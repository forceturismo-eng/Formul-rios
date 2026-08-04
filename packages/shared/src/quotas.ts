import { getPlan, isUnlimited, type LimitKey, type Plan, type PlanCode } from './plans.js';

/**
 * Regras de quota — a parte pura, sem banco.
 *
 * O princípio que organiza este arquivo está na seção 6.2 do documento de
 * produto: **nunca descartar submissão silenciosamente**. Formulário é canal de
 * entrada de cliente; perder uma resposta porque a cota estourou é perder um
 * negócio do nosso cliente, e ele não vai saber que perdeu.
 *
 * Daí o desenho em três degraus para respostas:
 *
 *   80% da cota  → avisa, com projeção de quantos dias faltam
 *   100%         → aceita por mais 48h, marcando `is_buffered`
 *   depois disso → formulário público exibe pausa neutra
 *
 * Limites de contagem (formulários, membros, domínios, chaves) são diferentes:
 * ali o bloqueio é duro na criação, porque não existe "perder" nada — a pessoa
 * simplesmente não cria mais um.
 */

export const BUFFER_HOURS = 48;
export const WARNING_THRESHOLD = 0.8;

export interface UsageSnapshot {
  responsesCount: number;
  aiAnalysesCount: number;
  storageUsedMb: number;
  formsCount: number;
  membersCount: number;
  customDomainsCount: number;
  apiKeysCount: number;
  periodStart: Date;
  periodEnd: Date;
  bufferStartedAt: Date | null;
  bufferEndsAt: Date | null;
}

/** Add-ons comprados somam ao limite do plano no período vigente. */
export interface AddonTotals {
  responses: number;
  aiAnalyses: number;
  storageMb: number;
  members: number;
  customDomains: number;
}

export const NO_ADDONS: AddonTotals = {
  responses: 0,
  aiAnalyses: 0,
  storageMb: 0,
  members: 0,
  customDomains: 0,
};

/** Limite do plano + add-ons. `-1` continua sendo ilimitado. */
export function effectiveLimit(plan: Plan, key: LimitKey, addons: AddonTotals = NO_ADDONS): number {
  const base = plan.limits[key];
  if (isUnlimited(base)) return base;

  const extra: Partial<Record<LimitKey, number>> = {
    responsesPerMonth: addons.responses,
    aiAnalysesPerMonth: addons.aiAnalyses,
    storageMb: addons.storageMb,
    members: addons.members,
    customDomains: addons.customDomains,
  };

  return base + (extra[key] ?? 0);
}

export type QuotaOutcome =
  | { allowed: true; reason: 'within_limit' | 'unlimited' }
  /** Respostas dentro da cortesia de 48h: aceita, mas marcada. */
  | { allowed: true; reason: 'buffered'; bufferEndsAt: Date }
  | { allowed: false; reason: 'limit_reached' | 'buffer_expired'; limit: number; current: number };

export interface QuotaCheckParams {
  planCode: string;
  usage: UsageSnapshot;
  addons?: AddonTotals;
  now?: Date;
}

/** Limites de contagem: bloqueio duro na criação. */
export function checkCountLimit(
  key: Extract<LimitKey, 'forms' | 'members' | 'customDomains' | 'apiKeys'>,
  params: QuotaCheckParams,
): QuotaOutcome {
  const plan = getPlan(params.planCode as PlanCode);
  const limit = effectiveLimit(plan, key, params.addons ?? NO_ADDONS);
  if (isUnlimited(limit)) return { allowed: true, reason: 'unlimited' };

  const current = {
    forms: params.usage.formsCount,
    members: params.usage.membersCount,
    customDomains: params.usage.customDomainsCount,
    apiKeys: params.usage.apiKeysCount,
  }[key];

  return current + 1 <= limit
    ? { allowed: true, reason: 'within_limit' }
    : { allowed: false, reason: 'limit_reached', limit, current };
}

/**
 * Respostas — a única quota com cortesia.
 *
 * Devolve `buffered` quando a cota estourou mas as 48h ainda não acabaram.
 * Quem chama grava `is_buffered = true`, e essas respostas **nunca** são
 * apagadas: ficam visíveis assim que o cliente regulariza.
 */
