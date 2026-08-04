import {
  addMonths,
  formatBRL,
  getPlan,
  isValidDocument,
  onlyDigits,
  planSupportsBoleto,
  MIN_BOLETO_CENTS,
  type BillingCycle,
  type BillingType,
  type PlanCode,
  type Subject,
} from '@forms/shared';
import type { Prisma, SubscriptionStatus } from '@prisma/client';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository } from '../db/repositories.js';
import { payments } from '../payments/provider.js';
import type { NormalizedEvent } from '../payments/provider.js';
import { AppError, conflict, notFound, validationError } from '../http/errors.js';

/**
 * Assinaturas e cobrança.
 *
 * A máquina de estados (seção 7.3):
 *
 *   trialing → active → pending_payment → overdue → suspended → canceled
 *
 * A regra que molda tudo: **boleto é assíncrono**. A compensação leva de 1 a 3
 * dias úteis, então suspender na data de vencimento derruba cliente adimplente
 * cujo dinheiro está em trânsito. Daí a tolerância por método, e daí a
 * reconciliação diária — sem ela, um webhook perdido vira cliente pagante
 * suspenso.
 */

/** Tolerância após o vencimento, por método (seção 7.3). */
export const TOLERANCIA_DIAS: Record<BillingType, number> = {
  boleto: 5,
  pix: 3,
  // Cartão são 3 tentativas de dunning; em dias, o equivalente prático.
  credit_card: 3,
  invoice: 10,
};

const DIA_MS = 24 * 60 * 60 * 1000;

/** Boleto é gerado 7 dias antes do vencimento (seção 7.2). */
export const DIAS_ANTECEDENCIA_BOLETO = 7;

function mesesDoCiclo(cycle: BillingCycle): number {
  return { monthly: 1, semiannual: 6, annual: 12 }[cycle];
}

export function precoDoCiclo(planCode: string, cycle: BillingCycle): number {
  const plan = getPlan(planCode as PlanCode);
  if (plan.priceMonthlyCents === null || plan.priceYearlyCents === null) {
    throw new AppError('validation_error', `O plano ${plan.name} é negociado por contrato. Fale com o time de vendas.`);
  }

  return {
    monthly: plan.priceMonthlyCents,
    // Semestral: metade do anual, que já embute os dois meses grátis.
    semiannual: Math.round(plan.priceYearlyCents / 2),
    annual: plan.priceYearlyCents,
  }[cycle];
}

// -----------------------------------------------------------------------------
// Cadastro fiscal
// -----------------------------------------------------------------------------

export interface BillingProfileInput {
  documentType: 'cpf' | 'cnpj';
  document: string;
  legalName: string;
  tradeName?: string;
  municipalRegistration?: string;
  emailBilling: string;
  phone?: string;
  addressZip: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement?: string;
  addressDistrict: string;
  addressCity: string;
  addressState: string;
}

/**
 * Cadastro fiscal, obrigatório antes da primeira cobrança (seção 7.4).
 *
 * O documento é validado por ALGORITMO, não por formato: "111.111.111-11" tem
 * o formato certo e não é um CPF. Sem isso, a NFS-e é rejeitada pela
 * prefeitura depois do pagamento — quando já é tarde.
 */
export async function upsertBillingProfile(ctx: TenantContext, subject: Subject, input: BillingProfileInput) {
  const documento = onlyDigits(input.document);

  if (!isValidDocument(documento)) {
    throw validationError({ document: ['Esse CPF ou CNPJ não é válido.'] });
  }

  const tipoEsperado = documento.length === 11 ? 'cpf' : 'cnpj';
  if (input.documentType !== tipoEsperado) {
    throw validationError({ documentType: [`Esse documento é um ${tipoEsperado.toUpperCase()}.`] });
  }

  const dados = {
    documentType: input.documentType,
    document: documento,
    legalName: input.legalName.trim(),
    tradeName: input.tradeName?.trim() ?? null,
    municipalRegistration: input.municipalRegistration?.trim() ?? null,
    emailBilling: input.emailBilling.trim().toLowerCase(),
    phone: input.phone ? onlyDigits(input.phone) : null,
    addressZip: onlyDigits(input.addressZip),
    addressStreet: input.addressStreet.trim(),
    addressNumber: input.addressNumber.trim(),
    addressComplement: input.addressComplement?.trim() ?? null,
    addressDistrict: input.addressDistrict.trim(),
    addressCity: input.addressCity.trim(),
    addressState: input.addressState.trim().toUpperCase().slice(0, 2),
  };

  const perfil = await ctx.tx.billingProfile.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, ...dados },
    update: dados,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'billing_profile.updated',
    resourceType: 'billing_profile',
    resourceId: perfil.id,
    // O documento em si não vai para o log de auditoria: é dado pessoal e o
    // log é lido por mais gente do que o cadastro.
    metadataJson: { documentType: perfil.documentType },
  });

  return perfil;
}

