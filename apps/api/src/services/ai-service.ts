import { createHash } from 'node:crypto';
import {
  assertCan,
  checkAiQuota,
  createRedactor,
  formSchema,
  getPlan,
  redactResponse,
  type PlanCode,
  type RedactionStats,
  type Subject,
} from '@forms/shared';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository } from '../db/repositories.js';
import { AppError, notFound, validationError } from '../http/errors.js';
import { decryptResponseData } from '../crypto/envelope.js';
import { quotaContext } from './usage-service.js';
import { loadFormFor } from './forms-service.js';
import { ANALYSIS_TYPES, type AnalysisType } from '../ai/provider.js';

/**
 * Análises com IA (seção 5.3).
 *
 * Três portões, nesta ordem, e nenhum deles é opcional:
 *
 *  1. **Consentimento.** Padrão desligado. Sem `ai_consent_at`, a análise nem
 *     é montada. Mandar conteúdo de cliente para um terceiro é decisão dele,
 *     não nossa, e ela precisa ter data e autor.
 *  2. **Plano e cota.** Análise custa dinheiro nosso a cada execução.
 *  3. **Redação.** O conteúdo é redigido ANTES de virar prompt, e o provedor
 *     confere de novo antes de enviar.
 *
 * E um quarto que não é portão, é economia: cache por `input_hash`. Pedir duas
 * vezes a mesma análise sobre as mesmas respostas devolve o resultado gravado,
 * sem gastar token nem cota.
 */

/** Quantas respostas entram numa análise. */
const MAXIMO_DE_RESPOSTAS = 500;

export interface AnalysisRequest {
  formId: string;
  type: AnalysisType;
  /** Recalcula mesmo havendo cache. Consome cota. */
  force?: boolean;
}

export interface PreparedAnalysis {
  formId: string;
  type: AnalysisType;
  inputHash: string;
  system: string;
  userContent: string;
  responseCount: number;
  /** Respostas que não puderam ser decifradas e ficaram de fora. */
  unreadableCount: number;
  redaction: RedactionStats;
}

// -----------------------------------------------------------------------------
// Consentimento
// -----------------------------------------------------------------------------

export async function loadAiSettings(ctx: TenantContext) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true, aiConsentAt: true, aiConsentBy: true },
  });

  const plano = getPlan(organizacao.planCode as PlanCode);

  return {
    enabled: organizacao.aiConsentAt !== null,
    consentedAt: organizacao.aiConsentAt,
    consentedBy: organizacao.aiConsentBy,
    available: plano.features.aiAnalysis,
    limit: plano.limits.aiAnalysesPerMonth,
    types: ANALYSIS_TYPES,
  };
}

export async function setAiConsent(ctx: TenantContext, subject: Subject, ligado: boolean) {
  assertCan(subject, 'ai:configure');

  const organizacao = await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: ligado
      ? { aiConsentAt: new Date(), aiConsentBy: subject.userId }
      : // Desligar limpa o autor junto: guardar quem consentiu depois de o
        // consentimento ser retirado não serve a ninguém.
        { aiConsentAt: null, aiConsentBy: null },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: ligado ? 'ai.consent_granted' : 'ai.consent_revoked',
    resourceType: 'organization',
    resourceId: ctx.organizationId,
    metadataJson: {},
  });

  return { enabled: organizacao.aiConsentAt !== null, consentedAt: organizacao.aiConsentAt };
}

// -----------------------------------------------------------------------------
// Preparação da análise
// -----------------------------------------------------------------------------

/**
 * Monta o prompt a partir das respostas do formulário.
 *
 * Roda dentro do contexto de tenant, como tudo. As respostas são decifradas
 * aqui, redigidas em seguida, e o texto em claro não existe fora desta função.
 */
