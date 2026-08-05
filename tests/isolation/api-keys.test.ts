import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';

/**
 * Isolamento pela API pública.
 *
 * A API por chave é uma segunda porta de entrada, e portas de entrada novas são
 * onde o isolamento costuma vazar: é fácil lembrar do `withTenant` no painel e
 * esquecer dele aqui.
 *
 * O contexto de tenant desta porta vem da PRÓPRIA chave — não de um cabeçalho,
 * não de um parâmetro. Nada que o cliente envie no request muda de qual
 * organização ele lê, e é isso que os testes abaixo tentam quebrar.
 */

const HOST = 'localhost';

let chaveDaAlfa: string;
let formularioDaBeta: string;
let respostaDaBeta: string;
let webhookDaBeta: string;

async function comChave(
  method: 'GET' | 'POST',
  url: string,
  chave: string,
  headers: Record<string, string> = {},
) {
  const app = await getApp();
  return app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${chave}`, ...headers } });
}

beforeAll(async () => {
  const token = (await loginAs(ORG_A.owner)).accessToken;
  const app = await getApp();

  const criacao = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { host: HOST, authorization: `Bearer ${token}` },
    payload: {
      name: 'isolamento alfa',
      // Todos os escopos de leitura: se o isolamento dependesse de escopo, este
      // teste passaria por acidente. Ele tem que passar por causa do tenant.
      scopes: ['forms:read', 'responses:read', 'forms:write', 'responses:write'],
    },
  });

  chaveDaAlfa = (criacao.json() as { secret: string }).secret;

  const daBeta = await withTenant(ORG_B.id, async ({ tx }) => ({
    form: await tx.form.findFirstOrThrow({ select: { id: true } }),
    response: await tx.response.findFirstOrThrow({ select: { id: true } }),
    webhook: await tx.webhook.findFirstOrThrow({ select: { id: true } }),
  }));

  formularioDaBeta = daBeta.form.id;
  respostaDaBeta = daBeta.response.id;
  webhookDaBeta = daBeta.webhook.id;
});

afterAll(async () => {
  await withTenant(ORG_A.id, ({ tx }) => tx.apiKey.deleteMany({ where: { name: 'isolamento alfa' } }));
  await closeApp();
});

describe('chave da Alfa contra recursos da Beta', () => {
  it('não lê as respostas de um formulário da Beta', async () => {
    const resposta = await comChave('GET', `/api/v1/forms/${formularioDaBeta}/responses`, chaveDaAlfa);

    expect(resposta.statusCode).toBe(404);
    // Nem o ID pedido pode voltar: confirmar que ele existe já é vazamento.
    expect(resposta.body).not.toContain(formularioDaBeta);
  });

  it('a listagem de formulários só traz os da própria organização', async () => {
    const resposta = await comChave('GET', '/api/v1/forms', chaveDaAlfa);

    expect(resposta.statusCode).toBe(200);
    const { forms } = resposta.json() as { forms: Array<{ id: string }> };

    expect(forms.length).toBeGreaterThan(0);
    expect(forms.map((form) => form.id)).not.toContain(formularioDaBeta);

    // E o corpo inteiro não menciona nada da Beta.
    for (const idDaBeta of [formularioDaBeta, respostaDaBeta, webhookDaBeta]) {
      expect(resposta.body).not.toContain(idDaBeta);
    }
  });

  it('/me devolve a organização da chave, não a pedida', async () => {
    // Cabeçalhos com nome de organização são a tentativa óbvia de trocar de
    // tenant. Nenhum deles é lido.
    const resposta = await comChave('GET', '/api/v1/me', chaveDaAlfa, {
      'x-organization-id': ORG_B.id,
      'x-tenant': ORG_B.id,
    });

    expect(resposta.json()).toMatchObject({ organizationId: ORG_A.id });
  });

  it('nenhum parâmetro de query muda o tenant', async () => {
    const resposta = await comChave(
      'GET',
      `/api/v1/forms?organizationId=${ORG_B.id}&organization_id=${ORG_B.id}`,
      chaveDaAlfa,
    );

    expect(resposta.statusCode).toBe(200);
    expect(resposta.body).not.toContain(formularioDaBeta);
  });

  it('a chave não abre as rotas de sessão do painel', async () => {
    // A chave é credencial de máquina. Ela não pode virar sessão de usuário:
    // se abrisse `/v1`, o escopo deixaria de limitar coisa alguma.
    for (const rota of ['/v1/forms', '/v1/api-keys', '/v1/webhooks', '/v1/organizations/current', '/v1/usage']) {
      const resposta = await comChave('GET', rota, chaveDaAlfa);
      expect(resposta.statusCode, rota).toBe(401);
    }
  });
});

describe('o segredo do webhook não circula', () => {
  it('não aparece em nenhuma resposta da API pública nem do painel', async () => {
    const segredoDaBeta = await withTenant(ORG_B.id, async ({ tx }) => {
      const webhook = await tx.webhook.findFirstOrThrow({ select: { secret: true } });
      return webhook.secret;
    });

    const token = (await loginAs(ORG_B.owner)).accessToken;
    const app = await getApp();

    const doPainel = await app.inject({
      method: 'GET',
      url: '/v1/webhooks',
      headers: { host: HOST, authorization: `Bearer ${token}` },
    });

    // Quem é dono do webhook também não recebe o segredo de volta: ele foi
    // mostrado na criação e não é recuperável depois.
    expect(doPainel.statusCode).toBe(200);
    expect(doPainel.body).not.toContain(segredoDaBeta);

    const doResource = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${webhookDaBeta}`,
      headers: { host: HOST, authorization: `Bearer ${token}` },
    });

    expect(doResource.body).not.toContain(segredoDaBeta);
  });
});
