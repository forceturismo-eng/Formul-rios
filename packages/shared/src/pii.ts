import type { FieldType, FormDefinition } from './schemas/form.js';

/**
 * Redação de dados pessoais antes da análise com IA (seção 5.3).
 *
 * Este arquivo decide o que SAI da nossa infraestrutura. A resposta de um
 * formulário é dado pessoal do cliente do nosso cliente — alguém que nunca
 * ouviu falar de nós e não consentiu com nada. Mandar isso para uma API de
 * terceiro sem redigir seria fazer, em nome do cliente, uma escolha que não é
 * nossa.
 *
 * ## Duas camadas, e a ordem importa
 *
 * **Por tipo de campo.** É a camada forte: sabemos que `cpf_cnpj` contém CPF
 * porque o próprio schema diz. Não depende de o valor estar bem formatado.
 *
 * **Por padrão no texto.** É a rede de segurança: alguém digita o próprio CPF
 * dentro da caixa "Conte o que aconteceu", e nenhum tipo de campo avisa.
 *
 * ## Pseudônimo estável, não asterisco
 *
 * `[CPF_1]` e não `***`. O mesmo valor recebe o mesmo rótulo dentro de uma
 * análise, então a IA ainda consegue dizer "a mesma pessoa reclamou duas
 * vezes" — que é justamente o tipo de conclusão pela qual o cliente paga. Com
 * asterisco, todo mundo vira a mesma pessoa e a análise perde sentido.
 *
 * O mapa de pseudônimos vive na memória do job e morre com ele. Ele nunca é
 * gravado: guardá-lo seria reconstruir exatamente o que a redação desfez.
 */

export type PiiKind = 'email' | 'cartao' | 'cnpj' | 'cpf' | 'telefone' | 'cep' | 'nome' | 'endereco';

/**
 * Ordem de aplicação. NÃO reordene sem pensar:
 *
 *  - e-mail antes de tudo: `12345678901@exemplo.com.br` tem um CPF dentro;
 *  - cartão antes de CNPJ e CPF: 16 dígitos contêm sequências de 11 e 14;
 *  - CNPJ antes de CPF: 14 dígitos começam com 11 dígitos válidos;
 *  - CEP por último: 8 dígitos são o padrão mais frouxo da lista.
 */
const PADROES: Array<{ kind: PiiKind; regex: RegExp; confirma?: (valor: string) => boolean }> = [
  {
    kind: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    kind: 'cartao',
    // 13 a 19 dígitos com separador opcional. Só vira redação se passar no
    // dígito verificador: sem isso, qualquer número de pedido longo sumiria.
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    confirma: passaNoLuhn,
  },
  {
    kind: 'cnpj',
    regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
  },
  {
    kind: 'cpf',
    regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  },
  {
    kind: 'telefone',
    // Com DDD, fixo ou celular, com ou sem +55. Exige separador ou parênteses
    // em algum lugar — 11 dígitos crus já foram tratados como CPF acima.
    regex: /(?:\+55[\s-]?)?(?:\(\d{2}\)|\b\d{2})[\s-]?9?\d{4}[\s-]?\d{4}\b/g,
    confirma: (valor) => contarDigitos(valor) >= 10 && contarDigitos(valor) <= 13,
  },
  {
    kind: 'cep',
    // Só com hífen. `\d{8}` cru é ambíguo demais — em pesquisa de satisfação,
    // apagar um número de protocolo por engano é pior do que deixá-lo passar,
    // e o CEP sem hífen ainda é pego pela camada de tipo de campo.
    regex: /\b\d{5}-\d{3}\b/g,
  },
];

/** Tipos de campo cujo valor é dado pessoal por definição. */
const TIPO_PARA_PII: Partial<Record<FieldType, PiiKind>> = {
  email: 'email',
  phone_br: 'telefone',
  cpf_cnpj: 'cpf',
  cep: 'cep',
  address: 'endereco',
  // Assinatura é imagem de assinatura — identificação direta, e nada que uma
  // análise de sentimento precise ver.
  signature: 'nome',
};

/**
 * Rótulos que denunciam um campo de nome.
 *
 * Heurística de rótulo, e ela erra nos dois sentidos: "Nome do produto" some
 * sem precisar, e um campo chamado "Como podemos te chamar" passa. O erro que
 * escolhemos é o primeiro — perder um dado da análise custa menos do que
 * vazá-lo.
 */
const ROTULOS_DE_NOME = /\b(nome|sobrenome|nome completo|respons[aá]vel|contato|solicitante)\b/i;

export interface RedactionStats {
  /** Quantas ocorrências de cada tipo saíram do texto. */
  counts: Partial<Record<PiiKind, number>>;
  total: number;
}

export interface Redactor {
  redact(texto: string): string;
  redactValue(valor: unknown, kind?: PiiKind): unknown;
  stats(): RedactionStats;
}

/**
 * Cria um redator com mapa de pseudônimos próprio.
 *
 * Um por análise. Compartilhar o mapa entre análises de organizações
 * diferentes faria `[CPF_1]` significar pessoas diferentes em cada uma — e,
 * pior, permitiria correlacionar as duas.
 */
