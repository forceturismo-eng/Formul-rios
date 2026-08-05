import { getPlan, type PlanCode } from '@forms/shared';
import { prisma } from '../db/prisma.js';
import { withTenant, withoutTenant } from '../db/tenant.js';
import { loadAdminMetrics, loadAdminOrganization, loadAdminOrganizations } from '../db/bootstrap.js';
import { hashPassword, verifyPassword } from '../auth/hashing.js';
import { generateTotpSecret, totpUri, totpWindowOf, verifyTotp } from '../auth/totp.js';
import { AppError, notFound, unauthorized, validationError } from '../http/errors.js';
import { env } from '../config/env.js';

/**
 * Admin da plataforma (seção 5.5).
 *
 * A regra que organiza tudo aqui: **o admin lê agregados, não linhas de
 * clientes**. MRR, churn, inadimplência e uso são somas e contagens, servidas
 * por funções do banco que só sabem devolver número. Mesmo com um bug nas
 * rotas, não existe caminho por onde conteúdo de resposta saia — a função não
 * tem como devolvê-lo.
 *
 * Para ver dado de cliente, o admin precisa IMPERSONAR. E impersonar deixa
 * rastro: entrada em `admin_actions`, entrada no `audit_logs` da empresa, e um
 * banner permanente na tela de quem estiver olhando.
 */

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
}

// -----------------------------------------------------------------------------
// Autenticação
// -----------------------------------------------------------------------------

export interface LoginResult {
  /** `mfa_setup` quando o admin ainda não configurou o segundo fator. */
  status: 'ok' | 'mfa_setup';
  admin: AdminIdentity;
  /** Presente só em `mfa_setup`: o segredo e a URI do QR Code. */
  totp?: { secret: string; uri: string };
}

/**
 * Login do admin.
 *
 * Senha E código TOTP na mesma chamada. Duas etapas separadas exigiriam um
 * token intermediário — mais um segredo de vida curta para desenhar, guardar e
 * invalidar — e o ganho seria só de interface.
 *
 * A exceção é o primeiro acesso: sem segredo configurado não há código para
 * pedir. Nesse caso a senha sozinha abre APENAS a configuração do MFA, e
 * `status: 'mfa_setup'` diz isso a quem chamou.
 */
export async function adminLogin(params: {
  email: string;
  password: string;
  totpCode?: string;
}): Promise<LoginResult> {
  const admin = await prisma.platformAdmin.findUnique({
    where: { email: params.email.trim().toLowerCase() },
  });

  // Sem admin, ainda gastamos o tempo de uma verificação de senha: responder
  // rápido para e-mail inexistente e devagar para existente enumera contas.
  if (!admin) {
    await verifyPassword(SENHA_FALSA, params.password).catch(() => false);
    throw unauthorized('Credenciais inválidas.');
  }

  if (admin.disabledAt) throw unauthorized('Credenciais inválidas.');

  const senhaOk = await verifyPassword(admin.passwordHash, params.password);
  if (!senhaOk) throw unauthorized('Credenciais inválidas.');

  const identidade = { id: admin.id, email: admin.email, name: admin.name };

  // Primeiro acesso: o segundo fator ainda não existe.
  if (!admin.totpSecret || !admin.totpEnabledAt) {
    const secret = admin.totpSecret ?? generateTotpSecret();

    // Guarda o segredo, mas NÃO liga o MFA: ligar só acontece depois de o
    // admin provar que conseguiu ler o QR Code. Sem isso, um erro na leitura
    // trancaria a conta para sempre.
    await prisma.platformAdmin.update({ where: { id: admin.id }, data: { totpSecret: secret } });

    return {
      status: 'mfa_setup',
      admin: identidade,
      totp: { secret, uri: totpUri({ secret, account: admin.email, issuer: env.branding.productName }) },
    };
  }

  if (!params.totpCode) throw unauthorized('Informe o código do seu aplicativo autenticador.');

  const janela = totpWindowOf(admin.totpSecret, params.totpCode);
  if (janela === null) throw unauthorized('Código inválido.');

  // O mesmo código vale por até 90 segundos. Sem registrar a janela consumida,
  // um código interceptado pode ser reapresentado dentro dela.
  if (admin.lastTotpWindow !== null && BigInt(janela) <= admin.lastTotpWindow) {
    throw unauthorized('Este código já foi usado. Aguarde o próximo.');
  }

  await prisma.platformAdmin.update({
    where: { id: admin.id },
    data: { lastTotpWindow: BigInt(janela), lastLoginAt: new Date() },
  });

  await recordAdminAction(admin.id, 'admin.login', null, {});

  return { status: 'ok', admin: identidade };
}

