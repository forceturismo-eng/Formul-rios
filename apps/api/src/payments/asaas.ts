import { timingSafeEqual } from 'node:crypto';
import type { BillingCycle, BillingType } from '@forms/shared';
import {
  PaymentProviderError,
  type BoletoData,
  type NormalizedEvent,
  type NormalizedEventType,
  type PaymentProvider,
  type PixData,
  type ProviderCustomerId,
  type ProviderCustomerInput,
  type ProviderInvoice,
  type ProviderSubscription,
  type ProviderSubscriptionInput,
} from './provider.js';

/**
 * Implementação do Asaas.
 *
 * Este é o ÚNICO arquivo que conhece o vocabulário do gateway. Se um dia o
 * provedor mudar, é aqui que a mudança acontece — e o teste que prova isso é o
 * da máquina de estados, que roda contra um provedor falso e não toca neste
 * arquivo.
 */

const SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';
const PRODUCTION_URL = 'https://api.asaas.com/v3';

interface AsaasConfig {
  apiKey: string;
  environment: 'sandbox' | 'production';
  /** Token que o Asaas envia no header `asaas-access-token` dos webhooks. */
  webhookToken: string;
}

/** Ciclos do Asaas. `semiannual` não existe lá; vira SEMIANNUALLY na API v3. */
const CICLO: Record<BillingCycle, string> = {
  monthly: 'MONTHLY',
  semiannual: 'SEMIANNUALLY',
  annual: 'YEARLY',
};

const TIPO_COBRANCA: Record<BillingType, string> = {
  credit_card: 'CREDIT_CARD',
  pix: 'PIX',
  boleto: 'BOLETO',
  // "Fatura" (Enterprise, por contrato) é boleto emitido manualmente.
  invoice: 'BOLETO',
};

const TIPO_COBRANCA_REVERSO: Record<string, BillingType> = {
  CREDIT_CARD: 'credit_card',
  PIX: 'pix',
  BOLETO: 'boleto',
  UNDEFINED: 'boleto',
};

/**
 * Eventos do Asaas → vocabulário do domínio.
 *
 * `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` são diferentes lá: o primeiro é a
 * confirmação (cartão autorizado), o segundo é o dinheiro efetivamente
 * disponível. Para boleto, só o segundo importa; para cartão, o primeiro já
 * libera o acesso.
 */
const EVENTOS: Record<string, NormalizedEventType> = {
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_CREATED: 'SUBSCRIPTION_UPDATED',
  PAYMENT_UPDATED: 'SUBSCRIPTION_UPDATED',
  PAYMENT_OVERDUE: 'PAYMENT_OVERDUE',
  PAYMENT_DELETED: 'SUBSCRIPTION_UPDATED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PAYMENT_REFUND_IN_PROGRESS: 'PAYMENT_REFUNDED',
  PAYMENT_CHARGEBACK_REQUESTED: 'PAYMENT_REFUNDED',
  SUBSCRIPTION_DELETED: 'SUBSCRIPTION_CANCELED',
  SUBSCRIPTION_UPDATED: 'SUBSCRIPTION_UPDATED',
};

const STATUS_FATURA: Record<string, ProviderInvoice['status']> = {
  PENDING: 'pending',
  AWAITING_RISK_ANALYSIS: 'pending',
  CONFIRMED: 'paid',
  RECEIVED: 'paid',
  RECEIVED_IN_CASH: 'paid',
  OVERDUE: 'overdue',
  REFUNDED: 'refunded',
  REFUND_REQUESTED: 'refunded',
  CHARGEBACK_REQUESTED: 'refunded',
  DELETED: 'canceled',
};

