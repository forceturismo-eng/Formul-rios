# ADR 0004 — Gateway de pagamento e emissor de NFS-e

- **Status:** aceito (implementação na Fase 3)
- **Data:** 2026-08-04

## Contexto

O produto vende por assinatura para empresas brasileiras. Isso significa três
formas de pagamento que não são negociáveis no mercado local — cartão, Pix e
boleto — mais NFS-e emitida a cada cobrança confirmada.

Gateways internacionais (Stripe, Paddle) tratam boleto como cidadão de segunda
classe e não emitem NFS-e municipal. Boleto não é detalhe: é como boa parte das
empresas brasileiras paga fornecedor, e é o que o plano Business promete no
ciclo mensal.

## Decisão

**Asaas** como provedor padrão, atrás da interface `PaymentProvider`.

Nenhum código de domínio importa o SDK do gateway. A interface é:

```typescript
interface PaymentProvider {
  createCustomer(org, billingProfile): Promise<ProviderCustomerId>
  createSubscription(params): Promise<ProviderSubscription>
  updateSubscription(id, params): Promise<ProviderSubscription>
  cancelSubscription(id): Promise<void>
  getInvoice(id): Promise<ProviderInvoice>
  listInvoices(subscriptionId): Promise<ProviderInvoice[]>
  generateBoleto(invoiceId): Promise<{ barcode, pdfUrl, dueDate }>
  generatePix(invoiceId): Promise<{ qrCode, copyPaste, expiresAt }>
  handleWebhook(payload, signature): Promise<NormalizedEvent>
}
```

Emissão fiscal fica em `InvoiceIssuer`, separada do gateway — trocar de emissor
de NFS-e não deve implicar trocar de gateway.

## Por que Asaas

- Cartão, Pix e boleto num provedor só, com API única.
- Recorrência nativa, incluindo boleto — que é o caso difícil.
- Webhooks com token de validação.
- Preço por transação compatível com um ticket de R$ 79 a R$ 499.

## Consequências e regras que decorrem disso

**Boleto é assíncrono, e isso muda o desenho.** A compensação leva de 1 a 3
dias úteis. Suspender conta na data de vencimento derruba cliente adimplente
cujo pagamento está em trânsito. Daí a máquina de estados com tolerância:

```
trialing → active → pending_payment → overdue → suspended → canceled
```

Cinco dias corridos de tolerância no boleto, três no Pix, três tentativas no
cartão.

**Idempotência não é opcional.** `payment_events.provider_event_id` é `UNIQUE`.
Gateway reenvia webhook, e processar duas vezes significa cobrar duas vezes ou
creditar duas vezes.

**Reconciliação diária é obrigatória.** Um job compara status local com o
status no gateway e corrige divergências: boleto pago fora do fluxo, baixa
manual, pagamento duplicado. Webhook se perde — é HTTP. Esse job é o que evita
cliente pagante ficar suspenso, e por isso não é considerado opcional.

**Dinheiro em centavos, sempre.** `Int` no banco, `number` inteiro no código,
formatação só na borda com `Intl.NumberFormat('pt-BR')`. Nunca float: uma
fatura errada por um centavo é problema fiscal, não arredondamento.

## Alternativas descartadas

**Stripe.** Melhor DX do mercado, mas boleto é limitado e NFS-e não existe.
Exigiria um segundo provedor só para o fiscal.

**Integração direta com banco (API PIX + CNAB).** Menor custo por transação,
custo de desenvolvimento e manutenção incompatível com a fase do produto.

**Mercado Pago.** Cobre os três meios, mas a API de assinatura é menos previsível
para recorrência com boleto.

A interface abstrata existe justamente para que essa escolha seja revisável sem
reescrever o domínio.
