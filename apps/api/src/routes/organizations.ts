import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertCan,
  can,
  canAssignRole,
  describeActivity,
  CSS_TAMANHO_MAXIMO,
  downgradeBloqueado,
  findPlan,
  getPlan,
  inviteMemberSchema,
  PLANS,
  sanitizeCustomCss,
} from '@forms/shared';
import { getAuth, requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { conflict, forbidden, notFound } from '../http/errors.js';
import {
  auditLogsRepository,
  invitationsRepository,
  organizationsRepository,
} from '../db/repositories.js';
import { generateOpaqueToken, hashToken } from '../auth/hashing.js';
import { invitationEmail, sendMail } from '../mail/mailer.js';
import { assertCanAddMember, checkDowngrade, usageSummary } from '../services/usage-service.js';
import { loadBranding, updateBranding } from '../services/branding-service.js';
import {
  changeMemberRole,
  listInvitations,
  listMembers,
  parseRole,
  removeMember,
  revokeInvitation,
} from '../services/members-service.js';

const INVITATION_TTL_DAYS = 7;

const uuidParam = z.object({ id: z.string().uuid() });

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.')
    .optional(),
  logoUrl: z.string().url().max(2048).optional(),
  faviconUrl: z.string().url().max(2048).optional(),
});

/**
 * White-label.
 *
 * `nullable` em tudo de propósito: limpar o logo é mandar `null`, e sem isso
 * não haveria como voltar ao padrão depois de definir um.
 */
const brandingSchema = z.object({
  logoUrl: z.string().max(2048).nullable().optional(),
  faviconUrl: z.string().max(2048).nullable().optional(),
  ogImageUrl: z.string().max(2048).nullable().optional(),
  primaryColor: z.string().max(9).nullable().optional(),
  metaTitle: z.string().max(120).nullable().optional(),
  metaDescription: z.string().max(200).nullable().optional(),
  customCss: z.string().max(CSS_TAMANHO_MAXIMO).nullable().optional(),
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
      // O banner permanente da seção 5.5 sai daqui. Vem do servidor e não do
      // token decodificado na tela: um banner que a tela pode escolher não
      // desenhar não é garantia nenhuma.
      impersonation: getAuth(request).impersonation ?? null,
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

  // ---------------------------------------------------------------------------
  // White-label
  // ---------------------------------------------------------------------------

  app.get('/branding', async (request) => {
    assertCan(subjectOf(request), 'org:read');
    return withRequestTenant(request, (ctx) => loadBranding(ctx));
  });

  app.patch('/branding', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'org:update');

    const entrada = brandingSchema.parse(request.body);
    return withRequestTenant(request, (ctx) => updateBranding(ctx, subject, entrada));
  });

  /**
   * Prévia do CSS: mostra o que sobra da folha ANTES de gravar.
   *
   * Sem isso, o cliente escreve uma regra, salva, e descobre que ela sumiu sem
   * saber por quê. A lista de removidos é a explicação.
   */
  app.post('/branding/preview-css', async (request) => {
    assertCan(subjectOf(request), 'org:update');

    const { css } = z.object({ css: z.string().max(50_000) }).parse(request.body);
    const resultado = sanitizeCustomCss(css);

    return { css: resultado.css, removidos: resultado.removidos };
  });

  app.get('/members', async (request) => {
    const subject = subjectOf(request);
    return { members: await withRequestTenant(request, (ctx) => listMembers(ctx, subject)) };
  });

  /**
   * Troca o papel de alguém.
   *
   * Duas travas, e as duas são de escalada de privilégio: ninguém dá um papel
   * acima do próprio, e ninguém mexe em quem está acima. A terceira é de
   * operação: o último dono não pode ser rebaixado, senão a empresa fica sem
   * quem a administre.
   */
  app.patch('/members/:id', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);
    const { role } = z.object({ role: z.string() }).parse(request.body);

    const atualizado = await withRequestTenant(request, (ctx) =>
      changeMemberRole(ctx, subject, id, parseRole(role)),
    );

    return { id: atualizado.id, role: atualizado.role };
  });

  /** Remove alguém — ou sai, quando é a própria pessoa. */
  app.delete('/members/:id', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    return withRequestTenant(request, (ctx) => removeMember(ctx, subject, id));
  });

  app.delete('/invitations/:id', async (request) => {
    const subject = subjectOf(request);
    const { id } = uuidParam.parse(request.params);

    return withRequestTenant(request, (ctx) => revokeInvitation(ctx, subject, id));
  });

  /**
   * Feed de atividades.
   *
   * O mesmo audit log da rota `/audit-logs`, traduzido para linguagem de gente
   * e sem o ruído que ninguém lê (login, refresh, troca de empresa). As
   * entradas que a plataforma gravou vêm marcadas: o cliente tem direito de ver
   * o que fizemos na conta dele, no mesmo lugar em que vê o que a equipe fez.
   */
  app.get('/activity', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'member:read');

    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(60) })
      .parse(request.query);

    const entradas = await withRequestTenant(request, async (ctx) => {
      // Busca mais do que o pedido porque parte será descartada na tradução.
      const logs = await auditLogsRepository.list(ctx, query.limit * 3);

      const autores = await ctx.tx.user.findMany({
        where: { id: { in: [...new Set(logs.map((l) => l.actorUserId).filter((id): id is string => id !== null))] } },
        select: { id: true, name: true },
      });
      const nomePorId = new Map(autores.map((autor) => [autor.id, autor.name]));

      return logs
        .map((log) => {
          const descrito = describeActivity(log.action, (log.metadataJson ?? {}) as Record<string, unknown>);
          if (!descrito) return null;

          return {
            id: log.id,
            texto: descrito.texto,
            categoria: descrito.categoria,
            daPlataforma: descrito.daPlataforma === true,
            // Sem autor quando a ação foi da plataforma ou de um processo.
            autor: log.actorUserId ? (nomePorId.get(log.actorUserId) ?? 'Alguém') : null,
            createdAt: log.createdAt,
          };
        })
        .filter((entrada): entrada is NonNullable<typeof entrada> => entrada !== null)
        .slice(0, query.limit);
    });

    return { activity: entradas };
  });

  app.get('/invitations', async (request) => {
    const subject = subjectOf(request);
    return { invitations: await withRequestTenant(request, (ctx) => listInvitations(ctx, subject)) };
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
