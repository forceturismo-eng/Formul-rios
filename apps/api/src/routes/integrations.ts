import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertCan } from '@forms/shared';
import { requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { unauthorized, forbidden, notFound } from '../http/errors.js';
import { withTenant, withoutTenant } from '../db/tenant.js';
import { resolveApiKeyOrg } from '../db/bootstrap.js';
import { hashToken } from '../auth/hashing.js';
import {
  API_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyContext,
  type ApiScope,
} from '../services/api-keys-service.js';
import {
  WEBHOOK_EVENTS,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  validateWebhookUrl,
} from '../services/webhooks-service.js';
import { listResponses } from '../services/responses-service.js';
import { listFormsFor } from '../services/forms-service.js';

const uuidParam = z.object({ id: z.string().uuid() });

/** Gestão de webhooks e chaves — no painel, com sessão. */
export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  app.get('/webhooks', async (request) => {
    assertCan(subjectOf(request), 'webhook:manage');
    return { webhooks: await withRequestTenant(request, (ctx) => listWebhooks(ctx)), events: WEBHOOK_EVENTS };
  });

  app.post('/webhooks', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'webhook:manage');

    const entrada = z
      .object({
        url: z.string().url().max(2048),
        formId: z.string().uuid().optional(),
        events: z.array(z.string()).min(1).max(20),
      })
      .parse(request.body);

    const { webhook, secret } = await withRequestTenant(request, (ctx) => createWebhook(ctx, subject, entrada));

    return reply.status(201).send({
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      // O segredo aparece UMA vez. Depois disso o banco só tem ele para assinar.
      secret,
      aviso: 'Guarde este segredo agora. Ele não será mostrado de novo.',
    });
  });

  app.delete('/webhooks/:id', async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'webhook:manage');

    const { id } = uuidParam.parse(request.params);
    await withRequestTenant(request, (ctx) => deleteWebhook(ctx, subject, id));

    return reply.status(204).send();
  });

  app.post('/webhooks/validate-url', async (request) => {
    assertCan(subjectOf(request), 'webhook:manage');
    const { url } = z.object({ url: z.string().max(2048) }).parse(request.body);
    return validateWebhookUrl(url);
  });

  // ---------------------------------------------------------------------------
  // Chaves de API
  // ---------------------------------------------------------------------------

  app.get('/api-keys', async (request) => {
    assertCan(subjectOf(request), 'apikey:manage');
    return { apiKeys: await withRequestTenant(request, (ctx) => listApiKeys(ctx)), scopes: API_SCOPES };
  });

  app.post('/api-keys', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'apikey:manage');

    const entrada = z
      .object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.string()).min(1).max(10),
        expiresAt: z.string().datetime().optional(),
      })
      .parse(request.body);

    const { apiKey, secret } = await withRequestTenant(request, (ctx) =>
      createApiKey(ctx, subject, {
        name: entrada.name,
        scopes: entrada.scopes,
        ...(entrada.expiresAt ? { expiresAt: new Date(entrada.expiresAt) } : {}),
      }),
    );

    return reply.status(201).send({
      id: apiKey.id,
      name: apiKey.name,
      scopes: apiKey.scopes,
      secret,
      aviso: 'Guarde esta chave agora. Ela não será mostrada de novo.',
    });
  });

  app.delete('/api-keys/:id', async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'apikey:manage');

    const { id } = uuidParam.parse(request.params);
    await withRequestTenant(request, (ctx) => revokeApiKey(ctx, subject, id));

    return reply.status(204).send();
  });
}

// -----------------------------------------------------------------------------
// API pública, autenticada por chave
// -----------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKeyContext | null;
  }
}

/**
 * Autenticação por chave de API.
 *
 * Diferente da sessão em três pontos que importam:
 *
 *  - Não há cookie nem refresh: a chave É a credencial, e ela vale até ser
 *    revogada ou expirar.
 *  - O acesso é limitado por ESCOPO, não por papel. Uma chave com
 *    `responses:read` não escreve nada, mesmo que a organização toda pudesse.
 *  - Chave inexistente, revogada e expirada respondem igual. O log distingue;
 *    o cliente, não.
 */
