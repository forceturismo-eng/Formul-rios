import { describe, expect, it } from 'vitest';
import {
  applyCalculations,
  evaluateCalculation,
  evaluateCondition,
  evaluateLogic,
  formSchema,
  validateResponse,
  visibleFields,
  type FormDefinition,
} from '@forms/shared';

/**
 * Runtime do formulário.
 *
 * Estes testes importam porque o mesmo código roda no navegador e no servidor.
 * Uma divergência aqui vira "o formulário aceitou na tela e o servidor
 * recusou" — ou, pior, o contrário.
 */

function build(input: unknown): FormDefinition {
  return formSchema.parse(input);
}

const formularioBase = build({
  pages: [
    {
      id: 'p1',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome', required: true },
        { id: 'email', type: 'email', label: 'E-mail', required: true },
        { id: 'documento', type: 'cpf_cnpj', label: 'CPF/CNPJ' },
        { id: 'telefone', type: 'phone_br', label: 'Telefone' },
        { id: 'quantidade', type: 'number', label: 'Quantidade', validation: { min: 1, max: 100 } },
      ],
    },
  ],
});

describe('schema do formulário', () => {
  it('recusa id de campo duplicado', () => {
    const resultado = formSchema.safeParse({
      pages: [
        {
          id: 'p1',
          fields: [
            { id: 'nome', type: 'short_text', label: 'A' },
            { id: 'nome', type: 'short_text', label: 'B' },
          ],
        },
      ],
    });

    // IDs duplicados fariam uma resposta sobrescrever a outra no JSON.
    expect(resultado.success).toBe(false);
    expect(JSON.stringify(resultado)).toContain('Já existe um campo');
  });

  it('recusa campo de seleção sem opções', () => {
    const resultado = formSchema.safeParse({
      pages: [{ id: 'p1', fields: [{ id: 'cor', type: 'dropdown', label: 'Cor' }] }],
    });
    expect(resultado.success).toBe(false);
  });

  it('recusa regra apontando para campo inexistente', () => {
    const resultado = formSchema.safeParse({
      pages: [{ id: 'p1', fields: [{ id: 'nome', type: 'short_text', label: 'Nome' }] }],
      logic: [
        {
          id: 'r1',
          when: { all: [{ field: 'inexistente', operator: 'equals', value: 'x' }] },
          action: 'show',
          target: 'nome',
        },
      ],
    });

    // Lógica morta some em silêncio no renderizador. Melhor recusar na gravação.
    expect(resultado.success).toBe(false);
    expect(JSON.stringify(resultado)).toContain('não existe');
  });

  it('recusa regex inválida', () => {
    const resultado = formSchema.safeParse({
      pages: [{ id: 'p1', fields: [{ id: 'a', type: 'short_text', label: 'A', validation: { pattern: '([' } }] }],
    });
    expect(resultado.success).toBe(false);
  });

  it('recusa propriedade desconhecida', () => {
    const resultado = formSchema.safeParse({
      pages: [{ id: 'p1', fields: [{ id: 'a', type: 'short_text', label: 'A', onClick: 'alert(1)' }] }],
    });
    expect(resultado.success).toBe(false);
  });

  it('aplica os padrões de settings', () => {
    const form = build({ pages: [{ id: 'p1', fields: [] }] });
    expect(form.settings.honeypotEnabled).toBe(true);
    expect(form.settings.submitLabel).toBe('Enviar');
  });
});

describe('condições', () => {
  it('compara igualdade sem se importar com o tipo', () => {
    expect(evaluateCondition('equals', '10', 10)).toBe(true);
    expect(evaluateCondition('equals', 10, '10')).toBe(true);
    expect(evaluateCondition('not_equals', 'a', 'b')).toBe(true);
  });

  it('trata vazio de todas as formas que ele aparece', () => {
    for (const vazio of [undefined, null, '', [], {}]) {
      expect(evaluateCondition('is_empty', vazio as never)).toBe(true);
    }
    expect(evaluateCondition('is_empty', 0)).toBe(false);
    expect(evaluateCondition('is_not_empty', 'x')).toBe(true);
  });

  it('contains funciona em texto e em múltipla escolha', () => {
    expect(evaluateCondition('contains', 'abacaxi', 'baca')).toBe(true);
    expect(evaluateCondition('contains', ['a', 'b'], 'b')).toBe(true);
    expect(evaluateCondition('not_contains', ['a', 'b'], 'c')).toBe(true);
  });

  it('comparação numérica ignora valor não numérico', () => {
    expect(evaluateCondition('greater_than', 10, 5)).toBe(true);
    expect(evaluateCondition('less_than', 3, 5)).toBe(true);
    expect(evaluateCondition('greater_than', 'abc', 5)).toBe(false);
  });
});

