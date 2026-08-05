import type { FastifyInstance } from 'fastify';
import { buildOpenApiDocument } from '../http/openapi.js';
import { env } from '../config/env.js';

/**
 * Documentação da API.
 *
 * `/openapi.json` serve o documento; `/docs` serve um visualizador que cabe
 * neste arquivo.
 *
 * Não usamos Swagger UI. Ela traz um bundle grande e, do jeito que costuma ser
 * instalada, carrega de CDN — o que a nossa própria CSP bloquearia. Um
 * visualizador de trezentas linhas, servido da mesma origem, resolve o
 * problema real: alguém abrir a URL e entender a API.
 *
 * O documento é montado a cada request, de propósito: ele é derivado das
 * constantes do código, e cachear introduziria uma versão que pode divergir
 * daquilo que a aplicação faz.
 */
export async function docsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async (_request, reply) => {
    void reply.header('Cache-Control', 'public, max-age=300');
    return buildOpenApiDocument();
  });

  app.get('/docs', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8');
    // `default-src 'none'` com exceções mínimas: a página só precisa do próprio
    // script inline e de buscar o JSON da mesma origem.
    void reply.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    );

    return PAGINA;
  });
}

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API — ${env.branding.productName}</title>
<style>
  :root { color-scheme: light dark; --texto: #0f172a; --suave: #64748b; --borda: #e2e8f0; --fundo: #ffffff; --caixa: #f8fafc; }
  @media (prefers-color-scheme: dark) {
    :root { --texto: #e2e8f0; --suave: #94a3b8; --borda: #334155; --fundo: #0f172a; --caixa: #1e293b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--texto); background: var(--fundo); }
  .casca { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
  nav { border-right: 1px solid var(--borda); padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  nav h1 { font-size: 16px; margin: 0 0 16px; }
  nav a { display: block; padding: 5px 8px; color: var(--suave); text-decoration: none; border-radius: 6px; font-size: 14px; }
  nav a:hover { background: var(--caixa); color: var(--texto); }
  main { padding: 32px 40px; max-width: 900px; }
  h2 { margin-top: 40px; padding-top: 8px; border-top: 1px solid var(--borda); }
  h2:first-of-type { border-top: 0; margin-top: 0; }
  .rota { border: 1px solid var(--borda); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
  .linha { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .metodo { font: 600 12px/1 ui-monospace, monospace; padding: 5px 8px; border-radius: 5px; color: #fff; }
  .get { background: #0369a1; } .post { background: #15803d; } .patch, .put { background: #a16207; } .delete { background: #b91c1c; }
  code, .caminho { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .resumo { font-weight: 600; }
  .desc { color: var(--suave); font-size: 14px; margin-top: 8px; white-space: pre-wrap; }
  .desc table { border-collapse: collapse; margin: 8px 0; }
  .desc td, .desc th { border: 1px solid var(--borda); padding: 4px 8px; }
  .trava { font-size: 12px; color: var(--suave); border: 1px solid var(--borda); border-radius: 999px; padding: 2px 8px; }
  .respostas { margin-top: 10px; font-size: 13px; color: var(--suave); }
  .respostas span { display: inline-block; margin-right: 12px; }
  .intro { color: var(--suave); white-space: pre-wrap; }
  @media (max-width: 860px) { .casca { grid-template-columns: 1fr; } nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--borda); } main { padding: 24px; } }
</style>
</head>
<body>
<div class="casca">
  <nav><h1>Carregando…</h1></nav>
  <main><p class="intro">Buscando a especificação…</p></main>
</div>
<script>
(async () => {
  const doc = await fetch('/openapi.json').then((r) => r.json());

  const nav = document.querySelector('nav');
  const main = document.querySelector('main');

  // Agrupa as operações por tag, mantendo a ordem declarada em \`tags\`.
  const porTag = new Map(doc.tags.map((t) => [t.name, { info: t, itens: [] }]));

  for (const [caminho, item] of Object.entries(doc.paths)) {
    for (const [metodo, op] of Object.entries(item)) {
      if (metodo === 'parameters') continue;
      const tag = (op.tags || ['Outros'])[0];
      if (!porTag.has(tag)) porTag.set(tag, { info: { name: tag }, itens: [] });
      porTag.get(tag).itens.push({ caminho, metodo, op });
    }
  }

  const escapar = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // Markdown mínimo: só o que as descrições usam.
  const marcar = (t) => escapar(t)
    .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, (b) => '<pre><code>' + b.replace(/\`\`\`/g, '').trim() + '</code></pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

  nav.innerHTML = '<h1>' + escapar(doc.info.title) + '</h1>' +
    [...porTag.values()].filter((g) => g.itens.length)
      .map((g) => '<a href="#' + encodeURIComponent(g.info.name) + '">' + escapar(g.info.name) + '</a>').join('');

  main.innerHTML = '<div class="intro">' + marcar(doc.info.description) + '</div>' +
    [...porTag.values()].filter((g) => g.itens.length).map((g) =>
      '<h2 id="' + encodeURIComponent(g.info.name) + '">' + escapar(g.info.name) + '</h2>' +
      (g.info.description ? '<p class="desc">' + marcar(g.info.description) + '</p>' : '') +
      g.itens.map(({ caminho, metodo, op }) => {
        const seguranca = op.security === undefined
          ? 'sessão'
          : op.security.length === 0
            ? 'público'
            : Object.keys(op.security[0])[0];

        return '<div class="rota">' +
          '<div class="linha">' +
            '<span class="metodo ' + metodo + '">' + metodo.toUpperCase() + '</span>' +
            '<span class="caminho">' + escapar(caminho) + '</span>' +
            '<span class="trava">' + escapar(seguranca) + '</span>' +
          '</div>' +
          '<div class="resumo" style="margin-top:8px">' + escapar(op.summary || '') + '</div>' +
          (op.description ? '<div class="desc">' + marcar(op.description) + '</div>' : '') +
          '<div class="respostas">' +
            Object.entries(op.responses || {}).map(([codigo, r]) =>
              '<span><code>' + codigo + '</code> ' + escapar(r.description || '') + '</span>').join('') +
          '</div>' +
        '</div>';
      }).join('')
    ).join('');
})();
</script>
</body>
</html>`;
