import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ForbiddenError, HTTP_STATUS_BY_CODE, type ApiErrorBody, type ErrorCode } from '@forms/shared';

/**
 * Erros da API.
 *
 * A regra que manda aqui: recurso que a organização não pode ver responde
 * `notFound()`, com 404. Nunca 403. Um 403 confirma que o recurso existe, e
 * essa confirmação já é vazamento — dá para mapear quantos formulários o
 * concorrente tem sem ler nenhum deles.
 *
 * 403 fica reservado para o caso em que a existência já é conhecida de quem
 * pergunta: você é membro da empresa e tentou uma ação acima do seu papel.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly extra?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: { details?: Record<string, string[]>; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS_BY_CODE[code];
    if (options.details) this.details = options.details;
    if (options.extra) this.extra = options.extra;
  }
}

export const notFound = (message = 'Não encontramos o que você procura.'): AppError =>
  new AppError('not_found', message);

export const unauthorized = (message = 'Faça login para continuar.'): AppError =>
  new AppError('unauthorized', message);

export const forbidden = (message = 'Seu papel nesta empresa não permite essa ação.'): AppError =>
  new AppError('forbidden', message);

export const conflict = (message: string): AppError => new AppError('conflict', message);

export const validationError = (details: Record<string, string[]>, message = 'Revise os campos destacados.'): AppError =>
  new AppError('validation_error', message, { details });

function zodToDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

function body(code: ErrorCode, message: string, details?: Record<string, string[]>, extra?: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, ...(details ? { details } : {}), ...(extra ?? {}) } };
}

export function registerErrorHandler(app: {
  setErrorHandler: (handler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void) => unknown;
  setNotFoundHandler: (handler: (request: FastifyRequest, reply: FastifyReply) => void) => unknown;
}): void {
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send(body('not_found', 'Não encontramos o que você procura.'));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send(body(error.code, error.message, error.details, error.extra));
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(422).send(body('validation_error', 'Revise os campos destacados.', zodToDetails(error)));
      return;
    }

    if (error instanceof ForbiddenError) {
      void reply.status(403).send(body('forbidden', 'Seu papel nesta empresa não permite essa ação.'));
      return;
    }

    // O @fastify/multipart estoura antes de sabermos o plano de quem enviou —
    // este é o teto absoluto do processo, não o limite do plano.
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      void reply
        .status(413)
        .send(body('validation_error', 'Esse arquivo é grande demais. Envie um arquivo menor.'));
      return;
    }

    // Rate limit e erros de parsing do próprio Fastify já chegam com statusCode.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      const code: ErrorCode = error.statusCode === 429 ? 'rate_limited' : 'validation_error';
      void reply.status(error.statusCode).send(body(code, error.message));
      return;
    }

    // Daqui para baixo é bug nosso. O cliente recebe uma mensagem genérica —
    // stack trace e mensagem interna ficam no log, nunca na resposta.
    request.log.error({ err: error }, 'erro não tratado');
    void reply.status(500).send(body('internal_error', 'Algo deu errado do nosso lado. Tente de novo em instantes.'));
  });
}
