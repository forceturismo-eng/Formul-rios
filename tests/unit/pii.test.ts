import { describe, expect, it } from 'vitest';
import { assertRedacted, createRedactor, redactResponse, redactText, type FormDefinition } from '@forms/shared';

/**
 * Redação de PII antes da análise com IA.
 *
 * Estes testes definem o que SAI da nossa infraestrutura. A resposta de um
 * formulário é dado pessoal de alguém que nunca ouviu falar de nós — mandar
 * isso para uma API de terceiro sem redigir seria fazer, em nome do cliente,
 * uma escolha que não é nossa.
 */

const definicao = {
  pages: [
    {
      id: 'p1',
      title: 'Contato',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome completo', required: true },
        { id: 'email', type: 'email', label: 'E-mail', required: true },
        { id: 'documento', type: 'cpf_cnpj', label: 'CPF' },
        { id: 'telefone', type: 'phone_br', label: 'Telefone' },
        { id: 'cep', type: 'cep', label: 'CEP' },
        { id: 'nota', type: 'nps', label: 'De 0 a 10, você indicaria?' },
        { id: 'relato', type: 'long_text', label: 'Conte o que aconteceu' },
        { id: 'produto', type: 'short_text', label: 'Produto' },
      ],
    },
  ],
  logic: [],
  settings: {},
} as unknown as FormDefinition;

describe('padrões brasileiros', () => {
  it('redige CPF com e sem pontuação', () => {
    expect(redactText('meu cpf é 390.533.447-05')).toBe('meu cpf é [CPF_1]');
    expect(redactText('cpf 39053344705 confere?')).toBe('cpf [CPF_1] confere?');
  });

  it('redige CNPJ antes de confundi-lo com CPF', () => {
    // 14 dígitos começam com 11 dígitos que parecem CPF. Se a ordem invertesse,
    // sobraria metade do CNPJ na tela.
    const texto = redactText('CNPJ 12.345.678/0001-95 da empresa');

    expect(texto).toBe('CNPJ [CNPJ_1] da empresa');
    expect(texto).not.toContain('0001');
  });

  it('redige e-mail antes de o CPF dentro dele escapar', () => {
    // `39053344705@exemplo.com.br` tem um CPF no meio. Redigido o e-mail
    // inteiro, não sobra nada.
    const texto = redactText('escreva para 39053344705@exemplo.com.br');

    expect(texto).toBe('escreva para [EMAIL_1]');
    expect(texto).not.toContain('39053344705');
  });

  it('redige telefone com e sem DDD entre parênteses', () => {
    expect(redactText('ligue (11) 98765-4321')).toBe('ligue [TELEFONE_1]');
    expect(redactText('ligue +55 11 98765-4321')).toContain('[TELEFONE_1]');
    expect(redactText('fixo (11) 3456-7890')).toBe('fixo [TELEFONE_1]');
  });

  it('redige CEP com hífen', () => {
    expect(redactText('rua x, 01310-100')).toContain('[CEP_1]');
  });

  it('redige cartão só quando o dígito verificador fecha', () => {
    // Sem o Luhn, todo número de pedido longo sumiria da análise. Os dois
    // primeiros são números de teste públicos das bandeiras.
    expect(redactText('cartão 4111 1111 1111 1111')).toContain('[CARTAO_1]');
    expect(redactText('cartão 5555555555554444')).toContain('[CARTAO_1]');
    expect(redactText('pedido 1234 5678 9012 3456')).toContain('1234 5678 9012 3456');
  });
});

describe('o que NÃO pode sumir', () => {
  it('mantém notas e quantidades', () => {
    // Uma pesquisa em que todo número virou rótulo não tem o que analisar.
    expect(redactText('dei nota 9 e esperei 3 dias')).toBe('dei nota 9 e esperei 3 dias');
    expect(redactText('comprei 2 unidades por 150 reais')).toBe('comprei 2 unidades por 150 reais');
  });

  it('mantém datas e horários', () => {
    expect(redactText('foi em 12/03/2026 às 14:30')).toBe('foi em 12/03/2026 às 14:30');
  });

  it('mantém o texto do relato', () => {
    const relato = 'O atendimento demorou muito e ninguém soube explicar o motivo.';
    expect(redactText(relato)).toBe(relato);
  });

  it('não redige CEP sem hífen', () => {
    // 8 dígitos crus são ambíguos demais; apagar um protocolo por engano custa
    // mais do que deixar passar. O campo do tipo `cep` pega esse caso.
    expect(redactText('protocolo 01310100')).toContain('01310100');
  });
});

