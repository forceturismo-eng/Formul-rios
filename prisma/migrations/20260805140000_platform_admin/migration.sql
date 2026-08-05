-- =============================================================================
-- Admin da plataforma (seção 5.5)
--
-- Duas tabelas novas e um conjunto de funções de agregação. A decisão que
-- organiza este arquivo:
--
--   O admin NÃO lê linhas de clientes. Ele lê AGREGADOS.
--
-- MRR, churn, inadimplência e uso são somas e contagens. Servi-los por funções
-- SECURITY DEFINER que só sabem devolver agregado significa que, mesmo com um
-- bug nas rotas de admin, não existe caminho por onde conteúdo de resposta
-- saia — a função não tem como devolvê-lo.
--
-- A lista de organizações devolve metadado (nome, plano, estado, contagens),
-- nunca conteúdo. Ver formulário ou resposta de cliente exige impersonar, e
-- impersonar deixa rastro.
-- =============================================================================

CREATE TABLE platform_admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          varchar(254) NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  name           varchar(160) NOT NULL,

  totp_secret      text,
  totp_enabled_at  timestamptz,
  last_totp_window bigint,

  last_login_at timestamptz,
  disabled_at   timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_admins IS
  'Operadores do SaaS. Tabela separada de users: um bug na autenticação de cliente não pode virar acesso de admin.';

CREATE TABLE admin_actions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,

  action          varchar(80) NOT NULL,
  -- Sem FK de propósito: apagar a empresa não pode apagar o registro de que
  -- alguém mexeu nela.
  organization_id uuid,

  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash       text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_actions_admin_idx ON admin_actions (admin_id, created_at DESC);
CREATE INDEX admin_actions_org_idx ON admin_actions (organization_id, created_at DESC);

COMMENT ON TABLE admin_actions IS
  'O que os nossos operadores fizeram nas empresas dos clientes. Append-only.';

-- -----------------------------------------------------------------------------
-- Append-only, como audit_logs
--
-- Trilha que o próprio operador pode editar não é trilha. O papel da aplicação
-- insere e lê; UPDATE e DELETE não são concedidos a ninguém que faça login.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admins TO app_runtime;
    GRANT SELECT, INSERT ON admin_actions TO app_runtime;
    REVOKE UPDATE, DELETE ON admin_actions FROM app_runtime;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Agregados da plataforma
--
-- Estas funções atravessam organizações — é o trabalho delas. O que as torna
-- aceitáveis é o formato do retorno: número, nunca conteúdo.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_admin_metrics()
RETURNS TABLE (
  organizations_total        bigint,
  organizations_active       bigint,
  organizations_trialing     bigint,
  organizations_suspended    bigint,
  organizations_canceled     bigint,
  mrr_cents                  bigint,
  invoices_overdue           bigint,
  invoices_overdue_cents     bigint,
  responses_last_30_days     bigint,
  canceled_last_30_days      bigint
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM organizations WHERE deleted_at IS NULL),
    (SELECT count(*) FROM organizations WHERE deleted_at IS NULL AND subscription_status = 'active'),
    (SELECT count(*) FROM organizations WHERE deleted_at IS NULL AND subscription_status = 'trialing'),
    (SELECT count(*) FROM organizations WHERE deleted_at IS NULL AND subscription_status = 'suspended'),
    (SELECT count(*) FROM organizations WHERE deleted_at IS NULL AND subscription_status = 'canceled'),
    -- MRR: assinatura anual entra dividida por 12, senão o mês em que ela é
    -- cobrada parece um salto e os outros onze parecem queda.
    (SELECT coalesce(sum(
        CASE s.cycle
          WHEN 'annual'     THEN s.amount_cents / 12
          WHEN 'semiannual' THEN s.amount_cents / 6
          ELSE s.amount_cents
        END
      ), 0)::bigint
       FROM subscriptions s
       JOIN organizations o ON o.id = s.organization_id
      WHERE s.status = 'active' AND o.deleted_at IS NULL),
    (SELECT count(*) FROM invoices WHERE status = 'overdue'),
    (SELECT coalesce(sum(amount_cents), 0)::bigint FROM invoices WHERE status = 'overdue'),
    (SELECT count(*) FROM responses WHERE deleted_at IS NULL AND created_at > now() - interval '30 days'),
    (SELECT count(*) FROM subscriptions
      WHERE status = 'canceled' AND canceled_at IS NOT NULL AND canceled_at > now() - interval '30 days')
