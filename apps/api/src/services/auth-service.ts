import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { slugify, withRandomSuffix, isReservedSlug, type Role } from '@forms/shared';
import { withTenant, withoutTenant } from '../db/tenant.js';
import {
  listUserMemberships,
  resolveInvitationOrg,
  resolveRefreshTokenOrg,
  type MembershipSummary,
} from '../db/bootstrap.js';
import { auditLogsRepository, membershipsRepository, refreshTokensRepository } from '../db/repositories.js';
import {
  dummyPasswordVerify,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../auth/hashing.js';
import { isLeakedPassword } from '../auth/password-policy.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  InvalidTokenError,
  type RefreshTokenClaims,
} from '../auth/tokens.js';
import { sendMail, verificationEmail } from '../mail/mailer.js';
import { AppError, conflict, unauthorized, validationError } from '../http/errors.js';
import { env } from '../config/env.js';
import { verificarSegundoFator } from './mfa-service.js';

/**
 * Fluxos de autenticação.
 *
 * O ponto sensível deste arquivo é o refresh rotativo com detecção de reuso.
 * Vale ler o comentário sobre isso em `rotateRefreshToken` antes de mexer.
 */

const TRIAL_DAYS = 14;
/** O teste de 14 dias libera o conjunto de recursos do Pro (copy da seção 10). */
const TRIAL_PLAN_CODE = 'pro';
const EMAIL_VERIFICATION_TTL_HOURS = 24;

export interface SessionMeta {
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; name: string; email: string; emailVerified: boolean };
  organization: { id: string; name: string; slug: string; role: Role; planCode: string };
  memberships: MembershipSummary[];
}

// -----------------------------------------------------------------------------
// Registro
// -----------------------------------------------------------------------------

export interface RegisterParams {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  meta: SessionMeta;
}

export async function register(params: RegisterParams): Promise<IssuedSession> {
  const email = params.email.trim().toLowerCase();

  if (await isLeakedPassword(params.password)) {
    throw validationError({ password: ['Essa senha aparece em vazamentos conhecidos. Escolha outra.'] });
  }

  const existing = await withoutTenant((tx) => tx.user.findUnique({ where: { email }, select: { id: true } }));
  if (existing) {
    // Decisão consciente: dizemos que o e-mail já tem conta em vez de fingir
    // sucesso. Esconder isso quebra o cadastro de quem esqueceu que já se
    // registrou, e a enumeração continuaria possível pelo fluxo de convite.
    throw conflict('Esse e-mail já tem uma conta. Faça login ou recupere a senha.');
  }

  const passwordHash = await hashPassword(params.password);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  // O id da organização nasce aqui para que o contexto de tenant possa ser
  // setado ANTES do INSERT. Sem isso o `WITH CHECK` da política recusaria a
  // própria linha que está criando a empresa.
  const organizationId = randomUUID();

  const created = await createOrganizationWithOwner({
    organizationId,
    organizationName: params.organizationName,
    user: { name: params.name.trim(), email, passwordHash },
    trialEndsAt,
  });

  await sendVerificationEmail(created.userId, created.userName, email);

  return issueSession({
    userId: created.userId,
    organizationId,
    meta: params.meta,
    action: 'auth.register',
  });
}

interface CreateOrgParams {
  organizationId: string;
  organizationName: string;
  user: { name: string; email: string; passwordHash: string };
  trialEndsAt: Date;
}

async function createOrganizationWithOwner(params: CreateOrgParams): Promise<{ userId: string; userName: string }> {
  const base = slugify(params.organizationName) || 'empresa';
  let slug = isReservedSlug(base) ? withRandomSuffix(base) : base;

  // O RLS impede consultar slugs de outras empresas para checar colisão — e
  // deveria mesmo impedir. Então a unicidade é resolvida pelo índice único do
  // banco, com retentativa: é o único jeito honesto de fazer isso sob RLS.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await withTenant(params.organizationId, async (ctx) => {
        await ctx.tx.organization.create({
          data: {
            id: params.organizationId,
            name: params.organizationName.trim(),
            slug,
            planCode: TRIAL_PLAN_CODE,
            subscriptionStatus: 'trialing',
            trialEndsAt: params.trialEndsAt,
          },
        });

        const user = await ctx.tx.user.create({
          data: { name: params.user.name, email: params.user.email, passwordHash: params.user.passwordHash },
          select: { id: true, name: true },
        });

        await membershipsRepository.create(ctx, {
          userId: user.id,
          role: 'owner',
          acceptedAt: new Date(),
        });

        await auditLogsRepository.record(ctx, {
          actorUserId: user.id,
          action: 'organization.created',
          resourceType: 'organization',
          resourceId: params.organizationId,
          metadataJson: { slug },
        });

        return { userId: user.id, userName: user.name };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'User', 'email')) {
        throw conflict('Esse e-mail já tem uma conta. Faça login ou recupere a senha.');
      }
      if (isUniqueViolation(error, 'Organization', 'slug')) {
        slug = withRandomSuffix(base);
        continue;
      }
      throw error;
    }
  }

  throw new AppError('internal_error', 'Não conseguimos criar a empresa agora. Tente de novo.');
}