export function checkResponseQuota(params: QuotaCheckParams): QuotaOutcome {
  const now = params.now ?? new Date();
  const plan = getPlan(params.planCode as PlanCode);
  const limit = effectiveLimit(plan, 'responsesPerMonth', params.addons ?? NO_ADDONS);

  if (isUnlimited(limit)) return { allowed: true, reason: 'unlimited' };

  const current = params.usage.responsesCount;
  if (current < limit) return { allowed: true, reason: 'within_limit' };

  // Cota estourada. A cortesia começa na primeira resposta que passa do limite.
  const bufferEndsAt = params.usage.bufferEndsAt ?? new Date(now.getTime() + BUFFER_HOURS * 60 * 60 * 1000);

  if (now < bufferEndsAt) return { allowed: true, reason: 'buffered', bufferEndsAt };

  return { allowed: false, reason: 'buffer_expired', limit, current };
}

/** Armazenamento e IA: bloqueiam o novo, mantêm o existente acessível. */
export function checkStorageQuota(params: QuotaCheckParams & { additionalMb: number }): QuotaOutcome {
  const plan = getPlan(params.planCode as PlanCode);
  const limit = effectiveLimit(plan, 'storageMb', params.addons ?? NO_ADDONS);
  if (isUnlimited(limit)) return { allowed: true, reason: 'unlimited' };

  const current = params.usage.storageUsedMb;
  return current + params.additionalMb <= limit
    ? { allowed: true, reason: 'within_limit' }
    : { allowed: false, reason: 'limit_reached', limit, current };
}

export function checkAiQuota(params: QuotaCheckParams): QuotaOutcome {
  const plan = getPlan(params.planCode as PlanCode);
  const limit = effectiveLimit(plan, 'aiAnalysesPerMonth', params.addons ?? NO_ADDONS);
  if (isUnlimited(limit)) return { allowed: true, reason: 'unlimited' };

  const current = params.usage.aiAnalysesCount;
  return current < limit
    ? { allowed: true, reason: 'within_limit' }
    : { allowed: false, reason: 'limit_reached', limit, current };
}

// -----------------------------------------------------------------------------
// Aviso de 80%
// -----------------------------------------------------------------------------

export interface UsageWarning {
  key: 'responsesPerMonth' | 'storageMb' | 'aiAnalysesPerMonth';
  used: number;
  limit: number;
  percent: number;
  /** Projeção no ritmo atual. `null` quando não dá para projetar. */
  daysUntilLimit: number | null;
  renewsAt: Date;
}

/**
 * Projeta em quantos dias a cota acaba, no ritmo atual.
 *
 * A copy da seção 11 pede exatamente isso: "No ritmo atual, o limite chega em
 * cerca de 6 dias". Um aviso sem projeção não ajuda ninguém a decidir.
 */
export function projectDaysUntilLimit(used: number, limit: number, periodStart: Date, now: Date): number | null {
  const diasDecorridos = (now.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);
  if (diasDecorridos < 1 || used <= 0) return null;

  const porDia = used / diasDecorridos;
  if (porDia <= 0) return null;

  const restante = limit - used;
  if (restante <= 0) return 0;

  return Math.max(0, Math.round(restante / porDia));
}

export function collectWarnings(params: QuotaCheckParams): UsageWarning[] {
  const now = params.now ?? new Date();
  const plan = getPlan(params.planCode as PlanCode);
  const addons = params.addons ?? NO_ADDONS;
  const avisos: UsageWarning[] = [];

  const candidatos = [
    { key: 'responsesPerMonth' as const, used: params.usage.responsesCount },
    { key: 'storageMb' as const, used: params.usage.storageUsedMb },
    { key: 'aiAnalysesPerMonth' as const, used: params.usage.aiAnalysesCount },
  ];

  for (const { key, used } of candidatos) {
    const limit = effectiveLimit(plan, key, addons);
    if (isUnlimited(limit) || limit <= 0) continue;

    const percent = used / limit;
    if (percent < WARNING_THRESHOLD) continue;

    avisos.push({
      key,
      used,
      limit,
      percent: Math.min(1, percent),
      daysUntilLimit: projectDaysUntilLimit(used, limit, params.usage.periodStart, now),
      renewsAt: params.usage.periodEnd,
    });
  }

  return avisos;
}

