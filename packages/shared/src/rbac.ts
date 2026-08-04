/**
 * Matriz de permissões — módulo único.
 *
 * Nenhum controller decide permissão por conta própria. Todo controller chama
 * `can()` ou `assertCan()`. Se uma regra nova precisa existir, ela nasce aqui.
 *
 * Papéis (seção 4 do documento de produto):
 *   owner   — tudo + billing + deletar organização + transferir posse
 *   admin   — membros, todos os formulários, configurações (sem billing)
 *   editor  — cria/edita os próprios formulários, vê respostas dos que tem acesso
 *   viewer  — somente leitura das respostas liberadas
 */

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const FORM_PERMISSIONS = ['edit', 'view', 'none'] as const;
export type FormPermission = (typeof FORM_PERMISSIONS)[number];

export const ACTIONS = [
  'org:read',
  'org:update',
  'org:delete',
  'org:transfer_ownership',

  'billing:read',
  'billing:manage',

  'member:read',
  'member:invite',
  'member:update_role',
  'member:remove',

  'form:create',
  'form:read',
  'form:update',
  'form:delete',
  'form:publish',
  'form:share',

  'response:read',
  'response:update',
  'response:delete',
  'response:export',

  'comment:create',
  'assignment:manage',

  'webhook:manage',
  'apikey:manage',
  'domain:manage',

  'ai:run',
  'ai:configure',

  'audit:read',
  'settings:update',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Quem está agindo. Sempre vem do contexto autenticado, nunca do request body. */
export interface Subject {
  userId: string;
  organizationId: string;
  role: Role;
}

/** Formulário reduzido ao que a decisão de permissão precisa saber. */
export interface FormRef {
  id: string;
  createdBy: string | null;
  /** Entrada de `form_permissions` para este usuário, se existir. */
  explicitPermission?: FormPermission | null;
}

export type Resource =
  | { kind: 'organization' }
  | { kind: 'form'; form: FormRef }
  /** Respostas, comentários, atribuições e análises herdam a permissão do formulário. */
  | { kind: 'form_child'; form: FormRef };

/**
 * Ações que cada papel pode exercer no escopo da organização, ignorando
 * permissões por formulário. As ações de formulário aparecem aqui como
 * "capacidade potencial"; o acesso real ao formulário é decidido em
 * `effectiveFormPermission()`.
 */
const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>(ACTIONS),

  admin: new Set<Action>([
    'org:read',
    'org:update',
    'member:read',
    'member:invite',
    'member:update_role',
    'member:remove',
    'form:create',
    'form:read',
    'form:update',
    'form:delete',
    'form:publish',
    'form:share',
    'response:read',
    'response:update',
    'response:delete',
    'response:export',
    'comment:create',
    'assignment:manage',
    'webhook:manage',
    'apikey:manage',
    'domain:manage',
    'ai:run',
    'ai:configure',
    'audit:read',
    'settings:update',
  ]),

  editor: new Set<Action>([
    'org:read',
    'member:read',
    'form:create',
    'form:read',
    'form:update',
    'form:delete',
    'form:publish',
    'response:read',
    'response:update',
    'response:export',
    'comment:create',
    'assignment:manage',
    'webhook:manage',
    'ai:run',
  ]),

  viewer: new Set<Action>(['org:read', 'member:read', 'form:read', 'response:read', 'comment:create']),
};

/** Ações que exigem `permission = 'edit'` no formulário. As demais aceitam `'view'`. */
const FORM_WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'form:update',
  'form:delete',
  'form:publish',
  'form:share',
  'response:update',
  'response:delete',
  'assignment:manage',
  'webhook:manage',
  'ai:run',
]);

/**
 * Permissão efetiva de um usuário sobre um formulário.
 *
 * Decisão de projeto: `form_permissions` sobrepõe o papel de `editor` e
 * `viewer`, mas NÃO tira acesso de `owner` e `admin`. Permitir que um editor
 * trave o dono fora de um formulário da própria empresa criaria dados órfãos
 * sem caminho de recuperação. Registrado em docs/adr/0003-rbac.md.
 */
export function effectiveFormPermission(subject: Subject, form: FormRef): FormPermission {
  if (subject.role === 'owner' || subject.role === 'admin') return 'edit';

  const explicit = form.explicitPermission;
  if (explicit) return explicit;

  if (subject.role === 'editor') {
    return form.createdBy === subject.userId ? 'edit' : 'none';
  }

  // viewer sem permissão explícita não enxerga o formulário.
  return 'none';
}

export function can(subject: Subject, action: Action, resource: Resource = { kind: 'organization' }): boolean {
  if (!ROLE_ACTIONS[subject.role].has(action)) return false;

  if (resource.kind === 'organization') return true;

  const permission = effectiveFormPermission(subject, resource.form);
  if (permission === 'none') return false;
  if (permission === 'edit') return true;

  // permission === 'view'
  return !FORM_WRITE_ACTIONS.has(action);
}

export class ForbiddenError extends Error {
  readonly action: Action;
  constructor(action: Action) {
    super(`Ação não permitida: ${action}`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

export function assertCan(subject: Subject, action: Action, resource: Resource = { kind: 'organization' }): void {
  if (!can(subject, action, resource)) throw new ForbiddenError(action);
}

/** Ordem de senioridade — usada para impedir que alguém promova acima de si. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function outranks(a: Role, b: Role): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

export function canAssignRole(subject: Subject, targetRole: Role): boolean {
  if (!can(subject, 'member:update_role')) return false;
  // Só o owner cria outro owner (via transferência de posse).
  if (targetRole === 'owner') return subject.role === 'owner';
  return ROLE_RANK[subject.role] >= ROLE_RANK[targetRole];
}
