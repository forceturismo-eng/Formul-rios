import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant, withoutTenant } from '../../apps/api/src/db/tenant.js';
import { FakePaymentProvider } from '../../apps/api/src/payments/fake.js';
import { setPaymentProvider } from '../../apps/api/src/payments/provider.js';
import { processPaymentEvent, reconcileOrganization } from '../../apps/api/src/queue/billing-worker.js';
import { podeTransicionar } from '../../apps/api/src/services/billing-service.js';

/**
 * Ciclo de cobrança de ponta a ponta, contra um provedor falso que implementa
 * o contrato de verdade.
 *
 * Três casos importam mais que os outros, e todos vêm da seção 7.3:
 *
 *   - Boleto vencido NÃO suspende na data. A tolerância existe porque a
 *     compensação leva de 1 a 3 dias úteis.
 *   - Webhook duplicado não credita duas vezes.
 *   - A reconciliação diária conserta o boleto pago cujo webhook se perdeu —
 *     que é o caso em que um cliente pagante seria suspenso.
 */

const HOST = 'localhost';
let token: string;
const gateway = new FakePaymentProvider();

const PERFIL_FISCAL = {
  documentType: 'cnpj' as const,
  document: '11.222.333/0001-81',
  legalName: 'Agência Alfa Comunicação LTDA',
  tradeName: 'Agência Alfa',
  municipalRegistration: '123456',
  emailBilling: 'financeiro@alfa.test',
  phone: '(11) 3333-4444',
  addressZip: '01310-100',
  addressStreet: 'Avenida Paulista',
  addressNumber: '1000',
  addressComplement: 'conjunto 12',
  addressDistrict: 'Bela Vista',
  addressCity: 'São Paulo',
  addressState: 'SP',
};

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

/**
 * Apaga o que ESTE teste criou, e só isso.
 *
 * Assinatura e fatura do seed têm `provider*Id` nulo — elas ficam, porque a
 * suíte de isolamento monta o inventário de recursos a partir delas. Uma
 * limpeza larga demais aqui quebraria outra suíte de um jeito difícil de
 * rastrear.
 */
async function limparCobranca(): Promise<void> {
  await withTenant(ORG_A.id, async ({ tx }) => {
    await tx.dunningLog.deleteMany({ where: { organizationId: ORG_A.id } });
    await tx.invoice.deleteMany({ where: { organizationId: ORG_A.id, providerInvoiceId: { not: null } } });
    await tx.subscription.deleteMany({
      where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
    });
    // A do seed fica, mas cancelada: `subscribe` recusa criar uma segunda
    // assinatura ativa, e é justamente isso que outro teste aqui verifica.
    await tx.subscription.updateMany({
      where: { organizationId: ORG_A.id, providerSubscriptionId: null },
      data: { status: 'canceled' },
    });
    await tx.organization.update({
      where: { id: ORG_A.id },
      data: { planCode: 'business', subscriptionStatus: 'active' },
    });
  });
  await withoutTenant((tx) => tx.paymentEvent.deleteMany({}));
  gateway.reset();
}

/** Assina e devolve o que o gateway e o banco guardaram. */
async function assinar(
  billingType: 'boleto' | 'pix' | 'credit_card' = 'boleto',
  cycle: 'monthly' | 'semiannual' | 'annual' = 'annual',
) {
  await api('PUT', '/v1/billing/profile', PERFIL_FISCAL);
  const resposta = await api('POST', '/v1/billing/subscribe', { planCode: 'pro', cycle, billingType });
  if (resposta.statusCode !== 201) throw new Error(`assinatura falhou: ${resposta.body}`);

  // Filtra pela assinatura DESTE teste: a do seed continua na tabela, porque a
  // suíte de isolamento monta o inventário a partir dela.
  const assinatura = await withTenant(ORG_A.id, ({ tx }) =>
    tx.subscription.findFirstOrThrow({
      where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
    }),
  );
  const faturas = await gateway.listInvoices(assinatura.providerSubscriptionId as string);

  return { assinatura, faturaRemota: faturas[0]! };
}

