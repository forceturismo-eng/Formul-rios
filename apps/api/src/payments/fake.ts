import { randomUUID } from 'node:crypto';
import type {
  BoletoData,
  NormalizedEvent,
  NormalizedEventType,
  PaymentProvider,
  PixData,
  ProviderCustomerId,
  ProviderCustomerInput,
  ProviderInvoice,
  ProviderSubscription,
  ProviderSubscriptionInput,
} from './provider.js';

/**
 * Provedor falso, em memória.
 *
 * Serve para dois usos legítimos:
 *
 *  1. Os testes. A máquina de estados de cobrança — trial, atraso, tolerância,
 *     suspensão, estorno, webhook duplicado — precisa ser exercitada inteira, e
 *     depender de sandbox externo tornaria a suíte lenta e intermitente.
 *  2. Desenvolvimento sem credencial. Quem está mexendo no builder não deveria
 *     precisar de uma conta no gateway para subir o projeto.
 *
 * Ele NÃO é um mock de teste unitário: implementa o contrato de verdade,
 * guarda estado e responde de forma coerente. O que ele não faz é falar com a
 * rede.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  private readonly customers = new Map<string, ProviderCustomerInput>();
  private readonly subscriptions = new Map<string, ProviderSubscription & { customerId: string; amountCents: number }>();
  private readonly invoices = new Map<string, ProviderInvoice>();
  /** Token esperado nos webhooks, para exercitar a verificação de origem. */
  readonly webhookToken = 'token-de-teste';

  async createCustomer(input: ProviderCustomerInput): Promise<ProviderCustomerId> {
    const id = `cus_${randomUUID()}`;
    this.customers.set(id, input);
    return id;
  }

  async createSubscription(input: ProviderSubscriptionInput): Promise<ProviderSubscription> {
    const id = `sub_${randomUUID()}`;
    const assinatura = {
      id,
      status: 'ACTIVE',
      nextDueDate: input.nextDueDate,
      customerId: input.customerId,
      amountCents: input.amountCents,
    };
    this.subscriptions.set(id, assinatura);

    // Toda assinatura já nasce com a primeira cobrança em aberto, como no
    // gateway real.
    this.criarFatura(id, input.amountCents, input.billingType, input.nextDueDate);

    return { id, status: assinatura.status, nextDueDate: assinatura.nextDueDate };
  }

  async updateSubscription(id: string, input: Partial<ProviderSubscriptionInput>): Promise<ProviderSubscription> {
    const atual = this.subscriptions.get(id);
    if (!atual) throw new Error(`assinatura ${id} não existe`);

    if (input.amountCents !== undefined) atual.amountCents = input.amountCents;
    if (input.nextDueDate) atual.nextDueDate = input.nextDueDate;

    return { id, status: atual.status, nextDueDate: atual.nextDueDate };
  }

  async cancelSubscription(id: string): Promise<void> {
    const atual = this.subscriptions.get(id);
    if (atual) atual.status = 'CANCELED';
  }

  async getInvoice(id: string): Promise<ProviderInvoice> {
    const fatura = this.invoices.get(id);
    if (!fatura) throw new Error(`fatura ${id} não existe`);
    return { ...fatura };
  }

  async listInvoices(subscriptionId: string): Promise<ProviderInvoice[]> {
    return [...this.invoices.values()].filter((f) => f.subscriptionId === subscriptionId);
  }

  async generateBoleto(invoiceId: string): Promise<BoletoData> {
    const fatura = await this.getInvoice(invoiceId);
    return {
      barcode: '34191.79001 01043.510047 91020.150008 1 99999999999999',
      pdfUrl: `https://fake.local/boleto/${invoiceId}.pdf`,
      dueDate: fatura.dueDate,
    };
  }

  async generatePix(invoiceId: string): Promise<PixData> {
    const fatura = await this.getInvoice(invoiceId);
    return {
      qrCode: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      copyPaste: `00020126580014BR.GOV.BCB.PIX0136${invoiceId}5204000053039865802BR`,
      expiresAt: new Date(fatura.dueDate.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  async handleWebhook(payload: unknown, signature: string | undefined): Promise<NormalizedEvent> {
    if (signature !== this.webhookToken) throw new Error('Token de webhook inválido.');

    const corpo = (payload ?? {}) as Record<string, unknown>;
    const pagamento = (corpo['payment'] ?? {}) as Record<string, unknown>;

    return {
      providerEventId: String(corpo['id'] ?? randomUUID()),
      type: (corpo['event'] as NormalizedEventType) ?? 'UNKNOWN',
      providerInvoiceId: pagamento['id'] ? String(pagamento['id']) : null,
      providerSubscriptionId: pagamento['subscription'] ? String(pagamento['subscription']) : null,
      providerCustomerId: pagamento['customer'] ? String(pagamento['customer']) : null,
      amountCents: typeof pagamento['value'] === 'number' ? Math.round((pagamento['value'] as number) * 100) : null,
      paidAt: pagamento['paymentDate'] ? new Date(String(pagamento['paymentDate'])) : null,
      dueDate: pagamento['dueDate'] ? new Date(String(pagamento['dueDate'])) : null,
      raw: payload,
    };
  }

  // ---------------------------------------------------------------------------
  // Controles de teste — o que o gateway real faria sozinho
  // ---------------------------------------------------------------------------

  private criarFatura(
    subscriptionId: string,
    amountCents: number,
    billingType: ProviderInvoice['billingType'],
    dueDate: Date,
  ): ProviderInvoice {
    const fatura: ProviderInvoice = {
      id: `pay_${randomUUID()}`,
      subscriptionId,
      amountCents,
      status: 'pending',
      billingType,
      dueDate,
      paidAt: null,
    };
    this.invoices.set(fatura.id, fatura);
    return fatura;
  }

  /** Emite a próxima cobrança do ciclo, como o gateway faz na renovação. */
  emitirProximaFatura(subscriptionId: string, dueDate: Date): ProviderInvoice {
    const assinatura = this.subscriptions.get(subscriptionId);
    if (!assinatura) throw new Error(`assinatura ${subscriptionId} não existe`);
    return this.criarFatura(subscriptionId, assinatura.amountCents, 'boleto', dueDate);
  }

  /** Simula a compensação de um pagamento. */
  marcarComoPaga(invoiceId: string, paidAt = new Date()): ProviderInvoice {
    const fatura = this.invoices.get(invoiceId);
    if (!fatura) throw new Error(`fatura ${invoiceId} não existe`);
    fatura.status = 'paid';
    fatura.paidAt = paidAt;
    return fatura;
  }

  marcarComoVencida(invoiceId: string): ProviderInvoice {
    const fatura = this.invoices.get(invoiceId);
    if (!fatura) throw new Error(`fatura ${invoiceId} não existe`);
    fatura.status = 'overdue';
    return fatura;
  }

  /** Monta o corpo de um webhook, no formato que `handleWebhook` espera. */
  webhookBody(type: NormalizedEventType, invoiceId: string, eventId: string = randomUUID()): Record<string, unknown> {
    const fatura = this.invoices.get(invoiceId);
    return {
      id: eventId,
      event: type,
      payment: {
        id: invoiceId,
        subscription: fatura?.subscriptionId ?? null,
        value: fatura ? fatura.amountCents / 100 : 0,
        dueDate: fatura?.dueDate.toISOString().slice(0, 10),
        paymentDate: fatura?.paidAt?.toISOString().slice(0, 10),
      },
    };
  }

  reset(): void {
    this.customers.clear();
    this.subscriptions.clear();
    this.invoices.clear();
  }
}
