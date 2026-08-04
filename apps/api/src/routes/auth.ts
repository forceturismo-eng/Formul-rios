import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptInvitationSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  switchOrganizationSchema,
  verifyEmailSchema,
} from '@forms/shared';
import {
  getAuth,
  requireAppHost,
  requireAuth,
  requestIpHash,
  requestUserAgentHash,
} from '../http/context.js';
import { unauthorized } from '../http/errors.js';
import { env } from '../config/env.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../auth/tokens.js';
import {
  acceptInvitation,
  login,
  logout,
  refreshTtlSeconds,
  register,
  rotateRefreshToken,
  resendVerification,
  switchOrganization,
  verifyEmail,
  type IssuedSession,
} from '../services/auth-service.js';

/**
 * Rotas de autenticação.
 *
 * Todas passam por `requireAppHost`: sessão só existe no domínio da aplicação.
 * Um domínio de cliente que tente `POST /v1/auth/login` recebe 404 (seção 8.1).
 *
 * O refresh token vai em cookie httpOnly com `path=/v1/auth` — ele não é
 * enviado em nenhum outro request, então nem XSS nem um endpoint vazando
 * headers conseguem lê-lo. O access token, esse sim, viaja no header
 * Authorization e vive 15 minutos.
 */

function sessionMeta(request: FastifyRequest) {
  return { ipHash: requestIpHash(request), userAgentHash: requestUserAgentHash(request) };
}

function sendSession(reply: FastifyReply, session: IssuedSession, status = 200) {
  reply.setCookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions(refreshTtlSeconds));
  return reply.status(status).send({
    accessToken: session.accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    user: session.user,
    organization: session.organization,
    memberships: session.memberships.map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organizationName,
      organizationSlug: m.organizationSlug,
      role: m.role,
      planCode: m.planCode,
      logoUrl: m.logoUrl,
      primaryColor: m.primaryColor,
    })),
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAppHost);

  app.post('/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const session = await register({ ...input, meta: sessionMeta(request) });
    return sendSession(reply, session, 201);
  });

  app.post(
    '/login',
    {
      config: {
        // 5 tentativas a cada 15 minutos, por IP (seção 9).
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const session = await login({ ...input, meta: sessionMeta(request) });
      return sendSession(reply, session);
    },
  );

  app.post('/refresh', async (request, reply) => {
    const rawToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!rawToken) throw unauthorized('Sessão expirada. Faça login de novo.');

    const session = await rotateRefreshToken({ rawToken, meta: sessionMeta(request) });
    return sendSession(reply, session);
  });

  app.post('/logout', async (request, reply) => {
    await logout(request.cookies[REFRESH_COOKIE_NAME]);
    reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(0));
    return reply.status(204).send();
  });

  app.post('/verify-email', async (request, reply) => {
    const { token } = verifyEmailSchema.parse(request.body);
    await verifyEmail(token);
    return reply.status(204).send();
  });

  app.post('/resend-verification', async (request, reply) => {
    const { email } = resendVerificationSchema.parse(request.body);
    await resendVerification(email);
    // Sempre 202, exista a conta ou não: esta rota não pode virar enumerador.
    return reply.status(202).send({ message: 'Se essa conta existir, o link de confirmação está a caminho.' });
  });

  app.post('/accept-invitation', async (request, reply) => {
    const input = acceptInvitationSchema.parse(request.body);
    const session = await acceptInvitation({ ...input, meta: sessionMeta(request) });
    return sendSession(reply, session);
  });

  app.post('/switch-organization', { preHandler: requireAuth }, async (request, reply) => {
    const { organizationId } = switchOrganizationSchema.parse(request.body);
    const session = await switchOrganization({
      userId: getAuth(request).userId,
      organizationId,
      meta: sessionMeta(request),
    });
    return sendSession(reply, session);
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    return {
      userId: auth.userId,
      organizationId: auth.organizationId,
      role: auth.role,
      emailVerified: auth.emailVerified,
    };
  });
}