/** Registra a fatura local, como o webhook de criação faria. */
async function registrarFaturaLocal(providerInvoiceId: string, dueDate: Date, status: 'pending' | 'overdue' = 'pending') {
  return withTenant(ORG_A.id, async ({ tx }) => {
    const assinatura = await tx.subscription.findFirstOrThrow({
      where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
    });
    return tx.invoice.create({
      data: {
        organizationId: ORG_A.id,
        subscriptionId: assinatura.id,
        providerInvoiceId,
        amountCents: assinatura.amountCents,
        status,
        billingType: assinatura.billingType,
        dueDate,
      },
    });
  });
}

beforeAll(() => {
  setPaymentProvider(gateway);
});

beforeEach(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;
  await limparCobranca();
});

afterAll(async () => {
  await limparCobranca();
  await closeApp();
});

describe('cadastro fiscal', () => {
  it('grava e devolve o documento mascarado', async () => {
    const resposta = await api('PUT', '/v1/billing/profile', PERFIL_FISCAL);

    expect(resposta.statusCode).toBe(200);
    const body = resposta.json() as { document: string; legalName: string };

    // O número inteiro não volta a cada carregamento de tela.
    expect(body.document).toBe('***0181');
    expect(body.legalName).toBe('Agência Alfa Comunicação LTDA');
  });

  it('recusa CNPJ com formato certo e dígito errado', async () => {
    // Validação por algoritmo, não por formato: sem isso a NFS-e seria
    // rejeitada pela prefeitura depois do pagamento.
    const resposta = await api('PUT', '/v1/billing/profile', { ...PERFIL_FISCAL, document: '11.222.333/0001-82' });

    expect(resposta.statusCode).toBe(422);
  });

  it('recusa CPF declarado como CNPJ', async () => {
    const resposta = await api('PUT', '/v1/billing/profile', {
      ...PERFIL_FISCAL,
      documentType: 'cnpj',
      document: '529.982.247-25',
    });

    expect(resposta.statusCode).toBe(422);
  });
});

describe('assinatura', () => {
  it('exige cadastro fiscal antes de assinar', async () => {
    await withTenant(ORG_A.id, ({ tx }) => tx.billingProfile.deleteMany({ where: { organizationId: ORG_A.id } }));

    const resposta = await api('POST', '/v1/billing/subscribe', {
      planCode: 'pro',
      cycle: 'annual',
      billingType: 'boleto',
    });

    expect(resposta.statusCode).toBe(422);
    expect(resposta.body).toContain('dados fiscais');
  });

  it('assina no Pro anual com boleto', async () => {
    const { assinatura } = await assinar('boleto', 'annual');

    expect(assinatura.planCode).toBe('pro');
    // R$ 1.990,00 em centavos, inteiro.
    expect(assinatura.amountCents).toBe(199000);
    // Ainda não há dinheiro compensado.
    expect(assinatura.status).toBe('pending_payment');
    expect(assinatura.providerSubscriptionId).toBeTruthy();
  });

  it('o boleto vence com sete dias de antecedência', async () => {
    const { assinatura } = await assinar('boleto');

    const dias = Math.round((assinatura.nextDueDate!.getTime() - Date.now()) / (24 * 3600_000));
    // O boleto precisa chegar ao cliente antes de vencer (seção 7.2).
    expect(dias).toBeGreaterThanOrEqual(6);
  });

  it('recusa boleto num ciclo que o plano não permite', async () => {
    await api('PUT', '/v1/billing/profile', PERFIL_FISCAL);

    // Pro aceita boleto no semestral e no anual, não no mensal.
    const resposta = await api('POST', '/v1/billing/subscribe', {
      planCode: 'pro',
      cycle: 'monthly',
      billingType: 'boleto',
    });

    expect(resposta.statusCode).toBe(422);
    expect(resposta.body).toContain('boleto');
  });

  it('aceita cartão e Pix em qualquer ciclo do Pro', async () => {
    await limparCobranca();
    expect((await assinar('pix', 'monthly')).assinatura.status).toBe('pending_payment');

    await limparCobranca();
    expect((await assinar('credit_card', 'monthly')).assinatura.status).toBe('pending_payment');
  });

  it('não permite duas assinaturas ativas', async () => {
    await assinar();
    const segunda = await api('POST', '/v1/billing/subscribe', {
      planCode: 'starter',
      cycle: 'annual',
      billingType: 'boleto',
    });

    expect(segunda.statusCode).toBe(409);
  });

  it('a prévia mostra preço e disponibilidade de boleto por ciclo', async () => {
    const anual = (await api('GET', '/v1/billing/quote?planCode=pro&cycle=annual')).json() as {
      amountCents: number;
      boletoAvailable: boolean;
    };
    const mensal = (await api('GET', '/v1/billing/quote?planCode=pro&cycle=monthly')).json() as {
      amountCents: number;
      boletoAvailable: boolean;
    };

    expect(anual.amountCents).toBe(199000);
    expect(anual.boletoAvailable).toBe(true);
    expect(mensal.amountCents).toBe(19900);
    expect(mensal.boletoAvailable).toBe(false);
  });
});

