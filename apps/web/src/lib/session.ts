import { create } from 'zustand';
import { can, type Action, type Role } from '@forms/shared';
import { api, onSessionLost, setAccessToken } from './api.js';

/**
 * Sessão do usuário.
 *
 * O access token NÃO fica aqui — ele vive em memória dentro de `api.ts`, fora
 * do alcance de qualquer serialização de estado. O que este store guarda é
 * quem é a pessoa, em qual empresa ela está e quais empresas ela tem.
 */

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
  planCode: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  planCode: string;
}

interface SessionResponse {
  accessToken: string;
  user: SessionUser;
  organization: SessionOrganization;
  memberships: Membership[];
}

interface SessionState {
  user: SessionUser | null;
  organization: SessionOrganization | null;
  memberships: Membership[];
  /** `true` até sabermos se há sessão — evita piscar a tela de login. */
  loading: boolean;

  entrar: (email: string, password: string, organizationId?: string) => Promise<void>;
  registrar: (input: { name: string; email: string; password: string; organizationName: string }) => Promise<void>;
  sair: () => Promise<void>;
  trocarEmpresa: (organizationId: string) => Promise<void>;
  restaurar: () => Promise<void>;
  aplicarSessao: (resposta: SessionResponse) => void;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  organization: null,
  memberships: [],
  loading: true,

  aplicarSessao(resposta) {
    setAccessToken(resposta.accessToken);
    set({
      user: resposta.user,
      organization: resposta.organization,
      memberships: resposta.memberships,
      loading: false,
    });
  },

  async entrar(email, password, organizationId) {
    const resposta = await api<SessionResponse>('/v1/auth/login', {
      method: 'POST',
      body: { email, password, ...(organizationId ? { organizationId } : {}) },
    });
    get().aplicarSessao(resposta);
  },

  async registrar(input) {
    const resposta = await api<SessionResponse>('/v1/auth/register', { method: 'POST', body: input });
    get().aplicarSessao(resposta);
  },

  async sair() {
    await api('/v1/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setAccessToken(null);
    set({ user: null, organization: null, memberships: [], loading: false });
  },

  async trocarEmpresa(organizationId) {
    const resposta = await api<SessionResponse>('/v1/auth/switch-organization', {
      method: 'POST',
      body: { organizationId },
    });
    get().aplicarSessao(resposta);
  },

  /**
   * Recupera a sessão ao abrir o app.
   *
   * O access token some a cada recarga (ele vive em memória). O cookie de
   * refresh sobrevive, e é ele que devolve a sessão sem pedir senha de novo.
   */
  async restaurar() {
    try {
      const resposta = await api<SessionResponse>('/v1/auth/refresh', {
        method: 'POST',
        body: {},
        skipRefresh: true,
      });
      get().aplicarSessao(resposta);
    } catch {
      set({ user: null, organization: null, memberships: [], loading: false });
    }
  },
}));

/** Quando a renovação falha de vez, o store precisa saber. */
onSessionLost(() => {
  useSession.setState({ user: null, organization: null, memberships: [], loading: false });
});

export function useIsAuthenticated(): boolean {
  return useSession((estado) => estado.user !== null);
}

export function usePermission(): {
  role: Role | null;
  is: (...papeis: Role[]) => boolean;
  can: (acao: Action) => boolean;
} {
  const role = useSession((estado) => estado.organization?.role ?? null);
  const userId = useSession((estado) => estado.user?.id ?? null);
  const organizationId = useSession((estado) => estado.organization?.id ?? null);

  return {
    role,
    is: (...papeis) => (role ? papeis.includes(role) : false),
    // Mesma tabela de permissões do backend, vinda do pacote compartilhado.
    // Esconder o que o usuário não pode fazer é cortesia; quem recusa de
    // verdade é a API, que refaz esta checagem no servidor.
    can: (acao) =>
      role !== null && userId !== null && organizationId !== null
        ? can({ userId, organizationId, role }, acao)
        : false,
  };
}
