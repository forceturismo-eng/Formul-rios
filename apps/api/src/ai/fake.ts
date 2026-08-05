import { assertRedacted } from '@forms/shared';
import type { AiProvider, AiRequest, AiResponse } from './provider.js';

/**
 * Provedor falso, para desenvolvimento e testes.
 *
 * Ele implementa o contrato de verdade — inclusive a conferência de redação,
 * que é o ponto do exercício. Um provedor falso que aceitasse qualquer texto
 * deixaria passar exatamente a classe de bug que mais importa aqui: os testes
 * ficariam verdes com PII vazando.
 *
 * Guarda o que recebeu para que os testes possam inspecionar o que SAIRIA da
 * nossa infraestrutura.
 */

export interface FakeAiProvider extends AiProvider {
  /** Tudo que foi enviado, na ordem. */
  readonly enviados: AiRequest[];
  /** Faz a próxima chamada falhar, para exercitar retentativa. */
  falharNaProxima(motivo?: string): void;
  limpar(): void;
}

export function createFakeAiProvider(): FakeAiProvider {
  const enviados: AiRequest[] = [];
  let falhaPendente: string | null = null;

  return {
    name: 'fake',
    enviados,

    falharNaProxima(motivo = 'falha simulada') {
      falhaPendente = motivo;
    },

    limpar() {
      enviados.length = 0;
      falhaPendente = null;
    },

    async analyze(request: AiRequest): Promise<AiResponse> {
      // A MESMA trava do provedor real. É o que faz um teste de redação valer.
      assertRedacted(request.userContent);

      enviados.push(request);

      if (falhaPendente) {
        const motivo = falhaPendente;
        falhaPendente = null;
        throw new Error(motivo);
      }

      return {
        content: respostaDe(request),
        model: 'fake-model',
        // Aproximação de 4 caracteres por token, suficiente para exercitar a
        // contabilidade de custo sem inventar precisão que não existe.
        inputTokens: Math.ceil(request.userContent.length / 4),
        outputTokens: 120,
      };
    },
  };
}

function respostaDe(request: AiRequest): string {
  switch (request.type) {
    case 'sentimento':
      return JSON.stringify({
        geral: 'neutro',
        distribuicao: { positivo: 4, neutro: 5, negativo: 3 },
        destaques: ['Elogios ao atendimento', 'Reclamações sobre prazo'],
      });

    case 'temas':
      return JSON.stringify({
        temas: [
          { tema: 'Prazo de entrega', ocorrencias: 6, exemplo: 'Demorou mais do que o combinado.' },
          { tema: 'Atendimento', ocorrencias: 4, exemplo: 'A equipe foi atenciosa.' },
        ],
      });

    case 'resumo':
      return JSON.stringify({
        resumo: 'A maioria elogia o atendimento e critica o prazo de entrega.',
        pontosDeAtencao: ['Prazo acima do prometido em vários relatos.'],
      });

    case 'outliers':
      return JSON.stringify({
        outliers: [{ motivo: 'Nota muito abaixo da média com relato longo', quantidade: 2 }],
      });

    case 'melhoria_formulario':
      return JSON.stringify({
        sugestoes: [
          { campo: 'relato', sugestao: 'Reduza o texto de ajuda: ele é o campo com mais abandono.' },
        ],
      });
  }
}
