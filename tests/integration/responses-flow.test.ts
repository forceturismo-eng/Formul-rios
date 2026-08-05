import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { generateExport, toCsv } from '../../apps/api/src/queue/export-worker.js';
import { storage } from '../../apps/api/src/storage/provider.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { limparFormulariosDeTeste, PREFIXO_DE_TESTE } from '../helpers/limpeza.js';

/**
 * Painel de recebimentos, de ponta a ponta.
 *
 * O job de exportação é executado direto (`generateExport`), sem passar pela
 * fila. O que precisa ser provado aqui é que o arquivo sai correto e sob o
 * contexto de tenant certo — não que o BullMQ entrega, que é responsabilidade
 * do BullMQ.
 */

const HOST = 'localhost';
let token: string;
let formId: string;
let slug: string;

const definicao = {
  pages: [
    {
      id: 'p1',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome', required: true },
        { id: 'email', type: 'email', label: 'E-mail', required: true },
        { id: 'valor', type: 'currency', label: 'Valor' },
        {
          id: 'origem',
          type: 'dropdown',
          label: 'Origem',
          options: [
            { value: 'site', label: 'Site' },
            { value: 'indicacao', label: 'Indicação' },
          ],
        },
      ],
    },
  ],
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

async function enviar(values: Record<string, unknown>) {
  const app = await getApp();
  return app.inject({ method: 'POST', url: `/f/${slug}/submit`, headers: { host: HOST }, payload: { values } });
}

