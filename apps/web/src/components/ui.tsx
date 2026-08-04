import type { ReactNode } from 'react';
import type { CopyBlock } from '@forms/shared';
import { Link } from '../lib/router.js';

/**
 * Peças de interface compartilhadas.
 *
 * O componente que mais importa aqui é o `Banner`: ele desenha os `CopyBlock`
 * que vêm do pacote compartilhado, com a copy e as ações já decididas lá. A
 * tela não reescreve texto de limite nem inventa botão — as diretrizes de
 * microcopy da seção 11 valem porque existe um lugar só onde essa copy nasce.
 */

const TONS = {
  info: 'border-slate-200 bg-slate-50 text-slate-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-900',
} as const;

export function Banner({ bloco }: { bloco: CopyBlock }) {
  return (
    <div className={`rounded-xl border p-4 ${TONS[bloco.tone]}`}>
      <p className="font-medium">{bloco.title}</p>
      <p className="mt-1 whitespace-pre-line text-sm opacity-90">{bloco.body}</p>

      {bloco.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {bloco.actions.map((acao) => (
            <Link
              key={acao.label}
              to={acao.href.startsWith('#') ? '#' : acao.href}
              className={
                acao.kind === 'primary'
                  ? 'rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800'
                  : 'rounded-lg border border-current px-3 py-1.5 text-sm font-medium hover:bg-white/50'
              }
            >
              {acao.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

export function EstadoVazio({ titulo, descricao, acao }: { titulo: string; descricao: string; acao?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <p className="font-medium text-slate-900">{titulo}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{descricao}</p>
      {acao && <div className="mt-5">{acao}</div>}
    </div>
  );
}

export function MensagemDeErro({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {children}
    </div>
  );
}

const CORES_ESTADO: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  published: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-slate-100 text-slate-500',
  new: 'bg-blue-100 text-blue-800',
  reviewed: 'bg-emerald-100 text-emerald-800',
  paid: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-800',
  canceled: 'bg-slate-100 text-slate-500',
  refunded: 'bg-slate-100 text-slate-600',
  active: 'bg-emerald-100 text-emerald-800',
  trialing: 'bg-blue-100 text-blue-800',
  pending_payment: 'bg-amber-100 text-amber-800',
  suspended: 'bg-red-100 text-red-800',
};

const ROTULOS_ESTADO: Record<string, string> = {
  draft: 'Rascunho',
  published: 'Publicado',
  archived: 'Arquivado',
  new: 'Nova',
  reviewed: 'Revisada',
  paid: 'Paga',
  pending: 'Em aberto',
  overdue: 'Vencida',
  canceled: 'Cancelada',
  refunded: 'Estornada',
  active: 'Ativa',
  trialing: 'Em teste',
  pending_payment: 'Aguardando pagamento',
  suspended: 'Suspensa',
};

export function Selo({ estado }: { estado: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
        CORES_ESTADO[estado] ?? 'bg-slate-100 text-slate-700'
      }`}
    >
      {ROTULOS_ESTADO[estado] ?? estado}
    </span>
  );
}

export function BarraDeProgresso({ valor, maximo }: { valor: number; maximo: number }) {
  const porcentagem = maximo <= 0 ? 0 : Math.min(100, Math.round((valor / maximo) * 100));
  // Amarelo a partir de 80%, vermelho no limite — os mesmos degraus do
  // enforcement, para a tela não contar uma história diferente do backend.
  const cor = porcentagem >= 100 ? 'bg-red-500' : porcentagem >= 80 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div className={`h-full rounded-full ${cor}`} style={{ width: `${porcentagem}%` }} />
    </div>
  );
}