/**
 * Identifica QUAL índice único estourou.
 *
 * O Prisma nem sempre preenche `meta.target` — em várias violações ele reporta
 * apenas "Unique constraint failed on the (not available)". Por isso a
 * identificação é feita primeiro por `meta.modelName`, que vem preenchido, e
 * só cai no nome do campo quando o modelo não está disponível.
 *
 * Distinguir os dois casos importa: colisão de slug se resolve sozinha com
 * outro sufixo, e-mail duplicado precisa virar 409 para o usuário.
 */
function isUniqueViolation(error: unknown, model: string, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;

  const modelName = error.meta?.['modelName'];
  if (typeof modelName === 'string') return modelName === model;

  const target = error.meta?.['target'];
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((name) => name.includes(field));
}

// -----------------------------------------------------------------------------
// Verificação de e-mail
// -----------------------------------------------------------------------------

export async function sendVerificationEmail(userId: string, userName: string, email: string): Promise<void> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await withoutTenant((tx) =>
    tx.emailVerificationToken.create({ data: { userId, tokenHash: hashToken(token), expiresAt } }),
  );

  await sendMail(verificationEmail({ to: email, name: userName, token }));
}

export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = hashToken(token);

  const applied = await withoutTenant(async (tx) => {
    const row = await tx.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt || row.expiresAt < new Date()) return false;

    await tx.emailVerificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
    return true;
  });

  if (!applied) throw new AppError('validation_error', 'Esse link de confirmação expirou ou já foi usado.');
}

export async function resendVerification(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const user = await withoutTenant((tx) =>
    tx.user.findUnique({ where: { email: normalized }, select: { id: true, name: true, emailVerifiedAt: true } }),
  );

  // Silêncio de propósito: responder "esse e-mail não existe" transformaria
  // esta rota num enumerador de contas. Quem chamou recebe sempre 202.
  if (!user || user.emailVerifiedAt) return;

  await sendVerificationEmail(user.id, user.name, normalized);
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------

export interface LoginParams {
  email: string;
  password: string;
  organizationId?: string;
  /** Código do app autenticador OU código de recuperação, quando a conta tem MFA. */
  mfaCode?: string;
  meta: SessionMeta;
}

export async function login(params: LoginParams): Promise<IssuedSession> {
  const email = params.email.trim().toLowerCase();

  const user = await withoutTenant((tx) =>
    tx.user.findUnique({ where: { email }, select: { id: true, passwordHash: true, mfaEnabledAt: true } }),
  );

  // E-mail inexistente também paga o custo de um Argon2id, para que o tempo de
  // resposta não diga se a conta existe.
  const passwordOk = user ? await verifyPassword(user.passwordHash, params.password) : await dummyPasswordVerify(params.password);

  if (!user || !passwordOk) throw unauthorized('E-mail ou senha incorretos.');

  const memberships = await withoutTenant((tx) => listUserMemberships(tx, user.id));
  const accepted = memberships.filter((m) => m.acceptedAt !== null);
  if (accepted.length === 0) throw unauthorized('Sua conta não está vinculada a nenhuma empresa ativa.');

  // O `organizationId` pedido é só uma preferência: só vale se existir uma
  // membership aceita para ele. Um id de outra empresa cai no fallback, nunca
  // em acesso.
  const chosen = params.organizationId
    ? accepted.find((m) => m.organizationId === params.organizationId)
    : accepted[0];

  if (!chosen) throw unauthorized('E-mail ou senha incorretos.');

  // Segundo fator, quando a conta tem.
  //
  // Conferido DEPOIS da senha e das memberships: pedir o código antes de saber
  // que a senha está certa diria a quem tentou que a conta existe e tem MFA.
  if (user.mfaEnabledAt) {
    if (!params.mfaCode) {
      throw new AppError('mfa_required', 'Informe o código do seu aplicativo autenticador.');
    }
    await verificarSegundoFator(user.id, params.mfaCode);
  }

  await withoutTenant((tx) => tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }));

  return issueSession({
    userId: user.id,
    organizationId: chosen.organizationId,
    meta: params.meta,
    action: 'auth.login',
  });
}

