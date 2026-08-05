import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { setAiProvider } from '../../apps/api/src/ai/provider.js';
import { createFakeAiProvider, type FakeAiProvider } from '../../apps/api/src/ai/fake.js';
import { runAnalysis, type AiJobData } from '../../apps/api/src/queue/ai-worker.js';

/**
 * Análises com IA.
 *
 * O teste que mais importa deste arquivo é o de redação: ele inspeciona o que
 * o provedor RECEBEU. Tudo o mais pode estar certo e, se PII chegar até ali,
 * mandamos dado pessoal de terceiros para fora da nossa infraestrutura.
 *
 * O provedor falso implementa a mesma trava do real (`assertRedacted`). Um
 * falso permissivo deixaria a suíte verde exatamente no caso que ela existe
 * para pegar.
 */

const HOST = 'localhost';
let token: string;
let formId: string;
let provedor: FakeAiProvider;

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

async function consentir(ligado: boolean) {
  const resposta = await api('PUT', '/v1/ai/consent', { enabled: ligado });
  expect(resposta.statusCode).toBe(200);
}

/** Pede a análise e roda o job na mão — a fila não sobe nos testes. */
async function analisar(type = 'resumo', force = false) {
  const pedido = await api('POST', `/v1/forms/${formId}/ai-analyses`, { type, force });
  if (pedido.statusCode !== 202) {
    throw new Error(`Esperava 202 do pedido de análise, veio ${pedido.statusCode}: ${pedido.body}`);
  }

  const corpo = pedido.json() as {
    redaction: { total: number };
    responseCount: number;
    unreadableCount: number;
  };

  // O job real carrega o conteúdo já redigido; aqui reconstruímos o mesmo
  // caminho chamando o worker diretamente.
  const dados = await prepararJob(type);
  const resultado = await runAnalysis(dados);

  return { pedido, resultado, corpo };
}

async function prepararJob(type: string): Promise<AiJobData> {
  const { prepareAnalysis } = await import('../../apps/api/src/services/ai-service.js');
  const sessao = await loginAs(ORG_A.owner);

  return withTenant(ORG_A.id, async (ctx) => {
    const preparada = await prepareAnalysis(
      ctx,
      { userId: sessao.userId, organizationId: ORG_A.id, role: 'owner' },
      { formId, type: type as never },
    );

    return {
      organizationId: ORG_A.id,
      requestedBy: sessao.userId,
      formId: preparada.formId,
      type: preparada.type,
      inputHash: preparada.inputHash,
      system: preparada.system,
      userContent: preparada.userContent,
      responseCount: preparada.responseCount,
    };
  });
}

beforeAll(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;

  formId = await withTenant(ORG_A.id, async ({ tx }) => {
    // O formulário com mais respostas — o do seed. Escolher "qualquer um com
    // pelo menos uma resposta" pegava formulários criados por outras suítes.
    const form = await tx.form.findFirstOrThrow({
      where: { deletedAt: null, responses: { some: {} } },
      orderBy: { responses: { _count: 'desc' } },
      select: { id: true },
    });
    return form.id;
  });
});

beforeEach(() => {
  provedor = createFakeAiProvider();
  setAiProvider(provedor);
});

afterEach(async () => {
  // Cada caso decide o próprio consentimento, e as análises criadas aqui não
  // podem virar cache do próximo. A do seed fica: outra suíte usa.
  await withTenant(ORG_A.id, async ({ tx }) => {
    await tx.organization.update({
      where: { id: ORG_A.id },
      data: { aiConsentAt: null, aiConsentBy: null },
    });
    await tx.aiAnalysis.deleteMany({ where: { model: 'fake-model' } });
  });
});

afterAll(async () => {
  setAiProvider(null);
  await closeApp();
});

