/**
 * Verificação contra senhas vazadas (seção 9).
 *
 * A lista embutida cobre o que aparece no topo de todo vazamento e o que é
 * previsível para um produto brasileiro. Não substitui uma base completa: a
 * interface `LeakedPasswordChecker` existe para plugar uma consulta k-anonymity
 * ao Have I Been Pwned sem tocar em quem chama.
 *
 * A checagem local roda primeiro de propósito — ela não depende de rede, então
 * uma indisponibilidade externa nunca deixa passar as senhas óbvias.
 */

export interface LeakedPasswordChecker {
  isLeaked(plain: string): Promise<boolean>;
}

const COMMON_PASSWORDS = new Set([
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'senha123',
  'senha1234',
  'password',
  'password1',
  'password123',
  'qwerty123',
  'qwertyuiop',
  'admin123',
  'administrador',
  'brasil123',
  'brasil2024',
  'brasil2025',
  'flamengo1',
  'corinthians',
  'palmeiras1',
  'saopaulo1',
  'iloveyou1',
  'abc123456',
  'letmein123',
  'welcome123',
  'mudar123',
  'mudar@123',
  'trocar123',
  'teste1234',
  'usuario123',
  'empresa123',
  'formulario123',
]);

/**
 * Raízes que, seguidas só de dígitos, produzem as senhas mais comuns que
 * existem: "senha123456", "password2025", "admin1234", "empresa2026".
 *
 * A política de comprimento sozinha deixa todas essas passarem — 11 caracteres
 * de "senha123456" atendem o mínimo e são a primeira coisa que um atacante
 * tenta.
 */
const COMMON_ROOTS = [
  'senha',
  'password',
  'passwd',
  'admin',
  'administrador',
  'root',
  'teste',
  'test',
  'usuario',
  'user',
  'empresa',
  'brasil',
  'mudar',
  'trocar',
  'qwerty',
  'abcdef',
  'abc',
  'letmein',
  'welcome',
  'iloveyou',
  'formulario',
  'formularios',
];

/** Sequências e repetições: "aaaaaaaaaa", "abcdefghij", "1111111111". */
function isLowEntropyPattern(plain: string): boolean {
  const lower = plain.toLowerCase();
  if (/^(.)\1+$/.test(lower)) return true;

  const isRun = (step: number): boolean => {
    for (let i = 1; i < lower.length; i++) {
      if (lower.charCodeAt(i) - lower.charCodeAt(i - 1) !== step) return false;
    }
    return true;
  };
  return isRun(1) || isRun(-1);
}

/** "senha" + qualquer coisa numérica, com ou sem separador simples. */
function isCommonRootWithDigits(plain: string): boolean {
  const normalized = plain.toLowerCase().replace(/[\s._@#!-]/g, '');
  const match = /^([a-z]+)(\d+)$/.exec(normalized);
  if (!match) return false;

  const [, root] = match;
  return COMMON_ROOTS.includes(root as string);
}

export const localLeakedPasswordChecker: LeakedPasswordChecker = {
  async isLeaked(plain: string): Promise<boolean> {
    const lower = plain.toLowerCase();
    if (COMMON_PASSWORDS.has(lower)) return true;
    if (isLowEntropyPattern(plain)) return true;
    if (isCommonRootWithDigits(plain)) return true;
    return false;
  },
};

/** Trocado nos testes e, mais adiante, por uma implementação com HIBP. */
let checker: LeakedPasswordChecker = localLeakedPasswordChecker;

export function setLeakedPasswordChecker(next: LeakedPasswordChecker): void {
  checker = next;
}

export function isLeakedPassword(plain: string): Promise<boolean> {
  return checker.isLeaked(plain);
}
