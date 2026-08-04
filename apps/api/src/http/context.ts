import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role, Subject } from '@forms/shared';
import { isAppHost } from '../config/env.js';
import { findMembership } from '../db/bootstrap.js';
import { withoutTenant, withTenant, type TenantContext } from '../db/tenant.js';
import { verifyAccessToken, InvalidTokenError } from '../auth/tokens.js';
import { hashIdentifier } from '../auth/hashing.js';
import { AppError, notFound, unauthorized } from './errors.js';

/**
 * Contexto autenticado de um request.
 *
 * `organizationId` vem SEMPRE do access token verificado, revalidado contra a
 * membership no banco. Não existe caminho no código que leia o tenant de body,
 * query, header (inclusive `Host`) ou path.
 */
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  membershipId: string;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * Domínio de cliente não serve rota autenticada (seção 8.1).
 *
 * Responde 404, não 403: para quem chega pelo domínio do cliente, o painel
 * simplesmente não existe. E como a checagem é por `Host`, um `Host` forjado
 * só consegue tirar acesso de si mesmo — nunca ganhar o de outro tenant, já
 * que o tenant sai do token e não do header.
 */
export async function requireAppHost(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!isAppHost(request.headers.host)) {
    request.log.warn({ host: request.headers.host }, 'rota de aplicação acessada por host não autorizado');
    throw notFound();
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * preHandler padrão das rotas autenticadas.
 *
 * Revalida a membership no banco a cada request, de propósito. O token dura 15
 * minutos; sem a revalidação, alguém removido da empresa continuaria dentro
 * desses 15 minutos, com o papel antigo. Quando isso pesar, o caminho é cachear
 * a membership no Redis com invalidação na remoção — não confiar no claim.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAppHost(request, reply);

  const token = bearerToken(request);
  if (!token) throw unauthorized();

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch (error) {
    if (error instanceof InvalidTokenError) throw unauthorized('Sessão inválida ou expirada.');
    throw error;
  }

  const membership = await withoutTenant((tx) => findMembership(tx, claims.sub, claims.org));
  if (!membership || !membership.acceptedAt) throw unauthorized('Sessão inválida ou expirada.');

  request.auth = {
    userId: claims.sub,
    organizationId: claims.org,
    // O papel vem do banco, não do token: promoção e rebaixamento valem na hora.
    role: membership.role,
    membershipId: claims.mid,
    emailVerified: claims.ev,
  };
}

/** Rotas que mexem em dado real exigem e-mail verificado. */
export async function requireVerifiedEmail(request: FastifyRequest): Promise<void> {
  const auth = getAuth(request);
  if (!auth.emailVerified) {
    throw new AppError('email_not_verified', 'Confirme seu e-mail para continuar. Reenviamos o link se precisar.');
  }
}

export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function subjectOf(request: FastifyRequest): Subject {
  const auth = getAuth(request);
  return { userId: auth.userId, organizationId: auth.organizationId, role: auth.role };
}

/** Abre uma transação já amarrada ao tenant do request. */
export function withRequestTenant<T>(request: FastifyRequest, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  return withTenant(getAuth(request).organizationId, fn);
}

export function requestIpHash(request: FastifyRequest): string | null {
  return hashIdentifier(request.ip);
}

export function requestUserAgentHash(request: FastifyRequest): string | null {
  return hashIdentifier(request.headers['user-agent']);
}
