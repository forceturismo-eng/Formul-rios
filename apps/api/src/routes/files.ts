import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPlan, type PlanCode } from '@forms/shared';
import { withTenant, withoutTenant } from '../db/tenant.js';
import { resolvePublicFormOrg } from '../db/bootstrap.js';
import { filesRepository } from '../db/repositories.js';
import { getAuth, requireAuth, subjectOf, withRequestTenant } from '../http/context.js';
import { notFound, validationError } from '../http/errors.js';
import { buildObjectKey, keyBelongsTo, storage, verifySignedKey } from '../storage/provider.js';
import { sanitizeFilename, validateUpload } from '../storage/upload-validation.js';
import { loadFormFor } from '../services/forms-service.js';

/**
 * Upload e download de arquivos.
 *
 * O upload público acontece ANTES da submissão: o respondente envia o arquivo,
 * recebe um id e manda esse id no campo do formulário. Isso permite validar e
 * mostrar progresso sem segurar a submissão inteira.
 *
 * O arquivo enviado e ainda não vinculado a uma resposta fica com
 * `responseId = null`. A submissão o adota; um job de limpeza recolhe os
 * órfãos (Fase 3, junto com a purga por retenção).
 *
 * Download nunca serve o byte direto de uma rota autenticada por sessão: é
 * sempre URL assinada com expiração. Bucket privado, sem exceção.
 */