describe('máquina de estados', () => {
  it('só permite as transições previstas', () => {
    expect(podeTransicionar('pending_payment', 'active')).toBe(true);
    expect(podeTransicionar('active', 'overdue')).toBe(true);
    expect(podeTransicionar('overdue', 'suspended')).toBe(true);
    expect(podeTransicionar('suspended', 'active')).toBe(true);

    // Cancelada é terminal: um webhook atrasado não ressuscita a assinatura.
    expect(podeTransicionar('canceled', 'active')).toBe(false);
    // E não se pula direto de ativa para suspensa, sem passar pela tolerância.
    expect(podeTransicionar('active', 'suspended')).toBe(false);
  });

  it('pagamento confirmado ativa a assinatura', async () => {
    const { faturaRemota } = await assinar();
    await registrarFaturaLocal(faturaRemota.id, faturaRemota.dueDate);
    gateway.marcarComoPaga(faturaRemota.id);

    const resultado = await processPaymentEvent(
      await gateway.handleWebhook(gateway.webhookBody('PAYMENT_RECEIVED', faturaRemota.id), gateway.webhookToken),
    );

    expect(resultado).toBe('applied');

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.findFirstOrThrow({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
      }),
    );
    expect(depois.status).toBe('active');
    expect(depois.graceUntil).toBeNull();
  });

  it('boleto vencido NÃO suspende na data — abre a tolerância de 5 dias', async () => {
    const { faturaRemota } = await assinar('boleto');

    // Vencimento em granularidade de DIA: é assim que o gateway trabalha, e é
    // como ele volta no webhook. Guardar hora aqui criaria uma precisão que o
    // dado não tem.
    const vencimento = new Date(`${faturaRemota.dueDate.toISOString().slice(0, 10)}T12:00:00Z`);
    await registrarFaturaLocal(faturaRemota.id, vencimento);
    gateway.marcarComoVencida(faturaRemota.id);

    await processPaymentEvent(
      await gateway.handleWebhook(gateway.webhookBody('PAYMENT_OVERDUE', faturaRemota.id), gateway.webhookToken),
    );

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.findFirstOrThrow({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
      }),
    );

    // Suspender aqui derrubaria cliente adimplente cujo dinheiro está em
    // trânsito — a compensação leva de 1 a 3 dias úteis.
    expect(depois.status).toBe('overdue');
    expect(depois.graceUntil).not.toBeNull();

    // A tolerância conta a partir do vencimento REAL da fatura, que é o que o
    // gateway informa — não de quando o webhook chegou.
    const diasDeTolerancia = Math.round(
      (depois.graceUntil!.getTime() - vencimento.getTime()) / (24 * 3600_000),
    );
    expect(diasDeTolerancia).toBe(5);
  });

  it('pagar dentro da tolerância volta a assinatura para ativa', async () => {
    const { faturaRemota } = await assinar('boleto');
    await registrarFaturaLocal(faturaRemota.id, new Date(Date.now() - 60_000));

    gateway.marcarComoVencida(faturaRemota.id);
    await processPaymentEvent(
      await gateway.handleWebhook(gateway.webhookBody('PAYMENT_OVERDUE', faturaRemota.id), gateway.webhookToken),
    );

    gateway.marcarComoPaga(faturaRemota.id);
    await processPaymentEvent(
      await gateway.handleWebhook(
        gateway.webhookBody('PAYMENT_RECEIVED', faturaRemota.id, 'evento-da-baixa'),
        gateway.webhookToken,
      ),
    );

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.findFirstOrThrow({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
      }),
    );
    expect(depois.status).toBe('active');
    expect(depois.graceUntil).toBeNull();
  });

  it('suspende só depois de a tolerância acabar', async () => {
    const { faturaRemota } = await assinar('boleto');
    await registrarFaturaLocal(faturaRemota.id, new Date(Date.now() - 10 * 24 * 3600_000), 'overdue');

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.updateMany({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
        data: { status: 'overdue', graceUntil: new Date(Date.now() - 24 * 3600_000) },
      }),
    );

    gateway.marcarComoVencida(faturaRemota.id);
    const resultado = await reconcileOrganization(ORG_A.id);

    expect(resultado.suspended).toBe(1);

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.findFirstOrThrow({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
      }),
    );
    expect(depois.status).toBe('suspended');
  });
});