describe('lógica condicional', () => {
  const form = build({
    pages: [
      {
        id: 'p1',
        fields: [
          { id: 'tipo', type: 'dropdown', label: 'Tipo', options: [{ value: 'pf', label: 'PF' }, { value: 'pj', label: 'PJ' }] },
          { id: 'cnpj', type: 'cpf_cnpj', label: 'CNPJ' },
          { id: 'observacao', type: 'long_text', label: 'Observação' },
        ],
      },
      { id: 'p2', fields: [{ id: 'final', type: 'short_text', label: 'Final' }] },
    ],
    logic: [
      { id: 'r1', when: { all: [{ field: 'tipo', operator: 'equals', value: 'pf' }] }, action: 'hide', target: 'cnpj' },
      { id: 'r2', when: { all: [{ field: 'tipo', operator: 'equals', value: 'pj' }] }, action: 'require', target: 'observacao' },
      { id: 'r3', when: { all: [{ field: 'tipo', operator: 'equals', value: 'pj' }] }, action: 'skip_to_page', target: 'p2' },
    ],
  });

  it('esconde campo quando a condição bate', () => {
    const resultado = evaluateLogic(form, { tipo: 'pf' });
    expect([...resultado.hiddenFields]).toEqual(['cnpj']);
  });

  it('não esconde nada quando a condição não bate', () => {
    expect(evaluateLogic(form, { tipo: 'pj' }).hiddenFields.size).toBe(0);
  });

  it('torna campo obrigatório e pula de página', () => {
    const resultado = evaluateLogic(form, { tipo: 'pj' });
    expect([...resultado.extraRequiredFields]).toEqual(['observacao']);
    expect(resultado.skipToPage).toBe('p2');
  });

  it('visibleFields reflete o que o respondente enxerga', () => {
    const ids = visibleFields(form, { tipo: 'pf' }).map((f) => f.id);
    expect(ids).not.toContain('cnpj');
    expect(ids).toContain('observacao');
  });
});

describe('cálculos', () => {
  const values = { quantidade: 3, preco: 2500, desconto: 500 };

  it('resolve aritmética com precedência e parênteses', () => {
    expect(evaluateCalculation('2 + 3 * 4', {})).toBe(14);
    expect(evaluateCalculation('(2 + 3) * 4', {})).toBe(20);
    expect(evaluateCalculation('10 / 4', {})).toBe(2.5);
    expect(evaluateCalculation('-5 + 3', {})).toBe(-2);
  });

  it('lê valores de campos pelo id', () => {
    expect(evaluateCalculation('quantidade * preco - desconto', values)).toBe(7000);
  });

  it('campo não respondido vale zero', () => {
    expect(evaluateCalculation('quantidade * inexistente', values)).toBe(0);
    expect(evaluateCalculation('quantidade + inexistente', values)).toBe(3);
  });

  it('divisão por zero devolve zero, não Infinity', () => {
    // "Infinity" numa tela de orçamento é pior que um zero visível.
    expect(evaluateCalculation('10 / 0', {})).toBe(0);
  });

  it('devolve null em expressão inválida em vez de explodir', () => {
    expect(evaluateCalculation('2 +', {})).toBeNull();
    expect(evaluateCalculation('(2 + 3', {})).toBeNull();
    expect(evaluateCalculation('2 3', {})).toBeNull();
  });

  it('recusa qualquer coisa que não seja aritmética', () => {
    // A alternativa a este interpretador seria `eval` sobre uma string vinda
    // do banco, gravada por um usuário. Estes casos são o motivo.
    expect(evaluateCalculation('process.exit(1)', {})).toBeNull();
    expect(evaluateCalculation('require("fs")', {})).toBeNull();
    expect(evaluateCalculation('1; console.log(1)', {})).toBeNull();
    expect(evaluateCalculation('__proto__', {})).toBe(0);
  });

  it('applyCalculations preenche os campos calculados', () => {
    const form = build({
      pages: [
        {
          id: 'p1',
          fields: [
            { id: 'qtd', type: 'number', label: 'Qtd' },
            { id: 'valor', type: 'number', label: 'Valor' },
            { id: 'total', type: 'number', label: 'Total', calculation: 'qtd * valor' },
          ],
        },
      ],
    });

    expect(applyCalculations(form, { qtd: 4, valor: 25 })['total']).toBe(100);
  });
});

