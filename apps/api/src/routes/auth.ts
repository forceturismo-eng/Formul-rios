import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
import { prisma } from '../db/prisma.js';
import { verifyPassword } from '../auth/hashing.js';
import {
  ativarMfa,
  desativarMfa,
  estadoDoMfa,
  iniciarMfa,
  regenerarCodigos,
} from '../services/mfa-service.js';
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

  // ---------------------------------------------------------------------------
  // Verificação em duas etapas
  //
  // Opcional para o cliente, diferente do admin da plataforma, onde é
  // obrigatória. Dessa diferença sai o resto: existe como desligar, desligar
  // exige senha, e há códigos de recuperação para quem perde o celular.
  // ---------------------------------------------------------------------------

  app.get('/mfa', { preHandler: requireAuth }, async (request) => {
    return estadoDoMfa(getAuth(request).userId);
  });

  /** Começa a configuração. NÃO liga o MFA — ligar exige provar o primeiro código. */
  app.post('/mfa/setup', { preHandler: requireAuth }, async (request) => {
    return iniciarMfa(getAuth(request).userId);
  });

  app.post('/mfa/activate', { preHandler: requireAuth }, async (request) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const resultado = await ativarMfa(getAuth(request).userId, code);

    return {
      ...resultado,
      aviso:
        'Guarde estes códigos agora, fora do celular. Cada um serve uma vez, e é assim que você entra ' +
        'se perder o aparelho.',
    };
  });

  /**
   * Desliga. Exige a SENHA, não só a sessão.
   *
   * Uma sessão roubada não pode remover a proteção que existe justamente para o
   * caso de a senha ter vazado — seria a porta de trás do próprio recurso.
   */
  app.post('/mfa/disable', { preHandler: requireAuth }, async (request) => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const auth = getAuth(request);

    await desativarMfa(auth.userId, await conferirSenha(auth.userId, password));
    return { enabled: false };
  });

  app.post('/mfa/recovery-codes', { preHandler: requireAuth }, async (request) => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const auth = getAuth(request);

    const codigos = await regenerarCodigos(auth.userId, await conferirSenha(auth.userId, password));
    return { recoveryCodes: codigos, aviso: 'Os códigos anteriores deixaram de valer.' };
  });

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

/**
 * Confere a senha atual de quem já está logado.
 *
 * Devolve booleano em vez de lançar: quem chama decide a mensagem, e as duas
 * chamadas daqui querem dizer coisas diferentes ("para desligar" e "para gerar
 * novos códigos").
 */
async function conferirSenha(userId: string, senha: string): Promise<boolean> {
  const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!usuario) return false;

  return verifyPassword(usuario.passwordHash, senha);
}
