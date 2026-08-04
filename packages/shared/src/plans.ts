/**
 * Catálogo de planos e add-ons.
 *
 * Regras que valem para o arquivo inteiro:
 * - Todo valor monetário é BRL em CENTAVOS (integer). Nunca float, nunca string.
 * - `-1` em um limite significa ILIMITADO. Use `isUnlimited()` — nunca compare direto.
 * - O preço anual é 10x o mensal (dois meses grátis).
 * - Este arquivo é a fonte da verdade. A tabela `plans` no banco é populada a
 *   partir daqui pelo seed; o enforcement lê daqui, não do banco.
 */

export const UNLIMITED = -1;

export type PlanCode = 'free' | 'starter' | 'pro' | 'business' | 'enterprise';
export type BillingType = 'credit_card' | 'pix' | 'boleto' | 'invoice';
export type BillingCycle = 'monthly' | 'semiannual' | 'annual';
export type ExportFormat = 'csv' | 'xlsx' | 'pdf' | 'json';
export type ConditionalLogicLevel = 'basic' | 'full';

export interface PlanLimits {
  forms: number;
  responsesPerMonth: number;
  members: number;
  storageMb: number;
  aiAnalysesPerMonth: number;
  customDomains: number;
  fileUploadMaxMb: number;
  formPagesMax: number;
  webhooksPerForm: number;
  apiKeys: number;
  responseRetentionDays: number;
  auditLogRetentionDays: number;
}

export type LimitKey = keyof PlanLimits;

export interface PlanFeatures {
  conditionalLogic: ConditionalLogicLevel;
  calculations: boolean;
  removeBranding: boolean;
  customCss: boolean;
  customDomain: boolean;
  apiAccess: boolean;
  webhooks: boolean;
  aiAnalysis: boolean;
  exportFormats: readonly ExportFormat[];
  customEmailSender: boolean;
  sso: boolean;
  prioritySupport: boolean;
  signatureField: boolean;
  paymentFields: boolean;
  /** Somente Enterprise. */
  dedicatedDatabase?: boolean;
  customDpa?: boolean;
  slaUptime?: number;
}

export type FeatureKey = keyof PlanFeatures;

export interface Plan {
  code: PlanCode;
  name: string;
  tagline: string;
  /** `null` = sob consulta (Enterprise). */
  priceMonthlyCents: number | null;
  priceYearlyCents: number | null;
  isPublic: boolean;
  isHighlighted?: boolean;
  isContactSales?: boolean;
  /** Business+ exige MFA no owner. Verificado no login e ao trocar de plano. */
  requiresOwnerMfa?: boolean;
  sortOrder: number;
  trialDays: number;
  allowedBillingTypes: readonly BillingType[];
  boletoCycles: readonly BillingCycle[];
  limits: PlanLimits;
  features: PlanFeatures;
}

