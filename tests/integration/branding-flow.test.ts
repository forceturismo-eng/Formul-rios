import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';

/**
 * White-label pela API.
 *
 * O que este arquivo prova e os unitários não: que o plano decide o que é
 * SERVIDO, e não o que está guardado; que o CSS chega ao renderizador público
 * já sanitizado; e que a marca do produto some quando o plano manda.
 */

const HOST = 'localhost';
let token: string;
let slug: string;
let planoOriginal: string;

async function api(method: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

async function formularioPublico() {
  const app = await getApp();
  const resposta = await app.inject({ method: 'GET', url: `/f/${slug}`, headers: { host: HOST } });
  return resposta.json() as {
    customCss: string;
    showBranding: boolean;
    productName: string;
    organization: { logoUrl: string | null; faviconUrl: string | null; primaryColor: string | null };
    meta: { title: string; tags: Array<{ key: string; content: string }> };
  };
}

async function trocarPlano(planCode: string) {
  await withTenant(ORG_A.id, ({ tx }) =>
    tx.organization.update({ where: { id: ORG_A.id }, data: { planCode } }),
  );
}

beforeAll(async () => {
  token = (await loginAs(ORG_A.owner)).accessToken;

  const dados = await withTenant(ORG_A.id, async ({ tx }) => {
    const organizacao = await tx.organization.findFirstOrThrow({ select: { planCode: true } });
    const form = await tx.form.findFirstOrThrow({
      where: { status: 'published', deletedAt: null },
      select: { slugPublic: true },
    });
    return { planCode: organizacao.planCode, slug: form.slugPublic };
  });

  planoOriginal = dados.planCode;
  slug = dados.slug;
});

afterEach(async () => {
  // Cada caso mexe no plano e no branding; o próximo começa limpo.
  await withTenant(ORG_A.id, ({ tx }) =>
    tx.organization.update({
      where: { id: ORG_A.id },
      data: {
        planCode: planoOriginal,
        // A cor entra aqui também: sem ela, a empresa do seed ficava com a cor
        // do último caso que rodou.
        primaryColor: '#2563eb',
        customCss: null,
        logoUrl: null,
        faviconUrl: null,
        ogImageUrl: null,
        metaTitle: null,
        metaDescription: null,
      },
    }),
  );
});

afterAll(closeApp);

describe('gravação', () => {
  it('salva e devolve o que foi salvo', async () => {
    const resposta = await api('PATCH', '/v1/branding', {
      logoUrl: 'https://cdn.alfa.test/logo.png',
      primaryColor: '#0f766e',
      metaTitle: 'Fale com a Alfa',
      metaDescription: 'Respondemos no mesmo dia.',
    });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({
      logoUrl: 'https://cdn.alfa.test/logo.png',
      primaryColor: '#0f766e',
      metaTitle: 'Fale com a Alfa',
    });
  });

  it('recusa imagem que não seja https', async () => {
    // http numa página https vira aviso de conteúdo misto no navegador de quem
    // responde — e a página é do cliente.
    const resposta = await api('PATCH', '/v1/branding', { logoUrl: 'http://cdn.alfa.test/logo.png' });

    expect(resposta.statusCode).toBe(422);
    expect(JSON.stringify(resposta.json())).toContain('https');
  });

  it('recusa cor fora do formato', async () => {
    expect((await api('PATCH', '/v1/branding', { primaryColor: 'red' })).statusCode).toBe(422);
    expect((await api('PATCH', '/v1/branding', { primaryColor: 'url(https://x)' })).statusCode).toBe(422);
  });

  it('null limpa o campo', async () => {
    await api('PATCH', '/v1/branding', { logoUrl: 'https://cdn.alfa.test/logo.png' });
    const limpo = await api('PATCH', '/v1/branding', { logoUrl: null });

    expect((limpo.json() as { logoUrl: string | null }).logoUrl).toBeNull();
  });

  it('string vazia também limpa, em vez de gravar vazio', async () => {
    await api('PATCH', '/v1/branding', { metaTitle: 'Alguma coisa' });
    const limpo = await api('PATCH', '/v1/branding', { metaTitle: '   ' });

    expect((limpo.json() as { metaTitle: string | null }).metaTitle).toBeNull();
  });
});

describe('CSS customizado e plano', () => {
  it('plano sem CSS customizado recusa a gravação', async () => {
    // Recusamos gravar, e não só renderizar: deixar salvar algo que nunca vai
    // aparecer é prometer o que o plano não entrega.
    await trocarPlano('starter');
    const resposta = await api('PATCH', '/v1/branding', { customCss: '.cartao { border-radius: 16px }' });

    expect(resposta.statusCode).toBe(402);
    expect(resposta.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('plano Business grava e o renderizador serve sanitizado', async () => {
    await trocarPlano('business');

    await api('PATCH', '/v1/branding', {
      customCss: '.cartao { border-radius: 16px; position: fixed; background: url(https://atacante.test/p) }',
    });

    const publico = await formularioPublico();

    expect(publico.customCss).toContain('border-radius: 16px;');
    expect(publico.customCss).not.toContain('position');
    expect(publico.customCss).not.toContain('url');
    // A propriedade que sustenta tudo: sem `<`, não existe `</style>`.
    expect(publico.customCss).not.toContain('<');
  });

  it('o painel devolve o CSS cru, para o cliente poder editar', async () => {
    await trocarPlano('business');
    const escrito = '.cartao { border-radius: 16px; position: fixed }';
    await api('PATCH', '/v1/branding', { customCss: escrito });

    const visao = (await api('GET', '/v1/branding')).json() as {
      branding: { customCss: string };
      preview: { css: string; removidos: string[] };
    };

    // Cru no editor — filtrar o texto que ele está editando seria apagar o
    // trabalho dele a cada gravação.
    expect(visao.branding.customCss).toBe(escrito);
    // E a prévia diz o que de fato vai ao ar.
    expect(visao.preview.css).not.toContain('position');
    expect(visao.preview.removidos.join(' ')).toContain('position');
  });

  it('baixar de plano para de servir o CSS, mas não o apaga', async () => {
    await trocarPlano('business');
    await api('PATCH', '/v1/branding', { customCss: '.cartao { border-radius: 16px }' });

    await trocarPlano('starter');

    // Sumiu da página…
    expect((await formularioPublico()).customCss).toBe('');

    // …e continua no banco, para voltar inteiro se o cliente reassinar.
    const guardado = await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.findFirstOrThrow({ select: { customCss: true } }),
    );
    expect(guardado.customCss).toContain('border-radius');
  });

  it('a prévia explica o que seria removido antes de gravar', async () => {
    const resposta = await api('POST', '/v1/branding/preview-css', {
      css: '.a { color: #000000; position: fixed }',
    });

    const corpo = resposta.json() as { css: string; removidos: string[] };
    expect(corpo.css).toContain('color: #000000;');
    expect(corpo.removidos.join(' ')).toContain('position');
  });
});

describe('marca do produto no formulário público', () => {
  it('plano Starter mantém o rodapé e o nome do produto', async () => {
    await trocarPlano('starter');
    const publico = await formularioPublico();

    expect(publico.showBranding).toBe(true);
    expect(publico.productName).not.toBe('');
    expect(publico.meta.title).toContain(publico.productName);
  });

  it('plano Pro some com a marca — inclusive do JSON', async () => {
    // Seção 12: nada menciona a plataforma quando o white-label está ativo. Não
    // basta esconder na tela: o respondente pode abrir o inspetor.
    await trocarPlano('pro');
    const publico = await formularioPublico();

    expect(publico.showBranding).toBe(false);
    expect(publico.productName).toBe('');
    expect(JSON.stringify(publico)).not.toContain('Formulários criado com');
  });
});

describe('meta tags no formulário público', () => {
  it('usa o título próprio quando ele existe', async () => {
    await api('PATCH', '/v1/branding', { metaTitle: 'Fale com a Alfa' });
    const publico = await formularioPublico();

    expect(publico.meta.title).toContain('Fale com a Alfa');
    expect(publico.meta.tags.find((t) => t.key === 'og:title')?.content).toBe('Fale com a Alfa');
  });

  it('marca noindex sempre', async () => {
    const publico = await formularioPublico();
    expect(publico.meta.tags.find((t) => t.key === 'robots')?.content).toContain('noindex');
  });

  it('leva o favicon para o renderizador', async () => {
    await api('PATCH', '/v1/branding', { faviconUrl: 'https://cdn.alfa.test/icone.png' });
    expect((await formularioPublico()).organization.faviconUrl).toBe('https://cdn.alfa.test/icone.png');
  });
});

describe('HTML para robô de prévia de link', () => {
  it('quem pede JSON continua recebendo JSON', async () => {
    // O robô do WhatsApp pede text/html; a SPA e os testes pedem JSON. Os dois
    // caminhos convivem na mesma rota.
    const app = await getApp();
    const resposta = await app.inject({
      method: 'GET',
      url: `/f/${slug}`,
      headers: { host: HOST, accept: 'application/json' },
    });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toHaveProperty('definition');
  });

  it('a resposta varia por Accept', async () => {
    // Sem `Vary: Accept`, um cache compartilhado serviria HTML a quem pediu
    // JSON — e vice-versa.
    const app = await getApp();
    const resposta = await app.inject({ method: 'GET', url: `/f/${slug}`, headers: { host: HOST } });

    expect(resposta.headers['vary']).toContain('Accept');
  });

  // O shell só existe depois de `npm run build -w @forms/web`. Sem ele a rota
  // devolve JSON, que é o comportamento de desenvolvimento — e é por isso que
  // o caso é condicional em vez de exigir o build antes dos testes.
  const temShell = existsSync(resolve(process.cwd(), 'apps/web/dist/index.html'));

  it.skipIf(!temShell)('quem pede HTML recebe o head já preenchido', async () => {
    await api('PATCH', '/v1/branding', {
      metaTitle: 'Fale com a Alfa',
      faviconUrl: 'https://cdn.alfa.test/icone.png',
    });

    const app = await getApp();
    const resposta = await app.inject({
      method: 'GET',
      url: `/f/${slug}`,
      // O que o robô de prévia do WhatsApp manda.
      headers: { host: HOST, accept: 'text/html,application/xhtml+xml,*/*' },
    });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.headers['content-type']).toContain('text/html');

    expect(resposta.body).toContain('<title>Fale com a Alfa');
    expect(resposta.body).toContain('property="og:title" content="Fale com a Alfa"');
    expect(resposta.body).toContain('rel="icon" href="https://cdn.alfa.test/icone.png"');
    // `og:url` depende do host do request — o mesmo formulário responde no
    // nosso domínio e no do cliente.
    expect(resposta.body).toContain(`content="https://${HOST}/f/${slug}"`);

    // O título original do shell precisa SAIR: dois títulos no documento fazem
    // o robô escolher, e ele escolhe o primeiro.
    expect(resposta.body.match(/<title>/g)).toHaveLength(1);

    // E o bundle da SPA continua lá, senão a página não renderiza para gente.
    expect(resposta.body).toContain('id="root"');
    expect(resposta.body).toContain('<script type="module"');
  });
});