export async function prepareAnalysis(
  ctx: TenantContext,
  subject: Subject,
  pedido: AnalysisRequest,
): Promise<PreparedAnalysis> {
  assertCan(subject, 'ai:run');

  if (!ANALYSIS_TYPES.includes(pedido.type)) {
    throw validationError({ type: ['Tipo de análise desconhecido.'] });
  }

  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true, aiConsentAt: true },
  });

  const plano = getPlan(organizacao.planCode as PlanCode);

  if (!plano.features.aiAnalysis) {
    throw new AppError('quota_exceeded', 'As análises com IA fazem parte do plano Pro.', {
      extra: { upgradeUrl: '/planos' },
    });
  }

  // O portão do consentimento vem antes de qualquer leitura de resposta. Sem
  // ele, nem chegamos a decifrar conteúdo para montar prompt.
  if (!organizacao.aiConsentAt) {
    throw new AppError(
      'forbidden',
      'As análises com IA estão desligadas. Um administrador precisa ativá-las nas configurações.',
    );
  }

  // Confere que o formulário existe E que o usuário tem acesso a ele.
  const { form } = await loadFormFor(ctx, subject, pedido.formId, 'ai:run');
  if (!form) throw notFound();

  const respostas = await ctx.tx.response.findMany({
    where: { organizationId: ctx.organizationId, formId: form.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: MAXIMO_DE_RESPOSTAS,
    select: { id: true, dataEncrypted: true, dataKeyEncrypted: true, createdAt: true },
  });

  if (respostas.length === 0) {
    throw validationError({ formId: ['Este formulário ainda não tem respostas para analisar.'] });
  }

  const definicao = formSchema.parse(form.schemaJson);

  // Um redator por análise: o mesmo CPF vira o mesmo rótulo nas 500 respostas,
  // e é isso que permite a IA dizer "a mesma pessoa reclamou duas vezes".
  const redator = createRedactor();
  const redigidas: Array<Record<string, unknown>> = [];
  let ilegiveis = 0;

  for (const resposta of respostas) {
    let valores: Record<string, unknown>;

    try {
      valores = decryptResponseData<Record<string, unknown>>(ctx.organizationId, {
        dataEncrypted: resposta.dataEncrypted,
        dataKeyEncrypted: resposta.dataKeyEncrypted,
      });
    } catch {
      // Uma resposta que não decifra não pode derrubar a análise das outras
      // 499. Acontece com linha corrompida, restauração parcial ou rotação de
      // chave malfeita — todos raros, todos possíveis, e nenhum deles é motivo
      // para o recurso inteiro parar. Contamos e seguimos; quem pediu vê o
      // número.
      ilegiveis += 1;
      continue;
    }

    redigidas.push(redactResponse(definicao, valores, redator).values);
  }

  if (redigidas.length === 0) {
    throw new AppError(
      'internal_error',
      'Não conseguimos ler as respostas deste formulário para analisar. Nossa equipe foi avisada.',
    );
  }

  const userContent = montarConteudo(definicao.pages, redigidas);

  return {
    formId: form.id,
    type: pedido.type,
    // O hash é do conteúdo REDIGIDO: duas coleções que redigem para o mesmo
    // texto produzem a mesma análise, e é o texto redigido que vira prompt.
    inputHash: createHash('sha256').update(`${pedido.type}\n${userContent}`).digest('hex'),
    system: SYSTEM_PROMPTS[pedido.type],
    userContent,
    responseCount: redigidas.length,
    unreadableCount: ilegiveis,
    redaction: redator.stats(),
  };
}

/** Resultado já gravado para esta entrada, se houver. */
export async function findCachedAnalysis(ctx: TenantContext, preparada: PreparedAnalysis) {
  return ctx.tx.aiAnalysis.findFirst({
    where: {
      organizationId: ctx.organizationId,
      formId: preparada.formId,
      type: preparada.type,
      inputHash: preparada.inputHash,
    },
  });
}