const MAX_BYTES_ABSOLUTO = 1024 * 1024 * 1024; // teto do Enterprise

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Download por URL assinada.
   *
   * Sem sessão de propósito: a URL é entregue a quem já provou acesso, e vale
   * por poucos minutos. Isso permite usá-la em `<img src>`, em e-mail e em
   * download direto sem vazar o token de sessão.
   */
  app.get('/v1/files/download', async (request, reply) => {
    const query = z
      .object({ key: z.string().min(1).max(500), exp: z.coerce.number().int(), sig: z.string().length(64) })
      .safeParse(request.query);

    if (!query.success) throw notFound();
    if (!verifySignedKey(query.data.key, query.data.exp, query.data.sig)) throw notFound();

    // O primeiro segmento da chave É o organization_id — é assim que
    // `buildObjectKey` monta o caminho. Usá-lo para abrir o contexto de tenant
    // não é confiar no cliente: a chave inteira está coberta pela assinatura
    // HMAC que acabou de ser conferida.
    const organizationId = query.data.key.split('/')[0] ?? '';
    if (!keyBelongsTo(query.data.key, organizationId)) throw notFound();

    const file = await withTenant(organizationId, (ctx) =>
      ctx.tx.file.findFirst({ where: { s3Key: query.data.key, organizationId: ctx.organizationId } }),
    ).catch(() => null);

    if (!file) throw notFound();

    const bytes = await storage()
      .get(query.data.key)
      .catch(() => null);

    if (!bytes) throw notFound();

    void reply.header('Content-Type', file.mime);
    // `attachment` sempre: nenhum arquivo enviado por terceiro é renderizado
    // inline no nosso domínio. Um PDF com JavaScript ou um HTML disfarçado
    // rodariam no nosso contexto de origem se fossem servidos inline.
    void reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    void reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(bytes);
  });

  /** Upload vindo do formulário público. Sem autenticação, com limite apertado. */
  app.post(
    '/f/:slug/upload',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { slug } = z
        .object({ slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/) })
        .parse(request.params);

      const located = await withoutTenant((tx) => resolvePublicFormOrg(tx, slug));
      if (!located) throw notFound('Este formulário não está disponível.');

      const parte = await request.file({ limits: { fileSize: MAX_BYTES_ABSOLUTO } });
      if (!parte) throw validationError({ file: ['Nenhum arquivo foi enviado.'] });

      const bytes = await parte.toBuffer();

      const arquivo = await withTenant(located.organizationId, async (ctx) => {
        const org = await ctx.tx.organization.findFirstOrThrow({
          where: { id: ctx.organizationId },
          select: { planCode: true },
        });
        const plano = getPlan(org.planCode as PlanCode);

        const check = validateUpload({
          filename: parte.filename,
          declaredMime: parte.mimetype,
          bytes,
          maxBytes: plano.limits.fileUploadMaxMb * 1024 * 1024,
        });
        if (!check.ok) throw validationError({ file: [check.reason as string] });

        // O caminho começa pelo organization_id: o isolamento entre empresas
        // não para no banco, vale para o bucket também.
        const key = `${buildObjectKey(ctx.organizationId, 'respostas')}.${check.safeExtension}`;
        await storage().put(key, bytes, parte.mimetype);

        return filesRepository.create(ctx, {
          responseId: null,
          s3Key: key,
          filename: sanitizeFilename(parte.filename),
          mime: parte.mimetype,
          sizeBytes: bytes.byteLength,
          // O antivírus entra na Fase 5. Até lá o arquivo fica `pending` e
          // nunca é servido inline — o `Content-Disposition: attachment` do
          // download é o que segura a peteca.
          scanStatus: 'pending',
        });
      });

      return reply.status(201).send({
        id: arquivo.id,
        filename: arquivo.filename,
        sizeBytes: arquivo.sizeBytes,
        mime: arquivo.mime,
      });
    },
  );

  /** Upload autenticado — logo, imagem do tema, anexos do painel. */
  app.post('/v1/files', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuth(request);

    const parte = await request.file({ limits: { fileSize: MAX_BYTES_ABSOLUTO } });
    if (!parte) throw validationError({ file: ['Nenhum arquivo foi enviado.'] });

    const bytes = await parte.toBuffer();

    const arquivo = await withRequestTenant(request, async (ctx) => {
      const org = await ctx.tx.organization.findFirstOrThrow({
        where: { id: ctx.organizationId },
        select: { planCode: true },
      });
      const plano = getPlan(org.planCode as PlanCode);

      const check = validateUpload({
        filename: parte.filename,
        declaredMime: parte.mimetype,
        bytes,
        maxBytes: plano.limits.fileUploadMaxMb * 1024 * 1024,
      });
      if (!check.ok) throw validationError({ file: [check.reason as string] });

      const key = `${buildObjectKey(auth.organizationId, 'respostas')}.${check.safeExtension}`;
      await storage().put(key, bytes, parte.mimetype);

      return filesRepository.create(ctx, {
        responseId: null,
        s3Key: key,
        filename: sanitizeFilename(parte.filename),
        mime: parte.mimetype,
        sizeBytes: bytes.byteLength,
        scanStatus: 'pending',
      });
    });

    return reply.status(201).send({ id: arquivo.id, filename: arquivo.filename, sizeBytes: arquivo.sizeBytes });
  });

  /** Gera a URL assinada de um arquivo que o usuário tem direito de ver. */
  app.get('/v1/files/:id/download-url', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const subject = subjectOf(request);

    const url = await withRequestTenant(request, async (ctx) => {
      const arquivo = await filesRepository.findById(ctx, id);
      if (!arquivo) throw notFound();

      // Defesa em profundidade: o RLS já garantiu que a linha é desta
      // organização, e aqui conferimos que o CAMINHO também é. Uma chave
      // montada errada em algum ponto do código não vira acesso cruzado.
      if (!keyBelongsTo(arquivo.s3Key, ctx.organizationId)) {
        request.log.error({ fileId: id }, 'arquivo com caminho fora do prefixo da organização');
        throw notFound();
      }

      // Arquivo anexado a uma resposta segue a permissão do formulário dela.
      if (arquivo.responseId) {
        const resposta = await ctx.tx.response.findFirst({
          where: { id: arquivo.responseId, organizationId: ctx.organizationId },
          select: { formId: true },
        });
        if (!resposta) throw notFound();
        await loadFormFor(ctx, subject, resposta.formId, 'response:read');
      }

      // Cinco minutos: tempo de clicar e baixar, não de compartilhar por aí.
      return storage().signedUrl(arquivo.s3Key, 300);
    });

    return { url, expiresInSeconds: 300 };
  });
}