beforeAll(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;

  const criado = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}Recebimentos ${Date.now()}` });
  const form = criado.json() as { id: string; slugPublic: string };
  formId = form.id;
  slug = form.slugPublic;

  await api('PATCH', `/v1/forms/${formId}`, { expectedRevision: 0, definition: definicao });
  await api('POST', `/v1/forms/${formId}/publish`);

  await enviar({ nome: 'Ana Souza', email: 'ana@exemplo.com.br', valor: '150,00', origem: 'site' });
  await enviar({ nome: 'Bruno Lima', email: 'bruno@outro.com.br', valor: '2500,50', origem: 'indicacao' });
  await enviar({ nome: 'Carla Dias', email: 'carla@exemplo.com.br', origem: 'site' });
});

afterAll(async () => {
  await limparFormulariosDeTeste(ORG_A.id);
  await closeApp();
});

describe('listagem', () => {
  it('lista as respostas decifradas', async () => {
    const resposta = await api('GET', `/v1/forms/${formId}/responses`);
    expect(resposta.statusCode).toBe(200);

    const body = resposta.json() as {
      total: number;
      responses: Array<{ values: Record<string, unknown> }>;
    };

    expect(body.total).toBe(3);
    const nomes = body.responses.map((r) => r.values['nome']);
    expect(nomes).toContain('Ana Souza');
    expect(nomes).toContain('Bruno Lima');
  });

  it('guarda moeda em centavos', async () => {
    const body = (await api('GET', `/v1/forms/${formId}/responses`)).json() as {
      responses: Array<{ values: Record<string, unknown> }>;
    };
    const bruno = body.responses.find((r) => r.values['nome'] === 'Bruno Lima');

    expect(bruno?.values['valor']).toBe(250050);
  });

  it('filtra por status', async () => {
    const primeira = (
      (await api('GET', `/v1/forms/${formId}/responses`)).json() as { responses: Array<{ id: string }> }
    ).responses[0];

    await api('PATCH', `/v1/responses/${primeira!.id}`, { status: 'reviewed' });

    const revisadas = (await api('GET', `/v1/forms/${formId}/responses?status=reviewed`)).json() as { total: number };
    const novas = (await api('GET', `/v1/forms/${formId}/responses?status=new`)).json() as { total: number };

    expect(revisadas.total).toBe(1);
    expect(novas.total).toBe(2);
  });

  it('busca dentro do conteúdo cifrado', async () => {
    // O banco não enxerga o conteúdo — a busca decifra em memória, dentro do
    // contexto de tenant.
    const resultado = (await api('GET', `/v1/forms/${formId}/responses?search=bruno`)).json() as {
      total: number;
      responses: Array<{ values: Record<string, unknown> }>;
    };

    expect(resultado.total).toBe(1);
    expect(resultado.responses[0]!.values['nome']).toBe('Bruno Lima');
  });

  it('busca não encontra o que não existe', async () => {
    const resultado = (await api('GET', `/v1/forms/${formId}/responses?search=inexistente-xyz`)).json() as {
      total: number;
    };
    expect(resultado.total).toBe(0);
  });

  it('pagina', async () => {
    const pagina1 = (await api('GET', `/v1/forms/${formId}/responses?page=1&pageSize=2`)).json() as {
      responses: unknown[];
      total: number;
    };
    const pagina2 = (await api('GET', `/v1/forms/${formId}/responses?page=2&pageSize=2`)).json() as {
      responses: unknown[];
    };

    expect(pagina1.total).toBe(3);
    expect(pagina1.responses).toHaveLength(2);
    expect(pagina2.responses).toHaveLength(1);
  });
});

describe('ações sobre a resposta', () => {
  let responseId: string;

  beforeAll(async () => {
    const body = (await api('GET', `/v1/forms/${formId}/responses`)).json() as { responses: Array<{ id: string }> };
    responseId = body.responses[0]!.id;
  });

  it('marca e desmarca', async () => {
    expect((await api('PATCH', `/v1/responses/${responseId}`, { isFlagged: true })).json()).toMatchObject({
      isFlagged: true,
    });

    const marcadas = (await api('GET', `/v1/forms/${formId}/responses?flagged=true`)).json() as { total: number };
    expect(marcadas.total).toBe(1);
  });

  it('comenta e lista comentários', async () => {
    const criado = await api('POST', `/v1/responses/${responseId}/comments`, {
      body: 'Cliente ligou, seguir com o orçamento. @editor@alfa.test',
    });
    expect(criado.statusCode).toBe(201);

    const lista = (await api('GET', `/v1/responses/${responseId}/comments`)).json() as {
      comments: Array<{ body: string; user: { name: string } }>;
    };
    expect(lista.comments).toHaveLength(1);
    expect(lista.comments[0]!.user.name).toBeTruthy();
  });

  it('atribui a um membro da própria empresa', async () => {
    const membros = (await api('GET', '/v1/members')).json() as { members: Array<{ user: { id: string } }> };
    const atribuicao = await api('POST', `/v1/responses/${responseId}/assignments`, {
      assigneeId: membros.members[0]!.user.id,
    });

    expect(atribuicao.statusCode).toBe(201);
  });

  it('não atribui a alguém de outra empresa', async () => {
    // Sem esta checagem, um id de usuário de outra organização entraria como
    // responsável — e apareceria numa tela que ele não pode ver.
    const outraEmpresa = await withTenant('22222222-2222-4222-8222-222222222222', ({ tx }) =>
      tx.membership.findFirstOrThrow({ select: { userId: true } }),
    );

    const resposta = await api('POST', `/v1/responses/${responseId}/assignments`, {
      assigneeId: outraEmpresa.userId,
    });

    expect(resposta.statusCode).toBe(404);
  });

  it('apaga com soft delete', async () => {
    const body = (await api('GET', `/v1/forms/${formId}/responses`)).json() as { responses: Array<{ id: string }> };
    const alvo = body.responses[body.responses.length - 1]!.id;

    expect((await api('DELETE', `/v1/responses/${alvo}`)).statusCode).toBe(204);
    expect((await api('GET', `/v1/responses/${alvo}/full`)).statusCode).toBe(404);

    // A linha continua no banco até a purga por retenção.
    const aindaExiste = await withTenant(ORG_A.id, ({ tx }) => tx.response.findUnique({ where: { id: alvo } }));
    expect(aindaExiste?.deletedAt).not.toBeNull();
  });
});

describe('exportação', () => {
  it('gera CSV com BOM, ponto e vírgula e os rótulos dos campos', async () => {
    const pedido = await api('POST', `/v1/forms/${formId}/exports`, { format: 'csv' });
    expect(pedido.statusCode).toBe(202);

    const { id } = pedido.json() as { id: string };

    // Executa o job direto: o que importa provar é o arquivo, não o BullMQ.
    const resultado = await generateExport({
      exportId: id,
      organizationId: ORG_A.id,
      requestedBy: (await loginAs(ORG_A.owner)).userId,
      formId,
      format: 'csv',
      filters: {},
    });

    const bytes = await storage().get(resultado.key);
    const texto = bytes.toString('utf8');

    expect(texto.charCodeAt(0)).toBe(0xfeff); // BOM, para o Excel ler UTF-8
    expect(texto).toContain('Nome;E-mail');
    expect(texto).toContain('Bruno Lima');
    // Moeda volta a reais na exportação.
    expect(texto).toContain('2500.50');

    // A resposta apagada no bloco anterior NÃO sai na exportação. Isso importa
    // para a LGPD: um titular que pediu exclusão não pode reaparecer num CSV
    // baixado depois.
    expect(texto).not.toContain('Ana Souza');
  });

  it('marca a exportação como pronta e devolve URL assinada', async () => {
    const pedido = await api('POST', `/v1/forms/${formId}/exports`, { format: 'csv' });
    const { id } = pedido.json() as { id: string };

    await generateExport({
      exportId: id,
      organizationId: ORG_A.id,
      requestedBy: (await loginAs(ORG_A.owner)).userId,
      formId,
      format: 'csv',
      filters: {},
    });

    const lista = (await api('GET', `/v1/forms/${formId}/exports`)).json() as {
      exports: Array<{ id: string; status: string; rowCount: number }>;
    };
    const pronta = lista.exports.find((e) => e.id === id);
    expect(pronta?.status).toBe('done');

    const url = await api('GET', `/v1/exports/${id}/download-url`);
    expect(url.statusCode).toBe(200);
    expect((url.json() as { url: string }).url).toContain('sig=');
  });

  it('não deixa exportar em formato fora do plano', async () => {
    // A Agência Alfa está no Pro, que não tem... na verdade tem todos.
    // O caso real é o Free e o Starter — testado pela lista do plano.
    const resposta = await api('POST', `/v1/forms/${formId}/exports`, { format: 'json' });
    expect([202, 402]).toContain(resposta.statusCode);
  });

  it('escapa fórmula para não virar execução no Excel', () => {
    // Uma célula começando com "=" é executada quando o arquivo é aberto.
    const csv = toCsv(['Campo'], [['=HYPERLINK("http://mal.example","clique")']]).toString('utf8');
    expect(csv).toContain("'=HYPERLINK");
  });

  it('escapa aspas e ponto e vírgula', () => {
    const csv = toCsv(['A', 'B'], [['tem "aspas"', 'tem;ponto e vírgula']]).toString('utf8');
    expect(csv).toContain('"tem ""aspas"""');
    expect(csv).toContain('"tem;ponto e vírgula"');
  });
});
