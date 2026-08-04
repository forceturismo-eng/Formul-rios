import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertCan,
  can,
  canAssignRole,
  downgradeBloqueado,
  findPlan,
  getPlan,
  inviteMemberSchema,
  PLANS,
} from '@forms/shared';
import { getAuth, requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { conflict, forbidden, notFound } from '../http/errors.js';
import {
  auditLogsRepository,
  invitationsRepository,
  membershipsRepository,
  organizationsRepository,
} from '../db/repositories.js';
import { generateOpaqueToken, hashToken } from '../auth/hashing.js';
import { invitationEmail, sendMail } from '../mail/mailer.js';
import { assertCanAddMember, checkDowngrade, usageSummary } from '../services/usage-service.js';

const INVITATION_TTL_DAYS = 7;

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.')
    .optional(),
  logoUrl: z.string().url().max(2048).optional(),
  faviconUrl: z.string().url().max(2048).optional(),
});

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/organizations/current', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'org:read');

    const organization = await withRequestTenant(request, (ctx) => organizationsRepository.findCurrent(ctx));
    if (!organization) throw notFound();

    const plan = getPlan(organization.planCode as never);

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logoUrl: organization.logoUrl,
      primaryColor: organization.primaryColor,
      faviconUrl: organization.faviconUrl,
      planCode: organization.planCode,
      subscriptionStatus: organization.subscriptionStatus,
      trialEndsAt: organization.trialEndsAt,
      aiConsentAt: organization.aiConsentAt,
      plan: { code: plan.code, name: plan.name, limits: plan.limits, features: plan.features },
      role: subject.role,
    };
  });

  app.patch('/organizations/current', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'org:update');

    const input = updateOrganizationSchema.parse(request.body);

    return withRequestTenant(request, async (ctx) => {
      const updated = await organizationsRepository.update(ctx, input);
      await auditLogsRepository.record(ctx, {
        actorUserId: subject.userId,
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: ctx.organizationId,
        metadataJson: { fields: Object.keys(input) },
      });
      return { id: updated.id, name: updated.name, slug: updated.slug, primaryColor: updated.primaryColor };
    });
  });

  app.get('/members', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'member:read');

    const members = await withRequestTenant(request, (ctx) => membershipsRepository.list(ctx));
    return {
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        acceptedAt: m.acceptedAt,
        createdAt: m.createdAt,
        user: m.user,
      })),
    };
  });

  app.get('/invitations', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'member:read');

    const invitations = await withRequestTenant(request, (ctx) => invitationsRepository.list(ctx));
    return {
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    };
  });

  app.post('/invitations', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    const auth = getAuth(request);
    if (!can(subject, 'member:invite')) throw forbidden();

    const input = inviteMemberSchema.parse(request.body);
    if (!canAssignRole(subject, input.role)) {
      throw forbidden('Você não pode convidar alguém com um papel acima do seu.');
    }

    // O token em claro existe nesta variável e no e-mail. O banco guarda o hash.
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    const result = await withRequestTenant(request, async (ctx) => {
      // Convite pendente já ocupa uma vaga: senão daria para convidar trinta
      // pessoas num plano de três e deixar o limite estourar no aceite.
      await assertCanAddMember(ctx);

      const organization = await organizationsRepository.findCurrent(ctx);
      if (!organization) throw notFound();

      const existingMember = await ctx.tx.membership.findFirst({
        where: { organizationId: ctx.organizationId, user: { email: input.email } },
      });
      if (existingMember) throw conflict('Essa pessoa já faz parte da empresa.');

      const pending = await ctx.tx.invitation.findFirst({
        where: { organizationId: ctx.organizationId, email: input.email, acceptedAt: null, expiresAt: { gt: new Date() } },
      });
      if (pending) throw conflict('Já existe um convite em aberto para esse e-mail.');

      const invitation = await invitationsRepository.create(ctx, {
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt,
        invitedBy: auth.userId,
      });

      await auditLogsRepository.record(ctx, {
        actorUserId: auth.userId,
        action: 'invitation.created',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadataJson: { role: input.role },
      });

      const inviter = await ctx.tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { name: true },
      });

      return { invitation, organizationName: organization.name, inviterName: inviter.name };
    });

    await sendMail(
      invitationEmail({
        to: input.email,
        organizationName: result.organizationName,
        inviterName: result.inviterName,
        token,
      }),
    );

    return reply.status(201).send({
      id: result.invitation.id,
      email: result.invitation.email,
      role: result.invitation.role,
      expiresAt: result.invitation.expiresAt,
    });
  });

  /**
   * Uso do ciclo vigente.
   *
   * É o que alimenta os banners de 80%, de buffer e de conta suspensa. Vem com
   * os avisos já calculados para que frontend e e-mail não reimplementem a
   * mesma regra de formas ligeiramente diferentes.
   */
  app.get('/usage', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'org:read');

    return withRequestTenant(request, (ctx) => usageSummary(ctx));
  });

  /**
   * O que impede a troca para um plano menor.
   *
   * A tela chama isto ANTES de oferecer o downgrade, para mostrar o checklist
   * em vez de deixar o cliente descobrir no meio do checkout. Nada é apagado
   * automaticamente — a lista é para ele decidir.
   */
  app.get('/plans/:code/downgrade-check', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'billing:read');

    const { code } = z.object({ code: z.string().max(40) }).parse(request.params);
    if (!findPlan(code)) throw notFound();

    const blockers = await withRequestTenant(request, (ctx) => checkDowngrade(ctx, code));

    return {
      targetPlanCode: code,
      allowed: blockers.length === 0,
      blockers,
      copy: blockers.length > 0 ? downgradeBloqueado({ targetPlanCode: code, blockers }) : null,
    };
  });

  app.get('/audit-logs', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'audit:read');

    const logs = await withRequestTenant(request, (ctx) => auditLogsRepository.list(ctx, 100));
    return { logs };
  });
}

/** Catálogo público de planos. Não exige autenticação — é a página de preços. */
export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.get('/plans', async () => ({
    plans: PLANS.filter((plan) => plan.isPublic).map((plan) => ({
      code: plan.code,
      name: plan.name,
      tagline: plan.tagline,
      priceMonthlyCents: plan.priceMonthlyCents,
      priceYearlyCents: plan.priceYearlyCents,
      isHighlighted: plan.isHighlighted ?? false,
      isContactSales: plan.isContactSales ?? false,
      trialDays: plan.trialDays,
      allowedBillingTypes: plan.allowedBillingTypes,
      boletoCycles: plan.boletoCycles,
      limits: plan.limits,
      features: plan.features,
      sortOrder: plan.sortOrder,
    })),
  }));
}