// -----------------------------------------------------------------------------
// Assinatura
// -----------------------------------------------------------------------------

export interface SubscribeParams {
  ctx: TenantContext;
  subject: Subject;
  planCode: string;
  cycle: BillingCycle;
  billingType: BillingType;
  creditCardToken?: string;
}

export async function subscribe(params: SubscribeParams) {
  const { ctx, subject } = params;
  const plan = getPlan(params.planCode as PlanCode);

  if (!plan.allowedBillingTypes.includes(params.billingType)) {
    throw validationError({
      billingType: [`O plano ${plan.name} não aceita esse meio de pagamento.`],
    });
  }

  if (params.billingType === 'boleto' && !planSupportsBoleto(plan, params.cycle)) {
    throw validationError({
      billingType: [`No plano ${plan.name}, boleto está disponível apenas nos ciclos ${plan.boletoCycles.join(', ')}.`],
    });
  }

  const amountCents = precoDoCiclo(params.planCode, params.cycle);

  if (params.billingType === 'boleto' && amountCents < MIN_BOLETO_CENTS) {
    // Boleto abaixo de R$ 5,00 custa mais para emitir do que arrecada.
    throw validationError({ billingType: ['Esse valor é baixo demais para boleto. Use Pix ou cartão.'] });
  }

  const perfil = await ctx.tx.billingProfile.findFirst({ where: { organizationId: ctx.organizationId } });
  if (!perfil) {
    throw new AppError('validation_error', 'Preencha os dados fiscais antes de assinar.', {
      details: { billingProfile: ['Cadastro fiscal obrigatório antes da primeira cobrança.'] },
    });
  }

  const existente = await ctx.tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId, status: { notIn: ['canceled'] } },
  });
  if (existente) throw conflict('Esta empresa já tem uma assinatura ativa. Use a troca de plano.');

  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { name: true },
  });

  const gateway = payments();

  const customerId =
    perfil.providerCustomerId ??
    (await gateway.createCustomer({
      organizationId: ctx.organizationId,
      name: perfil.legalName,
      email: perfil.emailBilling,
      document: perfil.document,
      documentType: perfil.documentType,
      ...(perfil.phone ? { phone: perfil.phone } : {}),
      address: {
        zip: perfil.addressZip,
        street: perfil.addressStreet,
        number: perfil.addressNumber,
        ...(perfil.addressComplement ? { complement: perfil.addressComplement } : {}),
        district: perfil.addressDistrict,
        city: perfil.addressCity,
        state: perfil.addressState,
      },
    }));

  if (!perfil.providerCustomerId) {
    await ctx.tx.billingProfile.update({ where: { id: perfil.id }, data: { providerCustomerId: customerId } });
  }

  const agora = new Date();
  // Boleto precisa chegar ao cliente com antecedência (seção 7.2).
  const primeiroVencimento = new Date(
    agora.getTime() + (params.billingType === 'boleto' ? DIAS_ANTECEDENCIA_BOLETO * DIA_MS : DIA_MS),
  );

  const remota = await gateway.createSubscription({
    customerId,
    planCode: params.planCode,
    billingType: params.billingType,
    cycle: params.cycle,
    amountCents,
    nextDueDate: primeiroVencimento,
    description: `${plan.name} — ${organizacao.name}`,
    ...(params.creditCardToken ? { creditCardToken: params.creditCardToken } : {}),
  });

  const periodEnd = addMonths(agora, mesesDoCiclo(params.cycle));

  const assinatura = await ctx.tx.subscription.create({
    data: {
      organizationId: ctx.organizationId,
      planCode: params.planCode,
      providerSubscriptionId: remota.id,
      billingType: params.billingType,
      cycle: params.cycle,
      // Ainda não há dinheiro compensado: o estado inicial é "aguardando".
      status: 'pending_payment',
      currentPeriodStart: agora,
      currentPeriodEnd: periodEnd,
      amountCents,
      nextDueDate: primeiroVencimento,
      // Reajuste anual respeita este trava-preço (seção 6.2).
      priceLockedUntil: addMonths(agora, 12),
    },
  });

  await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: { planCode: params.planCode, subscriptionStatus: 'pending_payment' },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'subscription.created',
    resourceType: 'subscription',
    resourceId: assinatura.id,
    metadataJson: { planCode: params.planCode, cycle: params.cycle, billingType: params.billingType, amountCents },
  });

  return assinatura;
}

/**
 * Troca de plano no meio do ciclo.
 *
 * Pro-rata em centavos, creditado na PRÓXIMA fatura. Nunca devolução
 * automática em boleto — devolver dinheiro por boleto exige dados bancários
 * que não temos e um processo manual (seção 6.2).
 */
