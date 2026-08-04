import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FIELD_TYPES, formSchema, type FieldType, type FormDefinition, type FormField } from '@forms/shared';
import { ApiError, api } from '../lib/api.js';
import { Link } from '../lib/router.js';
import { LayoutPainel } from '../components/layout.js';
import { MensagemDeErro, Selo, Spinner } from '../components/ui.js';

/**
 * Builder de formulários.
 *
 * O estado da edição vive aqui, e a gravação leva o `revision` que foi lido —
 * é o lock otimista do backend. Se outra pessoa salvou no meio, o servidor
 * responde 409 e esta tela avisa em vez de sobrescrever o trabalho dela.
 */

interface FormularioCompleto {
  id: string;
  title: string;
  description: string | null;
  slugPublic: string;
  publicUrl: string;
  status: string;
  version: number;
  revision: number;
  definition: FormDefinition;
}

const ROTULO_DO_TIPO: Record<FieldType, string> = {
  short_text: 'Texto curto',
  long_text: 'Texto longo',
  email: 'E-mail',
  phone_br: 'Telefone',
  cpf_cnpj: 'CPF ou CNPJ',
  cep: 'CEP',
  number: 'Número',
  currency: 'Moeda',
  date: 'Data',
  time: 'Hora',
  datetime: 'Data e hora',
  single_select: 'Escolha única',
  multi_select: 'Múltipla escolha',
  dropdown: 'Lista suspensa',
  scale: 'Escala',
  nps: 'NPS',
  file_upload: 'Arquivo',
  signature: 'Assinatura',
  address: 'Endereço',
  matrix: 'Matriz',
  hidden: 'Campo oculto',
  payment: 'Pagamento',
};

const TIPOS_COM_OPCOES: FieldType[] = ['single_select', 'multi_select', 'dropdown'];

/** Id de campo a partir do rótulo, com sufixo para não colidir. */
function novoIdDeCampo(existentes: Set<string>, tipo: FieldType): string {
  const base = tipo.replace(/[^a-z]/g, '') || 'campo';
  let tentativa = base;
  let contador = 1;
  while (existentes.has(tentativa)) tentativa = `${base}${++contador}`;
  return tentativa;
}

function campoNovo(tipo: FieldType, existentes: Set<string>): FormField {
  const base: FormField = {
    id: novoIdDeCampo(existentes, tipo),
    type: tipo,
    label: ROTULO_DO_TIPO[tipo],
    required: false,
  };

  if (TIPOS_COM_OPCOES.includes(tipo)) {
    return {
      ...base,
      options: [
        { value: 'opcao-1', label: 'Opção 1' },
        { value: 'opcao-2', label: 'Opção 2' },
      ],
    };
  }

  if (tipo === 'matrix') {
    return {
      ...base,
      rows: [{ value: 'linha-1', label: 'Linha 1' }],
      columns: [{ value: 'coluna-1', label: 'Coluna 1' }],
    };
  }

  return base;
}

