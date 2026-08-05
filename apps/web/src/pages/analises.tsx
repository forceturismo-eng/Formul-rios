import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Spinner } from '../components/ui.js';
import { usePermission } from '../lib/session.js';
import { Link } from '../lib/router.js';

/**
 * Análises com IA de um formulário.
 *
 * Duas exigências da seção 5.3 aparecem na tela e não são detalhe:
 *
 *  - **Fica claro que o conteúdo foi gerado por IA.** Um selo em cada
 *    resultado, não um aviso no rodapé que ninguém lê.
 *  - **Dá para desligar.** O interruptor de consentimento fica aqui, na mesma
 *    tela onde o recurso é usado, e não escondido em configurações.
 *
 * A tela também mostra quantos dados pessoais foram removidos antes do envio.
 * O cliente consentiu; ele merece ver o que o consentimento significou.
 */

interface AiSettings {
  enabled: boolean;
  consentedAt: string | null;
  available: boolean;
  limit: number;
  types: string[];
  providerConfigured: boolean;
}

interface Analise {
  id: string;
  type: string;
  result: Record<string, unknown>;
  model: string;
  tokensUsed: number;
  createdAt: string;
  generatedByAi: boolean;
}

const ROTULOS: Record<string, string> = {
  sentimento: 'Sentimento',
  temas: 'Temas recorrentes',
  resumo: 'Resumo executivo',
  outliers: 'Respostas que destoam',
  melhoria_formulario: 'Como melhorar o formulário',
};

const DESCRICOES: Record<string, string> = {
  sentimento: 'Como as pessoas se sentiram, no geral e na distribuição.',
  temas: 'O que mais aparece nas respostas, do mais para o menos frequente.',
  resumo: 'Um parágrafo com o essencial e os pontos que pedem atenção.',
  outliers: 'Respostas fora do padrão do conjunto, e por quê.',
  melhoria_formulario: 'Campos confusos, perguntas redundantes, ordem ruim.',
};

const dataHora = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function PaginaAnalises({ formId }: { formId: string }) {
  const { can } = usePermission();
  const cliente = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const [ultimaRedacao, setUltimaRedacao] = useState<{ total: number; unreadable: number } | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api<AiSettings>('/v1/ai/settings'),
    enabled: can('ai:run'),
  });

  const { data: analises } = useQuery({
    queryKey: ['ai-analyses', formId],
    queryFn: () => api<{ analyses: Analise[] }>(`/v1/forms/${formId}/ai-analyses`),
    enabled: can('ai:run'),
  });

  const consentir = useMutation({
    mutationFn: (enabled: boolean) => api('/v1/ai/consent', { method: 'PUT', body: { enabled } }),
    onSuccess: () => {
      setErro(null);
      void cliente.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos salvar essa escolha.'),
  });

  const pedir = useMutation({
    mutationFn: (type: string) =>
      api<{ status: string; redaction?: { total: number }; unreadableCount?: number }>(
        `/v1/forms/${formId}/ai-analyses`,
        { method: 'POST', body: { type } },
      ),
    onSuccess: (resultado) => {
      setErro(null);
      if (resultado.status === 'na_fila' && resultado.redaction) {
        setUltimaRedacao({
          total: resultado.redaction.total,
          unreadable: resultado.unreadableCount ?? 0,
        });
      }
      void cliente.invalidateQueries({ queryKey: ['ai-analyses', formId] });
    },
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos pedir a análise agora.'),
  });

  if (!can('ai:run')) {
    return (
      <LayoutPainel>
        <TituloDaPagina titulo="Análises" />
        <EstadoVazio
          titulo="Você não tem acesso às análises deste formulário"
          descricao="Peça a um administrador da empresa."
        />
      </LayoutPainel>
    );
  }

  if (isLoading || !settings) {
    return (
      <LayoutPainel>
        <Spinner />
      </LayoutPainel>
    );
  }

  return (
    <LayoutPainel>
      <TituloDaPagina
        titulo="Análises com IA"
        descricao="Leitura automática das respostas deste formulário."
        acao={
          <Link to={`/formularios/${formId}/respostas`} className="botao-secundario">
            Ver respostas
          </Link>
        }
      />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {!settings.available ? (
        <EstadoVazio
          titulo="As análises com IA fazem parte do plano Pro"
          descricao="Sentimento, temas recorrentes, resumo executivo e sugestões de melhoria do formulário — sobre as respostas que você já recebeu."
          acao={
            <Link to="/planos" className="botao-primario">
              Ver planos
            </Link>
          }
        />
      ) : (
        <>
          <ConsentimentoIA
            settings={settings}
            salvando={consentir.isPending}
            aoMudar={(ligado) => consentir.mutate(ligado)}
          />

          {settings.enabled && (
            <>
              {ultimaRedacao && (
                <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  Análise pedida. Antes de enviar, removemos {ultimaRedacao.total} dado(s) pessoal(is) das
                  respostas — nomes, e-mails, CPFs e telefones viraram rótulos.
                  {ultimaRedacao.unreadable > 0 && (
                    <>
                      {' '}
                      {ultimaRedacao.unreadable} resposta(s) não puderam ser lidas e ficaram de fora.
                    </>
                  )}{' '}
                  O resultado aparece aqui em instantes.
                </div>
              )}

              <div className="mb-8 grid gap-3 sm:grid-cols-2">
                {settings.types.map((tipo) => (
                  <button
                    key={tipo}
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-400 disabled:opacity-60"
                    disabled={pedir.isPending || !settings.providerConfigured}
                    onClick={() => pedir.mutate(tipo)}
                  >
                    <p className="font-medium text-slate-900">{ROTULOS[tipo] ?? tipo}</p>
                    <p className="mt-0.5 text-sm text-slate-500">{DESCRICOES[tipo] ?? ''}</p>
                  </button>
                ))}
              </div>

              {!settings.providerConfigured && (
                <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  As análises estão temporariamente indisponíveis. Já estamos vendo isso.
                </div>
              )}
            </>
          )}

          <Resultados analises={analises?.analyses ?? []} />
        </>
      )}
    </LayoutPainel>
  );
}

