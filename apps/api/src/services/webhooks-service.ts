import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPlan, isUnlimited, type PlanCode, type Subject } from '@forms/shared';
import { withTenant, type TenantContext } from '../db/tenant.js';
import { auditLogsRepository, webhooksRepository } from '../db/repositories.js';
import { QUEUE_NAMES, getQueue } from '../queue/queues.js';
import { AppError, notFound, validationError } from '../http/errors.js';
import { loadFormFor } from './forms-service.js';

/**
 * Webhooks de saída.
 *
 * Duas coisas definem o desenho:
 *
 *  **Assinatura HMAC.** Quem recebe o webhook precisa poder provar que ele veio
 *  de nós e não foi adulterado no caminho. Sem isso, a URL do webhook do
 *  cliente vira um endpoint que qualquer um alimenta com dados falsos.
 *
 *  **A URL é escolhida pelo cliente.** Isso é SSRF por construção: o cliente
 *  pode apontar para `http://169.254.169.254` e tentar ler o metadata da nossa
 *  nuvem. Daí a lista de destinos proibidos abaixo.
 */

export const WEBHOOK_EVENTS = [
  'response.created',
  'response.updated',
  'response.deleted',
  'form.published',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Destinos que um webhook nunca pode alcançar.
 *
 * Faixas privadas, loopback e link-local. `169.254.169.254` é o endpoint de
 * metadata da AWS, GCP e Azure — o alvo clássico de SSRF, porque devolve
 * credenciais da instância.
 */
const FAIXAS_PROIBIDAS: Array<(ip: string) => boolean> = [
  (ip) => ip.startsWith('127.'),
  (ip) => ip.startsWith('10.'),
  (ip) => ip.startsWith('192.168.'),
  (ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
  (ip) => ip.startsWith('169.254.'),
  (ip) => ip === '0.0.0.0',
  (ip) => ip === '::1',
  (ip) => ip.startsWith('fc') || ip.startsWith('fd'),
  (ip) => ip.startsWith('fe80:'),
];

const HOSTS_PROIBIDOS = new Set(['localhost', 'metadata.google.internal', 'metadata']);

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

export function validateWebhookUrl(entrada: string, permitirHttpLocal = false): UrlCheck {
  let url: URL;
  try {
    url = new URL(entrada);
  } catch {
    return { ok: false, reason: 'Informe uma URL completa, começando com https://.' };
  }

  // HTTPS obrigatório: o payload carrega o conteúdo da resposta, que é dado
  // pessoal do cliente do nosso cliente.
  if (url.protocol !== 'https:' && !(permitirHttpLocal && url.protocol === 'http:')) {
    return { ok: false, reason: 'O endereço precisa usar https.' };
  }

  const host = url.hostname.toLowerCase();

  if (HOSTS_PROIBIDOS.has(host)) {
    return { ok: false, reason: 'Esse endereço não pode receber webhooks.' };
  }

  // Endereço literal: barrado direto. Nome que RESOLVE para faixa privada é
  // barrado na hora da entrega, quando sabemos o IP.
  if (FAIXAS_PROIBIDAS.some((teste) => teste(host))) {
    return { ok: false, reason: 'Esse endereço não pode receber webhooks.' };
  }

  return { ok: true };
}

/** `true` se o IP resolvido está numa faixa que a entrega deve recusar. */
export function isBlockedAddress(ip: string): boolean {
  return FAIXAS_PROIBIDAS.some((teste) => teste(ip));
}

/**
 * Assinatura do webhook.
 *
 * `t=<timestamp>,v1=<hmac>` — o timestamp entra no HMAC para que um payload
 * capturado não possa ser reenviado meses depois. Quem recebe confere a
 * assinatura E a idade do timestamp.
 */
export function signPayload(secret: string, payload: string, timestamp = Date.now()): string {
  const assinatura = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${assinatura}`;
}

/** Verificação, exposta para o cliente conferir do lado dele e para os testes. */
export function verifySignature(
  secret: string,
  payload: string,
  header: string,
  toleranciaSegundos = 300,
): boolean {
  const partes = Object.fromEntries(
    header.split(',').map((item) => {
      const [chave, valor] = item.split('=');
      return [chave ?? '', valor ?? ''];
    }),
  );

  const timestamp = Number(partes['t']);
  const recebida = partes['v1'];
  if (!Number.isFinite(timestamp) || !recebida) return false;

  // Payload antigo não vale, mesmo com assinatura correta.
  if (Math.abs(Date.now() - timestamp) > toleranciaSegundos * 1000) return false;

  const esperada = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(recebida);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createWebhook(
  ctx: TenantContext,
  subject: Subject,
  entrada: { url: string; formId?: string; events: string[] },
) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });
  const plano = getPlan(organizacao.planCode as PlanCode);

  if (!plano.features.webhooks) {
    throw new AppError('quota_exceeded', 'Webhooks fazem parte de um plano superior.', {
      extra: { upgradeUrl: '/planos' },
    });
  }

  const checagem = validateWebhookUrl(entrada.url);
  if (!checagem.ok) throw validationError({ url: [checagem.reason as string] });

  const eventosInvalidos = entrada.events.filter((evento) => !WEBHOOK_EVENTS.includes(evento as WebhookEvent));
  if (eventosInvalidos.length > 0) {
    throw validationError({ events: [`Evento desconhecido: ${eventosInvalidos.join(', ')}.`] });
  }

  if (entrada.formId) {
    // Confere que o formulário existe E que o usuário tem acesso a ele.
    await loadFormFor(ctx, subject, entrada.formId, 'webhook:manage');

    const limite = plano.limits.webhooksPerForm;
    if (!isUnlimited(limite)) {
      const existentes = await ctx.tx.webhook.count({
        where: { organizationId: ctx.organizationId, formId: entrada.formId },
      });
      if (existentes >= limite) {
        throw new AppError('quota_exceeded', `Seu plano permite ${limite} webhook(s) por formulário.`, {
          extra: { limit: limite, current: existentes, upgradeUrl: '/planos' },
        });
      }
    }
  }

  // O segredo é mostrado UMA vez, na criação. Depois disso, só o cliente tem.
  const secret = `whsec_${randomBytes(24).toString('hex')}`;

  const webhook = await webhooksRepository.create(ctx, {
    url: entrada.url,
    formId: entrada.formId ?? null,
    secret,
    events: entrada.events,
    isActive: true,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'webhook.created',
    resourceType: 'webhook',
    resourceId: webhook.id,
    metadataJson: { events: entrada.events, formId: entrada.formId ?? null },
  });

  return { webhook, secret };
}

export async function listWebhooks(ctx: TenantContext) {
  const webhooks = await ctx.tx.webhook.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
  });

  // `secret` nunca sai daqui: ele é do cliente e foi mostrado na criação.
  return webhooks.map((webhook) => ({
    id: webhook.id,
    url: webhook.url,
    formId: webhook.formId,
    events: webhook.events,
    isActive: webhook.isActive,
    lastStatus: webhook.lastStatus,
    failureCount: webhook.failureCount,
    createdAt: webhook.createdAt,
  }));
}

export async function deleteWebhook(ctx: TenantContext, subject: Subject, webhookId: string): Promise<void> {
  const webhook = await webhooksRepository.findById(ctx, webhookId);
  if (!webhook) throw notFound();

  await ctx.tx.webhook.delete({ where: { id: webhook.id, organizationId: ctx.organizationId } });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'webhook.deleted',
    resourceType: 'webhook',
    resourceId: webhookId,
    metadataJson: {},
  });
}

/**
 * Monta o corpo enviado ao cliente.
 *
 * O conteúdo da resposta vai junto de propósito — é o que torna o webhook útil
 * — e é justamente por isso que a entrega exige HTTPS e assinatura.
 */
export function buildPayload(params: {
  event: WebhookEvent;
  organizationId: string;
  formId: string;
  responseId?: string;
  data?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    event: params.event,
    // Timestamp do evento, não da tentativa: retentativas repetem este valor.
    occurredAt: new Date().toISOString(),
    organizationId: params.organizationId,
    formId: params.formId,
    ...(params.responseId ? { responseId: params.responseId } : {}),
    ...(params.data ? { data: params.data } : {}),
  });
}

/**
 * Enfileira o evento para todos os webhooks que o assinam.
 *
 * Chamada DEPOIS da transação que gravou a resposta, nunca dentro dela: se o
 * commit falhasse, o job já estaria no Redis e o cliente receberia um webhook
 * de uma resposta que não existe.
 *
 * Devolve quantos jobs foram criados. Falha de Redis não sobe: quem responde o
 * formulário não pode receber erro porque o webhook do dono está com problema.
 */
export async function dispatchWebhooks(trigger: {
  organizationId: string;
  event: WebhookEvent;
  formId: string;
  responseId?: string;
  data?: Record<string, unknown>;
}): Promise<number> {
  const alvos = await withTenant(trigger.organizationId, (ctx) =>
    ctx.tx.webhook.findMany({
      where: {
        organizationId: ctx.organizationId,
        isActive: true,
        events: { has: trigger.event },
        // `formId` nulo significa "todos os formulários da organização".
        OR: [{ formId: null }, { formId: trigger.formId }],
      },
      select: { id: true },
    }),
  );

  if (alvos.length === 0) return 0;

  const payload = buildPayload({
    event: trigger.event,
    organizationId: trigger.organizationId,
    formId: trigger.formId,
    ...(trigger.responseId ? { responseId: trigger.responseId } : {}),
    ...(trigger.data ? { data: trigger.data } : {}),
  });

  const fila = getQueue(QUEUE_NAMES.webhook);

  await Promise.all(
    alvos.map((alvo) =>
      fila.add('entregar', {
        organizationId: trigger.organizationId,
        // Não há usuário por trás: o evento nasce de uma submissão pública.
        requestedBy: 'system',
        webhookId: alvo.id,
        event: trigger.event,
        payload,
        attempt: 1,
      }),
    ),
  );

  return alvos.length;
}

/** Espera antes da tentativa `attempt`, em milissegundos. */
export function backoffMs(attempt: number): number {
  // 1min, 5min, 30min, 2h, 6h. Endpoint de cliente cai por manutenção, e uma
  // janela longa é a diferença entre perder o evento e entregá-lo mais tarde.
  const escala = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
  return escala[Math.min(attempt - 1, escala.length - 1)] as number;
}

export const MAX_TENTATIVAS = 5;
