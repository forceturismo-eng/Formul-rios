import type { ApiErrorBody, ErrorCode } from '@forms/shared';

/**
 * Cliente HTTP da API.
 *
 * Duas responsabilidades que valem o arquivo existir:
 *
 *  1. **Refresh transparente.** O access token vive 15 minutos. Quando expira,
 *     o cliente troca por um novo usando o cookie httpOnly e REFAZ o request
 *     original — uma vez só. O usuário não vê nada; sem isso, ele seria
 *     deslogado no meio de um formulário a cada quinze minutos.
 *
 *  2. **Erros com forma.** A API responde `{ error: { code, message, ... } }`.
 *     Traduzir isso para uma exceção tipada evita que cada tela invente sua
 *     própria leitura do corpo de erro.
 *
 * O access token fica em memória, não em `localStorage`: um XSS que consegue
 * ler `localStorage` leva a sessão inteira junto. Em memória, o estrago acaba
 * quando a aba fecha — e o refresh está num cookie que o JavaScript não lê.
 */

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, string[]>;
  /** Presente em 402: limite, uso atual e para onde mandar o cliente. */
  readonly limit?: number;
  readonly current?: number;
  readonly upgradeUrl?: string;
  readonly addonUrl?: string;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
    if (body.limit !== undefined) this.limit = body.limit;
    if (body.current !== undefined) this.current = body.current;
    if (body.upgradeUrl) this.upgradeUrl = body.upgradeUrl;
    if (body.addonUrl) this.addonUrl = body.addonUrl;
  }

  /** Erros de campo, prontos para o React Hook Form. */
  fieldErrors(): Array<{ field: string; message: string }> {
    return Object.entries(this.details).flatMap(([field, mensagens]) =>
      mensagens.map((message) => ({ field, message })),
    );
  }
}

let accessToken: string | null = null;
let aoPerderSessao: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onSessionLost(handler: () => void): void {
  aoPerderSessao = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Uso interno: impede laço infinito de refresh. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

async function parseError(resposta: Response): Promise<ApiError> {
  const corpo = (await resposta.json().catch(() => null)) as ApiErrorBody | null;

  return new ApiError(
    resposta.status,
    corpo?.error ?? { code: 'internal_error', message: 'Não conseguimos falar com o servidor. Tente de novo.' },
  );
}

/** Uma renovação por vez: dez requests expirando juntos não viram dez refreshes. */
let refreshEmAndamento: Promise<boolean> | null = null;

async function renovarSessao(): Promise<boolean> {
  refreshEmAndamento ??= (async () => {
    try {
      const resposta = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // O cookie httpOnly viaja aqui. É por isso que `credentials` importa.
        credentials: 'include',
        body: '{}',
      });

      if (!resposta.ok) return false;

      const corpo = (await resposta.json()) as { accessToken: string };
      accessToken = corpo.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshEmAndamento = null;
    }
  })();

  return refreshEmAndamento;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const resposta = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (resposta.status === 401 && !options.skipRefresh) {
    if (await renovarSessao()) {
      return api<T>(path, { ...options, skipRefresh: true });
    }
    accessToken = null;
    aoPerderSessao?.();
    throw await parseError(resposta);
  }

  if (!resposta.ok) throw await parseError(resposta);
  if (resposta.status === 204) return undefined as T;

  return (await resposta.json()) as T;
}

/** Upload com multipart. O `Content-Type` é montado pelo navegador. */
export async function uploadFile<T>(path: string, arquivo: File): Promise<T> {
  const dados = new FormData();
  dados.append('file', arquivo);

  const resposta = await fetch(path, {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    credentials: 'include',
    body: dados,
  });

  if (!resposta.ok) throw await parseError(resposta);
  return (await resposta.json()) as T;
}
