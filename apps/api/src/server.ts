import { buildApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma } from './db/prisma.js';

const app = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await disconnectPrisma();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(
    { appDomain: env.branding.appDomain, cnameDomain: env.branding.cnameDomain },
    `${env.branding.productName} — API no ar`,
  );
} catch (error) {
  app.log.fatal({ err: error }, 'falha ao subir a API');
  process.exit(1);
}