export async function changePlan(ctx: TenantContext, subject: Subject, targetPlanCode: string) {
  const assinatura = await ctx.tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId, status: { notIn: ['canceled'] } },
  });
  if (!assinatura) throw notFound();

  const novoValor = precoDoCiclo(targetPlanCode, assinatura.cycle);
  const gateway = payments();

  if (assinatura.providerSubscriptionId) {
    await gateway.updateSubscription(assinatura.providerSubscriptionId, { amountCents: novoValor });
  }

  const atualizada = await ctx.tx.subscription.update({
    where: { id: assinatura.id },
    data: { planCode: targetPlanCode, amountCents: novoValor },
  });

  await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: { planCode: targetPlanCode },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'subscription.plan_changed',
    resourceType: 'subscription',
    resourceId: assinatura.id,
    metadataJson: { from: assinatura.planCode, to: targetPlanCode, amountCents: novoValor },
  });

  return atualizada;
}

export async function cancelSubscription(ctx: TenantContext, subject: Subject, reason?: string) {
  const assinatura = await ctx.tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId, status: { notIn: ['canceled'] } },
  });
  if (!assinatura) throw notFound();

  if (assinatura.providerSubscriptionId) {
    await payments().cancelSubscription(assinatura.providerSubscriptionId);
  }

  const cancelada = await ctx.tx.subscription.update({
    where: { id: assinatura.id },
    data: { status: 'canceled', canceledAt: new Date(), cancelReason: reason ?? null },
  });

  // A conta segue ativa até o fim do período pago. Cortar na hora seria cobrar
  // por um mês e entregar meio.
  await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: { subscriptionStatus: 'canceled' },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'subscription.canceled',
    resourceType: 'subscription',
    resourceId: assinatura.id,
    metadataJson: { activeUntil: assinatura.currentPeriodEnd.toISOString(), reason: reason ?? null },
  });

  return cancelada;
}

// -----------------------------------------------------------------------------
// Eventos de pagamento
// -----------------------------------------------------------------------------

/** Transições permitidas. Uma transição fora daqui é bug, e o log registra. */
const TRANSICOES: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  trialing: ['active', 'pending_payment', 'canceled'],
  active: ['pending_payment', 'overdue', 'canceled'],
  pending_payment: ['active', 'overdue', 'canceled'],
  overdue: ['active', 'suspended', 'canceled'],
  suspended: ['active', 'canceled'],
  canceled: [],
};

export function podeTransicionar(de: SubscriptionStatus, para: SubscriptionStatus): boolean {
  if (de === para) return true;
  return TRANSICOES[de].includes(para);
}

/**
 * Aplica um evento normalizado do gateway.
 *
 * Chamado pelo worker, nunca no request do webhook: um gateway que espera
 * resposta em 5 segundos não pode ficar preso atrás do nosso banco.
 */
export async function applyPaymentEvent(ctx: TenantContext, event: NormalizedEvent): Promise<void> {
  const assinatura = event.providerSubscriptionId
    ? await ctx.tx.subscription.findFirst({
        where: { organizationId: ctx.organizationId, providerSubscriptionId: event.providerSubscriptionId },
      })
    : await ctx.tx.subscription.findFirst({
        where: { organizationId: ctx.organizationId, status: { notIn: ['canceled'] } },
      });

  if (!assinatura) return;

  const fatura = event.providerInvoiceId
    ? await ctx.tx.invoice.findFirst({
        where: { organizationId: ctx.organizationId, providerInvoiceId: event.providerInvoiceId },
      })
    : null;

  switch (event.type) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED': {
      const pagoEm = event.paidAt ?? new Date();

      if (fatura) {
        await ctx.tx.invoice.update({ where: { id: fatura.id }, data: { status: 'paid', paidAt: pagoEm } });
      } else if (event.providerInvoiceId) {
        // Pagamento de fatura que nunca chegou por webhook de criação. Melhor
        // registrar do que descartar: a reconciliação depende deste histórico.
        await ctx.tx.invoice.create({
          data: {
            organizationId: ctx.organizationId,
            subscriptionId: assinatura.id,
            providerInvoiceId: event.providerInvoiceId,
            amountCents: event.amountCents ?? assinatura.amountCents,
            status: 'paid',
            billingType: assinatura.billingType,
            dueDate: event.dueDate ?? pagoEm,
            paidAt: pagoEm,
          },
        });
      }

      await moverAssinatura(ctx, assinatura.id, 'active', {
        graceUntil: null,
        currentPeriodStart: assinatura.currentPeriodEnd <= pagoEm ? pagoEm : assinatura.currentPeriodStart,
        currentPeriodEnd:
          assinatura.currentPeriodEnd <= pagoEm
            ? addMonths(pagoEm, mesesDoCiclo(assinatura.cycle))
            : assinatura.currentPeriodEnd,
      });
      break;
    }

    case 'PAYMENT_OVERDUE': {
      if (fatura) {
        await ctx.tx.invoice.update({ where: { id: fatura.id }, data: { status: 'overdue' } });
      }

      // A conta NÃO é suspensa aqui. O vencimento apenas inicia a contagem da
      // tolerância — quem suspende é o job diário, depois que ela acaba.
      const vencimento = event.dueDate ?? fatura?.dueDate ?? new Date();
      const graceUntil = new Date(vencimento.getTime() + TOLERANCIA_DIAS[assinatura.billingType] * DIA_MS);

      await moverAssinatura(ctx, assinatura.id, 'overdue', { graceUntil });
      break;
    }

    case 'PAYMENT_REFUNDED': {
      if (fatura) {
        await ctx.tx.invoice.update({ where: { id: fatura.id }, data: { status: 'refunded' } });
      }
      break;
    }

    case 'SUBSCRIPTION_CANCELED': {
      await moverAssinatura(ctx, assinatura.id, 'canceled', { canceledAt: new Date() });
      break;
    }

    case 'SUBSCRIPTION_UPDATED':
    case 'UNKNOWN':
      break;
  }
}

