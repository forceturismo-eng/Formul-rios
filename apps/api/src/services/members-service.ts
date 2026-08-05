import { assertCan, canAssignRole, outranks, type Role, type Subject } from '@forms/shared';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository, membershipsRepository } from '../db/repositories.js';
import { AppError, conflict, forbidden, notFound, validationError } from '../http/errors.js';

/**
 * Gestão de quem tem acesso à empresa.
 *
 * A regra que organiza este arquivo: **uma empresa nunca fica sem owner**.
 * Rebaixar o último, removê-lo ou deixá-lo sair transformaria a conta numa que
 * ninguém consegue administrar — e a recuperação passaria por nós, manualmente,
 * caso a caso.
 *
 * A segunda regra é que ninguém promove alguém acima de si (`canAssignRole`),
 * nem mexe em quem está acima (`outranks`). As duas juntas impedem a escalada
 * de privilégio dentro da própria empresa.
 */

/** Quantos owners ativos a empresa tem. */
async function contarOwners(ctx: TenantContext): Promise<number> {
  return ctx.tx.membership.count({
    where: { organizationId: ctx.organizationId, role: 'owner', acceptedAt: { not: null } },
  });
}

export async function listMembers(ctx: TenantContext, subject: Subject) {
  assertCan(subject, 'member:read');

  const membros = await membershipsRepository.list(ctx);

  return membros.map((membro) => ({
    id: membro.id,
    role: membro.role,
    acceptedAt: membro.acceptedAt,
    createdAt: membro.createdAt,
    user: { id: membro.user.id, name: membro.user.name, email: membro.user.email },
    /** `true` para a própria pessoa: a tela usa isso para não oferecer "remover". */
    isSelf: membro.user.id === subject.userId,
  }));
}

export async function changeMemberRole(
  ctx: TenantContext,
  subject: Subject,
  membershipId: string,
  novoPapel: Role,
) {
  assertCan(subject, 'member:update_role');

  const membro = await membershipsRepository.findById(ctx, membershipId);
  if (!membro) throw notFound();

  // Ninguém promove alguém acima de si — nem a si mesmo.
  if (!canAssignRole(subject, novoPapel)) {
    throw forbidden('Você não pode dar um papel acima do seu.');
  }

  // Nem mexe em quem está acima. Sem isto, um admin rebaixaria o owner e
  // assumiria a empresa.
  if (outranks(membro.role as Role, subject.role)) {
    throw forbidden('Você não pode alterar o papel de alguém acima de você.');
  }

  if (membro.role === novoPapel) return membro;

  // O último owner não pode ser rebaixado. É o caso que transforma a conta numa
  // que ninguém administra — e a saída seria um chamado para nós.
  if (membro.role === 'owner' && novoPapel !== 'owner' && (await contarOwners(ctx)) <= 1) {
    throw new AppError(
      'conflict',
      'Esta é a única pessoa com papel de dono. Promova outra antes de mudar o papel desta.',
    );
  }

  const atualizado = await ctx.tx.membership.update({
    where: { id: membro.id, organizationId: ctx.organizationId },
    data: { role: novoPapel },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'member.role_changed',
    resourceType: 'membership',
    resourceId: membro.id,
    metadataJson: { from: membro.role, to: novoPapel },
  });

  return atualizado;
}

export async function removeMember(ctx: TenantContext, subject: Subject, membershipId: string) {
  const membro = await membershipsRepository.findById(ctx, membershipId);
  if (!membro) throw notFound();

  const saindoSozinho = membro.userId === subject.userId;

  // Sair da empresa é direito de qualquer pessoa; remover OUTRA exige permissão.
  if (!saindoSozinho) {
    assertCan(subject, 'member:remove');

    if (outranks(membro.role as Role, subject.role)) {
      throw forbidden('Você não pode remover alguém acima de você.');
    }
  }

  if (membro.role === 'owner' && (await contarOwners(ctx)) <= 1) {
    throw new AppError(
      'conflict',
      saindoSozinho
        ? 'Você é a única pessoa com papel de dono. Promova outra antes de sair.'
        : 'Esta é a única pessoa com papel de dono. Promova outra antes de removê-la.',
    );
  }

  await ctx.tx.membership.delete({ where: { id: membro.id, organizationId: ctx.organizationId } });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: saindoSozinho ? 'member.left' : 'member.removed',
    resourceType: 'membership',
    resourceId: membro.id,
    // Sem e-mail nem nome: o audit log não é lugar de dado pessoal, e o id da
    // membership basta para reconstruir quem era numa investigação.
    metadataJson: { role: membro.role },
  });

  return { removed: true, self: saindoSozinho };
}

export async function revokeInvitation(ctx: TenantContext, subject: Subject, invitationId: string) {
  assertCan(subject, 'member:invite');

  const convite = await ctx.tx.invitation.findFirst({
    where: { id: invitationId, organizationId: ctx.organizationId },
  });
  if (!convite) throw notFound();

  if (convite.acceptedAt) {
    throw conflict('Este convite já foi aceito. Remova a pessoa pela lista de membros.');
  }

  // Apaga em vez de marcar: um convite revogado não tem uso posterior, e o
  // token dele deixa de existir junto — que é o ponto.
  await ctx.tx.invitation.delete({ where: { id: convite.id, organizationId: ctx.organizationId } });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'invitation.revoked',
    resourceType: 'invitation',
    resourceId: invitationId,
    metadataJson: { role: convite.role },
  });

  return { revoked: true };
}

/**
 * Convites pendentes, com o estado que a tela precisa mostrar.
 *
 * Um convite expirado continua listado de propósito: quem administra precisa
 * ver que a pessoa não entrou, e o caminho é revogar e convidar de novo.
 */
export async function listInvitations(ctx: TenantContext, subject: Subject) {
  assertCan(subject, 'member:read');

  const convites = await ctx.tx.invitation.findMany({
    where: { organizationId: ctx.organizationId, acceptedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const agora = new Date();

  return convites.map((convite) => ({
    id: convite.id,
    email: convite.email,
    role: convite.role,
    expiresAt: convite.expiresAt,
    createdAt: convite.createdAt,
    expired: convite.expiresAt <= agora,
  }));
}

/** Valida o papel vindo do corpo do request. */
export function parseRole(valor: unknown): Role {
  const papeis: Role[] = ['owner', 'admin', 'editor', 'viewer'];
  if (typeof valor !== 'string' || !papeis.includes(valor as Role)) {
    throw validationError({ role: ['Papel desconhecido.'] });
  }
  return valor as Role;
}