async function requireApiKey(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  const [esquema, valor] = (header ?? '').split(' ');

  if (!esquema || esquema.toLowerCase() !== 'bearer' || !valor) {
    throw unauthorized('Informe sua chave de API no header Authorization.');
  }

  const encontrada = await withoutTenant((tx) => resolveApiKeyOrg(tx, hashToken(valor.trim())));

  if (!encontrada) {
    request.log.warn('chave de API desconhecida');
    throw unauthorized('Chave de API inválida.');
  }
  if (encontrada.revokedAt) {
    request.log.warn({ apiKeyId: encontrada.apiKeyId }, 'chave de API revogada');
    throw unauthorized('Chave de API inválida.');
  }
  if (encontrada.expiresAt && encontrada.expiresAt < new Date()) {
    request.log.warn({ apiKeyId: encontrada.apiKeyId }, 'chave de API expirada');
    throw unauthorized('Chave de API inválida.');
  }
  if (encontrada.subscriptionStatus === 'suspended' || encontrada.subscriptionStatus === 'canceled') {
    throw forbidden('Esta conta está em modo somente leitura.');
  }

  request.apiKey = {
    organizationId: encontrada.organizationId,
    apiKeyId: encontrada.apiKeyId,
    scopes: encontrada.scopes,
  };

  // `last_used_at` alimenta a tela de chaves: saber que uma chave não é usada
  // há meses é o que permite revogá-la com confiança.
  void withTenant(encontrada.organizationId, (ctx) =>
    ctx.tx.apiKey.update({ where: { id: encontrada.apiKeyId }, data: { lastUsedAt: new Date() } }),
  ).catch(() => undefined);
}

function exigirEscopo(request: FastifyRequest, escopo: ApiScope): ApiKeyContext {
  const contexto = request.apiKey;
  if (!contexto) throw unauthorized();
  if (!contexto.scopes.includes(escopo)) {
    throw forbidden(`Esta chave não tem o escopo ${escopo}.`);
  }
  return contexto;
}

/**
 * A API pública usa o mesmo `withTenant` de sempre.
 *
 * O `subject` sintético tem papel `owner` porque quem autoriza aqui é o
 * ESCOPO da chave, não o papel de um usuário — a chave não pertence a uma
 * pessoa. A checagem de escopo acontece antes, em `exigirEscopo`.
 */
function subjectDaChave(contexto: ApiKeyContext) {
  return { userId: contexto.apiKeyId, organizationId: contexto.organizationId, role: 'owner' as const };
}

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('apiKey', null);
  app.addHook('preHandler', requireApiKey);

  app.get('/forms', async (request) => {
    const contexto = exigirEscopo(request, 'forms:read');
    const forms = await withTenant(contexto.organizationId, (ctx) =>
      listFormsFor(ctx, subjectDaChave(contexto)),
    );
    return { forms };
  });

  app.get('/forms/:id/responses', async (request) => {
    const contexto = exigirEscopo(request, 'responses:read');
    const { id } = uuidParam.parse(request.params);

    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        status: z.enum(['new', 'reviewed', 'archived']).optional(),
      })
      .parse(request.query);

    return withTenant(contexto.organizationId, (ctx) =>
      listResponses(ctx, subjectDaChave(contexto), id, {
        page: query.page,
        pageSize: query.pageSize,
        ...(query.status ? { status: query.status } : {}),
      }),
    );
  });

  /** Quem sou eu: útil para o cliente conferir escopo e organização. */
  app.get('/me', async (request) => {
    const contexto = request.apiKey;
    if (!contexto) throw notFound();

    return { organizationId: contexto.organizationId, scopes: contexto.scopes };
  });
}