describe('pseudônimo estável', () => {
  it('o mesmo valor recebe o mesmo rótulo', () => {
    // É o que permite a IA concluir "a mesma pessoa reclamou duas vezes".
    const redator = createRedactor();
    const primeiro = redator.redact('contato: ana@exemplo.com.br');
    const segundo = redator.redact('de novo ana@exemplo.com.br');

    expect(primeiro).toContain('[EMAIL_1]');
    expect(segundo).toContain('[EMAIL_1]');
  });

  it('ignora formatação ao comparar', () => {
    const redator = createRedactor();
    const a = redator.redact('390.533.447-05');
    const b = redator.redact('39053344705');

    expect(a).toBe(b);
  });

  it('valores diferentes recebem rótulos diferentes', () => {
    const redator = createRedactor();
    const texto = redator.redact('ana@x.com.br e bruno@y.com.br');

    expect(texto).toContain('[EMAIL_1]');
    expect(texto).toContain('[EMAIL_2]');
  });

  it('redatores diferentes não compartilham o mapa', () => {
    // Compartilhar faria `[CPF_1]` significar pessoas diferentes em cada
    // análise — e permitiria correlacionar as duas.
    const a = createRedactor();
    const b = createRedactor();

    a.redact('ana@x.com.br');
    expect(b.redact('bruno@y.com.br')).toContain('[EMAIL_1]');
  });

  it('conta o que redigiu', () => {
    const redator = createRedactor();
    redator.redact('ana@x.com.br, bruno@y.com.br, cpf 390.533.447-05');

    expect(redator.stats()).toMatchObject({ counts: { email: 2, cpf: 1 }, total: 3 });
  });
});

describe('redação por tipo de campo', () => {
  it('redige pelo tipo, mesmo com valor mal formatado', () => {
    // A camada forte: o schema diz que o campo é CPF, e isso basta.
    const { values } = redactResponse(definicao, {
      documento: '390 533 447 05',
      email: 'ana@exemplo.com.br',
      telefone: '11987654321',
      cep: '01310100',
    });

    expect(values['documento']).toBe('[CPF_1]');
    expect(values['email']).toBe('[EMAIL_1]');
    expect(values['telefone']).toBe('[TELEFONE_1]');
    // CEP sem hífen não seria pego por padrão; o tipo do campo pega.
    expect(values['cep']).toBe('[CEP_1]');
  });

  it('redige nome por rótulo', () => {
    const { values } = redactResponse(definicao, { nome: 'Ana Paula Souza' });
    expect(values['nome']).toBe('[NOME_1]');
  });

  it('não redige um texto curto qualquer', () => {
    const { values } = redactResponse(definicao, { produto: 'Plano anual' });
    expect(values['produto']).toBe('Plano anual');
  });

  it('mantém a nota intacta', () => {
    const { values } = redactResponse(definicao, { nota: 9 });
    expect(values['nota']).toBe(9);
  });

  it('aplica os padrões no relato, onde o tipo não ajuda', () => {
    // A rede de segurança: ninguém marcou este campo como PII, e a pessoa
    // digitou o próprio CPF dentro dele.
    const { values } = redactResponse(definicao, {
      relato: 'Meu CPF 390.533.447-05 foi cadastrado errado, me liguem no (11) 98765-4321.',
    });

    const texto = values['relato'] as string;
    expect(texto).not.toContain('390.533.447-05');
    expect(texto).not.toContain('98765-4321');
    // E o conteúdo útil sobrevive.
    expect(texto).toContain('foi cadastrado errado');
  });

  it('campo que o schema não conhece cai nos padrões, nunca passa direto', () => {
    // Campo removido do formulário depois de já ter recebido respostas. Ele
    // não pode virar a fresta por onde o dado escapa.
    const { values } = redactResponse(definicao, { campo_removido: 'ana@exemplo.com.br' });
    expect(values['campo_removido']).toBe('[EMAIL_1]');
  });

  it('redige dentro de listas', () => {
    const { values } = redactResponse(definicao, {
      relato: ['ana@x.com.br', 'sem dado nenhum'],
    });

    expect(values['relato']).toEqual(['[EMAIL_1]', 'sem dado nenhum']);
  });

  it('o mesmo redator atravessa várias respostas da mesma análise', () => {
    const redator = createRedactor();
    const primeira = redactResponse(definicao, { email: 'ana@x.com.br' }, redator);
    const segunda = redactResponse(definicao, { email: 'ana@x.com.br' }, redator);

    expect(primeira.values['email']).toBe(segunda.values['email']);
    expect(redator.stats().total).toBe(1);
  });
});

describe('conferência antes do envio', () => {
  it('passa quando o texto está limpo', () => {
    expect(() => assertRedacted('Nota 9. O atendimento foi bom. [EMAIL_1] reclamou.')).not.toThrow();
  });

  it('trava o envio quando sobrou PII', () => {
    // Defesa em profundidade: se um padrão novo aparecer e a redação falhar, o
    // job para em vez de mandar o dado para fora.
    expect(() => assertRedacted('contato ana@exemplo.com.br')).toThrow(/email/);
    expect(() => assertRedacted('cpf 390.533.447-05')).toThrow(/cpf/);
  });

  it('não fica preso ao estado da regex entre chamadas', () => {
    // `lastIndex` de uma regex global sobrevive entre chamadas. Sem zerar, a
    // segunda conferência pularia o começo do texto.
    for (let i = 0; i < 3; i++) {
      expect(() => assertRedacted('contato ana@exemplo.com.br')).toThrow();
    }
  });

  it('o resultado da redação sempre passa na conferência', () => {
    const entradas = [
      'CPF 390.533.447-05 e e-mail ana@x.com.br',
      'ligue (11) 98765-4321 ou 11 3456-7890',
      'CNPJ 12.345.678/0001-95, CEP 01310-100',
      'cartão 4111 1111 1111 1111',
    ];

    for (const entrada of entradas) {
      expect(() => assertRedacted(redactText(entrada)), entrada).not.toThrow();
    }
  });
});
