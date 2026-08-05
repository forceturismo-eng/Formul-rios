import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp } from '../helpers/api.js';
import { ORG_A, ORG_B, SEED_PASSWORD } from '../helpers/orgs.js';
import { prisma } from '../../apps/api/src/db/prisma.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { generateTotp, generateTotpSecret } from '../../apps/api/src/auth/totp.js';

/**
 * Admin da plataforma (seção 5.5).
 *
 * É a conta mais perigosa do sistema: uma pessoa que enxerga todos os clientes.
 * As perguntas que este arquivo responde:
 *
 *  1. Senha sozinha abre alguma coisa? (não — MFA é obrigatório)
 *  2. Um token de cliente vira token de admin? E o contrário?
 *  3. As rotas de admin devolvem conteúdo de cliente? (não — só agregado)
 *  4. Impersonar deixa rastro nos dois lados, e escreve alguma coisa?
 */

const HOST = 'localhost';
const ADMIN_EMAIL = 'admin@plataforma.test';

let segredoTotp: string;

/**
 * O login do admin tem rate limit de 5 tentativas por 15 minutos, por IP — uma
 * proteção do produto, não um detalhe. Cada caso desta suíte injeta de um IP
 * diferente, que é o que aconteceria na vida real com operadores distintos.
 * Afrouxar o limite para o teste passar seria trocar segurança por conveniência.
 */
let proximoIp = 0;
function ipDoTeste(): string {
  proximoIp += 1;
  return `203.0.113.${proximoIp % 250}`;
}

async function post(url: string, payload: unknown, token?: string) {
  const app = await getApp();
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: ipDoTeste(),
    headers: { host: HOST, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: payload as never,
  });
}

