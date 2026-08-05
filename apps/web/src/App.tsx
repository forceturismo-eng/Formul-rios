import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './lib/api.js';
import { RouterProvider, matchPath, useNavigate, useRouter } from './lib/router.js';
import { useSession } from './lib/session.js';
import { Spinner } from './components/ui.js';
import { PaginaLogin, PaginaRegistro, PaginaVerificarEmail } from './pages/auth.js';
import { PaginaPrecos } from './pages/precos.js';
import { PaginaFormularios } from './pages/formularios.js';
import { PaginaBuilder } from './pages/builder.js';
import { PaginaRespostas } from './pages/respostas.js';
import { PaginaCobranca } from './pages/cobranca.js';
import { PaginaEquipe } from './pages/equipe.js';
import { PaginaIntegracoes } from './pages/integracoes.js';
import { PaginaMarca } from './pages/marca.js';
import { PaginaAnalises } from './pages/analises.js';
import { PaginaAdmin } from './pages/admin.js';
import { PaginaFormularioPublico } from './pages/formulario-publico.js';

const cliente = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (tentativas, erro) => {
        // Não insistir em erro do cliente: 404 e 402 não melhoram com
        // retentativa, e 401 já é tratado pelo refresh dentro de `api()`.
        if (erro instanceof ApiError && erro.status < 500) return false;
        return tentativas < 2;
      },
    },
  },
});

/** Rotas que existem sem sessão — inclusive nos domínios dos clientes. */
const ROTAS_PUBLICAS = ['/', '/precos', '/entrar', '/criar-conta', '/verificar-email', '/contato'];

function Rotas() {
  const { path } = useRouter();
  const navigate = useNavigate();
  const { user, loading, restaurar } = useSession();

  useEffect(() => {
    void restaurar();
  }, [restaurar]);

  // O renderizador público vem antes de qualquer verificação de sessão: ele é
  // servido também nos domínios dos clientes, onde sessão não existe.
  const formularioPublico = matchPath('/f/:slug', path);
  if (formularioPublico) return <PaginaFormularioPublico slug={formularioPublico['slug'] as string} />;

  // A área do admin não passa pela sessão de cliente: ela tem autenticação
  // própria, e um cliente logado não deve ser levado para dentro dela por
  // acidente.
  if (path === '/admin' || path.startsWith('/admin/')) return <PaginaAdmin />;

  if (loading) return <Spinner label="Carregando" />;

  const publica = ROTAS_PUBLICAS.includes(path);

  if (!user && !publica) {
    return <PaginaLogin />;
  }

  if (user && (path === '/entrar' || path === '/criar-conta')) {
    // Já autenticado não fica preso na tela de login.
    setTimeout(() => navigate('/formularios', { replace: true }), 0);
    return <Spinner label="Redirecionando" />;
  }

  if (path === '/' || path === '/precos') return <PaginaPrecos />;
  if (path === '/entrar') return <PaginaLogin />;
  if (path === '/criar-conta') return <PaginaRegistro />;
  if (path === '/verificar-email') return <PaginaVerificarEmail />;
  if (path === '/formularios') return <PaginaFormularios />;
  if (path === '/equipe') return <PaginaEquipe />;
  if (path === '/integracoes') return <PaginaIntegracoes />;
  if (path === '/marca') return <PaginaMarca />;
  if (path === '/cobranca' || path === '/planos') return <PaginaCobranca />;

  const respostas = matchPath('/formularios/:id/respostas', path);
  if (respostas) return <PaginaRespostas formId={respostas['id'] as string} />;

  const analises = matchPath('/formularios/:id/analises', path);
  if (analises) return <PaginaAnalises formId={analises['id'] as string} />;

  const builder = matchPath('/formularios/:id', path);
  if (builder) return <PaginaBuilder formId={builder['id'] as string} />;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <p className="text-lg font-medium text-slate-900">Página não encontrada</p>
        <button type="button" className="botao-secundario mt-4" onClick={() => navigate('/formularios')}>
          Voltar ao início
        </button>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={cliente}>
      <RouterProvider>
        <Rotas />
      </RouterProvider>
    </QueryClientProvider>
  );
}
