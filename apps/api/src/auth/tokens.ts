import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@forms/shared';
import { env } from '../config/env.js';

/**
 * Access token: JWT curto (15 min), assinado com HS256.
 *
 * O `organizationId` viaja DENTRO do token assinado e é a única origem aceita
 * para o tenant de um request. Body, query, header e path são ignorados para
 * esse fim — é isso que faz "adulterar o payload" virar assinatura inválida em
 * vez de acesso a outra empresa.
 *
 * Access e refresh usam segredos diferentes: um access token não pode ser
 * reapresentado como refresh e vice-versa, nem por confusão de código nem por
 * um atacante que consiga um dos dois.
 */

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

const ALG = 'HS256';

export interface AccessTokenClaims {
  /** userId */
  sub: string;
  /** organizationId — o tenant do request. */
  org: string;
  role: Role;
  /** id da membership, para auditoria. */
  mid: string;
  /** e-mail verificado? Evita uma ida ao banco em rotas que só precisam disso. */
  ev: boolean;
  jti: string;
}

export async function signAccessToken(claims: Omit<AccessTokenClaims, 'jti'>): Promise<string> {
  return new SignJWT({ org: claims.org, role: claims.role, mid: claims.mid, ev: claims.ev })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
}

export class InvalidTokenError extends Error {
  constructor(message = 'Token inválido.') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const VALID_ROLES = new Set<string>(['owner', 'admin', 'editor', 'viewer']);

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, accessSecret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      // Aceitar apenas HS256 fecha a porta do "alg: none" e da confusão de algoritmo.
      algorithms: [ALG],
    });
    payload = result.payload;
  } catch {
    throw new InvalidTokenError();
  }

  // Assinatura válida não garante formato válido — um token emitido por uma
  // versão antiga do código pode não ter os claims que esperamos hoje.
  if (!isUuid(payload.sub) || !isUuid(payload.org) || !isUuid(payload.mid)) throw new InvalidTokenError();
  if (typeof payload.role !== 'string' || !VALID_ROLES.has(payload.role)) throw new InvalidTokenError();
  if (typeof payload.jti !== 'string') throw new InvalidTokenError();

  return {
    sub: payload.sub,
    org: payload.org,
    role: payload.role as Role,
    mid: payload.mid,
    ev: payload.ev === true,
    jti: payload.jti,
  };
}

/**
 * Refresh token.
 *
 * É um JWT para carregar `familyId` sem uma ida ao banco, mas o que vale é a
 * linha em `refresh_tokens`: o banco é quem sabe se o token foi revogado,
 * rotacionado ou reusado. Assinatura válida com linha revogada = reuso.
 */
export interface RefreshTokenClaims {
  sub: string;
  org: string;
  fam: string;
  jti: string;
}

export async function signRefreshToken(claims: Omit<RefreshTokenClaims, 'jti'>): Promise<{
  token: string;
  jti: string;
  expiresAt: Date;
}> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const token = await new SignJWT({ org: claims.org, fam: claims.fam })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(refreshSecret);

  return { token, jti, expiresAt };
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, refreshSecret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: [ALG],
    });
    payload = result.payload;
  } catch {
    throw new InvalidTokenError();
  }

  if (!isUuid(payload.sub) || !isUuid(payload.org) || !isUuid(payload.fam)) throw new InvalidTokenError();
  if (typeof payload.jti !== 'string') throw new InvalidTokenError();

  return { sub: payload.sub, org: payload.org, fam: payload.fam, jti: payload.jti };
}

export const REFRESH_COOKIE_NAME = 'fx_rt';

export function refreshCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // `strict` bloquearia o retorno de fluxos externos (link de e-mail, checkout).
    // `lax` mantém o cookie fora de requests cross-site que não sejam navegação.
    sameSite: 'lax' as const,
    path: '/v1/auth',
    domain: env.COOKIE_DOMAIN,
    maxAge: maxAgeSeconds,
  };
}