function comoData(valor: unknown): Date | null {
  if (typeof valor !== 'string' || valor.length === 0) return null;
  const data = new Date(valor.length === 10 ? `${valor}T12:00:00Z` : valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/** O Asaas trabalha em reais com decimal; nós, em centavos inteiros. */
function paraCentavos(valor: unknown): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

function paraReais(centavos: number): number {
  return Number((centavos / 100).toFixed(2));
}

/** `YYYY-MM-DD`, que é o formato que a API espera em datas de vencimento. */
function dataSimples(data: Date): string {
  return data.toISOString().slice(0, 10);
}

export class AsaasProvider implements PaymentProvider {
  readonly name = 'asaas';
  private readonly config: AsaasConfig;
  private readonly baseUrl: string;

  constructor(config: AsaasConfig) {
    this.config = config;
    this.baseUrl = config.environment === 'production' ? PRODUCTION_URL : SANDBOX_URL;
  }

  private async request<T>(path: string, init: { method: string; body?: unknown } = { method: 'GET' }): Promise<T> {
    const resposta = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        access_token: this.config.apiKey,
        // O Asaas pede identificação do integrador nos headers.
        'User-Agent': 'formularios-saas',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => '');
      // A mensagem do gateway não vai para o cliente final: ela pode conter
      // detalhes da nossa conta. Vai para o log, via `PaymentProviderError`.
      throw new PaymentProviderError(`Asaas respondeu ${resposta.status}: ${corpo.slice(0, 500)}`, resposta.status);
    }

    return (await resposta.json()) as T;
  }

  async createCustomer(input: ProviderCustomerInput): Promise<ProviderCustomerId> {
    const criado = await this.request<{ id: string }>('/customers', {
      method: 'POST',
      body: {
        name: input.name,
        email: input.email,
        cpfCnpj: input.document,
        phone: input.phone,
        postalCode: input.address.zip,
        address: input.address.street,
        addressNumber: input.address.number,
        complement: input.address.complement,
        province: input.address.district,
        // Referência externa: é como reconciliamos cliente daqui com cliente
        // de lá quando algo diverge.
        externalReference: input.organizationId,
        notificationDisabled: false,
      },
    });

    return criado.id;
  }

  async createSubscription(input: ProviderSubscriptionInput): Promise<ProviderSubscription> {
    const criada = await this.request<{ id: string; status: string; nextDueDate: string }>('/subscriptions', {
      method: 'POST',
      body: {
        customer: input.customerId,
        billingType: TIPO_COBRANCA[input.billingType],
        value: paraReais(input.amountCents),
        nextDueDate: dataSimples(input.nextDueDate),
        cycle: CICLO[input.cycle],
        description: input.description,
        externalReference: input.planCode,
        ...(input.creditCardToken ? { creditCardToken: input.creditCardToken } : {}),
      },
    });

    return {
      id: criada.id,
      status: criada.status,
      nextDueDate: comoData(criada.nextDueDate) ?? input.nextDueDate,
    };
  }

  async updateSubscription(id: string, input: Partial<ProviderSubscriptionInput>): Promise<ProviderSubscription> {
    const atualizada = await this.request<{ id: string; status: string; nextDueDate: string }>(
      `/subscriptions/${id}`,
      {
        method: 'POST',
        body: {
          ...(input.amountCents !== undefined ? { value: paraReais(input.amountCents) } : {}),
          ...(input.cycle ? { cycle: CICLO[input.cycle] } : {}),
          ...(input.billingType ? { billingType: TIPO_COBRANCA[input.billingType] } : {}),
          ...(input.nextDueDate ? { nextDueDate: dataSimples(input.nextDueDate) } : {}),
          // Mudança de plano no meio do ciclo NÃO recria a assinatura: o
          // pro-rata é resolvido por crédito na próxima fatura (seção 6.2).
          updatePendingPayments: false,
        },
      },
    );

    return {
      id: atualizada.id,
      status: atualizada.status,
      nextDueDate: comoData(atualizada.nextDueDate) ?? new Date(),
    };
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.request(`/subscriptions/${id}`, { method: 'DELETE' });
  }

  async getInvoice(id: string): Promise<ProviderInvoice> {
    return this.toInvoice(await this.request<Record<string, unknown>>(`/payments/${id}`));
  }

  async listInvoices(subscriptionId: string): Promise<ProviderInvoice[]> {
    const lista = await this.request<{ data: Array<Record<string, unknown>> }>(
      `/subscriptions/${subscriptionId}/payments`,
    );
    return lista.data.map((item) => this.toInvoice(item));
  }

  private toInvoice(raw: Record<string, unknown>): ProviderInvoice {
    return {
      id: String(raw['id']),
      subscriptionId: raw['subscription'] ? String(raw['subscription']) : null,
      amountCents: paraCentavos(raw['value']) ?? 0,
      status: STATUS_FATURA[String(raw['status'])] ?? 'pending',
      billingType: TIPO_COBRANCA_REVERSO[String(raw['billingType'])] ?? 'boleto',
      dueDate: comoData(raw['dueDate']) ?? new Date(),
      paidAt: comoData(raw['paymentDate']) ?? comoData(raw['clientPaymentDate']),
      ...(raw['bankSlipUrl'] ? { boletoUrl: String(raw['bankSlipUrl']) } : {}),
      ...(raw['invoiceUrl'] && !raw['bankSlipUrl'] ? { boletoUrl: String(raw['invoiceUrl']) } : {}),
    };
  }

  async generateBoleto(invoiceId: string): Promise<BoletoData> {
    const dados = await this.request<{ identificationField: string; barCode: string; expirationDate: string }>(
      `/payments/${invoiceId}/identificationField`,
    );
    const fatura = await this.getInvoice(invoiceId);

    return {
      // Linha digitável, que é o que o cliente copia e cola no internet banking.
      barcode: dados.identificationField ?? dados.barCode,
      pdfUrl: fatura.boletoUrl ?? `${this.baseUrl}/payments/${invoiceId}/identificationField`,
      dueDate: comoData(dados.expirationDate) ?? fatura.dueDate,
    };
  }

  async generatePix(invoiceId: string): Promise<PixData> {
    const dados = await this.request<{ encodedImage: string; payload: string; expirationDate: string }>(
      `/payments/${invoiceId}/pixQrCode`,
    );

    return {
      qrCode: dados.encodedImage,
      copyPaste: dados.payload,
      expiresAt: comoData(dados.expirationDate) ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  async handleWebhook(payload: unknown, signature: string | undefined): Promise<NormalizedEvent> {
    // Sem verificação, este endpoint seria uma forma de creditar assinatura de
    // graça: bastaria alguém postar um PAYMENT_RECEIVED.
    if (!this.verifyToken(signature)) {
      throw new PaymentProviderError('Token de webhook inválido.', 401);
    }

    const corpo = (payload ?? {}) as Record<string, unknown>;
    const pagamento = (corpo['payment'] ?? {}) as Record<string, unknown>;
    const evento = String(corpo['event'] ?? '');

    return {
      // O Asaas manda `id` do evento; sem ele, usamos evento + id do pagamento,
      // que ainda garante idempotência para reenvios do mesmo fato.
      providerEventId: String(corpo['id'] ?? `${evento}:${String(pagamento['id'] ?? '')}`),
      type: EVENTOS[evento] ?? 'UNKNOWN',
      providerInvoiceId: pagamento['id'] ? String(pagamento['id']) : null,
      providerSubscriptionId: pagamento['subscription'] ? String(pagamento['subscription']) : null,
      providerCustomerId: pagamento['customer'] ? String(pagamento['customer']) : null,
      amountCents: paraCentavos(pagamento['value']),
      paidAt: comoData(pagamento['paymentDate']) ?? comoData(pagamento['clientPaymentDate']),
      dueDate: comoData(pagamento['dueDate']),
      raw: payload,
    };
  }

  private verifyToken(signature: string | undefined): boolean {
    if (!this.config.webhookToken) return false;
    if (!signature) return false;

    const esperado = Buffer.from(this.config.webhookToken);
    const recebido = Buffer.from(signature);
    // Comparação em tempo constante: comparar com `===` vazaria o token byte a
    // byte para quem medir o tempo de resposta.
    if (esperado.length !== recebido.length) return false;
    return timingSafeEqual(esperado, recebido);
  }
}

export function createAsaasProvider(env: {
  ASAAS_API_KEY?: string | undefined;
  ASAAS_ENV?: string | undefined;
  ASAAS_WEBHOOK_TOKEN?: string | undefined;
}): AsaasProvider | null {
  if (!env.ASAAS_API_KEY) return null;

  return new AsaasProvider({
    apiKey: env.ASAAS_API_KEY,
    environment: env.ASAAS_ENV === 'production' ? 'production' : 'sandbox',
    webhookToken: env.ASAAS_WEBHOOK_TOKEN ?? '',
  });
}
