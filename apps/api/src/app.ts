import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { registerErrorHandler } from './http/errors.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes, paymentWebhookRoutes } from './routes/billing.js';
import { fileRoutes } from './routes/files.js';
import { formRoutes } from './routes/forms.js';
import { organizationRoutes, planRoutes } from './routes/organizations.js';
import { publicFormRoutes } from './routes/public-forms.js';
import { resourceRoutes } from './routes/resources.js';
import { responseRoutes } from './routes/responses.js';

/**
 * Montagem da aplicação.
 *
 * Separada de `server.ts` para que os testes subam a mesma instância que roda
 * em produção, sem abrir porta. Teste que exercita um app diferente do real
 * não prova nada sobre o real.
 */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.isTest ? 'silent' : env.LOG_LEVEL,
      // Redação automática: nada de senha, token ou cookie no log (seção 9).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'body.password',
          'body.token',
        ],
        censor: '[redigido]',
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            host: request.headers.host,
          };
        },
      },
    },
    // Confia no proxy só quando ele é nosso: sem isso, `request.ip` seria o
    // que o cliente escrever em X-Forwarded-For, e o rate limit por IP viraria
    // decoração.
    trustProxy: env.isProduction,
    disableRequestLogging: env.isTest,
    genReqId: () => crypto.randomUUID(),
  });

  app.decorateRequest('auth', null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // HSTS só faz sentido quando já se serve HTTPS de verdade.
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    // Lista fechada. `origin: true` refletiria qualquer origem — com
    // `credentials: true`, isso entregaria a sessão para qualquer site.
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });

  await app.register(cookie, {
    secret: env.JWT_ACCESS_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax' },
  });

  await app.register(multipart, {
    limits: {
      // Teto absoluto do processo, acima do maior plano (Enterprise, 1 GB).
      // O limite POR PLANO é aplicado depois, quando já sabemos quem enviou —
      // aqui o objetivo é só não deixar um upload infinito comer a memória.
      fileSize: 1024 * 1024 * 1024,
      files: 1,
      fields: 20,
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Em produção com mais de uma instância, trocar por Redis: contador em
    // memória multiplica o limite pelo número de processos.
    keyGenerator: (request) => request.ip,
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok', product: env.branding.productName }));

  // Renderizador público — as únicas rotas servidas também nos domínios de
  // clientes. Sem prefixo /v1: a URL /f/<slug> é divulgada pelo cliente e
  // precisa ser curta e estável.
  await app.register(publicFormRoutes);
  await app.register(fileRoutes);
  // Webhook do gateway: sem autenticação de usuário, com token do provedor.
  await app.register(paymentWebhookRoutes);

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(planRoutes, { prefix: '/v1' });
  await app.register(organizationRoutes, { prefix: '/v1' });
  await app.register(formRoutes, { prefix: '/v1' });
  await app.register(responseRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(resourceRoutes, { prefix: '/v1' });

  return app;
}