describe('consentimento', () => {
  it('vem desligado', async () => {
    const settings = (await api('GET', '/v1/ai/settings')).json() as { enabled: boolean };
    expect(settings.enabled).toBe(false);
  });

  it('sem consentimento, a análise é recusada e NADA sai daqui', async () => {
    // O portão vem antes de decifrar qualquer resposta. Se ele falhasse, o
    // conteúdo já teria virado prompt antes de alguém perceber.
    const resposta = await api('POST', `/v1/forms/${formId}/ai-analyses`, { type: 'resumo' });

    expect(resposta.statusCode).toBe(403);
    expect(provedor.enviados).toHaveLength(0);
  });

  it('ligar registra data e autor', async () => {
    await consentir(true);
    const settings = (await api('GET', '/v1/ai/settings')).json() as {
      enabled: boolean;
      consentedAt: string;
      consentedBy: string;
    };

    expect(settings.enabled).toBe(true);
    expect(new Date(settings.consentedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(settings.consentedBy).toBeTruthy();
  });

  it('desligar limpa o autor junto', async () => {
    await consentir(true);
    await consentir(false);

    const settings = (await api('GET', '/v1/ai/settings')).json() as {
      enabled: boolean;
      consentedBy: string | null;
    };

    expect(settings.enabled).toBe(false);
    expect(settings.consentedBy).toBeNull();
  });

  it('deixa trilha nos dois sentidos', async () => {
    await consentir(true);
    await consentir(false);

    const trilha = await withTenant(ORG_A.id, ({ tx }) =>
      tx.auditLog.findMany({
        where: { action: { in: ['ai.consent_granted', 'ai.consent_revoked'] } },
        orderBy: { createdAt: 'desc' },
        take: 2,
      }),
    );

    expect(trilha.map((linha) => linha.action)).toEqual(['ai.consent_revoked', 'ai.consent_granted']);
  });
});

describe('redação antes do envio', () => {
  it('o que chega ao provedor não tem PII', async () => {
    await consentir(true);
    const { resultado } = await analisar();

    expect(resultado).not.toBeNull();
    expect(provedor.enviados).toHaveLength(1);

    const enviado = provedor.enviados[0]!.userContent;

    // As respostas do seed têm e-mail, CPF e nome. Nenhum pode estar aqui.
    expect(enviado).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    expect(enviado).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    expect(enviado).not.toContain('Carla Dias');
    expect(enviado).not.toContain('Bruno Lima');

    // E os pseudônimos estão lá, que é o que preserva a análise.
    expect(enviado).toMatch(/\[(EMAIL|NOME|CPF)_\d+\]/);
  });

  it('o prompt de sistema explica os pseudônimos ao modelo', async () => {
    // Sem isso, o modelo tenta "corrigir" os rótulos inventando nomes.
    await consentir(true);
    await analisar();

    expect(provedor.enviados[0]!.system).toContain('pseudônimos');
  });

  it('o pedido devolve quantos dados foram removidos', async () => {
    // O cliente consentiu, e merece ver o que o consentimento significou.
    await consentir(true);
    const { corpo } = await analisar();

    expect(corpo!.redaction.total).toBeGreaterThan(0);
  });

  it('as notas sobrevivem à redação', async () => {
    // Uma pesquisa em que todo número sumiu não tem o que analisar.
    await consentir(true);
    await analisar();

    expect(provedor.enviados[0]!.userContent).toMatch(/\d/);
  });
});

describe('execução e cache', () => {
  it('grava o resultado, o modelo e o custo', async () => {
    await consentir(true);
    const { resultado } = await analisar();

    expect(resultado).toMatchObject({ cached: false });
    expect(resultado!.tokensUsed).toBeGreaterThan(0);
    expect(resultado!.costCents).toBeGreaterThan(0);

    const gravada = await withTenant(ORG_A.id, ({ tx }) =>
      tx.aiAnalysis.findFirstOrThrow({ where: { id: resultado!.analysisId } }),
    );

    expect(gravada.model).toBe('fake-model');
    expect(gravada.resultJson).toHaveProperty('resumo');
  });

  it('o segundo pedido volta do cache, sem gastar token', async () => {
    await consentir(true);
    await analisar();
    expect(provedor.enviados).toHaveLength(1);

    const repetido = await api('POST', `/v1/forms/${formId}/ai-analyses`, { type: 'resumo' });

    expect(repetido.statusCode).toBe(200);
    expect(repetido.json()).toMatchObject({ status: 'pronta' });
    // Nada de nova chamada ao provedor: a mesma entrada não paga duas vezes.
    expect(provedor.enviados).toHaveLength(1);
  });

  it('o worker também confere o cache antes de chamar', async () => {
    // Dois jobs da mesma análise podem estar na fila ao mesmo tempo.
    await consentir(true);
    const dados = await prepararJob('resumo');

    const primeiro = await runAnalysis(dados);
    const segundo = await runAnalysis(dados);

    expect(primeiro.cached).toBe(false);
    expect(segundo).toMatchObject({ cached: true, tokensUsed: 0, costCents: 0 });
    expect(provedor.enviados).toHaveLength(1);
  });

  it('a cota só é debitada quando a análise existe', async () => {
    await consentir(true);

    const antes = await contarAnalises();
    await analisar();
    const depois = await contarAnalises();

    expect(depois).toBe(antes + 1);
  });

  it('chamada que falha não debita cota', async () => {
    // Cobrar por uma chamada que falhou seria cobrar pelo nosso problema.
    await consentir(true);
    provedor.falharNaProxima('provedor fora do ar');

    const antes = await contarAnalises();
    await expect(runAnalysis(await prepararJob('temas'))).rejects.toThrow('provedor fora do ar');

    expect(await contarAnalises()).toBe(antes);
  });

  it('cada tipo de análise tem o próprio cache', async () => {
    await consentir(true);
    await analisar('resumo');
    await analisar('temas');

    expect(provedor.enviados).toHaveLength(2);
    expect(provedor.enviados.map((envio) => envio.type)).toEqual(['resumo', 'temas']);
  });

  it('recusa tipo desconhecido', async () => {
    await consentir(true);
    const resposta = await api('POST', `/v1/forms/${formId}/ai-analyses`, { type: 'adivinhar_futuro' });

    expect(resposta.statusCode).toBe(422);
    expect(provedor.enviados).toHaveLength(0);
  });
});

describe('resposta que não decifra', () => {
  it('fica de fora sem derrubar a análise das outras', async () => {
    // Linha corrompida, restauração parcial, rotação de chave malfeita: todos
    // raros, todos possíveis. Nenhum deles é motivo para o recurso inteiro
    // parar de funcionar para aquele formulário.
    await consentir(true);

    const corrompida = await withTenant(ORG_A.id, ({ tx }) =>
      tx.response.create({
        data: {
          organizationId: ORG_A.id,
          formId,
          formVersion: 1,
          dataEncrypted: Buffer.from('isto não é um envelope válido'),
          dataKeyEncrypted: Buffer.from('nem isto'),
          status: 'new',
        },
        select: { id: true },
      }),
    );

    try {
      const { corpo, resultado } = await analisar();

      expect(resultado).not.toBeNull();
      expect(corpo!.unreadableCount).toBe(1);
      // E as demais continuaram na análise.
      expect(corpo!.responseCount).toBeGreaterThan(0);
    } finally {
      await withTenant(ORG_A.id, ({ tx }) => tx.response.delete({ where: { id: corrompida.id } }));
    }
  });
});

describe('trilha de auditoria', () => {
  it('registra a análise sem gravar o conteúdo dela', async () => {
    // O audit log é lido por gente que não precisa ver resposta de cliente.
    await consentir(true);
    const { resultado } = await analisar();

    const linha = await withTenant(ORG_A.id, ({ tx }) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'ai_analysis.created', resourceId: resultado!.analysisId },
      }),
    );

    expect(linha.metadataJson).toMatchObject({ type: 'resumo', formId });
    expect(JSON.stringify(linha.metadataJson)).not.toContain('resumo:');
    expect(JSON.stringify(linha.metadataJson)).not.toContain('@');
  });
});

describe('leitura das análises', () => {
  it('marca que o conteúdo foi gerado por IA', async () => {
    // Requisito de interface da seção 5.3: o usuário precisa saber.
    await consentir(true);
    await analisar();

    const lista = (await api('GET', `/v1/forms/${formId}/ai-analyses`)).json() as {
      analyses: Array<{ generatedByAi: boolean }>;
    };

    expect(lista.analyses.length).toBeGreaterThan(0);
    expect(lista.analyses.every((analise) => analise.generatedByAi)).toBe(true);
  });
});

async function contarAnalises(): Promise<number> {
  const uso = (await api('GET', '/v1/usage')).json() as { usage: { aiAnalysesCount: number } };
  return uso.usage.aiAnalysesCount;
}
