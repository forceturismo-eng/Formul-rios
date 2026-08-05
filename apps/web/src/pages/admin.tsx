import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBRL } from '@forms/shared';
import { ApiError, setAccessToken } from '../lib/api.js';
import type { ApiErrorBody } from '@forms/shared';
import { MensagemDeErro, Spinner } from '../components/ui.js';
import { useNavigate } from '../lib/router.js';

/**
 * Área do admin da plataforma (seção 5.5).
 *
 * Deliberadamente fora do `LayoutPainel`: nada aqui compartilha casca com o
 * produto do cliente. Quem estiver olhando precisa saber, o tempo todo, em qual
 * dos dois lados está.
 *
 * O token do admin vive em memória, como o do cliente. Sessão de 30 minutos e
 * sem renovação: a conveniência de ficar logado não paga o risco de uma sessão
 * de admin esquecida aberta.
 */

let tokenDoAdmin: string | null = null;

async function adminApi<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const resposta = await fetch(`${import.meta.env['VITE_API_URL'] ?? ''}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(tokenDoAdmin ? { authorization: `Bearer ${tokenDoAdmin}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = (corpo as Partial<ApiErrorBody>).error;
    throw new ApiError(resposta.status, erro ?? { code: 'internal_error', message: 'Algo deu errado.' });
  }

  return corpo as T;
}

interface Metricas {
  organizations: { total: number; active: number; trialing: number; suspended: number; canceled: number };
  mrrCents: number;
  churnRate: number;
  overdue: { count: number; amountCents: number };
  responsesLast30Days: number;
}

interface Empresa {
  id: string;
  name: string;
  slug: string;
  planName: string;
  subscriptionStatus: string;
  membersCount: number;
  formsCount: number;
  responsesCount: number;
  overdueCount: number;
}

export function PaginaAdmin() {
  const [autenticado, setAutenticado] = useState(tokenDoAdmin !== null);

  if (!autenticado) return <LoginDoAdmin aoEntrar={() => setAutenticado(true)} />;

  return <PainelDoAdmin aoSair={() => setAutenticado(false)} />;
}

// -----------------------------------------------------------------------------