/** Conclui a configuração do MFA conferindo o primeiro código. */
export async function confirmAdminMfa(adminId: string, codigo: string): Promise<void> {
  const admin = await prisma.platformAdmin.findUnique({ where: { id: adminId } });
  if (!admin?.totpSecret) throw notFound();

  if (!verifyTotp(admin.totpSecret, codigo)) {
    throw validationError({ code: ['Código inválido. Confira o horário do seu celular.'] });
  }

  const janela = totpWindowOf(admin.totpSecret, codigo);

  await prisma.platformAdmin.update({
    where: { id: adminId },
    data: {
      totpEnabledAt: new Date(),
      ...(janela !== null ? { lastTotpWindow: BigInt(janela) } : {}),
    },
  });

  await recordAdminAction(adminId, 'admin.mfa_enabled', null, {});
}

export async function loadAdmin(adminId: string): Promise<AdminIdentity | null> {
  const admin = await prisma.platformAdmin.findFirst({
    where: { id: adminId, disabledAt: null },
    select: { id: true, email: true, name: true, totpEnabledAt: true },
  });

  // MFA não configurado = sem acesso a nada além da própria configuração.
  if (!admin?.totpEnabledAt) return null;

  return { id: admin.id, email: admin.email, name: admin.name };
}

/**
 * Hash descartável para gastar o mesmo tempo quando o e-mail não existe.
 *
 * Gerado na subida, uma vez. Verificar contra ele custa o mesmo que verificar
 * contra um hash real, que é o ponto.
 */
const SENHA_FALSA = await hashPassword('senha-que-nunca-sera-usada-de-verdade-2026');

// -----------------------------------------------------------------------------
// Trilha
// -----------------------------------------------------------------------------

export async function recordAdminAction(
  adminId: string,
  action: string,
  organizationId: string | null,
  metadata: Record<string, unknown>,
  ipHash?: string | null,
): Promise<void> {
  await prisma.adminAction.create({
    data: {
      adminId,
      action,
      organizationId,
      metadataJson: metadata as never,
      ipHash: ipHash ?? null,
    },
  });
}

