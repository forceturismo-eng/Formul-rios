import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  totpAt,
  totpUri,
  totpWindowOf,
  verifyTotp,
} from '../../apps/api/src/auth/totp.js';

/**
 * TOTP do admin da plataforma.
 *
 * O admin é a conta que enxerga todos os clientes, e o segundo fator é o que
 * separa "senha vazada" de "incidente com todos os dados de todos".
 *
 * Os vetores abaixo são do RFC 6238. Eles são o que prova que a implementação
 * é compatível com Google Authenticator e afins — um TOTP que só conversa com
 * ele mesmo passaria em qualquer teste caseiro e falharia no celular do
 * usuário.
 */

/** O segredo do RFC 6238 é a string ASCII "12345678901234567890". */
const SEGREDO_RFC = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('vetores do RFC 6238', () => {
  it('bate com os códigos publicados', () => {
    // Cada par é [timestamp em segundos, código esperado com SHA-1].
    const vetores: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];

    for (const [segundos, esperado] of vetores) {
      expect(generateTotp(SEGREDO_RFC, segundos * 1000), `t=${segundos}`).toBe(esperado);
    }
  });
});

describe('base32', () => {
  it('vai e volta', () => {
    for (const texto of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      const bytes = Buffer.from(texto, 'ascii');
      expect(base32Decode(base32Encode(bytes)).toString('ascii'), texto).toBe(texto);
    }
  });

  it('aceita o segredo como o app mostra', () => {
    // Apps exibem em grupos separados por espaço, e as pessoas copiam com eles.
    const original = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    const comoExibido = original.match(/.{1,4}/g)!.join(' ').toLowerCase();

    expect(base32Decode(comoExibido).equals(base32Decode(original))).toBe(true);
  });

  it('recusa caractere fora do alfabeto', () => {
    // `0`, `1`, `8` e `9` não existem no base32 do RFC 4648.
    expect(() => base32Decode('ABC018')).toThrow();
  });
});

describe('verificação', () => {
  const segredo = generateTotpSecret();

  it('aceita o código do momento', () => {
    expect(verifyTotp(segredo, generateTotp(segredo))).toBe(true);
  });

  it('aceita uma janela de deriva para cada lado', () => {
    // Relógio de celular fora de sincronia é a causa número um de "o código
    // não funciona", e 30 segundos de folga resolvem quase todos os casos.
    const agora = Date.now();
    const janela = Math.floor(agora / 1000 / 30);

    expect(verifyTotp(segredo, totpAt(segredo, janela - 1), agora)).toBe(true);
    expect(verifyTotp(segredo, totpAt(segredo, janela + 1), agora)).toBe(true);
  });

  it('recusa além da tolerância', () => {
    const agora = Date.now();
    const janela = Math.floor(agora / 1000 / 30);

    expect(verifyTotp(segredo, totpAt(segredo, janela - 2), agora)).toBe(false);
    expect(verifyTotp(segredo, totpAt(segredo, janela + 2), agora)).toBe(false);
  });

  it('recusa código de outro segredo', () => {
    const outro = generateTotpSecret();
    expect(verifyTotp(segredo, generateTotp(outro))).toBe(false);
  });

  it('recusa entrada malformada sem explodir', () => {
    for (const entrada of ['', '12345', '1234567', 'abcdef', '12 34 56 78', '000000000000']) {
      expect(verifyTotp(segredo, entrada), entrada).toBe(false);
    }
  });

  it('ignora espaço no que a pessoa digitou', () => {
    const codigo = generateTotp(segredo);
    expect(verifyTotp(segredo, `${codigo.slice(0, 3)} ${codigo.slice(3)}`)).toBe(true);
  });
});

describe('janela consumida', () => {
  it('devolve a janela do código, para bloquear reuso', () => {
    // O mesmo código vale por até 90 segundos. Sem registrar a janela já usada,
    // um código interceptado pode ser reapresentado dentro dela.
    const segredo = generateTotpSecret();
    const agora = Date.now();
    const janela = Math.floor(agora / 1000 / 30);

    expect(totpWindowOf(segredo, totpAt(segredo, janela), agora)).toBe(janela);
    expect(totpWindowOf(segredo, totpAt(segredo, janela - 1), agora)).toBe(janela - 1);
  });

  it('devolve null para código que não confere', () => {
    expect(totpWindowOf(generateTotpSecret(), '000000', Date.now())).toBeNull();
  });

  it('não quebra com relógio perto da época', () => {
    // A janela zero menos a tolerância dá contador negativo, e um inteiro sem
    // sinal de 64 bits não aceita isso. Recusar é o comportamento certo;
    // lançar derrubaria a verificação inteira.
    const segredo = generateTotpSecret();

    expect(() => verifyTotp(segredo, '000000', 0)).not.toThrow();
    expect(() => totpWindowOf(segredo, '000000', 0)).not.toThrow();
  });
});

describe('segredo e QR Code', () => {
  it('gera 160 bits', () => {
    // O tamanho recomendado pelo RFC 4226.
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('gera segredos diferentes', () => {
    const gerados = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(gerados.size).toBe(50);
  });

  it('monta a URI que o app lê', () => {
    const uri = totpUri({ secret: 'ABCDEFGH', account: 'admin@exemplo.com.br', issuer: 'Formulários' });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=ABCDEFGH');
    // O issuer vai no rótulo E no parâmetro: os apps discordam sobre qual ler.
    expect(uri).toContain(encodeURIComponent('Formulários:admin@exemplo.com.br'));
    expect(uri).toContain('issuer=Formul');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
