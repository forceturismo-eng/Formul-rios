/**
 * Contrato do provedor de IA.
 *
 * A mesma razão do gateway de pagamento (ADR 0004): nenhum código de domínio
 * importa o SDK. Mas aqui há um motivo a mais, e ele é de privacidade — com a
 * interface no meio, existe UM ponto por onde o conteúdo sai da nossa
 * infraestrutura, e esse ponto é auditável e testável.
 *
 * A chave da API vive só no servidor. Ela nunca chega ao frontend, e nada no
 * caminho do request do usuário fala com o provedor: análise é sempre em fila.
 */

export type AnalysisType =
  | 'sentimento'
  | 'temas'
  | 'resumo'
  | 'outliers'
  | 'melhoria_formulario';

export const ANALYSIS_TYPES: AnalysisType[] = [
  'sentimento',
  'temas',
  'resumo',
  'outliers',
  'melhoria_formulario',
];

export interface AiRequest {
  type: AnalysisType;
  /** Prompt de sistema. Não contém dado de cliente. */
  system: string;
  /** Conteúdo JÁ REDIGIDO. Este é o texto que sai daqui. */
  userContent: string;
  maxTokens: number;
}

export interface AiResponse {
  /** Texto devolvido pelo modelo. */
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  analyze(request: AiRequest): Promise<AiResponse>;
}

let provider: AiProvider | null = null;

export function setAiProvider(novo: AiProvider | null): void {
  provider = novo;
}

export function getAiProvider(): AiProvider | null {
  return provider;
}

/**
 * Custo em centavos de real.
 *
 * Preço por milhão de tokens, convertido. É estimativa: o valor exato depende
 * do câmbio do dia e da fatura do provedor. Serve para o cliente ver ordem de
 * grandeza e para nós acompanharmos margem — não para cobrar dele, que paga
 * por análise contratada no plano.
 */
export function estimateCostCents(inputTokens: number, outputTokens: number): number {
  const REAIS_POR_MILHAO_ENTRADA = 18;
  const REAIS_POR_MILHAO_SAIDA = 90;

  const reais =
    (inputTokens / 1_000_000) * REAIS_POR_MILHAO_ENTRADA +
    (outputTokens / 1_000_000) * REAIS_POR_MILHAO_SAIDA;

  return Math.ceil(reais * 100);
}
