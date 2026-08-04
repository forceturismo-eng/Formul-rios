import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Camada 3 do isolamento: contexto de tenant dentro da transação.
 *
 * Toda leitura e escrita de dados de negócio acontece dentro de `withTenant`.
 * Ele abre uma transação, grava `app.current_org_id` NELA (`set_config` com
 * `is_local = true`, que o Postgres descarta no commit/rollback) e só então
 * roda o trabalho.
 *
 * Duas propriedades importam:
 *
 *  1. O `SET LOCAL` e as queries estão na MESMA conexão e na MESMA transação.
 *     Um `SET` fora da transação vazaria para o próximo request que pegasse
 *     aquela conexão do pool — que é exatamente o bug que o RLS deveria evitar.
 *
 *  2. O `organizationId` vem sempre do token verificado. Nunca de body, query,
 *     header ou path. Este arquivo é o único ponto do sistema que escreve essa
 *     variável, e ele não tem como saber de onde veio o valor — por isso a
 *     regra vive no plugin de autenticação, e este módulo só recebe pronto.
 */

/** Cliente já amarrado a uma organização. */
export interface TenantContext {
  readonly organizationId: string;
  readonly tx: Prisma.TransactionClient;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label = 'organizationId'): void {
  if (!UUID_RE.test(value)) throw new Error(`${label} não é um UUID válido.`);
}

export interface WithTenantOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

export async function withTenant<T>(
  organizationId: string,
  fn: (ctx: TenantContext) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  // Validado antes de chegar ao banco: `set_config` aceita qualquer string, e
  // um valor torto só falharia mais tarde, no cast dentro da política.
  assertUuid(organizationId);

  return prisma.$transaction(
    async (tx) => {
      await setOrgId(tx, organizationId);
      return fn({ organizationId, tx });
    },
    { timeout: options.timeoutMs ?? 15_000, maxWait: options.maxWaitMs ?? 5_000 },
  );
}

/**
 * Transação SEM contexto de tenant.
 *
 * Serve para as tabelas globais (users, tokens de verificação) e para as
 * funções de bootstrap. Qualquer tabela com RLS acessada aqui devolve ZERO
 * linhas — o que é o comportamento correto e está coberto por teste.
 *
 * Se você precisou disto para ler dado de negócio, o desenho está errado.
 */
export async function withoutTenant<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  return prisma.$transaction(fn, {
    timeout: options.timeoutMs ?? 15_000,
    maxWait: options.maxWaitMs ?? 5_000,
  });
}

/**
 * Troca o tenant no meio de uma transação já aberta.
 *
 * Único uso legítimo: fluxos de bootstrap que descobrem a organização depois de
 * abrir a transação (aceitar convite, rotacionar refresh token). Fora disso,
 * use `withTenant`.
 */
export async function setOrgId(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  assertUuid(organizationId);
  await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}::text, true)`;
}

/** Lê o contexto vigente. Existe para os testes conseguirem provar o estado. */
export async function currentOrgId(tx: Prisma.TransactionClient): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ org_id: string | null }>>`SELECT app_current_org_id()::text AS org_id`;
  return rows[0]?.org_id ?? null;
}
