import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { disconnectPrisma } from '../../apps/api/src/db/prisma.js';
import { SEED_PASSWORD } from './orgs.js';

/**
 * Sobe a MESMA aplicação que roda em produção, sem abrir porta.
 *
 * Nada é substituído por mock: os testes de isolamento passam pelo Fastify
 * real, pelos plugins reais, pelo Prisma real e pelo Postgres real com RLS
 * ligado. Um teste de isolamento com banco falso não prova isolamento nenhum.
 */

let appPromise: Promise<FastifyInstance> | null = null;

export function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp();
  return appPromise;
}

export async function closeApp(): Promise<void> {
  if (appPromise) {
    const app = await appPromise;
    await app.close();
    appPromise = null;
  }
  await disconnectPrisma();
}

/** Host padrão dos testes: o domínio da aplicação. */
export const APP_HOST = 'localhost';

export interface Session {
  accessToken: string;
  refreshCookie: string;
  organizationId: string;
  userId: string;
}

// O login tem rate limit de 5 tentativas por 15 minutos, por IP — e nos testes
// todos os requests vêm do mesmo IP. Memorizar a sessão por e-mail evita que a
// suíte esbarre no próprio controle de segurança que ela deveria respeitar.
const sessions = new Map<string, Session>();

export async function loginAs(email: string, organizationId?: string): Promise<Session> {
  const cacheKey = `${email}::${organizationId ?? 'default'}`;
  const cached = sessions.get(cacheKey);
  if (cached) return cached;

  const app = await getApp();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { host: APP_HOST },
    payload: { email, password: SEED_PASSWORD, ...(organizationId ? { organizationId } : {}) },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Login falhou para ${email}: ${response.statusCode} ${response.body}`);
  }

  const body = response.json() as {
    accessToken: string;
    user: { id: string };
    organization: { id: string };
  };

  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '');

  const session: Session = {
    accessToken: body.accessToken,
    refreshCookie: cookieHeader.split(';')[0] ?? '',
    organizationId: body.organization.id,
    userId: body.user.id,
  };

  sessions.set(cacheKey, session);
  return session;
}

export function clearSessionCache(): void {
  sessions.clear();
}

export interface GetOptions {
  token?: string;
  host?: string;
  cookie?: string;
}

export async function get(url: string, options: GetOptions = {}) {
  const app = await getApp();
  return app.inject({
    method: 'GET',
    url,
    headers: {
      host: options.host ?? APP_HOST,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
  });
}

export async function post(url: string, payload: unknown, options: GetOptions = {}) {
  const app = await getApp();
  return app.inject({
    method: 'POST',
    url,
    headers: {
      host: options.host ?? APP_HOST,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    payload: payload as never,
  });
}
