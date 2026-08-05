-- =============================================================================
-- White-label por organização (seção 8.5)
--
-- Título da aba, prévia do link e CSS customizado. Nenhuma coluna nova precisa
-- de política de RLS própria: elas ficam em `organizations`, que já tem RLS
-- habilitado e forçado desde a migration de políticas.
--
-- `custom_css` guarda o texto CRU, como o cliente escreveu. A sanitização
-- acontece a cada renderização, não na gravação — se a lista de propriedades
-- permitidas mudar, o que já está no banco passa pela lista nova sem
-- precisarmos reescrever linha nenhuma.
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN meta_title       varchar(120),
  ADD COLUMN meta_description varchar(200),
  ADD COLUMN og_image_url     text,
  ADD COLUMN custom_css       text;

-- Teto no banco também, e não só na validação da aplicação: o sanitizador corta
-- o excesso, mas uma folha de 5 MB gravada por outro caminho seria um problema
-- de memória antes de chegar nele.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_custom_css_tamanho CHECK (length(custom_css) <= 20000);

COMMENT ON COLUMN organizations.custom_css IS
  'CSS do cliente, cru. Sanitizado por sanitizeCustomCss a cada renderização — nunca servido como está.';
