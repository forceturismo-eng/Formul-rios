/**
 * As duas organizações do seed, e o inventário de recursos de cada uma.
 *
 * A suíte de isolamento precisa de IDs reais de recursos da OUTRA empresa para
 * tentar alcançá-los. Buscar esses IDs aqui — com contexto de tenant explícito
 * — é a única leitura cross-tenant legítima do projeto, e ela existe justamente
 * para provar que a aplicação não consegue fazer o mesmo.
 */
import { withTenant } from '../../apps/api/src/db/tenant.js';

export const ORG_A = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Agência Alfa',
  owner: 'owner@alfa.test',
  editor: 'editor@alfa.test',
  viewer: 'viewer@alfa.test',
  domain: 'formularios.alfa.test',
} as const;

export const ORG_B = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Clínica Beta',
  owner: 'owner@beta.test',
  editor: 'editor@beta.test',
  viewer: 'viewer@beta.test',
  domain: 'formularios.beta.test',
} as const;

export const SEED_PASSWORD = 'formulario-dev-2026';

/**
 * Um recurso de cada tipo, por organização.
 *
 * As chaves são exatamente os segmentos de rota expostos em
 * apps/api/src/routes/resources.ts. Se um recurso novo entrar lá e não entrar
 * aqui, o teste de cobertura da suíte acusa.
 */
export interface ResourceInventory {
  forms: string;
  'form-versions': string;
  responses: string;
  files: string;
  comments: string;
  assignments: string;
  'ai-analyses': string;
  members: string;
  invitations: string;
  webhooks: string;
  'api-keys': string;
  'custom-domains': string;
  invoices: string;
}

function requireId(value: { id: string } | null, label: string): string {
  if (!value) throw new Error(`Seed incompleto: nenhum registro de "${label}". Rode \`npm run seed\`.`);
  return value.id;
}

export async function inventoryOf(organizationId: string): Promise<ResourceInventory> {
  return withTenant(organizationId, async ({ tx }) => ({
    forms: requireId(await tx.form.findFirst({ select: { id: true } }), 'forms'),
    'form-versions': requireId(await tx.formVersion.findFirst({ select: { id: true } }), 'form_versions'),
    responses: requireId(await tx.response.findFirst({ select: { id: true } }), 'responses'),
    files: requireId(await tx.file.findFirst({ select: { id: true } }), 'files'),
    comments: requireId(await tx.comment.findFirst({ select: { id: true } }), 'comments'),
    assignments: requireId(await tx.assignment.findFirst({ select: { id: true } }), 'assignments'),
    'ai-analyses': requireId(await tx.aiAnalysis.findFirst({ select: { id: true } }), 'ai_analyses'),
    members: requireId(
      await tx.membership.findFirst({ where: { role: 'owner' }, select: { id: true } }),
      'memberships',
    ),
    invitations: requireId(await tx.invitation.findFirst({ select: { id: true } }), 'invitations'),
    webhooks: requireId(await tx.webhook.findFirst({ select: { id: true } }), 'webhooks'),
    'api-keys': requireId(await tx.apiKey.findFirst({ select: { id: true } }), 'api_keys'),
    'custom-domains': requireId(await tx.customDomain.findFirst({ select: { id: true } }), 'custom_domains'),
    invoices: requireId(await tx.invoice.findFirst({ select: { id: true } }), 'invoices'),
  }));
}
