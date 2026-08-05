import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Spinner } from '../components/ui.js';
import { usePermission } from '../lib/session.js';

/**
 * White-label: logo, cores, prévia do link e CSS customizado.
 *
 * A decisão de interface que importa aqui é a prévia do CSS. Sem ela, o cliente
 * escreve uma regra, salva, e descobre que ela sumiu — sem saber qual, nem por
 * quê. A lista de removidos é a explicação, e ela aparece enquanto ele digita,
 * não depois de gravar.
 */

interface BrandingResposta {
  branding: {
    logoUrl: string | null;
    faviconUrl: string | null;
    ogImageUrl: string | null;
    primaryColor: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    customCss: string | null;
  };
  preview: { css: string; removidos: string[] };
  features: { removeBranding: boolean; customCss: boolean };
}

type CamposDeTexto = keyof BrandingResposta['branding'];

const CAMPOS: Array<{ chave: CamposDeTexto; rotulo: string; ajuda: string; placeholder: string }> = [
  {
    chave: 'logoUrl',
    rotulo: 'Logo',
    ajuda: 'Aparece no topo dos seus formulários. Endereço https de uma imagem.',
    placeholder: 'https://suaempresa.com.br/logo.png',
  },
  {
    chave: 'faviconUrl',
    rotulo: 'Favicon',
    ajuda: 'O ícone da aba do navegador.',
    placeholder: 'https://suaempresa.com.br/favicon.png',
  },
  {
    chave: 'ogImageUrl',
    rotulo: 'Imagem da prévia',
    ajuda: 'A imagem do cartão quando alguém compartilha o link no WhatsApp. Use 1200×630.',
    placeholder: 'https://suaempresa.com.br/preview.png',
  },
  {
    chave: 'metaTitle',
    rotulo: 'Título da prévia',
    ajuda: 'Em branco, usamos o título do próprio formulário.',
    placeholder: 'Fale com a nossa equipe',
  },
  {
    chave: 'metaDescription',
    rotulo: 'Descrição da prévia',
    ajuda: 'A linha abaixo do título no cartão do link. Até 200 caracteres.',
    placeholder: 'Responda em dois minutos e retornamos no mesmo dia.',
  },
];

export function PaginaMarca() {
  const { can } = usePermission();
  const cliente = useQueryClient();

  const [rascunho, setRascunho] = useState<BrandingResposta['branding'] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api<BrandingResposta>('/v1/branding'),
    enabled: can('org:update'),
  });

  useEffect(() => {
    if (data && !rascunho) setRascunho(data.branding);
  }, [data, rascunho]);

  /** Prévia do CSS no servidor: a mesma função que decide o que vai ao ar. */
  const previa = useMutation({
    mutationFn: (css: string) => api<{ css: string; removidos: string[] }>('/v1/branding/preview-css', {
      method: 'POST',
      body: { css },
    }),
  });

  const salvar = useMutation({
    mutationFn: (valores: BrandingResposta['branding']) =>
      api('/v1/branding', { method: 'PATCH', body: valores }),
    onSuccess: () => {
      setErro(null);
      setSalvo(true);
      void cliente.invalidateQueries({ queryKey: ['branding'] });
    },
    onError: (problema: unknown) => {
      setSalvo(false);
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos salvar agora.');
    },
  });

  if (!can('org:update')) {
    return (
      <LayoutPainel>
        <TituloDaPagina titulo="Marca" />
        <EstadoVazio
          titulo="Você não administra a marca desta empresa"
          descricao="Peça a um administrador para ajustar logo, cores e o visual dos formulários."
        />
      </LayoutPainel>
    );
  }

  if (isLoading || !data || !rascunho) {
    return (
      <LayoutPainel>
        <Spinner />
      </LayoutPainel>
    );
  }

  function alterar(chave: CamposDeTexto, valor: string) {
    setSalvo(false);
    setRascunho((atual) => (atual ? { ...atual, [chave]: valor } : atual));
  }

  const removidos = previa.data?.removidos ?? data.preview.removidos;

  return (
    <LayoutPainel>
      <TituloDaPagina
        titulo="Marca"
        descricao="Como seus formulários aparecem para quem responde — e como o link deles aparece quando é compartilhado."
      />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {salvo && (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Salvo. As mudanças já valem para quem abrir seus formulários agora.
        </div>
      )}

      {!data.features.removeBranding && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <p className="font-medium text-slate-900">Seus formulários ainda mostram a nossa marca</p>
          <p className="mt-1">
            No plano Pro o rodapé sai, e o formulário fica inteiramente com a cara da sua empresa. Logo, cores e
            prévia do link você já pode configurar aqui.
          </p>
        </div>
      )}

      <form
        className="space-y-6"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (rascunho) salvar.mutate(rascunho);
        }}
      >
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-900">Cor</h2>

          <div className="mt-3 flex items-center gap-3">
            <input
              type="color"
              className="h-10 w-14 cursor-pointer rounded border border-slate-300"
              value={rascunho.primaryColor ?? '#2563eb'}
              onChange={(evento) => alterar('primaryColor', evento.target.value)}
              aria-label="Cor principal"
            />
            <input
              className="w-32 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              value={rascunho.primaryColor ?? ''}
              placeholder="#2563eb"
              onChange={(evento) => alterar('primaryColor', evento.target.value)}
            />
            <p className="text-sm text-slate-500">Usada em botões e destaques.</p>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-900">Imagens e prévia do link</h2>

          {CAMPOS.map((campo) => (
            <div key={campo.chave}>
              <label className="block text-sm font-medium text-slate-700" htmlFor={campo.chave}>
                {campo.rotulo}
              </label>
              <input
                id={campo.chave}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                value={rascunho[campo.chave] ?? ''}
                placeholder={campo.placeholder}
                onChange={(evento) => alterar(campo.chave, evento.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">{campo.ajuda}</p>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold text-slate-900">CSS customizado</h2>
            {!data.features.customCss && (
              <span className="text-sm text-slate-500">Disponível no plano Business</span>
            )}
          </div>

          {data.features.customCss ? (
            <>
              <p className="mt-1 text-sm text-slate-500">
                Aceitamos um conjunto de propriedades de aparência — cores, espaçamento, tipografia, bordas. O que
                estiver fora dele é removido, e a lista abaixo diz o quê.
              </p>

              <textarea
                className="mt-3 h-56 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                value={rascunho.customCss ?? ''}
                placeholder={'.cartao {\n  border-radius: 16px;\n}'}
                onChange={(evento) => {
                  alterar('customCss', evento.target.value);
                  previa.mutate(evento.target.value);
                }}
              />

              {removidos.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium">Isto não vai ao ar:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {removidos.map((motivo) => (
                      <li key={motivo}>{motivo}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              No plano Business você ajusta o visual dos formulários com CSS próprio, além de logo e cores.
            </p>
          )}
        </section>

        <button type="submit" className="botao-primario" disabled={salvar.isPending}>
          {salvar.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </form>
    </LayoutPainel>
  );
}
