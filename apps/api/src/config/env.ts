import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { resolveBranding, normalizeHost } from '@forms/shared';

/**
 * Configuração validada uma vez, na subida do processo.
 *
 * Se falta variável ou o valor não faz sentido, o processo morre aqui — antes
 * de aceitar o primeiro request. Um servidor que sobe com JWT_ACCESS_SECRET
 * vazio é pior do que um servidor que não sobe.
 */

const repoRoot = resolve(process.cwd().includes('apps/api') ? '../..' : '.');

function loadDotEnv(): void {
  for (const file of ['.env', '.env.example']) {
    const path = resolve(repoRoot, file);
    if (!existsSync(path)) continue;
    const parsed = dotenv.parse(readFileSync(path));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    // O `.env` real tem precedência: se existe, não caímos no exemplo.
    if (file === '.env') return;
  }
}

loadDotEnv();

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PRODUCT_NAME: z.string().min(1).default('Formulários'),
  APP_DOMAIN: z.string().min(1),
  CNAME_DOMAIN: z.string().min(1),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),

  REDIS_URL: z.string().optional(),

  // 32 caracteres é o mínimo para um segredo HS256 não ser força-bruta de fim de semana.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET precisa de pelo menos 32 caracteres.'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET precisa de pelo menos 32 caracteres.'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  JWT_ISSUER: z.string().default('formularios'),
  JWT_AUDIENCE: z.string().default('formularios-app'),

  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  IP_HASH_SALT: z.string().min(16, 'IP_HASH_SALT precisa de pelo menos 16 caracteres.'),
  ENCRYPTION_MASTER_KEY: z.string().min(1),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Configuração inválida:\n${issues}`);
}

const raw = parsed.data;
const branding = resolveBranding(process.env);

if (raw.NODE_ENV === 'production') {
  for (const [key, value] of Object.entries({
    JWT_ACCESS_SECRET: raw.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: raw.JWT_REFRESH_SECRET,
    IP_HASH_SALT: raw.IP_HASH_SALT,
  })) {
    if (value.startsWith('troque-este')) {
      throw new Error(`${key} ainda está com o valor de exemplo. Gere um segredo antes de subir em produção.`);
    }
  }
  if (!raw.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE precisa ser true em produção.');
  }
}

/**
 * Hosts que servem rotas autenticadas.
 *
 * Só o domínio da aplicação. Domínio de cliente NUNCA serve painel, API
 * autenticada ou cookie de sessão (seção 8.1) — e quem garante isso é esta
 * lista, não a boa vontade de quem escreve a rota.
 *
 * Fora de produção, localhost entra na lista para o desenvolvimento e os testes
 * funcionarem sem editar /etc/hosts.
 */
const appHosts = new Set<string>([normalizeHost(raw.APP_DOMAIN)]);
if (raw.NODE_ENV !== 'production') {
  appHosts.add('localhost');
  appHosts.add('127.0.0.1');
  appHosts.add('[::1]');
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: csv(raw.CORS_ORIGINS),
  branding,
  appHosts,
} as const;

export type Env = typeof env;

/** `true` quando o header Host aponta para o domínio da aplicação. */
export function isAppHost(hostHeader: string | undefined): boolean {
  return env.appHosts.has(normalizeHost(hostHeader));
}
