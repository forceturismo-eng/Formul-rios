import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, get, getApp, loginAs, post } from '../helpers/api.js';
import { ORG_A, ORG_B, SEED_PASSWORD, inventoryOf, type ResourceInventory } from '../helpers/orgs.js';

/**
 * TESTE BLOQUEANTE — separação entre domínio da aplicação e domínio de cliente
 * (seção 8.1).
 *
 * A regra: painel, login, API autenticada e cookie de sessão existem SOMENTE no
 * domínio da aplicação. Um domínio de cliente serve apenas a renderização
 * pública de formulário.
 *
 * O corolário, testado aqui: como o tenant sai do token e não do `Host`,
 * forjar o header não move ninguém de empresa. No máximo tira acesso de quem
 * forjou.
 */

let tokenA: string;
let inventoryA: ResourceInventory;
let inventoryB: ResourceInventory;

const CUSTOMER_HOST = ORG_B.domain;

beforeAll(async () => {
  tokenA = (await loginAs(ORG_A.owner)).accessToken;
  [inventoryA, inventoryB] = await Promise.all([inventoryOf(ORG_A.id), inventoryOf(ORG_B.id)]);
});

afterAll(closeApp);

describe('rotas autenticadas por domínio de cliente', () => {
  it('GET /v1/organizations/current pelo domínio do cliente responde 404', async () => {
    const response = await get('/v1/organizations/current', { token: tokenA, host: CUSTOMER_HOST });

    // 404 e não 401/403: pelo domínio do cliente, o painel não existe.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it.each(['forms', 'responses', 'members', 'invoices', 'api-keys'])(
    'GET /v1/%s/:id pelo domínio do cliente responde 404 mesmo com token válido',
    async (path) => {
      const ownId = inventoryA[path as keyof ResourceInventory];
      const response = await get(`/v1/${path}/${ownId}`, { token: tokenA, host: CUSTOMER_HOST });
      expect(response.statusCode).toBe(404);
    },
  );

  it('POST /v1/auth/login pelo domínio do cliente responde 404', async () => {
    const response = await post(
      '/v1/auth/login',
      { email: ORG_A.owner, password: SEED_PASSWORD },
      { host: CUSTOMER_HOST },
    );

    expect(response.statusCode).toBe(404);
    // E, principalmente, nenhum cookie de sessão é emitido nesse domínio.
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('POST /v1/auth/refresh pelo domínio do cliente responde 404', async () => {
    const session = await loginAs(ORG_A.owner);
    const response = await post('/v1/auth/refresh', {}, { host: CUSTOMER_HOST, cookie: session.refreshCookie });

    expect(response.statusCode).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('um host desconhecido qualquer também responde 404', async () => {
    const response = await get('/v1/organizations/current', { token: tokenA, host: 'nao-e-nosso.example.com' });
    expect(response.statusCode).toBe(404);
  });
});

describe('Host forjado não troca o tenant', () => {
  it('token da empresa A com Host da empresa B continua sem alcançar dados de B', async () => {
    const response = await get(`/v1/forms/${inventoryB.forms}`, { token: tokenA, host: ORG_B.domain });
    expect(response.statusCode).toBe(404);
  });

  it('Host do domínio da aplicação com token de A devolve A, não o que o Host sugere', async () => {
    const response = await get('/v1/organizations/current', { token: tokenA, host: 'localhost' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ORG_A.id });
  });

  it('X-Forwarded-Host não é considerado', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/organizations/current',
      headers: {
        host: 'localhost',
        'x-forwarded-host': ORG_B.domain,
        authorization: `Bearer ${tokenA}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ORG_A.id });
  });

  it('Host com porta e maiúsculas continua sendo o domínio da aplicação', async () => {
    const response = await get('/v1/organizations/current', { token: tokenA, host: 'LOCALHOST:3333' });
    expect(response.statusCode).toBe(200);
  });
});

describe('rotas públicas', () => {
  it('/health responde em qualquer host — não expõe dado de tenant', async () => {
    const response = await get('/health', { host: CUSTOMER_HOST });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });
});
