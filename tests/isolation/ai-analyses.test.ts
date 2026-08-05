import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { setAiProvider } from '../../apps/api/src/ai/provider.js';
import { createFakeAiProvider, type FakeAiProvider } from '../../apps/api/src/ai/fake.js';
import { runAnalysis } from '../../apps/api/src/queue/ai-worker.js';

/**
 * Análises com IA e isolamento.
 *
 * A IA junta duas coisas perigosas: leitura em massa de respostas — o conteúdo
 * mais sensível do produto — e envio para fora da nossa infraestrutura. As
 * perguntas que importam:
 *
 *  1. A empresa A consegue mandar analisar um formulário da B?
 *  2. O consentimento de uma empresa vale para a outra?
 *  3. Um job com o `organizationId` trocado alcança dados alheios?
 */

const HOST = 'localhost';

let tokenDaAlfa: string;
let formularioDaBeta: string;
let analiseDaBeta: string;
let provedor: FakeAiProvider;

async function comoAlfa(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${tokenDaAlfa}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

beforeAll(async () => {
  tokenDaAlfa = (await loginAs(ORG_A.owner)).accessToken;

  const daBeta = await withTenant(ORG_B.id, async ({ tx }) => ({
    form: await tx.form.findFirstOrThrow({
      where: { deletedAt: null, responses: { some: {} } },
      orderBy: { responses: { _count: 'desc' } },
      select: { id: true },
    }),
    analise: await tx.aiAnalysis.findFirstOrThrow({ select: { id: true } }),
  }));

  formularioDaBeta = daBeta.form.id;
  analiseDaBeta = daBeta.analise.id;
});

beforeEach(() => {
  provedor = createFakeAiProvider();
  setAiProvider(provedor);
});

afterEach(async () => {
  await Promise.all([
    withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { aiConsentAt: null, aiConsentBy: null } }),
    ),
    withTenant(ORG_B.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_B.id }, data: { aiConsentAt: null, aiConsentBy: null } }),
    ),
  ]);

  await Promise.all([
    withTenant(ORG_A.id, ({ tx }) => tx.aiAnalysis.deleteMany({ where: { model: 'fake-model' } })),
    withTenant(ORG_B.id, ({ tx }) => tx.aiAnalysis.deleteMany({ where: { model: 'fake-model' } })),
  ]);
});

afterAll(async () => {
  setAiProvider(null);
  await closeApp();
});

describe('a Alfa contra os dados da Beta', () => {
  it('não manda analisar formulário da Beta', async () => {
    await comoAlfa('PUT', '/v1/ai/consent', { enabled: true });

    const resposta = await comoAlfa('POST', `/v1/forms/${formularioDaBeta}/ai-analyses`, { type: 'resumo' });

    // 404, não 403: um 403 confirmaria que o formulário existe.
    expect(resposta.statusCode).toBe(404);
    // E, acima de tudo: nada da Beta foi lido, redigido ou enviado.
    expect(provedor.enviados).toHaveLength(0);
  });

  it('não lista as análises de um formulário da Beta', async () => {
    const resposta = await comoAlfa('GET', `/v1/forms/${formularioDaBeta}/ai-analyses`);

    // A lista sai vazia porque o RLS não devolve linha nenhuma — e não porque
    // a rota conferiu o dono.
    expect(resposta.json()).toEqual({ analyses: [] });
  });

  it('não lê uma análise da Beta por ID direto', async () => {
    const resposta = await comoAlfa('GET', `/v1/ai-analyses/${analiseDaBeta}`);

    expect(resposta.statusCode).toBe(404);
    expect(resposta.body).not.toContain(analiseDaBeta);
  });
});

describe('consentimento não atravessa', () => {
  it('a Beta consentir não libera a Alfa', async () => {
    await withTenant(ORG_B.id, ({ tx }) =>
      tx.organization.update({
        where: { id: ORG_B.id },
        data: { aiConsentAt: new Date(), aiConsentBy: null },
      }),
    );

    const settings = (await comoAlfa('GET', '/v1/ai/settings')).json() as { enabled: boolean };
    expect(settings.enabled).toBe(false);

    // E a análise da própria Alfa continua barrada.
    const proprioForm = await withTenant(ORG_A.id, async ({ tx }) => {
      const form = await tx.form.findFirstOrThrow({
        where: { deletedAt: null, responses: { some: {} } },
        orderBy: { responses: { _count: 'desc' } },
        select: { id: true },
      });
      return form.id;
    });

    const resposta = await comoAlfa('POST', `/v1/forms/${proprioForm}/ai-analyses`, { type: 'resumo' });

    expect(resposta.statusCode).toBe(403);
    expect(provedor.enviados).toHaveLength(0);
  });
});

describe('job com organização trocada', () => {
  it('não grava análise de um formulário que não é da organização do job', async () => {
    // Um job forjado — ou um bug que trocasse o id — não pode fazer o worker
    // escrever no formulário da Beta com o contexto da Alfa.
    await expect(
      runAnalysis({
        organizationId: ORG_A.id,
        requestedBy: 'system',
        formId: formularioDaBeta,
        type: 'resumo',
        inputHash: 'hash-forjado',
        system: 'teste',
        userContent: 'Respostas recebidas: 1\n\nNota: 9\n',
        responseCount: 1,
      }),
    ).rejects.toThrow(/não pertence à organização/);

    // Nada gravado dos dois lados. Note que a chave estrangeira do Postgres NÃO
    // teria barrado isto: ela roda como sistema, fora do RLS — a linha nasceria
    // na Alfa apontando para um formulário da Beta.
    const [daBeta, daAlfa] = await Promise.all([
      withTenant(ORG_B.id, ({ tx }) => tx.aiAnalysis.count({ where: { inputHash: 'hash-forjado' } })),
      withTenant(ORG_A.id, ({ tx }) => tx.aiAnalysis.count({ where: { inputHash: 'hash-forjado' } })),
    ]);

    expect(daBeta).toBe(0);
    expect(daAlfa).toBe(0);
  });
});

describe('o provedor nunca recebe PII', () => {
  it('a trava vale mesmo com conteúdo montado à mão', async () => {
    // Defesa em profundidade: se um caminho novo montar o job sem passar pela
    // redação, o envio quebra em vez de vazar.
    await expect(
      runAnalysis({
        organizationId: ORG_A.id,
        requestedBy: 'system',
        formId: formularioDaBeta,
        type: 'resumo',
        inputHash: 'hash-com-pii',
        system: 'teste',
        userContent: 'E-mail do cliente: ana@exemplo.com.br',
        responseCount: 1,
      }),
    ).rejects.toThrow(/Redação incompleta/);

    expect(provedor.enviados).toHaveLength(0);
  });
});
