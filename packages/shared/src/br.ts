/**
 * Validações brasileiras usadas no cadastro fiscal (seção 7.4) e nos campos
 * CPF/CNPJ do builder (seção 5.1). Validação por algoritmo, não por regex de
 * formato — "111.111.111-11" tem o formato certo e não é um CPF.
 */

export function onlyDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

export function isValidCPF(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number) as number[];

  for (const [length, position] of [
    [9, 9],
    [10, 10],
  ] as const) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += (digits[i] as number) * (length + 1 - i);
    const remainder = (sum * 10) % 11 % 10;
    if (remainder !== digits[position]) return false;
  }
  return true;
}

export function isValidCNPJ(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const digits = cnpj.split('').map(Number) as number[];
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  for (const position of [12, 13] as const) {
    const slice = weights.slice(weights.length - position);
    let sum = 0;
    for (let i = 0; i < position; i++) sum += (digits[i] as number) * (slice[i] as number);
    const remainder = sum % 11;
    const expected = remainder < 2 ? 0 : 11 - remainder;
    if (expected !== digits[position]) return false;
  }
  return true;
}

export type DocumentType = 'cpf' | 'cnpj';

export function detectDocumentType(input: string): DocumentType | null {
  const digits = onlyDigits(input);
  if (digits.length === 11) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  return null;
}

export function isValidDocument(input: string): boolean {
  const type = detectDocumentType(input);
  if (type === 'cpf') return isValidCPF(input);
  if (type === 'cnpj') return isValidCNPJ(input);
  return false;
}

export function formatCPF(input: string): string {
  const d = onlyDigits(input).padStart(11, '0').slice(0, 11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function formatCNPJ(input: string): string {
  const d = onlyDigits(input).padStart(14, '0').slice(0, 14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function formatDocument(input: string): string {
  const type = detectDocumentType(input);
  if (type === 'cpf') return formatCPF(input);
  if (type === 'cnpj') return formatCNPJ(input);
  return input;
}

/** CEP com 8 dígitos. O autopreenchimento em si é feito no frontend. */
export function isValidCEP(input: string): boolean {
  return /^\d{8}$/.test(onlyDigits(input));
}

export function formatCEP(input: string): string {
  const d = onlyDigits(input).slice(0, 8);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : input;
}
