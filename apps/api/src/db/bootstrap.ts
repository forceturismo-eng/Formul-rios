import type { Prisma } from '@prisma/client';
import type { Role } from '@forms/shared';

/**
 * MÓDULO AUDITADO — o único lugar do backend autorizado a usar `$queryRaw`
 * fora de `tenant.ts`. Há um teste que falha se `$queryRaw`/`$executeRaw`
 * aparecer em qualquer outro arquivo (tests/unit/raw-query-guard.test.ts).
 *
 * Todas as consultas aqui chamam funções SECURITY DEFINER declaradas na
 * migration de RLS. Elas existem para resolver o problema de ovo e galinha do
 * multi-tenant: para descobrir a organização de um request é preciso ler
 * tabelas que já estão protegidas por organização.
 *
 * O que torna isso seguro:
 *  - Nenhuma função recebe `organization_id` como entrada. Não dá para escolher
 *    o tenant que se quer ler.
 *  - Cada uma exige que o chamador já tenha provado posse de uma credencial:
 *    o id de um usuário autenticado, ou o hash de um token que só quem recebeu
 *    o e-mail/cookie conhece.
 *  - Cada uma devolve o mínimo necessário para setar o contexto. O conteúdo de
 *    verdade é lido depois, já sob RLS.
 */

export interface MembershipSummary {
  organizationId: string;
  role: Role;
  acceptedAt: Date | null;
  organizationName: string;
  organizationSlug: string;
  planCode: string;
  subscriptionStatus: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

interface MembershipRow {
  organization_id: string;
  role: Role;
  accepted_at: Date | null;
  organization_name: string;
  organization_slug: string;
  plan_code: string;
  subscription_status: string;
  logo_url: string | null;
  primary_color: string | null;
}

/** Empresas de UM usuário. Usada no login, no refresh e na troca de workspace. */
export async function listUserMemberships(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<MembershipSummary[]> {
  const rows = await tx.$queryRaw<MembershipRow[]>`
    SELECT * FROM app_user_memberships(${userId}::uuid)
  `;
  return rows.map((row) => ({
    organizationId: row.organization_id,
    role: row.role,
    acceptedAt: row.accepted_at,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    planCode: row.plan_code,
    subscriptionStatus: row.subscription_status,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
  }));
}

/** Membership de um usuário numa organização específica, ou `null`. */
export async function findMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId: string,
): Promise<MembershipSummary | null> {
  const memberships = await listUserMemberships(tx, userId);
  return memberships.find((m) => m.organizationId === organizationId) ?? null;
}

/** Organização de um convite, a partir do hash do token. */
export async function resolveInvitationOrg(
  tx: Prisma.TransactionClient,
  tokenHash: string,
): Promise<{ invitationId: string; organizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ invitation_id: string; organization_id: string }>>`
    SELECT * FROM app_invitation_org(${tokenHash})
  `;
  const row = rows[0];
  return row ? { invitationId: row.invitation_id, organizationId: row.organization_id } : null;
}

/**
 * Organização de um formulário público, a partir do slug.
 *
 * O slug é público por natureza — está na URL que o cliente divulga. Conhecê-lo
 * não é credencial, e por isso esta função devolve apenas IDs, e apenas para
 * formulários efetivamente publicados. Título, schema e configurações são lidos
 * depois, já sob RLS.
 */
export async function resolvePublicFormOrg(
  tx: Prisma.TransactionClient,
  slug: string,
): Promise<{ formId: string; organizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ form_id: string; organization_id: string }>>`
    SELECT * FROM app_public_form_org(${slug})
  `;
  const row = rows[0];
  return row ? { formId: row.form_id, organizationId: row.organization_id } : null;
}

/**
 * Organização de um domínio de cliente.
 *
 * Usada no renderizador público e no endpoint `ask` do Caddy. Devolve o estado
 * da organização junto porque a autorização de emissão de certificado depende
 * dele: domínio de cliente suspenso não ganha certificado novo.
 */
export interface CustomDomainLookup {
  domainId: string;
  organizationId: string;
  domainStatus: string;
  subscriptionStatus: string;
  organizationDeleted: boolean;
}

export async function resolveCustomDomainOrg(
  tx: Prisma.TransactionClient,
  domain: string,
): Promise<CustomDomainLookup | null> {
  const rows = await tx.$queryRaw<
    Array<{
      domain_id: string;
      organization_id: string;
      domain_status: string;
      subscription_status: string;
      organization_deleted: boolean;
    }>
  >`SELECT * FROM app_custom_domain_org(${domain})`;

  const row = rows[0];
  return row
    ? {
        domainId: row.domain_id,
        organizationId: row.organization_id,
        domainStatus: row.domain_status,
        subscriptionStatus: row.subscription_status,
        organizationDeleted: row.organization_deleted,
      }
    : null;
}

/**
 * Organização de uma chave de API, a partir do hash dela.
 *
 * O que autoriza a consulta é a posse da própria chave: só quem tem o segredo
 * produz esse hash. Devolve `revokedAt` e `expiresAt` sem filtrar, para que o
 * MOTIVO da recusa possa ser registrado — "chave revogada" e "chave
 * inexistente" respondem igual ao cliente, mas o log precisa distinguir.
 */
