import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';

/**
 * Webhooks e chaves de API, pela porta da frente.
 *
 * O que este arquivo cobre e os unitários não: que o segredo aparece uma única
 * vez e nunca mais; que a chave autentica um request sem sessão; e que o
 * escopo — não o papel — decide o que ela alcança.
 */

const HOST = 'localhost';
let token: string;
let formId: string;

async function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

/** Request da API pública: sem cookie, sem sessão, só a chave. */
async function comChave(url: string, chave: string) {
  const app = await getApp();
  return app.inject({ method: 'GET', url, headers: { host: HOST, authorization: `Bearer ${chave}` } });
}

async function criarChave(escopos: string[]): Promise<string> {
  const resposta = await api('POST', '/v1/api-keys', { name: `teste ${escopos.join('+')}`, scopes: escopos });
  expect(resposta.statusCode).toBe(201);
  return (resposta.json() as { secret: string }).secret;
}

beforeAll(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;
  formId = await withTenant(ORG_A.id, async ({ tx }) => {
    const form = await tx.form.findFirstOrThrow({ select: { id: true } });
    return form.id;
  });
});

afterAll(async () => {
  // Só o que esta suíte criou. As chaves e webhooks do seed são usados pela
  // suíte de isolamento e não podem sumir.
  await withTenant(ORG_A.id, async ({ tx }) => {
    await tx.apiKey.deleteMany({ where: { name: { startsWith: 'teste ' } } });
    await tx.webhook.deleteMany({ where: { url: { contains: 'teste-integracao' } } });
  });
  await closeApp();
});

describe('webhooks', () => {
  it('cria e mostra o segredo uma única vez', async () => {
    const criacao = await api('POST', '/v1/webhooks', {
      url: 'https://hooks.teste-integracao.com.br/formularios',
      events: ['response.created'],
    });

    expect(criacao.statusCode).toBe(201);
    const criado = criacao.json() as { id: string; secret: string };
    expect(criado.secret).toMatch(/^whsec_/);

    const lista = await api('GET', '/v1/webhooks');
    const webhook = (lista.json() as { webhooks: Array<Record<string, unknown>> }).webhooks.find(
      (item) => item.id === criado.id,
    );

    expect(webhook).toBeDefined();
    // Um dump da listagem — em log, em print de suporte — não pode conter o
    // material que assina as entregas.
    expect(webhook).not.toHaveProperty('secret');
    expect(JSON.stringify(lista.json())).not.toContain(criado.secret);
  });

  it('recusa destino interno na criação', async () => {
    const resposta = await api('POST', '/v1/webhooks', {
      url: 'https://169.254.169.254/latest/meta-data/',
      events: ['response.created'],
    });

    expect(resposta.statusCode).toBe(422);
  });

  it('recusa evento inexistente', async () => {
    const resposta = await api('POST', '/v1/webhooks', {
      url: 'https://hooks.teste-integracao.com.br/x',
      events: ['response.inventado'],
    });

    expect(resposta.statusCode).toBe(422);
  });

  it('apaga', async () => {
    const criacao = await api('POST', '/v1/webhooks', {
      url: 'https://hooks.teste-integracao.com.br/apagar',
      events: ['form.published'],
    });
    const { id } = criacao.json() as { id: string };

    expect((await api('DELETE', `/v1/webhooks/${id}`)).statusCode).toBe(204);

    const lista = (await api('GET', '/v1/webhooks')).json() as { webhooks: Array<{ id: string }> };
    expect(lista.webhooks.map((item) => item.id)).not.toContain(id);
  });
});