export async function listAdminActions(params: { adminId?: string; organizationId?: string; limit?: number }) {
  return prisma.adminAction.findMany({
    where: {
      ...(params.adminId ? { adminId: params.adminId } : {}),
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(params.limit ?? 100, 500),
    include: { admin: { select: { email: true, name: true } } },
  });
}

// -----------------------------------------------------------------------------
// Métricas
// -----------------------------------------------------------------------------

export async function platformMetrics() {
  const linha = await withoutTenant((tx) => loadAdminMetrics(tx));

  if (!linha) throw new AppError('internal_error', 'Não conseguimos ler as métricas.');

  const ativas = Number(linha.organizations_active);
  const canceladas = Number(linha.canceled_last_30_days);

  return {
    organizations: {
      total: Number(linha.organizations_total),
      active: ativas,
      trialing: Number(linha.organizations_trialing),
      suspended: Number(linha.organizations_suspended),
      canceled: Number(linha.organizations_canceled),
    },
    mrrCents: Number(linha.mrr_cents),
    // Churn do período sobre a base que existia no começo dele. Denominador
    // zero devolve 0 e não NaN: uma plataforma sem clientes não tem churn.
    churnRate: ativas + canceladas > 0 ? canceladas / (ativas + canceladas) : 0,
    overdue: {
      count: Number(linha.invoices_overdue),
      amountCents: Number(linha.invoices_overdue_cents),
    },
    responsesLast30Days: Number(linha.responses_last_30_days),
  };
}

export async function listOrganizations(params: { search?: string; limit?: number; offset?: number }) {
  const linhas = await withoutTenant((tx) =>
    loadAdminOrganizations(tx, {
      search: params.search ?? '',
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    }),
  );

  return linhas.map((linha) => ({
    id: linha.id,
    name: linha.name,
    slug: linha.slug,
    planCode: linha.plan_code,
    planName: getPlan(linha.plan_code as PlanCode).name,
    subscriptionStatus: linha.subscription_status,
    createdAt: linha.created_at,
    membersCount: Number(linha.members_count),
    formsCount: Number(linha.forms_count),
    responsesCount: Number(linha.responses_count),
    overdueCount: Number(linha.overdue_count),
  }));
}

export async function organizationDetail(organizationId: string) {
  const linha = await withoutTenant((tx) => loadAdminOrganization(tx, organizationId));

  if (!linha) throw notFound();

  const plano = getPlan(linha.plan_code as PlanCode);

  return {
    id: linha.id,
    name: linha.name,
    slug: linha.slug,
    planCode: linha.plan_code,
    planName: plano.name,
    subscriptionStatus: linha.subscription_status,
    trialEndsAt: linha.trial_ends_at,
    createdAt: linha.created_at,
    // Único dado pessoal desta tela, e ele existe para o suporte conseguir
    // responder a quem abriu o chamado.
    ownerEmail: linha.owner_email,
    membersCount: Number(linha.members_count),
    formsCount: Number(linha.forms_count),
    responsesCount: Number(linha.responses_count),
    storageUsedMb: Number(linha.storage_used_mb),
    overdueCents: Number(linha.overdue_cents),
  };
}

// -----------------------------------------------------------------------------
// Ações sobre uma empresa
// -----------------------------------------------------------------------------

const STATUS_PERMITIDOS = new Set(['active', 'suspended', 'canceled', 'trialing']);

export async function setOrganizationStatus(
  adminId: string,
  organizationId: string,
  status: string,
  motivo: string,
) {
  if (!STATUS_PERMITIDOS.has(status)) {
    throw validationError({ status: ['Estado desconhecido.'] });
  }
  if (motivo.trim().length < 5) {
    // Motivo obrigatório: uma trilha que diz "alguém suspendeu" sem dizer por
    // quê não resolve a pergunta que se faz três meses depois.
    throw validationError({ reason: ['Explique o motivo — ele fica registrado.'] });
  }

  const atualizada = await withTenant(organizationId, async (ctx) => {
    const antes = await ctx.tx.organization.findFirst({
      where: { id: organizationId },
      select: { subscriptionStatus: true },
    });
    if (!antes) throw notFound();

    return {
      antes: antes.subscriptionStatus,
      depois: (
        await ctx.tx.organization.update({
          where: { id: organizationId },
          data: { subscriptionStatus: status as never },
        })
      ).subscriptionStatus,
    };
  });

  await recordAdminAction(adminId, 'organization.status_changed', organizationId, {
    from: atualizada.antes,
    to: atualizada.depois,
    reason: motivo.trim(),
  });

  // Também no audit log do CLIENTE: ele tem direito de ver, no próprio painel,
  // que a conta foi suspensa por nós — e quando.
  await withTenant(organizationId, (ctx) =>
    ctx.tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: 'organization.status_changed_by_platform',
        resourceType: 'organization',
        resourceId: organizationId,
        metadataJson: { from: atualizada.antes, to: atualizada.depois },
      },
    }),
  );

  return atualizada;
}

