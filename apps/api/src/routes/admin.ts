import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestIpHash } from '../http/context.js';
import { forbidden, notFound, unauthorized } from '../http/errors.js';
import {
  InvalidTokenError,
  signAdminToken,
  signImpersonationToken,
  verifyAdminToken,
} from '../auth/tokens.js';
import {
  IMPERSONATION_TTL_SECONDS,
  adminLogin,
  confirmAdminMfa,
  listAdminActions,
  listOrganizations,
  loadAdmin,
  organizationDetail,
  platformMetrics,
  recordAdminAction,
  recordImpersonation,
  resolveImpersonationTarget,
  setOrganizationPlan,
  setOrganizationStatus,
  type AdminIdentity,
} from '../services/admin-service.js';

/**
 * Área do admin da plataforma (seção 5.5).
 *
 * Autenticação distinta da dos clientes: tabela própria, token com audience
 * própria, prefixo próprio. Um token de cliente apresentado aqui falha na
 * verificação de audience antes de qualquer checagem de papel.
 *
 * O que o admin consegue ver sem impersonar são AGREGADOS e metadado. Nenhuma
 * rota aqui devolve conteúdo de formulário ou de resposta — para isso existe a
 * impersonação, que é curta, registrada nos dois lados e visível na tela.
 */

declare module 'fastify' {
  interface FastifyRequest {
    platformAdmin: AdminIdentity | null;
  }
}

const uuidParam = z.object({ id: z.string().uuid() });

/** Motivo obrigatório em toda ação que mexe na conta de um cliente. */
const motivoSchema = z
  .string()
  .trim()
  .min(5, 'Explique o motivo — ele fica registrado.')
  .max(500);

function adminDe(request: FastifyRequest): AdminIdentity {
  if (!request.platformAdmin) throw unauthorized();
  return request.platformAdmin;
}

/** Verifica o token de admin, convertendo qualquer falha em 401. */
async function verificarOuRecusar(token: string) {
  try {
    return await verifyAdminToken(token);
  } catch (erro) {
    if (erro instanceof InvalidTokenError) throw unauthorized();
    throw erro;
  }
}

