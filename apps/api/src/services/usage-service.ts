import {
  checkAiQuota,
  checkCountLimit,
  checkResponseQuota,
  checkStorageQuota,
  collectWarnings,
  currentPeriod,
  downgradeBlockers,
  getAddon,
  NO_ADDONS,
  type AddonTotals,
  type QuotaOutcome,
  type UsageSnapshot,
} from '@forms/shared';
import type { TenantContext } from '../db/tenant.js';
import { AppError } from '../http/errors.js';

/**
 * Enforcement de quotas — a parte que conversa com o banco.
 *
 * A regra que a seção 6.2 grifa: o enforcement roda no BACKEND, ANTES da ação.
 * Nunca confiar na UI. Uma tela que esconde o botão de "criar formulário" é
 * cortesia; quem impede a criação é este módulo.
 */

/** Contadores do ciclo vigente, criando a linha se ainda não existir. */
export async function loadUsage(ctx: TenantContext, now = new Date()): Promise<UsageSnapshot> {
  const org = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { createdAt: true },
  });

  // O ciclo acompanha a assinatura; sem assinatura ainda, acompanha a data de
  // criação da conta. O que não pode é resetar no dia 1 (seção 6.2).
  const subscription = await ctx.tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
    select: { currentPeriodStart: true },
  });

  const { start, end } = currentPeriod(subscription?.currentPeriodStart ?? org.createdAt, now);

  const counter = await ctx.tx.usageCounter.upsert({
    where: { organizationId_periodStart: { organizationId: ctx.organizationId, periodStart: start } },
    update: {},
    create: { organizationId: ctx.organizationId, periodStart: start, periodEnd: end },
  });

  // Contagens que não são acumulativas saem direto da fonte: guardar cópia
  // convidaria a divergir do estado real.
  const [formsCount, membersCount, customDomainsCount, apiKeysCount] = await Promise.all([
    ctx.tx.form.count({ where: { organizationId: ctx.organizationId, deletedAt: null, status: { not: 'archived' } } }),
    ctx.tx.membership.count({ where: { organizationId: ctx.organizationId } }),
    ctx.tx.customDomain.count({ where: { organizationId: ctx.organizationId, status: { not: 'disabled' } } }),
    ctx.tx.apiKey.count({ where: { organizationId: ctx.organizationId, revokedAt: null } }),
  ]);

  return {
    responsesCount: counter.responsesCount,
    aiAnalysesCount: counter.aiAnalysesCount,
    storageUsedMb: counter.storageUsedMb,
    formsCount,
    membersCount,
    customDomainsCount,
    apiKeysCount,
    periodStart: counter.periodStart,
    periodEnd: counter.periodEnd,
    bufferStartedAt: counter.bufferStartedAt,
    bufferEndsAt: counter.bufferEndsAt,
  };
}

/** Add-ons ativos no período, somados por unidade. */
export async function loadAddons(ctx: TenantContext, periodStart: Date, periodEnd: Date): Promise<AddonTotals> {
  const compras = await ctx.tx.addonPurchase.findMany({
    where: {
      organizationId: ctx.organizationId,
      periodStart: { lte: periodEnd },
      periodEnd: { gte: periodStart },
    },
  });

  const totais: AddonTotals = { ...NO_ADDONS };

  for (const compra of compras) {
    const addon = getAddon(compra.addonCode);
    if (!addon) continue;

    switch (addon.unit) {
      case 'responses':
        totais.responses += compra.amount;
        break;
      case 'aiAnalyses':
        totais.aiAnalyses += compra.amount;
        break;
      case 'storageMb':
        totais.storageMb += compra.amount;
        break;
      case 'members':
        totais.members += compra.amount;
        break;
      case 'customDomains':
        totais.customDomains += compra.amount;
        break;
    }
  }

  return totais;
}

export interface QuotaContext {
  planCode: string;
  usage: UsageSnapshot;
  addons: AddonTotals;
}

export async function quotaContext(ctx: TenantContext, now = new Date()): Promise<QuotaContext> {
  const org = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });

  const usage = await loadUsage(ctx, now);
  const addons = await loadAddons(ctx, usage.periodStart, usage.periodEnd);

  return { planCode: org.planCode, usage, addons };
}

/**
 * Transforma uma recusa de quota em HTTP 402 com o que a tela precisa.
 *
 * O corpo carrega `limit`, `current`, `upgrade_url` e `addon_url` porque a
 * seção 6.2 pede exatamente isso — e porque uma mensagem de bloqueio sem
 * caminho de saída é só uma parede.
 */
export function quotaError(outcome: Extract<QuotaOutcome, { allowed: false }>, message: string): AppError {
  return new AppError('quota_exceeded', message, {
    extra: {
      limit: outcome.limit,
      current: outcome.current,
      upgradeUrl: '/planos',
      addonUrl: '/planos/adicionais',
    },
  });
}

// -----------------------------------------------------------------------------
// Verificações usadas antes de cada ação
// -----------------------------------------------------------------------------

