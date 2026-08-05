import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { limparFormulariosDeTeste, PREFIXO_DE_TESTE } from '../helpers/limpeza.js';
import { decryptResponseData } from '../../apps/api/src/crypto/envelope.js';

/**
 * Ciclo completo de um formulário: criar, publicar, responder, ler.
 *
 * O teste que mais importa aqui é o último de "submissão": ele decifra a
 * resposta gravada e confere o conteúdo. É o que prova que a criptografia em
 * repouso não é decorativa — que o que está na coluna é mesmo o que o
 * respondente enviou, e que dá para recuperá-lo.
 */

const HOST = 'localhost';
let token: string;

const definicao = {
  pages: [
    {
      id: 'p1',
      title: 'Contato',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome', required: true },
        { id: 'email', type: 'email', label: 'E-mail', required: true },
        { id: 'documento', type: 'cpf_cnpj', label: 'CPF' },
        {
          id: 'assunto',
          type: 'dropdown',
          label: 'Assunto',
          required: true,
          options: [
            { value: 'orcamento', label: 'Orçamento' },
            { value: 'suporte', label: 'Suporte' },
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

async function publico(method: 'GET' | 'POST', url: string, payload?: unknown, host = HOST) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

async function criarFormulario(titulo: string) {
  // Prefixo de teste: é por ele que a limpeza no fim da suíte encontra o que
  // apagar, sem tocar nos formulários do seed.
  const criado = await api('POST', '/v1/forms', { title: `${PREFIXO_DE_TESTE}${titulo}` });
  expect(criado.statusCode).toBe(201);
  return criado.json() as { id: string; revision: number; slugPublic: string; status: string };
}

beforeAll(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;
});

afterAll(async () => {
  await limparFormulariosDeTeste(ORG_A.id);
  await closeApp();
});

describe('criação e edição', () => {
  it('dois formulários com o mesmo título não colidem no slug', async () => {
    // O slug público é único globalmente, e o RLS impede conferir colisão
    // antes — quem resolve é o índice único, com retentativa.
    //
    // A retentativa precisa de uma transação NOVA: no Postgres, a violação de
    // unicidade aborta a transação inteira, e o comando seguinte falha com um
    // erro que não é P2002. Antes desta correção, o segundo formulário com o
    // mesmo título respondia 500.
    const titulo = `Mesmo título ${Date.now()}`;

    const primeiro = await criarFormulario(titulo);
    const segundo = await criarFormulario(titulo);

    expect(primeiro.slugPublic).not.toBe(segundo.slugPublic);
    expect(segundo.slugPublic.startsWith(primeiro.slugPublic)).toBe(true);
  });

  it('cria um formulário em rascunho, com uma página vazia', async () => {
    const form = await criarFormulario(`Contato ${Date.now()}`);

    expect(form.status).toBe('draft');
    expect(form.revision).toBe(0);
    // O slug deriva do título, e o título leva o prefixo de teste.
    expect(form.slugPublic).toMatch(/^suite-contato-/);
  });

  it('grava a definição e incrementa a revisão', async () => {
    const form = await criarFormulario(`Editável ${Date.now()}`);

    const salvo = await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: form.revision,
      definition: definicao,
    });

    expect(salvo.statusCode).toBe(200);
    expect((salvo.json() as { revision: number }).revision).toBe(1);
  });

  it('recusa gravação com revisão desatualizada', async () => {
    const form = await criarFormulario(`Concorrente ${Date.now()}`);

    // Duas pessoas leram a revisão 0. A primeira salva...
    const primeira = await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: 0,
      title: 'Salvo pela primeira pessoa',
    });
    expect(primeira.statusCode).toBe(200);

    // ...e a segunda tenta salvar com a revisão que leu antes.
    const segunda = await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: 0,
      title: 'Salvo pela segunda pessoa',
    });

    // Sem o lock, este PATCH apagaria o trabalho da primeira sem aviso.
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json()).toMatchObject({ error: { code: 'conflict' } });

    const atual = await api('GET', `/v1/forms/${form.id}/full`);
    expect((atual.json() as { title: string }).title).toBe('Salvo pela primeira pessoa');
  });

  it('recusa definição inválida', async () => {
    const form = await criarFormulario(`Inválido ${Date.now()}`);

    const resposta = await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: form.revision,
      definition: { pages: [{ id: 'p1', fields: [{ id: 'a', type: 'tipo_que_nao_existe', label: 'A' }] }] },
    });

    expect(resposta.statusCode).toBe(422);
  });

  it('valida schema sem gravar', async () => {
    const ok = await api('POST', '/v1/forms/validate-schema', { definition: definicao });
    expect(ok.json()).toMatchObject({ valid: true });

    const ruim = await api('POST', '/v1/forms/validate-schema', {
      definition: { pages: [{ id: 'p1', fields: [{ id: 'x', type: 'dropdown', label: 'X' }] }] },
    });
    expect(ruim.json()).toMatchObject({ valid: false });
  });
});

