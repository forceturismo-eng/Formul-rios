import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  can,
  canAssignRole,
  effectiveFormPermission,
  outranks,
  type FormRef,
  type Role,
  type Subject,
} from '@forms/shared';

/** Matriz de permissões — seção 4 do documento de produto. */

const ORG = '11111111-1111-4111-8111-111111111111';

const subject = (role: Role, userId = 'user-1'): Subject => ({ userId, organizationId: ORG, role });

const form = (createdBy: string | null, explicitPermission: FormRef['explicitPermission'] = null): FormRef => ({
  id: 'form-1',
  createdBy,
  explicitPermission,
});

describe('papéis no escopo da organização', () => {
  it('owner faz tudo', () => {
    for (const action of ACTIONS) {
      expect(can(subject('owner'), action), action).toBe(true);
    }
  });

  it('admin faz tudo menos billing, deletar a empresa e transferir posse', () => {
    const admin = subject('admin');
    expect(can(admin, 'member:invite')).toBe(true);
    expect(can(admin, 'settings:update')).toBe(true);
    expect(can(admin, 'domain:manage')).toBe(true);

    expect(can(admin, 'billing:read')).toBe(false);
    expect(can(admin, 'billing:manage')).toBe(false);
    expect(can(admin, 'org:delete')).toBe(false);
    expect(can(admin, 'org:transfer_ownership')).toBe(false);
  });

  it('editor não administra membros nem chaves de API', () => {
    const editor = subject('editor');
    expect(can(editor, 'form:create')).toBe(true);
    expect(can(editor, 'member:read')).toBe(true);

    expect(can(editor, 'member:invite')).toBe(false);
    expect(can(editor, 'member:remove')).toBe(false);
    expect(can(editor, 'apikey:manage')).toBe(false);
    expect(can(editor, 'billing:read')).toBe(false);
    expect(can(editor, 'audit:read')).toBe(false);
  });

  it('viewer é somente leitura', () => {
    const viewer = subject('viewer');
    expect(can(viewer, 'response:read')).toBe(true);
    expect(can(viewer, 'form:read')).toBe(true);

    expect(can(viewer, 'form:create')).toBe(false);
    expect(can(viewer, 'form:update')).toBe(false);
    expect(can(viewer, 'response:delete')).toBe(false);
    expect(can(viewer, 'response:export')).toBe(false);
  });
});

describe('permissão por formulário', () => {
  it('owner e admin acessam qualquer formulário da empresa', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(effectiveFormPermission(subject(role), form('outro-usuario'))).toBe('edit');
    }
  });

  it('permissão explícita não tira acesso de owner nem de admin', () => {
    // Decisão registrada em docs/adr/0003-rbac.md: um editor não pode trancar o
    // dono fora de um formulário da própria empresa.
    expect(effectiveFormPermission(subject('owner'), form('outro', 'none'))).toBe('edit');
    expect(effectiveFormPermission(subject('admin'), form('outro', 'none'))).toBe('edit');
  });

  it('editor edita os próprios formulários', () => {
    expect(effectiveFormPermission(subject('editor', 'user-1'), form('user-1'))).toBe('edit');
  });

  it('editor não enxerga formulário de outro sem permissão explícita', () => {
    expect(effectiveFormPermission(subject('editor', 'user-1'), form('user-2'))).toBe('none');
  });

  it('permissão explícita libera o editor num formulário alheio', () => {
    expect(effectiveFormPermission(subject('editor', 'user-1'), form('user-2', 'view'))).toBe('view');
    expect(effectiveFormPermission(subject('editor', 'user-1'), form('user-2', 'edit'))).toBe('edit');
  });

  it('permissão explícita "none" tira o formulário do próprio criador', () => {
    expect(effectiveFormPermission(subject('editor', 'user-1'), form('user-1', 'none'))).toBe('none');
  });

  it('viewer só vê o que foi liberado explicitamente', () => {
    expect(effectiveFormPermission(subject('viewer'), form('outro'))).toBe('none');
    expect(effectiveFormPermission(subject('viewer'), form('outro', 'view'))).toBe('view');
  });

  it('permissão de leitura não autoriza escrita', () => {
    const editor = subject('editor', 'user-1');
    const shared = { kind: 'form' as const, form: form('user-2', 'view') };

    expect(can(editor, 'form:read', shared)).toBe(true);
    expect(can(editor, 'response:read', shared)).toBe(true);
    expect(can(editor, 'form:update', shared)).toBe(false);
    expect(can(editor, 'form:delete', shared)).toBe(false);
    expect(can(editor, 'response:update', shared)).toBe(false);
  });

  it('sem acesso ao formulário, nenhuma ação passa', () => {
    const editor = subject('editor', 'user-1');
    const alheio = { kind: 'form_child' as const, form: form('user-2') };

    for (const action of ACTIONS) {
      expect(can(editor, action, alheio), action).toBe(false);
    }
  });
});

describe('atribuição de papéis', () => {
  it('senioridade é respeitada', () => {
    expect(outranks('owner', 'admin')).toBe(true);
    expect(outranks('admin', 'editor')).toBe(true);
    expect(outranks('editor', 'viewer')).toBe(true);
    expect(outranks('viewer', 'editor')).toBe(false);
    expect(outranks('admin', 'admin')).toBe(false);
  });

  it('só o owner cria outro owner', () => {
    expect(canAssignRole(subject('owner'), 'owner')).toBe(true);
    expect(canAssignRole(subject('admin'), 'owner')).toBe(false);
  });

  it('admin não promove ninguém acima de si', () => {
    expect(canAssignRole(subject('admin'), 'admin')).toBe(true);
    expect(canAssignRole(subject('admin'), 'editor')).toBe(true);
    expect(canAssignRole(subject('admin'), 'viewer')).toBe(true);
  });

  it('editor e viewer não atribuem papel nenhum', () => {
    for (const role of ['editor', 'viewer'] as const) {
      for (const target of ROLES) {
        expect(canAssignRole(subject(role), target), `${role} -> ${target}`).toBe(false);
      }
    }
  });
});