/** Cota de análises. Chamada depois do cache: acerto de cache não consome. */
export async function assertCanRunAnalysis(ctx: TenantContext): Promise<void> {
  const contexto = await quotaContext(ctx);
  const resultado = checkAiQuota(contexto);

  if (!resultado.allowed) {
    throw new AppError('quota_exceeded', 'Você usou todas as análises com IA do seu ciclo.', {
      extra: {
        limit: resultado.limit,
        current: resultado.current,
        upgradeUrl: '/planos',
        addonUrl: '/cobranca#adicionais',
      },
    });
  }
}

export async function listAnalyses(ctx: TenantContext, formId: string) {
  const analises = await ctx.tx.aiAnalysis.findMany({
    where: { organizationId: ctx.organizationId, formId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return analises.map((analise) => ({
    id: analise.id,
    type: analise.type,
    result: analise.resultJson,
    model: analise.model,
    tokensUsed: analise.tokensUsed,
    costCents: analise.costCents,
    createdAt: analise.createdAt,
    // A tela precisa dizer que o conteúdo foi gerado por IA (seção 5.3).
    generatedByAi: true,
  }));
}

export async function getAnalysis(ctx: TenantContext, id: string) {
  const analise = await ctx.tx.aiAnalysis.findFirst({
    where: { id, organizationId: ctx.organizationId },
  });

  if (!analise) throw notFound();
  return analise;
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

/**
 * Prompts de sistema.
 *
 * Duas instruções aparecem em todos e não são enfeite: pedir JSON evita ter de
 * interpretar prosa na tela, e avisar que os rótulos entre colchetes são
 * pseudônimos impede o modelo de tentar "corrigi-los" inventando nomes.
 */
const BASE =
  'Você analisa respostas de formulários de empresas brasileiras. ' +
  'Rótulos entre colchetes como [EMAIL_1] ou [CPF_2] são pseudônimos de dados pessoais que foram removidos: ' +
  'o mesmo rótulo é sempre a mesma pessoa, e você nunca deve tentar adivinhar o valor real. ' +
  'Responda SOMENTE com JSON válido, sem texto antes ou depois, em português do Brasil.';

const SYSTEM_PROMPTS: Record<AnalysisType, string> = {
  sentimento: `${BASE} Classifique o sentimento geral e a distribuição. Formato: {"geral":"positivo|neutro|negativo","distribuicao":{"positivo":n,"neutro":n,"negativo":n},"destaques":["..."]}`,

  temas: `${BASE} Identifique os temas recorrentes, do mais para o menos frequente. Formato: {"temas":[{"tema":"...","ocorrencias":n,"exemplo":"..."}]}`,

  resumo: `${BASE} Escreva um resumo executivo curto e os pontos que merecem atenção. Formato: {"resumo":"...","pontosDeAtencao":["..."]}`,

  outliers: `${BASE} Aponte respostas que destoam do conjunto e por quê. Formato: {"outliers":[{"motivo":"...","quantidade":n}]}`,

  melhoria_formulario: `${BASE} Sugira melhorias no formulário com base no que as respostas revelam — campos confusos, perguntas redundantes, ordem ruim. Formato: {"sugestoes":[{"campo":"...","sugestao":"..."}]}`,
};

function montarConteudo(
  paginas: Array<{ fields: Array<{ id: string; label: string; type: string }> }>,
  respostas: Array<Record<string, unknown>>,
): string {
  const rotulos = new Map<string, string>();
  for (const pagina of paginas) {
    for (const campo of pagina.fields) rotulos.set(campo.id, campo.label);
  }

  const linhas = [`Respostas recebidas: ${respostas.length}`, ''];

  respostas.forEach((resposta, indice) => {
    linhas.push(`--- Resposta ${indice + 1} ---`);
    for (const [id, valor] of Object.entries(resposta)) {
      if (valor === null || valor === undefined || valor === '') continue;
      const rotulo = rotulos.get(id) ?? id;
      linhas.push(`${rotulo}: ${Array.isArray(valor) ? valor.join(', ') : String(valor)}`);
    }
    linhas.push('');
  });

  return linhas.join('\n');
}
