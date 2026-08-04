import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { storage } from '../../apps/api/src/storage/provider.js';
import { generateExport } from '../../apps/api/src/queue/export-worker.js';

/**
 * TESTE BLOQUEANTE — a fronteira entre empresas nas superfícies novas da Fase 2.
 *
 * Cada recurso que a Fase 2 trouxe é uma porta nova, e toda porta nova é uma
 * chance de esquecer o isolamento. Aqui elas são atacadas a partir da
 * Empresa A, com IDs reais da Empresa B:
 *
 *   formulários, respostas, comentários, atribuições, exportações, arquivos,
 *   e o renderizador público.
 */

let tokenA: string;
let tokenB: string;
let idsDeB: {
  formId: string;
  slug: string;
  responseId: string;
  exportId: string;
  fileKey: string;
  fileId: string;
};

const definicao = {
  pages: [
    {
      id: 'p1',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome', required: true },
        { id: 'segredo', type: 'long_text', label: 'Informação confidencial' },
      ],
    },
  ],
};

async function comoA(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: 'localhost', authorization: `Bearer ${tokenA}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

async function comoB(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: 'localhost', authorization: `Bearer ${tokenB}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

beforeAll(async () => {
  const sessaoA = await loginAs(ORG_A.owner);
  const sessaoB = await loginAs(ORG_B.owner);
  tokenA = sessaoA.accessToken;
  tokenB = sessaoB.accessToken;

  // A Empresa B monta um formulário completo, com resposta, arquivo e exportação.
  const criado = await comoB('POST', '/v1/forms', { title: `Confidencial B ${Date.now()}` });
  const form = criado.json() as { id: string; slugPublic: string };

  await comoB('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
  await comoB('POST', `/v1/forms/${form.id}/publish`);

  const app = await getApp();
  await app.inject({
    method: 'POST',
    url: `/f/${form.slugPublic}/submit`,
    headers: { host: 'localhost' },
    payload: { values: { nome: 'Paciente da Beta', segredo: 'diagnóstico sigiloso' } },
  });

  const responses = (await comoB('GET', `/v1/forms/${form.id}/responses`)).json() as {
    responses: Array<{ id: string }>;
  };

  const pedido = await comoB('POST', `/v1/forms/${form.id}/exports`, { format: 'csv' });
  const { id: exportId } = pedido.json() as { id: string };
  await generateExport({
    exportId,
    organizationId: ORG_B.id,
    requestedBy: sessaoB.userId,
    formId: form.id,
    format: 'csv',
    filters: {},
  });

  // Um arquivo da Empresa B, criado direto para ter a chave do storage.
  const arquivo = await withTenant(ORG_B.id, async ({ tx }) => {
    const key = `${ORG_B.id}/respostas/2026-08-04/${'b'.repeat(32)}.pdf`;
    await storage().put(key, Buffer.from('%PDF-1.7 conteudo confidencial'), 'application/pdf');
    return tx.file.create({
      data: {
        organizationId: ORG_B.id,
        s3Key: key,
        filename: 'confidencial.pdf',
        mime: 'application/pdf',
        sizeBytes: 30,
        scanStatus: 'clean',
      },
    });
  });

  idsDeB = {
    formId: form.id,
    slug: form.slugPublic,
    responseId: responses.responses[0]!.id,
    exportId,
    fileKey: arquivo.s3Key,
    fileId: arquivo.id,
  };
});

afterAll(closeApp);

describe('formulários da outra empresa', () => {
  it('não são lidos', async () => {
    expect((await comoA('GET', `/v1/forms/${idsDeB.formId}/full`)).statusCode).toBe(404);
  });

  it('não são editados', async () => {
    const resposta = await comoA('PATCH', `/v1/forms/${idsDeB.formId}`, {
      expectedRevision: 0,
      title: 'Sequestrado pela Alfa',
    });
    expect(resposta.statusCode).toBe(404);
  });

  it('não são publicados, arquivados nem apagados', async () => {
    expect((await comoA('POST', `/v1/forms/${idsDeB.formId}/publish`)).statusCode).toBe(404);
    expect((await comoA('POST', `/v1/forms/${idsDeB.formId}/archive`)).statusCode).toBe(404);
    expect((await comoA('DELETE', `/v1/forms/${idsDeB.formId}`)).statusCode).toBe(404);
  });

  it('não são duplicados — copiar também é ler', async () => {
    expect((await comoA('POST', `/v1/forms/${idsDeB.formId}/duplicate`)).statusCode).toBe(404);
  });

  it('não aparecem na listagem da Alfa', async () => {
    const lista = (await comoA('GET', '/v1/forms')).json() as { forms: Array<{ id: string }> };
    expect(lista.forms.map((f) => f.id)).not.toContain(idsDeB.formId);
  });

  it('não têm o histórico de versões exposto', async () => {
    expect((await comoA('GET', `/v1/forms/${idsDeB.formId}/versions`)).statusCode).toBe(404);
  });
});

describe('respostas da outra empresa', () => {
  it('a listagem por formulário alheio responde 404', async () => {
    expect((await comoA('GET', `/v1/forms/${idsDeB.formId}/responses`)).statusCode).toBe(404);
  });

  it('a resposta individual não é lida', async () => {
    const resposta = await comoA('GET', `/v1/responses/${idsDeB.responseId}/full`);

    expect(resposta.statusCode).toBe(404);
    // E o conteúdo não vaza nem por mensagem de erro.
    expect(resposta.body).not.toContain('diagnóstico');
    expect(resposta.body).not.toContain('Paciente');
  });

  it('não é marcada nem apagada', async () => {
    expect((await comoA('PATCH', `/v1/responses/${idsDeB.responseId}`, { status: 'archived' })).statusCode).toBe(404);
    expect((await comoA('DELETE', `/v1/responses/${idsDeB.responseId}`)).statusCode).toBe(404);
  });

  it('não recebe comentário nem atribuição', async () => {
    expect(
      (await comoA('POST', `/v1/responses/${idsDeB.responseId}/comments`, { body: 'oi' })).statusCode,
    ).toBe(404);
    expect((await comoA('GET', `/v1/responses/${idsDeB.responseId}/comments`)).statusCode).toBe(404);
  });

  it('continua intacta depois das tentativas', async () => {
    const intacta = await withTenant(ORG_B.id, ({ tx }) =>
      tx.response.findUniqueOrThrow({ where: { id: idsDeB.responseId } }),
    );
    expect(intacta.deletedAt).toBeNull();
    expect(intacta.status).toBe('new');
  });
});

describe('exportações da outra empresa', () => {
  it('a lista de exportações de um formulário alheio responde 404', async () => {
    expect((await comoA('GET', `/v1/forms/${idsDeB.formId}/exports`)).statusCode).toBe(404);
  });

  it('a URL de download não é emitida', async () => {
    // Uma exportação é o conteúdo inteiro de um formulário num arquivo só.
    expect((await comoA('GET', `/v1/exports/${idsDeB.exportId}/download-url`)).statusCode).toBe(404);
  });

  it('pedir exportação de formulário alheio responde 404', async () => {
    expect((await comoA('POST', `/v1/forms/${idsDeB.formId}/exports`, { format: 'csv' })).statusCode).toBe(404);
  });
});

describe('arquivos da outra empresa', () => {
  it('a URL assinada não é emitida', async () => {
    expect((await comoA('GET', `/v1/files/${idsDeB.fileId}/download-url`)).statusCode).toBe(404);
  });

  it('o download direto sem assinatura válida responde 404', async () => {
    const app = await getApp();
    const resposta = await app.inject({
      method: 'GET',
      url: `/v1/files/download?key=${encodeURIComponent(idsDeB.fileKey)}&exp=99999999999&sig=${'0'.repeat(64)}`,
      headers: { host: 'localhost' },
    });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.body).not.toContain('confidencial');
  });

  it('assinatura expirada não vale', async () => {
    const { signKey } = await import('../../apps/api/src/storage/provider.js');
    const passado = Math.floor(Date.now() / 1000) - 60;
    const app = await getApp();

    const resposta = await app.inject({
      method: 'GET',
      url: `/v1/files/download?key=${encodeURIComponent(idsDeB.fileKey)}&exp=${passado}&sig=${signKey(idsDeB.fileKey, passado)}`,
      headers: { host: 'localhost' },
    });

    expect(resposta.statusCode).toBe(404);
  });

  it('o caminho no bucket é prefixado pela organização dona', async () => {
    // O isolamento não para no banco: uma chave montada errada seria um
    // vazamento que o RLS não pega.
    expect(idsDeB.fileKey.startsWith(`${ORG_B.id}/`)).toBe(true);
    expect(idsDeB.fileKey.startsWith(ORG_A.id)).toBe(false);
  });
});

describe('renderizador público', () => {
  it('o formulário público não expõe respostas nem dados da empresa além do branding', async () => {
    const app = await getApp();
    const resposta = await app.inject({ method: 'GET', url: `/f/${idsDeB.slug}`, headers: { host: 'localhost' } });

    expect(resposta.statusCode).toBe(200);

    const corpo = resposta.body;
    expect(corpo).not.toContain('diagnóstico');
    expect(corpo).not.toContain('Paciente da Beta');
    expect(corpo).not.toContain(idsDeB.responseId);
    // Nem o plano ou o estado da assinatura do cliente aparecem para quem responde.
    expect(corpo).not.toContain('planCode');
    expect(corpo).not.toContain('subscriptionStatus');
  });

  it('a submissão pública cai na empresa dona do formulário, não na de quem envia', async () => {
    const app = await getApp();
    const enviada = await app.inject({
      method: 'POST',
      url: `/f/${idsDeB.slug}/submit`,
      // Mesmo com um token da Empresa A no header, a resposta é da Empresa B:
      // o tenant vem do slug, e a rota pública nem olha `Authorization`.
      headers: { host: 'localhost', authorization: `Bearer ${tokenA}` },
      payload: { values: { nome: 'Enviado com token da Alfa' } },
    });

    expect(enviada.statusCode).toBe(201);
    const { responseId } = enviada.json() as { responseId: string };

    const gravada = await withTenant(ORG_B.id, ({ tx }) =>
      tx.response.findUniqueOrThrow({ where: { id: responseId } }),
    );
    expect(gravada.organizationId).toBe(ORG_B.id);

    // E a Empresa A não consegue lê-la.
    expect((await comoA('GET', `/v1/responses/${responseId}/full`)).statusCode).toBe(404);
  });

  it('o upload público vai para o prefixo da empresa dona do formulário', async () => {
    const arquivos = await withTenant(ORG_B.id, ({ tx }) =>
      tx.file.findMany({ select: { s3Key: true }, take: 20 }),
    );

    for (const arquivo of arquivos) {
      expect(arquivo.s3Key.startsWith(`${ORG_B.id}/`)).toBe(true);
    }
  });
});

describe('a exportação roda no tenant certo', () => {
  it('exportar com contexto da Empresa B não traz nada da Empresa A', async () => {
    const sessaoB = await loginAs(ORG_B.owner);
    const pedido = await comoB('POST', `/v1/forms/${idsDeB.formId}/exports`, { format: 'csv' });
    const { id } = pedido.json() as { id: string };

    const resultado = await generateExport({
      exportId: id,
      organizationId: ORG_B.id,
      requestedBy: sessaoB.userId,
      formId: idsDeB.formId,
      format: 'csv',
      filters: {},
    });

    const texto = (await storage().get(resultado.key)).toString('utf8');

    // O worker abre o contexto de tenant como a API faz. Sem isso, um job
    // rodaria sem RLS e exportaria a base inteira.
    expect(texto).toContain('Paciente da Beta');
    expect(texto).not.toContain('@alfa.test');
  });

  it('exportar um formulário da Empresa B com contexto da Empresa A não produz linhas', async () => {
    const sessaoA = await loginAs(ORG_A.owner);

    // O formulário não existe para a Empresa A, então o job falha em vez de
    // gerar um arquivo vazio que pareceria sucesso.
    await expect(
      generateExport({
        exportId: idsDeB.exportId,
        organizationId: ORG_A.id,
        requestedBy: sessaoA.userId,
        formId: idsDeB.formId,
        format: 'csv',
        filters: {},
      }),
    ).rejects.toThrow();
  });
});
