import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238), escrito aqui.
 *
 * São quarenta linhas de HMAC e aritmética, e o algoritmo está congelado desde
 * 2011. Uma dependência no caminho da autenticação do admin é uma superfície
 * que precisaria ser auditada a cada atualização — e o admin é a conta que
 * enxerga todos os clientes.
 *
 * Compatível com Google Authenticator, Authy, 1Password e qualquer app que
 * siga o RFC: SHA-1, 6 dígitos, janela de 30 segundos. SHA-1 aqui não é
 * escolha de segurança, é interoperabilidade — o HMAC não está protegendo
 * confidencialidade, e nenhum app popular aceita outra coisa.
 */

const DIGITOS = 6;
const PASSO_SEGUNDOS = 30;

/**
 * Quantas janelas de 30s aceitar para trás e para frente.
 *
 * Uma para cada lado: cobre relógio do celular fora de sincronia e o usuário
 * que digita nos últimos segundos do código. Mais do que isso amplia a janela
 * de reuso de um código interceptado sem ganho prático.
 */
const TOLERANCIA_JANELAS = 1;

// -----------------------------------------------------------------------------
// Base32 (RFC 4648, sem padding) — o formato que os apps autenticadores leem
// -----------------------------------------------------------------------------

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let saida = '';

  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];

  return saida;
}

export function base32Decode(texto: string): Buffer {
  // Apps mostram o segredo em grupos separados por espaço, e gente copia com
  // eles. Minúscula idem.
  const limpo = texto.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');

  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];

  for (const caractere of limpo) {
    const indice = ALFABETO.indexOf(caractere);
    if (indice === -1) throw new Error('Segredo TOTP inválido.');

    valor = (valor << 5) | indice;
    bits += 5;

    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// -----------------------------------------------------------------------------
// TOTP
// -----------------------------------------------------------------------------

/** Segredo novo, com 160 bits — o tamanho recomendado pelo RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Código de uma janela específica. Exposto para os testes exercitarem deriva. */
export function totpAt(secret: string, contador: number): string {
  const chave = base32Decode(secret);

  const buffer = Buffer.alloc(8);
  // O contador é um inteiro sem sinal de 64 bits. Negativo só aparece com
  // relógio perto da época — e `writeBigUInt64BE` lança nesse caso, o que
  // derrubaria a verificação em vez de recusá-la.
  buffer.writeBigUInt64BE(BigInt(Math.max(0, contador)));

  const hmac = createHmac('sha1', chave).update(buffer).digest();

  // Truncagem dinâmica do RFC 4226: os 4 bits finais escolhem de onde ler.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binario =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return (binario % 10 ** DIGITOS).toString().padStart(DIGITOS, '0');
}

export function generateTotp(secret: string, agora = Date.now()): string {
  return totpAt(secret, Math.floor(agora / 1000 / PASSO_SEGUNDOS));
}

/**
 * Confere um código.
 *
 * Comparação em tempo constante. O ganho é pequeno para seis dígitos, mas o
 * custo de fazer certo é uma linha, e um lado do sistema em que "é pouco
 * provável que dê para explorar" vira precedente para o próximo.
 */
export function verifyTotp(secret: string, codigo: string, agora = Date.now()): boolean {
  const limpo = codigo.replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpo)) return false;

  const janelaAtual = Math.floor(agora / 1000 / PASSO_SEGUNDOS);

  for (let deriva = -TOLERANCIA_JANELAS; deriva <= TOLERANCIA_JANELAS; deriva++) {
    const esperado = Buffer.from(totpAt(secret, janelaAtual + deriva));
    const recebido = Buffer.from(limpo);

    if (esperado.length === recebido.length && timingSafeEqual(esperado, recebido)) return true;
  }

  return false;
}

/**
 * A janela em que um código foi usado.
 *
 * Serve para impedir reuso: o mesmo código vale por até 90 segundos, e sem
 * registrar a janela consumida um código interceptado pode ser reapresentado
 * dentro dela.
 */
export function totpWindowOf(secret: string, codigo: string, agora = Date.now()): number | null {
  const janelaAtual = Math.floor(agora / 1000 / PASSO_SEGUNDOS);

  for (let deriva = -TOLERANCIA_JANELAS; deriva <= TOLERANCIA_JANELAS; deriva++) {
    if (totpAt(secret, janelaAtual + deriva) === codigo.replace(/\s/g, '')) {
      return janelaAtual + deriva;
    }
  }

  return null;
}

/**
 * URI `otpauth://` para o QR Code.
 *
 * O `issuer` aparece no app do usuário. Ele vai no rótulo E no parâmetro
 * porque os apps discordam sobre qual deles ler.
 */
export function totpUri(params: { secret: string; account: string; issuer: string }): string {
  const rotulo = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_SEGUNDOS),
  });

  return `otpauth://totp/${rotulo}?${query.toString()}`;
}
