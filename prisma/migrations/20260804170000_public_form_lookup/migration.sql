-- =============================================================================
-- Resolução pública de formulário por slug
--
-- O renderizador público não tem token: quem chega em /f/<slug> é um
-- respondente anônimo. Mas `forms` tem RLS, então descobrir a organização do
-- formulário é o mesmo problema de ovo e galinha do ADR 0002.
--
-- Mesma solução, mesmas restrições: função SECURITY DEFINER pertencente a
-- `app_bootstrap`, que NÃO aceita organization_id como entrada e devolve
-- apenas o mínimo para setar o contexto.
--
-- O slug é público por natureza — está na URL que o cliente divulga. Conhecê-lo
-- não é credencial, e por isso a função devolve só IDs e o estado de
-- publicação: nada de schema, título ou configuração. Esse conteúdo é lido
-- depois, já sob RLS, e só se o formulário estiver realmente publicado.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_public_form_org(p_slug text)
RETURNS TABLE (form_id uuid, organization_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT f.id, f.organization_id
    FROM forms f
   WHERE f.slug_public = p_slug
     AND f.deleted_at IS NULL
     AND f.status = 'published'
$$;

COMMENT ON FUNCTION app_public_form_org(text) IS
  'Resolve a organização de um formulário público pelo slug. Devolve apenas IDs, e só para formulários publicados.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  -- Leitura mínima: só a tabela que a função consulta.
  GRANT SELECT ON forms TO app_bootstrap;

  ALTER FUNCTION app_public_form_org(text) OWNER TO app_bootstrap;
  REVOKE ALL ON FUNCTION app_public_form_org(text) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_public_form_org(text) TO app_runtime;
  END IF;
END
$$;
