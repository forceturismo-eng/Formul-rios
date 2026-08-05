import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { limparFormulariosDeTeste, PREFIXO_DE_TESTE } from '../helpers/limpeza.js';
import { loadUsage } from '../../apps/api/src/services/usage-service.js';

/**
 * Enforcement de quotas, contra o banco de verdade.
 *
 * O teste que mais importa é o do buffer: a seção 11 promete ao cliente que
 * "nenhuma resposta é apagada". Aqui isso vira uma asserção — a submissão que
 * estoura a cota precisa continuar sendo GRAVADA, só que marcada.
 */

const HOST = 'localhost';
let token: string;

const definicao = {
  pages: [{ id: 'p1', fields: [{ id: 'nome', type: 'short_text', label: 'Nome', required: true }] }],
};

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

/** Troca o plano da empresa direto no banco, para exercitar cada limite. */
async function usarPlano(planCode: string): Promise<void> {
  await withTenant(ORG_A.id, ({ tx }) =>
    tx.organization.update({ where: { id: ORG_A.id }, data: { planCode } }),
  );
}

/** Zera os contadores do ciclo, para os testes não interferirem uns nos outros. */
async function zerarContadores(): Promise<void> {
  await withTenant(ORG_A.id, async (ctx) => {
    const usage = await loadUsage(ctx);
    await ctx.tx.usageCounter.update({
      where: { organizationId_periodStart: { organizationId: ORG_A.id, periodStart: usage.periodStart } },
      data: { responsesCount: 0, storageUsedMb: 0, aiAnalysesCount: 0, bufferStartedAt: null, bufferEndsAt: null },
    });
  });
}

beforeEach(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;
  await usarPlano('business');
  await zerarContadores();
});

afterAll(async () => {
  await usarPlano('business');
  await zerarContadores();
  // Sem isto, cada execução deixa dezenas de formulários para trás e a próxima
  // esbarra no limite do plano — falhando por acúmulo, não pela mudança.
  await limparFormulariosDeTeste(ORG_A.id);
  await closeApp();
});

/** Cria formulários até a empresa ter pelo menos `alvo` ativos. */
async function garantirFormularios(alvo: number): Promise<void> {
  await usarPlano('business');

  let atual = (await withTenant(ORG_A.id, (ctx) => loadUsage(ctx))).formsCount;
  while (atual < alvo) {
    const criado = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Preenchimento ${atual} ${Date.now()}` });
    if (criado.statusCode !== 201) throw new Error(`falha ao preparar formulários: ${criado.body}`);
    atual += 1;
  }
}

describe('limite de formulários', () => {
  it('bloqueia a criação com 402 e diz o que fazer', async () => {
    // O teste cria a própria condição em vez de depender do estado do seed —
    // senão passaria ou falharia conforme a ordem de execução da suíte.
    await garantirFormularios(3);
    await usarPlano('free'); // 3 formulários

    const resposta = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Mais um formulário` });

    expect(resposta.statusCode).toBe(402);

    const body = resposta.json() as {
      error: { code: string; message: string; limit: number; current: number; upgradeUrl: string; addonUrl: string };
    };

    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.limit).toBe(3);
    // A tela precisa dos dois caminhos: o pago e o gratuito.
    expect(body.error.upgradeUrl).toBe('/planos');
    expect(body.error.addonUrl).toBe('/planos/adicionais');
    expect(body.error.message).toContain('Arquive');
    expect(body.error.message).not.toContain('!');
  });

  it('arquivar libera a vaga sem apagar nada', async () => {
    await garantirFormularios(3);

    const criado = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Descartável ${Date.now()}` });
    const { id } = criado.json() as { id: string };

    const antes = (await withTenant(ORG_A.id, (ctx) => loadUsage(ctx))).formsCount;

    // Arquivar é a alternativa gratuita que a copy da seção 11 promete ao lado
    // do botão de upgrade.
    await api('POST', `/v1/forms/${id}/archive`);

    const depois = (await withTenant(ORG_A.id, (ctx) => loadUsage(ctx))).formsCount;
    expect(depois).toBe(antes - 1);

    // E o formulário continua acessível: arquivado não é apagado.
    expect((await api('GET', `/v1/forms/${id}/full`)).statusCode).toBe(200);
  });

  it('plano ilimitado nunca bloqueia', async () => {
    await usarPlano('business');
    expect((await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Ilimitado ${Date.now()}` })).statusCode).toBe(201);
  });
});

