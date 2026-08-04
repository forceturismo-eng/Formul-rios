import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Roteador mínimo.
 *
 * Este app é uma SPA com pouco mais de uma dúzia de rotas, sem SSR, sem
 * loaders e sem streaming. O React Router traria tudo isso — e, com isso, uma
 * superfície de CVE que hoje não tem versão limpa: as recentes são de RSC e SSR
 * hydration, recursos que não usamos e que ainda assim quebrariam o
 * `npm audit --audit-level=high` do CI.
 *
 * Sessenta linhas de History API resolvem o que precisamos. Se um dia
 * precisarmos de loaders ou SSR, a troca é localizada neste arquivo.
 */

interface RouterState {
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const aoVoltar = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', aoVoltar);
    return () => window.removeEventListener('popstate', aoVoltar);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    // Só caminhos internos. Um `to` externo aqui viraria open redirect, que é
    // exatamente a classe de bug das CVEs que nos fizeram sair do React Router.
    const destino = sanitizePath(to);

    if (options?.replace) window.history.replaceState({}, '', destino);
    else window.history.pushState({}, '', destino);

    setPath(destino.split('?')[0] ?? destino);
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo(() => ({ path, navigate }), [path, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/**
 * Aceita apenas caminho relativo à própria origem.
 *
 * Recusa `//evil.com` (URL relativa a protocolo), `\\evil.com` (que alguns
 * navegadores normalizam para barra) e qualquer coisa com esquema.
 */
export function sanitizePath(to: string): string {
  const limpo = to.trim().replace(/\\/g, '/');
  if (!limpo.startsWith('/')) return '/';
  if (limpo.startsWith('//')) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(limpo)) return '/';
  return limpo;
}

export function useRouter(): RouterState {
  const contexto = useContext(RouterContext);
  if (!contexto) throw new Error('useRouter precisa estar dentro de RouterProvider.');
  return contexto;
}

export function useNavigate(): RouterState['navigate'] {
  return useRouter().navigate;
}

/**
 * Casa o caminho atual contra um padrão com parâmetros: `/formularios/:id`.
 * Devolve os parâmetros ou `null` quando não casa.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const partesPadrao = pattern.split('/').filter(Boolean);
  const partesCaminho = path.split('/').filter(Boolean);

  if (partesPadrao.length !== partesCaminho.length) return null;

  const parametros: Record<string, string> = {};

  for (const [i, parte] of partesPadrao.entries()) {
    const atual = partesCaminho[i] as string;
    if (parte.startsWith(':')) {
      parametros[parte.slice(1)] = decodeURIComponent(atual);
    } else if (parte !== atual) {
      return null;
    }
  }

  return parametros;
}

export function Link({
  to,
  children,
  className,
  ...rest
}: { to: string; children: ReactNode; className?: string } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
>) {
  const navigate = useNavigate();

  return (
    <a
      href={sanitizePath(to)}
      className={className}
      onClick={(evento) => {
        // Deixa o navegador cuidar de ctrl+clique, clique do meio e afins.
        if (evento.metaKey || evento.ctrlKey || evento.shiftKey || evento.button !== 0) return;
        evento.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