export async function assertCanCreateForm(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkCountLimit('forms', contexto);

  if (!resultado.allowed) {
    throw quotaError(
      resultado,
      `Você usou seus ${resultado.limit} formulários. Arquive um formulário ou mude de plano para criar mais.`,
    );
  }
}

export async function assertCanAddMember(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkCountLimit('members', contexto);

  if (!resultado.allowed) {
    throw quotaError(
      resultado,
      `Seu plano permite ${resultado.limit} ${resultado.limit === 1 ? 'membro' : 'membros'} e todos os lugares estão ocupados.`,
    );
  }
}

export async function assertCanAddDomain(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkCountLimit('customDomains', contexto);

  if (!resultado.allowed) {
    throw quotaError(resultado, 'Você usou todos os domínios personalizados do seu plano.');
  }
}

export async function assertCanCreateApiKey(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkCountLimit('apiKeys', contexto);

  if (!resultado.allowed) {
    throw quotaError(resultado, 'Você usou todas as chaves de API do seu plano.');
  }
}

export async function assertCanUpload(ctx: TenantContext, additionalBytes: number): Promise<void> {
  const contexto = await quotaContext(ctx);
  const additionalMb = Math.ceil(additionalBytes / (1024 * 1024));
  const resultado = checkStorageQuota({ ...contexto, additionalMb });

  if (!resultado.allowed) {
    // Bloqueia o novo, mantém o existente acessível (seção 6.2).
    throw quotaError(
      resultado,
      'Seu armazenamento está cheio. Seus arquivos atuais continuam acessíveis — libere espaço ou contrate mais para enviar novos.',
    );
  }
}

export async function assertCanRunAi(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkAiQuota(contexto);

  if (!resultado.allowed) {
    throw quotaError(
      resultado,
      'Você usou suas análises deste mês. As análises já geradas continuam disponíveis.',
    );
  }
}

/**
 * Decide o destino de uma submissão.
 *
 * Nunca lança: devolve o veredito para quem chama. A submissão pública precisa
 * distinguir "aceite normal", "aceite em cortesia" e "formulário pausado" — e
 * as três respondem coisas diferentes ao respondente.
 */
export async function evaluateResponseQuota(
  ctx: TenantContext,
  now = new Date(),
): Promise<{ outcome: QuotaOutcome; isBuffered: boolean }> {
  const contexto = await quotaContext(ctx, now);
  const outcome = checkResponseQuota({ ...contexto, now });

  const isBuffered = outcome.allowed && outcome.reason === 'buffered';

  // A janela de cortesia começa na PRIMEIRA resposta que passa do limite, e é
  // gravada para que as 48h não recomecem a cada submissão.
  if (isBuffered && !contexto.usage.bufferStartedAt) {
    await ctx.tx.usageCounter.update({
      where: { organizationId_periodStart: { organizationId: ctx.organizationId, periodStart: contexto.usage.periodStart } },
      data: {
        bufferStartedAt: now,
        bufferEndsAt: outcome.reason === 'buffered' ? outcome.bufferEndsAt : null,
      },
    });
  }

  return { outcome, isBuffered };
}

/** Incrementa o contador de respostas do ciclo. */
export async function incrementResponseCount(ctx: TenantContext, periodStart: Date): Promise<void> {
  await ctx.tx.usageCounter.update({
    where: { organizationId_periodStart: { organizationId: ctx.organizationId, periodStart } },
    data: { responsesCount: { increment: 1 } },
  });
}

export async function incrementStorage(ctx: TenantContext, bytes: number): Promise<void> {
  const usage = await loadUsage(ctx);
  await ctx.tx.usageCounter.update({
    where: { organizationId_periodStart: { organizationId: ctx.organizationId, periodStart: usage.periodStart } },
    data: { storageUsedMb: { increment: Math.ceil(bytes / (1024 * 1024)) } },
  });
}

export async function incrementAiCount(ctx: TenantContext): Promise<void> {
  const usage = await loadUsage(ctx);
  await ctx.tx.usageCounter.update({
    where: { organizationId_periodStart: { organizationId: ctx.organizationId, periodStart: usage.periodStart } },
    data: { aiAnalysesCount: { increment: 1 } },
  });
}

/** Painel de uso: o que a tela de configurações e os banners mostram. */
export async function usageSummary(ctx: TenantContext, now = new Date()) {
  const contexto = await quotaContext(ctx, now);

  return {
    planCode: contexto.planCode,
    period: { start: contexto.usage.periodStart, end: contexto.usage.periodEnd },
    usage: contexto.usage,
    addons: contexto.addons,
    warnings: collectWarnings({ ...contexto, now }),
    buffer:
      contexto.usage.bufferEndsAt && contexto.usage.bufferEndsAt > now
        ? { active: true, endsAt: contexto.usage.bufferEndsAt }
        : { active: false, endsAt: null },
  };
}

/** O que impede a troca para um plano menor. */
export async function checkDowngrade(ctx: TenantContext, targetPlanCode: string) {
  const contexto = await quotaContext(ctx);
  return downgradeBlockers({ targetPlanCode, usage: contexto.usage, addons: contexto.addons });
}