describe('limite de membros', () => {
  it('bloqueia o convite quando as vagas acabam', async () => {
    // Free permite 1 membro, e a Agência Alfa tem três.
    await usarPlano('free');

    const resposta = await api('POST', '/v1/invitations', { email: 'novo@alfa.test', role: 'editor' });

    expect(resposta.statusCode).toBe(402);
    expect((resposta.json() as { error: { limit: number } }).error.limit).toBe(1);
  });
});

describe('cota de respostas e a cortesia de 48 horas', () => {
  let slug: string;
  let formId: string;

  async function prepararFormulario(): Promise<void> {
    const criado = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Cota ${Date.now()}` });
    const form = criado.json() as { id: string; slugPublic: string };
    formId = form.id;
    slug = form.slugPublic;

    await api('PATCH', `/v1/forms/${formId}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${formId}/publish`);
  }

  async function enviar(nome: string) {
    const app = await getApp();
    return app.inject({
      method: 'POST',
      url: `/f/${slug}/submit`,
      headers: { host: HOST },
      payload: { values: { nome } },
    });
  }

  /** Coloca o contador exatamente no limite do plano. */
  async function encherCota(limite: number): Promise<void> {
    await withTenant(ORG_A.id, async (ctx) => {
      const usage = await loadUsage(ctx);
      await ctx.tx.usageCounter.update({
        where: { organizationId_periodStart: { organizationId: ORG_A.id, periodStart: usage.periodStart } },
        data: { responsesCount: limite },
      });
    });
  }

  it('aceita normalmente abaixo do limite', async () => {
    await prepararFormulario();
    expect((await enviar('Dentro da cota')).statusCode).toBe(201);
  });

  it('ao estourar a cota, a resposta continua sendo GRAVADA', async () => {
    await prepararFormulario();
    await usarPlano('free'); // 100 respostas/mês
    await encherCota(100);

    const resposta = await enviar('Chegou depois do limite');

    // A promessa da seção 11: "Continuamos recebendo tudo normalmente por mais
    // 48 horas para você não perder nada."
    expect(resposta.statusCode).toBe(201);

    const { responseId } = resposta.json() as { responseId: string };
    const gravada = await withTenant(ORG_A.id, ({ tx }) =>
      tx.response.findUniqueOrThrow({ where: { id: responseId } }),
    );

    expect(gravada.isBuffered).toBe(true);
  });

  it('a janela de 48h começa na primeira resposta excedente e não reinicia', async () => {
    await prepararFormulario();
    await usarPlano('free');
    await encherCota(100);

    await enviar('Primeira excedente');
    const depoisDaPrimeira = await withTenant(ORG_A.id, (ctx) => loadUsage(ctx));

    await enviar('Segunda excedente');
    const depoisDaSegunda = await withTenant(ORG_A.id, (ctx) => loadUsage(ctx));

    expect(depoisDaPrimeira.bufferEndsAt).not.toBeNull();
    // Se reiniciasse a cada envio, um formulário movimentado nunca sairia da
    // cortesia — e o cliente nunca seria cobrado pelo excedente.
    expect(depoisDaSegunda.bufferEndsAt?.toISOString()).toBe(depoisDaPrimeira.bufferEndsAt?.toISOString());
  });

  it('depois das 48h, o formulário público pausa com mensagem neutra', async () => {
    await prepararFormulario();
    await usarPlano('free');
    await encherCota(100);

    // Move a janela para o passado.
    await withTenant(ORG_A.id, async (ctx) => {
      const usage = await loadUsage(ctx);
      await ctx.tx.usageCounter.update({
        where: { organizationId_periodStart: { organizationId: ORG_A.id, periodStart: usage.periodStart } },
        data: {
          bufferStartedAt: new Date(Date.now() - 72 * 3600_000),
          bufferEndsAt: new Date(Date.now() - 24 * 3600_000),
        },
      });
    });

    const resposta = await enviar('Depois da cortesia');
    expect(resposta.statusCode).toBe(403);

    // Quem responde o formulário não tem nada com a relação comercial do
    // cliente conosco.
    const mensagem = JSON.stringify(resposta.json()).toLowerCase();
    for (const proibido of ['plano', 'cota', 'limite', 'pagamento', 'assinatura', 'upgrade']) {
      expect(mensagem, `menciona "${proibido}"`).not.toContain(proibido);
    }
  });

  it('as respostas do buffer continuam visíveis no painel', async () => {
    await prepararFormulario();
    await usarPlano('free');
    await encherCota(100);
    await enviar('Recebida na cortesia');

    await usarPlano('business');

    const painel = await api('GET', `/v1/forms/${formId}/responses`);
    const body = painel.json() as { responses: Array<{ values: Record<string, unknown>; isBuffered: boolean }> };

    // "Nenhuma resposta é apagada": elas ficam visíveis após a regularização.
    const naCortesia = body.responses.find((r) => r.values['nome'] === 'Recebida na cortesia');
    expect(naCortesia).toBeDefined();
    expect(naCortesia?.isBuffered).toBe(true);
  });

  it('submissão inválida não consome a cortesia', async () => {
    await prepararFormulario();
    await usarPlano('free');
    await encherCota(100);

    const app = await getApp();
    const invalida = await app.inject({
      method: 'POST',
      url: `/f/${slug}/submit`,
      headers: { host: HOST },
      payload: { values: {} },
    });

    expect(invalida.statusCode).toBe(422);

    // A janela só começa quando uma resposta VÁLIDA passa do limite.
    const usage = await withTenant(ORG_A.id, (ctx) => loadUsage(ctx));
    expect(usage.bufferStartedAt).toBeNull();
  });
});

describe('painel de uso', () => {
  it('devolve contadores, período e avisos', async () => {
    const resposta = await api('GET', '/v1/usage');

    expect(resposta.statusCode).toBe(200);

    const body = resposta.json() as {
      planCode: string;
      period: { start: string; end: string };
      usage: { responsesCount: number; formsCount: number };
      warnings: unknown[];
      buffer: { active: boolean };
    };

    expect(body.planCode).toBe('business');
    expect(new Date(body.period.end).getTime()).toBeGreaterThan(new Date(body.period.start).getTime());
    expect(body.usage.formsCount).toBeGreaterThan(0);
    expect(body.buffer.active).toBe(false);
  });

  it('emite aviso a partir de 80% da cota', async () => {
    await usarPlano('free');
    await withTenant(ORG_A.id, async (ctx) => {
      const usage = await loadUsage(ctx);
      await ctx.tx.usageCounter.update({
        where: { organizationId_periodStart: { organizationId: ORG_A.id, periodStart: usage.periodStart } },
        data: { responsesCount: 85 },
      });
    });

    const body = (await api('GET', '/v1/usage')).json() as {
      warnings: Array<{ key: string; used: number; limit: number; renewsAt: string }>;
    };

    const aviso = body.warnings.find((w) => w.key === 'responsesPerMonth');
    expect(aviso).toMatchObject({ used: 85, limit: 100 });
    // A data exata de renovação, nunca "em breve".
    expect(aviso?.renewsAt).toBeTruthy();
  });
});

describe('downgrade', () => {
  it('lista o que precisa ser ajustado antes de descer de plano', async () => {
    const resposta = await api('GET', '/v1/plans/free/downgrade-check');

    expect(resposta.statusCode).toBe(200);

    const body = resposta.json() as {
      allowed: boolean;
      blockers: Array<{ key: string; current: number; limit: number; action: string }>;
      copy: { body: string; actions: Array<{ kind: string }> } | null;
    };

    expect(body.allowed).toBe(false);
    expect(body.blockers.length).toBeGreaterThan(0);
    expect(body.blockers.some((b) => b.key === 'members')).toBe(true);

    // A copy vem pronta, com a garantia de que nada é apagado.
    expect(body.copy?.body).toContain('Nada é apagado');
    expect(body.copy?.actions.some((a) => a.kind === 'free')).toBe(true);
  });

  it('permite quando o uso cabe no plano de destino', async () => {
    const body = (await api('GET', '/v1/plans/enterprise/downgrade-check')).json() as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('plano inexistente responde 404', async () => {
    expect((await api('GET', '/v1/plans/inexistente/downgrade-check')).statusCode).toBe(404);
  });
});
