import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');

/**
 * Carrega `.env` da raiz do monorepo, com fallback para `.env.example`.
 *
 * O fallback existe para que `npm test` funcione num clone limpo sem que
 * ninguém precise copiar arquivo à mão. Ele nunca sobrepõe variáveis já
 * presentes no ambiente — em produção quem manda é o ambiente.
 */
export function loadEnv() {
  const envPath = resolve(repoRoot, '.env');
  const examplePath = resolve(repoRoot, '.env.example');
  const source = existsSync(envPath) ? envPath : examplePath;

  const parsed = dotenv.parse(readFileSync(source));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { ...parsed, ...process.env };
}
