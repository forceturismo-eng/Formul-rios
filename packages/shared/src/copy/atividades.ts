/**
 * Feed de atividades: o audit log em linguagem de gente.
 *
 * O audit log guarda `form.published` e `member.role_changed`. Isso serve para
 * uma investigação, e não serve para a pessoa que abre a tela querendo saber o
 * que aconteceu na empresa dela esta semana.
 *
 * A tradução mora no pacote compartilhado por um motivo prático: a mesma frase
 * vai aparecer na tela e, um dia, no digest por e-mail. Duas implementações
 * divergiriam na primeira vez que alguém ajustasse uma palavra.
 *
 * Nenhuma frase daqui inclui conteúdo de resposta. O audit log não guarda, e o
 * feed não teria como inventar — mas vale dizer, porque a tentação de "mostrar
 * um trechinho" aparece toda vez que alguém desenha esta tela.
 */

export type CategoriaDeAtividade = 'formulario' | 'recebimento' | 'equipe' | 'conta' | 'integracao' | 'plataforma';

export interface AtividadeDescrita {
  /** Frase pronta, sem o nome de quem fez — a tela põe o autor na frente. */
  texto: string;
  categoria: CategoriaDeAtividade;
  /** `true` quando foi a plataforma, não alguém da empresa. */
  daPlataforma?: boolean;
}

type Metadados = Record<string, unknown>;

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

const PAPEIS: Record<string, string> = {
  owner: 'dono',
  admin: 'administrador',
  editor: 'editor',
  viewer: 'leitor',
};

function papel(valor: unknown): string {
  const bruto = texto(valor);
  return bruto ? (PAPEIS[bruto] ?? bruto) : 'membro';
}

/**
 * Descreve uma entrada do audit log.
 *
 * Devolve `null` para o que não deve aparecer no feed. Isso é deliberado: um
 * feed com `auth.refresh` a cada quinze minutos é um feed que ninguém lê, e a
 * informação que importa se perde no meio.
 */
