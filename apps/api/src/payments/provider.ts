import type { BillingCycle, BillingType } from '@forms/shared';

/**
 * Contrato do gateway de pagamento.
 *
 * Nenhum código de domínio importa o SDK do gateway. A razão prática está no
 * ADR 0004: boleto, Pix e NFS-e municipal amarram a gente a um provedor
 * brasileiro, e essa escolha precisa ser revisável sem reescrever cobrança.
 *
 * A razão imediata é outra: com a interface, os testes rodam contra um
 * provedor falso e exercitam a máquina de estados inteira — inclusive
 * pagamento em atraso, estorno e webhook duplicado — sem depender de sandbox
 * externo nem de credencial.
 */

export type ProviderCustomerId = string;

export interface ProviderCustomerInput {
  organizationId: string;
  name: string;
  email: string;
  /** Somente dígitos, já validado por algoritmo. */
  document: string;
  documentType: 'cpf' | 'cnpj';
  phone?: string;
  address: {
    zip: string;
    street: string;
    number: string;
    complement?: string;
    district: string;
    city: string;
    state: string;
  };
}

export interface ProviderSubscriptionInput {
  customerId: ProviderCustomerId;
  planCode: string;
  billingType: BillingType;
  cycle: BillingCycle;
  amountCents: number;
  /** Primeiro vencimento. Boleto é gerado 7 dias antes (seção 7.2). */
  nextDueDate: Date;
  description: string;
  /** Só para cartão. O número em si NUNCA passa pelos nossos servidores. */
  creditCardToken?: string;
}

export interface ProviderSubscription {
  id: string;
  status: string;
  nextDueDate: Date;
}

export interface ProviderInvoice {
  id: string;
  subscriptionId: string | null;
  amountCents: number;
  status: 'pending' | 'paid' | 'overdue' | 'canceled' | 'refunded';
  billingType: BillingType;
  dueDate: Date;
  paidAt: Date | null;
  boletoUrl?: string;
  boletoBarcode?: string;
  pixQrcode?: string;
  pixCopyPaste?: string;
}

export interface BoletoData {
  barcode: string;
  pdfUrl: string;
  dueDate: Date;
}

export interface PixData {
  qrCode: string;
  copyPaste: string;
  expiresAt: Date;
}

/**
 * Evento normalizado.
 *
 * O domínio nunca vê o vocabulário do gateway. Trocar de provedor significa
 * escrever outro tradutor, não mexer na máquina de estados da assinatura.
 */
export type NormalizedEventType =
  | 'PAYMENT_CONFIRMED'
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_OVERDUE'
  | 'PAYMENT_REFUNDED'
  | 'SUBSCRIPTION_CANCELED'
  | 'SUBSCRIPTION_UPDATED'
  | 'UNKNOWN';

export interface NormalizedEvent {
  /** Chave de idempotência. É o que a coluna `provider_event_id` guarda. */
  providerEventId: string;
  type: NormalizedEventType;
  providerInvoiceId: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  amountCents: number | null;
  paidAt: Date | null;
  dueDate: Date | null;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;

  createCustomer(input: ProviderCustomerInput): Promise<ProviderCustomerId>;
  createSubscription(input: ProviderSubscriptionInput): Promise<ProviderSubscription>;
  updateSubscription(id: string, input: Partial<ProviderSubscriptionInput>): Promise<ProviderSubscription>;
  cancelSubscription(id: string): Promise<void>;

  getInvoice(id: string): Promise<ProviderInvoice>;
  listInvoices(subscriptionId: string): Promise<ProviderInvoice[]>;

  generateBoleto(invoiceId: string): Promise<BoletoData>;
  generatePix(invoiceId: string): Promise<PixData>;

  /**
   * Traduz o webhook do gateway para o vocabulário do domínio.
   *
   * Valida a assinatura/token do provedor antes de qualquer coisa. Lança se a
   * origem não confere — um webhook de pagamento aceito sem verificação é um
   * endpoint para creditar assinatura de graça.
   */
  handleWebhook(payload: unknown, signature: string | undefined): Promise<NormalizedEvent>;
}

export class PaymentProviderError extends Error {
  readonly providerStatus?: number;

  constructor(message: string, providerStatus?: number) {
    super(message);
    this.name = 'PaymentProviderError';
    if (providerStatus !== undefined) this.providerStatus = providerStatus;
  }
}

let provider: PaymentProvider | null = null;

export function setPaymentProvider(next: PaymentProvider): void {
  provider = next;
}

export function payments(): PaymentProvider {
  if (!provider) {
    throw new PaymentProviderError(
      'Nenhum provedor de pagamento configurado. Defina ASAAS_API_KEY ou registre um provedor nos testes.',
    );
  }
  return provider;
}

export function hasPaymentProvider(): boolean {
  return provider !== null;
}
