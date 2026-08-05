import { Worker, type Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { assertRedacted } from '@forms/shared';
import { withTenant } from '../db/tenant.js';
import { QUEUE_NAMES, redisConnection, type TenantJob } from './queues.js';
import { estimateCostCents, getAiProvider, type AnalysisType } from '../ai/provider.js';
import { incrementAiCount } from '../services/usage-service.js';
import { auditLogsRepository } from '../db/repositories.js';

/**
 * Execução das análises com IA.
 *
 * Em fila e nunca no request, por dois motivos: a chamada leva dezenas de
 * segundos, e a chave da API não pode estar em nenhum caminho que o frontend
 * alcance.
 *
 * O job carrega o conteúdo JÁ REDIGIDO. Ele passa pelo Redis, e por isso o que
 * está aqui já é a versão pseudonimizada — o texto em claro nunca sai da
 * transação que o decifrou.
 */

export interface AiJobData extends TenantJob {
  formId: string;
  type: AnalysisType;
  inputHash: string;
  system: string;
  /** Já redigido. Conferido de novo antes do envio. */
  userContent: string;
  responseCount: number;
}

export interface AiJobResult {
  analysisId: string;
  cached: boolean;
  tokensUsed: number;
  costCents: number;
}

const MAX_TOKENS = 4_000;

export async function runAnalysis(data: AiJobData): Promise<AiJobResult> {
  const provider = getAiProvider();
  if (!provider) throw new Error('Nenhum provedor de IA configurado.');

  // Terceira conferência, depois da redação e antes do provedor. Sai barato e
  // fecha o caso em que o job foi montado por um caminho que ainda não existe.
  assertRedacted(data.userContent);

  const conferido = await withTenant(data.organizationId, async (ctx) => {
    // O `formId` vem do payload do job, e payload de fila não é fonte confiável
    // de autorização. A checagem de chave estrangeira do Postgres NÃO passa
    // pelo RLS — ela roda como sistema — então um id de outra organização
    // gravaria uma linha com referência cruzada sem erro nenhum.
    const form = await ctx.tx.form.findFirst({
      where: { id: data.formId, organizationId: ctx.organizationId },
      select: { id: true },
    });

    if (!form) return { formularioValido: false as const };

    // O cache é conferido de novo aqui: entre o enfileiramento e a execução,
    // outro job pode ter produzido exatamente esta análise.
    const jaExiste = await ctx.tx.aiAnalysis.findFirst({
      where: {
        organizationId: ctx.organizationId,
        formId: data.formId,
        type: data.type,
        inputHash: data.inputHash,
      },
      select: { id: true },
    });

    return { formularioValido: true as const, jaExiste };
  });

  if (!conferido.formularioValido) {
    throw new Error('O formulário do job não pertence à organização do job.');
  }

  if (conferido.jaExiste) {
    return { analysisId: conferido.jaExiste.id, cached: true, tokensUsed: 0, costCents: 0 };
  }

  const resposta = await provider.analyze({
    type: data.type,
    system: data.system,
    userContent: data.userContent,
    maxTokens: MAX_TOKENS,
  });

  const tokensUsed = resposta.inputTokens + resposta.outputTokens;
  const costCents = estimateCostCents(resposta.inputTokens, resposta.outputTokens);

  return withTenant(data.organizationId, async (ctx) => {
    const analise = await ctx.tx.aiAnalysis.create({
      data: {
        organizationId: ctx.organizationId,
        formId: data.formId,
        type: data.type,
        inputHash: data.inputHash,
        resultJson: interpretar(resposta.content),
        model: resposta.model,
        tokensUsed,
        costCents,
      },
    });

    // A cota é debitada só depois de a análise existir. Cobrar por uma chamada
    // que falhou seria cobrar pelo nosso problema.
    await incrementAiCount(ctx);

    await auditLogsRepository.record(ctx, {
      actorUserId: data.requestedBy === 'system' ? null : data.requestedBy,
      action: 'ai_analysis.created',
      resourceType: 'ai_analysis',
      resourceId: analise.id,
      // Sem conteúdo: o resultado fala de respostas de clientes, e o audit log
      // é lido por gente que não precisa vê-lo.
      metadataJson: { type: data.type, formId: data.formId, responseCount: data.responseCount },
    });

    return { analysisId: analise.id, cached: false, tokensUsed, costCents };
  });
}

/**
 * O modelo foi instruído a devolver JSON. Quando ele não devolve, o texto é
 * guardado como está em vez de o job falhar: uma análise em prosa ainda é útil
 * para quem pediu, e perder a chamada já paga seria pior.
 */
function interpretar(conteudo: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(conteudo) as Prisma.InputJsonValue;
  } catch {
    return { texto: conteudo, formatoInesperado: true };
  }
}

export function startAiWorker(): Worker<AiJobData> {
  return new Worker<AiJobData>(
    QUEUE_NAMES.ai,
    async (job: Job<AiJobData>) => runAnalysis(job.data),
    {
      connection: redisConnection(),
      // Baixa de propósito: cada job é uma chamada longa e paga, e uma rajada
      // de análises simultâneas vira custo antes de virar valor.
      concurrency: 2,
    },
  );
}
