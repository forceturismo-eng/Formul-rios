-- =============================================================================
-- Resolução de tenant a partir do webhook do gateway
--
-- Um webhook de pagamento chega sem token nosso e sem saber de qual empresa
-- ele é: o que ele traz é o id da assinatura NO GATEWAY. Descobrir a
-- organização exige ler `subscriptions`, que tem RLS — o mesmo problema de ovo
-- e galinha do ADR 0002, com a mesma solução.
--
-- O que autoriza a consulta não é conhecer o id, e sim o token do provedor,
-- verificado em tempo constante ANTES de a função ser chamada. A função em si
-- devolve apenas IDs; a fatura e a assinatura são lidas depois, já sob RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_subscription_org(p_provider_subscription_id text)
RETURNS TABLE (subscription_id uuid, organization_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.organization_id
    FROM subscriptions s
   WHERE s.provider_subscription_id = p_provider_subscription_id
$$;

COMMENT ON FUNCTION app_subscription_org(text) IS
  'Resolve a organização de uma assinatura pelo id do gateway. Usada só no processamento de webhook, depois de o token do provedor ser verificado.';

-- Quando o evento não traz a assinatura (cobrança avulsa), o caminho é o
-- cliente no gateway, guardado em billing_profiles.
CREATE OR REPLACE FUNCTION app_billing_customer_org(p_provider_customer_id text)
RETURNS TABLE (organization_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT b.organization_id
    FROM billing_profiles b
   WHERE b.provider_customer_id = p_provider_customer_id
$$;

COMMENT ON FUNCTION app_billing_customer_org(text) IS
  'Resolve a organização pelo id do cliente no gateway. Devolve apenas o id — nenhum dado fiscal.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    RAISE EXCEPTION 'Papel app_bootstrap não existe. Rode `npm run db:roles` antes das migrations.';
  END IF;

  -- Leitura mínima, só as colunas que as funções consultam estão nestas tabelas.
  GRANT SELECT ON subscriptions, billing_profiles TO app_bootstrap;

  ALTER FUNCTION app_subscription_org(text) OWNER TO app_bootstrap;
  ALTER FUNCTION app_billing_customer_org(text) OWNER TO app_bootstrap;

  REVOKE ALL ON FUNCTION app_subscription_org(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION app_billing_customer_org(text) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_subscription_org(text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_billing_customer_org(text) TO app_runtime;
  END IF;
END
$$;