/** Troca de workspace: reemite a sessão em outra empresa do mesmo usuário. */
export async function switchOrganization(params: {
  userId: string;
  organizationId: string;
  meta: SessionMeta;
}): Promise<IssuedSession> {
  const memberships = await withoutTenant((tx) => listUserMemberships(tx, params.userId));
  const target = memberships.find((m) => m.organizationId === params.organizationId && m.acceptedAt !== null);
  if (!target) throw unauthorized('Você não faz parte dessa empresa.');

  return issueSession({
    userId: params.userId,
    organizationId: params.organizationId,
    meta: params.meta,
    action: 'auth.switch_organization',
  });
}

// -----------------------------------------------------------------------------
// Emissão de sessão
// -----------------------------------------------------------------------------

async function issueSession(params: {
  userId: string;
  organizationId: string;
  meta: SessionMeta;
  action: string;
  familyId?: string;
}): Promise<IssuedSession> {
  const memberships = await withoutTenant((tx) => listUserMemberships(tx, params.userId));
  const membership = memberships.find((m) => m.organizationId === params.organizationId);
  if (!membership) throw unauthorized();

  const user = await withoutTenant((tx) =>
    tx.user.findUniqueOrThrow({
      where: { id: params.userId },
      select: { id: true, name: true, email: true, emailVerifiedAt: true },
    }),
  );

  const familyId = params.familyId ?? randomUUID();
  const refresh = await signRefreshToken({ sub: params.userId, org: params.organizationId, fam: familyId });

  const membershipRow = await withTenant(params.organizationId, async (ctx) => {
    const row = await membershipsRepository.findByUser(ctx, params.userId);
    if (!row) throw unauthorized();

    await refreshTokensRepository.create(ctx, {
      id: refresh.jti,
      userId: params.userId,
      tokenHash: hashToken(refresh.token),
      familyId,
      expiresAt: refresh.expiresAt,
      ipHash: params.meta.ipHash,
      userAgentHash: params.meta.userAgentHash,
    });

    await auditLogsRepository.record(ctx, {
      actorUserId: params.userId,
      action: params.action,
      resourceType: 'session',
      resourceId: refresh.jti,
      ipHash: params.meta.ipHash,
      metadataJson: {},
    });

    return row;
  });

  const accessToken = await signAccessToken({
    sub: params.userId,
    org: params.organizationId,
    role: membershipRow.role,
    mid: membershipRow.id,
    ev: user.emailVerifiedAt !== null,
  });

  return {
    accessToken,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    organization: {
      id: membership.organizationId,
      name: membership.organizationName,
      slug: membership.organizationSlug,
      role: membership.role,
      planCode: membership.planCode,
    },
    memberships,
  };
}

// -----------------------------------------------------------------------------
// Refresh rotativo
// -----------------------------------------------------------------------------

/**
 * Rotação com detecção de reuso.
 *
 * Cada refresh queima o token apresentado e emite outro na mesma `família`.
 * Se um token JÁ REVOGADO for apresentado de novo, só há duas explicações: o
 * cookie vazou e alguém está usando uma cópia, ou o legítimo está repetindo um
 * request antigo. Não dá para distinguir — então a família inteira cai, e as
 * duas partes precisam fazer login de novo. Perder a sessão é barato; manter
 * uma sessão vazada aberta não é.
 */
