import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { collectWarnings, respostasEm80, respostasNoLimite, type UsageWarning } from '@forms/shared';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Link, useRouter } from '../lib/router.js';
import { Banner } from './ui.js';

/**
 * Casca do painel autenticado.
 *
 * Ela carrega o uso do ciclo e desenha os banners de cota — que é onde a
 * promessa da seção 11 encosta na tela: o cliente precisa saber que está em 80%
 * ANTES de estourar, e precisa ver o relógio da cortesia enquanto ele corre.
 */

interface UsoResposta {
  planCode: string;
  usage: { responsesCount: number; periodEnd: string };
  warnings: UsageWarning[];
  buffer: { active: boolean; endsAt: string | null };
}

const MENU = [
  { rotulo: 'Formulários', destino: '/formularios' },
  { rotulo: 'Equipe', destino: '/equipe' },
  { rotulo: 'Integrações', destino: '/integracoes' },
  { rotulo: 'Cobrança', destino: '/cobranca' },
];

export function LayoutPainel({ children }: { children: ReactNode }) {
  const { user, organization, memberships, sair, trocarEmpresa } = useSession();
  const { path } = useRouter();

  const { data: uso } = useQuery({
    queryKey: ['uso', organization?.id],
    queryFn: () => api<UsoResposta>('/v1/usage'),
    enabled: Boolean(organization),
    // O uso muda a cada resposta recebida; um minuto é frequente o bastante
    // para o banner aparecer e barato o bastante para não pesar.
    staleTime: 60_000,
  });

  const avisos = uso
    ? collectWarnings({
        planCode: uso.planCode,
        usage: {
          ...uso.usage,
          periodStart: new Date(),
          periodEnd: new Date(uso.usage.periodEnd),
          aiAnalysesCount: 0,
          storageUsedMb: 0,
          formsCount: 0,
          membersCount: 0,
          customDomainsCount: 0,
          apiKeysCount: 0,
          bufferStartedAt: null,
          bufferEndsAt: uso.buffer.endsAt ? new Date(uso.buffer.endsAt) : null,
        },
      })
    : [];

  const avisoDeRespostas = (uso?.warnings ?? avisos).find((aviso) => aviso.key === 'responsesPerMonth');

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/formularios" className="font-semibold text-slate-900">
              Formulários
            </Link>

            <nav className="hidden gap-1 sm:flex">
              {MENU.map((item) => (
                <Link
                  key={item.destino}
                  to={item.destino}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    path.startsWith(item.destino)
                      ? 'bg-slate-100 text-slate-900'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.rotulo}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Troca de workspace: o mesmo usuário pode estar em várias empresas. */}
            {memberships.length > 1 && (
              <select
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                value={organization?.id ?? ''}
                onChange={(evento) => void trocarEmpresa(evento.target.value)}
              >
                {memberships.map((vinculo) => (
                  <option key={vinculo.organizationId} value={vinculo.organizationId}>
                    {vinculo.organizationName}
                  </option>
                ))}
              </select>
            )}

            <span className="hidden text-sm text-slate-500 sm:inline">{user?.name}</span>
            <button type="button" onClick={() => void sair()} className="text-sm text-slate-500 hover:text-slate-900">
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* E-mail não confirmado trava ações que criam dado. Avisar antes evita
            o usuário descobrir isso ao clicar em "salvar". */}
        {user && !user.emailVerified && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Confirme seu e-mail para criar formulários e convidar pessoas. Enviamos o link para {user.email}.
          </div>
        )}

        {uso?.buffer.active && uso.buffer.endsAt && avisoDeRespostas && (
          <div className="mb-6">
            <Banner
              bloco={respostasNoLimite({ limit: avisoDeRespostas.limit, bufferEndsAt: new Date(uso.buffer.endsAt) })}
            />
          </div>
        )}

        {!uso?.buffer.active && avisoDeRespostas && (
          <div className="mb-6">
            <Banner
              bloco={respostasEm80({ ...avisoDeRespostas, renewsAt: new Date(avisoDeRespostas.renewsAt) })}
            />
          </div>
        )}

        {children}
      </main>
    </div>
  );
}

export function TituloDaPagina({ titulo, descricao, acao }: { titulo: string; descricao?: string; acao?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{titulo}</h1>
        {descricao && <p className="mt-1 text-sm text-slate-500">{descricao}</p>}
      </div>
      {acao}
    </div>
  );
}
