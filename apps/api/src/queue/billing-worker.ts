import { Worker, type Job } from 'bullmq';
import { withTenant, withoutTenant } from '../db/tenant.js';
import { resolveBillingCustomerOrg, resolveSubscriptionOrg } from '../db/bootstrap.js';
import { applyPaymentEvent, suspendIfGraceExpired, TOLERANCIA_DIAS } from '../services/billing-service.js';
import { payments, type NormalizedEvent } from '../payments/provider.js';
import { QUEUE_NAMES, redisConnection } from './queues.js';
import type { Prisma } from '@prisma/client';

/**
 * Processamento de eventos de pagamento.
 *
 * Duas garantias moram aqui, e as duas custaram dinheiro a alguém antes de
 * virarem regra:
 *
 *  **Idempotência.** Gateway reenvia webhook. Processar duas vezes significa
 *  creditar duas vezes, ou cobrar duas vezes. A trava é o índice único em
 *  `payment_events.provider_event_id` — não uma checagem em memória.
 *
 *  **Reconciliação diária.** Webhook é HTTP: ele se perde. O job que compara
 *  nosso estado com o do gateway é o que evita cliente pagante ficar suspenso,
 *  e por isso a seção 7.5 diz explicitamente que ele não é opcional.
 */

export interface PaymentEventJobData {
  /** O evento já normalizado, com o token do provedor já verificado. */
  event: NormalizedEvent;
}

/**
 * Registra o evento e aplica o efeito.
 *
 * O registro vem primeiro, e é ele que garante idempotência: se a linha já
 * existe, o evento é reenvio e não há nada a fazer.
 */
export async function processPaymentEvent(event: NormalizedEvent): Promise<'applied' | 'duplicate' | 'unmatched'> {
  const novo = await withoutTenant(async (tx) => {
    const existente = await tx.paymentEvent.findUnique({ where: { providerEventId: event.providerEventId } });
    if (existente) return false;

    await tx.paymentEvent.create({
      data: {
        provider: payments().name,
        providerEventId: event.providerEventId,
        eventType: event.type,
        payloadJson: event.raw as Prisma.InputJsonValue,
      },
    });
    return true;
  }).catch((error: unknown) => {
    // Corrida entre dois webhooks idênticos: o índice único decide, e quem
    // perdeu trata como duplicata.
    if (error instanceof Error && error.message.includes('Unique constraint')) return false;
    throw error;
  });

  if (!novo) return 'duplicate';

  const organizationId = await resolveOrganization(event);
  if (!organizationId) {
    await marcarProcessado(event.providerEventId, 'nenhuma organização corresponde a este evento');
    return 'unmatched';
  }

  await withTenant(organizationId, (ctx) => applyPaymentEvent(ctx, event));
  await marcarProcessado(event.providerEventId);

  return 'applied';
}

async function resolveOrganization(event: NormalizedEvent): Promise<string | null> {
  return withoutTenant(async (tx) => {
    if (event.providerSubscriptionId) {
      const encontrada = await resolveSubscriptionOrg(tx, event.providerSubscriptionId);
      if (encontrada) return encontrada.organizationId;
    }
    if (event.providerCustomerId) {
      return resolveBillingCustomerOrg(tx, event.providerCustomerId);
    }
    return null;
  });
}

async function marcarProcessado(providerEventId: string, erro?: string): Promise<void> {
  await withoutTenant((tx) =>
    tx.paymentEvent.update({
      where: { providerEventId },
      data: { processedAt: new Date(), error: erro ?? null },
    }),
  );
}

// -----------------------------------------------------------------------------
// Reconciliação diária
// -----------------------------------------------------------------------------

export interface ReconciliationResult {
  checked: number;
  corrected: number;
  suspended: number;
  details: Array<{ organizationId: string; invoiceId: string; from: string; to: string }>;
}

/**
 * Compara o estado local com o do gateway e corrige divergências.
 *
 * Os casos reais que este job resolve:
 *
 *  - Boleto pago no banco e o webhook nunca chegou → cliente pagante seria
 *    suspenso amanhã.
 *  - Baixa manual feita no painel do gateway.
 *  - Pagamento duplicado, que aparece como duas faturas pagas.
 *
 * Roda com contexto de tenant por organização, como qualquer outro acesso.
 */