describe('validação da resposta', () => {
  it('aceita uma submissão completa e normaliza os valores', () => {
    const resultado = validateResponse(formularioBase, {
      nome: '  Maria Silva  ',
      email: 'MARIA@Exemplo.COM.BR',
      documento: '529.982.247-25',
      telefone: '(11) 98765-4321',
      quantidade: '7',
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.values['nome']).toBe('Maria Silva');
    expect(resultado.values['email']).toBe('maria@exemplo.com.br');
    expect(resultado.values['documento']).toBe('52998224725');
    expect(resultado.values['telefone']).toBe('11987654321');
    expect(resultado.values['quantidade']).toBe(7);
  });

  it('cobra os campos obrigatórios', () => {
    const resultado = validateResponse(formularioBase, { documento: '52998224725' });
    expect(resultado.ok).toBe(false);
    expect(resultado.errors['nome']).toBeDefined();
    expect(resultado.errors['email']).toBeDefined();
  });

  it('recusa CPF com formato certo e dígito errado', () => {
    const resultado = validateResponse(formularioBase, {
      nome: 'X',
      email: 'x@y.com',
      documento: '111.111.111-11',
    });
    expect(resultado.errors['documento']).toBeDefined();
  });

  it('respeita min e max', () => {
    const acima = validateResponse(formularioBase, { nome: 'X', email: 'x@y.com', quantidade: 999 });
    expect(acima.errors['quantidade']).toBeDefined();
  });

  it('usa a mensagem customizada quando existe', () => {
    const form = build({
      pages: [
        {
          id: 'p1',
          fields: [
            {
              id: 'codigo',
              type: 'short_text',
              label: 'Código',
              required: true,
              validation: { pattern: '^[A-Z]{3}-\\d{4}$', message: 'O código tem o formato ABC-1234.' },
            },
          ],
        },
      ],
    });

    const resultado = validateResponse(form, { codigo: 'errado' });
    expect(resultado.errors['codigo']).toEqual(['O código tem o formato ABC-1234.']);
  });

  it('não cobra campo escondido pela lógica', () => {
    const form = build({
      pages: [
        {
          id: 'p1',
          fields: [
            { id: 'tipo', type: 'dropdown', label: 'Tipo', options: [{ value: 'pf', label: 'PF' }] },
            { id: 'cnpj', type: 'cpf_cnpj', label: 'CNPJ', required: true },
          ],
        },
      ],
      logic: [
        { id: 'r1', when: { all: [{ field: 'tipo', operator: 'equals', value: 'pf' }] }, action: 'hide', target: 'cnpj' },
      ],
    });

    // Cobrar obrigatoriedade de um campo que o respondente nunca viu é um beco
    // sem saída na tela.
    const resultado = validateResponse(form, { tipo: 'pf' });
    expect(resultado.ok).toBe(true);
    expect(resultado.values['cnpj']).toBeUndefined();
  });

  it('cobra campo que a lógica tornou obrigatório', () => {
    const form = build({
      pages: [
        {
          id: 'p1',
          fields: [
            { id: 'nota', type: 'nps', label: 'Nota' },
            { id: 'motivo', type: 'long_text', label: 'Motivo' },
          ],
        },
      ],
      logic: [
        { id: 'r1', when: { all: [{ field: 'nota', operator: 'less_than', value: 7 }] }, action: 'require', target: 'motivo' },
      ],
    });

    expect(validateResponse(form, { nota: 9 }).ok).toBe(true);
    expect(validateResponse(form, { nota: 3 }).errors['motivo']).toBeDefined();
  });

  it('recusa opção que não está na lista', () => {
    const form = build({
      pages: [
        {
          id: 'p1',
          fields: [
            {
              id: 'plano',
              type: 'dropdown',
              label: 'Plano',
              required: true,
              options: [{ value: 'a', label: 'A' }],
            },
          ],
        },
      ],
    });

    // O cliente pode mandar qualquer coisa no POST — a lista de opções da tela
    // não é uma garantia.
    expect(validateResponse(form, { plano: 'injetado' }).ok).toBe(false);
  });

  it('guarda moeda em centavos, inteira', () => {
    const form = build({
      pages: [{ id: 'p1', fields: [{ id: 'valor', type: 'currency', label: 'Valor' }] }],
    });

    expect(validateResponse(form, { valor: '199,90' }).values['valor']).toBe(19990);
    expect(validateResponse(form, { valor: 1234.56 }).values['valor']).toBe(123456);
  });

  it('limita NPS ao intervalo', () => {
    const form = build({ pages: [{ id: 'p1', fields: [{ id: 'nps', type: 'nps', label: 'NPS' }] }] });
    expect(validateResponse(form, { nps: 10 }).ok).toBe(true);
    expect(validateResponse(form, { nps: 11 }).ok).toBe(false);
    expect(validateResponse(form, { nps: -1 }).ok).toBe(false);
  });

  it('só aceita UUID em campo de upload', () => {
    const form = build({
      pages: [{ id: 'p1', fields: [{ id: 'anexo', type: 'file_upload', label: 'Anexo' }] }],
    });

    expect(validateResponse(form, { anexo: ['../../etc/passwd'] }).ok).toBe(false);
    expect(validateResponse(form, { anexo: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'] }).ok).toBe(true);
  });

  it('ignora campo que não existe no formulário', () => {
    // Cliente mandando chave extra não contamina a resposta gravada.
    const resultado = validateResponse(formularioBase, {
      nome: 'X',
      email: 'x@y.com',
      is_admin: true,
      organizationId: '22222222-2222-4222-8222-222222222222',
    });

    expect(resultado.values['is_admin']).toBeUndefined();
    expect(resultado.values['organizationId']).toBeUndefined();
  });

  it('campo opcional vazio vira null, não some', () => {
    const resultado = validateResponse(formularioBase, { nome: 'X', email: 'x@y.com' });
    // Registra "perguntado e não respondido" em vez de "nem existia".
    expect(resultado.values['documento']).toBeNull();
  });
});
