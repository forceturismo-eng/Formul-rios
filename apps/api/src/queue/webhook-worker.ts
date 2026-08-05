import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Worker, type Job } from 'bullmq';
import { withTenant, type TenantContext } from '../db/tenant.js';
import { QUEUE_NAMES, redisConnection, type TenantJob } from './queues.js';
import {
  MAX_TENTATIVAS,
  backoffMs,
  isBlockedAddress,
  signPayload,
  validateWebhookUrl,
  type WebhookEvent,
} from '../services/webhooks-service.js';

/**
 * Entrega de webhooks.
 *
 * O ponto sensível é que a URL de destino é escolhida pelo cliente. Isso é SSRF
 * por construção: nada impede alguém de cadastrar `http://169.254.169.254` e
 * usar o nosso servidor para ler o metadata da nuvem — que devolve credenciais
 * da instância.
 *
 * A validação no cadastro barra endereço literal. Aqui, na entrega, o nome é
 * RESOLVIDO e o IP conferido: `webhook.cliente.com.br` pode apontar para
 * `127.0.0.1` hoje e para um IP público amanhã, e é o valor do momento da
 * entrega que importa.
 */

export interface WebhookJobData extends TenantJob {
  webhookId: string;
  event: WebhookEvent;
  payload: string;
  attempt: number;
}

const TIMEOUT_MS = 10_000;

export interface DeliveryResult {
  status: 'entregue' | 'falhou' | 'bloqueado';
  statusCode?: number;
  motivo?: string;
}

/**
 * Resolve o host e recusa se ele apontar para faixa privada.
 *
 * Há uma janela de TOCTOU aqui — o DNS pode mudar entre a resolução e a
 * conexão. Fechá-la exigiria conectar por IP e enviar o Host manualmente, o
 * que quebra SNI e certificado. A mitigação prática é esta checagem mais o
 * fato de o corpo da resposta nunca voltar ao cliente: mesmo um SSRF bem
 * sucedido não vaza conteúdo por aqui.
 */
export type ResolvedorDeHost = (hostname: string) => Promise<string>;

const resolvedorPadrao: ResolvedorDeHost = async (hostname) => (await lookup(hostname)).address;

export async function checkDeliveryTarget(
  url: string,
  resolver: ResolvedorDeHost = resolvedorPadrao,
): Promise<{ ok: boolean; motivo?: string }> {
  const validacao = validateWebhookUrl(url);
  if (!validacao.ok) return { ok: false, motivo: validacao.reason as string };

  try {
    const endereco = await resolver(new URL(url).hostname);
    if (isBlockedAddress(endereco)) {
      return { ok: false, motivo: 'O endereço resolve para uma rede interna.' };
    }
  } catch {
    // Nome que não resolve não vira tentativa de conexão. Também evita que um
    // DNS lento segure o worker além do timeout do fetch.
    return { ok: false, motivo: 'Não conseguimos resolver o endereço.' };
  }

  return { ok: true };
}

export async function deliverWebhook(
  data: WebhookJobData,
  resolver: ResolvedorDeHost = resolvedorPadrao,
): Promise<DeliveryResult> {
  return withTenant(data.organizationId, async (ctx) => {
    const webhook = await ctx.tx.webhook.findFirst({
      where: { id: data.webhookId, organizationId: ctx.organizationId },
    });

    if (!webhook || !webhook.isActive) return { status: 'falhou', motivo: 'webhook inativo' };

    const permitido = await checkDeliveryTarget(webhook.url, resolver);
    if (!permitido.ok) {
      await ctx.tx.webhook.update({
        where: { id: webhook.id },
        data: { isActive: false, lastStatus: 0, failureCount: { increment: 1 } },
      });
      await registrarTentativa(ctx, data, null, null);
      return { status: 'bloqueado', motivo: permitido.motivo as string };
    }

    const assinatura = signPayload(webhook.secret, data.payload);
    const controle = new AbortController();
    const timeout = setTimeout(() => controle.abort(), TIMEOUT_MS);

    let statusCode: number | null = null;

    try {
      const resposta = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Formularios-Event': data.event,
          'X-Formularios-Signature': assinatura,
          'X-Formularios-Delivery': `${data.webhookId}:${data.attempt}`,
          'User-Agent': 'Formularios-Webhook/1',
        },
        body: data.payload,
        signal: controle.signal,
        // Nunca seguir redirect: o destino redirecionar para uma rede interna
        // contornaria a checagem de IP que acabamos de fazer.
        redirect: 'manual',
      });

      statusCode = resposta.status;
    } catch {
      statusCode = null;
    } finally {
      clearTimeout(timeout);
    }

    const entregue: boolean = statusCode !== null && statusCode >= 200 && statusCode < 300;

    await ctx.tx.webhook.update({
      where: { id: webhook.id },
      data: {
        lastStatus: statusCode,
        failureCount: entregue ? 0 : { increment: 1 },
        // Endpoint que falha muitas vezes é desligado: continuar batendo num
        // servidor morto é ruído para eles e custo para nós.
        ...(!entregue && webhook.failureCount + 1 >= 20 ? { isActive: false } : {}),
      },
    });

    await registrarTentativa(ctx, data, statusCode, entregue ? null : proximaTentativa(data.attempt));

    return {
      status: entregue ? 'entregue' : 'falhou',
      ...(statusCode !== null ? { statusCode } : {}),
    };
  });
}

function proximaTentativa(attempt: number): Date | null {
  if (attempt >= MAX_TENTATIVAS) return null;
  return new Date(Date.now() + backoffMs(attempt));
}

async function registrarTentativa(
  ctx: TenantContext,
  data: WebhookJobData,
  statusCode: number | null,
  nextRetryAt: Date | null,
): Promise<void> {
  await ctx.tx.webhookDelivery.create({
    data: {
      organizationId: ctx.organizationId,
      webhookId: data.webhookId,
      event: data.event,
      // O payload NÃO é guardado: ele contém a resposta do formulário, que é
      // dado pessoal. O hash basta para correlacionar entregas do mesmo evento.
      payloadHash: hashDoPayload(data.payload),
      statusCode,
      attempt: data.attempt,
      nextRetryAt,
    },
  });
}

/**
 * Hash do payload, truncado.
 *
 * SHA-256 e não um hash rápido qualquer: o payload contém dado pessoal, e um
 * hash fraco de um JSON com poucos campos variáveis é reversível por força
 * bruta. Truncar em 16 caracteres mantém a correlação entre tentativas do
 * mesmo evento sem guardar mais do que o necessário.
 */
function hashDoPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function startWebhookWorker(): Worker<WebhookJobData> {
  const worker = new Worker<WebhookJobData>(
    QUEUE_NAMES.webhook,
    async (job: Job<WebhookJobData>) => {
      const resultado = await deliverWebhook(job.data);
      // Falha vira exceção para o BullMQ reagendar com o backoff da fila.
      if (resultado.status === 'falhou' && job.data.attempt < MAX_TENTATIVAS) {
        throw new Error(`entrega falhou (status ${resultado.statusCode ?? 'sem resposta'})`);
      }
      return resultado;
    },
    { connection: redisConnection(), concurrency: 8 },
  );

  return worker;
}
