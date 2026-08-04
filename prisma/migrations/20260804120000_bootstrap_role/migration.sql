-- =============================================================================
-- Papel dono das funções de bootstrap
--
-- POR QUE ISTO EXISTE
--
-- A migration anterior criou três funções SECURITY DEFINER para resolver o
-- problema de ovo e galinha do multi-tenant (descobrir a organização de um
-- request exige ler tabelas protegidas por organização).
--
-- Só que SECURITY DEFINER não desliga RLS: ele apenas troca o usuário que
-- executa. E como todas as tabelas usam FORCE ROW LEVEL SECURITY, nem o dono
-- escapa das políticas. Com as funções pertencendo a `app_migrator`, elas
-- devolviam zero linhas — e o login não encontrava membership nenhuma.
--
-- A saída é um papel dedicado, `app_bootstrap`, criado pelo bootstrap de
-- papéis com:
--   NOLOGIN   — nenhuma conexão se autentica como ele;
--   BYPASSRLS — é o único papel do sistema com esse atributo.
--
-- O que mantém isso seguro:
--   1. Ele só recebe SELECT nas QUATRO tabelas de que as funções precisam.
--      Nada de formulários, respostas, arquivos, faturas ou logs.
--   2. `app_runtime` não é membro dele. A aplicação não consegue `SET ROLE`
--      para ganhar BYPASSRLS — só pode executar as três funções.
--   3. Nenhuma das funções aceita `organization_id` como entrada. Não existe
--      forma de pedir "os dados do tenant X"; só "os dados de QUEM já provou
--      posse desta credencial".
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  -- O Postgres exige que o dono de um objeto tenha CREATE no schema onde ele
  -- vive. Conceder aqui, e não só no bootstrap de papéis, torna a migration
  -- autossuficiente — o shadow database do `prisma migrate dev` é recriado do
  -- zero a cada execução e perderia qualquer grant feito fora daqui.
  GRANT USAGE, CREATE ON SCHEMA public TO app_bootstrap;

  -- Privilégio mínimo: apenas leitura, apenas nas tabelas que as funções tocam.
  GRANT SELECT ON organizations, memberships, invitations, refresh_tokens TO app_bootstrap;

  ALTER FUNCTION app_user_memberships(uuid) OWNER TO app_bootstrap;
  ALTER FUNCTION app_invitation_org(text)   OWNER TO app_bootstrap;
  ALTER FUNCTION app_refresh_token_org(text) OWNER TO app_bootstrap;

  -- Trocar o dono zera os privilégios de execução; reconcedê-los é obrigatório.
  REVOKE ALL ON FUNCTION app_user_memberships(uuid)  FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_invitation_org(text)    FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_refresh_token_org(text) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_user_memberships(uuid)  TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_invitation_org(text)    TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_refresh_token_org(text) TO app_runtime;
  END IF;
END
$$;
