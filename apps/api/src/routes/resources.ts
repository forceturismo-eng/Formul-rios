import type { FastifyInstance } from 'fastify';
import { can, type Action, type FormRef } from '@forms/shared';
import { getAuth, requireAuth, subjectOf, withRequestTenant } from '../http/context.js';
import { forbidden, notFound } from '../http/errors.js';
import type { TenantContext } from '../db/tenant.js';
import {
  aiAnalysesRepository,
  apiKeysRepository,
  assignmentsRepository,
  commentsRepository,
  customDomainsRepository,
  filesRepository,
  formVersionsRepository,
  formsRepository,
  invitationsRepository,
  invoicesRepository,
  membershipsRepository,
  responsesRepository,
  webhooksRepository,
} from '../db/repositories.js';

/**
 * Leitura por ID de cada recurso da plataforma.
 *
 * Estas rotas são a base sobre a qual as Fases 2 a 4 constroem o CRUD, e são
 * também o que a suíte de isolamento ataca: para CADA recurso listado aqui, o
 * teste autentica na empresa A e pede o ID de um recurso da empresa B.
 *
 * A resposta é sempre 404 — nunca 403 — quando o recurso não pertence ao
 * tenant. Um 403 diria "existe, mas não é seu", e isso já é informação.
 *
 * Os handlers são gerados a partir de uma lista de descritores em vez de
 * escritos treze vezes. Não é abstração por elegância: treze cópias do mesmo
 * handler é treze lugares onde alguém esquece a checagem de permissão.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResourceDescriptor<TRow> {
  /** Segmento da URL: /v1/forms/:id */
  path: string;
  action: Action;
  load(ctx: TenantContext, id: string): Promise<TRow | null>;
  /**
   * Recursos que vivem dentro de um formulário herdam a permissão dele.
   * Devolve o `formId` que governa o acesso, ou `null` para recursos que são
   * da organização como um todo.
   */
  formIdOf?(row: TRow): string | null;
  serialize(row: TRow): Record<string, unknown>;
}

function descriptor<TRow>(d: ResourceDescriptor<TRow>): ResourceDescriptor<unknown> {
  return d as unknown as ResourceDescriptor<unknown>;
}

