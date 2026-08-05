import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { allFields, tempoRelativo, type FormDefinition } from '@forms/shared';
import { ApiError, api } from '../lib/api.js';
import { Link } from '../lib/router.js';
import { LayoutPainel } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Selo, Spinner } from '../components/ui.js';

/** Painel de recebimentos: filtros, busca e exportação. */

interface RespostaDecifrada {
  id: string;
  status: string;
  isFlagged: boolean;
  isBuffered: boolean;
  createdAt: string;
  values: Record<string, unknown>;
}

interface PaginaDeRespostas {
  responses: RespostaDecifrada[];
  total: number;
  page: number;
  pageSize: number;
  form: { id: string; title: string; definition: FormDefinition };
}

const dataHora = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function textoDoValor(valor: unknown): string {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (Array.isArray(valor)) return valor.join(', ');
  if (typeof valor === 'object') return JSON.stringify(valor);
  return String(valor);
}

export function PaginaRespostas({ formId }: { formId: string }) {
  const cliente = useQueryClient();
  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState('');
  const [pagina, setPagina] = useState(1);
  const [aberta, setAberta] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const parametros = new URLSearchParams({ page: String(pagina), pageSize: '25' });
  if (busca) parametros.set('search', busca);
  if (status) parametros.set('status', status);

  const { data, isLoading } = useQuery({
    queryKey: ['respostas', formId, busca, status, pagina],
    queryFn: () => api<PaginaDeRespostas>(`/v1/forms/${formId}/responses?${parametros.toString()}`),
  });

  const exportar = useMutation({
    mutationFn: (formato: 'csv' | 'xlsx') =>
      api<{ id: string; message: string }>(`/v1/forms/${formId}/exports`, {
        method: 'POST',
        body: { format: formato, ...(status ? { status } : {}), ...(busca ? { search: busca } : {}) },
      }),
    onError: (problema: unknown) => {
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos preparar a exportação agora.');
    },
  });

  const marcar = useMutation({
    mutationFn: ({ id, mudanca }: { id: string; mudanca: Record<string, unknown> }) =>
      api(`/v1/responses/${id}`, { method: 'PATCH', body: mudanca }),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['respostas', formId] }),
  });

  const campos = data ? allFields(data.form.definition).slice(0, 4) : [];
  const totalDePaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <LayoutPainel>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link to={`/formularios/${formId}`} className="text-sm text-slate-500 hover:text-slate-900">
            ← Voltar ao formulário
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{data?.form.title ?? 'Respostas'}</h1>
          {data && <p className="mt-1 text-sm text-slate-500">{data.total} resposta(s)</p>}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="botao-secundario"
            onClick={() => exportar.mutate('csv')}
            disabled={exportar.isPending}
          >
            Exportar CSV
          </button>
          <button
            type="button"
            className="botao-secundario"
            onClick={() => exportar.mutate('xlsx')}
            disabled={exportar.isPending}
          >
            Exportar Excel
          </button>
        </div>
      </div>

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {exportar.isSuccess && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          {exportar.data.message} Ele aparece em Exportações quando ficar pronto.
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-3">
        <input
          className="campo max-w-xs"
          placeholder="Buscar no conteúdo…"
          value={busca}
          onChange={(evento) => {
            setBusca(evento.target.value);
            setPagina(1);
          }}
        />
        <select
          className="campo max-w-[180px]"
          value={status}
          onChange={(evento) => {
            setStatus(evento.target.value);
            setPagina(1);
          }}
        >
          <option value="">Todas as situações</option>
          <option value="new">Novas</option>
          <option value="reviewed">Revisadas</option>
          <option value="archived">Arquivadas</option>
        </select>
      </div>

      {isLoading && <Spinner label="Carregando respostas" />}

      {!isLoading && data?.responses.length === 0 && (
        <EstadoVazio
          titulo="Nenhuma resposta ainda"
          descricao={
            busca || status
              ? 'Nenhuma resposta corresponde ao filtro. Tente ajustar a busca.'
              : 'Divulgue o link público do formulário para começar a receber.'
          }
        />
      )}

      {data && data.responses.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Recebida</th>
                  {campos.map((campo) => (
                    <th key={campo.id} className="px-4 py-3 font-medium">
                      {campo.label}
                    </th>
                  ))}
                  <th className="px-4 py-3 font-medium">Situação</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.responses.map((resposta) => (
                  <tr key={resposta.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                      {dataHora.format(new Date(resposta.createdAt))}
                    </td>
                    {campos.map((campo) => (
                      <td key={campo.id} className="max-w-[220px] truncate px-4 py-3 text-slate-700">
                        {textoDoValor(resposta.values[campo.id])}
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Selo estado={resposta.status} />
                        {/* Resposta recebida na cortesia de 48h continua aqui,
                            visível e marcada — ela nunca é apagada. */}
                        {resposta.isBuffered && (
                          <span
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                            title="Recebida durante o período de cortesia"
                          >
                            cortesia
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="text-sm font-medium text-slate-600 hover:text-slate-900"
                        onClick={() => setAberta(aberta === resposta.id ? null : resposta.id)}
                      >
                        {aberta === resposta.id ? 'Fechar' : 'Ver'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {aberta && (
            <DetalheDaResposta
              resposta={data.responses.find((r) => r.id === aberta) as RespostaDecifrada}
              definicao={data.form.definition}
              aoMarcar={(mudanca) => marcar.mutate({ id: aberta, mudanca })}
            />
          )}

          {totalDePaginas > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <button
                type="button"
                className="botao-secundario"
                disabled={pagina <= 1}
                onClick={() => setPagina((atual) => atual - 1)}
              >
                Anterior
              </button>
              <span className="text-slate-500">
                Página {pagina} de {totalDePaginas}
              </span>
              <button
                type="button"
                className="botao-secundario"
                disabled={pagina >= totalDePaginas}
                onClick={() => setPagina((atual) => atual + 1)}
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </LayoutPainel>
  );
}

function DetalheDaResposta({
  resposta,
  definicao,
  aoMarcar,
}: {
  resposta: RespostaDecifrada;
  definicao: FormDefinition;
  aoMarcar: (mudanca: Record<string, unknown>) => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-slate-900">Resposta completa</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className="botao-secundario"
            onClick={() => aoMarcar({ status: resposta.status === 'reviewed' ? 'new' : 'reviewed' })}
          >
            {resposta.status === 'reviewed' ? 'Marcar como nova' : 'Marcar como revisada'}
          </button>
          <button type="button" className="botao-secundario" onClick={() => aoMarcar({ isFlagged: !resposta.isFlagged })}>
            {resposta.isFlagged ? 'Desmarcar' : 'Marcar'}
          </button>
        </div>
      </div>

      <dl className="space-y-3">
        {allFields(definicao).map((campo) => (
          <div key={campo.id} className="grid gap-1 sm:grid-cols-[220px_1fr]">
            <dt className="text-sm text-slate-500">{campo.label}</dt>
            <dd className="text-sm text-slate-900">{textoDoValor(resposta.values[campo.id])}</dd>
          </div>
        ))}
      </dl>

      <Comentarios responseId={resposta.id} />
    </div>
  );
}

interface Comentario {
  id: string;
  body: string;
  mentions: string[];
  createdAt: string;
  user: { id: string; name: string };
}

/**
 * Comentários de uma resposta.
 *
 * A menção é por e-mail (`@pessoa@empresa.com.br`) e só vale para quem já é da
 * empresa — a API descarta o resto. O seletor existe para ninguém precisar
 * decorar endereço, mas digitar à mão funciona igual.
 *
 * O aviso de menção sai por e-mail SEM o conteúdo do comentário: ele fala de
 * uma resposta de formulário, que é dado pessoal de terceiro, e a caixa de
 * entrada é o canal menos controlado que existe.
 */
function Comentarios({ responseId }: { responseId: string }) {
  const cliente = useQueryClient();
  const [texto, setTexto] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['comentarios', responseId],
    queryFn: () => api<{ comments: Comentario[] }>(`/v1/responses/${responseId}/comments`),
  });

  const { data: equipe } = useQuery({
    queryKey: ['membros'],
    queryFn: () => api<{ members: Array<{ user: { name: string; email: string } }> }>('/v1/members'),
  });

  const comentar = useMutation({
    mutationFn: () => api(`/v1/responses/${responseId}/comments`, { method: 'POST', body: { body: texto } }),
    onSuccess: () => {
      setTexto('');
      void cliente.invalidateQueries({ queryKey: ['comentarios', responseId] });
    },
  });

  return (
    <section className="mt-8 border-t border-slate-200 pt-6">
      <h3 className="font-medium text-slate-900">Comentários</h3>
      <p className="mt-0.5 text-sm text-slate-500">
        Visíveis só para a equipe. Quem respondeu o formulário nunca vê isto.
      </p>

      {isLoading && <Spinner label="Carregando comentários" />}

      {data && data.comments.length > 0 && (
        <ul className="mt-4 space-y-3">
          {data.comments.map((comentario) => (
            <li key={comentario.id} className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-slate-900">{comentario.user.name}</span>
                <span className="text-xs text-slate-500">{tempoRelativo(new Date(comentario.createdAt))}</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{comentario.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-4 space-y-2"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (texto.trim()) comentar.mutate();
        }}
      >
        <textarea
          className="h-24 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Escreva um comentário. Use @ para chamar alguém da equipe."
          value={texto}
          onChange={(evento) => setTexto(evento.target.value)}
        />

        <div className="flex flex-wrap items-center gap-2">
          {(equipe?.members ?? []).slice(0, 6).map((membro) => (
            <button
              key={membro.user.email}
              type="button"
              className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:border-slate-400"
              onClick={() => setTexto((atual) => `${atual}${atual && !atual.endsWith(' ') ? ' ' : ''}@${membro.user.email} `)}
            >
              @{membro.user.name.split(' ')[0]}
            </button>
          ))}

          <button type="submit" className="botao-primario ml-auto" disabled={comentar.isPending}>
            {comentar.isPending ? 'Enviando…' : 'Comentar'}
          </button>
        </div>
      </form>
    </section>
  );
}