describe('publicação e versionamento', () => {
  it('não publica formulário sem campo nenhum', async () => {
    const form = await criarFormulario(`Vazio ${Date.now()}`);
    const resposta = await api('POST', `/v1/forms/${form.id}/publish`);

    expect(resposta.statusCode).toBe(422);
  });

  it('publica e cria a versão 1', async () => {
    const form = await criarFormulario(`Publicável ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });

    const publicado = await api('POST', `/v1/forms/${form.id}/publish`);
    expect(publicado.statusCode).toBe(200);
    expect(publicado.json()).toMatchObject({ status: 'published', version: 1 });

    const versoes = await api('GET', `/v1/forms/${form.id}/versions`);
    expect((versoes.json() as { versions: unknown[] }).versions).toHaveLength(1);
  });

  it('cada nova publicação cria uma versão', async () => {
    const form = await criarFormulario(`Versionado ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${form.id}/publish`);

    const atual = await api('GET', `/v1/forms/${form.id}/full`);
    await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: (atual.json() as { revision: number }).revision,
      title: 'Título novo',
    });
    await api('POST', `/v1/forms/${form.id}/publish`);

    const versoes = await api('GET', `/v1/forms/${form.id}/versions`);
    const lista = (versoes.json() as { versions: Array<{ version: number }> }).versions;

    // As respostas guardam a versão com que foram enviadas. Sem histórico,
    // editar um formulário reescreveria o significado das respostas antigas.
    expect(lista.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it('arquiva sem apagar', async () => {
    const form = await criarFormulario(`Arquivável ${Date.now()}`);
    const arquivado = await api('POST', `/v1/forms/${form.id}/archive`);

    expect(arquivado.json()).toMatchObject({ status: 'archived' });
    // Continua acessível: a copy da seção 11 promete que nada é apagado.
    expect((await api('GET', `/v1/forms/${form.id}/full`)).statusCode).toBe(200);
  });

  it('duplica preservando a definição', async () => {
    const form = await criarFormulario(`Original ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });

    const copia = await api('POST', `/v1/forms/${form.id}/duplicate`);
    expect(copia.statusCode).toBe(201);

    const body = copia.json() as { id: string; title: string; status: string };
    expect(body.title).toContain('(cópia)');
    expect(body.status).toBe('draft');
    expect(body.id).not.toBe(form.id);
  });
});

describe('renderizador público', () => {
  let slug: string;

  beforeAll(async () => {
    const form = await criarFormulario(`Público ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${form.id}/publish`);
    slug = form.slugPublic;
  });

  it('serve o formulário publicado sem autenticação', async () => {
    const resposta = await publico('GET', `/f/${slug}`);

    expect(resposta.statusCode).toBe(200);
    const body = resposta.json() as { state: string; definition: { pages: unknown[] }; organization: { name: string } };
    expect(body.state).toBe('open');
    expect(body.definition.pages).toHaveLength(1);
    expect(body.organization.name).toBe(ORG_A.name);
  });

  it('não serve rascunho', async () => {
    const rascunho = await criarFormulario(`Rascunho ${Date.now()}`);
    const resposta = await publico('GET', `/f/${rascunho.slugPublic}`);

    // Rascunho, apagado e inexistente respondem igual: um 404 diferente de um
    // 410 já diria que o formulário existiu.
    expect(resposta.statusCode).toBe(404);
  });

  it('slug inexistente responde 404', async () => {
    expect((await publico('GET', '/f/nao-existe-mesmo')).statusCode).toBe(404);
  });

  it('funciona em qualquer host, porque o tenant vem do slug', async () => {
    // Estas são as únicas rotas servidas nos domínios de clientes (seção 8.1).
    const resposta = await publico('GET', `/f/${slug}`, undefined, 'formularios.cliente.com.br');
    expect(resposta.statusCode).toBe(200);
    expect((resposta.json() as { organization: { name: string } }).organization.name).toBe(ORG_A.name);
  });

  it('não vaza cookie de sessão no domínio público', async () => {
    const resposta = await publico('GET', `/f/${slug}`, undefined, 'formularios.cliente.com.br');
    expect(resposta.headers['set-cookie']).toBeUndefined();
  });
});

