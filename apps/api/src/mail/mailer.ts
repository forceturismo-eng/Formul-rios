import { env } from '../config/env.js';

/**
 * Envio de e-mail.
 *
 * Na Fase 1 existe só o driver de memória: ele guarda a mensagem numa caixa de
 * saída e registra no log. Isso é suficiente para o fluxo de verificação de
 * e-mail funcionar de ponta a ponta em dev e nos testes, e evita depender de
 * SMTP para provar que o registro funciona.
 *
 * O envio real (Resend/SMTP) entra junto com as filas, na Fase 2 — e-mail
 * transacional pertence a uma fila, não ao request: um SMTP lento não pode
 * segurar um cadastro.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  sentAt: Date;
}

export interface Mailer {
  send(message: Omit<OutgoingEmail, 'sentAt'>): Promise<void>;
}

const outbox: OutgoingEmail[] = [];

export const memoryMailer: Mailer = {
  async send(message) {
    outbox.push({ ...message, sentAt: new Date() });
    // Só assunto e destinatário no log. Corpo de e-mail transacional carrega
    // token e nome — nada disso vai para log estruturado (seção 9).
    console.info(`[mail] para=${message.to} assunto="${message.subject}"`);
  },
};

let mailer: Mailer = memoryMailer;

export function setMailer(next: Mailer): void {
  mailer = next;
}

export function sendMail(message: Omit<OutgoingEmail, 'sentAt'>): Promise<void> {
  return mailer.send(message);
}

/** Caixa de saída em memória. Usada pelos testes e pelo dev que não quer subir Mailhog. */
export function readOutbox(): readonly OutgoingEmail[] {
  return outbox;
}

export function findLastEmailTo(address: string): OutgoingEmail | undefined {
  const normalized = address.trim().toLowerCase();
  for (let i = outbox.length - 1; i >= 0; i--) {
    if (outbox[i]?.to.toLowerCase() === normalized) return outbox[i];
  }
  return undefined;
}

export function clearOutbox(): void {
  outbox.length = 0;
}

// -----------------------------------------------------------------------------
// Mensagens
// -----------------------------------------------------------------------------

export function verificationEmail(params: { to: string; name: string; token: string }): Omit<OutgoingEmail, 'sentAt'> {
  const link = `${env.branding.appUrl}/verificar-email?token=${encodeURIComponent(params.token)}`;
  return {
    to: params.to,
    subject: `Confirme seu e-mail no ${env.branding.productName}`,
    text: [
      `Olá, ${params.name}.`,
      '',
      `Confirme seu e-mail para liberar o envio de formulários no ${env.branding.productName}:`,
      link,
      '',
      'O link vale por 24 horas. Se não foi você quem criou a conta, ignore esta mensagem.',
    ].join('\n'),
  };
}

export function invitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string;
  token: string;
}): Omit<OutgoingEmail, 'sentAt'> {
  const link = `${env.branding.appUrl}/convite?token=${encodeURIComponent(params.token)}`;
  return {
    to: params.to,
    subject: `${params.inviterName} convidou você para a ${params.organizationName}`,
    text: [
      `${params.inviterName} convidou você para trabalhar nos formulários da ${params.organizationName}.`,
      '',
      'Aceite o convite por aqui:',
      link,
      '',
      'O convite vale por 7 dias e só pode ser usado uma vez.',
    ].join('\n'),
  };
}

/**
 * Aviso de menção num comentário.
 *
 * O corpo do comentário NÃO vai no e-mail. Ele fala de uma resposta de
 * formulário — dado pessoal de terceiro — e e-mail é o canal menos controlado
 * que existe: fica na caixa de entrada, é encaminhado, é indexado por cliente
 * de e-mail. O aviso diz que houve menção e leva para dentro do produto, onde
 * as permissões valem.
 */
export function mentionEmail(params: {
  to: string;
  mentionedBy: string;
  organizationName: string;
  formTitle: string;
  responseId: string;
  formId: string;
}): Omit<OutgoingEmail, 'sentAt'> {
  const link = `${env.branding.appUrl}/formularios/${params.formId}/respostas?resposta=${params.responseId}`;

  return {
    to: params.to,
    subject: `${params.mentionedBy} mencionou você em ${params.formTitle}`,
    text: [
      `${params.mentionedBy} mencionou você num comentário em "${params.formTitle}", na ${params.organizationName}.`,
      '',
      'Veja o comentário por aqui:',
      link,
      '',
      'O conteúdo fica no produto, onde as permissões da sua conta valem.',
    ].join('\n'),
  };
}
