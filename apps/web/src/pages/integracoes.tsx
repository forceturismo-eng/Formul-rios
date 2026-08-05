import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Spinner } from '../components/ui.js';
import { usePermission } from '../lib/session.js';

/**
 * Integrações: domínio próprio, webhooks e chaves de API.
 *
 * O elemento de interface mais importante desta tela é o painel de segredo
 * revelado. Webhook e chave de API são mostrados uma única vez, e a tela
 * precisa deixar isso inequívoco ANTES de o usuário fechar o painel — porque
 * depois não há recuperação, só nova emissão.
 */

interface DominiosResposta {
  domains: Array<{
    id: string;
    domain: string;
    type: string;
    status: string;
    dnsError: string | null;
    verifiedAt: string | null;
  }>;
  cnameTarget: string;
}

interface RegistroDns {
  tipo: string;
  nome: string;
  valor: string;
  observacao?: string;
}

interface WebhooksResposta {
  webhooks: Array<{
    id: string;
    url: string;
    formId: string | null;
    events: string[];
    isActive: boolean;
    lastStatus: number | null;
    failureCount: number;
  }>;
  events: string[];
}

interface ChavesResposta {
  apiKeys: Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
  }>;
  scopes: string[];
}

const dataCurta = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatarData(valor: string | null): string {
  return valor ? dataCurta.format(new Date(valor)) : '—';
}

function mensagemDe(problema: unknown, padrao: string): string {
  return problema instanceof ApiError ? problema.message : padrao;
}

// -----------------------------------------------------------------------------

/**
 * Painel de segredo revelado.
 *
 * Sem botão de "fechar" discreto: fechar é uma ação deliberada, com o texto
 * dizendo o que se perde. É o único momento em que este valor existe fora do
 * servidor.
 */
