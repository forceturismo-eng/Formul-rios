import {
  allFields,
  type ConditionOperator,
  type FormDefinition,
  type FormField,
  type LogicRule,
} from './schemas/form.js';
import { isValidCEP, isValidDocument, onlyDigits } from './br.js';

/**
 * Runtime do formulário: lógica condicional, cálculos e validação da resposta.
 *
 * Roda nos DOIS lados. O renderizador usa para mostrar e esconder campos em
 * tempo real; a API usa para validar a submissão. Ter uma implementação só
 * evita a classe de bug em que o formulário aceita na tela e recusa no
 * servidor — ou, muito pior, o contrário.
 *
 * O que o servidor NÃO delega ao cliente: a decisão final. O front pode
 * esconder um campo obrigatório, mas quem diz se a resposta vale é a chamada a
 * `validateResponse` no backend.
 */

export type ResponseValue = string | number | boolean | string[] | Record<string, string> | null;
export type ResponseValues = Record<string, ResponseValue>;

// -----------------------------------------------------------------------------
// Lógica condicional
// -----------------------------------------------------------------------------

function isEmpty(value: ResponseValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function asComparable(value: ResponseValue | undefined): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function evaluateCondition(
  operator: ConditionOperator,
  actual: ResponseValue | undefined,
  /** Ausente em `is_empty` e `is_not_empty`, que não comparam com nada. */
  expected?: string | number | boolean,
): boolean {
  switch (operator) {
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'equals':
      return String(asComparable(actual) ?? '') === String(expected ?? '');
    case 'not_equals':
      return String(asComparable(actual) ?? '') !== String(expected ?? '');
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(String(expected));
      return String(asComparable(actual) ?? '').includes(String(expected ?? ''));
    case 'not_contains':
      if (Array.isArray(actual)) return !actual.includes(String(expected));
      return !String(asComparable(actual) ?? '').includes(String(expected ?? ''));
    case 'greater_than': {
      const a = Number(asComparable(actual));
      const b = Number(expected);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case 'less_than': {
      const a = Number(asComparable(actual));
      const b = Number(expected);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    default:
      return false;
  }
}

function ruleMatches(rule: LogicRule, values: ResponseValues): boolean {
  const all = rule.when.all ?? [];
  const any = rule.when.any ?? [];

  const todasBatem = all.every((c) => evaluateCondition(c.operator, values[c.field], c.value));
  const algumaBate = any.length === 0 || any.some((c) => evaluateCondition(c.operator, values[c.field], c.value));

  return todasBatem && algumaBate;
}

export interface LogicOutcome {
  hiddenFields: Set<string>;
  extraRequiredFields: Set<string>;
  /** Página para a qual pular, se alguma regra `skip_to_page` disparou. */
  skipToPage: string | null;
}

export function evaluateLogic(form: FormDefinition, values: ResponseValues): LogicOutcome {
  const hiddenFields = new Set<string>();
  const extraRequiredFields = new Set<string>();
  let skipToPage: string | null = null;

  for (const rule of form.logic) {
    if (!ruleMatches(rule, values)) continue;

    switch (rule.action) {
      case 'hide':
        hiddenFields.add(rule.target);
        break;
      case 'show':
        // `show` desfaz um `hide` anterior: a ordem das regras é a ordem em
        // que o cliente as escreveu, e a última que fala vence.
        hiddenFields.delete(rule.target);
        break;
      case 'require':
        extraRequiredFields.add(rule.target);
        break;
      case 'skip_to_page':
        skipToPage = rule.target;
        break;
    }
  }

  return { hiddenFields, extraRequiredFields, skipToPage };
}

/** Campos que o respondente realmente vê, dadas as respostas até agora. */
export function visibleFields(form: FormDefinition, values: ResponseValues): FormField[] {
  const { hiddenFields } = evaluateLogic(form, values);
  return allFields(form).filter((field) => field.type !== 'hidden' && !hiddenFields.has(field.id));
}

// -----------------------------------------------------------------------------
// Cálculos entre campos
// -----------------------------------------------------------------------------

/**
 * Interpretador de expressões aritméticas.
 *
 * Suporta `+ - * / ( )`, números e referências a campos por id.
 *
 * Escrito à mão de propósito. A alternativa óbvia — `eval` ou `new Function` —
 * executaria uma string que veio do banco, gravada por um usuário, dentro do
 * processo da API. Não existe sanitização que torne isso aceitável.
 */
type Token = { kind: 'number'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const char = expression[i] as string;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if ('+-*/()'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let numero = '';
      while (i < expression.length && /[0-9.]/.test(expression[i] as string)) numero += expression[i++];
      const value = Number(numero);
      if (!Number.isFinite(value)) throw new Error(`Número inválido: ${numero}`);
      tokens.push({ kind: 'number', value });
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      let ident = '';
      while (i < expression.length && /[a-zA-Z0-9_]/.test(expression[i] as string)) ident += expression[i++];
      tokens.push({ kind: 'ident', value: ident });
      continue;
    }

    throw new Error(`Caractere não permitido em cálculo: ${char}`);
  }

  return tokens;
}

/** Descida recursiva: expressão -> termo (('+'|'-') termo)*, termo -> fator ... */
function parseExpression(tokens: Token[], values: ResponseValues): number {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  const expr = (): number => {
    let left = term();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.value === '+' || token.value === '-')) {
        position++;
        const right = term();
        left = token.value === '+' ? left + right : left - right;
      } else {
        return left;
      }
    }
  };

  const term = (): number => {
    let left = factor();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && (token.value === '*' || token.value === '/')) {
        position++;
        const right = factor();
        // Divisão por zero devolve 0 em vez de Infinity: um total "Infinity"
        // numa tela de orçamento é pior do que um zero visível.
        left = token.value === '*' ? left * right : right === 0 ? 0 : left / right;
      } else {
        return left;
      }
    }
  };

  const factor = (): number => {
    const token = peek();
    if (!token) throw new Error('Expressão incompleta.');

    if (token.kind === 'op' && token.value === '-') {
      position++;
      return -factor();
    }
    if (token.kind === 'op' && token.value === '+') {
      position++;
      return factor();
    }
    if (token.kind === 'op' && token.value === '(') {
      position++;
      const inner = expr();
      const fechamento = peek();
      if (fechamento?.kind !== 'op' || fechamento.value !== ')') throw new Error('Parêntese não fechado.');
      position++;
      return inner;
    }
    if (token.kind === 'number') {
      position++;
      return token.value;
    }
    if (token.kind === 'ident') {
      position++;
      const raw = values[token.value];
      // Campo ainda não respondido vale zero. É o que o usuário espera de um
      // subtotal enquanto preenche.
      const numero = Number(Array.isArray(raw) ? raw.length : raw);
      return Number.isFinite(numero) ? numero : 0;
    }

    throw new Error('Expressão inválida.');
  };

  const resultado = expr();
  if (position !== tokens.length) throw new Error('Sobrou conteúdo na expressão.');
  return resultado;
}

