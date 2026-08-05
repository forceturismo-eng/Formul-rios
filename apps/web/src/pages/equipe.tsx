import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeActivity, tempoRelativo, type Role } from '@forms/shared';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { EstadoVazio, MensagemDeErro, Spinner } from '../components/ui.js';
import { usePermission, useSession } from '../lib/session.js';

/**
 * Equipe: quem tem acesso, quem foi convidado, e o que andou acontecendo.
 *
 * As três coisas na mesma tela de propósito. Quem administra a equipe abre isto
 * para responder uma pergunta só — "quem mexeu no quê" — e separar membros de
 * atividades em duas telas obrigaria a cruzar as duas de cabeça.
 *
 * O que a tela esconde é cortesia; quem recusa de verdade é a API. Um `viewer`
 * que force a chamada recebe 403 do mesmo jeito.
 */

interface Membro {
  id: string;
  role: Role;
  acceptedAt: string | null;
  user: { id: string; name: string; email: string };
  isSelf: boolean;
}

interface Convite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  expired: boolean;
}

interface Atividade {
  id: string;
  texto: string;
  categoria: string;
  daPlataforma: boolean;
  autor: string | null;
  createdAt: string;
}

const PAPEIS: Array<{ valor: Role; rotulo: string; descricao: string }> = [
  { valor: 'owner', rotulo: 'Dono', descricao: 'Tudo, inclusive cobrança e encerrar a conta.' },
  { valor: 'admin', rotulo: 'Administrador', descricao: 'Tudo, menos cobrança.' },
  { valor: 'editor', rotulo: 'Editor', descricao: 'Cria e edita formulários, vê respostas.' },
  { valor: 'viewer', rotulo: 'Leitor', descricao: 'Só leitura, e comentários.' },
];

const ROTULO_DO_PAPEL: Record<string, string> = Object.fromEntries(
  PAPEIS.map((papel) => [papel.valor, papel.rotulo]),
);

