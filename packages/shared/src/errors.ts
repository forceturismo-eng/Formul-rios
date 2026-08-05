/**
 * Códigos de erro da API.
 *
 * Regra de ouro do multi-tenant: recurso de outra organização responde
 * `not_found` com HTTP 404, nunca 403. Um 403 confirma que o recurso existe —
 * isso é um vazamento de informação, mesmo sem o conteúdo.
 */

export const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'quota_exceeded',
  'payment_required',
  'email_not_verified',
  /** Recurso que depende de terceiro e ele não está disponível agora. */
  'service_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Erros de validação, campo a campo. */
    details?: Record<string, string[]>;
    /** Presente em `quota_exceeded` / `payment_required` (seção 6.2). */
    limit?: number;
    current?: number;
    upgradeUrl?: string;
    addonUrl?: string;
  };
}

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 402,
  payment_required: 402,
  email_not_verified: 403,
  // 503 e não 500: o problema é temporário e de um terceiro, e a diferença
  // muda o que a tela diz e o que o cliente faz a seguir.
  service_unavailable: 503,
  internal_error: 500,
};
