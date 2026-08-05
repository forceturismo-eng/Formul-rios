-- =============================================================================
-- RLS em admin_actions
--
-- A tabela tem `organization_id`, e a regra do projeto é que TODA tabela com
-- essa coluna tenha RLS habilitado e forçado — há um teste que trava isso.
--
-- Só que esta tabela não é do cliente. Ela é NOSSA: o registro do que os
-- operadores da plataforma fizeram nas contas dos outros. O cliente vê o que
-- lhe diz respeito no próprio `audit_logs`, com as entradas que gravamos lá de
-- propósito; ele não vê a trilha interna, que menciona outras empresas.
--
-- A política abaixo diz exatamente isso, em SQL:
--
--   visível SOMENTE quando não há contexto de tenant.
--
-- Um request de cliente sempre passa por `withTenant`, que faz o `SET LOCAL`.
-- Logo, `app_current_org_id()` nunca é nulo nele, e ele nunca enxerga uma linha
-- daqui. As rotas de admin não abrem contexto de tenant — e por isso enxergam.
--
-- O efeito colateral é útil: se alguém um dia ler esta tabela de dentro de um
-- request de cliente, por engano, o resultado é vazio em vez de vazamento.
-- =============================================================================

ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY admin_actions_sem_tenant ON admin_actions
  USING (app_current_org_id() IS NULL)
  WITH CHECK (app_current_org_id() IS NULL);

COMMENT ON POLICY admin_actions_sem_tenant ON admin_actions IS
  'Trilha da plataforma, não do cliente. Visível apenas fora de um contexto de tenant — dentro de um request de cliente, a tabela é vazia.';