async function moverAssinatura(
  ctx: TenantContext,
  subscriptionId: string,
  para: SubscriptionStatus,
  extra: Prisma.SubscriptionUncheckedUpdateInput = {},
): Promise<void> {
  const atual = await ctx.tx.subscription.findFirstOrThrow({
    where: { id: subscriptionId, organizationId: ctx.organizationId },
  });

  if (!podeTransicionar(atual.status, para)) {
    // Uma assinatura cancelada não volta a ativa por um webhook atrasado.
    await auditLogsRepository.record(ctx, {
      action: 'subscription.transition_rejected',
      resourceType: 'subscription',
      resourceId: subscriptionId,
      metadataJson: { from: atual.status, to: para },
    });
    return;
  }

  await ctx.tx.subscription.update({ where: { id: subscriptionId }, data: { status: para, ...extra } });
  await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: { subscriptionStatus: para },
  });

  await auditLogsRepository.record(ctx, {
    action: 'subscription.status_changed',
    resourceType: 'subscription',
    resourceId: subscriptionId,
    metadataJson: { from: atual.status, to: para },
  });
}

/**
 * Suspende quem passou da tolerância.
 *
 * Roda no job diário. Suspensão é modo somente leitura: o cliente continua
 * vendo e exportando tudo, e os formulários públicos pausam com mensagem
 * neutra (seção 11).
 */
export async function suspendIfGraceExpired(ctx: TenantContext, now = new Date()): Promise<boolean> {
  const assinatura = await ctx.tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId, status: 'overdue' },
  });

  if (!assinatura?.graceUntil || assinatura.graceUntil > now) return false;

  await moverAssinatura(ctx, assinatura.id, 'suspended');
  return true;
}

/** Resumo para o painel de cobrança. */
export async function billingOverview(ctx: TenantContext) {
  const [assinatura, perfil, faturas] = await Promise.all([
    ctx.tx.subscription.findFirst({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
    }),
    ctx.tx.billingProfile.findFirst({ where: { organizationId: ctx.organizationId } }),
    ctx.tx.invoice.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { dueDate: 'desc' },
      take: 24,
    }),
  ]);

  return {
    subscription: assinatura
      ? {
          id: assinatura.id,
          planCode: assinatura.planCode,
          status: assinatura.status,
          billingType: assinatura.billingType,
          cycle: assinatura.cycle,
          amountCents: assinatura.amountCents,
          amountFormatted: formatBRL(assinatura.amountCents),
          currentPeriodStart: assinatura.currentPeriodStart,
          currentPeriodEnd: assinatura.currentPeriodEnd,
          graceUntil: assinatura.graceUntil,
          nextDueDate: assinatura.nextDueDate,
          canceledAt: assinatura.canceledAt,
        }
      : null,
    billingProfile: perfil
      ? {
          documentType: perfil.documentType,
          // Documento mascarado: a tela confirma qual é sem expor o número
          // inteiro em cada carregamento.
          document: `***${perfil.document.slice(-4)}`,
          legalName: perfil.legalName,
          emailBilling: perfil.emailBilling,
          addressCity: perfil.addressCity,
          addressState: perfil.addressState,
        }
      : null,
    invoices: faturas.map((f) => ({
      id: f.id,
      amountCents: f.amountCents,
      amountFormatted: formatBRL(f.amountCents),
      status: f.status,
      billingType: f.billingType,
      dueDate: f.dueDate,
      paidAt: f.paidAt,
      boletoUrl: f.boletoUrl,
      nfseUrl: f.nfseUrl,
      nfseNumber: f.nfseNumber,
    })),
  };
}