$$;

COMMENT ON FUNCTION app_admin_metrics() IS
  'Agregados da plataforma para o painel de admin. Devolve apenas números — nenhum conteúdo de cliente.';

CREATE OR REPLACE FUNCTION app_admin_organizations(p_search text, p_limit int, p_offset int)
RETURNS TABLE (
  id                  uuid,
  name                varchar(160),
  slug                varchar(80),
  plan_code           varchar(40),
  subscription_status subscription_status,
  created_at          timestamptz,
  members_count       bigint,
  forms_count         bigint,
  responses_count     bigint,
  overdue_count       bigint
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT
    o.id, o.name, o.slug, o.plan_code, o.subscription_status, o.created_at,
    (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id),
    (SELECT count(*) FROM forms f WHERE f.organization_id = o.id AND f.deleted_at IS NULL),
    (SELECT count(*) FROM responses r WHERE r.organization_id = o.id AND r.deleted_at IS NULL),
    (SELECT count(*) FROM invoices i WHERE i.organization_id = o.id AND i.status = 'overdue')
  FROM organizations o
  WHERE o.deleted_at IS NULL
    AND (
      p_search IS NULL OR p_search = ''
      OR o.name ILIKE '%' || p_search || '%'
      OR o.slug ILIKE '%' || p_search || '%'
    )
  ORDER BY o.created_at DESC
  LIMIT least(coalesce(p_limit, 50), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

COMMENT ON FUNCTION app_admin_organizations(text, int, int) IS
  'Lista de empresas com metadado e contagens. Nunca conteúdo — ver dado de cliente exige impersonar, e impersonar deixa rastro.';

-- -----------------------------------------------------------------------------
-- Uma organização, para a tela de detalhe
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_admin_organization(p_organization_id uuid)
RETURNS TABLE (
  id                  uuid,
  name                varchar(160),
  slug                varchar(80),
  plan_code           varchar(40),
  subscription_status subscription_status,
  trial_ends_at       timestamptz,
  created_at          timestamptz,
  owner_email         varchar(254),
  members_count       bigint,
  forms_count         bigint,
  responses_count     bigint,
  storage_used_mb     bigint,
  overdue_cents       bigint
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT
    o.id, o.name, o.slug, o.plan_code, o.subscription_status, o.trial_ends_at, o.created_at,
    (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
    (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id),
    (SELECT count(*) FROM forms f WHERE f.organization_id = o.id AND f.deleted_at IS NULL),
    (SELECT count(*) FROM responses r WHERE r.organization_id = o.id AND r.deleted_at IS NULL),
    (SELECT coalesce(max(uc.storage_used_mb), 0)::bigint FROM usage_counters uc WHERE uc.organization_id = o.id),
    (SELECT coalesce(sum(i.amount_cents), 0)::bigint FROM invoices i
      WHERE i.organization_id = o.id AND i.status = 'overdue')
  FROM organizations o
  WHERE o.id = p_organization_id AND o.deleted_at IS NULL
$$;

COMMENT ON FUNCTION app_admin_organization(uuid) IS
  'Detalhe de uma empresa para o admin. Metadado e contagens; o e-mail do owner é o único dado pessoal, e existe para o suporte conseguir responder a quem abriu o chamado.';

-- -----------------------------------------------------------------------------
-- Dono e execução
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  -- As funções precisam ler tabelas com RLS, e SECURITY DEFINER sozinho não
  -- vence FORCE ROW LEVEL SECURITY (ADR 0002). Daí o dono ser app_bootstrap.
  GRANT SELECT ON organizations, subscriptions, invoices, responses, memberships, forms, usage_counters, users
    TO app_bootstrap;

  ALTER FUNCTION app_admin_metrics() OWNER TO app_bootstrap;
  ALTER FUNCTION app_admin_organizations(text, int, int) OWNER TO app_bootstrap;
  ALTER FUNCTION app_admin_organization(uuid) OWNER TO app_bootstrap;

  REVOKE ALL ON FUNCTION app_admin_metrics() FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_admin_organizations(text, int, int) FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_admin_organization(uuid) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_admin_metrics() TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_admin_organizations(text, int, int) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_admin_organization(uuid) TO app_runtime;
  END IF;
END
$$;