export async function rotateRefreshToken(params: { rawToken: string; meta: SessionMeta }): Promise<IssuedSession> {
  let claims: RefreshTokenClaims;
  try {
    claims = await verifyRefreshToken(params.rawToken);
  } catch (error) {
    if (error instanceof InvalidTokenError) throw unauthorized('Sessão expirada. Faça login de novo.');
    throw error;
  }

  const tokenHash = hashToken(params.rawToken);
  const located = await withoutTenant((tx) => resolveRefreshTokenOrg(tx, tokenHash));
  if (!located) throw unauthorized('Sessão expirada. Faça login de novo.');

  // O token diz a que empresa pertence; o banco diz a mesma coisa. Divergência
  // significa token forjado com um `org` que não é o da linha.
  if (located.organizationId !== claims.org || located.userId !== claims.sub) {
    throw unauthorized('Sessão expirada. Faça login de novo.');
  }

  const outcome = await withTenant(located.organizationId, async (ctx) => {
    const row = await refreshTokensRepository.findById(ctx, located.tokenId);
    if (!row) return 'invalid' as const;

    if (row.revokedAt) {
      await refreshTokensRepository.revokeFamily(ctx, row.familyId);
      await auditLogsRepository.record(ctx, {
        actorUserId: row.userId,
        action: 'auth.refresh_token_reuse_detected',
        resourceType: 'session',
        resourceId: row.familyId,
        ipHash: params.meta.ipHash,
        metadataJson: { revokedFamily: true },
      });
      return 'reuse' as const;
    }

    if (row.expiresAt < new Date()) return 'invalid' as const;

    await refreshTokensRepository.revoke(ctx, row.id);
    return { familyId: row.familyId, userId: row.userId };
  });

  if (outcome === 'reuse') {
    throw unauthorized('Detectamos uso indevido desta sessão. Por segurança, entre de novo.');
  }
  if (outcome === 'invalid') {
    throw unauthorized('Sessão expirada. Faça login de novo.');
  }

  return issueSession({
    userId: outcome.userId,
    organizationId: located.organizationId,
    meta: params.meta,
    action: 'auth.refresh',
    familyId: outcome.familyId,
  });
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;

  const located = await withoutTenant((tx) => resolveRefreshTokenOrg(tx, hashToken(rawToken)));
  if (!located) return;

  await withTenant(located.organizationId, async (ctx) => {
    const row = await refreshTokensRepository.findById(ctx, located.tokenId);
    if (!row) return;
    await refreshTokensRepository.revokeFamily(ctx, row.familyId);
    await auditLogsRepository.record(ctx, {
      actorUserId: row.userId,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: row.familyId,
      metadataJson: {},
    });
  });
}

/** Aceite de convite: cria o vínculo com a empresa que emitiu o token. */
export async function acceptInvitation(params: {
  token: string;
  name?: string;
  password?: string;
  meta: SessionMeta;
}): Promise<IssuedSession> {
  const tokenHash = hashToken(params.token);

  const located = await withoutTenant((tx) => resolveInvitationOrg(tx, tokenHash));
  if (!located) throw new AppError('validation_error', 'Esse convite expirou ou já foi usado.');

  const result = await withTenant(located.organizationId, async (ctx) => {
    const invitation = await ctx.tx.invitation.findFirst({
      where: { id: located.invitationId, organizationId: ctx.organizationId, acceptedAt: null },
    });
    if (!invitation) return null;

    let user = await ctx.tx.user.findUnique({ where: { email: invitation.email }, select: { id: true } });

    if (!user) {
      if (!params.name || !params.password) {
        throw validationError({
          name: params.name ? [] : ['Informe seu nome.'],
          password: params.password ? [] : ['Escolha uma senha.'],
        });
      }
      if (await isLeakedPassword(params.password)) {
        throw validationError({ password: ['Essa senha aparece em vazamentos conhecidos. Escolha outra.'] });
      }
      user = await ctx.tx.user.create({
        data: {
          email: invitation.email,
          name: params.name.trim(),
          passwordHash: await hashPassword(params.password),
          // O convite chegou no e-mail: clicar no link já prova posse dele.
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
    }

    const existing = await membershipsRepository.findByUser(ctx, user.id);
    if (!existing) {
      await membershipsRepository.create(ctx, {
        userId: user.id,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        acceptedAt: new Date(),
      });
    }

    await ctx.tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await auditLogsRepository.record(ctx, {
      actorUserId: user.id,
      action: 'invitation.accepted',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadataJson: { role: invitation.role },
    });

    return { userId: user.id };
  });

  if (!result) throw new AppError('validation_error', 'Esse convite expirou ou já foi usado.');

  return issueSession({
    userId: result.userId,
    organizationId: located.organizationId,
    meta: params.meta,
    action: 'auth.accept_invitation',
  });
}

export const refreshTtlSeconds = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;