async function get(url: string, token?: string) {
  const app = await getApp();
  return app.inject({
    method: 'GET',
    url,
    headers: { host: HOST, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

async function patch(url: string, payload: unknown, token?: string) {
  const app = await getApp();
  return app.inject({
    method: 'PATCH',
    url,
    headers: { host: HOST, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: payload as never,
  });
}

/** Login completo, com o segundo fator já configurado. */
async function entrarComoAdmin(): Promise<string> {
  const resposta = await post('/admin/auth/login', {
    email: ADMIN_EMAIL,
    password: SEED_PASSWORD,
    totpCode: generateTotp(segredoTotp),
  });

  if (resposta.statusCode !== 200) {
    throw new Error(`Login do admin falhou: ${resposta.statusCode} ${resposta.body}`);
  }

  return (resposta.json() as { token: string }).token;
}

beforeAll(async () => {
  // Configura o MFA direto no banco: o caminho pela API tem teste próprio, e
  // repeti-lo em todo `beforeAll` gastaria janelas de TOTP à toa.
  segredoTotp = generateTotpSecret();

  await prisma.platformAdmin.update({
    where: { email: ADMIN_EMAIL },
    data: { totpSecret: segredoTotp, totpEnabledAt: new Date(), lastTotpWindow: null, disabledAt: null },
  });
});

afterEach(async () => {
  // O bloqueio de reuso de código é global por admin; zerá-lo entre casos
  // evita que um teste derrube o seguinte.
  await prisma.platformAdmin.update({ where: { email: ADMIN_EMAIL }, data: { lastTotpWindow: null } });
});

afterAll(async () => {
  // A trilha do admin NÃO é limpa aqui — a aplicação não tem DELETE nela, e é
  // exatamente isso que o último caso deste arquivo verifica. Um `deleteMany`
  // aqui falharia, e falhar seria o comportamento certo.
  await closeApp();
});

describe('MFA é obrigatório', () => {
  it('senha certa sem código não entra', async () => {
    const resposta = await post('/admin/auth/login', { email: ADMIN_EMAIL, password: SEED_PASSWORD });

    expect(resposta.statusCode).toBe(401);
    expect(resposta.body).not.toContain('token');
  });

  it('código errado não entra', async () => {
    const resposta = await post('/admin/auth/login', {
      email: ADMIN_EMAIL,
      password: SEED_PASSWORD,
      totpCode: '000000',
    });

    expect(resposta.statusCode).toBe(401);
  });

  it('senha errada com código certo não entra', async () => {
    const resposta = await post('/admin/auth/login', {
      email: ADMIN_EMAIL,
      password: 'senha-errada-mas-longa-2026',
      totpCode: generateTotp(segredoTotp),
    });

    expect(resposta.statusCode).toBe(401);
  });

  it('o mesmo código não vale duas vezes', async () => {
    // Ele continua válido por até 90 segundos. Sem registrar a janela
    // consumida, um código interceptado pode ser reapresentado dentro dela.
    const codigo = generateTotp(segredoTotp);

    const primeiro = await post('/admin/auth/login', {
      email: ADMIN_EMAIL,
      password: SEED_PASSWORD,
      totpCode: codigo,
    });
    expect(primeiro.statusCode).toBe(200);

    const segundo = await post('/admin/auth/login', {
      email: ADMIN_EMAIL,
      password: SEED_PASSWORD,
      totpCode: codigo,
    });

    expect(segundo.statusCode).toBe(401);
    expect(segundo.body).toContain('já foi usado');
  });

  it('admin sem MFA configurado não acessa nada além da configuração', async () => {
    await prisma.platformAdmin.update({
      where: { email: ADMIN_EMAIL },
      data: { totpEnabledAt: null },
    });

    try {
      const login = await post('/admin/auth/login', { email: ADMIN_EMAIL, password: SEED_PASSWORD });

      expect(login.statusCode).toBe(200);
      const corpo = login.json() as { status: string; setupToken: string; totp: { uri: string } };

      expect(corpo.status).toBe('mfa_setup');
      expect(corpo.totp.uri.startsWith('otpauth://totp/')).toBe(true);

      // O token de configuração não abre o painel.
      expect((await get('/admin/metrics', corpo.setupToken)).statusCode).toBe(401);
      expect((await get('/admin/organizations', corpo.setupToken)).statusCode).toBe(401);
    } finally {
      await prisma.platformAdmin.update({
        where: { email: ADMIN_EMAIL },
        data: { totpSecret: segredoTotp, totpEnabledAt: new Date(), lastTotpWindow: null },
      });
    }
  });

  it('e-mail inexistente responde igual a senha errada', async () => {
    const inexistente = await post('/admin/auth/login', {
      email: 'ninguem@plataforma.test',
      password: SEED_PASSWORD,
      totpCode: '123456',
    });

    expect(inexistente.statusCode).toBe(401);
    expect(inexistente.json()).toMatchObject({ error: { message: 'Credenciais inválidas.' } });
  });
});

describe('as duas autenticações não se misturam', () => {
  it('token de cliente não abre rota de admin', async () => {
    const { loginAs } = await import('../helpers/api.js');
    const sessao = await loginAs(ORG_A.owner);

    for (const rota of ['/admin/me', '/admin/metrics', '/admin/organizations']) {
      expect((await get(rota, sessao.accessToken)).statusCode, rota).toBe(401);
    }
  });

  it('token de admin não abre rota de cliente', async () => {
    const token = await entrarComoAdmin();

    for (const rota of ['/v1/forms', '/v1/organizations/current', '/v1/usage']) {
      expect((await get(rota, token)).statusCode, rota).toBe(401);
    }
  });

  it('sem token nenhum, 401', async () => {
    expect((await get('/admin/metrics')).statusCode).toBe(401);
  });
});

describe('o admin lê agregado, não conteúdo', () => {
  it('as métricas são só números', async () => {
    const token = await entrarComoAdmin();
    const corpo = (await get('/admin/metrics', token)).json() as Record<string, unknown>;

    expect(corpo).toHaveProperty('mrrCents');
    expect(corpo).toHaveProperty('churnRate');
    expect(corpo).toHaveProperty('organizations');

    // Nenhum dado de cliente atravessa: os nomes das empresas do seed não
    // aparecem, e nem o conteúdo de resposta nenhuma.
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain(ORG_A.name);
    expect(texto).not.toContain('@');
  });

  it('a lista de empresas traz metadado e contagem, nunca conteúdo', async () => {
    const token = await entrarComoAdmin();

    // Busca em vez de confiar na primeira página: outras suítes criam empresas,
    // e a ordenação é por data de criação.
    const corpo = (
      await get(`/admin/organizations?search=${encodeURIComponent(ORG_A.name)}`, token)
    ).json() as { organizations: Array<Record<string, unknown>> };

    expect(corpo.organizations.length).toBeGreaterThanOrEqual(1);

    const alfa = corpo.organizations.find((org) => org['id'] === ORG_A.id);
    expect(alfa).toMatchObject({ name: ORG_A.name, planCode: expect.any(String) });
    expect(alfa).toHaveProperty('responsesCount');

    // Contagem sim; conteúdo não. Nenhuma chave carrega texto de resposta.
    expect(alfa).not.toHaveProperty('responses');
    expect(alfa).not.toHaveProperty('forms');
  });

  it('o detalhe não abre formulário nem resposta', async () => {
    const token = await entrarComoAdmin();
    const corpo = (await get(`/admin/organizations/${ORG_A.id}`, token)).json() as {
      organization: Record<string, unknown>;
    };

    expect(corpo.organization).toMatchObject({ id: ORG_A.id, name: ORG_A.name });
    // O e-mail do owner é o único dado pessoal, e existe para o suporte
    // responder a quem abriu o chamado.
    expect(corpo.organization['ownerEmail']).toBe(ORG_A.owner);

    expect(corpo.organization).not.toHaveProperty('formsList');
    expect(corpo.organization).not.toHaveProperty('responsesList');
  });

  it('não existe rota de admin que devolva resposta de cliente', async () => {
    const token = await entrarComoAdmin();

    const idDaResposta = await withTenant(ORG_A.id, async ({ tx }) => {
      const resposta = await tx.response.findFirstOrThrow({ select: { id: true } });
      return resposta.id;
    });

    // Nenhuma destas existe, e é de propósito.
    for (const rota of [
      `/admin/responses/${idDaResposta}`,
      `/admin/organizations/${ORG_A.id}/responses`,
      `/admin/organizations/${ORG_A.id}/forms`,
    ]) {
      expect((await get(rota, token)).statusCode, rota).toBe(404);
    }
  });
});

describe('ações sobre a conta do cliente', () => {
  it('exigem motivo', async () => {
    const token = await entrarComoAdmin();

    const semMotivo = await patch(
      `/admin/organizations/${ORG_B.id}/status`,
      { status: 'suspended' },
      token,
    );

    expect(semMotivo.statusCode).toBe(422);
  });

  it('registram nos DOIS lados', async () => {
    const token = await entrarComoAdmin();

    const antes = await withTenant(ORG_B.id, async ({ tx }) => {
      const org = await tx.organization.findFirstOrThrow({ select: { subscriptionStatus: true } });
      return org.subscriptionStatus;
    });

    try {
      const resposta = await patch(
        `/admin/organizations/${ORG_B.id}/status`,
        { status: 'suspended', reason: 'Teste de isolamento da suíte' },
        token,
      );

      expect(resposta.statusCode).toBe(200);

      // Do nosso lado: quem fez, em qual empresa, por quê.
      const nossa = await prisma.adminAction.findFirst({
        where: { action: 'organization.status_changed', organizationId: ORG_B.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(nossa).toBeTruthy();
      expect(nossa!.metadataJson).toMatchObject({ to: 'suspended', reason: 'Teste de isolamento da suíte' });

      // Do lado do CLIENTE: ele tem direito de ver no próprio painel que a
      // conta foi suspensa por nós, e quando.
      const dele = await withTenant(ORG_B.id, ({ tx }) =>
        tx.auditLog.findFirst({
          where: { action: 'organization.status_changed_by_platform' },
          orderBy: { createdAt: 'desc' },
        }),
      );

      expect(dele).toBeTruthy();
    } finally {
      await withTenant(ORG_B.id, ({ tx }) =>
        tx.organization.update({ where: { id: ORG_B.id }, data: { subscriptionStatus: antes } }),
      );
    }
  });

  it('recusam plano inventado', async () => {
    const token = await entrarComoAdmin();

    const resposta = await patch(
      `/admin/organizations/${ORG_B.id}/plan`,
      { planCode: 'plano-de-ouro-infinito', reason: 'Teste da suíte' },
      token,
    );

    // Um plano inexistente gravado aqui quebraria enforcement, cobrança e
    // telas de uma vez.
    expect(resposta.statusCode).toBeGreaterThanOrEqual(400);

    const gravado = await withTenant(ORG_B.id, async ({ tx }) => {
      const org = await tx.organization.findFirstOrThrow({ select: { planCode: true } });
      return org.planCode;
    });

    expect(gravado).not.toBe('plano-de-ouro-infinito');
  });
});

describe('impersonação', () => {
  it('exige motivo e devolve um token curto', async () => {
    const token = await entrarComoAdmin();

    expect((await post(`/admin/organizations/${ORG_A.id}/impersonate`, {}, token)).statusCode).toBe(422);

    const resposta = await post(
      `/admin/organizations/${ORG_A.id}/impersonate`,
      { reason: 'Cliente relatou que não vê o formulário' },
      token,
    );

    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json() as { token: string; expiresInSeconds: number; actingAs: string };

    expect(corpo.expiresInSeconds).toBeLessThanOrEqual(15 * 60);
    expect(corpo.actingAs).toBe(ORG_A.owner);
  });

  it('registra nos dois lados ANTES de emitir o token', async () => {
    const token = await entrarComoAdmin();

    await post(
      `/admin/organizations/${ORG_A.id}/impersonate`,
      { reason: 'Verificando um chamado de suporte' },
      token,
    );

    const nossa = await prisma.adminAction.findFirst({
      where: { action: 'organization.impersonated', organizationId: ORG_A.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(nossa!.metadataJson).toMatchObject({ reason: 'Verificando um chamado de suporte' });

    // E o cliente vê no painel dele, sem precisar pedir.
    const dele = await withTenant(ORG_A.id, ({ tx }) =>
      tx.auditLog.findFirst({
        where: { action: 'platform.impersonation_started' },
        orderBy: { createdAt: 'desc' },
      }),
    );

    expect(dele).toBeTruthy();
    expect(dele!.metadataJson).toMatchObject({ adminEmail: ADMIN_EMAIL });
  });

  it('o token entra na conta certa e a tela sabe que é impersonação', async () => {
    const token = await entrarComoAdmin();

    const { token: comoCliente } = (
      await post(`/admin/organizations/${ORG_A.id}/impersonate`, { reason: 'Chamado 123 do suporte' }, token)
    ).json() as { token: string };

    const atual = await get('/v1/organizations/current', comoCliente);

    expect(atual.statusCode).toBe(200);
    const corpo = atual.json() as { id: string; impersonation: { adminEmail: string } | null };

    expect(corpo.id).toBe(ORG_A.id);
    // O banner permanente sai do SERVIDOR. Um banner que a tela pode escolher
    // não desenhar não é garantia nenhuma.
    expect(corpo.impersonation).toMatchObject({ adminEmail: ADMIN_EMAIL });
  });

  it('é SOMENTE LEITURA', async () => {
    // Aperto deliberado além do que a seção 5.5 pede. O caso de uso é suporte,
    // e ver não precisa de escrita. Escrever sob impersonação é um operador
    // nosso alterando dado do cliente com o registro dizendo que foi o cliente.
    const token = await entrarComoAdmin();

    const { token: comoCliente } = (
      await post(`/admin/organizations/${ORG_A.id}/impersonate`, { reason: 'Chamado 456' }, token)
    ).json() as { token: string };

    // Leitura passa.
    expect((await get('/v1/forms', comoCliente)).statusCode).toBe(200);

    // Escrita, não.
    const criar = await post('/v1/forms', { title: 'Formulário criado pelo admin' }, comoCliente);
    expect(criar.statusCode).toBe(403);
    expect(criar.body).toContain('somente leitura');

    const alterar = await patch(`/v1/branding`, { primaryColor: '#000000' }, comoCliente);
    expect(alterar.statusCode).toBe(403);
  });

  it('não alcança a outra empresa', async () => {
    // O token é de uma organização só. Impersonar a Alfa não abre a Beta.
    const token = await entrarComoAdmin();

    const { token: comoAlfa } = (
      await post(`/admin/organizations/${ORG_A.id}/impersonate`, { reason: 'Chamado 789' }, token)
    ).json() as { token: string };

    const daBeta = await withTenant(ORG_B.id, async ({ tx }) => {
      const form = await tx.form.findFirstOrThrow({ select: { id: true } });
      return form.id;
    });

    const resposta = await get(`/v1/forms/${daBeta}`, comoAlfa);
    expect(resposta.statusCode).toBe(404);
  });
});

describe('a trilha do admin não pode ser apagada pela aplicação', () => {
  it('o papel da aplicação não tem UPDATE nem DELETE em admin_actions', async () => {
    // Trilha que o próprio operador pode editar não é trilha.
    const linhas = await prisma.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE n.nspname = 'public' AND c.relname = 'admin_actions' AND grantee.rolname = 'app_runtime'
    `;

    const privilegios = new Set(linhas.map((linha) => linha.privilege_type));

    expect(privilegios.has('SELECT')).toBe(true);
    expect(privilegios.has('INSERT')).toBe(true);
    expect(privilegios.has('UPDATE')).toBe(false);
    expect(privilegios.has('DELETE')).toBe(false);
  });
});