export interface ApiKeyLookup {
  apiKeyId: string;
  organizationId: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  subscriptionStatus: string;
}

export async function resolveApiKeyOrg(
  tx: Prisma.TransactionClient,
  keyHash: string,
): Promise<ApiKeyLookup | null> {
  const rows = await tx.$queryRaw<
    Array<{
      api_key_id: string;
      organization_id: string;
      scopes: string[];
      revoked_at: Date | null;
      expires_at: Date | null;
      subscription_status: string;
    }>
  >`SELECT * FROM app_api_key_org(${keyHash})`;

  const row = rows[0];
  return row
    ? {
        apiKeyId: row.api_key_id,
        organizationId: row.organization_id,
        scopes: row.scopes,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
        subscriptionStatus: row.subscription_status,
      }
    : null;
}

/**
 * Organização de uma assinatura, a partir do id dela no gateway.
 *
 * Usada só no processamento de webhook de pagamento. O que autoriza a consulta
 * não é conhecer o id, e sim o token do provedor — verificado em tempo
 * constante antes desta chamada.
 */
export async function resolveSubscriptionOrg(
  tx: Prisma.TransactionClient,
  providerSubscriptionId: string,
): Promise<{ subscriptionId: string; organizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ subscription_id: string; organization_id: string }>>`
    SELECT * FROM app_subscription_org(${providerSubscriptionId})
  `;
  const row = rows[0];
  return row ? { subscriptionId: row.subscription_id, organizationId: row.organization_id } : null;
}

/** Idem, quando o evento traz só o cliente do gateway e não a assinatura. */
export async function resolveBillingCustomerOrg(
  tx: Prisma.TransactionClient,
  providerCustomerId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ organization_id: string }>>`
    SELECT * FROM app_billing_customer_org(${providerCustomerId})
  `;
  return rows[0]?.organization_id ?? null;
}

/**
 * Organização de um refresh token, a partir do hash.
 * Devolve o token mesmo revogado ou expirado — a detecção de reuso precisa
 * enxergar tokens já queimados para saber que houve reuso.
 */
export async function resolveRefreshTokenOrg(
  tx: Prisma.TransactionClient,
  tokenHash: string,
): Promise<{ tokenId: string; organizationId: string; userId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ token_id: string; organization_id: string; user_id: string }>>`
    SELECT * FROM app_refresh_token_org(${tokenHash})
  `;
  const row = rows[0];
  return row ? { tokenId: row.token_id, organizationId: row.organization_id, userId: row.user_id } : null;
}

// -----------------------------------------------------------------------------
// Admin da plataforma
//
// Estas três atravessam organizações — é o trabalho delas, e é o único lugar
// do sistema onde isso é intencional. O que as torna aceitáveis não é o papel
// de quem chama: é o FORMATO DO RETORNO.
//
// `app_admin_metrics` e `app_admin_organizations` só sabem devolver número e
// metadado. Não existe parâmetro que as faça devolver conteúdo de resposta,
// porque a função não tem essa coluna no retorno. Mesmo com um bug nas rotas
// de admin, o conteúdo dos clientes não sai por aqui.
//
// Para ver dado de cliente, o admin precisa impersonar — e impersonar deixa
// rastro nos dois lados (ADR 0009).
// -----------------------------------------------------------------------------

export interface AdminMetricsRow {
  organizations_total: bigint;
  organizations_active: bigint;
  organizations_trialing: bigint;
  organizations_suspended: bigint;
  organizations_canceled: bigint;
  mrr_cents: bigint;
  invoices_overdue: bigint;
  invoices_overdue_cents: bigint;
  responses_last_30_days: bigint;
  canceled_last_30_days: bigint;
}

export async function loadAdminMetrics(tx: Prisma.TransactionClient): Promise<AdminMetricsRow | null> {
  const rows = await tx.$queryRaw<AdminMetricsRow[]>`SELECT * FROM app_admin_metrics()`;
  return rows[0] ?? null;
}

export interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan_code: string;
  subscription_status: string;
  created_at: Date;
  members_count: bigint;
  forms_count: bigint;
  responses_count: bigint;
  overdue_count: bigint;
}

export async function loadAdminOrganizations(
  tx: Prisma.TransactionClient,
  params: { search: string; limit: number; offset: number },
): Promise<AdminOrganizationRow[]> {
  // Casts explícitos: o Prisma manda número como int8, e a função é declarada
  // com `int`. Sem eles o Postgres não encontra a assinatura.
  return tx.$queryRaw<AdminOrganizationRow[]>`
    SELECT * FROM app_admin_organizations(${params.search}::text, ${params.limit}::int, ${params.offset}::int)
  `;
}

export interface AdminOrganizationDetailRow extends AdminOrganizationRow {
  trial_ends_at: Date | null;
  owner_email: string | null;
  storage_used_mb: bigint;
  overdue_cents: bigint;
}

export async function loadAdminOrganization(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<AdminOrganizationDetailRow | null> {
  const rows = await tx.$queryRaw<AdminOrganizationDetailRow[]>`
    SELECT * FROM app_admin_organization(${organizationId}::uuid)
  `;
  return rows[0] ?? null;
}