export function describeActivity(action: string, metadata: Metadados = {}): AtividadeDescrita | null {
  switch (action) {
    // -------------------------------------------------------------------------
    // Formulários
    // -------------------------------------------------------------------------
    case 'form.created':
      return { texto: `criou o formulário “${texto(metadata['title']) ?? 'sem título'}”`, categoria: 'formulario' };
    case 'form.updated':
      return { texto: 'editou um formulário', categoria: 'formulario' };
    case 'form.published':
      return { texto: 'publicou um formulário', categoria: 'formulario' };
    case 'form.archived':
      return { texto: 'arquivou um formulário', categoria: 'formulario' };
    case 'form.deleted':
      return { texto: 'apagou um formulário', categoria: 'formulario' };

    // -------------------------------------------------------------------------
    // Recebimentos
    // -------------------------------------------------------------------------
    case 'response.updated':
      return { texto: 'mudou o status de uma resposta', categoria: 'recebimento' };
    case 'response.deleted':
      return { texto: 'apagou uma resposta', categoria: 'recebimento' };
    case 'response.exported':
      return {
        texto: `exportou respostas em ${texto(metadata['format'])?.toUpperCase() ?? 'arquivo'}`,
        categoria: 'recebimento',
      };
    case 'ai_analysis.created':
      return { texto: 'gerou uma análise com IA', categoria: 'recebimento' };

    // -------------------------------------------------------------------------
    // Equipe
    // -------------------------------------------------------------------------
    case 'invitation.created':
      return { texto: `convidou alguém como ${papel(metadata['role'])}`, categoria: 'equipe' };
    case 'invitation.accepted':
    case 'auth.accept_invitation':
      return { texto: 'entrou na empresa', categoria: 'equipe' };
    case 'invitation.revoked':
      return { texto: 'cancelou um convite', categoria: 'equipe' };
    case 'member.role_changed':
      return {
        texto: `mudou o papel de ${papel(metadata['from'])} para ${papel(metadata['to'])}`,
        categoria: 'equipe',
      };
    case 'member.removed':
      return { texto: 'removeu alguém da empresa', categoria: 'equipe' };
    case 'member.left':
      return { texto: 'saiu da empresa', categoria: 'equipe' };

    // -------------------------------------------------------------------------
    // Conta
    // -------------------------------------------------------------------------
    case 'organization.created':
      return { texto: 'criou a empresa', categoria: 'conta' };
    case 'organization.updated':
      return { texto: 'alterou os dados da empresa', categoria: 'conta' };
    case 'branding.updated':
      return { texto: 'alterou a marca dos formulários', categoria: 'conta' };
    case 'billing_profile.updated':
      return { texto: 'alterou os dados de cobrança', categoria: 'conta' };
    case 'subscription.created':
      return { texto: `assinou o plano ${texto(metadata['planCode']) ?? ''}`.trim(), categoria: 'conta' };
    case 'subscription.plan_changed':
      return {
        texto: `mudou o plano de ${texto(metadata['from']) ?? '—'} para ${texto(metadata['to']) ?? '—'}`,
        categoria: 'conta',
      };
    case 'subscription.canceled':
      return { texto: 'cancelou a assinatura', categoria: 'conta' };
    case 'ai.consent_granted':
      return { texto: 'ativou as análises com IA', categoria: 'conta' };
    case 'ai.consent_revoked':
      return { texto: 'desativou as análises com IA', categoria: 'conta' };

    // -------------------------------------------------------------------------
    // Integrações
    // -------------------------------------------------------------------------
    case 'custom_domain.added':
      return { texto: `cadastrou o domínio ${texto(metadata['domain']) ?? 'próprio'}`, categoria: 'integracao' };
    case 'custom_domain.removed':
      return { texto: 'removeu um domínio próprio', categoria: 'integracao' };
    case 'webhook.created':
      return { texto: 'cadastrou um webhook', categoria: 'integracao' };
    case 'webhook.deleted':
      return { texto: 'removeu um webhook', categoria: 'integracao' };
    case 'api_key.created':
      return { texto: `criou a chave de API “${texto(metadata['name']) ?? 'sem nome'}”`, categoria: 'integracao' };
    case 'api_key.revoked':
      return { texto: 'revogou uma chave de API', categoria: 'integracao' };

    // -------------------------------------------------------------------------
    // Plataforma
    //
    // O cliente tem direito de ver o que NÓS fizemos na conta dele, no mesmo
    // lugar em que vê o que a equipe dele fez. Marcadas para a tela poder
    // distingui-las.
    // -------------------------------------------------------------------------
    case 'platform.impersonation_started':
      return {
        texto: `acesso da plataforma à conta${texto(metadata['reason']) ? `: ${texto(metadata['reason'])}` : ''}`,
        categoria: 'plataforma',
        daPlataforma: true,
      };
    case 'organization.status_changed_by_platform':
      return {
        texto: `a plataforma alterou o estado da conta para ${texto(metadata['to']) ?? '—'}`,
        categoria: 'plataforma',
        daPlataforma: true,
      };
    case 'organization.plan_changed_by_platform':
      return {
        texto: `a plataforma alterou o plano para ${texto(metadata['to']) ?? '—'}`,
        categoria: 'plataforma',
        daPlataforma: true,
      };

    // -------------------------------------------------------------------------
    // Fora do feed
    //
    // Login, refresh e troca de empresa acontecem o tempo todo e afogariam o
    // resto. Continuam no audit log, que é onde uma investigação os procura.
    // -------------------------------------------------------------------------
    default:
      return null;
  }
}

/** Data relativa em português, para o feed. */
export function tempoRelativo(quando: Date, agora = new Date()): string {
  const segundos = Math.floor((agora.getTime() - quando.getTime()) / 1000);

  if (segundos < 60) return 'agora há pouco';
  if (segundos < 3600) {
    const minutos = Math.floor(segundos / 60);
    return `há ${minutos} minuto${minutos > 1 ? 's' : ''}`;
  }
  if (segundos < 86_400) {
    const horas = Math.floor(segundos / 3600);
    return `há ${horas} hora${horas > 1 ? 's' : ''}`;
  }
  if (segundos < 7 * 86_400) {
    const dias = Math.floor(segundos / 86_400);
    return dias === 1 ? 'ontem' : `há ${dias} dias`;
  }

  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(quando);
}
