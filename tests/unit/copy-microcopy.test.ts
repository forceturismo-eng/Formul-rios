import { describe, expect, it } from 'vitest';
import {
  FORMULARIO_PAUSADO_PUBLICO,
  boletoEmitido,
  boletoVencidoNaTolerancia,
  bufferEncerrado,
  confirmarCancelamento,
  contaSuspensa,
  dominioIndisponivel,
  downgradeBloqueado,
  limiteDeArmazenamento,
  limiteDeFormularios,
  limiteDeIA,
  limiteDeMembros,
  respostasEm80,
  respostasNoLimite,
  trialEncerrado,
  trialTerminando,
  type CopyBlock,
} from '@forms/shared';

/**
 * As diretrizes de microcopy da seção 11, como asserções.
 *
 * Copy é a parte do produto que costuma degradar em silêncio: alguém adiciona
 * uma tela nova, escreve "Clique aqui" e ninguém percebe até um cliente
 * reclamar. Estas regras são objetivas o bastante para virar teste, então
 * viraram.
 */

const RENOVA_EM = new Date('2026-09-12T00:00:00Z');

/** Todos os blocos de copy, para as regras que valem para o conjunto. */
const TODOS: Array<{ nome: string; bloco: CopyBlock }> = [
  { nome: 'respostas em 80%', bloco: respostasEm80({ key: 'responsesPerMonth', used: 4100, limit: 5000, percent: 0.82, daysUntilLimit: 6, renewsAt: RENOVA_EM }) },
  { nome: 'respostas no limite', bloco: respostasNoLimite({ limit: 5000, bufferEndsAt: new Date(Date.now() + 47 * 3600_000) }) },
  { nome: 'buffer encerrado', bloco: bufferEncerrado({ bufferedCount: 214 }) },
  { nome: 'limite de formulários', bloco: limiteDeFormularios({ limit: 15, planCode: 'starter' }) },
  { nome: 'limite de membros', bloco: limiteDeMembros({ limit: 3 }) },
  { nome: 'limite de armazenamento', bloco: limiteDeArmazenamento({ usedMb: 2048, limitMb: 2048 }) },
  { nome: 'limite de IA', bloco: limiteDeIA({ limit: 300, renewsAt: RENOVA_EM }) },
  { nome: 'domínio indisponível', bloco: dominioIndisponivel('Formulários') },
  { nome: 'downgrade bloqueado', bloco: downgradeBloqueado({ targetPlanCode: 'starter', blockers: [{ key: 'forms', label: 'formulários', current: 28, limit: 15, excess: 13, action: 'arquive 13' }] }) },
  { nome: 'trial terminando', bloco: trialTerminando({ daysLeft: 3 }) },
  { nome: 'trial encerrado', bloco: trialEncerrado({ formsCount: 12, responsesCount: 847 }) },
  { nome: 'boleto emitido', bloco: boletoEmitido({ amountCents: 199000, dueDate: RENOVA_EM }) },
  { nome: 'boleto vencido', bloco: boletoVencidoNaTolerancia({ dueDate: RENOVA_EM, graceUntil: new Date('2026-09-17T00:00:00Z') }) },
  { nome: 'conta suspensa', bloco: contaSuspensa() },
  { nome: 'cancelamento', bloco: confirmarCancelamento({ activeUntil: RENOVA_EM }) },
];

describe('diretrizes que valem para toda a copy', () => {
  it.each(TODOS)('$nome não usa ponto de exclamação', ({ bloco }) => {
    // "Nunca usar ponto de exclamação em avisos de limite ou cobrança."
    expect(bloco.title).not.toContain('!');
    expect(bloco.body).not.toContain('!');
    for (const acao of bloco.actions) expect(acao.label).not.toContain('!');
  });

  it.each(TODOS)('$nome usa botões no formato [verbo] + [resultado]', ({ bloco }) => {
    for (const acao of bloco.actions) {
      expect(acao.label.toLowerCase()).not.toBe('clique aqui');
      expect(acao.label.toLowerCase()).not.toBe('enviar');
      expect(acao.label.toLowerCase()).not.toBe('ok');
      // Rótulo curto demais não diz o que acontece ao clicar.
      expect(acao.label.length).toBeGreaterThan(3);
    }
  });

  it.each(TODOS)('$nome não promete apagar dados', ({ bloco }) => {
    // "Nunca dizer que dados foram ou serão apagados quando não forem."
    const texto = `${bloco.title} ${bloco.body}`.toLowerCase();
    for (const proibido of ['apagamos seus dados', 'serão excluídos', 'perderá tudo', 'seus dados serão apagados']) {
      expect(texto, proibido).not.toContain(proibido);
    }
  });

  it.each(TODOS)('$nome tem pelo menos uma ação', ({ bloco }) => {
    expect(bloco.actions.length).toBeGreaterThan(0);
  });
});

