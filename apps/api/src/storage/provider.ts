import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from '../config/env.js';

/**
 * Armazenamento de arquivos.
 *
 * Atrás de uma interface pelo mesmo motivo do gateway de pagamento: o domínio
 * não deve saber se por baixo tem S3, MinIO ou disco. E porque testar upload
 * contra um bucket de verdade transforma a suíte em algo que só roda com
 * infraestrutura no ar.
 *
 * Duas regras valem em qualquer driver:
 *
 *  1. O caminho SEMPRE começa com o organization_id. O isolamento entre
 *     empresas não para no banco — vale para o bucket também. Um caminho
 *     montado errado é um vazamento que o RLS não pega.
 *  2. O nome do arquivo no storage é aleatório, nunca o que o usuário enviou.
 *     Nome original vira metadado no banco. Isso mata path traversal
 *     ("../../etc/passwd"), colisão e execução por extensão.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
}

export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** URL temporária de download. Bucket é privado: sem URL assinada, sem acesso. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * Monta o caminho no bucket.
 *
 * `organizationId` é validado como UUID antes de virar caminho: é a única
 * parte da chave que vem de fora do módulo, e uma barra a mais aqui furaria o
 * prefixo de isolamento.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildObjectKey(organizationId: string, scope: 'respostas' | 'logos' | 'exportacoes'): string {
  if (!UUID_RE.test(organizationId)) throw new Error('organizationId inválido para montar caminho no storage.');

  const nomeAleatorio = randomBytes(16).toString('hex');
  const hoje = new Date().toISOString().slice(0, 10);
  return `${organizationId}/${scope}/${hoje}/${nomeAleatorio}`;
}

/** `true` se a chave pertence à organização — checado antes de qualquer leitura. */
export function keyBelongsTo(key: string, organizationId: string): boolean {
  return key.startsWith(`${organizationId}/`);
}

// -----------------------------------------------------------------------------
// Driver de disco local
// -----------------------------------------------------------------------------

/**
 * Guarda em disco. Serve para desenvolvimento sem MinIO e para os testes.
 *
 * As URLs assinadas aqui são reais no formato — token HMAC com expiração — e
 * são servidas pela própria API. O que muda em produção é quem serve o byte,
 * não o contrato.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root = resolve(process.cwd(), '.storage')) {
    this.root = root;
  }

  private pathOf(key: string): string {
    // A chave é sempre gerada por `buildObjectKey`, mas confiar nisso seria
    // exatamente o tipo de suposição que vira CVE.
    if (key.includes('..') || key.startsWith('/')) throw new Error('Chave de objeto inválida.');
    return join(this.root, key);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<StoredObject> {
    const caminho = this.pathOf(key);
    await mkdir(dirname(caminho), { recursive: true });
    await writeFile(caminho, body);
    return { key, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expiraEm = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const assinatura = signKey(key, expiraEm);
    return `${env.API_URL}/v1/files/download?key=${encodeURIComponent(key)}&exp=${expiraEm}&sig=${assinatura}`;
  }
}

/** HMAC da chave + expiração. Sem ela, adivinhar o caminho bastaria. */
export function signKey(key: string, expiresAt: number): string {
  return createHash('sha256').update(`${key}:${expiresAt}:${env.IP_HASH_SALT}`).digest('hex');
}

export function verifySignedKey(key: string, expiresAt: number, signature: string): boolean {
  if (Number.isNaN(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  return signKey(key, expiresAt) === signature;
}

// -----------------------------------------------------------------------------
// Seleção do driver
// -----------------------------------------------------------------------------

let provider: StorageProvider = new LocalStorageProvider();

export function setStorageProvider(next: StorageProvider): void {
  provider = next;
}

export function storage(): StorageProvider {
  return provider;
}
