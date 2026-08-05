import { env } from '../config/env.js';
import { createAnthropicProvider } from './anthropic.js';
import { createFakeAiProvider } from './fake.js';
import { getAiProvider, setAiProvider } from './provider.js';

/**
 * Registra o provedor de IA na subida.
 *
 * Sem `ANTHROPIC_API_KEY`, as rotas de análise respondem que o recurso está
 * indisponível — e isso é melhor do que subir com um provedor falso em
 * produção por engano. Fora de produção, o falso entra para que quem está
 * desenvolvendo a tela veja resultado sem precisar de credencial nem gastar
 * token.
 */
export function registerAiProvider(): void {
  if (getAiProvider()) return;

  const anthropic = createAnthropicProvider({
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    ANTHROPIC_MODEL: process.env['ANTHROPIC_MODEL'],
  });

  if (anthropic) {
    setAiProvider(anthropic);
    return;
  }

  if (env.isProduction) {
    // Não derruba a aplicação: o resto do produto funciona sem IA, e uma
    // plataforma de formulários fora do ar por falta de chave de análise seria
    // uma troca ruim. As rotas de IA respondem 503.
    console.warn('[ai] ANTHROPIC_API_KEY ausente — as análises com IA ficam indisponíveis.');
    return;
  }

  setAiProvider(createFakeAiProvider());
}

export * from './provider.js';