describe('toda tela de bloqueio oferece uma saída gratuita', () => {
  // "Todo aviso de bloqueio traz uma alternativa gratuita ao lado da paga.
  //  Nunca só o botão de upgrade."
  const BLOQUEIOS = [
    { nome: 'limite de formulários', bloco: limiteDeFormularios({ limit: 15, planCode: 'starter' }) },
    { nome: 'limite de membros', bloco: limiteDeMembros({ limit: 3 }) },
    { nome: 'limite de armazenamento', bloco: limiteDeArmazenamento({ usedMb: 2048, limitMb: 2048 }) },
    { nome: 'conta suspensa', bloco: contaSuspensa() },
    {
      nome: 'downgrade bloqueado',
      bloco: downgradeBloqueado({
        targetPlanCode: 'starter',
        blockers: [{ key: 'forms', label: 'formulários', current: 28, limit: 15, excess: 13, action: 'arquive 13' }],
      }),
    },
  ];

  it.each(BLOQUEIOS)('$nome oferece alternativa sem custo', ({ bloco }) => {
    expect(bloco.actions.some((a) => a.kind === 'free')).toBe(true);
  });
});

describe('data exata de renovação', () => {
  it('o aviso de 80% diz a data, não "em breve"', () => {
    const bloco = respostasEm80({
      key: 'responsesPerMonth',
      used: 4100,
      limit: 5000,
      percent: 0.82,
      daysUntilLimit: 6,
      renewsAt: RENOVA_EM,
    });

    expect(bloco.body).toContain('12 de setembro');
    expect(bloco.body.toLowerCase()).not.toContain('em breve');
    // E a projeção prometida pela copy.
    expect(bloco.body).toContain('6 dias');
    expect(bloco.body).toContain('4.100');
    expect(bloco.body).toContain('5.000');
  });

  it('o limite de IA diz quando a cota renova', () => {
    expect(limiteDeIA({ limit: 300, renewsAt: RENOVA_EM }).body).toContain('12 de setembro');
  });
});

describe('mensagem ao respondente', () => {
  it('não menciona plano, limite, pagamento nem a plataforma', () => {
    // "Mensagens ao respondente jamais mencionam plano, limite, pagamento ou o
    //  nome da plataforma quando o white-label estiver ativo."
    const texto = FORMULARIO_PAUSADO_PUBLICO.toLowerCase();

    for (const proibido of ['plano', 'limite', 'pagamento', 'assinatura', 'upgrade', 'cota', 'fatura', 'boleto']) {
      expect(texto, `menciona "${proibido}"`).not.toContain(proibido);
    }
    expect(FORMULARIO_PAUSADO_PUBLICO).not.toContain('!');
  });

  it('diz o que fazer, não só o que falhou', () => {
    // "Estados de erro explicam o que fazer, não apenas o que falhou."
    expect(FORMULARIO_PAUSADO_PUBLICO).toContain('procure a equipe responsável');
  });
});

/** O `Intl` usa espaço não-quebrável entre "R$" e o valor. */
const normalizarEspacos = (texto: string): string => texto.replace(/\u00a0/g, ' ');

describe('valores em BRL', () => {
  it('o boleto sai formatado em real', () => {
    const bloco = boletoEmitido({ amountCents: 199000, dueDate: RENOVA_EM });
    expect(normalizarEspacos(bloco.body)).toContain('R$ 1.990,00');
  });

  it('a copy de upgrade cita o preço do Pro', () => {
    const bloco = limiteDeFormularios({ limit: 15, planCode: 'starter' });
    expect(normalizarEspacos(bloco.body)).toContain('R$ 199/mês');
  });
});

describe('conteúdo específico prometido pela seção 11', () => {
  it('buffer encerrado diz que as respostas estão salvas', () => {
    const bloco = bufferEncerrado({ bufferedCount: 214 });

    expect(bloco.body).toContain('214');
    expect(bloco.body).toContain('estão salvas');
  });

  it('boleto vencido tranquiliza quem já pagou', () => {
    // A compensação leva de 1 a 3 dias úteis: quem pagou ontem não pode se
    // assustar com um aviso de inadimplência.
    const bloco = boletoVencidoNaTolerancia({ dueDate: RENOVA_EM, graceUntil: new Date('2026-09-17T00:00:00Z') });

    expect(bloco.body).toContain('já pagou');
    expect(bloco.body).toContain('baixa é automática');
    expect(bloco.body).toContain('17 de setembro');
  });

  it('conta suspensa deixa claro que dá para exportar', () => {
    const bloco = contaSuspensa();

    // "Somente leitura" é o termo que a seção 11 pede no lugar de "bloqueada".
    expect(`${bloco.title} ${bloco.body}`).toContain('somente leitura');
    expect(bloco.body).toContain('exportando');
    expect(bloco.actions.some((a) => a.label.includes('Exportar'))).toBe(true);
  });

  it('armazenamento cheio garante que os arquivos continuam acessíveis', () => {
    expect(limiteDeArmazenamento({ usedMb: 2048, limitMb: 2048 }).body).toContain('continuam intactos e acessíveis');
  });

  it('downgrade lista o que ajustar e garante que nada é apagado', () => {
    const bloco = downgradeBloqueado({
      targetPlanCode: 'starter',
      blockers: [
        { key: 'forms', label: 'formulários', current: 28, limit: 15, excess: 13, action: 'arquive 13' },
        { key: 'members', label: 'membros', current: 6, limit: 3, excess: 3, action: 'remova 3' },
      ],
    });

    expect(bloco.body).toContain('arquive 13');
    expect(bloco.body).toContain('remova 3');
    expect(bloco.body).toContain('Nada é apagado');
  });
});