describe('chaves de API', () => {
  it('cria, mostra o segredo uma vez e guarda só o prefixo', async () => {
    const resposta = await api('POST', '/v1/api-keys', { name: 'teste criação', scopes: ['forms:read'] });

    expect(resposta.statusCode).toBe(201);
    const criada = resposta.json() as { id: string; secret: string };
    expect(criada.secret).toMatch(/^fx_live_[0-9a-f]{48}$/);

    const lista = (await api('GET', '/v1/api-keys')).json() as {
      apiKeys: Array<{ id: string; prefix: string }>;
    };
    const chave = lista.apiKeys.find((item) => item.id === criada.id);

    expect(chave?.prefix).toBe(`${criada.secret.slice(0, 16)}…`);
    expect(JSON.stringify(lista)).not.toContain(criada.secret);
  });

  it('o banco guarda hash, não a chave', async () => {
    const segredo = await criarChave(['forms:read']);

    const noBanco = await withTenant(ORG_A.id, ({ tx }) =>
      tx.apiKey.findMany({ select: { keyHash: true, prefix: true } }),
    );

    for (const registro of noBanco) {
      expect(registro.keyHash).not.toBe(segredo);
      expect(registro.keyHash).not.toContain(segredo.slice(16));
    }
  });

  it('recusa escopo desconhecido', async () => {
    const resposta = await api('POST', '/v1/api-keys', { name: 'teste ruim', scopes: ['banco:drop'] });
    expect(resposta.statusCode).toBe(422);
  });
});

describe('API pública', () => {
  it('autentica pela chave e devolve os formulários', async () => {
    const segredo = await criarChave(['forms:read']);
    const resposta = await comChave('/api/v1/forms', segredo);

    expect(resposta.statusCode).toBe(200);
    expect((resposta.json() as { forms: unknown[] }).forms.length).toBeGreaterThan(0);
  });

  it('sem chave nenhuma, 401', async () => {
    const app = await getApp();
    const resposta = await app.inject({ method: 'GET', url: '/api/v1/forms', headers: { host: HOST } });

    expect(resposta.statusCode).toBe(401);
  });

  it('a sessão do painel não vale na API pública', async () => {
    // O access token é um JWT, não uma chave: ele não deve abrir a API por
    // acidente só por chegar no mesmo header.
    expect((await comChave('/api/v1/forms', token)).statusCode).toBe(401);
  });

  it('escopo insuficiente é 403, não 404', async () => {
    // Aqui o recurso existe e é da organização da chave. Esconder isso não
    // protege ninguém e atrapalha quem está integrando.
    const segredo = await criarChave(['forms:read']);
    const resposta = await comChave(`/api/v1/forms/${formId}/responses`, segredo);

    expect(resposta.statusCode).toBe(403);
    // A mensagem nomeia o escopo que falta: quem está integrando precisa saber
    // o que pedir na próxima chave.
    expect(resposta.json()).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('responses:read') },
    });
  });

  it('com o escopo certo, lê as respostas já decifradas', async () => {
    const segredo = await criarChave(['responses:read']);
    const resposta = await comChave(`/api/v1/forms/${formId}/responses`, segredo);

    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json() as { responses: Array<{ id: string; values: Record<string, unknown> }> };
    expect(corpo.responses.length).toBeGreaterThan(0);
    // Decifrado: o cliente recebe os valores, não o blob da coluna.
    expect(corpo.responses[0]).toHaveProperty('values');
  });

  it('chave revogada para de valer', async () => {
    const criacao = await api('POST', '/v1/api-keys', { name: 'teste revogar', scopes: ['forms:read'] });
    const { id, secret } = criacao.json() as { id: string; secret: string };

    expect((await comChave('/api/v1/forms', secret)).statusCode).toBe(200);

    expect((await api('DELETE', `/v1/api-keys/${id}`)).statusCode).toBe(204);

    // Mesma resposta de uma chave que nunca existiu: quem tem a chave revogada
    // não descobre por qual motivo ela parou.
    expect((await comChave('/api/v1/forms', secret)).statusCode).toBe(401);
  });

  it('chave expirada não vale', async () => {
    const criacao = await api('POST', '/v1/api-keys', {
      name: 'teste expirada',
      scopes: ['forms:read'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { id, secret } = criacao.json() as { id: string; secret: string };

    expect((await comChave('/api/v1/forms', secret)).statusCode).toBe(200);

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );

    expect((await comChave('/api/v1/forms', secret)).statusCode).toBe(401);
  });

  it('chave inventada não vale', async () => {
    expect((await comChave('/api/v1/forms', `fx_live_${'a'.repeat(48)}`)).statusCode).toBe(401);
  });

  it('/me devolve a organização da chave e nada mais', async () => {
    const segredo = await criarChave(['forms:read']);
    const corpo = (await comChave('/api/v1/me', segredo)).json();

    expect(corpo).toEqual({ organizationId: ORG_A.id, scopes: ['forms:read'] });
  });
});
