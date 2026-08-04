import { formatBRL, formatBRLCompact } from '../money.js';
import { getPlan, type PlanCode } from '../plans.js';
import type { DowngradeBlocker, UsageWarning } from '../quotas.js';

/**
 * Copy das telas de limite e cobrança (seção 11 do documento de produto).
 *
 * Está aqui, e não espalhada pelos componentes, por dois motivos. Primeiro,
 * frontend e e-mail precisam dizer a mesma coisa. Segundo, as diretrizes de
 * microcopy da seção 11 são verificáveis — e há um teste que as verifica:
 *
 *   - Nunca usar ponto de exclamação em aviso de limite ou cobrança.
 *   - Todo bloqueio traz uma alternativa GRATUITA ao lado da paga.
 *   - Sempre a data exata de renovação, nunca "em breve".
 *   - Nunca dizer que dados foram apagados quando não foram.
 *   - Mensagem ao respondente jamais menciona plano, limite ou pagamento.
 *   - Botão é [verbo] + [resultado], nunca "Clique aqui".
 */

export interface CopyAction {
  label: string;
  href: string;
  /** `free` é a saída que não custa nada. Toda tela de bloqueio precisa de uma. */
  kind: 'primary' | 'free';
}

export interface CopyBlock {
  tone: 'info' | 'warning' | 'danger';
  title: string;
  body: string;
  actions: CopyAction[];
}

const DATA_LONGA = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });
const DATA_CURTA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function formatarData(data: Date): string {
  return DATA_LONGA.format(data);
}

export function formatarDataCurta(data: Date): string {
  return DATA_CURTA.format(data);
}

const numero = new Intl.NumberFormat('pt-BR');

// -----------------------------------------------------------------------------
// Respostas
// -----------------------------------------------------------------------------

/** 80% da cota. Amarelo, para owner e admins. */
export function respostasEm80(aviso: UsageWarning): CopyBlock {
  const projecao =
    aviso.daysUntilLimit === null
      ? ''
      : ` No ritmo atual, o limite chega em cerca de ${aviso.daysUntilLimit} ${
          aviso.daysUntilLimit === 1 ? 'dia' : 'dias'
        }.`;

  return {
    tone: 'warning',
    title: 'Você está perto do limite de respostas',
    body:
      `Você já usou ${numero.format(aviso.used)} das ${numero.format(aviso.limit)} respostas deste mês.` +
      `${projecao} A cota renova em ${formatarData(aviso.renewsAt)}.`,
    actions: [
      { label: 'Ver planos', href: '/planos', kind: 'primary' },
      { label: `Comprar +5.000 respostas por ${formatBRLCompact(19900)}`, href: '/planos/adicionais', kind: 'primary' },
    ],
  };
}

/** No limite, dentro das 48h de cortesia. Vermelho. */
export function respostasNoLimite(params: { limit: number; bufferEndsAt: Date; now?: Date }): CopyBlock {
  const agora = params.now ?? new Date();
  const horas = Math.max(0, Math.round((params.bufferEndsAt.getTime() - agora.getTime()) / (60 * 60 * 1000)));

  return {
    tone: 'danger',
    title: 'Você chegou ao limite de respostas',
    body:
      `Você chegou ao limite de ${numero.format(params.limit)} respostas. Continuamos recebendo tudo normalmente ` +
      `por mais ${horas} ${horas === 1 ? 'hora' : 'horas'} para você não perder nada. ` +
      'Depois disso, seus formulários param de aceitar novas respostas.',
    actions: [
      { label: 'Fazer upgrade agora', href: '/planos', kind: 'primary' },
      { label: 'Comprar pacote avulso', href: '/planos/adicionais', kind: 'primary' },
    ],
  };
}

/** Cortesia encerrada. As respostas do buffer continuam salvas e visíveis. */
export function bufferEncerrado(params: { bufferedCount: number }): CopyBlock {
  return {
    tone: 'danger',
    title: 'Seus formulários pararam de receber respostas',
    body:
      `As ${numero.format(params.bufferedCount)} respostas recebidas durante o período de cortesia estão salvas ` +
      'e visíveis abaixo. Para voltar a receber, faça upgrade ou compre um pacote avulso.',
    actions: [{ label: 'Reativar meus formulários', href: '/planos', kind: 'primary' }],
  };
}

/**
 * O que o RESPONDENTE vê quando o formulário está pausado.
 *
 * Sem marca, sem plano, sem pagamento, sem o nome da plataforma. Inadimplência
 * é assunto entre nós e o cliente — o público dele não tem nada com isso.
 */