export const PLANS: readonly Plan[] = [
  {
    code: 'free',
    name: 'Free',
    tagline: 'Para testar antes de decidir.',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    isPublic: true,
    sortOrder: 1,
    trialDays: 0,
    allowedBillingTypes: [],
    boletoCycles: [],
    limits: {
      forms: 3,
      responsesPerMonth: 100,
      members: 1,
      storageMb: 100,
      aiAnalysesPerMonth: 0,
      customDomains: 0,
      fileUploadMaxMb: 5,
      formPagesMax: 3,
      webhooksPerForm: 0,
      apiKeys: 0,
      responseRetentionDays: 90,
      auditLogRetentionDays: 0,
    },
    features: {
      conditionalLogic: 'basic',
      calculations: false,
      removeBranding: false,
      customCss: false,
      customDomain: false,
      apiAccess: false,
      webhooks: false,
      aiAnalysis: false,
      exportFormats: ['csv'],
      customEmailSender: false,
      sso: false,
      prioritySupport: false,
      signatureField: false,
      paymentFields: false,
    },
  },
  {
    code: 'starter',
    name: 'Starter',
    tagline: 'Para quem já recebe formulário todo dia.',
    priceMonthlyCents: 7900,
    priceYearlyCents: 79000,
    isPublic: true,
    sortOrder: 2,
    trialDays: 14,
    allowedBillingTypes: ['credit_card', 'pix', 'boleto'],
    boletoCycles: ['annual'],
    limits: {
      forms: 15,
      responsesPerMonth: 1000,
      members: 3,
      storageMb: 2048,
      aiAnalysesPerMonth: 50,
      customDomains: 0,
      fileUploadMaxMb: 25,
      formPagesMax: 10,
      webhooksPerForm: 2,
      apiKeys: 0,
      responseRetentionDays: 365,
      auditLogRetentionDays: 30,
    },
    features: {
      conditionalLogic: 'full',
      calculations: true,
      removeBranding: false,
      customCss: false,
      customDomain: false,
      apiAccess: false,
      webhooks: true,
      aiAnalysis: true,
      exportFormats: ['csv', 'xlsx'],
      customEmailSender: false,
      sso: false,
      prioritySupport: false,
      signatureField: true,
      paymentFields: false,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    tagline: 'Para empresas que atendem clientes pelo formulário.',
    priceMonthlyCents: 19900,
    priceYearlyCents: 199000,
    isPublic: true,
    isHighlighted: true,
    sortOrder: 3,
    trialDays: 14,
    allowedBillingTypes: ['credit_card', 'pix', 'boleto'],
    boletoCycles: ['semiannual', 'annual'],
    limits: {
      forms: 50,
      responsesPerMonth: 5000,
      members: 10,
      storageMb: 20480,
      aiAnalysesPerMonth: 300,
      customDomains: 1,
      fileUploadMaxMb: 100,
      formPagesMax: UNLIMITED,
      webhooksPerForm: 10,
      apiKeys: 3,
      responseRetentionDays: 1095,
      auditLogRetentionDays: 365,
    },
    features: {
      conditionalLogic: 'full',
      calculations: true,
      removeBranding: true,
      customCss: false,
      customDomain: true,
      apiAccess: true,
      webhooks: true,
      aiAnalysis: true,
      exportFormats: ['csv', 'xlsx', 'pdf', 'json'],
      customEmailSender: false,
      sso: false,
      prioritySupport: false,
      signatureField: true,
      paymentFields: true,
    },
  },
  {
    code: 'business',
    name: 'Business',
    tagline: 'Para operações com volume alto e várias equipes.',
    priceMonthlyCents: 49900,
    priceYearlyCents: 499000,
    isPublic: true,
    sortOrder: 4,
    trialDays: 14,
    allowedBillingTypes: ['credit_card', 'pix', 'boleto'],
    boletoCycles: ['monthly', 'semiannual', 'annual'],
    requiresOwnerMfa: true,
    limits: {
      forms: UNLIMITED,
      responsesPerMonth: 25000,
      members: 30,
      storageMb: 102400,
      aiAnalysesPerMonth: 1500,
      customDomains: 5,
      fileUploadMaxMb: 500,
      formPagesMax: UNLIMITED,
      webhooksPerForm: UNLIMITED,
      apiKeys: 10,
      responseRetentionDays: UNLIMITED,
      auditLogRetentionDays: UNLIMITED,
    },
    features: {
      conditionalLogic: 'full',
      calculations: true,
      removeBranding: true,
      customCss: true,
      customDomain: true,
      apiAccess: true,
      webhooks: true,
      aiAnalysis: true,
      exportFormats: ['csv', 'xlsx', 'pdf', 'json'],
      customEmailSender: true,
      sso: false,
      prioritySupport: true,
      signatureField: true,
      paymentFields: true,
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    tagline: 'Contrato, SLA e banco de dados dedicado.',
    priceMonthlyCents: null,
    priceYearlyCents: null,
    isPublic: true,
    isContactSales: true,
    sortOrder: 5,
    trialDays: 0,
    allowedBillingTypes: ['credit_card', 'pix', 'boleto', 'invoice'],
    boletoCycles: ['monthly', 'semiannual', 'annual'],
    requiresOwnerMfa: true,
    limits: {
      forms: UNLIMITED,
      responsesPerMonth: UNLIMITED,
      members: UNLIMITED,
      storageMb: UNLIMITED,
      aiAnalysesPerMonth: UNLIMITED,
      customDomains: UNLIMITED,
      fileUploadMaxMb: 1024,
      formPagesMax: UNLIMITED,
      webhooksPerForm: UNLIMITED,
      apiKeys: UNLIMITED,
      responseRetentionDays: UNLIMITED,
      auditLogRetentionDays: UNLIMITED,
    },
    features: {
      conditionalLogic: 'full',
      calculations: true,
      removeBranding: true,
      customCss: true,
      customDomain: true,
      apiAccess: true,
      webhooks: true,
      aiAnalysis: true,
      exportFormats: ['csv', 'xlsx', 'pdf', 'json'],
      customEmailSender: true,
      sso: true,
      prioritySupport: true,
      signatureField: true,
      paymentFields: true,
      dedicatedDatabase: true,
      customDpa: true,
      slaUptime: 99.9,
    },
  },
];

export interface Addon {
  code: string;
  name: string;
  priceCents: number;
  unit: LimitKey | 'responses' | 'aiAnalyses';
  amount: number;
  recurring?: boolean;
}

export const ADDONS: readonly Addon[] = [
  { code: 'responses_1k', name: '+1.000 respostas', priceCents: 4900, unit: 'responses', amount: 1000 },
  { code: 'responses_5k', name: '+5.000 respostas', priceCents: 19900, unit: 'responses', amount: 5000 },
  { code: 'storage_10gb', name: '+10 GB', priceCents: 3900, unit: 'storageMb', amount: 10240 },
  { code: 'ai_500', name: '+500 análises IA', priceCents: 9900, unit: 'aiAnalyses', amount: 500 },
  { code: 'member_extra', name: '+1 membro', priceCents: 2900, unit: 'members', amount: 1, recurring: true },
  { code: 'domain_extra', name: '+1 domínio', priceCents: 4900, unit: 'customDomains', amount: 1, recurring: true },
];

const PLANS_BY_CODE = new Map<PlanCode, Plan>(PLANS.map((p) => [p.code, p]));
const ADDONS_BY_CODE = new Map<string, Addon>(ADDONS.map((a) => [a.code, a]));

export function getPlan(code: PlanCode): Plan {
  const plan = PLANS_BY_CODE.get(code);
  if (!plan) throw new Error(`Plano desconhecido: ${code}`);
  return plan;
}

export function findPlan(code: string): Plan | undefined {
  return PLANS_BY_CODE.get(code as PlanCode);
}

export function getAddon(code: string): Addon | undefined {
  return ADDONS_BY_CODE.get(code);
}

export function isUnlimited(limit: number): boolean {
  return limit === UNLIMITED;
}

/** `true` quando ainda cabe pelo menos mais `increment` unidades. */
export function withinLimit(limit: number, current: number, increment = 1): boolean {
  if (isUnlimited(limit)) return true;
  return current + increment <= limit;
}

/** Quanto ainda cabe. `null` quando ilimitado. */
export function remainingQuota(limit: number, current: number): number | null {
  if (isUnlimited(limit)) return null;
  return Math.max(0, limit - current);
}

export function planSupportsBoleto(plan: Plan, cycle: BillingCycle): boolean {
  return plan.boletoCycles.includes(cycle);
}
