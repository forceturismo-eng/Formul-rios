import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestIpHash, requestUserAgentHash } from '../http/context.js';
import { getPublicForm, submitPublicForm } from '../services/public-form-service.js';
import { aceitaHtml, canonicalUrlDe, injectMeta, loadSpaShell } from '../http/spa-shell.js';

/**
 * Rotas públicas do formulário.
 *
 * Estas são as ÚNICAS rotas que os domínios de clientes servem (seção 8.1), e
 * por isso são as únicas sem `requireAppHost`. Elas são stateless: não leem
 * cookie, não emitem cookie, não olham `Authorization`.
 *
 * Como o tenant sai do slug e não do `Host`, servir a mesma rota em qualquer
 * domínio é seguro: mudar o `Host` não muda o formulário que responde.
 */

const slugParam = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Slug inválido.'),
});

const submitBody = z.object({
  values: z.record(z.unknown()).default({}),
  /** Honeypot. O nome genérico é de propósito: não entrega o truque. */
  website: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
});

export async function publicFormRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/f/:slug',
    {
      config: {
        // Leitura pública é barata, mas não infinita: um formulário divulgado
        // vira alvo de raspagem.
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const form = await getPublicForm(slug);

      // Cache curto no CDN: o schema muda quando o cliente publica, e uma
      // janela de 30s é aceitável para não derrubar o banco numa campanha.
      void reply.header('Cache-Control', 'public, max-age=30');
      // `frame-ancestors` liberado porque o embed em iframe é recurso do
      // produto (seção 5.1). Por formulário, isso vira configurável na Fase 4.
      void reply.header('Content-Security-Policy', "frame-ancestors *");
      // A prévia do link muda com o branding da organização, e um cache
      // compartilhado que ignorasse o Accept serviria HTML a quem pediu JSON.
      void reply.header('Vary', 'Accept');

      // Navegador e robô de prévia recebem HTML com as meta tags já no head.
      // Robô de WhatsApp não roda script: meta tag preenchida depois não existe
      // para ele.
      if (aceitaHtml(request.headers.accept)) {
        const shell = await loadSpaShell();
        if (shell) {
          void reply.type('text/html; charset=utf-8');
          return injectMeta(shell, {
            title: form.meta.title,
            // `og:url` só é montada aqui: ela depende do host do request, e o
            // mesmo formulário é servido no domínio do cliente e no nosso.
            tags: [
              ...form.meta.tags,
              { attr: 'property', key: 'og:url', content: canonicalUrlDe(request.headers.host, slug) },
            ],
            faviconUrl: form.organization.faviconUrl,
          });
        }
      }

      return form;
    },
  );

  app.post(
    '/f/:slug/submit',
    {
      config: {
        // 10 submissões por minuto por IP. Formulário de evento tem vários
        // respondentes atrás do mesmo NAT, então o limite não pode ser 1 ou 2.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { slug } = slugParam.parse(request.params);
      const body = submitBody.parse(request.body);

      const resultado = await submitPublicForm({
        slug,
        values: body.values as Record<string, never>,
        ...(body.website !== undefined ? { honeypot: body.website } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
        ipHash: requestIpHash(request),
        userAgentHash: requestUserAgentHash(request),
      });

      return reply.status(201).send(resultado);
    },
  );
}