/**
 * Rotas sem sessão: login e confirmação do MFA.
 *
 * Separadas do resto porque o `preHandler` de autenticação não pode valer para
 * elas — e porque a confirmação do MFA acontece num estado em que o admin já
 * provou a senha mas ainda não tem segundo fator.
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/login',
    {
      config: {
        // Mais apertado que o login de cliente: são poucas contas, e força
        // bruta aqui vale muito mais para quem tenta.
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request) => {
      const entrada = z
        .object({
          email: z.string().email().max(254),
          password: z.string().min(1).max(200),
          totpCode: z.string().max(20).optional(),
        })
        .parse(request.body);

      const resultado = await adminLogin(entrada);

      if (resultado.status === 'mfa_setup') {
        // Token de escopo mínimo: com MFA desligado, `loadAdmin` devolve null
        // e o `preHandler` recusa tudo — exceto a confirmação do MFA, que
        // valida o token por conta própria.
        return {
          status: 'mfa_setup',
          setupToken: await signAdminToken(resultado.admin.id),
          totp: resultado.totp,
          instrucoes:
            'Leia o QR Code no seu aplicativo autenticador e confirme com o primeiro código. ' +
            'Enquanto isso não acontecer, esta conta não acessa nada.',
        };
      }

      return {
        status: 'ok',
        token: await signAdminToken(resultado.admin.id),
        admin: resultado.admin,
        expiresInSeconds: 30 * 60,
      };
    },
  );

  app.post('/mfa/confirm', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    const header = request.headers.authorization;
    const [esquema, valor] = (header ?? '').split(' ');
    if (!esquema || esquema.toLowerCase() !== 'bearer' || !valor) throw unauthorized();

    const claims = await verificarOuRecusar(valor);
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);

    await confirmAdminMfa(claims.sub, code);

    return { status: 'ok', mensagem: 'Segundo fator ativado. Entre novamente com o código.' };
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('platformAdmin', null);

  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    const [esquema, valor] = (header ?? '').split(' ');

    if (!esquema || esquema.toLowerCase() !== 'bearer' || !valor) throw unauthorized();

    // Token de cliente apresentado aqui falha na audience — e precisa virar
    // 401, não 500. Um erro de servidor diria a quem tentou que ele encontrou
    // um caminho não previsto.
    const claims = await verificarOuRecusar(valor);
    // `loadAdmin` devolve null quando o MFA não está ligado ou a conta foi
    // desativada. Nos dois casos, nada aqui responde.
    const admin = await loadAdmin(claims.sub);
    if (!admin) throw unauthorized();

    request.platformAdmin = admin;
  });

  app.get('/me', async (request) => ({ admin: adminDe(request) }));

  // ---------------------------------------------------------------------------
  // Painel
  // ---------------------------------------------------------------------------

  app.get('/metrics', async (request) => {
    adminDe(request);
    return platformMetrics();
  });

  app.get('/organizations', async (request) => {
    adminDe(request);

    const query = z
      .object({
        search: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    return {
      organizations: await listOrganizations({
        ...(query.search ? { search: query.search } : {}),
        limit: query.limit,
        offset: query.offset,
      }),
    };
  });

  app.get('/organizations/:id', async (request) => {
    adminDe(request);
    const { id } = uuidParam.parse(request.params);

    return {
      organization: await organizationDetail(id),
      // A trilha do que já foi feito nesta empresa aparece junto do detalhe:
      // quem vai agir precisa ver o que já aconteceu antes de agir.
      actions: (await listAdminActions({ organizationId: id, limit: 50 })).map(formatarAcao),
    };
  });

  // ---------------------------------------------------------------------------
  // Ações
  // ---------------------------------------------------------------------------

  app.patch('/organizations/:id/status', async (request) => {
    const admin = adminDe(request);
    const { id } = uuidParam.parse(request.params);

    const entrada = z
      .object({
        status: z.enum(['active', 'suspended', 'canceled', 'trialing']),
        reason: motivoSchema,
      })
      .parse(request.body);

    return setOrganizationStatus(admin.id, id, entrada.status, entrada.reason);
  });

  app.patch('/organizations/:id/plan', async (request) => {
    const admin = adminDe(request);
    const { id } = uuidParam.parse(request.params);

    const entrada = z
      .object({ planCode: z.string().min(1).max(40), reason: motivoSchema })
      .parse(request.body);

    return setOrganizationPlan(admin.id, id, entrada.planCode, entrada.reason);
  });

  /**
   * Impersonação.
   *
   * Devolve um access token de CLIENTE, com dois claims a mais dizendo quem
   * está por trás. Reaproveitar o formato é proposital: toda rota de cliente
   * enxerga a impersonação sem precisar saber que ela existe, e nenhuma delas
   * pode esquecer de conferir.
   *
   * Quinze minutos, sem refresh. Tempo de olhar um problema, não de trabalhar
   * na conta de outra pessoa.
   */
  app.post('/organizations/:id/impersonate', async (request) => {
    const admin = adminDe(request);
    const { id } = uuidParam.parse(request.params);
    const { reason } = z.object({ reason: motivoSchema }).parse(request.body);

    const alvo = await resolveImpersonationTarget(id);
    const ipHash = requestIpHash(request);

    // Registra ANTES de emitir. Se a gravação falhar, não há token — melhor
    // uma impersonação que não aconteceu do que uma sem rastro.
    await recordImpersonation({
      adminId: admin.id,
      adminEmail: admin.email,
      organizationId: id,
      targetUserId: alvo.userId,
      reason,
      ipHash,
    });

    const token = await signImpersonationToken({
      userId: alvo.userId,
      organizationId: id,
      role: alvo.role as never,
      membershipId: alvo.membershipId,
      adminId: admin.id,
      adminEmail: admin.email,
      ttlSeconds: IMPERSONATION_TTL_SECONDS,
    });

    return {
      token,
      expiresInSeconds: IMPERSONATION_TTL_SECONDS,
      organization: { id, name: alvo.organizationName },
      actingAs: alvo.userEmail,
      aviso:
        'Você está entrando na conta de um cliente. A empresa vê este acesso no próprio painel, ' +
        'e ele é somente leitura.',
    };
  });

  // ---------------------------------------------------------------------------
  // Trilha
  // ---------------------------------------------------------------------------

  app.get('/actions', async (request) => {
    adminDe(request);

    const query = z
      .object({
        adminId: z.string().uuid().optional(),
        organizationId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);

    return {
      actions: (
        await listAdminActions({
          ...(query.adminId ? { adminId: query.adminId } : {}),
          ...(query.organizationId ? { organizationId: query.organizationId } : {}),
          limit: query.limit,
        })
      ).map(formatarAcao),
    };
  });

  /** Sair. Registrado como qualquer outra coisa. */
  app.post('/logout', async (request) => {
    const admin = adminDe(request);
    await recordAdminAction(admin.id, 'admin.logout', null, {});
    return { status: 'ok' };
  });

  app.setNotFoundHandler(async () => {
    throw notFound();
  });
}

function formatarAcao(acao: {
  id: string;
  action: string;
  organizationId: string | null;
  metadataJson: unknown;
  createdAt: Date;
  admin: { email: string; name: string };
}) {
  return {
    id: acao.id,
    action: acao.action,
    organizationId: acao.organizationId,
    metadata: acao.metadataJson,
    createdAt: acao.createdAt,
    admin: acao.admin,
  };
}

/** Reexportado para o `app.ts` recusar o admin quando ele estiver desligado. */
export function adminDisabled(): never {
  throw forbidden('A área de administração está desativada nesta instalação.');
}