function SegredoRevelado({
  titulo,
  valor,
  aoFechar,
}: {
  titulo: string;
  valor: string;
  aoFechar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">{titulo}</p>
      <p className="mt-1 text-sm text-amber-900">
        Copie agora. Assim que você fechar este aviso, não teremos mais como mostrá-lo — só emitir um novo.
      </p>

      <code className="mt-3 block overflow-x-auto rounded-lg border border-amber-200 bg-white px-3 py-2 font-mono text-sm text-slate-800">
        {valor}
      </code>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => {
            void navigator.clipboard?.writeText(valor);
            setCopiado(true);
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
        <button
          type="button"
          className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-white/60"
          onClick={aoFechar}
        >
          Já guardei, pode fechar
        </button>
      </div>
    </div>
  );
}

function Secao({ titulo, descricao, children }: { titulo: string; descricao: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">{descricao}</p>
      {children}
    </section>
  );
}

// -----------------------------------------------------------------------------

function SecaoDominios() {
  const cliente = useQueryClient();
  const [novo, setNovo] = useState('');
  const [instrucoes, setInstrucoes] = useState<{ domain: string; registros: RegistroDns[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dominios'],
    queryFn: () => api<DominiosResposta>('/v1/custom-domains'),
  });

  const adicionar = useMutation({
    mutationFn: (domain: string) =>
      api<{ domain: string; instructions: { registros: RegistroDns[] } }>('/v1/custom-domains', {
        method: 'POST',
        body: { domain },
      }),
    onSuccess: (criado) => {
      setNovo('');
      setErro(null);
      setInstrucoes({ domain: criado.domain, registros: criado.instructions.registros });
      void cliente.invalidateQueries({ queryKey: ['dominios'] });
    },
    onError: (problema) => setErro(mensagemDe(problema, 'Não conseguimos cadastrar este domínio.')),
  });

  const verificar = useMutation({
    mutationFn: (id: string) =>
      api<{ verified: boolean; dnsError: string | null }>(`/v1/custom-domains/${id}/verify`, { method: 'POST' }),
    onSuccess: (resultado) => {
      setErro(
        resultado.verified
          ? null
          : (resultado.dnsError ?? 'Ainda não encontramos os registros. O DNS pode levar algumas horas.'),
      );
      void cliente.invalidateQueries({ queryKey: ['dominios'] });
    },
  });

  const remover = useMutation({
    mutationFn: (id: string) => api(`/v1/custom-domains/${id}`, { method: 'DELETE' }),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['dominios'] }),
  });

  if (isLoading) return <Spinner />;

  return (
    <Secao
      titulo="Domínio próprio"
      descricao="Seus formulários no seu endereço. O certificado é emitido automaticamente assim que o DNS aponta para cá."
    >
      {erro && (
        <div className="mb-4">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (novo.trim()) adicionar.mutate(novo.trim());
        }}
      >
        <input
          className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="formularios.suaempresa.com.br"
          value={novo}
          onChange={(evento) => setNovo(evento.target.value)}
        />
        <button type="submit" className="botao-primario" disabled={adicionar.isPending}>
          {adicionar.isPending ? 'Cadastrando…' : 'Adicionar domínio'}
        </button>
      </form>

      {instrucoes && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="font-medium text-slate-900">Configure estes registros em {instrucoes.domain}</p>
          <p className="mt-1 text-sm text-slate-500">
            Depois de salvar no seu provedor de DNS, volte aqui e clique em “Verificar”. A propagação costuma levar
            de alguns minutos a algumas horas.
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 pr-4">Tipo</th>
                  <th className="pb-2 pr-4">Nome</th>
                  <th className="pb-2">Valor</th>
                </tr>
              </thead>
              <tbody className="font-mono text-slate-800">
                {instrucoes.registros.map((registro) => (
                  <tr key={`${registro.tipo}-${registro.nome}`} className="border-t border-slate-100">
                    <td className="py-2 pr-4">{registro.tipo}</td>
                    <td className="py-2 pr-4">{registro.nome}</td>
                    <td className="py-2">
                      {registro.valor}
                      {registro.observacao && (
                        <span className="mt-1 block font-sans text-xs text-slate-500">{registro.observacao}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.domains.length === 0 ? (
        <EstadoVazio
          titulo="Nenhum domínio próprio ainda"
          descricao="Enquanto isso, seus formulários continuam disponíveis no endereço padrão."
        />
      ) : (
        <ul className="space-y-2">
          {data?.domains.map((dominio) => (
            <li
              key={dominio.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <div>
                <p className="font-medium text-slate-900">{dominio.domain}</p>
                <p className="text-sm text-slate-500">
                  {dominio.status === 'active'
                    ? `Ativo desde ${formatarData(dominio.verifiedAt)}`
                    : (dominio.dnsError ?? 'Aguardando os registros de DNS')}
                </p>
              </div>

              <div className="flex gap-2">
                {dominio.status !== 'active' && (
                  <button
                    type="button"
                    className="botao-secundario"
                    onClick={() => verificar.mutate(dominio.id)}
                    disabled={verificar.isPending}
                  >
                    Verificar
                  </button>
                )}
                <button
                  type="button"
                  className="text-sm text-slate-500 hover:text-red-700"
                  onClick={() => remover.mutate(dominio.id)}
                >
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Secao>
  );
}

// -----------------------------------------------------------------------------

function SecaoWebhooks() {
  const cliente = useQueryClient();
  const [url, setUrl] = useState('');
  const [eventos, setEventos] = useState<string[]>(['response.created']);
  const [segredo, setSegredo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<WebhooksResposta>('/v1/webhooks'),
  });

  const criar = useMutation({
    mutationFn: () => api<{ secret: string }>('/v1/webhooks', { method: 'POST', body: { url, events: eventos } }),
    onSuccess: (criado) => {
      setUrl('');
      setErro(null);
      setSegredo(criado.secret);
      void cliente.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (problema) => setErro(mensagemDe(problema, 'Não conseguimos cadastrar este webhook.')),
  });

  const remover = useMutation({
    mutationFn: (id: string) => api(`/v1/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  if (isLoading) return <Spinner />;

  return (
    <Secao
      titulo="Webhooks"
      descricao="Avisamos seu sistema a cada resposta recebida. Toda entrega vai assinada, para você conferir que veio mesmo de nós."
    >
      {erro && (
        <div className="mb-4">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {segredo && (
        <div className="mb-4">
          <SegredoRevelado
            titulo="Segredo de assinatura do webhook"
            valor={segredo}
            aoFechar={() => setSegredo(null)}
          />
        </div>
      )}

      <form
        className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (url.trim() && eventos.length > 0) criar.mutate();
        }}
      >
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="https://seusistema.com.br/webhooks/formularios"
          value={url}
          onChange={(evento) => setUrl(evento.target.value)}
        />

        <div className="flex flex-wrap gap-3">
          {(data?.events ?? []).map((evento) => (
            <label key={evento} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={eventos.includes(evento)}
                onChange={(mudanca) =>
                  setEventos((atuais) =>
                    mudanca.target.checked ? [...atuais, evento] : atuais.filter((item) => item !== evento),
                  )
                }
              />
              <code className="font-mono text-xs">{evento}</code>
            </label>
          ))}
        </div>

        <button type="submit" className="botao-primario" disabled={criar.isPending}>
          {criar.isPending ? 'Cadastrando…' : 'Cadastrar webhook'}
        </button>

        <p className="text-xs text-slate-500">
          O endereço precisa usar https e responder em até 10 segundos. Depois de 20 falhas seguidas, desligamos o
          webhook e avisamos aqui.
        </p>
      </form>

      {data && data.webhooks.length === 0 ? (
        <EstadoVazio
          titulo="Nenhum webhook cadastrado"
          descricao="Cadastre um endereço para receber as respostas no seu sistema assim que elas chegarem."
        />
      ) : (
        <ul className="space-y-2">
          {data?.webhooks.map((webhook) => (
            <li
              key={webhook.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-slate-900">{webhook.url}</p>
                <p className="text-sm text-slate-500">
                  {webhook.events.join(', ')}
                  {webhook.isActive
                    ? webhook.lastStatus
                      ? ` · última resposta ${webhook.lastStatus}`
                      : ' · nenhuma entrega ainda'
                    : ' · desligado após falhas seguidas'}
                </p>
              </div>

              <button
                type="button"
                className="text-sm text-slate-500 hover:text-red-700"
                onClick={() => remover.mutate(webhook.id)}
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </Secao>
  );
}

// -----------------------------------------------------------------------------

function SecaoChaves() {
  const cliente = useQueryClient();
  const [nome, setNome] = useState('');
  const [escopos, setEscopos] = useState<string[]>(['forms:read', 'responses:read']);
  const [segredo, setSegredo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['chaves-api'],
    queryFn: () => api<ChavesResposta>('/v1/api-keys'),
  });

  const criar = useMutation({
    mutationFn: () => api<{ secret: string }>('/v1/api-keys', { method: 'POST', body: { name: nome, scopes: escopos } }),
    onSuccess: (criada) => {
      setNome('');
      setErro(null);
      setSegredo(criada.secret);
      void cliente.invalidateQueries({ queryKey: ['chaves-api'] });
    },
    onError: (problema) => setErro(mensagemDe(problema, 'Não conseguimos criar esta chave.')),
  });

  const revogar = useMutation({
    mutationFn: (id: string) => api(`/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['chaves-api'] }),
  });

  if (isLoading) return <Spinner />;

  return (
    <Secao
      titulo="Chaves de API"
      descricao="Para o seu sistema ler formulários e respostas direto. Cada chave vale só para o que você marcar aqui."
    >
      {erro && (
        <div className="mb-4">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {segredo && (
        <div className="mb-4">
          <SegredoRevelado titulo="Sua nova chave de API" valor={segredo} aoFechar={() => setSegredo(null)} />
        </div>
      )}

      <form
        className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (nome.trim() && escopos.length > 0) criar.mutate();
        }}
      >
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Nome da chave — ex.: integração com o CRM"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
        />

        <div className="flex flex-wrap gap-3">
          {(data?.scopes ?? []).map((escopo) => (
            <label key={escopo} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={escopos.includes(escopo)}
                onChange={(mudanca) =>
                  setEscopos((atuais) =>
                    mudanca.target.checked ? [...atuais, escopo] : atuais.filter((item) => item !== escopo),
                  )
                }
              />
              <code className="font-mono text-xs">{escopo}</code>
            </label>
          ))}
        </div>

        <button type="submit" className="botao-primario" disabled={criar.isPending}>
          {criar.isPending ? 'Criando…' : 'Criar chave'}
        </button>
      </form>

      {data && data.apiKeys.length === 0 ? (
        <EstadoVazio
          titulo="Nenhuma chave criada"
          descricao="Crie uma chave para consumir a API a partir do seu sistema."
        />
      ) : (
        <ul className="space-y-2">
          {data?.apiKeys.map((chave) => (
            <li
              key={chave.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <div>
                <p className="font-medium text-slate-900">
                  {chave.name}
                  {chave.revokedAt && <span className="ml-2 text-sm font-normal text-slate-500">(revogada)</span>}
                </p>
                <p className="font-mono text-xs text-slate-500">{chave.prefix}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {chave.scopes.join(', ')} ·{' '}
                  {/* Chave sem uso há meses é candidata a revogação, e essa é a
                      informação que dá confiança para apagá-la. */}
                  {chave.lastUsedAt ? `usada em ${formatarData(chave.lastUsedAt)}` : 'nunca usada'}
                </p>
              </div>

              {!chave.revokedAt && (
                <button
                  type="button"
                  className="text-sm text-slate-500 hover:text-red-700"
                  onClick={() => revogar.mutate(chave.id)}
                >
                  Revogar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Secao>
  );
}

// -----------------------------------------------------------------------------

export function PaginaIntegracoes() {
  const { can } = usePermission();

  if (!can('webhook:manage')) {
    return (
      <LayoutPainel>
        <TituloDaPagina titulo="Integrações" />
        <EstadoVazio
          titulo="Você não administra as integrações desta empresa"
          descricao="Peça a um administrador para cadastrar domínios, webhooks ou chaves de API."
        />
      </LayoutPainel>
    );
  }

  return (
    <LayoutPainel>
      <TituloDaPagina
        titulo="Integrações"
        descricao="Domínio próprio, webhooks e chaves de API — tudo que liga os formulários ao resto do seu sistema."
      />

      <SecaoDominios />
      <SecaoWebhooks />
      <SecaoChaves />
    </LayoutPainel>
  );
}
