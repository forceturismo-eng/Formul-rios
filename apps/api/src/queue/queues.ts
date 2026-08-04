import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

/**
 * Filas BullMQ.
 *
 * O que entra em fila e por quê: qualquer trabalho cuja duração não caiba no
 * tempo de um request. Exportar 25.000 respostas leva minutos; um e-mail
 * depende de um SMTP que pode estar lento; a análise com IA depende de uma API
 * externa. Nenhum dos três pode segurar a resposta HTTP do usuário.
 *
 * A conexão é preguiçosa de propósito: um ambiente sem Redis (o CI de testes
 * unitários, por exemplo) sobe a API normalmente e só falha se alguém tentar
 * de fato enfileirar. Melhor do que exigir Redis para rodar um teste de
 * validação de CPF.
 */

export const QUEUE_NAMES = {
  export: 'exportacoes',
  email: 'emails',
  webhook: 'webhooks',
  ai: 'analises-ia',
  retention: 'retencao',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

let connection: IORedis | null = null;
const queues = new Map<string, Queue>();

export function redisConnection(): IORedis {
  connection ??= new IORedis(env.REDIS_URL ?? 'redis://localhost:6379', {
    // Exigido pelo BullMQ: com retry limitado, um job pode ser perdido durante
    // uma indisponibilidade momentânea do Redis.
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  return connection;
}

/** Política padrão de retentativa. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Mantém os últimos jobs para inspeção sem deixar o Redis crescer sem fim.
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 24 * 3600, count: 500 },
};

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redisConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}

// -----------------------------------------------------------------------------
// Contrato dos jobs
// -----------------------------------------------------------------------------

/**
 * Todo job carrega `organizationId`.
 *
 * O worker abre o contexto de tenant com ele, exatamente como a API faz num
 * request. Um job sem contexto enxerga zero linhas — o que é o comportamento
 * correto, e está coberto por teste.
 */
export interface TenantJob {
  organizationId: string;
  /** Quem pediu. Vai para o audit log e para a notificação de conclusão. */
  requestedBy: string;
}

export interface ExportJobData extends TenantJob {
  exportId: string;
  formId: string;
  format: 'csv' | 'xlsx' | 'json';
  filters: {
    status?: 'new' | 'reviewed' | 'archived';
    isFlagged?: boolean;
    from?: string;
    to?: string;
    search?: string;
  };
}
