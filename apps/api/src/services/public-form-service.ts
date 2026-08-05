import {
  buildMetaTags,
  formSchema,
  themeSchema,
  validateResponse,
  type FormDefinition,
  type MetaTag,
  type ResponseValues,
} from '@forms/shared';
import type { Prisma } from '@prisma/client';
import { withTenant, withoutTenant, type TenantContext } from '../db/tenant.js';
import { resolvePublicFormOrg } from '../db/bootstrap.js';
import { responsesRepository } from '../db/repositories.js';
import { encryptResponseData } from '../crypto/envelope.js';
import { verifyPassword } from '../auth/hashing.js';
import { AppError, notFound, validationError } from '../http/errors.js';
import { evaluateResponseQuota, incrementResponseCount, loadUsage } from './usage-service.js';
import { dispatchWebhooks } from './webhooks-service.js';
import { publicBrandingOf } from './branding-service.js';
import { env } from '../config/env.js';

/**
 * O lado público: renderizar e receber.
 *
 * Este é o único caminho do sistema em que um anônimo toca dados de uma
 * organização. Por isso ele é deliberadamente estreito:
 *
 *  - O tenant sai do slug, resolvido por função de bootstrap, e o contexto
 *    resultante serve para UMA coisa: ler aquele formulário e gravar UMA
 *    resposta nele.
 *  - Nada além do formulário pedido é exposto. Nem contagem de respostas, nem
 *    dados da empresa, nem outros formulários.
 *  - Nenhuma mensagem daqui menciona plano, limite, pagamento ou o nome da
 *    plataforma (seção 11). Quem responde o formulário não tem nada a ver com
 *    a relação comercial do cliente com a gente.
 */

export type PublicFormState =
  | 'open'
  | 'closed_by_date'
  | 'closed_by_limit'
  | 'requires_password'
  | 'requires_login'
  | 'paused';

export interface PublicFormView {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  version: number;
  definition: FormDefinition;
  theme: unknown;
  state: PublicFormState;
  organization: {
    name: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string | null;
  };
  /** `false` nos planos Pro+ — o formulário sai sem a nossa marca. */
  showBranding: boolean;
  /**
   * Nome do produto para o rodapé.
   *
   * Vem do servidor porque [PRODUTO] é configurável por `.env`, e a tela não
   * tem acesso a esse valor. Vazio quando `showBranding` é falso — assim não
   * existe nem no JSON que o respondente pode abrir no inspetor.
   */
  productName: string;
  /** Já sanitizado e já filtrado pelo plano. Vai direto para uma `<style>`. */
  customCss: string;
  /** Título da aba e prévia do link, prontos para aplicar. */
  meta: { title: string; tags: MetaTag[] };
}

/** Estados em que a organização não recebe respostas (seção 11). */
const STATUS_QUE_PAUSAM = new Set(['suspended', 'canceled']);

interface ResolvedForm {
  ctx: TenantContext;
  form: Prisma.FormGetPayload<Record<string, never>>;
  organization: OrganizacaoPublica;
}

interface OrganizacaoPublica {
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  primaryColor: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  customCss: string | null;
  planCode: string;
  subscriptionStatus: string;
}

/**
 * Resolve o formulário e abre o contexto de tenant.
 *
 * `fn` roda dentro da transação já amarrada à organização dona do formulário.
 */
async function withPublicForm<T>(slug: string, fn: (resolved: ResolvedForm) => Promise<T>): Promise<T> {
  const located = await withoutTenant((tx) => resolvePublicFormOrg(tx, slug));
  // Formulário inexistente, despublicado ou apagado: tudo responde igual. Um
  // 404 diferente de um 410 já diria que o formulário existiu.
  if (!located) throw notFound('Este formulário não está disponível.');

  return withTenant(located.organizationId, async (ctx) => {
    const form = await ctx.tx.form.findFirst({
      where: { id: located.formId, organizationId: ctx.organizationId, deletedAt: null, status: 'published' },
    });
    if (!form) throw notFound('Este formulário não está disponível.');

    const organization = await ctx.tx.organization.findFirst({
      where: { id: ctx.organizationId },
      select: {
        name: true,
        logoUrl: true,
        faviconUrl: true,
        ogImageUrl: true,
        primaryColor: true,
        metaTitle: true,
        metaDescription: true,
        customCss: true,
        planCode: true,
        subscriptionStatus: true,
      },
    });
    if (!organization) throw notFound('Este formulário não está disponível.');

    return fn({ ctx, form, organization });
  });
}

async function resolveState(resolved: ResolvedForm): Promise<PublicFormState> {
  const { form, organization, ctx } = resolved;

  if (STATUS_QUE_PAUSAM.has(organization.subscriptionStatus)) return 'paused';
  if (form.closesAt && form.closesAt <= new Date()) return 'closed_by_date';

  if (form.maxResponses !== null) {
    const recebidas = await ctx.tx.response.count({
      where: { organizationId: ctx.organizationId, formId: form.id, deletedAt: null },
    });
    if (recebidas >= form.maxResponses) return 'closed_by_limit';
  }

  if (form.requiresLogin) return 'requires_login';
  if (form.passwordHash) return 'requires_password';

  return 'open';
}

