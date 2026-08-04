-- =============================================================================
-- ISOLAMENTO DE DADOS — Row Level Security
--
-- Esta migration é a segunda das quatro camadas de isolamento (seção 1 do
-- documento de produto). As outras três — coluna obrigatória, contexto de
-- request e camada de repositório — estão no schema e no código da API.
--
-- Ela é escrita à mão de propósito: o Prisma não modela políticas de RLS, e
-- deixar isso "para o deploy" significa não ter isolamento nenhum em dev, que
-- é exatamente onde o bug nasce.
--
-- Roda como `app_migrator` (dono das tabelas). O papel de runtime é
-- `app_runtime`, sem BYPASSRLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Contexto do tenant
--
-- `current_setting('app.current_org_id', true)` devolve NULL quando a variável
-- nunca foi setada, mas devolve '' (string vazia) depois de um
-- `set_config(..., '', true)` — e ''::uuid levanta exceção. O NULLIF normaliza
-- os dois casos para NULL.
--
-- Com NULL, toda comparação `organization_id = NULL` é NULL, que a política
-- trata como falso: query sem contexto enxerga ZERO linhas, nunca a base
-- inteira. Esse é o comportamento exigido pelos testes de isolamento.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_org_id() IS
  'Organização da transação atual. NULL quando não há contexto — o que faz as políticas de RLS não devolverem linha alguma.';

-- -----------------------------------------------------------------------------
-- Políticas por tabela
--
-- USING controla o que a transação enxerga (SELECT/UPDATE/DELETE).
-- WITH CHECK controla o que ela pode gravar (INSERT/UPDATE) — sem ele, um bug
-- conseguiria inserir uma linha carimbada com o organization_id de outra empresa.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'memberships',
    'invitations',
    'refresh_tokens',
    'subscriptions',
    'billing_profiles',
    'invoices',
    'dunning_log',
    'addon_purchases',
    'usage_counters',
    'forms',
    'form_versions',
    'form_permissions',
    'responses',
    'files',
    'comments',
    'assignments',
    'ai_analyses',
    'api_keys',
    'webhooks',
    'webhook_deliveries',
    'custom_domains',
    'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE faz a política valer inclusive para o DONO da tabela. Sem isso,
    -- migrations e seeds rodariam sem isolamento e nada avisaria.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (organization_id = app_current_org_id())
         WITH CHECK (organization_id = app_current_org_id())', t);
  END LOOP;
END
$$;

-- `organizations` é a raiz do tenant: a coluna que identifica a empresa é `id`.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (id = app_current_org_id())
  WITH CHECK (id = app_current_org_id());

-- -----------------------------------------------------------------------------
-- Tabelas globais — sem RLS, por decisão registrada em docs/adr/0001.
--
--   users, email_verification_tokens  -> a pessoa existe antes de qualquer
--        empresa e pode pertencer a várias. O acesso é sempre por chave própria
--        (id do usuário autenticado, hash de token), nunca por varredura. Listar
--        membros de uma empresa passa por `memberships`, que TEM RLS.
--   plans          -> catálogo público. Runtime só lê.
--   payment_events -> chega do gateway antes de sabermos o tenant.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Funções de bootstrap (SECURITY DEFINER)
--
-- Existe um problema de ovo e galinha: para descobrir a organização de um
-- request, é preciso ler tabelas que já estão protegidas por organização.
--
-- A saída NÃO é dar BYPASSRLS ao runtime nem abrir exceção nas políticas. São
-- estas três funções, cada uma respondendo a uma única pergunta e exigindo que
-- quem chama já tenha provado posse de uma credencial (id do usuário
-- autenticado, hash de token de convite, hash de refresh token).
--
-- Nenhuma delas aceita `organization_id` como entrada, então nenhuma pode ser
-- usada para pescar dados de um tenant escolhido pelo atacante.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_user_memberships(p_user_id uuid)
RETURNS TABLE (
  organization_id uuid,
  role role,
  accepted_at timestamptz,
  organization_name varchar,
  organization_slug varchar,
  plan_code varchar,
  subscription_status subscription_status,
  logo_url text,
  primary_color varchar
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT m.organization_id,
         m.role,
         m.accepted_at,
         o.name,
         o.slug,
         o.plan_code,
         o.subscription_status,
         o.logo_url,
         o.primary_color
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
   WHERE m.user_id = p_user_id
     AND o.deleted_at IS NULL
   ORDER BY m.created_at ASC
$$;

COMMENT ON FUNCTION app_user_memberships(uuid) IS
  'Empresas de UM usuário. Usada no login e na troca de workspace, antes de existir contexto de tenant.';

CREATE OR REPLACE FUNCTION app_invitation_org(p_token_hash text)
RETURNS TABLE (invitation_id uuid, organization_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.organization_id
    FROM invitations i
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.expires_at > now()
$$;

COMMENT ON FUNCTION app_invitation_org(text) IS
  'Resolve a organização de um convite a partir do hash do token. Devolve apenas os IDs — o conteúdo do convite é lido depois, já sob RLS.';

CREATE OR REPLACE FUNCTION app_refresh_token_org(p_token_hash text)
RETURNS TABLE (token_id uuid, organization_id uuid, user_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT rt.id, rt.organization_id, rt.user_id
    FROM refresh_tokens rt
   WHERE rt.token_hash = p_token_hash
$$;

COMMENT ON FUNCTION app_refresh_token_org(text) IS
  'Resolve a organização de um refresh token. Devolve o token mesmo revogado ou expirado: a detecção de reuso precisa enxergar tokens já queimados.';

-- -----------------------------------------------------------------------------
-- Privilégios do papel de runtime
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_current_org_id() TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_user_memberships(uuid) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_invitation_org(text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_refresh_token_org(text) TO app_runtime;

    -- Audit log é append-only. Um log que pode ser reescrito não é auditoria.
    -- A garantia é a ausência do privilégio, não uma regra da aplicação.
    REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime;

    -- Catálogo de planos: leitura apenas. Quem escreve é o seed, via migrator.
    REVOKE INSERT, UPDATE, DELETE ON plans FROM app_runtime;

    -- O runtime não tem por que enxergar o histórico de migrations.
    REVOKE ALL ON "_prisma_migrations" FROM app_runtime;
  END IF;
END
$$;