function ConsentimentoIA({
  settings,
  salvando,
  aoMudar,
}: {
  settings: AiSettings;
  salvando: boolean;
  aoMudar: (ligado: boolean) => void;
}) {
  return (
    <section className="mb-8 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-semibold text-slate-900">Enviar respostas para análise</h2>
          <p className="mt-1 text-sm text-slate-600">
            Para gerar as análises, o conteúdo das respostas é enviado a um provedor de IA. Antes de sair da
            nossa infraestrutura, removemos os dados pessoais: nomes, e-mails, CPFs, CNPJs, telefones, CEPs e
            números de cartão são substituídos por rótulos como <code className="font-mono">[EMAIL_1]</code>.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Você pode desligar quando quiser. Desligado, nenhuma resposta é enviada.
          </p>

          {settings.enabled && settings.consentedAt && (
            <p className="mt-2 text-xs text-slate-500">
              Ativado em {dataHora.format(new Date(settings.consentedAt))}.
            </p>
          )}
        </div>

        <button
          type="button"
          className={settings.enabled ? 'botao-secundario' : 'botao-primario'}
          disabled={salvando}
          onClick={() => aoMudar(!settings.enabled)}
        >
          {salvando ? 'Salvando…' : settings.enabled ? 'Desligar' : 'Ativar análises'}
        </button>
      </div>
    </section>
  );
}

function Resultados({ analises }: { analises: Analise[] }) {
  if (analises.length === 0) {
    return (
      <EstadoVazio
        titulo="Nenhuma análise ainda"
        descricao="Escolha um tipo acima. A primeira leva alguns segundos; depois, repetir a mesma análise sobre as mesmas respostas é instantâneo e não consome sua cota."
      />
    );
  }

  return (
    <div className="space-y-4">
      {analises.map((analise) => (
        <article key={analise.id} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-900">{ROTULOS[analise.type] ?? analise.type}</h3>

            {/* Requisito da seção 5.3: fica claro que foi gerado por IA. */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-800">
              Gerado por IA
            </span>
          </div>

          <p className="mt-0.5 text-xs text-slate-500">
            {dataHora.format(new Date(analise.createdAt))} · {analise.model}
          </p>

          <div className="mt-3">
            <ResultadoFormatado resultado={analise.result} />
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * Desenha o JSON devolvido pelo modelo.
 *
 * Genérico de propósito: o formato de cada tipo de análise é decidido no
 * prompt, e uma tela que soubesse de cada um exigiria mudança aqui a cada
 * ajuste de prompt. O modelo também pode devolver prosa quando não obedece ao
 * formato — e isso precisa aparecer, não sumir.
 */
function ResultadoFormatado({ resultado }: { resultado: Record<string, unknown> }) {
  if (typeof resultado['texto'] === 'string') {
    return <p className="whitespace-pre-line text-sm text-slate-700">{resultado['texto']}</p>;
  }

  return (
    <dl className="space-y-3 text-sm">
      {Object.entries(resultado).map(([chave, valor]) => (
        <div key={chave}>
          <dt className="font-medium text-slate-700">{humanizar(chave)}</dt>
          <dd className="mt-0.5 text-slate-600">{renderizarValor(valor)}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderizarValor(valor: unknown): React.ReactNode {
  if (valor === null || valor === undefined) return '—';

  if (Array.isArray(valor)) {
    return (
      <ul className="list-disc space-y-1 pl-5">
        {valor.map((item, indice) => (
          <li key={indice}>{renderizarValor(item)}</li>
        ))}
      </ul>
    );
  }

  if (typeof valor === 'object') {
    return (
      <ul className="space-y-0.5">
        {Object.entries(valor as Record<string, unknown>).map(([chave, interno]) => (
          <li key={chave}>
            <span className="text-slate-500">{humanizar(chave)}:</span> {renderizarValor(interno)}
          </li>
        ))}
      </ul>
    );
  }

  return String(valor);
}

function humanizar(chave: string): string {
  const comEspacos = chave.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return comEspacos.charAt(0).toUpperCase() + comEspacos.slice(1);
}