function LoginDoAdmin({ aoEntrar }: { aoEntrar: () => void }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [configuracao, setConfiguracao] = useState<{ uri: string; secret: string; token: string } | null>(null);

  const entrar = useMutation({
    mutationFn: () =>
      adminApi<{ status: string; token?: string; setupToken?: string; totp?: { uri: string; secret: string } }>(
        '/admin/auth/login',
        { method: 'POST', body: { email, password: senha, ...(codigo ? { totpCode: codigo } : {}) } },
      ),
    onSuccess: (resultado) => {
      setErro(null);

      if (resultado.status === 'mfa_setup' && resultado.totp && resultado.setupToken) {
        setConfiguracao({ ...resultado.totp, token: resultado.setupToken });
        return;
      }

      tokenDoAdmin = resultado.token ?? null;
      aoEntrar();
    },
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos entrar agora.'),
  });

  const confirmar = useMutation({
    mutationFn: () => {
      tokenDoAdmin = configuracao!.token;
      return adminApi('/admin/auth/mfa/confirm', { method: 'POST', body: { code: codigo } });
    },
    onSuccess: () => {
      tokenDoAdmin = null;
      setConfiguracao(null);
      setCodigo('');
      setErro('Segundo fator ativado. Entre novamente, agora com o código.');
    },
    onError: (problema: unknown) => {
      tokenDoAdmin = null;
      setErro(problema instanceof ApiError ? problema.message : 'Código inválido.');
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8">
        <h1 className="text-xl font-semibold text-slate-900">Administração da plataforma</h1>
        <p className="mt-1 text-sm text-slate-500">
          Esta área é separada do produto. O segundo fator é obrigatório.
        </p>

        {erro && (
          <div className="mt-4">
            <MensagemDeErro>{erro}</MensagemDeErro>
          </div>
        )}

        {configuracao ? (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-slate-700">
              Cadastre este segredo no seu aplicativo autenticador e confirme com o primeiro código.
            </p>

            <code className="block overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm">
              {configuracao.secret}
            </code>

            <p className="break-all text-xs text-slate-500">{configuracao.uri}</p>

            <input
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-widest"
              placeholder="000000"
              inputMode="numeric"
              maxLength={6}
              value={codigo}
              onChange={(evento) => setCodigo(evento.target.value)}
            />

            <button
              type="button"
              className="botao-primario w-full"
              disabled={confirmar.isPending}
              onClick={() => confirmar.mutate()}
            >
              Confirmar segundo fator
            </button>
          </div>
        ) : (
          <form
            className="mt-6 space-y-4"
            onSubmit={(evento) => {
              evento.preventDefault();
              entrar.mutate();
            }}
          >
            <input
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
              type="email"
              placeholder="E-mail"
              autoComplete="username"
              value={email}
              onChange={(evento) => setEmail(evento.target.value)}
            />
            <input
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
              type="password"
              placeholder="Senha"
              autoComplete="current-password"
              value={senha}
              onChange={(evento) => setSenha(evento.target.value)}
            />
            <input
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono tracking-widest"
              placeholder="Código do autenticador"
              inputMode="numeric"
              maxLength={6}
              value={codigo}
              onChange={(evento) => setCodigo(evento.target.value)}
            />

            <button type="submit" className="botao-primario w-full" disabled={entrar.isPending}>
              {entrar.isPending ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function PainelDoAdmin({ aoSair }: { aoSair: () => void }) {
  const cliente = useQueryClient();
  const navigate = useNavigate();
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const { data: metricas } = useQuery({
    queryKey: ['admin-metricas'],
    queryFn: () => adminApi<Metricas>('/admin/metrics'),
  });

  const { data: empresas, isLoading } = useQuery({
    queryKey: ['admin-empresas', busca],
    queryFn: () =>
      adminApi<{ organizations: Empresa[] }>(
        `/admin/organizations?search=${encodeURIComponent(busca)}&limit=100`,
      ),
  });

  const impersonar = useMutation({
    mutationFn: (params: { id: string; reason: string }) =>
      adminApi<{ token: string }>(`/admin/organizations/${params.id}/impersonate`, {
        method: 'POST',
        body: { reason: params.reason },
      }),
    onSuccess: (resultado) => {
      // Entra na conta do cliente usando o token de impersonação. O banner
      // permanente aparece porque o servidor informa a impersonação em
      // `/v1/organizations/current` — não porque a tela lembrou de desenhá-lo.
      setAccessToken(resultado.token);
      cliente.clear();
      navigate('/formularios');
    },
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos entrar na conta.'),
  });

  const alterarEstado = useMutation({
    mutationFn: (params: { id: string; status: string; reason: string }) =>
      adminApi(`/admin/organizations/${params.id}/status`, {
        method: 'PATCH',
        body: { status: params.status, reason: params.reason },
      }),
    onSuccess: () => {
      setErro(null);
      void cliente.invalidateQueries({ queryKey: ['admin-empresas'] });
      void cliente.invalidateQueries({ queryKey: ['admin-metricas'] });
    },
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos alterar o estado.'),
  });

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-slate-900 px-4 py-3 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <span className="font-semibold">Administração da plataforma</span>
          <button
            type="button"
            className="text-sm text-slate-300 hover:text-white"
            onClick={() => {
              tokenDoAdmin = null;
              aoSair();
            }}
          >
            Sair
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {erro && (
          <div className="mb-6">
            <MensagemDeErro>{erro}</MensagemDeErro>
          </div>
        )}

        {metricas && (
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Indicador rotulo="MRR" valor={formatBRL(metricas.mrrCents)} />
            <Indicador rotulo="Empresas ativas" valor={String(metricas.organizations.active)} />
            <Indicador
              rotulo="Churn (30 dias)"
              valor={`${(metricas.churnRate * 100).toFixed(1)}%`}
              alerta={metricas.churnRate > 0.05}
            />
            <Indicador
              rotulo="Faturas vencidas"
              valor={`${metricas.overdue.count} · ${formatBRL(metricas.overdue.amountCents)}`}
              alerta={metricas.overdue.count > 0}
            />
          </div>
        )}

        <input
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Buscar empresa por nome ou slug"
          value={busca}
          onChange={(evento) => setBusca(evento.target.value)}
        />

        {isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Empresa</th>
                  <th className="px-4 py-3">Plano</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Uso</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {(empresas?.organizations ?? []).map((empresa) => (
                  <tr key={empresa.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{empresa.name}</p>
                      <p className="text-xs text-slate-500">{empresa.slug}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{empresa.planName}</td>
                    <td className="px-4 py-3">
                      <span className={empresa.overdueCount > 0 ? 'text-red-700' : 'text-slate-700'}>
                        {empresa.subscriptionStatus}
                        {empresa.overdueCount > 0 && ` · ${empresa.overdueCount} vencida(s)`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {empresa.membersCount} membro(s) · {empresa.formsCount} form. ·{' '}
                      {empresa.responsesCount} resp.
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          className="text-sm font-medium text-slate-600 hover:text-slate-900"
                          onClick={() => {
                            // Motivo obrigatório, e ele fica registrado dos dois
                            // lados — inclusive no painel do cliente.
                            const motivo = window.prompt(
                              'Por que você precisa entrar nesta conta? O cliente vê este registro.',
                            );
                            if (motivo && motivo.trim().length >= 5) {
                              impersonar.mutate({ id: empresa.id, reason: motivo });
                            }
                          }}
                        >
                          Entrar na conta
                        </button>

                        <button
                          type="button"
                          className="text-sm font-medium text-slate-600 hover:text-red-700"
                          onClick={() => {
                            const suspender = empresa.subscriptionStatus !== 'suspended';
                            const motivo = window.prompt(
                              `${suspender ? 'Suspender' : 'Reativar'} ${empresa.name}. Por quê?`,
                            );
                            if (motivo && motivo.trim().length >= 5) {
                              alterarEstado.mutate({
                                id: empresa.id,
                                status: suspender ? 'suspended' : 'active',
                                reason: motivo,
                              });
                            }
                          }}
                        >
                          {empresa.subscriptionStatus === 'suspended' ? 'Reativar' : 'Suspender'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function Indicador({ rotulo, valor, alerta }: { rotulo: string; valor: string; alerta?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{rotulo}</p>
      <p className={`mt-1 text-2xl font-semibold ${alerta ? 'text-red-700' : 'text-slate-900'}`}>{valor}</p>
    </div>
  );
}
