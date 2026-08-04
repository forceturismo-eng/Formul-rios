import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { slugify } from '@forms/shared';
import { closeApp, get, getApp, post } from '../helpers/api.js';
import { ORG_A, SEED_PASSWORD } from '../helpers/orgs.js';
import { clearOutbox, findLastEmailTo } from '../../apps/api/src/mail/mailer.js';
import { withTenant, withoutTenant } from '../../apps/api/src/db/tenant.js';

/**
 * Fluxo de autenticação de ponta a ponta.
 *
 * O caso mais importante do arquivo é o de reuso de refresh token: ele é o que
 * transforma "o cookie vazou" em "a sessão inteira caiu" em vez de "o atacante
 * ficou dentro por trinta dias".
 */

const HOST = 'localhost';

function novoEmail(): string {
  return `teste-${randomUUID()}@exemplo.test`;
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  return value.split(';')[0] ?? '';
}

beforeEach(() => {
  clearOutbox();
});

afterAll(closeApp);

describe('registro', () => {
  it('cria empresa, owner e sessão de uma vez', async () => {
    const email = novoEmail();
    // Nome único: a suíte roda contra um banco que persiste entre execuções, e
    // um nome fixo passaria a colidir consigo mesmo na segunda rodada.
    const nomeEmpresa = `Padaria do Bairro ${randomUUID().slice(0, 8)}`;

    const response = await post('/v1/auth/register', {
      name: 'Maria Fundadora',
      email,
      password: 'senha-forte-2026',
      organizationName: nomeEmpresa,
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      accessToken: string;
      user: { id: string; emailVerified: boolean };
      organization: { id: string; name: string; slug: string; role: string };
    };

    expect(body.accessToken).toBeTruthy();
    expect(body.organization.name).toBe(nomeEmpresa);
    expect(body.organization.slug).toBe(slugify(nomeEmpresa));
    expect(body.organization.role).toBe('owner');
    // Quem registra ainda não confirmou o e-mail.
    expect(body.user.emailVerified).toBe(false);

    // A empresa nasce isolada: o contexto dela enxerga uma organização só.
    const orgs = await withTenant(body.organization.id, ({ tx }) => tx.organization.findMany({ select: { id: true } }));
    expect(orgs.map((o) => o.id)).toEqual([body.organization.id]);
  });

  it('emite o cookie de refresh como httpOnly', async () => {
    const response = await post('/v1/auth/register', {
      name: 'João Teste',
      email: novoEmail(),
      password: 'senha-forte-2026',
      organizationName: 'Empresa Cookie',
    });

    const raw = response.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw.join(';') : String(raw);

    expect(cookie).toContain('fx_rt=');
    expect(cookie).toContain('HttpOnly');
    // O refresh só é enviado nas rotas de auth — nenhuma outra rota o recebe.
    expect(cookie).toContain('Path=/v1/auth');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('manda o e-mail de confirmação', async () => {
    const email = novoEmail();
    await post('/v1/auth/register', {
      name: 'Ana Verificação',
      email,
      password: 'senha-forte-2026',
      organizationName: 'Empresa Verifica',
    });

    const mensagem = findLastEmailTo(email);
    expect(mensagem).toBeDefined();
    expect(mensagem!.subject).toContain('Confirme seu e-mail');
    expect(mensagem!.text).toContain('/verificar-email?token=');
  });

  it('confirma o e-mail com o token recebido', async () => {
    const email = novoEmail();
    await post('/v1/auth/register', {
      name: 'Rita Confirmada',
      email,
      password: 'senha-forte-2026',
      organizationName: 'Empresa Confirma',
    });

    const mensagem = findLastEmailTo(email)!;
    const token = /token=([^\s]+)/.exec(mensagem.text)?.[1];
    expect(token).toBeTruthy();

    const primeira = await post('/v1/auth/verify-email', { token: decodeURIComponent(token!) });
    expect(primeira.statusCode).toBe(204);

    const usuario = await withoutTenant((tx) => tx.user.findUnique({ where: { email } }));
    expect(usuario?.emailVerifiedAt).not.toBeNull();

    // Token de uso único: a segunda tentativa não passa.
    const segunda = await post('/v1/auth/verify-email', { token: decodeURIComponent(token!) });
    expect(segunda.statusCode).toBe(422);
  });

  it('recusa senha que aparece em vazamentos', async () => {
    const response = await post('/v1/auth/register', {
      name: 'Pedro Fraco',
      email: novoEmail(),
      password: 'senha123456',
      organizationName: 'Empresa Fraca',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('recusa senha curta e sem número', async () => {
    for (const password of ['curta1', 'somenteletrasaqui']) {
      const response = await post('/v1/auth/register', {
        name: 'Teste Senha',
        email: novoEmail(),
        password,
        organizationName: 'Empresa Senha',
      });
      expect(response.statusCode, password).toBe(422);
    }
  });

  it('não cria duas contas com o mesmo e-mail', async () => {
    const email = novoEmail();
    const payload = {
      name: 'Duplicado',
      email,
      password: 'senha-forte-2026',
      organizationName: 'Primeira Empresa',
    };

    expect((await post('/v1/auth/register', payload)).statusCode).toBe(201);

    const segunda = await post('/v1/auth/register', { ...payload, organizationName: 'Segunda Empresa' });
    expect(segunda.statusCode).toBe(409);
  });

  it('desempata slug de empresas com o mesmo nome', async () => {
    const nome = `Empresa Colisao ${randomUUID().slice(0, 8)}`;

    const primeira = await post('/v1/auth/register', {
      name: 'Um',
      email: novoEmail(),
      password: 'senha-forte-2026',
      organizationName: nome,
    });
    const segunda = await post('/v1/auth/register', {
      name: 'Dois',
      email: novoEmail(),
      password: 'senha-forte-2026',
      organizationName: nome,
    });

    expect(primeira.statusCode).toBe(201);
    expect(segunda.statusCode).toBe(201);

    const slugA = (primeira.json() as { organization: { slug: string } }).organization.slug;
    const slugB = (segunda.json() as { organization: { slug: string } }).organization.slug;
    expect(slugA).not.toBe(slugB);
  });
});

describe('login', () => {
  it('autentica com as credenciais do seed', async () => {
    const response = await post('/v1/auth/login', { email: ORG_A.owner, password: SEED_PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organization: { id: ORG_A.id, role: 'owner' } });
  });

  it('recusa senha errada', async () => {
    const response = await post('/v1/auth/login', { email: ORG_A.owner, password: 'senha-errada-2026' });
    expect(response.statusCode).toBe(401);
  });

  it('e-mail inexistente responde igual a senha errada', async () => {
    const inexistente = await post('/v1/auth/login', { email: novoEmail(), password: 'senha-forte-2026' });
    const senhaErrada = await post('/v1/auth/login', { email: ORG_A.owner, password: 'outra-senha-2026' });

    // Mensagens idênticas: esta rota não pode dizer se a conta existe.
    expect(inexistente.statusCode).toBe(senhaErrada.statusCode);
    expect(inexistente.json()).toEqual(senhaErrada.json());
  });

  it('organizationId de empresa alheia cai no fallback, não em acesso', async () => {
    const response = await post('/v1/auth/login', {
      email: ORG_A.owner,
      password: SEED_PASSWORD,
      organizationId: '22222222-2222-4222-8222-222222222222',
    });

    // Sem membership na empresa pedida, o login não entrega aquela empresa.
    expect(response.statusCode).toBe(401);
  });
});

describe('refresh rotativo', () => {
  async function sessaoNova() {
    const email = novoEmail();
    const registro = await post('/v1/auth/register', {
      name: 'Sessão Teste',
      email,
      password: 'senha-forte-2026',
      organizationName: `Empresa Sessao ${randomUUID().slice(0, 6)}`,
    });
    return { email, cookie: cookieFrom(registro.headers as Record<string, unknown>) };
  }

  it('troca o refresh por um novo a cada uso', async () => {
    const { cookie } = await sessaoNova();

    const primeiro = await post('/v1/auth/refresh', {}, { cookie });
    expect(primeiro.statusCode).toBe(200);

    const novoCookie = cookieFrom(primeiro.headers as Record<string, unknown>);
    expect(novoCookie).not.toBe(cookie);

    const segundo = await post('/v1/auth/refresh', {}, { cookie: novoCookie });
    expect(segundo.statusCode).toBe(200);
  });

  it('reapresentar um token já usado derruba a família inteira', async () => {
    const { cookie } = await sessaoNova();

    const rotacao = await post('/v1/auth/refresh', {}, { cookie });
    const cookieAtual = cookieFrom(rotacao.headers as Record<string, unknown>);

    // O token antigo volta: ou vazou, ou é replay. Nos dois casos, cai tudo.
    const reuso = await post('/v1/auth/refresh', {}, { cookie });
    expect(reuso.statusCode).toBe(401);

    // E o token que era válido também deixa de valer.
    const depois = await post('/v1/auth/refresh', {}, { cookie: cookieAtual });
    expect(depois.statusCode).toBe(401);
  });

  it('refresh sem cookie responde 401', async () => {
    const response = await post('/v1/auth/refresh', {});
    expect(response.statusCode).toBe(401);
  });

  it('logout revoga a sessão', async () => {
    const { cookie } = await sessaoNova();

    expect((await post('/v1/auth/logout', {}, { cookie })).statusCode).toBe(204);
    expect((await post('/v1/auth/refresh', {}, { cookie })).statusCode).toBe(401);
  });
});

describe('rate limit do login', () => {
  it('bloqueia depois de cinco tentativas', async () => {
    const app = await getApp();
    const email = novoEmail();

    const codigos: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { host: HOST, 'x-forwarded-for': '203.0.113.77' },
        payload: { email, password: `tentativa-errada-${i}` },
      });
      codigos.push(response.statusCode);
    }

    expect(codigos.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe('rotas públicas', () => {
  it('GET /v1/plans não exige autenticação', async () => {
    const response = await get('/v1/plans');
    expect(response.statusCode).toBe(200);

    const body = response.json() as { plans: Array<{ code: string }> };
    expect(body.plans.map((p) => p.code)).toContain('pro');
  });

  it('reenvio de confirmação responde 202 mesmo para e-mail inexistente', async () => {
    const response = await post('/v1/auth/resend-verification', { email: novoEmail() });
    expect(response.statusCode).toBe(202);
  });
});
