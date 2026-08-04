import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { env } from '../config/env.js';

/**
 * Argon2id. O `2` é o valor do enum `Algorithm.Argon2id` do @node-rs/argon2,
 * escrito à mão porque aquele enum é `const enum` ambiente e não sobrevive à
 * compilação com `verbatimModuleSyntax`. A constante nomeada abaixo evita que
 * o número solto vire mistério daqui a seis meses.
 */
const ARGON2ID = 2;

/**
 * Parâmetros do Argon2id.
 *
 * 19 MiB de memória e 2 iterações são a recomendação de primeira opção do
 * OWASP para Argon2id. Custo de memória é o que faz GPU render pouco — subir
 * `timeCost` sem subir `memoryCost` engorda o custo do servidor mais do que o
 * do atacante.
 */
const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTIONS);
  } catch {
    // Hash corrompido ou de formato desconhecido: trata como senha errada,
    // nunca como erro 500 (que já seria um oráculo).
    return false;
  }
}

/**
 * Hash descartável usado quando o e-mail não existe, para que login com e-mail
 * inexistente demore o mesmo que login com senha errada. Sem isso, o tempo de
 * resposta vira um enumerador de usuários.
 */
let dummyHashPromise: Promise<string> | null = null;
export function dummyPasswordVerify(plain: string): Promise<boolean> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('hex'));
  return dummyHashPromise.then((hash) => verifyPassword(hash, plain));
}

/**
 * Token opaco de uso único (convite, verificação de e-mail, refresh).
 * 32 bytes de entropia. O valor em claro existe uma vez só — no e-mail ou no
 * cookie. O banco guarda apenas o hash.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 do token. Aqui não se usa Argon2 de propósito: o token já tem 256
 * bits de entropia, então não existe ataque de dicionário para desacelerar — e
 * um KDF caro numa rota chamada a cada refresh vira negação de serviço.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * IP e user-agent nunca são gravados em claro (seção 9).
 * HMAC com sal do ambiente: sem o sal, o hash não pode ser revertido por
 * força bruta no espaço de endereços IPv4, que é pequeno o bastante para isso.
 */
export function hashIdentifier(value: string | undefined | null): string | null {
  if (!value) return null;
  return createHmac('sha256', env.IP_HASH_SALT).update(value).digest('hex');
}