describe('idempotência dos webhooks', () => {
  it('o mesmo evento processado duas vezes não credita duas vezes', async () => {
    const { faturaRemota } = await assinar();
    await registrarFaturaLocal(faturaRemota.id, faturaRemota.dueDate);
    gateway.marcarComoPaga(faturaRemota.id);

    const corpo = gateway.webhookBody('PAYMENT_RECEIVED', faturaRemota.id, 'evento-repetido');

    expect(await processPaymentEvent(await gateway.handleWebhook(corpo, gateway.webhookToken))).toBe('applied');
    // Gateway reenvia webhook. Processar duas vezes seria creditar duas vezes.
    expect(await processPaymentEvent(await gateway.handleWebhook(corpo, gateway.webhookToken))).toBe('duplicate');

    // Conta só as faturas deste teste: a do seed também está paga.
    const faturasPagas = await withTenant(ORG_A.id, ({ tx }) =>
      tx.invoice.count({
        where: { organizationId: ORG_A.id, status: 'paid', providerInvoiceId: { not: null } },
      }),
    );
    expect(faturasPagas).toBe(1);
  });

  it('a trava é o índice único no banco, não a memória do processo', async () => {
    const { faturaRemota } = await assinar();
    await registrarFaturaLocal(faturaRemota.id, faturaRemota.dueDate);

    const corpo = gateway.webhookBody('PAYMENT_RECEIVED', faturaRemota.id, 'evento-unico');
    await processPaymentEvent(await gateway.handleWebhook(corpo, gateway.webhookToken));

    const registros = await withoutTenant((tx) =>
      tx.paymentEvent.count({ where: { providerEventId: 'evento-unico' } }),
    );
    expect(registros).toBe(1);
  });

  it('evento de organização desconhecida é registrado e não aplicado', async () => {
    const resultado = await processPaymentEvent({
      providerEventId: 'evento-orfao',
      type: 'PAYMENT_RECEIVED',
      providerInvoiceId: 'pay_inexistente',
      providerSubscriptionId: 'sub_inexistente',
      providerCustomerId: null,
      amountCents: 1000,
      paidAt: new Date(),
      dueDate: new Date(),
      raw: {},
    });

    // Registrar mesmo sem casar é o que permite investigar depois.
    expect(resultado).toBe('unmatched');

    const registro = await withoutTenant((tx) =>
      tx.paymentEvent.findUniqueOrThrow({ where: { providerEventId: 'evento-orfao' } }),
    );
    expect(registro.processedAt).not.toBeNull();
    expect(registro.error).toContain('nenhuma organização');
  });
});

describe('reconciliação diária', () => {
  it('conserta o boleto pago cujo webhook se perdeu', async () => {
    const { faturaRemota } = await assinar('boleto');
    await registrarFaturaLocal(faturaRemota.id, new Date(Date.now() - 2 * 24 * 3600_000), 'overdue');

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.updateMany({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
        data: { status: 'overdue', graceUntil: new Date(Date.now() + 3 * 24 * 3600_000) },
      }),
    );

    // O cliente pagou no banco; o webhook nunca chegou.
    gateway.marcarComoPaga(faturaRemota.id);

    const resultado = await reconcileOrganization(ORG_A.id);

    expect(resultado.corrected).toBe(1);
    expect(resultado.details[0]).toMatchObject({ from: 'overdue', to: 'paid' });

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.findFirstOrThrow({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
      }),
    );
    // Este é o job que evita cliente pagante ficar suspenso (seção 7.5).
    expect(depois.status).toBe('active');
  });

  it('não mexe no que já está correto', async () => {
    const { faturaRemota } = await assinar();
    await registrarFaturaLocal(faturaRemota.id, faturaRemota.dueDate);

    const resultado = await reconcileOrganization(ORG_A.id);

    expect(resultado.checked).toBe(1);
    expect(resultado.corrected).toBe(0);
  });
});

