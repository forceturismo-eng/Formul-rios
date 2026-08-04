#!/usr/bin/env node
/**
 * Roda um comando com DATABASE_URL apontando para o papel de MIGRATION.
 *
 * O papel de runtime (`app_runtime`) não é dono das tabelas e sofre RLS — ele
 * não consegue nem deve rodar migrations. Manter os dois papéis separados é o
 * que garante que uma falha na aplicação não vire um `DROP TABLE`.
 *
 *   node scripts/with-migrate-url.mjs prisma migrate deploy
 */
import { spawn } from 'node:child_process';
import { loadEnv } from './load-env.mjs';

const env = loadEnv();

const migrateUrl = env.MIGRATE_DATABASE_URL;
if (!migrateUrl) {
  console.error('MIGRATE_DATABASE_URL não definida. Copie .env.example para .env.');
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Uso: node scripts/with-migrate-url.mjs <comando> [args...]');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, ...env, DATABASE_URL: migrateUrl },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
