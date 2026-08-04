import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, getPlan, type ExportFormat, type PlanCode } from '@forms/shared';
import { requireAuth, subjectOf, withRequestTenant } from '../http/context.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { storage } from '../storage/provider.js';
import { getQueue, QUEUE_NAMES, type ExportJobData } from '../queue/queues.js';
import {
  addComment,
  assignResponse,
  deleteResponse,
  getResponse,
  listComments,
  listResponses,
  updateResponse,
} from '../services/responses-service.js';
import { loadFormFor } from '../services/forms-service.js';

/** Painel de recebimentos: listar, filtrar, marcar, comentar, atribuir, exportar. */

const uuidParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.enum(['new', 'reviewed', 'archived']).optional(),
  flagged: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const exportBody = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf', 'json']),
  status: z.enum(['new', 'reviewed', 'archived']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
});

export async function responseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/forms/:id/responses', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const query = listQuery.parse(request.query);

    return withRequestTenant(request, (ctx) =>
      listResponses(ctx, subject, id, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.flagged !== undefined ? { isFlagged: query.flagged } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        ...(query.search ? { search: query.search } : {}),
        page: query.page,
        pageSize: query.pageSize,
      }),
    );
  });

  app.get('/responses/:id/full', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    return withRequestTenant(request, (ctx) => getResponse(ctx, subject, id));
  });

  app.patch('/responses/:id', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const body = z
      .object({
        status: z.enum(['new', 'reviewed', 'archived']).optional(),
        isFlagged: z.boolean().optional(),
      })
      .parse(request.body);

    const atualizada = await withRequestTenant(request, (ctx) => updateResponse(ctx, subject, id, body));
    return { id: atualizada.id, status: atualizada.status, isFlagged: atualizada.isFlagged };
  });

  app.delete('/responses/:id', async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    await withRequestTenant(request, (ctx) => deleteResponse(ctx, subject, id));
    return reply.status(204).send();
  });

  app.get('/responses/:id/comments', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const comentarios = await withRequestTenant(request, (ctx) => listComments(ctx, subject, id));
    return {
      comments: comentarios.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        user: c.user,
      })),
    };
  });

  app.post('/responses/:id/comments', async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(request.body);

    const comentario = await withRequestTenant(request, (ctx) => addComment(ctx, subject, id, body));
    return reply.status(201).send({ id: comentario.id, body: comentario.body, createdAt: comentario.createdAt });
  });

  app.post('/responses/:id/assignments', async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const body = z
      .object({ assigneeId: z.string().uuid(), dueAt: z.string().datetime().optional() })
      .parse(request.body);

    const atribuicao = await withRequestTenant(request, (ctx) =>
      assignResponse(ctx, subject, id, body.assigneeId, body.dueAt ? new Date(body.dueAt) : undefined),
    );

    return reply.status(201).send({ id: atribuicao.id, assigneeId: atribuicao.assigneeId, status: atribuicao.status });
  });

  /**
   * Pede uma exportação.
   *
   * Responde 202 com o id do pedido — o arquivo é gerado em fila. A alternativa
   * (gerar no request) travaria por minutos num formulário com volume, e cairia
   * no timeout do proxy justamente para os clientes que mais precisam.
   */
  app.post('/forms/:id/exports', async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const body = exportBody.parse(request.body);

    if (!can(subject, 'response:export')) throw forbidden();

    const exportacao = await withRequestTenant(request, async (ctx) => {
      await loadFormFor(ctx, subject, id, 'response:export');

      const org = await ctx.tx.organization.findFirstOrThrow({
        where: { id: ctx.organizationId },
        select: { planCode: true },
      });
      const plano = getPlan(org.planCode as PlanCode);

      if (!plano.features.exportFormats.includes(body.format as ExportFormat)) {
        throw new AppError('quota_exceeded', `Exportar em ${body.format.toUpperCase()} faz parte de um plano superior.`, {
          extra: { upgradeUrl: '/planos' },
        });
      }

      return ctx.tx.export.create({
        data: {
          organizationId: ctx.organizationId,
          formId: id,
          requestedBy: subject.userId,
          format: body.format,
          status: 'pending',
          filtersJson: {
            ...(body.status ? { status: body.status } : {}),
            ...(body.from ? { from: body.from } : {}),
            ...(body.to ? { to: body.to } : {}),
            ...(body.search ? { search: body.search } : {}),
          },
        },
      });
    });

    const jobData: ExportJobData = {
      exportId: exportacao.id,
      organizationId: subject.organizationId,
      requestedBy: subject.userId,
      formId: id,
      format: body.format === 'pdf' ? 'csv' : body.format,
      filters: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.from ? { from: body.from } : {}),
        ...(body.to ? { to: body.to } : {}),
        ...(body.search ? { search: body.search } : {}),
      },
    };

    await getQueue(QUEUE_NAMES.export).add('gerar-exportacao', jobData);

    return reply.status(202).send({
      id: exportacao.id,
      status: exportacao.status,
      message: 'Estamos preparando seu arquivo. Avisaremos quando estiver pronto.',
    });
  });

  app.get('/forms/:id/exports', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const exportacoes = await withRequestTenant(request, async (ctx) => {
      await loadFormFor(ctx, subject, id, 'response:export');
      return ctx.tx.export.findMany({
        where: { organizationId: ctx.organizationId, formId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    return {
      exports: exportacoes.map((e) => ({
        id: e.id,
        format: e.format,
        status: e.status,
        rowCount: e.rowCount,
        error: e.error,
        expiresAt: e.expiresAt,
        createdAt: e.createdAt,
        completedAt: e.completedAt,
      })),
    };
  });

  /** URL assinada do arquivo pronto. Expira em 5 minutos. */
  app.get('/exports/:id/download-url', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const url = await withRequestTenant(request, async (ctx) => {
      const exportacao = await ctx.tx.export.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });
      if (!exportacao) throw notFound();

      await loadFormFor(ctx, subject, exportacao.formId, 'response:export');

      if (exportacao.status !== 'done' || !exportacao.s3Key) {
        throw new AppError('validation_error', 'Esse arquivo ainda não está pronto.');
      }
      if (exportacao.expiresAt && exportacao.expiresAt < new Date()) {
        throw new AppError('validation_error', 'Esse arquivo expirou. Gere a exportação de novo.');
      }

      return storage().signedUrl(exportacao.s3Key, 300);
    });

    return { url, expiresInSeconds: 300 };
  });
}