/** `null` quando a expressão é inválida — cálculo quebrado nunca derruba a submissão. */
export function evaluateCalculation(expression: string, values: ResponseValues): number | null {
  try {
    const resultado = parseExpression(tokenize(expression), values);
    return Number.isFinite(resultado) ? resultado : null;
  } catch {
    return null;
  }
}

export function applyCalculations(form: FormDefinition, values: ResponseValues): ResponseValues {
  const resultado: ResponseValues = { ...values };
  for (const field of allFields(form)) {
    if (!field.calculation) continue;
    const valor = evaluateCalculation(field.calculation, resultado);
    if (valor !== null) resultado[field.id] = valor;
  }
  return resultado;
}

// -----------------------------------------------------------------------------
// Validação da resposta
// -----------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  /** Valores normalizados, prontos para cifrar e gravar. */
  values: ResponseValues;
  /** Erros por id de campo. */
  errors: Record<string, string[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function messageOf(field: FormField, padrao: string): string {
  return field.validation?.message ?? padrao;
}

function validateField(field: FormField, raw: ResponseValue | undefined): { value: ResponseValue; errors: string[] } {
  const errors: string[] = [];
  const v = field.validation;

  const textoBase = (): string => (typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim());

  const checarTexto = (texto: string): void => {
    if (v?.minLength !== undefined && texto.length < v.minLength) {
      errors.push(messageOf(field, `Use pelo menos ${v.minLength} caracteres.`));
    }
    if (v?.maxLength !== undefined && texto.length > v.maxLength) {
      errors.push(messageOf(field, `Use no máximo ${v.maxLength} caracteres.`));
    }
    if (v?.pattern) {
      try {
        if (!new RegExp(v.pattern).test(texto)) errors.push(messageOf(field, 'Esse valor não está no formato esperado.'));
      } catch {
        // Regex inválida foi barrada na gravação do schema. Se chegou aqui, o
        // schema é antigo — ignorar a regra é melhor que recusar a resposta.
      }
    }
  };

  const checarNumero = (numero: number): void => {
    if (v?.min !== undefined && numero < v.min) errors.push(messageOf(field, `O mínimo é ${v.min}.`));
    if (v?.max !== undefined && numero > v.max) errors.push(messageOf(field, `O máximo é ${v.max}.`));
  };

  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'hidden':
    case 'signature': {
      const texto = textoBase();
      checarTexto(texto);
      return { value: texto, errors };
    }

    case 'email': {
      const texto = textoBase().toLowerCase();
      if (!EMAIL_RE.test(texto)) errors.push(messageOf(field, 'Esse e-mail não parece válido.'));
      checarTexto(texto);
      return { value: texto, errors };
    }

    case 'phone_br': {
      const digitos = onlyDigits(textoBase());
      // 10 dígitos (fixo com DDD) ou 11 (celular com DDD).
      if (digitos.length !== 10 && digitos.length !== 11) {
        errors.push(messageOf(field, 'Informe o telefone com DDD.'));
      }
      return { value: digitos, errors };
    }

    case 'cpf_cnpj': {
      const digitos = onlyDigits(textoBase());
      if (!isValidDocument(digitos)) errors.push(messageOf(field, 'Esse CPF ou CNPJ não é válido.'));
      return { value: digitos, errors };
    }

    case 'cep': {
      const digitos = onlyDigits(textoBase());
      if (!isValidCEP(digitos)) errors.push(messageOf(field, 'Informe um CEP com 8 dígitos.'));
      return { value: digitos, errors };
    }

    case 'number':
    case 'currency': {
      const numero = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
      if (!Number.isFinite(numero)) {
        errors.push(messageOf(field, 'Informe um número.'));
        return { value: null, errors };
      }
      checarNumero(numero);
      // Moeda é guardada em centavos, inteira. Nunca float — a razão é a
      // mesma da seção 7.4: um centavo errado é problema, não arredondamento.
      return { value: field.type === 'currency' ? Math.round(numero * 100) : numero, errors };
    }

    case 'date': {
      const texto = textoBase();
      if (!ISO_DATE_RE.test(texto) || Number.isNaN(Date.parse(texto))) {
        errors.push(messageOf(field, 'Informe uma data válida.'));
      }
      return { value: texto, errors };
    }

    case 'time': {
      const texto = textoBase();
      if (!ISO_TIME_RE.test(texto)) errors.push(messageOf(field, 'Informe um horário válido.'));
      return { value: texto, errors };
    }

    case 'datetime': {
      const texto = textoBase();
      if (Number.isNaN(Date.parse(texto))) errors.push(messageOf(field, 'Informe uma data e hora válidas.'));
      return { value: texto, errors };
    }

    case 'single_select':
    case 'dropdown': {
      const texto = textoBase();
      const permitidos = new Set((field.options ?? []).map((o) => o.value));
      if (!permitidos.has(texto)) errors.push(messageOf(field, 'Escolha uma das opções disponíveis.'));
      return { value: texto, errors };
    }

    case 'multi_select': {
      const lista = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
      const permitidos = new Set((field.options ?? []).map((o) => o.value));
      const invalidos = lista.filter((item) => !permitidos.has(item));
      if (invalidos.length > 0) errors.push(messageOf(field, 'Uma das opções escolhidas não existe.'));
      return { value: lista, errors };
    }

    case 'scale':
    case 'nps': {
      const numero = Number(raw);
      const min = field.scaleMin ?? (field.type === 'nps' ? 0 : 1);
      const max = field.scaleMax ?? (field.type === 'nps' ? 10 : 5);
      if (!Number.isInteger(numero) || numero < min || numero > max) {
        errors.push(messageOf(field, `Escolha um valor entre ${min} e ${max}.`));
        return { value: null, errors };
      }
      return { value: numero, errors };
    }

    case 'file_upload': {
      // A resposta carrega os IDs dos arquivos já enviados. O upload em si
      // acontece antes, num endpoint próprio, e é lá que MIME e tamanho são
      // conferidos.
      const lista = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
      if (lista.some((id) => !UUID_RE.test(id))) {
        errors.push(messageOf(field, 'Um dos arquivos enviados não foi reconhecido.'));
      }
      if (v?.maxFiles !== undefined && lista.length > v.maxFiles) {
        errors.push(messageOf(field, `Envie no máximo ${v.maxFiles} arquivo(s).`));
      }
      return { value: lista, errors };
    }

    case 'address': {
      const objeto = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
      const normalizado: Record<string, string> = {};
      for (const chave of ['zip', 'street', 'number', 'complement', 'district', 'city', 'state'] as const) {
        const valor = objeto[chave];
        if (typeof valor === 'string') normalizado[chave] = valor.trim().slice(0, 200);
      }
      if (normalizado['zip'] && !isValidCEP(normalizado['zip'])) {
        errors.push(messageOf(field, 'Informe um CEP com 8 dígitos.'));
      }
      return { value: normalizado, errors };
    }

    case 'matrix': {
      const objeto = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
      const linhas = new Set((field.rows ?? []).map((r) => r.value));
      const colunas = new Set((field.columns ?? []).map((c) => c.value));
      const normalizado: Record<string, string> = {};

      for (const [linha, coluna] of Object.entries(objeto)) {
        if (!linhas.has(linha) || !colunas.has(String(coluna))) {
          errors.push(messageOf(field, 'Uma das respostas da matriz não existe.'));
          break;
        }
        normalizado[linha] = String(coluna);
      }
      return { value: normalizado, errors };
    }

    case 'payment': {
      // Campo de pagamento entra na Fase 3, junto com o gateway. Por ora o
      // valor trafega como metadado e não é cobrado.
      return { value: raw ?? null, errors };
    }

    default:
      return { value: raw ?? null, errors };
  }
}

