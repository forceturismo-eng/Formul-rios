-- =============================================================================
-- RLS para `exports`, e um helper para as próximas tabelas
--
-- A tabela `exports` guarda o pedido de exportação de respostas — o dado mais
-- sensível que o cliente confia à plataforma. Ela tem organization_id, logo
-- precisa de RLS. Não é opcional e não é decisão de quem cria a tabela.
--
-- Como aplicar as quatro linhas de RLS à mão é justamente o tipo de coisa que
-- alguém esquece numa migration futura, este arquivo também deixa a função
-- `app_enable_tenant_rls(text)`. Tabela nova passa a ser uma linha:
--
--     SELECT app_enable_tenant_rls('minha_tabela');
--
-- O teste em tests/isolation/rls-database.test.ts varre `information_schema` e
-- falha se aparecer tabela com organization_id sem FORCE RLS — ele é a rede de
-- segurança para quando alguém esquecer mesmo assim.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_enable_tenant_rls(p_table text) RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'A tabela % não tem organization_id — RLS de tenant não se aplica.', p_table;
  END IF;

  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I
       USING (organization_id = app_current_org_id())
       WITH CHECK (organization_id = app_current_org_id())', p_table);
END
$$;

COMMENT ON FUNCTION app_enable_tenant_rls(text) IS
  'Aplica ENABLE + FORCE RLS e a política tenant_isolation. Use em toda tabela nova com organization_id.';

SELECT app_enable_tenant_rls('exports');

-- `app_enable_tenant_rls` faz ALTER TABLE. É ferramenta de migration, e o papel
-- da aplicação não tem nada que a execute: uma aplicação capaz de mexer nas
-- próprias políticas de RLS não tem RLS.
REVOKE ALL ON FUNCTION app_enable_tenant_rls(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON exports TO app_runtime;
    REVOKE ALL ON FUNCTION app_enable_tenant_rls(text) FROM app_runtime;
  END IF;
END
$$;