export async function reconcileOrganization(organizationId: string, now = new Date()): Promise<ReconciliationResult> {
  const resultado: ReconciliationResult = { checked: 0, corrected: 0, suspended: 0, details: [] };
  const gateway = payments();

  await withTenant(organizationId, async (ctx) => {
    const pendentes = await ctx.tx.invoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { in: ['pending', 'overdue'] },
        providerInvoiceId: { not: null },
      },
      take: 200,
    });

    for (const fatura of pendentes) {
      resultado.checked += 1;

      const remota = await gateway.getInvoice(fatura.providerInvoiceId as string).catch(() => null);
      if (!remota || remota.status === fatura.status) continue;

      await ctx.tx.invoice.update({
        where: { id: fatura.id },
        data: {
          status: remota.status,
          paidAt: remota.paidAt,
          ...(remota.boletoUrl ? { boletoUrl: remota.boletoUrl } : {}),
        },
      });

      resultado.corrected += 1;
      resultado.details.push({
        organizationId,
        invoiceId: fatura.id,
        from: fatura.status,
        to: remota.status,
      });

      // Divergência que mais importa: pago lá, pendente aqui.
      if (remota.status === 'paid') {
        await applyPaymentEvent(ctx, {
          providerEventId: `reconciliacao:${fatura.id}:${now.toISOString().slice(0, 10)}`,
          type: 'PAYMENT_RECEIVED',
          providerInvoiceId: fatura.providerInvoiceId,
          providerSubscriptionId: null,
          providerCustomerId: null,
          amountCents: remota.amountCents,
          paidAt: remota.paidAt,
          dueDate: remota.dueDate,
          raw: { origem: 'reconciliacao-diaria' },
        });
      }
    }

    // A suspensão acontece DEPOIS da reconciliação, de propósito: primeiro
    // corrigimos o que sabemos, e só então cortamos quem realmente não pagou.
    if (await suspendIfGraceExpired(ctx, now)) resultado.suspended += 1;
  });

  return resultado;
}

/**
 * Emite a segunda via de um boleto vencido.
 *
 * A copy da seção 11 promete "Emitir segunda via" ao lado do aviso de
 * vencimento; sem isto, o botão seria decoração.
 */
export async function reissueBoleto(organizationId: string, invoiceId: string) {
  return withTenant(organizationId, async (ctx) => {
    const fatura = await ctx.tx.invoice.findFirstOrThrow({
      where: { id: invoiceId, organizationId: ctx.organizationId },
    });
    if (!fatura.providerInvoiceId) throw new Error('Fatura sem referência no gateway.');

    const boleto = await payments().generateBoleto(fatura.providerInvoiceId);

    return ctx.tx.invoice.update({
      where: { id: fatura.id },
      data: { boletoUrl: boleto.pdfUrl, boletoBarcode: boleto.barcode },
    });
  });
}

/** Datas em que o cliente é lembrado: 3 dias antes, no dia, 1 e 3 depois. */
export const DUNNING_STEPS = [
  { step: 'lembrete_3_dias_antes', offsetDays: -3 },
  { step: 'lembrete_no_vencimento', offsetDays: 0 },
  { step: 'aviso_1_dia_apos', offsetDays: 1 },
  { step: 'aviso_3_dias_apos', offsetDays: 3 },
] as const;

/** O passo de dunning devido hoje para uma fatura, se houver. */
export function dunningStepFor(dueDate: Date, now: Date): (typeof DUNNING_STEPS)[number] | null {
  const dias = Math.round((now.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000));
  return DUNNING_STEPS.find((passo) => passo.offsetDays === dias) ?? null;
}

/** Fim da tolerância de uma fatura, conforme o meio de pagamento. */
export function graceDeadline(dueDate: Date, billingType: keyof typeof TOLERANCIA_DIAS): Date {
  return new Date(dueDate.getTime() + TOLERANCIA_DIAS[billingType] * 24 * 60 * 60 * 1000);
}

export function startBillingWorker(): Worker<PaymentEventJobData> {
  return new Worker<PaymentEventJobData>(
    QUEUE_NAMES.billing,
    async (job: Job<PaymentEventJobData>) => processPaymentEvent(job.data.event),
    { connection: redisConnection(), concurrency: 4 },
  );
}