export function PaginaBuilder({ formId }: { formId: string }) {
  const cliente = useQueryClient();

  const [definicao, setDefinicao] = useState<FormDefinition | null>(null);
  const [titulo, setTitulo] = useState('');
  const [revisao, setRevisao] = useState(0);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvoEm, setSalvoEm] = useState<Date | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['formulario', formId],
    queryFn: () => api<FormularioCompleto>(`/v1/forms/${formId}/full`),
  });

  useEffect(() => {
    if (!data) return;
    setDefinicao(data.definition);
    setTitulo(data.title);
    setRevisao(data.revision);
  }, [data]);

  const salvar = useMutation({
    mutationFn: async () => {
      if (!definicao) throw new Error('nada para salvar');
      return api<FormularioCompleto>(`/v1/forms/${formId}`, {
        method: 'PATCH',
        // O `revision` lido volta ao servidor: é o que impede esta gravação de
        // apagar o que outra pessoa salvou enquanto esta aba estava aberta.
        body: { expectedRevision: revisao, title: titulo, definition: definicao },
      });
    },
    onSuccess: (atualizado) => {
      setRevisao(atualizado.revision);
      setSalvoEm(new Date());
      setErro(null);
      void cliente.invalidateQueries({ queryKey: ['formularios'] });
    },
    onError: (problema: unknown) => {
      if (problema instanceof ApiError && problema.code === 'conflict') {
        setErro(problema.message);
      } else if (problema instanceof ApiError) {
        const primeiro = problema.fieldErrors()[0];
        setErro(primeiro ? `${primeiro.message}` : problema.message);
      } else {
        setErro('Não conseguimos salvar agora. Tente de novo em instantes.');
      }
    },
  });

  const publicar = useMutation({
    mutationFn: () => api<FormularioCompleto>(`/v1/forms/${formId}/publish`, { method: 'POST' }),
    onSuccess: (atualizado) => {
      setRevisao(atualizado.revision);
      setErro(null);
      void cliente.invalidateQueries({ queryKey: ['formulario', formId] });
    },
    onError: (problema: unknown) => {
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos publicar agora.');
    },
  });

  const idsUsados = useMemo(
    () => new Set((definicao?.pages ?? []).flatMap((pagina) => pagina.fields.map((campo) => campo.id))),
    [definicao],
  );

  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Teclado também reordena: arrastar não pode ser o único caminho.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (isLoading || !definicao || !data) {
    return (
      <LayoutPainel>
        <Spinner label="Carregando formulário" />
      </LayoutPainel>
    );
  }

  const pagina = definicao.pages[0];
  const campos = pagina?.fields ?? [];
  const campoSelecionado = campos.find((campo) => campo.id === selecionado) ?? null;

  function atualizarCampos(proximos: FormField[]): void {
    setDefinicao((atual) => {
      if (!atual) return atual;
      const paginas = [...atual.pages];
      paginas[0] = { ...(paginas[0] as (typeof paginas)[0]), fields: proximos };
      return { ...atual, pages: paginas };
    });
  }

  function adicionar(tipo: FieldType): void {
    const campo = campoNovo(tipo, idsUsados);
    atualizarCampos([...campos, campo]);
    setSelecionado(campo.id);
  }

  function editar(id: string, mudancas: Partial<FormField>): void {
    atualizarCampos(campos.map((campo) => (campo.id === id ? { ...campo, ...mudancas } : campo)));
  }

  function remover(id: string): void {
    atualizarCampos(campos.filter((campo) => campo.id !== id));
    if (selecionado === id) setSelecionado(null);
  }

  function aoSoltar(evento: DragEndEvent): void {
    const { active, over } = evento;
    if (!over || active.id === over.id) return;

    const de = campos.findIndex((campo) => campo.id === active.id);
    const para = campos.findIndex((campo) => campo.id === over.id);
    if (de < 0 || para < 0) return;

    atualizarCampos(arrayMove(campos, de, para));
  }

  const schemaValido = formSchema.safeParse(definicao).success;

  return (
    <LayoutPainel>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to="/formularios" className="text-sm text-slate-500 hover:text-slate-900">
            ← Formulários
          </Link>
          <input
            className="rounded-lg border border-transparent px-2 py-1 text-xl font-semibold text-slate-900 hover:border-slate-300 focus:border-slate-400 focus:outline-none"
            value={titulo}
            onChange={(evento) => setTitulo(evento.target.value)}
          />
          <Selo estado={data.status} />
        </div>

        <div className="flex items-center gap-2">
          {salvoEm && (
            <span className="text-xs text-slate-400">
              Salvo às {salvoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <Link to={`/formularios/${formId}/respostas`} className="botao-secundario">
            Respostas
          </Link>
          <button
            type="button"
            className="botao-secundario"
            onClick={() => salvar.mutate()}
            disabled={salvar.isPending}
          >
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
          <button
            type="button"
            className="botao-primario"
            onClick={() => publicar.mutate()}
            disabled={publicar.isPending || !schemaValido || campos.length === 0}
          >
            {publicar.isPending ? 'Publicando…' : 'Publicar'}
          </button>
        </div>
      </div>

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {data.status === 'published' && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <span className="text-slate-500">Link público:</span>{' '}
          <a
            href={`/f/${data.slugPublic}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-slate-900 hover:underline"
          >
            /f/{data.slugPublic}
          </a>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr_300px]">
        <aside className="space-y-1">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Adicionar campo</p>
          {FIELD_TYPES.filter((tipo) => tipo !== 'payment' && tipo !== 'hidden').map((tipo) => (
            <button
              key={tipo}
              type="button"
              onClick={() => adicionar(tipo)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50"
            >
              {ROTULO_DO_TIPO[tipo]}
            </button>
          ))}
        </aside>

        <section>
          {campos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">
              Escolha um tipo de campo à esquerda para começar.
            </div>
          ) : (
            <DndContext sensors={sensores} collisionDetection={closestCenter} onDragEnd={aoSoltar}>
              <SortableContext items={campos.map((campo) => campo.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {campos.map((campo) => (
                    <CampoArrastavel
                      key={campo.id}
                      campo={campo}
                      selecionado={selecionado === campo.id}
                      aoSelecionar={() => setSelecionado(campo.id)}
                      aoRemover={() => remover(campo.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </section>

        <aside>
          {campoSelecionado ? (
            <PainelDoCampo campo={campoSelecionado} aoEditar={(mudancas) => editar(campoSelecionado.id, mudancas)} />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
              Selecione um campo para editar as propriedades.
            </div>
          )}
        </aside>
      </div>
    </LayoutPainel>
  );
}

function CampoArrastavel({
  campo,
  selecionado,
  aoSelecionar,
  aoRemover,
}: {
  campo: FormField;
  selecionado: boolean;
  aoSelecionar: () => void;
  aoRemover: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: campo.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      onClick={aoSelecionar}
      className={`flex items-center gap-3 rounded-xl border bg-white p-4 ${
        selecionado ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <button
        type="button"
        className="cursor-grab text-slate-400 hover:text-slate-600 active:cursor-grabbing"
        aria-label={`Reordenar ${campo.label}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">
          {campo.label}
          {campo.required && <span className="ml-1 text-red-500">*</span>}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {ROTULO_DO_TIPO[campo.type]} · <code>{campo.id}</code>
        </p>
      </div>

      <button
        type="button"
        onClick={(evento) => {
          evento.stopPropagation();
          aoRemover();
        }}
        className="text-sm text-slate-400 hover:text-red-600"
        aria-label={`Remover ${campo.label}`}
      >
        Remover
      </button>
    </div>
  );
}

function PainelDoCampo({ campo, aoEditar }: { campo: FormField; aoEditar: (mudancas: Partial<FormField>) => void }) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Propriedades</p>

      <div>
        <label className="rotulo">Rótulo</label>
        <input className="campo" value={campo.label} onChange={(e) => aoEditar({ label: e.target.value })} />
      </div>

      <div>
        <label className="rotulo">Texto de ajuda</label>
        <input
          className="campo"
          value={campo.description ?? ''}
          onChange={(e) => aoEditar({ description: e.target.value || undefined })}
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={campo.required}
          onChange={(e) => aoEditar({ required: e.target.checked })}
          className="h-4 w-4"
        />
        Campo obrigatório
      </label>

      {TIPOS_COM_OPCOES.includes(campo.type) && (
        <div>
          <label className="rotulo">Opções</label>
          <div className="space-y-2">
            {(campo.options ?? []).map((opcao, indice) => (
              <div key={indice} className="flex gap-2">
                <input
                  className="campo"
                  value={opcao.label}
                  onChange={(e) => {
                    const opcoes = [...(campo.options ?? [])];
                    opcoes[indice] = {
                      // O `value` acompanha o rótulo, porque é ele que vai para
                      // a resposta gravada — e um valor solto de rótulo vira
                      // relatório ilegível seis meses depois.
                      value: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `opcao-${indice + 1}`,
                      label: e.target.value,
                    };
                    aoEditar({ options: opcoes });
                  }}
                />
                <button
                  type="button"
                  className="botao-secundario px-2"
                  onClick={() => aoEditar({ options: (campo.options ?? []).filter((_, i) => i !== indice) })}
                  aria-label="Remover opção"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="botao-secundario w-full"
              onClick={() =>
                aoEditar({
                  options: [
                    ...(campo.options ?? []),
                    { value: `opcao-${(campo.options?.length ?? 0) + 1}`, label: `Opção ${(campo.options?.length ?? 0) + 1}` },
                  ],
                })
              }
            >
              Adicionar opção
            </button>
          </div>
        </div>
      )}

      {(campo.type === 'number' || campo.type === 'currency') && (
        <div>
          <label className="rotulo">Cálculo</label>
          <input
            className="campo"
            placeholder="quantidade * preco"
            value={campo.calculation ?? ''}
            onChange={(e) => aoEditar({ calculation: e.target.value || undefined })}
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Use os identificadores dos campos e os operadores + − × ÷.
          </p>
        </div>
      )}
    </div>
  );
}