export function PaginaEquipe() {
  const { can, role } = usePermission();
  const { user } = useSession();
  const cliente = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);

  const { data: membros, isLoading } = useQuery({
    queryKey: ['membros'],
    queryFn: () => api<{ members: Membro[] }>('/v1/members'),
  });

  const { data: convites } = useQuery({
    queryKey: ['convites'],
    queryFn: () => api<{ invitations: Convite[] }>('/v1/invitations'),
    enabled: can('member:invite'),
  });

  function aoFalhar(padrao: string) {
    return (problema: unknown) => setErro(problema instanceof ApiError ? problema.message : padrao);
  }

  function aoMudarEquipe() {
    setErro(null);
    void cliente.invalidateQueries({ queryKey: ['membros'] });
    void cliente.invalidateQueries({ queryKey: ['convites'] });
    void cliente.invalidateQueries({ queryKey: ['atividades'] });
  }

  const trocarPapel = useMutation({
    mutationFn: (params: { id: string; role: Role }) =>
      api(`/v1/members/${params.id}`, { method: 'PATCH', body: { role: params.role } }),
    onSuccess: aoMudarEquipe,
    onError: aoFalhar('Não conseguimos alterar o papel.'),
  });

  const remover = useMutation({
    mutationFn: (id: string) => api(`/v1/members/${id}`, { method: 'DELETE' }),
    onSuccess: aoMudarEquipe,
    onError: aoFalhar('Não conseguimos remover essa pessoa.'),
  });

  const revogar = useMutation({
    mutationFn: (id: string) => api(`/v1/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: aoMudarEquipe,
    onError: aoFalhar('Não conseguimos cancelar o convite.'),
  });

  return (
    <LayoutPainel>
      <TituloDaPagina titulo="Equipe" descricao="Quem tem acesso aos formulários desta empresa." />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {can('member:invite') && <FormularioDeConvite aoConvidar={aoMudarEquipe} aoFalhar={aoFalhar} papelAtual={role} />}

      {isLoading ? (
        <Spinner label="Carregando equipe" />
      ) : (
        <section className="mb-10 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Pessoa</th>
                <th className="px-4 py-3 font-medium">Papel</th>
                <th className="px-4 py-3 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(membros?.members ?? []).map((membro) => (
                <tr key={membro.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {membro.user.name}
                      {membro.isSelf && <span className="ml-2 text-xs font-normal text-slate-500">(você)</span>}
                    </p>
                    <p className="text-slate-500">{membro.user.email}</p>
                  </td>

                  <td className="px-4 py-3">
                    {can('member:update_role') && !membro.isSelf ? (
                      <select
                        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                        value={membro.role}
                        disabled={trocarPapel.isPending}
                        onChange={(evento) =>
                          trocarPapel.mutate({ id: membro.id, role: evento.target.value as Role })
                        }
                      >
                        {PAPEIS.map((papel) => (
                          <option key={papel.valor} value={papel.valor}>
                            {papel.rotulo}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-slate-700">{ROTULO_DO_PAPEL[membro.role] ?? membro.role}</span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {(can('member:remove') || membro.isSelf) && (
                      <button
                        type="button"
                        className="text-sm font-medium text-slate-500 hover:text-red-700"
                        onClick={() => {
                          const pergunta = membro.isSelf
                            ? 'Sair desta empresa? Você perde o acesso aos formulários dela.'
                            : `Remover ${membro.user.name}? Os formulários criados por essa pessoa continuam aqui.`;
                          if (window.confirm(pergunta)) remover.mutate(membro.id);
                        }}
                      >
                        {membro.isSelf ? 'Sair da empresa' : 'Remover'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {can('member:invite') && (convites?.invitations.length ?? 0) > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 font-semibold text-slate-900">Convites em aberto</h2>

          <ul className="space-y-2">
            {(convites?.invitations ?? []).map((convite) => (
              <li
                key={convite.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div>
                  <p className="font-medium text-slate-900">{convite.email}</p>
                  <p className="text-sm text-slate-500">
                    {ROTULO_DO_PAPEL[convite.role] ?? convite.role} ·{' '}
                    {convite.expired ? (
                      // Convite vencido continua listado: quem administra
                      // precisa ver que a pessoa não entrou.
                      <span className="text-amber-700">expirou — cancele e convide de novo</span>
                    ) : (
                      `vence ${tempoRelativo(new Date(convite.expiresAt), new Date(Date.now() - 0))}`
                    )}
                  </p>
                </div>

                <button
                  type="button"
                  className="text-sm font-medium text-slate-500 hover:text-red-700"
                  onClick={() => revogar.mutate(convite.id)}
                >
                  Cancelar convite
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FeedDeAtividades meuNome={user?.name ?? null} />
    </LayoutPainel>
  );
}

// -----------------------------------------------------------------------------

function FormularioDeConvite({
  aoConvidar,
  aoFalhar,
  papelAtual,
}: {
  aoConvidar: () => void;
  aoFalhar: (padrao: string) => (problema: unknown) => void;
  papelAtual: Role | null;
}) {
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<Role>('editor');
  const [enviado, setEnviado] = useState<string | null>(null);

  const convidar = useMutation({
    mutationFn: () => api('/v1/invitations', { method: 'POST', body: { email, role: papel } }),
    onSuccess: () => {
      setEnviado(email);
      setEmail('');
      aoConvidar();
    },
    onError: aoFalhar('Não conseguimos enviar o convite.'),
  });

  // Ninguém convida para um papel acima do seu — a API recusa, e a tela nem
  // oferece.
  const ordem: Role[] = ['owner', 'admin', 'editor', 'viewer'];
  const disponiveis = PAPEIS.filter(
    (opcao) => papelAtual === null || ordem.indexOf(opcao.valor) >= ordem.indexOf(papelAtual),
  );

  return (
    <section className="mb-8 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-slate-900">Convidar alguém</h2>
      <p className="mt-1 text-sm text-slate-500">
        A pessoa recebe um link por e-mail. O convite vale por 7 dias e serve uma vez só.
      </p>

      {enviado && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Convite enviado para {enviado}.
        </p>
      )}

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(evento) => {
          evento.preventDefault();
          if (email.trim()) convidar.mutate();
        }}
      >
        <input
          className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          type="email"
          placeholder="email@daempresa.com.br"
          value={email}
          onChange={(evento) => setEmail(evento.target.value)}
        />

        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={papel}
          onChange={(evento) => setPapel(evento.target.value as Role)}
        >
          {disponiveis.map((opcao) => (
            <option key={opcao.valor} value={opcao.valor}>
              {opcao.rotulo}
            </option>
          ))}
        </select>

        <button type="submit" className="botao-primario" disabled={convidar.isPending}>
          {convidar.isPending ? 'Enviando…' : 'Convidar'}
        </button>
      </form>

      <p className="mt-3 text-xs text-slate-500">
        {PAPEIS.find((opcao) => opcao.valor === papel)?.descricao}
      </p>
    </section>
  );
}

// -----------------------------------------------------------------------------

const CORES_DA_CATEGORIA: Record<string, string> = {
  formulario: 'bg-blue-100 text-blue-800',
  recebimento: 'bg-emerald-100 text-emerald-800',
  equipe: 'bg-violet-100 text-violet-800',
  conta: 'bg-slate-100 text-slate-700',
  integracao: 'bg-amber-100 text-amber-900',
  plataforma: 'bg-red-100 text-red-800',
};

function FeedDeAtividades({ meuNome }: { meuNome: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['atividades'],
    queryFn: () => api<{ activity: Atividade[] }>('/v1/activity'),
  });

  return (
    <section>
      <h2 className="mb-1 font-semibold text-slate-900">Atividades</h2>
      <p className="mb-4 text-sm text-slate-500">
        O que a equipe fez por aqui. Login e renovação de sessão ficam de fora — eles acontecem o tempo todo e
        afogariam o resto.
      </p>

      {isLoading && <Spinner label="Carregando atividades" />}

      {data && data.activity.length === 0 && (
        <EstadoVazio titulo="Nada por aqui ainda" descricao="As ações da equipe aparecem nesta lista." />
      )}

      {data && data.activity.length > 0 && (
        <ol className="space-y-1">
          {data.activity.map((entrada) => (
            <li
              key={entrada.id}
              className={`flex flex-wrap items-baseline gap-2 rounded-lg px-3 py-2 text-sm ${
                entrada.daPlataforma ? 'bg-red-50' : 'odd:bg-slate-50'
              }`}
            >
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  CORES_DA_CATEGORIA[entrada.categoria] ?? 'bg-slate-100 text-slate-700'
                }`}
              >
                {entrada.categoria}
              </span>

              <span className="text-slate-800">
                <strong className="font-medium">
                  {entrada.autor === null
                    ? entrada.daPlataforma
                      ? 'Plataforma'
                      : 'Sistema'
                    : entrada.autor === meuNome
                      ? 'Você'
                      : entrada.autor}
                </strong>{' '}
                {entrada.texto}
              </span>

              <span className="ml-auto text-xs text-slate-500">
                {tempoRelativo(new Date(entrada.createdAt))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Reexportado para os testes exercitarem a tradução sem subir a tela. */
export { describeActivity };
