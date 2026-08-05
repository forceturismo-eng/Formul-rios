import { randomBytes } from 'node:crypto';
import { getPlan, type PlanCode, type Subject } from '@forms/shared';
import type { TenantContext } from '../db/tenant.js';
import { apiKeysRepository, auditLogsRepository } from '../db/repositories.js';
import { hashToken } from '../auth/hashing.js';
import { AppError, notFound, validationError } from '../http/errors.js';
import { assertCanCreateApiKey } from './usage-service.js';

/**
 * Chaves da API pública.
 *
 * A chave é mostrada UMA vez, na criação. O banco guarda só o hash — pelo mesmo
 * motivo de uma senha: um dump do banco não pode virar acesso à API dos
 * clientes.
 *
 * O `prefix` existe para o usuário reconhecer a chave na lista sem que
 * precisemos guardá-la. É o começo dela, e não serve para autenticar.
 */

export const API_SCOPES = [
  'forms:read',
  'forms:write',
  'responses:read',
  'responses:write',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Prefixo visível: `fx_live_` mais oito caracteres. */
const PREFIXO = 'fx_live_';

export async function createApiKey(
  ctx: TenantContext,
  subject: Subject,
  entrada: { name: string; scopes: string[]; expiresAt?: Date },
) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });
  const plano = getPlan(organizacao.planCode as PlanCode);

  if (!plano.features.apiAccess) {
    throw new AppError('quota_exceeded', 'A API pública faz parte do plano Pro.', {
      extra: { upgradeUrl: '/planos' },
    });
  }

  await assertCanCreateApiKey(ctx);

  const invalidos = entrada.scopes.filter((escopo) => !API_SCOPES.includes(escopo as ApiScope));
  if (invalidos.length > 0) {
    throw validationError({ scopes: [`Escopo desconhecido: ${invalidos.join(', ')}.`] });
  }
  if (entrada.scopes.length === 0) {
    // Chave sem escopo não abre nada; melhor recusar do que criar algo inútil.
    throw validationError({ scopes: ['Escolha pelo menos um escopo.'] });
  }

  const segredo = `${PREFIXO}${randomBytes(24).toString('hex')}`;

  const chave = await apiKeysRepository.create(ctx, {
    name: entrada.name.trim(),
    keyHash: hashToken(segredo),
    prefix: segredo.slice(0, PREFIXO.length + 8),
    scopes: entrada.scopes,
    ...(entrada.expiresAt ? { expiresAt: entrada.expiresAt } : {}),
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: chave.id,
    metadataJson: { name: chave.name, scopes: entrada.scopes },
  });

  // O segredo em claro existe nesta variável e na resposta HTTP. Nunca mais.
  return { apiKey: chave, secret: segredo };
}

export async function listApiKeys(ctx: TenantContext) {
  const chaves = await ctx.tx.apiKey.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return chaves.map((chave) => ({
    id: chave.id,
    name: chave.name,
    // O prefixo identifica a chave na lista; o resto o cliente guardou.
    prefix: `${chave.prefix}…`,
    scopes: chave.scopes,
    lastUsedAt: chave.lastUsedAt,
    expiresAt: chave.expiresAt,
    revokedAt: chave.revokedAt,
    createdAt: chave.createdAt,
  }));
}

export async function revokeApiKey(ctx: TenantContext, subject: Subject, keyId: string) {
  const chave = await apiKeysRepository.findById(ctx, keyId);
  if (!chave) throw notFound();

  // Revoga, não apaga: o audit log referencia a chave, e saber que ela existiu
  // importa numa investigação.
  const revogada = await ctx.tx.apiKey.update({
    where: { id: chave.id, organizationId: ctx.organizationId },
    data: { revokedAt: new Date() },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: keyId,
    metadataJson: { name: chave.name },
  });

  return revogada;
}

export interface ApiKeyContext {
  organizationId: string;
  apiKeyId: string;
  scopes: string[];
}

/** `true` quando a chave cobre o escopo pedido. */
export function hasScope(contexto: ApiKeyContext, escopo: ApiScope): boolean {
  return contexto.scopes.includes(escopo);
}