export async function getPublicForm(slug: string): Promise<PublicFormView> {
  return withPublicForm(slug, async (resolved) => {
    const { form, organization } = resolved;
    const state = await resolveState(resolved);

    // Formulário fechado devolve o cabeçalho e o estado, sem os campos: não há
    // motivo para entregar o schema de algo que não aceita resposta.
    const definition = formSchema.parse(form.schemaJson);
    const vazio: FormDefinition = { ...definition, pages: [], logic: [] };

    const branding = publicBrandingOf(organization);

    return {
      id: form.id,
      title: form.title,
      description: form.description,
      slug: form.slugPublic,
      version: form.version,
      definition: state === 'open' ? definition : vazio,
      theme: themeSchema.parse(form.themeJson ?? {}),
      state,
      organization: {
        name: organization.name,
        logoUrl: branding.logoUrl,
        faviconUrl: branding.faviconUrl,
        primaryColor: branding.primaryColor,
      },
      showBranding: branding.showBranding,
      productName: branding.showBranding ? env.branding.productName : '',
      customCss: branding.customCss,
      meta: buildMetaTags({
        formTitle: form.title,
        formDescription: form.description,
        organizationName: organization.name,
        metaTitle: branding.metaTitle,
        metaDescription: branding.metaDescription,
        ogImageUrl: branding.ogImageUrl,
        faviconUrl: branding.faviconUrl,
        showBranding: branding.showBranding,
        productName: env.branding.productName,
      }),
    };
  });
}

export interface SubmitParams {
  slug: string;
  values: ResponseValues;
  /** Campo invisível que só robô preenche. */
  honeypot?: string;
  /** Senha do formulário, quando ele tem uma. */
  password?: string;
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface SubmitResult {
  responseId: string;
  confirmationMessage: string;
  redirectUrl?: string;
}

export async function submitPublicForm(params: SubmitParams): Promise<SubmitResult> {
  const { resultado, evento } = await gravarSubmissao(params);

  // Disparado fora da transação e sem `await`: o respondente já cumpriu a
  // parte dele. Webhook do dono do formulário com problema não pode virar erro
  // na tela de quem respondeu.
  if (evento) {
    void dispatchWebhooks(evento).catch(() => undefined);
  }

  return resultado;
}

interface SubmissaoGravada {
  resultado: SubmitResult;
  /** Ausente quando nada foi realmente gravado (honeypot). */
  evento?: {
    organizationId: string;
    event: 'response.created';
    formId: string;
    responseId: string;
    data: Record<string, unknown>;
  };
}

async function gravarSubmissao(params: SubmitParams): Promise<SubmissaoGravada> {
  return withPublicForm(params.slug, async (resolved) => {
    const { ctx, form } = resolved;
    const state = await resolveState(resolved);

    if (state === 'paused' || state === 'closed_by_date' || state === 'closed_by_limit') {
      // Mensagem neutra, sem mencionar plano, limite ou pagamento (seção 11).
      throw new AppError('forbidden', 'Este formulário não está recebendo respostas no momento.');
    }

    if (state === 'requires_login') {
      throw new AppError('unauthorized', 'Este formulário é restrito. Entre com sua conta para responder.');
    }

    const definition = formSchema.parse(form.schemaJson);

    if (form.passwordHash) {
      const ok = params.password ? await verifyPassword(form.passwordHash, params.password) : false;
      if (!ok) throw validationError({ password: ['Senha incorreta.'] });
    }

    // Honeypot: o campo é invisível na tela, então humano não preenche.
    // Responder 201 em vez de erro é proposital — o robô vai embora achando
    // que funcionou, e não tenta outra estratégia.
    if (definition.settings.honeypotEnabled && params.honeypot && params.honeypot.trim() !== '') {
      return {
        resultado: {
          responseId: '00000000-0000-4000-8000-000000000000',
          confirmationMessage: definition.settings.confirmationMessage,
        },
      };
    }

    const validacao = validateResponse(definition, params.values);
    if (!validacao.ok) throw validationError(validacao.errors, 'Revise os campos destacados.');

    // A cota de respostas é avaliada DEPOIS da validação, para que uma
    // submissão inválida não consuma a cortesia de 48h de quem está no limite.
    const { outcome, isBuffered } = await evaluateResponseQuota(ctx);
    if (!outcome.allowed) {
      // O respondente não tem nada com a relação comercial do cliente conosco:
      // a mensagem é a mesma de um formulário fechado por qualquer motivo.
      throw new AppError('forbidden', 'Este formulário não está recebendo respostas no momento.');
    }

    // Cifra antes de tocar o banco. A resposta em claro não existe fora desta
    // função — nem em log, nem em coluna.
    const { dataEncrypted, dataKeyEncrypted } = encryptResponseData(ctx.organizationId, validacao.values);

    const response = await responsesRepository.create(ctx, {
      formId: form.id,
      formVersion: form.version,
      dataEncrypted,
      dataKeyEncrypted,
      ipHash: params.ipHash,
      userAgentHash: params.userAgentHash,
      status: 'new',
      // Recebida durante a cortesia. Fica marcada, mas NUNCA é apagada: some
      // da contagem, não do banco (seção 6.2).
      isBuffered,
    });

    await incrementResponseCount(ctx, (await loadUsage(ctx)).periodStart);

    // Anexa os arquivos que já haviam sido enviados a esta resposta.
    const idsDeArquivo = Object.values(validacao.values)
      .filter((valor): valor is string[] => Array.isArray(valor))
      .flat()
      .filter((valor) => typeof valor === 'string');

    if (idsDeArquivo.length > 0) {
      await ctx.tx.file.updateMany({
        where: { id: { in: idsDeArquivo }, organizationId: ctx.organizationId, responseId: null },
        data: { responseId: response.id },
      });
    }

    return {
      resultado: {
        responseId: response.id,
        confirmationMessage: definition.settings.confirmationMessage,
        ...(definition.settings.redirectUrl ? { redirectUrl: definition.settings.redirectUrl } : {}),
      },
      evento: {
        organizationId: ctx.organizationId,
        event: 'response.created' as const,
        formId: form.id,
        responseId: response.id,
        // As respostas vão no payload — é o que torna o webhook útil. Por isso
        // a entrega exige https e vai assinada.
        data: validacao.values as Record<string, unknown>,
      },
    };
  });
}
