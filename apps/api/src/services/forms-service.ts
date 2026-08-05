import {
  can,
  formSchema,
  gatedFieldsUsed,
  getPlan,
  isReservedSlug,
  isUnlimited,
  slugify,
  themeSchema,
  withRandomSuffix,
  type FormDefinition,
  type FormRef,
  type PlanCode,
  type Subject,
} from '@forms/shared';
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '../db/tenant.js';
import { auditLogsRepository, formVersionsRepository, formsRepository } from '../db/repositories.js';
import { AppError, conflict, notFound, validationError } from '../http/errors.js';
import { assertCanCreateForm } from './usage-service.js';

/**
 * Regras dos formulários.
 *
 * Três coisas moram aqui e não nas rotas: permissão por formulário,
 * versionamento e o lock otimista. As três são fáceis de esquecer numa rota
 * nova, e cada esquecimento tem custo — respectivamente: vazamento interno,
 * histórico perdido e trabalho de colega sobrescrito.
 */

/**
 * Carrega o formulário já resolvendo a permissão do usuário sobre ele.
 *
 * Devolve 404 tanto para "não existe" quanto para "existe e você não tem
 * acesso". Dizer "existe, mas não é seu" revelaria quantos formulários a
 * empresa tem para alguém que não deveria saber.
 */
export async function loadFormFor(
  ctx: TenantContext,
  subject: Subject,
  formId: string,
  action: Parameters<typeof can>[1],
): Promise<{ form: Awaited<ReturnType<typeof formsRepository.findById>>; ref: FormRef }> {
  const scoped = await formsRepository.findByIdForUser(ctx, formId, subject.userId);
  if (!scoped) throw notFound();

  const ref: FormRef = {
    id: scoped.form.id,
    createdBy: scoped.form.createdBy,
    explicitPermission: scoped.explicitPermission,
  };

  if (!can(subject, action, { kind: 'form', form: ref })) throw notFound();

  return { form: scoped.form, ref };
}

/**
 * Confere o schema contra o que o plano libera.
 *
 * Isto é validação de conteúdo, não de quota: um formulário com campo de
 * assinatura num plano Free ficaria inconsistente no momento em que fosse
 * renderizado. Quotas de contagem (quantos formulários, quantas respostas)
 * entram na Fase 3, no middleware de enforcement.
 */
export function assertSchemaFitsPlan(definition: FormDefinition, planCode: string): void {
  const plan = getPlan(planCode as PlanCode);
  const errors: Record<string, string[]> = {};

  for (const { fieldId, feature } of gatedFieldsUsed(definition)) {
    if (!plan.features[feature as 'signatureField' | 'paymentFields']) {
      const nome = feature === 'signatureField' ? 'Campo de assinatura' : 'Campo de pagamento';
      (errors[`fields.${fieldId}`] ??= []).push(`${nome} faz parte de um plano superior ao ${plan.name}.`);
    }
  }

  const paginas = definition.pages.length;
  if (!isUnlimited(plan.limits.formPagesMax) && paginas > plan.limits.formPagesMax) {
    errors['pages'] = [
      `O plano ${plan.name} permite ${plan.limits.formPagesMax} páginas por formulário, e este tem ${paginas}.`,
    ];
  }

  if (definition.logic.length > 0 && plan.features.conditionalLogic === 'basic') {
    // No Free a lógica é "básica": mostrar e esconder, sem pular página nem
    // tornar obrigatório.
    const avancadas = definition.logic.filter((rule) => rule.action !== 'show' && rule.action !== 'hide');
    if (avancadas.length > 0) {
      errors['logic'] = [`Pular página e tornar obrigatório fazem parte de um plano superior ao ${plan.name}.`];
    }
  }

  const temCalculo = definition.pages.some((page) => page.fields.some((field) => field.calculation));
  if (temCalculo && !plan.features.calculations) {
    errors['calculations'] = [`Cálculos entre campos fazem parte de um plano superior ao ${plan.name}.`];
  }

  if (definition.settings.redirectUrl && !plan.features.removeBranding) {
    // Redirecionar para fora só nos planos que já removem a marca — senão
    // vira caminho fácil para usar o produto como encurtador.
    errors['settings.redirectUrl'] = [`Redirecionamento após envio faz parte de um plano superior ao ${plan.name}.`];
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('quota_exceeded', 'Esse formulário usa recursos que o seu plano não inclui.', {
      details: errors,
      extra: { upgradeUrl: '/planos' },
    });
  }
}

async function currentPlanCode(ctx: TenantContext): Promise<string> {
  const org = await ctx.tx.organization.findFirst({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });
  if (!org) throw notFound();
  return org.planCode;
}

/** Schema mínimo de um formulário novo: uma página vazia. */
const SCHEMA_INICIAL: FormDefinition = formSchema.parse({
  pages: [{ id: 'pagina-1', title: 'Página 1', fields: [] }],
});

export interface CreateFormParams {
  organizationId: string;
  subject: Subject;
  title: string;
  description?: string;
  definition?: unknown;
}