// -----------------------------------------------------------------------------
// Downgrade
// -----------------------------------------------------------------------------

export interface DowngradeBlocker {
  key: LimitKey;
  label: string;
  current: number;
  limit: number;
  excess: number;
  /** O que o cliente precisa fazer — sempre uma ação, nunca só um número. */
  action: string;
}

const LABELS: Partial<Record<LimitKey, { nome: string; acao: (excesso: number) => string }>> = {
  forms: { nome: 'formulários', acao: (n) => `arquive ${n}` },
  members: { nome: 'membros', acao: (n) => `remova ${n}` },
  customDomains: { nome: 'domínios personalizados', acao: () => 'serão desativados' },
  apiKeys: { nome: 'chaves de API', acao: (n) => `revogue ${n}` },
};

/**
 * O que impede a troca para um plano menor.
 *
 * Nada é apagado automaticamente — a regra da seção 6.2 é explícita. O cliente
 * recebe a lista do que precisa ajustar e decide.
 */
export function downgradeBlockers(params: {
  targetPlanCode: string;
  usage: UsageSnapshot;
  addons?: AddonTotals;
}): DowngradeBlocker[] {
  const plan = getPlan(params.targetPlanCode as PlanCode);
  const addons = params.addons ?? NO_ADDONS;

  const atual: Partial<Record<LimitKey, number>> = {
    forms: params.usage.formsCount,
    members: params.usage.membersCount,
    customDomains: params.usage.customDomainsCount,
    apiKeys: params.usage.apiKeysCount,
  };

  const bloqueios: DowngradeBlocker[] = [];

  for (const [key, current] of Object.entries(atual) as Array<[LimitKey, number]>) {
    const limit = effectiveLimit(plan, key, addons);
    if (isUnlimited(limit) || current <= limit) continue;

    const rotulo = LABELS[key];
    const excess = current - limit;

    bloqueios.push({
      key,
      label: rotulo?.nome ?? key,
      current,
      limit,
      excess,
      action: rotulo?.acao(excess) ?? `reduza ${excess}`,
    });
  }

  return bloqueios;
}

// -----------------------------------------------------------------------------
// Período
// -----------------------------------------------------------------------------

/**
 * Soma meses preservando o dia, com clamp no último dia do mês de destino.
 *
 * `setUTCMonth` sozinho transborda: 31 de janeiro + 1 mês vira 3 de março,
 * porque fevereiro não tem dia 31. Numa assinatura recorrente isso significaria
 * o ciclo andando alguns dias para frente todo ano — e cobrança em data que o
 * cliente não reconhece.
 */
export function addMonths(date: Date, months: number): Date {
  const ano = date.getUTCFullYear();
  const mes = date.getUTCMonth() + months;
  const dia = date.getUTCDate();

  // Dia 0 do mês seguinte é o último dia do mês alvo.
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      ano,
      mes,
      Math.min(dia, ultimoDia),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * O ciclo começa em `current_period_start` da assinatura, não no dia 1.
 *
 * Assinar dia 12 e ver a cota zerar dia 1 seria dar meio mês de graça para uns
 * e cobrar mês cheio de outros.
 */
export function currentPeriod(subscriptionStart: Date, now: Date): { start: Date; end: Date } {
  // Estimativa direta em vez de laço mês a mês: uma assinatura de cinco anos
  // não precisa de sessenta iterações.
  const mesesAproximados =
    (now.getUTCFullYear() - subscriptionStart.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - subscriptionStart.getUTCMonth());

  let ciclos = Math.max(0, mesesAproximados);
  let start = addMonths(subscriptionStart, ciclos);

  // Ajusta para trás ou para frente conforme o dia do mês.
  while (start > now && ciclos > 0) {
    ciclos -= 1;
    start = addMonths(subscriptionStart, ciclos);
  }
  while (addMonths(subscriptionStart, ciclos + 1) <= now) {
    ciclos += 1;
    start = addMonths(subscriptionStart, ciclos);
  }

  return { start, end: addMonths(subscriptionStart, ciclos + 1) };
}