export async function setOrganizationPlan(
  adminId: string,
  organizationId: string,
  planCode: string,
  motivo: string,
) {
  // `getPlan` lança para código desconhecido, e é o que queremos: um plano
  // inventado gravado aqui quebraria enforcement, cobrança e telas de uma vez.
  const plano = getPlan(planCode as PlanCode);

  if (motivo.trim().length < 5) {
    throw validationError({ reason: ['Explique o motivo — ele fica registrado.'] });
  }

  const resultado = await withTenant(organizationId, async (ctx) => {
    const antes = await ctx.tx.organization.findFirst({
      where: { id: organizationId },
      select: { planCode: true },
    });
    if (!antes) throw notFound();

    await ctx.tx.organization.update({ where: { id: organizationId }, data: { planCode: plano.code } });
    return { antes: antes.planCode, depois: plano.code };
  });

  await recordAdminAction(adminId, 'organization.plan_changed', organizationId, {
    from: resultado.antes,
    to: resultado.depois,
    reason: motivo.trim(),
  });

  await withTenant(organizationId, (ctx) =>
    ctx.tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: 'organization.plan_changed_by_platform',
        resourceType: 'organization',
        resourceId: organizationId,
        metadataJson: { from: resultado.antes, to: resultado.depois },
      },
    }),
  );

  return resultado;
}

// -----------------------------------------------------------------------------
// Impersonação
// -----------------------------------------------------------------------------

/** Quinze minutos. Tempo de olhar um problema, não de trabalhar na conta. */
export const IMPERSONATION_TTL_SECONDS = 15 * 60;

export interface ImpersonationTarget {
  userId: string;
  membershipId: string;
  role: string;
  organizationName: string;
  userEmail: string;
}

/**
 * Escolhe em nome de quem impersonar.
 *
 * Sempre o `owner` mais antigo: é a conta com visão completa da empresa, e
 * fixar o critério evita que a escolha vire mais uma decisão do operador.
 */
export async function resolveImpersonationTarget(organizationId: string): Promise<ImpersonationTarget> {
  return withTenant(organizationId, async (ctx) => {
    const organizacao = await ctx.tx.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { name: true },
    });
    if (!organizacao) throw notFound();

    const membership = await ctx.tx.membership.findFirst({
      where: { organizationId, role: 'owner' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!membership) throw new AppError('conflict', 'Esta empresa não tem um owner ativo.');

    return {
      userId: membership.user.id,
      membershipId: membership.id,
      role: membership.role,
      organizationName: organizacao.name,
      userEmail: membership.user.email,
    };
  });
}

/**
 * Registra a impersonação nos DOIS lados.
 *
 * Em `admin_actions`, porque é nossa operação. E no `audit_logs` da empresa,
 * porque é direito do cliente saber que alguém da plataforma entrou na conta
 * dele — sem precisar pedir.
 */
export async function recordImpersonation(params: {
  adminId: string;
  adminEmail: string;
  organizationId: string;
  targetUserId: string;
  reason: string;
  ipHash?: string | null;
}): Promise<void> {
  await recordAdminAction(
    params.adminId,
    'organization.impersonated',
    params.organizationId,
    { targetUserId: params.targetUserId, reason: params.reason },
    params.ipHash,
  );

  await withTenant(params.organizationId, (ctx) =>
    ctx.tx.auditLog.create({
      data: {
        organizationId: params.organizationId,
        actorUserId: null,
        action: 'platform.impersonation_started',
        resourceType: 'organization',
        resourceId: params.organizationId,
        metadataJson: {
          adminEmail: params.adminEmail,
          reason: params.reason,
          expiresInSeconds: IMPERSONATION_TTL_SECONDS,
        },
        ...(params.ipHash ? { ipHash: params.ipHash } : {}),
      },
    }),
  );
}
