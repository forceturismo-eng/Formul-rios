/**
 * Marca e domínios do produto.
 *
 * Os marcadores [PRODUTO], [DOMINIO_APP] e [DOMINIO_CNAME] do documento de
 * produto vivem aqui e vêm do ambiente. Trocar o nome comercial ou os domínios
 * é uma mudança de `.env`, não de código.
 */

export interface Branding {
  /** [PRODUTO] */
  productName: string;
  /** [DOMINIO_APP] — login, painel e API autenticada. Só aqui. */
  appDomain: string;
  /** [DOMINIO_CNAME] — alvo do CNAME dos domínios de clientes. */
  cnameDomain: string;
  appUrl: string;
}

export const BRANDING_DEFAULTS: Branding = {
  productName: 'Formulários',
  appDomain: 'app.formularios.local',
  cnameDomain: 'custom.formularios.local',
  appUrl: 'http://localhost:5173',
};

type EnvSource = Record<string, string | undefined>;

export function resolveBranding(env: EnvSource): Branding {
  return {
    productName: env.PRODUCT_NAME?.trim() || BRANDING_DEFAULTS.productName,
    appDomain: normalizeHost(env.APP_DOMAIN) || BRANDING_DEFAULTS.appDomain,
    cnameDomain: normalizeHost(env.CNAME_DOMAIN) || BRANDING_DEFAULTS.cnameDomain,
    appUrl: env.APP_URL?.trim().replace(/\/+$/, '') || BRANDING_DEFAULTS.appUrl,
  };
}

/** lowercase, sem protocolo, sem porta, sem path, sem ponto final. */
export function normalizeHost(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}