describe('webhook HTTP', () => {
  it('recusa sem o token do provedor', async () => {
    const app = await getApp();
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { host: HOST },
      payload: { id: 'forjado', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x', value: 1990 } },
    });

    // Sem verificação, este endpoint seria uma forma de creditar assinatura de
    // graça: bastaria postar um PAYMENT_RECEIVED.
    expect(resposta.statusCode).toBe(401);
  });

  it('recusa com token errado', async () => {
    const app = await getApp();
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { host: HOST, 'asaas-access-token': 'token-errado' },
      payload: { id: 'forjado', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } },
    });

    expect(resposta.statusCode).toBe(401);
  });

  it('aceita com o token certo e responde na hora', async () => {
    const app = await getApp();
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { host: HOST, 'asaas-access-token': gateway.webhookToken },
      payload: { id: `evento-http-${Date.now()}`, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_y', value: 1990 } },
    });

    // 200 imediato: o processamento vai para a fila. Um gateway que espera
    // resposta em segundos não pode ficar preso atrás do nosso banco.
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ ok: true });
  });

  it('funciona em qualquer host — o gateway não conhece nosso domínio de app', async () => {
    const app = await getApp();
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { host: 'qualquer.coisa.test', 'asaas-access-token': gateway.webhookToken },
      payload: { id: `evento-host-${Date.now()}`, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_z' } },
    });

    expect(resposta.statusCode).toBe(200);
  });
});

describe('painel e banners', () => {
  it('mostra assinatura, perfil mascarado e faturas', async () => {
    const { faturaRemota } = await assinar('boleto');
    await registrarFaturaLocal(faturaRemota.id, faturaRemota.dueDate);

    const body = (await api('GET', '/v1/billing')).json() as {
      subscription: { planCode: string; amountFormatted: string };
      billingProfile: { document: string };
      invoices: Array<{ amountFormatted: string; amountCents: number }>;
    };

    expect(body.subscription.planCode).toBe('pro');
    expect(body.subscription.amountFormatted.replace(/\u00a0/g, ' ')).toBe('R$ 1.990,00');
    expect(body.billingProfile.document).toBe('***0181');

    // A fatura deste teste aparece no histórico, junto com a do seed.
    expect(body.invoices.some((f) => f.amountCents === 199000)).toBe(true);
  });

  it('o banner de conta suspensa oferece exportar os dados', async () => {
    await assinar();
    await withTenant(ORG_A.id, ({ tx }) =>
      tx.subscription.updateMany({
        where: { organizationId: ORG_A.id, providerSubscriptionId: { not: null } },
        data: { status: 'suspended' },
      }),
    );

    const body = (await api('GET', '/v1/billing/banners')).json() as {
      banners: Array<{ title: string; actions: Array<{ label: string; kind: string }> }>;
    };

    const suspensa = body.banners.find((b) => b.title.includes('somente leitura'));
    expect(suspensa).toBeDefined();
    // Alternativa gratuita ao lado da paga, como manda a seção 11.
    expect(suspensa?.actions.some((a) => a.kind === 'free')).toBe(true);
  });

  it('cancelar mantém a conta ativa até o fim do período pago', async () => {
    const { assinatura } = await assinar();

    const resposta = await api('POST', '/v1/billing/cancel', { reason: 'orçamento apertado' });

    expect(resposta.statusCode).toBe(200);
    const body = resposta.json() as { status: string; activeUntil: string; copy: { body: string } };

    expect(body.status).toBe('canceled');
    expect(new Date(body.activeUntil).toISOString()).toBe(assinatura.currentPeriodEnd.toISOString());
    // Cortar na hora seria cobrar por um mês e entregar meio.
    expect(body.copy.body).toContain('fica ativa até');
    expect(body.copy.body).toContain('exportação por 30 dias');
  });
});

describe('permissões', () => {
  it('admin não acessa cobrança', async () => {
    // "admin — Membros, todos os formulários, configurações (sem billing)".
    const sessaoEditor = await loginAs(ORG_A.editor);
    const app = await getApp();

    const resposta = await app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { host: HOST, authorization: `Bearer ${sessaoEditor.accessToken}` },
    });

    expect(resposta.statusCode).toBe(403);
  });
});