const RESOURCES: ReadonlyArray<ResourceDescriptor<unknown>> = [
  descriptor({
    path: 'forms',
    action: 'form:read',
    load: (ctx, id) => formsRepository.findById(ctx, id),
    formIdOf: (row) => row.id,
    serialize: (row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      slugPublic: row.slugPublic,
      status: row.status,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  }),

  descriptor({
    path: 'form-versions',
    action: 'form:read',
    load: (ctx, id) => formVersionsRepository.findById(ctx, id),
    formIdOf: (row) => row.formId,
    serialize: (row) => ({
      id: row.id,
      formId: row.formId,
      version: row.version,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'responses',
    action: 'response:read',
    load: (ctx, id) => responsesRepository.findById(ctx, id),
    formIdOf: (row) => row.formId,
    // O conteúdo em si é cifrado e só é decifrado na tela de recebimentos
    // (Fase 2). Aqui vai só o metadado — nunca o blob.
    serialize: (row) => ({
      id: row.id,
      formId: row.formId,
      formVersion: row.formVersion,
      status: row.status,
      isFlagged: row.isFlagged,
      isBuffered: row.isBuffered,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'files',
    action: 'response:read',
    load: (ctx, id) => filesRepository.findById(ctx, id),
    formIdOf: () => null,
    serialize: (row) => ({
      id: row.id,
      responseId: row.responseId,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      scanStatus: row.scanStatus,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'comments',
    action: 'response:read',
    load: (ctx, id) => commentsRepository.findById(ctx, id),
    formIdOf: () => null,
    serialize: (row) => ({
      id: row.id,
      responseId: row.responseId,
      userId: row.userId,
      body: row.body,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'assignments',
    action: 'response:read',
    load: (ctx, id) => assignmentsRepository.findById(ctx, id),
    formIdOf: () => null,
    serialize: (row) => ({
      id: row.id,
      responseId: row.responseId,
      assigneeId: row.assigneeId,
      status: row.status,
      dueAt: row.dueAt,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'ai-analyses',
    action: 'form:read',
    load: (ctx, id) => aiAnalysesRepository.findById(ctx, id),
    formIdOf: (row) => row.formId,
    serialize: (row) => ({
      id: row.id,
      formId: row.formId,
      type: row.type,
      model: row.model,
      resultJson: row.resultJson,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'members',
    action: 'member:read',
    load: (ctx, id) => membershipsRepository.findById(ctx, id),
    serialize: (row) => ({
      id: row.id,
      role: row.role,
      acceptedAt: row.acceptedAt,
      createdAt: row.createdAt,
      user: row.user,
    }),
  }),

  descriptor({
    path: 'invitations',
    action: 'member:read',
    load: (ctx, id) => invitationsRepository.findById(ctx, id),
    // `tokenHash` nunca sai daqui: com ele dá para aceitar o convite.
    serialize: (row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'webhooks',
    action: 'webhook:manage',
    load: (ctx, id) => webhooksRepository.findById(ctx, id),
    formIdOf: (row) => row.formId,
    // `secret` é a chave do HMAC de saída. Não é exibível.
    serialize: (row) => ({
      id: row.id,
      formId: row.formId,
      url: row.url,
      events: row.events,
      isActive: row.isActive,
      lastStatus: row.lastStatus,
      failureCount: row.failureCount,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'api-keys',
    action: 'apikey:manage',
    load: (ctx, id) => apiKeysRepository.findById(ctx, id),
    // `keyHash` fica no banco. O segredo em claro aparece uma vez, na criação.
    serialize: (row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'custom-domains',
    action: 'domain:manage',
    load: (ctx, id) => customDomainsRepository.findById(ctx, id),
    serialize: (row) => ({
      id: row.id,
      domain: row.domain,
      type: row.type,
      status: row.status,
      verificationToken: row.verificationToken,
      dnsLastCheckedAt: row.dnsLastCheckedAt,
      dnsError: row.dnsError,
      certExpiresAt: row.certExpiresAt,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt,
    }),
  }),

  descriptor({
    path: 'invoices',
    action: 'billing:read',
    load: (ctx, id) => invoicesRepository.findById(ctx, id),
    serialize: (row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      amountCents: row.amountCents,
      status: row.status,
      billingType: row.billingType,
      dueDate: row.dueDate,
      paidAt: row.paidAt,
      boletoUrl: row.boletoUrl,
      nfseUrl: row.nfseUrl,
      createdAt: row.createdAt,
    }),
  }),
];

/** Nomes de rota expostos, para a suíte de isolamento varrer sem duplicar a lista. */
export const RESOURCE_PATHS: readonly string[] = RESOURCES.map((r) => r.path);

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  for (const resource of RESOURCES) {
    app.get(`/${resource.path}/:id`, async (request, reply) => {
      const { id } = request.params as { id: string };
      // ID malformado responde igual a ID inexistente. Distinguir os dois daria
      // ao atacante um sinal de que o formato certo levaria a algum lugar.
      if (!UUID_RE.test(id)) throw notFound();

      const subject = subjectOf(request);
      const auth = getAuth(request);

      const row = await withRequestTenant(request, async (ctx) => {
        const found = await resource.load(ctx, id);
        if (!found) return null;

        // Recurso da organização como um todo: basta o papel permitir a ação.
        if (!resource.formIdOf) {
          return can(subject, resource.action) ? found : 'forbidden';
        }

        const formId = resource.formIdOf(found);
        if (!formId) {
          return can(subject, resource.action) ? found : 'forbidden';
        }

        const scoped = await formsRepository.findByIdForUser(ctx, formId, auth.userId);
        if (!scoped) return null;

        const formRef: FormRef = {
          id: scoped.form.id,
          createdBy: scoped.form.createdBy,
          explicitPermission: scoped.explicitPermission,
        };

        // Sem acesso ao formulário, o recurso filho não existe para este
        // usuário — 404, e não 403, para não revelar que ele existe.
        return can(subject, resource.action, { kind: 'form_child', form: formRef }) ? found : null;
      });

      if (row === null) throw notFound();
      if (row === 'forbidden') throw forbidden();

      return reply.send(resource.serialize(row));
    });
  }
}
