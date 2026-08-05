import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { Link, useNavigate } from '../lib/router.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Selo, Spinner } from '../components/ui.js';

/** Lista de formulários da empresa. */

interface FormularioResumo {
  id: string;
  title: string;
  slugPublic: string;
  status: string;
  version: number;
  responseCount: number;
  updatedAt: string;
}

const dataCurta = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

export function PaginaFormularios() {
  const navigate = useNavigate();
  const cliente = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['formularios'],
    queryFn: () => api<{ forms: FormularioResumo[] }>('/v1/forms'),
  });

  const criar = useMutation({
    mutationFn: () => api<{ id: string }>('/v1/forms', { method: 'POST', body: { title: 'Formulário sem título' } }),
    onSuccess: (criado) => {
      void cliente.invalidateQueries({ queryKey: ['formularios'] });
      navigate(`/formularios/${criado.id}`);
    },
    onError: (problema: unknown) => {
      // Limite de plano volta 402 com o caminho de saída no corpo. Mostrar a
      // mensagem do servidor é melhor do que inventar uma aqui.
      setErro(
        problema instanceof ApiError ? problema.message : 'Não conseguimos criar o formulário agora.',
      );
    },
  });

  return (
    <LayoutPainel>
      <TituloDaPagina
        titulo="Formulários"
        descricao="Crie, publique e acompanhe o que chega."
        acao={
          <button type="button" className="botao-primario" onClick={() => criar.mutate()} disabled={criar.isPending}>
            {criar.isPending ? 'Criando…' : 'Criar formulário'}
          </button>
        }
      />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {isLoading && <Spinner label="Carregando formulários" />}

      {!isLoading && data?.forms.length === 0 && (
        <EstadoVazio
          titulo="Nenhum formulário ainda"
          descricao="Crie o primeiro e publique em menos de um minuto."
          acao={
            <button type="button" className="botao-primario" onClick={() => criar.mutate()}>
              Criar meu primeiro formulário
            </button>
          }
        />
      )}

      {data && data.forms.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Formulário</th>
                <th className="px-4 py-3 font-medium">Situação</th>
                <th className="px-4 py-3 font-medium">Respostas</th>
                <th className="px-4 py-3 font-medium">Atualizado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.forms.map((formulario) => (
                <tr key={formulario.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/formularios/${formulario.id}`} className="font-medium text-slate-900 hover:underline">
                      {formulario.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">/f/{formulario.slugPublic}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Selo estado={formulario.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">{formulario.responseCount}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {dataCurta.format(new Date(formulario.updatedAt))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3">
                      <Link
                        to={`/formularios/${formulario.id}/respostas`}
                        className="text-sm font-medium text-slate-600 hover:text-slate-900"
                      >
                        Ver respostas
                      </Link>
                      <Link
                        to={`/formularios/${formulario.id}/analises`}
                        className="text-sm font-medium text-slate-600 hover:text-slate-900"
                      >
                        Análises
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </LayoutPainel>
  );
}
