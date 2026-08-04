import { formSchema, themeSchema, validateResponse, type FormDefinition, type ResponseValues } from '@forms/shared';
import type { Prisma } from '@prisma/client';
import { withTenant, withoutTenant, type TenantContext } from '../db/tenant.js';
import { resolvePublicFormOrg } from '../db/bootstrap.js';
import { responsesRepository } from '../db/repositories.js';
import { encryptResponseData } from '../crypto/envelope.js';
import { verifyPassword } from '../auth/hashing.js';
import { AppError, notFound, validationError } from '../http/errors.js';

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
    primaryColor: string | null;
  };
  /** `false` nos planos Pro+ — o formulário sai sem a nossa marca. */
  showBranding: boolean;
}

/** Estados em que a organização não recebe respostas (seção 11). */
const STATUS_QUE_PAUSAM = new Set(['suspended', 'canceled']);

interface ResolvedForm {
  ctx: TenantContext;
  form: Prisma.FormGetPayload<Record<string, never>>;
  organization: { name: string; logoUrl: string | null; primaryColor: string | null; planCode: string; subscriptionStatus: string };
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
      select: { name: true, logoUrl: true, primaryColor: true, planCode: true, subscriptionStatus: true },
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
        logoUrl: organization.logoUrl,
        primaryColor: organization.primaryColor,
      },
      showBranding: !planRemovesBranding(organization.planCode),
    };
  });
}

function planRemovesBranding(planCode: string): boolean {
  return planCode === 'pro' || planCode === 'business' || planCode === 'enterprise';
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
        responseId: '00000000-0000-4000-8000-000000000000',
        confirmationMessage: definition.settings.confirmationMessage,
      };
    }

    const validacao = validateResponse(definition, params.values);
    if (!validacao.ok) throw validationError(validacao.errors, 'Revise os campos destacados.');

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
    });

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
      responseId: response.id,
      confirmationMessage: definition.settings.confirmationMessage,
      ...(definition.settings.redirectUrl ? { redirectUrl: definition.settings.redirectUrl } : {}),
    };
  });
}
