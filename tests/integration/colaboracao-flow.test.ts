import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { readOutbox } from '../../apps/api/src/mail/mailer.js';

/**
 * Colaboração: equipe, convites, comentários e feed.
 *
 * Os casos que mais importam são os de escalada de privilégio. Gestão de equipe
 * é onde ela costuma aparecer: um admin que consegue rebaixar o owner assume a
 * empresa, e um editor que consegue se promover passa a ver o que não devia.
 */

const HOST = 'localhost';
let tokenDoOwner: string;
let tokenDoEditor: string;
let idDoOwner: string;
let idDoEditor: string;
let idDoViewer: string;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

interface Membro {
  id: string;
  role: string;
  isSelf: boolean;
  user: { email: string };
}

async function membros(token = tokenDoOwner): Promise<Membro[]> {
  const resposta = await api('GET', '/v1/members', token);
  return (resposta.json() as { members: Membro[] }).members;
}

beforeAll(async () => {
  tokenDoOwner = (await loginAs(ORG_A.owner)).accessToken;
  tokenDoEditor = (await loginAs(ORG_A.editor)).accessToken;

  const lista = await membros();
  idDoOwner = lista.find((m) => m.user.email === ORG_A.owner)!.id;
  idDoEditor = lista.find((m) => m.user.email === ORG_A.editor)!.id;
  idDoViewer = lista.find((m) => m.user.email === ORG_A.viewer)!.id;
});

afterEach(async () => {
  // Restaura os papéis do seed e limpa convites criados aqui.
  await withTenant(ORG_A.id, async ({ tx }) => {
    await tx.membership.update({ where: { id: idDoEditor }, data: { role: 'editor' } });
    await tx.membership.update({ where: { id: idDoViewer }, data: { role: 'viewer' } });
    await tx.invitation.deleteMany({ where: { email: { contains: 'colaboracao-teste' } } });
  });
});

afterAll(closeApp);

describe('listagem da equipe', () => {
  it('traz papel e marca quem é você', async () => {
    const lista = await membros();

    expect(lista.length).toBeGreaterThanOrEqual(3);
    expect(lista.find((m) => m.user.email === ORG_A.owner)?.isSelf).toBe(true);
    expect(lista.find((m) => m.user.email === ORG_A.editor)?.isSelf).toBe(false);
  });

  it('um viewer também vê a equipe', async () => {
    // Saber com quem se trabalha não é privilégio administrativo.
    const tokenDoViewer = (await loginAs(ORG_A.viewer)).accessToken;
    expect((await api('GET', '/v1/members', tokenDoViewer)).statusCode).toBe(200);
  });
});

describe('troca de papel', () => {
  it('o owner promove e rebaixa', async () => {
    expect((await api('PATCH', `/v1/members/${idDoViewer}`, tokenDoOwner, { role: 'editor' })).statusCode).toBe(200);

    const lista = await membros();
    expect(lista.find((m) => m.id === idDoViewer)?.role).toBe('editor');
  });

  it('um editor não promove ninguém', async () => {
    const resposta = await api('PATCH', `/v1/members/${idDoViewer}`, tokenDoEditor, { role: 'admin' });
    expect(resposta.statusCode).toBe(403);
  });

  it('ninguém dá um papel acima do próprio', async () => {
    // O caminho clássico de escalada: promover alguém a owner e pedir para
    // essa pessoa promover de volta.
    await withTenant(ORG_A.id, ({ tx }) => tx.membership.update({ where: { id: idDoEditor }, data: { role: 'admin' } }));
    const tokenDeAdmin = (await loginAs(ORG_A.editor)).accessToken;

    const resposta = await api('PATCH', `/v1/members/${idDoViewer}`, tokenDeAdmin, { role: 'owner' });

    expect(resposta.statusCode).toBe(403);
    expect(resposta.body).toContain('acima do seu');
  });

  it('ninguém mexe em quem está acima', async () => {
    // Sem esta trava, um admin rebaixa o owner e assume a empresa.
    await withTenant(ORG_A.id, ({ tx }) => tx.membership.update({ where: { id: idDoEditor }, data: { role: 'admin' } }));
    const tokenDeAdmin = (await loginAs(ORG_A.editor)).accessToken;

    const resposta = await api('PATCH', `/v1/members/${idDoOwner}`, tokenDeAdmin, { role: 'viewer' });

    expect(resposta.statusCode).toBe(403);

    // E o owner continua owner.
    expect((await membros()).find((m) => m.id === idDoOwner)?.role).toBe('owner');
  });

  it('o último owner não pode ser rebaixado', async () => {
    // O caso que transforma a conta numa que ninguém administra.
    const resposta = await api('PATCH', `/v1/members/${idDoOwner}`, tokenDoOwner, { role: 'admin' });

    expect(resposta.statusCode).toBe(409);
    expect(resposta.body).toContain('única pessoa com papel de dono');
    expect((await membros()).find((m) => m.id === idDoOwner)?.role).toBe('owner');
  });

  it('recusa papel inventado', async () => {
    expect((await api('PATCH', `/v1/members/${idDoViewer}`, tokenDoOwner, { role: 'superusuario' })).statusCode).toBe(
      422,
    );
  });
});