export const FORMULARIO_PAUSADO_PUBLICO =
  'Este formulário não está recebendo respostas no momento. ' +
  'Se você precisa entrar em contato, procure a equipe responsável diretamente.';

// -----------------------------------------------------------------------------
// Limites de contagem
// -----------------------------------------------------------------------------

export function limiteDeFormularios(params: { limit: number; planCode: string }): CopyBlock {
  const plano = getPlan(params.planCode as PlanCode);
  const pro = getPlan('pro');

  return {
    tone: 'warning',
    title: 'Você usou todos os formulários do seu plano',
    body:
      `Você usou seus ${numero.format(params.limit)} formulários do plano ${plano.name}. ` +
      `No ${pro.name} você tem ${numero.format(pro.limits.forms)} formulários e domínio próprio, ` +
      `por ${formatBRLCompact(pro.priceMonthlyCents ?? 0)}/mês.`,
    actions: [
      { label: `Ver o que muda no ${pro.name}`, href: '/planos', kind: 'primary' },
      // A alternativa que não custa nada.
      { label: 'Arquivar um formulário', href: '/formularios', kind: 'free' },
    ],
  };
}

export function limiteDeMembros(params: { limit: number }): CopyBlock {
  const pro = getPlan('pro');

  return {
    tone: 'warning',
    title: 'Todos os lugares da sua equipe estão ocupados',
    body:
      `Seu plano permite ${params.limit} ${params.limit === 1 ? 'membro' : 'membros'} e todos os lugares estão ` +
      `ocupados. Adicione um membro extra por ${formatBRLCompact(2900)}/mês ou vá para o ${pro.name}, ` +
      `que inclui ${pro.limits.members} lugares.`,
    actions: [
      { label: 'Adicionar 1 membro', href: '/planos/adicionais', kind: 'primary' },
      { label: 'Remover um membro', href: '/equipe', kind: 'free' },
    ],
  };
}

export function limiteDeArmazenamento(params: { usedMb: number; limitMb: number }): CopyBlock {
  const emGb = (mb: number): string => (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1);

  return {
    tone: 'warning',
    title: 'Seu armazenamento está cheio',
    body:
      `Você usou ${emGb(params.usedMb)} GB de ${emGb(params.limitMb)} GB. Novos envios de arquivo estão ` +
      'bloqueados até você liberar espaço. Seus arquivos atuais continuam intactos e acessíveis.',
    actions: [
      { label: `Adicionar 10 GB por ${formatBRLCompact(3900)}/mês`, href: '/planos/adicionais', kind: 'primary' },
      { label: 'Liberar espaço', href: '/arquivos', kind: 'free' },
    ],
  };
}

export function limiteDeIA(params: { limit: number; renewsAt: Date }): CopyBlock {
  return {
    tone: 'info',
    title: 'Você usou suas análises deste mês',
    body:
      `Você usou suas ${numero.format(params.limit)} análises deste mês. As análises já geradas continuam ` +
      `disponíveis. A cota renova em ${formatarData(params.renewsAt)}.`,
    actions: [
      { label: `Comprar +500 análises por ${formatBRLCompact(9900)}`, href: '/planos/adicionais', kind: 'primary' },
      { label: 'Ver planos', href: '/planos', kind: 'primary' },
    ],
  };
}

export function dominioIndisponivel(productName: string): CopyBlock {
  const pro = getPlan('pro');

  return {
    tone: 'info',
    title: 'Domínio próprio faz parte do plano Pro',
    body:
      `Publique seus formulários em formularios.suaempresa.com.br, sem a marca ${productName} e com o ` +
      'visual da sua empresa.',
    actions: [{ label: `Fazer upgrade para o ${pro.name}`, href: '/planos', kind: 'primary' }],
  };
}

// -----------------------------------------------------------------------------
// Downgrade
// -----------------------------------------------------------------------------

export function downgradeBloqueado(params: { targetPlanCode: string; blockers: DowngradeBlocker[] }): CopyBlock {
  const plano = getPlan(params.targetPlanCode as PlanCode);
  const itens = params.blockers
    .map((b) => `· ${b.current} ${b.label} acima do limite de ${b.limit} → ${b.action}`)
    .join('\n');

  const quantidade = params.blockers.length;

  return {
    tone: 'warning',
    title: `Antes de mudar para o ${plano.name}`,
    body:
      `Você precisa ajustar ${quantidade} ${quantidade === 1 ? 'coisa' : 'coisas'}:\n${itens}\n\n` +
      // Nunca dizer que algo será apagado quando não será.
      'Nada é apagado — formulários arquivados e respostas continuam salvos.',
    actions: [
      { label: 'Ajustar agora', href: '/configuracoes', kind: 'free' },
      { label: 'Manter meu plano atual', href: '/planos', kind: 'free' },
    ],
  };
}

