import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertCan,
  boletoEmitido,
  boletoVencidoNaTolerancia,
  confirmarCancelamento,
  contaSuspensa,
  findPlan,
  isValidDocument,
  MIN_BOLETO_CENTS,
} from '@forms/shared';
import { requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { AppError, notFound, validationError } from '../http/errors.js';
import { hasPaymentProvider, payments } from '../payments/provider.js';
import { getQueue, QUEUE_NAMES } from '../queue/queues.js';
import { reissueBoleto } from '../queue/billing-worker.js';
import {
  billingOverview,
  cancelSubscription,
  changePlan,
  precoDoCiclo,
  subscribe,
  upsertBillingProfile,
} from '../services/billing-service.js';
import { checkDowngrade } from '../services/usage-service.js';

/**
 * Cobrança.
 *
 * Só `owner` chega aqui: `billing:read` e `billing:manage` não existem no
 * papel de `admin` (seção 4). Quem administra a equipe não administra o
 * dinheiro.
 */

const perfilFiscalSchema = z.object({
  documentType: z.enum(['cpf', 'cnpj']),
  document: z
    .string()
    .min(11)
    .max(20)
    .refine((v) => isValidDocument(v), 'Esse CPF ou CNPJ não é válido.'),
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional(),
  municipalRegistration: z.string().trim().max(40).optional(),
  emailBilling: z.string().email().max(254),
  phone: z.string().max(20).optional(),
  addressZip: z.string().min(8).max(9),
  addressStreet: z.string().trim().min(2).max(200),
  addressNumber: z.string().trim().min(1).max(20),
  addressComplement: z.string().trim().max(100).optional(),
  addressDistrict: z.string().trim().min(2).max(100),
  addressCity: z.string().trim().min(2).max(100),
  addressState: z.string().trim().length(2),
});

const assinaturaSchema = z.object({
  planCode: z.string().max(40),
  cycle: z.enum(['monthly', 'semiannual', 'annual']),
  billingType: z.enum(['credit_card', 'pix', 'boleto']),
  /**
   * Token do cartão, gerado no NAVEGADOR pelo SDK do gateway.
   * O número do cartão nunca passa pelos nossos servidores — é o que mantém o
   * escopo de PCI fora do nosso lado.
   */
  creditCardToken: z.string().max(200).optional(),
});

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/billing', async (request) => {
    assertCan(subjectOf(request), 'billing:read');
    return withRequestTenant(request, (ctx) => billingOverview(ctx));
  });

  app.put('/billing/profile', { preHandler: requireVerifiedEmail }, async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    const input = perfilFiscalSchema.parse(request.body);
    const perfil = await withRequestTenant(request, (ctx) => upsertBillingProfile(ctx, subject, input));

    return {
      documentType: perfil.documentType,
      document: `***${perfil.document.slice(-4)}`,
      legalName: perfil.legalName,
      emailBilling: perfil.emailBilling,
    };
  });

  /** Prévia do checkout: preço do ciclo e o que muda antes de confirmar. */
  app.get('/billing/quote', async (request) => {
    assertCan(subjectOf(request), 'billing:read');

    const query = z
      .object({ planCode: z.string().max(40), cycle: z.enum(['monthly', 'semiannual', 'annual']) })
      .parse(request.query);

    const plan = findPlan(query.planCode);
    if (!plan) throw notFound();

    const amountCents = precoDoCiclo(query.planCode, query.cycle);

    return {
      planCode: plan.code,
      planName: plan.name,
      cycle: query.cycle,
      amountCents,
      allowedBillingTypes: plan.allowedBillingTypes,
      // Boleto só nos ciclos que o plano permite, e nunca abaixo do mínimo.
      boletoAvailable: plan.boletoCycles.includes(query.cycle) && amountCents >= MIN_BOLETO_CENTS,
      trialDays: plan.trialDays,
    };
  });

  app.post('/billing/subscribe', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    if (!hasPaymentProvider()) {
      throw new AppError('internal_error', 'A cobrança está indisponível no momento. Tente de novo em instantes.');
    }

    const input = assinaturaSchema.parse(request.body);
    if (!findPlan(input.planCode)) throw notFound();

    const assinatura = await withRequestTenant(request, (ctx) => subscribe({ ctx, subject, ...input }));

    return reply.status(201).send({
      id: assinatura.id,
      planCode: assinatura.planCode,
      status: assinatura.status,
      amountCents: assinatura.amountCents,
      nextDueDate: assinatura.nextDueDate,
    });
  });

  app.post('/billing/change-plan', { preHandler: requireVerifiedEmail }, async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    const { planCode } = z.object({ planCode: z.string().max(40) }).parse(request.body);
    if (!findPlan(planCode)) throw notFound();

    return withRequestTenant(request, async (ctx) => {
      // Descer de plano com uso acima do novo limite exige ajuste antes. Nada
      // é apagado automaticamente (seção 6.2).
      const bloqueios = await checkDowngrade(ctx, planCode);
      if (bloqueios.length > 0) {
        throw new AppError('quota_exceeded', 'Ajuste seu uso antes de mudar para esse plano.', {
          extra: { blockers: bloqueios, upgradeUrl: '/planos' },
        });
      }

      const atualizada = await changePlan(ctx, subject, planCode);
      return { planCode: atualizada.planCode, amountCents: atualizada.amountCents, status: atualizada.status };
    });
  });

  app.post('/billing/cancel', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {});
    const cancelada = await withRequestTenant(request, (ctx) => cancelSubscription(ctx, subject, reason));

    return {
      status: cancelada.status,
      activeUntil: cancelada.currentPeriodEnd,
      copy: confirmarCancelamento({ activeUntil: cancelada.currentPeriodEnd }),
    };
  });

  /** Segunda via do boleto, prometida pela copy do aviso de vencimento. */
  app.post('/billing/invoices/:id/reissue-boleto', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const existe = await withRequestTenant(request, (ctx) =>
      ctx.tx.invoice.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } }),
    );
    if (!existe) throw notFound();

    const fatura = await reissueBoleto(subject.organizationId, id);
    return { boletoUrl: fatura.boletoUrl, boletoBarcode: fatura.boletoBarcode, dueDate: fatura.dueDate };
  });

  /** Troca de boleto para Pix, também prometida pela copy. */
  app.post('/billing/invoices/:id/pix', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:manage');

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withRequestTenant(request, async (ctx) => {
      const fatura = await ctx.tx.invoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
      if (!fatura?.providerInvoiceId) throw notFound();
      if (fatura.status === 'paid') throw validationError({ invoice: ['Essa fatura já foi paga.'] });

      const pix = await payments().generatePix(fatura.providerInvoiceId);

      await ctx.tx.invoice.update({
        where: { id: fatura.id },
        data: { pixQrcode: pix.qrCode, pixCopypaste: pix.copyPaste },
      });

      return { qrCode: pix.qrCode, copyPaste: pix.copyPaste, expiresAt: pix.expiresAt };
    });
  });

  /**
   * Banners contextuais da conta.
   *
   * A copy vem pronta do módulo compartilhado para que a tela não reimplemente
   * as regras de microcopy da seção 11.
   */
  app.get('/billing/banners', async (request) => {
    assertCan(subjectOf(request), 'billing:read');

    return withRequestTenant(request, async (ctx) => {
      const visao = await billingOverview(ctx);
      const banners = [];

      if (visao.subscription?.status === 'suspended') {
        banners.push(contaSuspensa());
      }

      if (visao.subscription?.status === 'overdue' && visao.subscription.graceUntil) {
        const vencida = visao.invoices.find((f) => f.status === 'overdue');
        if (vencida) {
          banners.push(
            boletoVencidoNaTolerancia({ dueDate: vencida.dueDate, graceUntil: visao.subscription.graceUntil }),
          );
        }
      }

      const boletoAberto = visao.invoices.find((f) => f.status === 'pending' && f.billingType === 'boleto');
      if (boletoAberto) {
        banners.push(boletoEmitido({ amountCents: boletoAberto.amountCents, dueDate: boletoAberto.dueDate }));
      }

      return { banners };
    });
  });
}

/**
 * Webhook do gateway.
 *
 * Fora do prefixo autenticado e sem `requireAuth`: quem chama é o gateway, não
 * um usuário. A autenticação é o token do provedor, verificado em tempo
 * constante dentro de `handleWebhook`.
 *
 * O processamento vai para a fila e a resposta é 200 imediata. Um gateway que
 * espera resposta em segundos não pode ficar preso atrás do nosso banco — e
 * um webhook que dá timeout é reenviado, o que só funciona porque o
 * processamento é idempotente.
 */
export async function paymentWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/payments',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!hasPaymentProvider()) return reply.status(503).send({ ok: false });

      const assinatura =
        (request.headers['asaas-access-token'] as string | undefined) ??
        (request.headers['x-webhook-token'] as string | undefined);

      let evento;
      try {
        evento = await payments().handleWebhook(request.body, assinatura);
      } catch {
        // Não diferenciamos "token errado" de "corpo malformado": as duas
        // respostas seriam informação para quem está sondando o endpoint.
        request.log.warn('webhook de pagamento recusado');
        return reply.status(401).send({ ok: false });
      }

      await getQueue(QUEUE_NAMES.billing).add('processar-evento', { event: evento });

      return reply.status(200).send({ ok: true });
    },
  );
}
