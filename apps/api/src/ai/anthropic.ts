import { assertRedacted } from '@forms/shared';
import type { AiProvider, AiRequest, AiResponse } from './provider.js';

/**
 * Provedor Claude (Anthropic).
 *
 * Chamada HTTP direta, sem SDK: a superfície que usamos é uma rota só, e uma
 * dependência a mais no caminho por onde dado de cliente passa é dependência
 * que precisaria ser auditada a cada atualização.
 *
 * A conferência de redação acontece AQUI, imediatamente antes do envio, e não
 * só na montagem do prompt. É o último ponto em que ainda somos donos do
 * conteúdo — depois do `fetch` não há como voltar atrás.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSAO_API = '2023-06-01';
const TIMEOUT_MS = 120_000;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export function createAnthropicProvider(env: {
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_MODEL?: string | undefined;
}): AiProvider | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const model = env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5';

  return {
    name: 'anthropic',

    async analyze(request: AiRequest): Promise<AiResponse> {
      // Trava de última hora. Se um padrão novo aparecer e a redação falhar, a
      // análise quebra em vez de mandar dado pessoal para fora.
      assertRedacted(request.userContent);

      const controle = new AbortController();
      const timeout = setTimeout(() => controle.abort(), TIMEOUT_MS);

      try {
        const resposta = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': VERSAO_API,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.userContent }],
          }),
          signal: controle.signal,
        });

        if (!resposta.ok) {
          // O corpo do erro NÃO entra na mensagem: ele pode ecoar o prompt, e o
          // prompt vai para o log de quem estiver depurando.
          throw new Error(`Claude respondeu ${resposta.status}.`);
        }

        const corpo = (await resposta.json()) as {
          content?: Array<{ type: string; text?: string }>;
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        const texto = (corpo.content ?? [])
          .filter((bloco) => bloco.type === 'text')
          .map((bloco) => bloco.text ?? '')
          .join('\n')
          .trim();

        if (!texto) throw new Error('Claude devolveu uma resposta vazia.');

        return {
          content: texto,
          model: corpo.model ?? model,
          inputTokens: corpo.usage?.input_tokens ?? 0,
          outputTokens: corpo.usage?.output_tokens ?? 0,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