export function createRedactor(): Redactor {
  const pseudonimos = new Map<string, string>();
  const contadores = new Map<PiiKind, number>();

  function pseudonimoDe(kind: PiiKind, valor: string): string {
    const chave = `${kind}:${valor.replace(/[\s.\-/()]/g, '').toLowerCase()}`;
    const existente = pseudonimos.get(chave);
    if (existente) return existente;

    const proximo = (contadores.get(kind) ?? 0) + 1;
    contadores.set(kind, proximo);

    const rotulo = `[${kind.toUpperCase()}_${proximo}]`;
    pseudonimos.set(chave, rotulo);
    return rotulo;
  }

  function redact(texto: string): string {
    let resultado = texto;

    for (const padrao of PADROES) {
      resultado = resultado.replace(padrao.regex, (achado) => {
        if (padrao.confirma && !padrao.confirma(achado)) return achado;
        return pseudonimoDe(padrao.kind, achado);
      });
    }

    return resultado;
  }

  function redactValue(valor: unknown, kind?: PiiKind): unknown {
    if (valor === null || valor === undefined) return valor;

    if (Array.isArray(valor)) return valor.map((item) => redactValue(item, kind));

    if (typeof valor === 'string') {
      // Campo de tipo conhecido: o valor inteiro é PII, formatado ou não.
      if (kind) return valor.trim() === '' ? valor : pseudonimoDe(kind, valor);
      return redact(valor);
    }

    // Número e booleano não carregam PII sozinhos — e uma nota de 0 a 10 é
    // exatamente o que a análise precisa enxergar.
    return valor;
  }

  function stats(): RedactionStats {
    const counts: Partial<Record<PiiKind, number>> = {};
    let total = 0;

    for (const [kind, quantidade] of contadores) {
      counts[kind] = quantidade;
      total += quantidade;
    }

    return { counts, total };
  }

  return { redact, redactValue, stats };
}

/** Atalho para um texto solto, quando não há campo por trás. */
export function redactText(texto: string): string {
  return createRedactor().redact(texto);
}

export interface RedactedResponse {
  values: Record<string, unknown>;
  stats: RedactionStats;
}

/**
 * Redige uma resposta inteira usando o schema do formulário.
 *
 * Campo que o schema não conhece cai na camada de padrões — nunca passa direto.
 * É o caso de um campo removido do formulário depois de já ter recebido
 * respostas, e ele não pode virar a fresta por onde o dado escapa.
 */
export function redactResponse(
  definition: FormDefinition,
  values: Record<string, unknown>,
  redator: Redactor = createRedactor(),
): RedactedResponse {
  const porId = new Map<string, { type: FieldType; label: string }>();

  for (const pagina of definition.pages) {
    for (const campo of pagina.fields) {
      porId.set(campo.id, { type: campo.type, label: campo.label });
    }
  }

  const saida: Record<string, unknown> = {};

  for (const [id, valor] of Object.entries(values)) {
    const campo = porId.get(id);
    saida[id] = redator.redactValue(valor, campo ? kindDoCampo(campo) : undefined);
  }

  return { values: saida, stats: redator.stats() };
}

function kindDoCampo(campo: { type: FieldType; label: string }): PiiKind | undefined {
  const porTipo = TIPO_PARA_PII[campo.type];
  if (porTipo) return porTipo;

  // Texto curto com rótulo de nome. Só `short_text`: um `long_text` chamado
  // "Nome" quase sempre é relato, e apagar o relato inteiro esvaziaria a
  // análise — nele, a camada de padrões faz o trabalho.
  if (campo.type === 'short_text' && ROTULOS_DE_NOME.test(campo.label)) return 'nome';

  return undefined;
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function contarDigitos(valor: string): number {
  let total = 0;
  for (const caractere of valor) {
    if (caractere >= '0' && caractere <= '9') total += 1;
  }
  return total;
}

/** Dígito verificador de cartão. Evita apagar número de pedido longo. */
function passaNoLuhn(valor: string): boolean {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length < 13 || digitos.length > 19) return false;

  let soma = 0;
  let dobra = false;

  for (let i = digitos.length - 1; i >= 0; i--) {
    let digito = digitos.charCodeAt(i) - 48;

    if (dobra) {
      digito *= 2;
      if (digito > 9) digito -= 9;
    }

    soma += digito;
    dobra = !dobra;
  }

  return soma % 10 === 0;
}

/**
 * Confere que nada óbvio escapou.
 *
 * Roda depois da redação, imediatamente antes do envio. É defesa em
 * profundidade: se um padrão novo aparecer e a redação falhar, o job para em
 * vez de mandar o dado para fora.
 */
export function assertRedacted(texto: string): void {
  const sobras: string[] = [];

  for (const padrao of PADROES) {
    // `matchAll` com regex global precisa do índice zerado: a mesma instância
    // é reusada entre chamadas e `lastIndex` sobrevive.
    padrao.regex.lastIndex = 0;

    for (const achado of texto.matchAll(padrao.regex)) {
      const valor = achado[0];
      if (padrao.confirma && !padrao.confirma(valor)) continue;
      sobras.push(padrao.kind);
      break;
    }
  }

  if (sobras.length > 0) {
    throw new Error(`Redação incompleta: ainda há ${[...new Set(sobras)].join(', ')} no texto.`);
  }
}
