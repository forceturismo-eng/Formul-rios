import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMetaTags, type MetaResolvido } from '@forms/shared';
import { env } from '../config/env.js';

/**
 * Shell HTML do formulário público, com as meta tags já dentro.
 *
 * Por que isso existe: o app é uma SPA, e meta tag preenchida por JavaScript
 * não serve para nada no caso que mais importa aqui. Formulário no Brasil
 * circula por WhatsApp, e o robô que monta o cartão de prévia não roda script —
 * ele lê o HTML que chegou e vai embora. Sem meta tag no primeiro byte, o
 * cliente que pagou por white-label vê o nome do formulário substituído pelo
 * título genérico do índice.
 *
 * O Caddy já roteia `/f/*` para a API nos domínios de clientes (infra/Caddyfile),
 * então este é o lugar natural: a resposta sai daqui com o `<head>` certo e o
 * mesmo bundle da SPA assume a partir do `<body>`.
 */

/** Onde o `npm run build -w @forms/web` deixa o index.html. */
const DIST = resolve(process.cwd(), 'apps/web/dist/index.html');

let shellEmCache: string | null = null;
let jaAvisou = false;

/**
 * Lê o index.html construído, uma vez.
 *
 * `null` quando não existe — é o caso do desenvolvimento, em que o Vite serve
 * a SPA na porta dele. Quem chama devolve JSON nesse caso, que é exatamente o
 * comportamento que a API sempre teve.
 */
export async function loadSpaShell(): Promise<string | null> {
  if (shellEmCache !== null) return shellEmCache;

  try {
    shellEmCache = await readFile(DIST, 'utf8');
    return shellEmCache;
  } catch {
    if (!jaAvisou) {
      jaAvisou = true;
      console.info('[spa-shell] apps/web/dist/index.html ausente — /f/:slug responde JSON.');
    }
    return null;
  }
}

/** Só para os testes: o cache guarda o arquivo pela vida do processo. */
export function resetSpaShellCache(): void {
  shellEmCache = null;
  jaAvisou = false;
}

/**
 * Injeta título e meta tags no `<head>` do shell.
 *
 * O index.html do Vite traz um `<title>` próprio, que precisa sair: dois
 * títulos no mesmo documento fazem o robô escolher, e ele escolhe o primeiro.
 */
export function injectMeta(shell: string, meta: MetaResolvido): string {
  const semTitulo = shell.replace(/<title>[\s\S]*?<\/title>/i, '');
  const tags = renderMetaTags(meta);

  if (semTitulo.includes('</head>')) {
    return semTitulo.replace('</head>', `${tags}\n</head>`);
  }

  // Shell sem `</head>` não deveria acontecer, mas devolver a página sem meta
  // tag é melhor do que devolver erro para quem só queria responder um
  // formulário.
  return `${tags}\n${semTitulo}`;
}

/** `true` quando o cliente quer HTML — navegador ou robô de prévia de link. */
export function aceitaHtml(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.includes('text/html');
}

export function canonicalUrlDe(host: string | undefined, slug: string): string {
  const dominio = host?.split(':')[0] ?? env.branding.appDomain;
  return `https://${dominio}/f/${slug}`;
}
