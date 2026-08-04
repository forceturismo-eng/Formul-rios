import type { Prisma } from '@prisma/client';
import type { TenantContext } from './tenant.js';

/**
 * Camada 4 do isolamento: repositórios.
 *
 * Nenhum controller fala com o Prisma direto. Todo acesso a dado de negócio
 * passa por aqui, e toda função recebe um `TenantContext` — ou seja, já chega
 * amarrada a uma organização.
 *
 * O `organizationId` aparece explicitamente nos `where` mesmo com o RLS ligado.
 * É redundante de propósito: se um dia alguém rodar a aplicação com um papel
 * que tenha BYPASSRLS, ou esquecer o `FORCE` numa tabela nova, a filtragem da
 * aplicação continua de pé. Redundância aqui custa uma coluna a mais no índice
 * e paga um vazamento inteiro.
 */

// -----------------------------------------------------------------------------
// Organização e membros
// -----------------------------------------------------------------------------

export const organizationsRepository = {
  findCurrent(ctx: TenantContext) {
    return ctx.tx.organization.findFirst({
      where: { id: ctx.organizationId, deletedAt: null },
    });
  },

  create(ctx: TenantContext, data: Omit<Prisma.OrganizationUncheckedCreateInput, 'id'>) {
    // O id vem do contexto: a organização criada É o tenant da transação.
    return ctx.tx.organization.create({ data: { ...data, id: ctx.organizationId } });
  },

  update(ctx: TenantContext, data: Prisma.OrganizationUncheckedUpdateInput) {
    return ctx.tx.organization.update({ where: { id: ctx.organizationId }, data });
  },
};

export const membershipsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.membership.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    });
  },

  findByUser(ctx: TenantContext, userId: string) {
    return ctx.tx.membership.findFirst({ where: { userId, organizationId: ctx.organizationId } });
  },

  list(ctx: TenantContext) {
    return ctx.tx.membership.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  },

  count(ctx: TenantContext) {
    return ctx.tx.membership.count({ where: { organizationId: ctx.organizationId } });
  },

  create(ctx: TenantContext, data: Omit<Prisma.MembershipUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.membership.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const invitationsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.invitation.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },

  list(ctx: TenantContext) {
    return ctx.tx.invitation.findMany({
      where: { organizationId: ctx.organizationId, acceptedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  },

  create(ctx: TenantContext, data: Omit<Prisma.InvitationUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.invitation.create({ data: { ...data, organizationId: ctx.organizationId } });
  },

  markAccepted(ctx: TenantContext, id: string) {
    return ctx.tx.invitation.update({
      where: { id, organizationId: ctx.organizationId },
      data: { acceptedAt: new Date() },
    });
  },
};

// -----------------------------------------------------------------------------
// Sessões
// -----------------------------------------------------------------------------

export const refreshTokensRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.refreshToken.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },

  create(ctx: TenantContext, data: Omit<Prisma.RefreshTokenUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.refreshToken.create({ data: { ...data, organizationId: ctx.organizationId } });
  },

  revoke(ctx: TenantContext, id: string, replacedBy?: string) {
    return ctx.tx.refreshToken.update({
      where: { id, organizationId: ctx.organizationId },
      data: { revokedAt: new Date(), ...(replacedBy ? { replacedBy } : {}) },
    });
  },

  /**
   * Revoga a família inteira de uma sessão.
   * Chamado quando um token já substituído é reapresentado: ou o cookie vazou,
   * ou alguém está replicando requests. Nos dois casos a sessão acabou.
   */
  revokeFamily(ctx: TenantContext, familyId: string) {
    return ctx.tx.refreshToken.updateMany({
      where: { familyId, organizationId: ctx.organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};

// -----------------------------------------------------------------------------
// Formulários e respostas
// -----------------------------------------------------------------------------

export const formsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.form.findFirst({ where: { id, organizationId: ctx.organizationId, deletedAt: null } });
  },

  /** Formulário + a permissão explícita de um usuário sobre ele, se houver. */
  async findByIdForUser(ctx: TenantContext, id: string, userId: string) {
    const form = await ctx.tx.form.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      include: { permissions: { where: { userId } } },
    });
    if (!form) return null;
    return { form, explicitPermission: form.permissions[0]?.permission ?? null };
  },

  list(ctx: TenantContext) {
    return ctx.tx.form.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  },

  count(ctx: TenantContext) {
    return ctx.tx.form.count({ where: { organizationId: ctx.organizationId, deletedAt: null } });
  },

  create(ctx: TenantContext, data: Omit<Prisma.FormUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.form.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const formVersionsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.formVersion.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  listByForm(ctx: TenantContext, formId: string) {
    return ctx.tx.formVersion.findMany({
      where: { formId, organizationId: ctx.organizationId },
      orderBy: { version: 'desc' },
    });
  },
  create(ctx: TenantContext, data: Omit<Prisma.FormVersionUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.formVersion.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const formPermissionsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.formPermission.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  upsert(ctx: TenantContext, formId: string, userId: string, permission: 'edit' | 'view' | 'none') {
    return ctx.tx.formPermission.upsert({
      where: { formId_userId: { formId, userId } },
      create: { organizationId: ctx.organizationId, formId, userId, permission },
      update: { permission },
    });
  },
};

export const responsesRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.response.findFirst({ where: { id, organizationId: ctx.organizationId, deletedAt: null } });
  },
  countInPeriod(ctx: TenantContext, from: Date, to: Date) {
    return ctx.tx.response.count({
      where: { organizationId: ctx.organizationId, createdAt: { gte: from, lt: to } },
    });
  },
  create(ctx: TenantContext, data: Omit<Prisma.ResponseUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.response.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const filesRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.file.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.FileUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.file.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const commentsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.comment.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.CommentUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.comment.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const assignmentsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.assignment.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.AssignmentUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.assignment.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const aiAnalysesRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.aiAnalysis.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.AiAnalysisUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.aiAnalysis.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

// -----------------------------------------------------------------------------
// Integrações e cobrança
// -----------------------------------------------------------------------------

export const webhooksRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.webhook.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.WebhookUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.webhook.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const apiKeysRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.apiKey.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.ApiKeyUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.apiKey.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const customDomainsRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.customDomain.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  create(ctx: TenantContext, data: Omit<Prisma.CustomDomainUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.customDomain.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

export const invoicesRepository = {
  findById(ctx: TenantContext, id: string) {
    return ctx.tx.invoice.findFirst({ where: { id, organizationId: ctx.organizationId } });
  },
  list(ctx: TenantContext) {
    return ctx.tx.invoice.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { dueDate: 'desc' },
    });
  },
  create(ctx: TenantContext, data: Omit<Prisma.InvoiceUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.invoice.create({ data: { ...data, organizationId: ctx.organizationId } });
  },
};

// -----------------------------------------------------------------------------
// Auditoria
// -----------------------------------------------------------------------------

export const auditLogsRepository = {
  /**
   * Append-only. Não existe `update` nem `delete` aqui, e o papel de runtime
   * também não tem esses privilégios no banco (ver migration de RLS).
   */
  record(ctx: TenantContext, data: Omit<Prisma.AuditLogUncheckedCreateInput, 'organizationId'>) {
    return ctx.tx.auditLog.create({ data: { ...data, organizationId: ctx.organizationId } });
  },

  list(ctx: TenantContext, limit = 100) {
    return ctx.tx.auditLog.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};
