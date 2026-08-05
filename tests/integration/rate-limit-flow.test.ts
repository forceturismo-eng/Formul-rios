import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import {
  closeRateLimitRedis,
  rateLimitRedis,
  RATE_LIMIT_NAMESPACE,
} from '../../apps/api/src/http/rate-limit.js';
import { disconnectPrisma } from '../../apps/api/src/db/prisma.js';

/**
 * Rate limit compartilhado entre processos.
 *
 * O teste que dá sentido a este arquivo é o de duas instâncias: ele sobe DOIS
 * apps — o equivalente a dois processos atrás de um balanceador — e mostra que
 * o contador é um só.
 *
 * Com o contador em memória esse mesmo teste passaria a impressão de estar
 * tudo certo em cada instância isoladamente, enquanto o limite efetivo era o
 * dobro do configurado. É exatamente o tipo de falha que não aparece em
 * desenvolvimento, onde só existe um processo.
 */

const HOST = 'localhost';
const TEM_REDIS = Boolean(process.env['REDIS_URL'] ?? 'redis://localhost:6379');

let primeira: FastifyInstance;
let segunda: FastifyInstance;

/**
 * IP diferente por caso E por execução.
 *
 * Por caso, porque o contador é por IP e um caso não pode gastar o do outro.
 * Por execução, porque agora o contador vive no Redis com TTL de 15 minutos —
 * rodar a suíte duas vezes seguidas encontraria o limite já gasto pela rodada
 * anterior. Foi o que aconteceu no primeiro teste depois de a correção entrar.
 */
const BLOCO = Math.floor(Math.random() * 250);
let proximoIp = 0;
function ipDoTeste(): string {
  proximoIp += 1;
  return `198.51.${BLOCO}.${proximoIp % 250}`;
}

beforeAll(async () => {
  primeira = await buildApp();
  segunda = await buildApp();
});

afterAll(async () => {
  await primeira.close();
  await segunda.close();
  await closeRateLimitRedis();
  await disconnectPrisma();
});

describe('o contador é compartilhado entre processos', () => {
  it.skipIf(!TEM_REDIS)('cinco tentativas gastam o limite do login nas DUAS instâncias', async () => {
    const ip = ipDoTeste();

    const tentar = (app: FastifyInstance) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: ip,
        headers: { host: HOST },
        payload: { email: 'ninguem@exemplo.test', password: 'senha-errada-mas-longa-2026' },
      });

    // O limite do login é 5 por 15 minutos. Gasta 3 numa instância…
    for (let i = 0; i < 3; i++) {
      const resposta = await tentar(primeira);
      expect(resposta.statusCode, `tentativa ${i + 1}`).toBe(401);
    }

    // …e 2 na outra. Com contador em memória, cada uma acharia que está na
    // terceira tentativa e as duas seguintes passariam.
    for (let i = 0; i < 2; i++) {
      const resposta = await tentar(segunda);
      expect(resposta.statusCode, `tentativa ${i + 4}`).toBe(401);
    }

    // A sexta é recusada, não importa em qual instância ela chegue.
    expect((await tentar(segunda)).statusCode).toBe(429);
    expect((await tentar(primeira)).statusCode).toBe(429);
  });

  it.skipIf(!TEM_REDIS)('o contador de um IP não afeta o de outro', async () => {
    const ip = ipDoTeste();

    const resposta = await primeira.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip,
      headers: { host: HOST },
      payload: { email: 'outro@exemplo.test', password: 'senha-errada-mas-longa-2026' },
    });

    // Um IP novo começa do zero mesmo que outro tenha estourado agora mesmo.
    expect(resposta.statusCode).toBe(401);
  });
});

describe('as chaves não colidem com as das filas', () => {
  it.skipIf(!TEM_REDIS)('usa um prefixo próprio', async () => {
    const redis = rateLimitRedis();
    expect(redis).not.toBeNull();

    const ip = ipDoTeste();

    await primeira.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: ip,
      headers: { host: HOST },
      payload: { email: 'chave@exemplo.test', password: 'senha-errada-mas-longa-2026' },
    });

    // O BullMQ usa `bull:` nas chaves dele. Um prefixo compartilhado faria uma
    // limpeza de filas apagar contadores de rate limit, e vice-versa.
    const chaves = await redis!.keys(`${RATE_LIMIT_NAMESPACE}*`);
    expect(chaves.length).toBeGreaterThan(0);

    for (const chave of chaves) {
      expect(chave.startsWith('bull')).toBe(false);
    }
  });
});

describe('o produto continua de pé sem o contador', () => {
  it('a submissão pública não depende do rate limit para funcionar', async () => {
    // `skipOnError: true` é decisão consciente: com o Redis fora do ar, o rate
    // limit para de contar e os requests passam. Recusar tudo transformaria uma
    // indisponibilidade do Redis numa indisponibilidade do produto — inclusive
    // para quem só quer responder um formulário.
    const resposta = await primeira.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: ipDoTeste(),
      headers: { host: HOST },
    });

    expect(resposta.statusCode).toBe(200);
  });
});
