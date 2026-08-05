import IORedis from 'ioredis';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

/**
 * Contador do rate limit.
 *
 * O contador em memória — o padrão do plugin — tem um defeito que só aparece em
 * produção: ele é POR PROCESSO. Com quatro instâncias atrás de um balanceador,
 * um limite de "5 tentativas de login por 15 minutos" vira 20, e ninguém
 * percebe porque cada processo está obedecendo direitinho o próprio contador.
 *
 * Em Redis o contador é um só. É o que faz o número configurado significar o
 * que está escrito.
 *
 * Sem `REDIS_URL`, cai para memória: quem está desenvolvendo o builder não
 * precisa de Redis, e um processo só não tem o problema acima.
 */

let cliente: IORedis | null = null;

/**
 * Prefixo das chaves no Redis.
 *
 * Evita colidir com as do BullMQ, que usa `bull:`. Um prefixo compartilhado
 * faria uma limpeza de filas apagar contadores de rate limit, e vice-versa.
 *
 * Em teste ganha um sufixo por PROCESSO, calculado uma única vez. Sem ele, o
 * contador — que agora é compartilhado e sobrevive 15 minutos — carregaria de
 * uma execução da suíte para a próxima, e os testes falhariam por 429 sem
 * relação nenhuma com a mudança em análise. É o preço de o rate limit ter
 * passado a funcionar de verdade.
 *
 * Calculado uma vez de propósito: duas instâncias no MESMO processo precisam do
 * mesmo prefixo, senão o teste que prova o compartilhamento não prova nada.
 */
export const RATE_LIMIT_NAMESPACE = env.isTest
  ? `fx-rl-teste-${process.pid}-${Date.now()}:`
  : 'fx-rl:';

/**
 * Conexão dedicada ao rate limit.
 *
 * Separada da conexão do BullMQ de propósito: a das filas usa
 * `maxRetriesPerRequest: null` — ela deve insistir para não perder job. Aqui é
 * o oposto: um request HTTP não pode ficar pendurado esperando o Redis
 * responder. Falha rápido e o plugin decide o que fazer.
 */
export function rateLimitRedis(): IORedis | null {
  if (!env.REDIS_URL) return null;

  cliente ??= new IORedis(env.REDIS_URL, {
    // Uma tentativa. O caminho de erro está resolvido abaixo, e insistir só
    // aumentaria a latência de todo request durante uma indisponibilidade.
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    // Curto o bastante para não segurar um request, longo o bastante para o
    // Redis responder em condição normal.
    commandTimeout: 300,
    // A fila de offline FICA LIGADA de propósito.
    //
    // Com ela desligada, os comandos emitidos antes de a conexão ficar pronta
    // falham na hora — e `skipOnError` os engole em silêncio. O efeito era o
    // rate limit simplesmente não contar os primeiros requests depois de cada
    // subida, sem nenhum sinal no log. Foi assim que este arquivo nasceu
    // errado, e o teste de duas instâncias pegou.
    //
    // Ligada, esses comandos esperam a conexão; se o Redis estiver mesmo fora,
    // o `commandTimeout` acima resolve em 300ms.
    enableOfflineQueue: true,
    // Sem isto, um Redis fora do ar enche o log com uma linha por request.
    retryStrategy: (tentativas) => Math.min(tentativas * 200, 5_000),
  });

  return cliente;
}

export async function closeRateLimitRedis(): Promise<void> {
  if (cliente) {
    cliente.disconnect();
    cliente = null;
  }
}

/**
 * Configuração global do plugin.
 *
 * **`skipOnError: true` é uma decisão, não um descuido.** Com o Redis fora do
 * ar, o rate limit para de contar e os requests passam. A alternativa —
 * recusar tudo — transformaria uma indisponibilidade do Redis numa
 * indisponibilidade do produto inteiro, inclusive para quem só quer responder
 * um formulário.
 *
 * O que sustenta essa escolha é não ser a única defesa: a senha passa por
 * Argon2 (caro por tentativa), o admin tem MFA obrigatório, e o token de
 * sessão dura 15 minutos.
 */
export function rateLimitOptions() {
  const redis = rateLimitRedis();

  return {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(redis ? { redis } : {}),
    skipOnError: true,
    // O prefixo evita colidir com as chaves do BullMQ no mesmo Redis.
    //
    // Em teste ele ganha um sufixo por processo. Sem isso, o contador — que
    // agora é compartilhado e sobrevive 15 minutos — carregaria de uma execução
    // da suíte para a próxima, e os testes falhariam por 429 sem relação
    // nenhuma com a mudança em análise. É o preço de o rate limit ter passado
    // a funcionar de verdade.
    nameSpace: RATE_LIMIT_NAMESPACE,
    keyGenerator: (request: FastifyRequest) => request.ip,
    /** `true` quando o contador é compartilhado entre processos. */
    distribuido: redis !== null,
  };
}
