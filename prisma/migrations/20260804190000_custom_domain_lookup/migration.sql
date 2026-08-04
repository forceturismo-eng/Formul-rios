-- =============================================================================
-- Resolução de tenant por domínio de cliente
--
-- Quem chega em formularios.empresa.com.br é um respondente anônimo, e o único
-- dado que o request carrega é o header `Host`. Descobrir de qual organização é
-- aquele domínio exige ler `custom_domains`, que tem RLS — o mesmo problema de
-- ovo e galinha do ADR 0002.
--
-- Também é esta função que o endpoint `ask` do Caddy consulta antes de emitir
-- certificado. Ela devolve o estado da organização junto, porque a autorização
-- depende dele: domínio de cliente suspenso não ganha certificado novo.
--
-- Devolve apenas IDs e estado. Branding, formulários e respostas são lidos
-- depois, já sob RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_custom_domain_org(p_domain text)
RETURNS TABLE (
  domain_id uuid,
  organization_id uuid,
  domain_status custom_domain_status,
  subscription_status subscription_status,
  organization_deleted boolean
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT d.id,
         d.organization_id,
         d.status,
         o.subscription_status,
         (o.deleted_at IS NOT NULL)
    FROM custom_domains d
    JOIN organizations o ON o.id = d.organization_id
   WHERE d.domain = lower(p_domain)
$$;

COMMENT ON FUNCTION app_custom_domain_org(text) IS
  'Resolve a organização de um domínio de cliente. Usada no renderizador público e no endpoint ask do Caddy.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  GRANT SELECT ON custom_domains TO app_bootstrap;

  ALTER FUNCTION app_custom_domain_org(text) OWNER TO app_bootstrap;
  REVOKE ALL ON FUNCTION app_custom_domain_org(text) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_custom_domain_org(text) TO app_runtime;
  END IF;
END
$$;