describe('submissão', () => {
  let slug: string;
  let formId: string;

  beforeAll(async () => {
    const form = await criarFormulario(`Recebedor ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${form.id}/publish`);
    slug = form.slugPublic;
    formId = form.id;
  });

  it('aceita uma resposta válida e a grava cifrada', async () => {
    const resposta = await publico('POST', `/f/${slug}/submit`, {
      values: {
        nome: 'Joana Respondente',
        email: 'joana@exemplo.com.br',
        documento: '529.982.247-25',
        assunto: 'orcamento',
      },
    });

    expect(resposta.statusCode).toBe(201);
    const { responseId } = resposta.json() as { responseId: string };

    const gravada = await withTenant(ORG_A.id, ({ tx }) =>
      tx.response.findUniqueOrThrow({ where: { id: responseId } }),
    );

    // O que está na coluna precisa ser ilegível...
    expect(Buffer.from(gravada.dataEncrypted).toString('utf8')).not.toContain('joana');
    // ...e recuperável com a chave da organização certa.
    const conteudo = decryptResponseData<Record<string, unknown>>(ORG_A.id, gravada);
    expect(conteudo['nome']).toBe('Joana Respondente');
    expect(conteudo['documento']).toBe('52998224725');

    expect(gravada.formVersion).toBe(1);
    // IP e user-agent nunca em claro (seção 9).
    expect(gravada.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recusa resposta incompleta', async () => {
    const resposta = await publico('POST', `/f/${slug}/submit`, { values: { nome: 'Só o nome' } });

    expect(resposta.statusCode).toBe(422);
    const body = resposta.json() as { error: { details: Record<string, string[]> } };
    expect(body.error.details['email']).toBeDefined();
    expect(body.error.details['assunto']).toBeDefined();
  });

  it('recusa CPF inválido', async () => {
    const resposta = await publico('POST', `/f/${slug}/submit`, {
      values: { nome: 'X', email: 'x@y.com', documento: '111.111.111-11', assunto: 'suporte' },
    });
    expect(resposta.statusCode).toBe(422);
  });

  it('recusa opção que não está na lista', async () => {
    const resposta = await publico('POST', `/f/${slug}/submit`, {
      values: { nome: 'X', email: 'x@y.com', assunto: 'valor-injetado' },
    });
    expect(resposta.statusCode).toBe(422);
  });

  it('descarta em silêncio quando o honeypot é preenchido', async () => {
    const antes = await withTenant(ORG_A.id, ({ tx }) => tx.response.count({ where: { formId } }));

    const resposta = await publico('POST', `/f/${slug}/submit`, {
      values: { nome: 'Robô', email: 'robo@spam.test', assunto: 'suporte' },
      website: 'http://spam.example.com',
    });

    // 201 de propósito: o robô vai embora achando que funcionou, em vez de
    // tentar outra estratégia.
    expect(resposta.statusCode).toBe(201);

    const depois = await withTenant(ORG_A.id, ({ tx }) => tx.response.count({ where: { formId } }));
    expect(depois).toBe(antes);
  });

  it('ignora campo que não existe no formulário', async () => {
    const resposta = await publico('POST', `/f/${slug}/submit`, {
      values: {
        nome: 'Teste',
        email: 'teste@exemplo.com',
        assunto: 'suporte',
        organizationId: '22222222-2222-4222-8222-222222222222',
        is_admin: true,
      },
    });

    expect(resposta.statusCode).toBe(201);
    const { responseId } = resposta.json() as { responseId: string };

    const gravada = await withTenant(ORG_A.id, ({ tx }) =>
      tx.response.findUniqueOrThrow({ where: { id: responseId } }),
    );
    const conteudo = decryptResponseData<Record<string, unknown>>(ORG_A.id, gravada);

    expect(conteudo['organizationId']).toBeUndefined();
    expect(conteudo['is_admin']).toBeUndefined();
    // E a resposta ficou mesmo na empresa dona do formulário.
    expect(gravada.organizationId).toBe(ORG_A.id);
  });

  it('não aceita resposta em formulário fechado por data', async () => {
    const form = await criarFormulario(`Fechado ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${form.id}/publish`);

    const atual = await api('GET', `/v1/forms/${form.id}/full`);
    await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: (atual.json() as { revision: number }).revision,
      settings: { closesAt: new Date(Date.now() - 60_000).toISOString() },
    });

    const visao = await publico('GET', `/f/${form.slugPublic}`);
    expect((visao.json() as { state: string }).state).toBe('closed_by_date');

    const envio = await publico('POST', `/f/${form.slugPublic}/submit`, {
      values: { nome: 'X', email: 'x@y.com', assunto: 'suporte' },
    });
    expect(envio.statusCode).toBe(403);

    // A mensagem ao respondente não menciona plano, limite nem pagamento.
    const mensagem = JSON.stringify(envio.json()).toLowerCase();
    for (const proibido of ['plano', 'pagamento', 'limite', 'assinatura', 'upgrade']) {
      expect(mensagem, `mensagem menciona "${proibido}"`).not.toContain(proibido);
    }
  });

  it('respeita o limite de respostas do formulário', async () => {
    const form = await criarFormulario(`Limitado ${Date.now()}`);
    await api('PATCH', `/v1/forms/${form.id}`, { expectedRevision: 0, definition: definicao });
    await api('POST', `/v1/forms/${form.id}/publish`);

    const atual = await api('GET', `/v1/forms/${form.id}/full`);
    await api('PATCH', `/v1/forms/${form.id}`, {
      expectedRevision: (atual.json() as { revision: number }).revision,
      settings: { maxResponses: 1 },
    });

    const valores = { values: { nome: 'A', email: 'a@b.com', assunto: 'suporte' } };
    expect((await publico('POST', `/f/${form.slugPublic}/submit`, valores)).statusCode).toBe(201);
    expect((await publico('POST', `/f/${form.slugPublic}/submit`, valores)).statusCode).toBe(403);
  });
});
