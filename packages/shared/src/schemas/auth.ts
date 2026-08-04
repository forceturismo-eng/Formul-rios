import { z } from 'zod';
import { ROLES } from '../rbac.js';

/**
 * Schemas de autenticação compartilhados entre frontend e backend.
 * O frontend valida para dar feedback rápido; o backend valida porque é o
 * backend que decide. Mesmo schema nos dois lados, uma fonte só.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Informe um e-mail.')
  .max(254, 'E-mail longo demais.')
  .email('Esse e-mail não parece válido.');

/**
 * Política de senha: comprimento faz mais pelo cofre do que exigir símbolo.
 * A verificação contra listas de senhas vazadas acontece no servidor.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, 'Senha longa demais.')
  .refine((v) => !/^\s|\s$/.test(v), 'A senha não pode começar nem terminar com espaço.')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Combine letras e números.');

export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe o nome da empresa.')
  .max(120, 'Nome longo demais.');

export const personNameSchema = z.string().trim().min(2, 'Informe seu nome.').max(120, 'Nome longo demais.');

/** Registro cria a organização e o primeiro membro, sempre como `owner`. */
export const registerSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
  organizationName: organizationNameSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe sua senha.').max(PASSWORD_MAX_LENGTH),
  /**
   * Opcional: usuário que pertence a várias empresas pode escolher em qual
   * entrar. Se omitido, entra na mais recente. Este valor NÃO define o tenant
   * sozinho — o servidor confere se existe membership antes de emitir o token.
   */
  organizationId: z.string().uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

export const resendVerificationSchema = z.object({
  email: emailSchema,
});

export const switchOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((r) => r !== 'owner', 'Não é possível convidar alguém como owner.'),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  /** Necessários apenas quando o convidado ainda não tem conta. */
  name: personNameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const uuidParamSchema = z.object({ id: z.string().uuid() });
