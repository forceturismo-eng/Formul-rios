import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan } from '@forms/shared';
import { requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { AppError } from '../http/errors.js';
import { getQueue, QUEUE_NAMES } from '../queue/queues.js';
import { ANALYSIS_TYPES, getAiProvider, type AnalysisType } from '../ai/provider.js';
import {
  assertCanRunAnalysis,
  findCachedAnalysis,
  listAnalyses,
  loadAiSettings,
  prepareAnalysis,
  setAiConsent,
} from '../services/ai-service.js';
import type { AiJobData } from '../queue/ai-worker.js';

const uuidParam = z.object({ id: z.string().uuid() });

/**
 * Análises com IA.
 *
 * Nenhuma rota aqui fala com o provedor. O request prepara, confere os
 * portões e enfileira; quem chama o modelo é o worker. É o que mantém a chave
 * da API fora de qualquer caminho que o frontend alcance.
 */
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/ai/settings', async (request) => {
    assertCan(subjectOf(request), 'ai:run');
    const settings = await withRequestTenant(request, (ctx) => loadAiSettings(ctx));

    return {
      ...settings,
      // A tela precisa saber se o provedor está configurado para não oferecer
      // um botão que só falharia.
      providerConfigured: getAiProvider() !== null,
    };
  });

  /**
   * Liga e desliga o consentimento.
   *
   * Padrão desligado, e só quem tem `ai:configure` muda. É o cliente decidindo
   * que o conteúdo dele pode sair da nossa infraestrutura — decisão que precisa
   * de data, autor e trilha.
   */
  app.put('/ai/consent', { preHandler: requireVerifiedEmail }, async (request) => {
    const subject = subjectOf(request);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);

    return withRequestTenant(request, (ctx) => setAiConsent(ctx, subject, enabled));
  });

  app.get('/forms/:id/ai-analyses', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'ai:run');

    const { id } = uuidParam.parse(request.params);
    return { analyses: await withRequestTenant(request, (ctx) => listAnalyses(ctx, id)) };
  });

  // Ler UMA análise é `GET /v1/ai-analyses/:id`, servido por routes/resources.ts
  // junto de todos os outros recursos. Uma segunda rota para o mesmo recurso
  // seria uma segunda checagem de acesso a manter em dia — e a da suíte de
  // isolamento só varre a primeira.

  /**
   * Pede uma análise.
   *
   * Responde 200 com o resultado quando há cache, e 202 quando entrou na fila.
   * Distinguir os dois importa para a tela: no primeiro caso não há nada que
   * esperar.
   */
  app.post('/forms/:id/ai-analyses', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    const entrada = z
      .object({
        type: z.enum(ANALYSIS_TYPES as [AnalysisType, ...AnalysisType[]]),
        force: z.boolean().optional(),
      })
      .parse(request.body);

    if (!getAiProvider()) {
      throw new AppError('service_unavailable', 'As análises com IA estão indisponíveis no momento.');
    }

    const preparada = await withRequestTenant(request, async (ctx) => {
      const analise = await prepareAnalysis(ctx, subject, {
        formId: id,
        type: entrada.type,
        ...(entrada.force !== undefined ? { force: entrada.force } : {}),
      });

      if (!entrada.force) {
        const emCache = await findCachedAnalysis(ctx, analise);
        if (emCache) return { cached: emCache, analise };
      }

      // A cota só é conferida depois do cache: repetir uma análise já feita não
      // consome nada, e é o comportamento que o cliente espera.
      await assertCanRunAnalysis(ctx);
      return { cached: null, analise };
    });

    if (preparada.cached) {
      return reply.status(200).send({
        status: 'pronta',
        analysis: {
          id: preparada.cached.id,
          type: preparada.cached.type,
          result: preparada.cached.resultJson,
          createdAt: preparada.cached.createdAt,
          generatedByAi: true,
        },
      });
    }

    const jobData: AiJobData = {
      organizationId: subject.organizationId,
      requestedBy: subject.userId,
      formId: preparada.analise.formId,
      type: preparada.analise.type,
      inputHash: preparada.analise.inputHash,
      system: preparada.analise.system,
      userContent: preparada.analise.userContent,
      responseCount: preparada.analise.responseCount,
    };

    await getQueue(QUEUE_NAMES.ai).add('analisar', jobData);

    return reply.status(202).send({
      status: 'na_fila',
      responseCount: preparada.analise.responseCount,
      // Zero no caso normal. Diferente de zero, a tela avisa: o cliente
      // precisa saber que a análise não olhou tudo.
      unreadableCount: preparada.analise.unreadableCount,
      // Quantos dados pessoais foram removidos antes de sair daqui. A tela
      // mostra isso: o cliente consentiu, e merece ver o que o consentimento
      // significou na prática.
      redaction: preparada.analise.redaction,
    });
  });
}
