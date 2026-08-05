-- =============================================================================
-- Resolução de tenant a partir de uma chave de API
--
-- Um request da API pública chega com `Authorization: Bearer fx_live_...` e
-- nada mais. Descobrir de qual organização é a chave exige ler `api_keys`, que
-- tem RLS — mesmo problema de ovo e galinha do ADR 0002.
--
-- O que autoriza a consulta é a posse da própria chave: a função recebe o HASH
-- dela, e só quem tem o segredo consegue produzir esse hash. Ela devolve
-- apenas o id da organização, os escopos e o estado — o resto é lido depois,
-- já sob RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_api_key_org(p_key_hash text)
RETURNS TABLE (
  api_key_id uuid,
  organization_id uuid,
  scopes text[],
  revoked_at timestamptz,
  expires_at timestamptz,
  subscription_status subscription_status
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.organization_id, k.scopes, k.revoked_at, k.expires_at, o.subscription_status
    FROM api_keys k
    JOIN organizations o ON o.id = k.organization_id
   WHERE k.key_hash = p_key_hash
     AND o.deleted_at IS NULL
$$;

COMMENT ON FUNCTION app_api_key_org(text) IS
  'Resolve a organização de uma chave de API pelo hash. Devolve revoked_at e expires_at para quem chama decidir — a função não filtra, para o motivo da recusa ficar registrável.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  GRANT SELECT ON api_keys TO app_bootstrap;

  ALTER FUNCTION app_api_key_org(text) OWNER TO app_bootstrap;
  REVOKE ALL ON FUNCTION app_api_key_org(text) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_api_key_org(text) TO app_runtime;
  END IF;
END
$$;
