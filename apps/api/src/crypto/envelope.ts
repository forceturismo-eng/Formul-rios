import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Criptografia das respostas em repouso — envelope encryption (seção 9).
 *
 * Três chaves em camadas:
 *
 *   chave mestra        vem do ambiente (em produção, do KMS)
 *        ↓ HKDF com o organization_id como info
 *   chave da organização derivada, nunca gravada
 *        ↓ cifra
 *   chave de dados      uma por resposta, aleatória, gravada cifrada
 *        ↓ cifra
 *   conteúdo da resposta
 *
 * Por que não cifrar tudo direto com a chave mestra:
 *
 *  - Uma chave por resposta limita o estrago. Vazar uma chave de dados expõe
 *    uma resposta, não o banco.
 *  - Derivar por organização significa que a chave que abre a Empresa A não
 *    abre a Empresa B, mesmo com acesso ao banco inteiro. É a mesma fronteira
 *    do RLS, agora em criptografia.
 *  - Rotacionar a chave mestra depois vira re-cifrar as chaves de dados, não
 *    as respostas — que são o volume.
 *
 * AES-256-GCM em todos os níveis: além de cifrar, autentica. Um byte alterado
 * no banco faz a decifragem falhar, em vez de devolver lixo silenciosamente.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits — o tamanho que o GCM foi desenhado para usar.
const TAG_BYTES = 16;

function loadMasterKey(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_MASTER_KEY, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_MASTER_KEY precisa ter 32 bytes em base64 (tem ${key.length}). Gere com: openssl rand -base64 32`,
    );
  }
  return key;
}

const masterKey = loadMasterKey();

/**
 * Chave da organização, derivada por HKDF. Não é gravada em lugar nenhum:
 * é recalculada a cada uso, a partir da chave mestra e do id da organização.
 */
const orgKeyCache = new Map<string, Buffer>();

function organizationKey(organizationId: string): Buffer {
  const cached = orgKeyCache.get(organizationId);
  if (cached) return cached;

  const derived = Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.from('formularios:org-key:v1'), Buffer.from(organizationId), KEY_BYTES),
  );
  orgKeyCache.set(organizationId, derived);
  return derived;
}

/** Layout de um blob cifrado: [iv (12) | tag (16) | ciphertext]. */
function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function open(key: Buffer, blob: Buffer, aad?: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Blob cifrado truncado.');

  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * O que sai daqui e vai para a coluna `bytea`.
 *
 * `Uint8Array<ArrayBuffer>` e não `Buffer` de propósito: é exatamente o tipo
 * que o Prisma aceita. O `Buffer` do Node 22 é tipado como
 * `Buffer<ArrayBufferLike>`, que não satisfaz essa restrição — converter aqui,
 * na fronteira, evita um cast espalhado por todo serviço que grava resposta.
 */
export interface EncryptedPayload {
  dataEncrypted: Uint8Array<ArrayBuffer>;
  dataKeyEncrypted: Uint8Array<ArrayBuffer>;
}

/** O que entra: qualquer sequência de bytes, inclusive a que veio do banco. */
export interface EncryptedInput {
  dataEncrypted: Uint8Array;
  dataKeyEncrypted: Uint8Array;
}

function toBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

/**
 * Cifra o conteúdo de uma resposta.
 *
 * O `organizationId` entra como AAD (dado autenticado adicional) na chave de
 * dados. Isso amarra o envelope ao tenant: mover a linha de uma organização
 * para outra no banco não a torna legível — a autenticação do GCM falha.
 */
export function encryptResponseData(organizationId: string, data: unknown): EncryptedPayload {
  const dataKey = randomBytes(KEY_BYTES);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');

  const dataEncrypted = seal(dataKey, plaintext);
  const dataKeyEncrypted = seal(organizationKey(organizationId), dataKey, Buffer.from(organizationId));

  // A chave de dados em claro não sobrevive a esta função.
  dataKey.fill(0);

  return { dataEncrypted: toBytes(dataEncrypted), dataKeyEncrypted: toBytes(dataKeyEncrypted) };
}

export function decryptResponseData<T = unknown>(organizationId: string, payload: EncryptedInput): T {
  const dataKey = open(
    organizationKey(organizationId),
    Buffer.from(payload.dataKeyEncrypted),
    Buffer.from(organizationId),
  );
  try {
    return JSON.parse(open(dataKey, Buffer.from(payload.dataEncrypted)).toString('utf8')) as T;
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Redação de PII para envio à IA (seção 5.3).
 *
 * Roda ANTES de qualquer coisa sair do servidor. Máscara parcial em vez de
 * remoção total porque a análise de temas ainda precisa distinguir respostas
 * diferentes umas das outras.
 */
const PII_PATTERNS: Array<{ regex: RegExp; replace: (match: string) => string }> = [
  // CPF e CNPJ, com ou sem máscara.
  { regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replace: () => '[CPF]' },
  { regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, replace: () => '[CNPJ]' },
  // E-mail: preserva o domínio, que costuma ser sinal útil (cliente corporativo).
  {
    regex: /\b[\w.+-]+@([\w-]+\.[\w.-]+)\b/g,
    replace: (match) => `[EMAIL]@${match.split('@')[1] ?? ''}`,
  },
  // Telefone brasileiro com DDD.
  { regex: /\b\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, replace: () => '[TELEFONE]' },
  // CEP.
  { regex: /\b\d{5}-?\d{3}\b/g, replace: () => '[CEP]' },
];

export function redactPII(value: unknown): unknown {
  if (typeof value === 'string') {
    let redigido = value;
    for (const { regex, replace } of PII_PATTERNS) {
      redigido = redigido.replace(regex, (match) => replace(match));
    }
    return redigido;
  }

  if (Array.isArray(value)) return value.map(redactPII);

  if (value && typeof value === 'object') {
    const resultado: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(value)) {
      // Campos cujo nome já denuncia o conteúdo são mascarados inteiros — o
      // padrão textual não pegaria "João da Silva" num campo "nome".
      resultado[chave] = /^(nome|name|nome_completo|full_?name|assinatura|signature)$/i.test(chave)
        ? '[NOME]'
        : redactPII(item);
    }
    return resultado;
  }

  return value;
}