/**
 * Cria um formulário.
 *
 * Recebe `organizationId` e abre a própria transação — uma POR TENTATIVA, e
 * essa é a parte que importa.
 *
 * O slug público é único globalmente, e o RLS impede (corretamente) consultar
 * os slugs das outras empresas para checar colisão antes. Quem resolve é o
 * índice único, com retentativa.
 *
 * Só que a retentativa precisa de uma transação NOVA. No Postgres, uma
 * violação de unicidade aborta a transação inteira: dentro dela, o próximo
 * comando falha com "current transaction is aborted", que não é P2002 e escapa
 * do `catch`. O resultado era 500 na segunda pessoa que criasse um formulário
 * com o mesmo título — e o retry parecia estar lá, funcionando.
 *
 * Encontrado pelo teste ponta a ponta, ao criar dois formulários sem título.
 */
export async function createForm(params: CreateFormParams) {
  const { subject } = params;
  const base = slugify(params.title) || 'formulario';
  let slug = isReservedSlug(base) ? withRandomSuffix(base) : base;

  for (let tentativa = 0; tentativa < 6; tentativa++) {
    try {
      return await withTenant(params.organizationId, async (ctx) => {
        // Enforcement ANTES da ação, no backend. A UI esconder o botão é
        // cortesia; quem impede a criação é esta linha (seção 6.2).
        await assertCanCreateForm(ctx);

        const definition = params.definition ? formSchema.parse(params.definition) : SCHEMA_INICIAL;
        assertSchemaFitsPlan(definition, await currentPlanCode(ctx));

        const form = await formsRepository.create(ctx, {
          createdBy: subject.userId,
          title: params.title.trim(),
          description: params.description?.trim() ?? null,
          slugPublic: slug,
          schemaJson: definition as unknown as Prisma.InputJsonValue,
          status: 'draft',
        });

        await auditLogsRepository.record(ctx, {
          actorUserId: subject.userId,
          action: 'form.created',
          resourceType: 'form',
          resourceId: form.id,
          metadataJson: { title: form.title },
        });

        return form;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        slug = withRandomSuffix(base);
        continue;
      }
      throw error;
    }
  }

  throw new AppError('internal_error', 'Não conseguimos criar o formulário agora. Tente de novo.');
}

export interface UpdateFormParams {
  ctx: TenantContext;
  subject: Subject;
  formId: string;
  /** Contador lido pelo cliente. Se não bater com o do banco, ninguém grava. */
  expectedRevision: number;
  title?: string;
  description?: string | null;
  definition?: unknown;
  theme?: unknown;
  settings?: {
    requiresLogin?: boolean;
    closesAt?: string | null;
    maxResponses?: number | null;
    responseRetentionDays?: number | null;
  };
}

/**
 * Grava alterações do builder.
 *
 * O lock otimista existe porque duas pessoas editando o mesmo formulário é
 * cenário comum numa agência: sem ele, quem salva por último apaga o trabalho
 * do outro sem que ninguém perceba. Com ele, o segundo recebe 409 e a chance
 * de recarregar.
 */
export async function updateForm(params: UpdateFormParams) {
  const { ctx, subject, formId } = params;
  const { form } = await loadFormFor(ctx, subject, formId, 'form:update');
  if (!form) throw notFound();

  if (form.revision !== params.expectedRevision) {
    throw conflict(
      'Alguém editou este formulário enquanto você trabalhava nele. Recarregue para ver a versão atual antes de salvar.',
    );
  }

  const data: Prisma.FormUncheckedUpdateInput = { revision: { increment: 1 } };

  if (params.title !== undefined) data.title = params.title.trim();
  if (params.description !== undefined) data.description = params.description?.trim() ?? null;

  if (params.definition !== undefined) {
    const definition = formSchema.parse(params.definition);
    assertSchemaFitsPlan(definition, await currentPlanCode(ctx));
    data.schemaJson = definition as unknown as Prisma.InputJsonValue;
  }

  if (params.theme !== undefined) {
    data.themeJson = themeSchema.parse(params.theme) as unknown as Prisma.InputJsonValue;
  }

  if (params.settings) {
    if (params.settings.requiresLogin !== undefined) data.requiresLogin = params.settings.requiresLogin;
    if (params.settings.closesAt !== undefined) {
      data.closesAt = params.settings.closesAt ? new Date(params.settings.closesAt) : null;
    }
    if (params.settings.maxResponses !== undefined) data.maxResponses = params.settings.maxResponses;
    if (params.settings.responseRetentionDays !== undefined) {
      data.responseRetentionDays = params.settings.responseRetentionDays;
    }
  }

  const atualizado = await ctx.tx.form.update({
    where: { id: formId, organizationId: ctx.organizationId },
    data,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'form.updated',
    resourceType: 'form',
    resourceId: formId,
    metadataJson: { revision: atualizado.revision },
  });

  return atualizado;
}

/**
 * Publica o formulário, congelando o schema numa `form_version`.
 *
 * As respostas guardam o número da versão com que foram enviadas. Sem isso,
 * editar um formulário reescreveria a interpretação das respostas antigas —
 * uma pergunta trocada faria a resposta de ontem significar outra coisa hoje.
 */
export async function publishForm(ctx: TenantContext, subject: Subject, formId: string) {
  const { form } = await loadFormFor(ctx, subject, formId, 'form:publish');
  if (!form) throw notFound();

  const definition = formSchema.parse(form.schemaJson);
  assertSchemaFitsPlan(definition, await currentPlanCode(ctx));

  const temCampos = definition.pages.some((page) => page.fields.length > 0);
  if (!temCampos) {
    throw validationError({ pages: ['Adicione pelo menos um campo antes de publicar.'] });
  }

  const proximaVersao = form.status === 'published' ? form.version + 1 : form.version;

  const publicado = await ctx.tx.form.update({
    where: { id: formId, organizationId: ctx.organizationId },
    data: { status: 'published', version: proximaVersao, revision: { increment: 1 } },
  });

  await formVersionsRepository.create(ctx, {
    formId,
    version: proximaVersao,
    schemaJson: definition as unknown as Prisma.InputJsonValue,
    publishedBy: subject.userId,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'form.published',
    resourceType: 'form',
    resourceId: formId,
    metadataJson: { version: proximaVersao },
  });

  return publicado;
}

/**
 * Arquiva. Nunca apaga.
 *
 * A copy da seção 11 promete: "Nada é apagado — formulários arquivados e
 * respostas continuam salvos". Arquivar tira o formulário do ar e libera a
 * vaga na contagem do plano, mantendo tudo acessível.
 */
export async function archiveForm(ctx: TenantContext, subject: Subject, formId: string) {
  const { form } = await loadFormFor(ctx, subject, formId, 'form:update');
  if (!form) throw notFound();

  const arquivado = await ctx.tx.form.update({
    where: { id: formId, organizationId: ctx.organizationId },
    data: { status: 'archived', revision: { increment: 1 } },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'form.archived',
    resourceType: 'form',
    resourceId: formId,
    metadataJson: {},
  });

  return arquivado;
}

export async function restoreForm(ctx: TenantContext, subject: Subject, formId: string) {
  const { form } = await loadFormFor(ctx, subject, formId, 'form:update');
  if (!form) throw notFound();

  return ctx.tx.form.update({
    where: { id: formId, organizationId: ctx.organizationId },
    data: { status: form.version > 0 ? 'published' : 'draft', revision: { increment: 1 } },
  });
}

/** Soft delete. As respostas continuam no banco até a purga por retenção. */
export async function deleteForm(ctx: TenantContext, subject: Subject, formId: string) {
  const { form } = await loadFormFor(ctx, subject, formId, 'form:delete');
  if (!form) throw notFound();

  await ctx.tx.form.update({
    where: { id: formId, organizationId: ctx.organizationId },
    data: { deletedAt: new Date(), status: 'archived', revision: { increment: 1 } },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'form.deleted',
    resourceType: 'form',
    resourceId: formId,
    metadataJson: { softDelete: true },
  });
}

/**
 * Duplica um formulário.
 *
 * A leitura acontece numa transação, e a criação abre a dela — não dá para
 * aninhar, porque `createForm` precisa de uma transação nova por tentativa de
 * slug. Entre uma e outra existe uma janela em que o original pode mudar; ela
 * é aceitável, porque o que sai é uma CÓPIA e ninguém espera que ela acompanhe
 * o original.
 */
export async function duplicateForm(organizationId: string, subject: Subject, formId: string) {
  const original = await withTenant(organizationId, async (ctx) => {
    const { form } = await loadFormFor(ctx, subject, formId, 'form:read');
    if (!form) throw notFound();
    return { title: form.title, description: form.description, schemaJson: form.schemaJson };
  });

  return createForm({
    organizationId,
    subject,
    title: `${original.title} (cópia)`,
    description: original.description ?? undefined,
    definition: original.schemaJson,
  });
}

/** Lista para o painel. Filtra pelo que o usuário pode ver, não pelo que existe. */
export async function listFormsFor(ctx: TenantContext, subject: Subject) {
  const forms = await ctx.tx.form.findMany({
    where: { organizationId: ctx.organizationId, deletedAt: null },
    include: {
      permissions: { where: { userId: subject.userId } },
      _count: { select: { responses: { where: { deletedAt: null } } } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  return forms
    .filter((form) =>
      can(subject, 'form:read', {
        kind: 'form',
        form: { id: form.id, createdBy: form.createdBy, explicitPermission: form.permissions[0]?.permission ?? null },
      }),
    )
    .map((form) => ({
      id: form.id,
      title: form.title,
      description: form.description,
      slugPublic: form.slugPublic,
      status: form.status,
      version: form.version,
      revision: form.revision,
      responseCount: form._count.responses,
      closesAt: form.closesAt,
      createdBy: form.createdBy,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
    }));
}
