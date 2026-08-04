import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Cliente Prisma único do processo.
 *
 * Conecta com `DATABASE_URL`, que aponta para `app_runtime` — papel sem
 * BYPASSRLS. Se alguém trocar essa URL pelo papel de migration, o isolamento
 * continua valendo (as tabelas usam FORCE ROW LEVEL SECURITY), mas o processo
 * ganharia poder de DDL que não deveria ter.
 */
export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'debug' ? ['warn', 'error', 'query'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