// -----------------------------------------------------------------------------
// Trial
// -----------------------------------------------------------------------------

export function trialTerminando(params: { daysLeft: number }): CopyBlock {
  return {
    tone: 'info',
    title: `${params.daysLeft === 1 ? 'Falta 1 dia' : `Faltam ${params.daysLeft} dias`} do seu teste`,
    body:
      `Depois disso a conta vira Free e alguns recursos ficam indisponíveis. ` +
      'Seus formulários e respostas continuam salvos.',
    actions: [{ label: 'Escolher um plano', href: '/planos', kind: 'primary' }],
  };
}

export function trialEncerrado(params: { formsCount: number; responsesCount: number }): CopyBlock {
  return {
    tone: 'info',
    title: 'Seu teste acabou e a conta voltou para o Free',
    body:
      `Está tudo aqui: ${numero.format(params.formsCount)} formulários e ` +
      `${numero.format(params.responsesCount)} respostas. ` +
      'Assine para reativar lógica condicional, webhooks e sua equipe.',
    actions: [{ label: 'Ver planos', href: '/planos', kind: 'primary' }],
  };
}

// -----------------------------------------------------------------------------
// Cobrança
// -----------------------------------------------------------------------------

export function boletoEmitido(params: { amountCents: number; dueDate: Date }): CopyBlock {
  return {
    tone: 'info',
    title: 'Seu boleto está pronto',
    body:
      `Seu boleto de ${formatBRL(params.amountCents)} vence em ${formatarData(params.dueDate)}. ` +
      'A compensação leva de 1 a 3 dias úteis. Sua conta continua ativa normalmente nesse período.',
    actions: [
      { label: 'Baixar boleto', href: '#boleto', kind: 'primary' },
      { label: 'Copiar linha digitável', href: '#linha-digitavel', kind: 'free' },
      { label: 'Trocar para Pix', href: '#pix', kind: 'free' },
    ],
  };
}

export function boletoVencidoNaTolerancia(params: { dueDate: Date; graceUntil: Date }): CopyBlock {
  return {
    tone: 'warning',
    title: 'Não identificamos o pagamento do seu boleto',
    body:
      `Não identificamos o pagamento do boleto vencido em ${formatarData(params.dueDate)}. ` +
      `Sua conta segue ativa até ${formatarData(params.graceUntil)}. ` +
      // Boleto compensa em 1 a 3 dias úteis: quem já pagou não pode se assustar.
      'Se você já pagou nos últimos dias, pode ignorar este aviso — a baixa é automática.',
    actions: [
      { label: 'Emitir segunda via', href: '#segunda-via', kind: 'primary' },
      { label: 'Pagar por Pix agora', href: '#pix', kind: 'primary' },
    ],
  };
}

export function contaSuspensa(): CopyBlock {
  return {
    tone: 'danger',
    title: 'Sua conta está em modo somente leitura',
    body:
      'Você continua vendo e exportando tudo. Formulários públicos estão pausados e novas respostas não ' +
      'estão sendo recebidas. Regularize para reativar em poucos minutos.',
    actions: [
      { label: 'Regularizar pagamento', href: '/cobranca', kind: 'primary' },
      { label: 'Exportar meus dados', href: '/exportacoes', kind: 'free' },
    ],
  };
}

export function confirmarCancelamento(params: { activeUntil: Date }): CopyBlock {
  return {
    tone: 'warning',
    title: 'Tem certeza que quer cancelar?',
    body:
      `Sua assinatura fica ativa até ${formatarData(params.activeUntil)}. Depois disso, a conta vira somente ` +
      'leitura e seus dados ficam disponíveis para exportação por 30 dias. ' +
      'Se o problema for preço ou volume, talvez um plano menor resolva.',
    actions: [
      { label: 'Ver planos menores', href: '/planos', kind: 'free' },
      { label: 'Exportar tudo antes', href: '/exportacoes', kind: 'free' },
      { label: 'Confirmar cancelamento', href: '#confirmar', kind: 'primary' },
    ],
  };
}
