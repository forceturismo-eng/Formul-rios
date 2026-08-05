import { startExportWorker } from '../../api/src/queue/export-worker.js';
import { startWebhookWorker } from '../../api/src/queue/webhook-worker.js';
import { closeQueues } from '../../api/src/queue/queues.js';
import { disconnectPrisma } from '../../api/src/db/prisma.js';

/**
 * Processo dos workers.
 *
 * Separado da API de propósito: um job pesado — exportar 25.000 respostas,
 * cada uma decifrada individualmente — não pode competir por CPU com quem está
 * esperando uma tela carregar. Em produção eles escalam separado.
 *
 * Os workers compartilham o código da API (contexto de tenant, repositórios,
 * criptografia) em vez de reimplementar. Um worker com a própria versão do
 * isolamento de tenant seria uma segunda chance de errar.
 */

const workers = [startExportWorker(), startWebhookWorker()];

console.info(`workers no ar: ${workers.length}`);

async function shutdown(signal: string): Promise<void> {
  console.info(`encerrando workers (${signal})`);
  // `close()` espera o job em andamento terminar. Matar um export pela metade
  // deixaria o pedido preso em "processando" para sempre.
  await Promise.all(workers.map((worker) => worker.close()));
  await closeQueues();
  await disconnectPrisma();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