describe('remoção', () => {
  it('o último owner não pode sair', async () => {
    const resposta = await api('DELETE', `/v1/members/${idDoOwner}`, tokenDoOwner);

    expect(resposta.statusCode).toBe(409);
    expect(resposta.body).toContain('antes de sair');
  });

  it('um editor não remove ninguém', async () => {
    expect((await api('DELETE', `/v1/members/${idDoViewer}`, tokenDoEditor)).statusCode).toBe(403);
  });

  it('remover e reconvidar funciona', async () => {
    // Cria uma pessoa descartável para não mexer nas do seed.
    const criada = await withTenant(ORG_A.id, async ({ tx }) => {
      const usuario = await tx.user.create({
        data: {
          email: `descartavel-${Date.now()}@colaboracao-teste.local`,
          name: 'Pessoa Descartável',
          passwordHash: 'nao-usado',
        },
      });
      return tx.membership.create({
        data: { organizationId: ORG_A.id, userId: usuario.id, role: 'viewer', acceptedAt: new Date() },
        select: { id: true, userId: true },
      });
    });

    expect((await api('DELETE', `/v1/members/${criada.id}`, tokenDoOwner)).statusCode).toBe(200);
    expect((await membros()).find((m) => m.id === criada.id)).toBeUndefined();

    await withTenant(ORG_A.id, ({ tx }) => tx.user.delete({ where: { id: criada.userId } }));
  });
});

describe('convites', () => {
  it('cria, lista e cancela', async () => {
    const email = `convidado-${Date.now()}@colaboracao-teste.local`;

    const criacao = await api('POST', '/v1/invitations', tokenDoOwner, { email, role: 'editor' });
    expect(criacao.statusCode).toBe(201);

    const lista = (await api('GET', '/v1/invitations', tokenDoOwner)).json() as {
      invitations: Array<{ id: string; email: string; expired: boolean }>;
    };

    const convite = lista.invitations.find((c) => c.email === email);
    expect(convite).toBeDefined();
    expect(convite!.expired).toBe(false);

    expect((await api('DELETE', `/v1/invitations/${convite!.id}`, tokenDoOwner)).statusCode).toBe(200);

    const depois = (await api('GET', '/v1/invitations', tokenDoOwner)).json() as {
      invitations: Array<{ email: string }>;
    };
    expect(depois.invitations.map((c) => c.email)).not.toContain(email);
  });

  it('um editor não convida', async () => {
    const resposta = await api('POST', '/v1/invitations', tokenDoEditor, {
      email: `nao-vai-${Date.now()}@colaboracao-teste.local`,
      role: 'viewer',
    });

    expect(resposta.statusCode).toBe(403);
  });

  it('ninguém convida alguém como dono — nem o próprio dono', async () => {
    // Recusado pelo SCHEMA, antes de chegar ao RBAC: transferir a propriedade
    // da empresa é outro fluxo, com confirmação própria. Um convite que cria um
    // segundo dono seria a forma silenciosa de fazer isso.
    // O dono TEM permissão de convidar, então chega ao schema: 422.
    const doDono = await api('POST', '/v1/invitations', tokenDoOwner, {
      email: `dono-${Date.now()}@colaboracao-teste.local`,
      role: 'owner',
    });
    expect(doDono.statusCode).toBe(422);

    // O editor nem chega lá: para com 403 na permissão de convidar. Recusas
    // diferentes, e é assim que deve ser — cada camada responde pelo que ela
    // sabe.
    const doEditor = await api('POST', '/v1/invitations', tokenDoEditor, {
      email: `dono-${Date.now()}@colaboracao-teste.local`,
      role: 'owner',
    });
    expect(doEditor.statusCode).toBe(403);
  });

  it('um admin convida outro admin, mas não escala além disso', async () => {
    await withTenant(ORG_A.id, ({ tx }) => tx.membership.update({ where: { id: idDoEditor }, data: { role: 'admin' } }));
    const tokenDeAdmin = (await loginAs(ORG_A.editor)).accessToken;

    const permitido = await api('POST', '/v1/invitations', tokenDeAdmin, {
      email: `par-${Date.now()}@colaboracao-teste.local`,
      role: 'admin',
    });

    expect(permitido.statusCode).toBe(201);
  });
});

