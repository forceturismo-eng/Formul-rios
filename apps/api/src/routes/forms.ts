import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, formSchema, themeSchema } from '@forms/shared';
import { requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { notFound } from '../http/errors.js';
import { formVersionsRepository } from '../db/repositories.js';
import {
  archiveForm,
  createForm,
  deleteForm,
  duplicateForm,
  listFormsFor,
  loadFormFor,
  publishForm,
  restoreForm,
  updateForm,
} from '../services/forms-service.js';
import { env } from '../config/env.js';

/**
 * CRUD de formulários — o painel do builder.
 *
 * Nenhuma destas rotas decide permissão por conta própria: quem decide é
 * `loadFormFor`, que resolve a permissão do usuário sobre o formulário
 * específico e devolve 404 quando não há acesso.
 */

const uuidParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  title: z.string().trim().min(1, 'Dê um nome ao formulário.').max(200),
  description: z.string().trim().max(2000).optional(),
  definition: z.unknown().optional(),
});

const updateBody = z.object({
  // O cliente devolve o `revision` que leu. É o que impede uma gravação de
  // apagar o trabalho de quem salvou primeiro.
  expectedRevision: z.number().int().min(0),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  definition: z.unknown().optional(),
  theme: z.unknown().optional(),
  settings: z
    .object({
      requiresLogin: z.boolean().optional(),
      closesAt: z.string().datetime().nullable().optional(),
      maxResponses: z.number().int().positive().nullable().optional(),
      responseRetentionDays: z.number().int().positive().max(3650).nullable().optional(),
    })
    .optional(),
});

function serializeForm(form: {
  id: string;
  title: string;
  description: string | null;
  slugPublic: string;
  status: string;
  version: number;
  revision: number;
  requiresLogin: boolean;
  closesAt: Date | null;
  maxResponses: number | null;
  responseRetentionDays: number | null;
  schemaJson: unknown;
  themeJson: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    slugPublic: form.slugPublic,
    publicUrl: `${env.branding.appUrl}/f/${form.slugPublic}`,
    status: form.status,
    version: form.version,
    revision: form.revision,
    requiresLogin: form.requiresLogin,
    closesAt: form.closesAt,
    maxResponses: form.maxResponses,
    responseRetentionDays: form.responseRetentionDays,
    definition: form.schemaJson,
    theme: form.themeJson,
    createdBy: form.createdBy,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

export async function formRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/forms', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'form:read');

    const forms = await withRequestTenant(request, (ctx) => listFormsFor(ctx, subject));
    return { forms };
  });

  app.post('/forms', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'form:create');

    const input = createBody.parse(request.body);
    // `createForm` abre a própria transação, uma por tentativa de slug: uma
    // violação de unicidade aborta a transação no Postgres, e retentar dentro
    // dela não funciona.
    const form = await createForm({ organizationId: subject.organizationId, subject, ...input });

    return reply.status(201).send(serializeForm(form));
  });

  app.get('/forms/:id/full', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const form = await withRequestTenant(request, async (ctx) => {
      const { form } = await loadFormFor(ctx, subject, id, 'form:read');
      return form;
    });

    if (!form) throw notFound();
    return serializeForm(form);
  });

  app.patch('/forms/:id', { preHandler: requireVerifiedEmail }, async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const input = updateBody.parse(request.body);

    const form = await withRequestTenant(request, (ctx) => updateForm({ ctx, subject, formId: id, ...input }));
    return serializeForm(form);
  });

  app.post('/forms/:id/publish', { preHandler: requireVerifiedEmail }, async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const form = await withRequestTenant(request, (ctx) => publishForm(ctx, subject, id));
    return serializeForm(form);
  });

  app.post('/forms/:id/archive', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const form = await withRequestTenant(request, (ctx) => archiveForm(ctx, subject, id));
    return serializeForm(form);
  });

  app.post('/forms/:id/restore', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const form = await withRequestTenant(request, (ctx) => restoreForm(ctx, subject, id));
    return serializeForm(form);
  });

  app.post('/forms/:id/duplicate', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const form = await duplicateForm(subject.organizationId, subject, id);
    return reply.status(201).send(serializeForm(form));
  });

  app.delete('/forms/:id', async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    await withRequestTenant(request, (ctx) => deleteForm(ctx, subject, id));
    return reply.status(204).send();
  });

  app.get('/forms/:id/versions', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const versions = await withRequestTenant(request, async (ctx) => {
      await loadFormFor(ctx, subject, id, 'form:read');
      return formVersionsRepository.listByForm(ctx, id);
    });

    return {
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        publishedBy: v.publishedBy,
        createdAt: v.createdAt,
      })),
    };
  });

  /**
   * Validação do schema sem gravar nada.
   *
   * O builder chama isto enquanto o usuário monta o formulário, para mostrar
   * o erro antes de ele perder o trabalho ao salvar.
   */
  app.post('/forms/validate-schema', async (request) => {
    const resultado = formSchema.safeParse((request.body as { definition?: unknown })?.definition);
    if (resultado.success) return { valid: true, errors: {} };

    const errors: Record<string, string[]> = {};
    for (const issue of resultado.error.issues) {
      const chave = issue.path.length > 0 ? issue.path.join('.') : '_';
      (errors[chave] ??= []).push(issue.message);
    }
    return { valid: false, errors };
  });

  app.post('/forms/validate-theme', async (request) => {
    const resultado = themeSchema.safeParse((request.body as { theme?: unknown })?.theme);
    return { valid: resultado.success };
  });
}