/**
 * Valida a submissão inteira.
 *
 * Campos escondidos pela lógica condicional não são validados nem exigidos —
 * cobrar obrigatoriedade de um campo que o respondente nunca viu é um beco sem
 * saída na tela.
 */
export function validateResponse(form: FormDefinition, raw: ResponseValues): ValidationResult {
  const comCalculos = applyCalculations(form, raw);
  const { hiddenFields, extraRequiredFields } = evaluateLogic(form, comCalculos);

  const values: ResponseValues = {};
  const errors: Record<string, string[]> = {};

  for (const field of allFields(form)) {
    if (hiddenFields.has(field.id)) continue;

    const bruto = comCalculos[field.id] ?? field.defaultValue ?? undefined;
    const obrigatorio = field.required || extraRequiredFields.has(field.id);

    if (isEmpty(bruto as ResponseValue)) {
      if (obrigatorio) errors[field.id] = [messageOf(field, 'Este campo é obrigatório.')];
      // Campo vazio e opcional entra como null, para que a resposta registre
      // "perguntado e não respondido" em vez de "nem existia".
      values[field.id] = null;
      continue;
    }

    const { value, errors: erros } = validateField(field, bruto as ResponseValue);
    values[field.id] = value;
    if (erros.length > 0) errors[field.id] = erros;
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}