describe('comentários e menções', () => {
  let responseId: string;

  beforeAll(async () => {
    responseId = await withTenant(ORG_A.id, async ({ tx }) => {
      const resposta = await tx.response.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } });
      return resposta.id;
    });
  });

  it('comenta e lê de volta', async () => {
    const texto = `Comentário de teste ${Date.now()}`;

    expect((await api('POST', `/v1/responses/${responseId}/comments`, tokenDoOwner, { body: texto })).statusCode).toBe(
      201,
    );

    const lista = (await api('GET', `/v1/responses/${responseId}/comments`, tokenDoOwner)).json() as {
      comments: Array<{ body: string }>;
    };

    expect(lista.comments.map((c) => c.body)).toContain(texto);
  });

  it('menção a quem é da empresa avisa por e-mail, sem o conteúdo', async () => {
    // O corpo do comentário fala de uma resposta de formulário — dado pessoal
    // de terceiro. A caixa de entrada é o canal menos controlado que existe.
    const segredo = `nao-pode-vazar-${Date.now()}`;

    await api('POST', `/v1/responses/${responseId}/comments`, tokenDoOwner, {
      body: `@${ORG_A.editor} olha isso: ${segredo}`,
    });

    const aviso = readOutbox()
      .filter((email) => email.to === ORG_A.editor)
      .at(-1);

    expect(aviso).toBeDefined();
    expect(aviso!.subject).toContain('mencionou você');
    expect(aviso!.text).not.toContain(segredo);
  });

  it('menção a e-mail de fora NÃO vira destinatário', async () => {
    // Sem esta validação, escrever `@qualquer@coisa.com` faria a plataforma
    // mandar e-mail para um endereço arbitrário, em nome do cliente e com a
    // nossa reputação de remetente.
    const forasteiro = `forasteiro-${Date.now()}@dominio-de-fora.test`;
    const antes = readOutbox().length;

    const criacao = await api('POST', `/v1/responses/${responseId}/comments`, tokenDoOwner, {
      body: `@${forasteiro} entra aqui`,
    });

    expect(criacao.statusCode).toBe(201);

    const novos = readOutbox().slice(antes);
    expect(novos.map((email) => email.to)).not.toContain(forasteiro);

    // E a menção não foi gravada como se fosse válida.
    const gravado = (criacao.json() as { mentions?: string[] }).mentions ?? [];
    expect(gravado).not.toContain(forasteiro);
  });

  it('quem escreve não é notificado do próprio comentário', async () => {
    const antes = readOutbox().filter((email) => email.to === ORG_A.owner).length;

    await api('POST', `/v1/responses/${responseId}/comments`, tokenDoOwner, {
      body: `@${ORG_A.owner} falando comigo mesmo`,
    });

    expect(readOutbox().filter((email) => email.to === ORG_A.owner).length).toBe(antes);
  });
});

describe('feed de atividades', () => {
  it('traduz o audit log para linguagem de gente', async () => {
    await api('POST', '/v1/invitations', tokenDoOwner, {
      email: `feed-${Date.now()}@colaboracao-teste.local`,
      role: 'viewer',
    });

    const feed = (await api('GET', '/v1/activity', tokenDoOwner)).json() as {
      activity: Array<{ texto: string; categoria: string; autor: string | null; daPlataforma: boolean }>;
    };

    expect(feed.activity.length).toBeGreaterThan(0);

    const convite = feed.activity.find((entrada) => entrada.texto.includes('convidou'));
    expect(convite).toBeDefined();
    expect(convite!.categoria).toBe('equipe');
    expect(convite!.autor).toBeTruthy();
  });

  it('deixa de fora o ruído que ninguém lê', async () => {
    // Login e refresh acontecem o tempo todo. Num feed, afogam o resto.
    const feed = (await api('GET', '/v1/activity', tokenDoOwner)).json() as {
      activity: Array<{ texto: string }>;
    };

    for (const entrada of feed.activity) {
      expect(entrada.texto.toLowerCase()).not.toContain('login');
      expect(entrada.texto.toLowerCase()).not.toContain('refresh');
    }
  });

  it('nenhuma entrada carrega conteúdo de resposta', async () => {
    // O audit log não guarda, e o feed não tem como inventar — mas a tentação
    // de "mostrar um trechinho" aparece toda vez que alguém mexe nesta tela.
    const feed = (await api('GET', '/v1/activity', tokenDoOwner)).json() as {
      activity: Array<{ texto: string }>;
    };

    const texto = JSON.stringify(feed).toLowerCase();
    expect(texto).not.toContain('carla dias');
    expect(texto).not.toContain('390.533.447-05');
  });
});
