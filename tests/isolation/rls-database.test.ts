import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { currentOrgId, withTenant, withoutTenant } from '../../apps/api/src/db/tenant.js';
import { disconnectPrisma } from '../../apps/api/src/db/prisma.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';

/**
 * TESTE BLOQUEANTE — isolamento no nível do banco.
 *
 * Os testes HTTP provam que a aplicação se comporta. Estes provam que, mesmo
 * que a aplicação se comporte mal, o banco não deixa passar. É a diferença
 * entre isolamento como promessa e isolamento como garantia.
 */

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
  await disconnectPrisma();
});

describe('configuração do banco', () => {
  it('nenhum papel que faz login tem BYPASSRLS ou superusuário', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean }>
    >`
      SELECT rolname, rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname LIKE 'app\\_%'
    `;

    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const role of rows.filter((r) => r.rolcanlogin)) {
      expect(role.rolbypassrls, `${role.rolname} faz login E tem BYPASSRLS`).toBe(false);
      expect(role.rolsuper, `${role.rolname} é superusuário`).toBe(false);
    }
  });

  it('app_bootstrap tem BYPASSRLS mas não faz login', async () => {
    // É o único papel do sistema com BYPASSRLS. Ele existe porque
    // SECURITY DEFINER sozinho não vence FORCE ROW LEVEL SECURITY. O que o
    // torna aceitável é não ser possível autenticar-se como ele.
    const rows = await prisma.$queryRaw<Array<{ rolbypassrls: boolean; rolcanlogin: boolean }>>`
      SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'app_bootstrap'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.rolbypassrls).toBe(true);
    expect(rows[0]!.rolcanlogin).toBe(false);
  });

  it('o papel da aplicação não é membro de app_bootstrap', async () => {
    // Se fosse, um `SET ROLE app_bootstrap` daria BYPASSRLS à aplicação e todo
    // o isolamento viraria decoração.
    const rows = await prisma.$queryRaw<Array<{ member: string }>>`
      SELECT m.rolname AS member
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
       WHERE r.rolname = 'app_bootstrap'
    `;

    expect(rows.map((r) => r.member)).not.toContain('app_runtime');
  });

  it('app_bootstrap só enxerga as tabelas de que as funções de bootstrap precisam', async () => {
    // `information_schema.table_privileges` só lista o que o papel corrente
    // enxerga — e `app_runtime` não é membro de `app_bootstrap`, justamente o
    // que outro teste aqui exige. Então a leitura vai direto ao catálogo.
    const rows = await prisma.$queryRaw<Array<{ table_name: string; privilege_type: string }>>`
      SELECT c.relname AS table_name, acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND grantee.rolname = 'app_bootstrap'
    `;

    const tabelas = [...new Set(rows.map((r) => r.table_name))].sort();

    // Uma tabela por função de bootstrap, e nada além:
    //   organizations, memberships -> app_user_memberships (login, refresh)
    //   invitations                -> app_invitation_org
    //   refresh_tokens             -> app_refresh_token_org
    //   forms                      -> app_public_form_org (renderizador público)
    //   subscriptions              -> app_subscription_org (webhook do gateway)
    //   billing_profiles           -> app_billing_customer_org (idem)
    //
    // Esta lista é um portão de propósito: crescer a superfície do único papel
    // com BYPASSRLS precisa ser uma decisão consciente, com este teste
    // falhando primeiro e obrigando a justificativa.
    expect(tabelas).toEqual([
      'billing_profiles',
      'forms',
      'invitations',
      'memberships',
      'organizations',
      'refresh_tokens',
      'subscriptions',
    ]);

    // E o que NÃO pode estar aqui — o conteúdo que os clientes confiam a nós.
    for (const proibida of ['responses', 'files', 'comments', 'invoices', 'audit_logs', 'api_keys']) {
      expect(tabelas, `app_bootstrap enxerga ${proibida}`).not.toContain(proibida);
    }

    // Só leitura, em todas.
    expect([...new Set(rows.map((r) => r.privilege_type))]).toEqual(['SELECT']);
  });

  it('toda tabela com organization_id tem RLS habilitado E forçado', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = c.relname
              AND col.column_name = 'organization_id'
         )
    `;

    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.table_name} sem RLS`).toBe(true);
      // Sem FORCE, o dono da tabela ignora a política — e o seed roda como dono.
      expect(row.relforcerowsecurity, `${row.table_name} sem FORCE RLS`).toBe(true);
    }
  });

  it('toda tabela com RLS tem a política tenant_isolation com USING e WITH CHECK', async () => {
    const rows = await prisma.$queryRaw<Array<{ tablename: string; qual: string | null; with_check: string | null }>>`
      SELECT tablename, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
    `;

    expect(rows.length).toBeGreaterThanOrEqual(21);
    for (const row of rows) {
      expect(row.qual, `${row.tablename} sem USING`).toBeTruthy();
      // Sem WITH CHECK, um bug conseguiria INSERIR linha carimbada com o
      // organization_id de outra empresa, mesmo sem conseguir lê-la.
      expect(row.with_check, `${row.tablename} sem WITH CHECK`).toBeTruthy();
    }
  });

  it('audit_logs é append-only para o papel de runtime', async () => {
    const rows = await prisma.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type
        FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'audit_logs' AND grantee = 'app_runtime'
    `;

    const privileges = rows.map((r) => r.privilege_type);
    expect(privileges).toContain('SELECT');
    expect(privileges).toContain('INSERT');
    // A garantia é a ausência do privilégio no banco, não uma regra da aplicação.
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });
});

describe('contexto de tenant', () => {
  it('sem contexto setado, uma query devolve ZERO linhas — não a base inteira', async () => {
    const counts = await withoutTenant(async (tx) => ({
      contexto: await currentOrgId(tx),
      organizations: await tx.organization.count(),
      forms: await tx.form.count(),
      responses: await tx.response.count(),
      memberships: await tx.membership.count(),
      auditLogs: await tx.auditLog.count(),
    }));

    expect(counts.contexto).toBeNull();
    expect(counts.organizations).toBe(0);
    expect(counts.forms).toBe(0);
    expect(counts.responses).toBe(0);
    expect(counts.memberships).toBe(0);
    expect(counts.auditLogs).toBe(0);
  });

  it('com contexto da empresa A, nada da empresa B aparece', async () => {
    const seen = await withTenant(ORG_A.id, async ({ tx }) => ({
      contexto: await currentOrgId(tx),
      organizations: await tx.organization.findMany({ select: { id: true } }),
      forms: await tx.form.findMany({ select: { organizationId: true } }),
      responses: await tx.response.findMany({ select: { organizationId: true } }),
    }));

    expect(seen.contexto).toBe(ORG_A.id);
    expect(seen.organizations.map((o) => o.id)).toEqual([ORG_A.id]);
    expect(seen.forms.length).toBeGreaterThan(0);
    for (const row of [...seen.forms, ...seen.responses]) {
      expect(row.organizationId).toBe(ORG_A.id);
    }
  });

  it('buscar por ID conhecido da empresa B, sob contexto de A, não devolve nada', async () => {
    const idFromB = await withTenant(ORG_B.id, ({ tx }) => tx.form.findFirstOrThrow({ select: { id: true } }));

    const found = await withTenant(ORG_A.id, ({ tx }) => tx.form.findUnique({ where: { id: idFromB.id } }));

    // `findUnique` busca pela chave primária e ainda assim volta vazio: quem
    // filtrou foi a política do banco, não o `where` da aplicação.
    expect(found).toBeNull();
  });

  it('o contexto não vaza entre transações na mesma conexão', async () => {
    await withTenant(ORG_A.id, async ({ tx }) => {
      expect(await currentOrgId(tx)).toBe(ORG_A.id);
    });

    // `set_config(..., is_local => true)` some no commit. Se vazasse, o próximo
    // request a pegar esta conexão do pool herdaria o tenant anterior — que é
    // exatamente a falha que o RLS deveria impedir.
    const afterwards = await withoutTenant((tx) => currentOrgId(tx));
    expect(afterwards).toBeNull();
  });

  it('gravar com organization_id de outra empresa é recusado pelo WITH CHECK', async () => {
    await expect(
      withTenant(ORG_A.id, ({ tx }) =>
        tx.form.create({
          data: {
            organizationId: ORG_B.id,
            title: 'Formulário plantado',
            slugPublic: `plantado-${Date.now()}`,
            schemaJson: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('atualizar linha da empresa B sob contexto de A não afeta nenhuma linha', async () => {
    const before = await withTenant(ORG_B.id, ({ tx }) => tx.form.findFirstOrThrow());

    const result = await withTenant(ORG_A.id, ({ tx }) =>
      tx.form.updateMany({ where: { id: before.id }, data: { title: 'Sequestrado' } }),
    );
    expect(result.count).toBe(0);

    const after = await withTenant(ORG_B.id, ({ tx }) => tx.form.findFirstOrThrow({ where: { id: before.id } }));
    expect(after.title).toBe(before.title);
  });

  it('apagar linha da empresa B sob contexto de A não afeta nenhuma linha', async () => {
    const target = await withTenant(ORG_B.id, ({ tx }) => tx.form.findFirstOrThrow({ select: { id: true } }));

    const result = await withTenant(ORG_A.id, ({ tx }) => tx.form.deleteMany({ where: { id: target.id } }));
    expect(result.count).toBe(0);

    const stillThere = await withTenant(ORG_B.id, ({ tx }) => tx.form.count({ where: { id: target.id } }));
    expect(stillThere).toBe(1);
  });

  it('contexto com UUID inválido é recusado antes de chegar ao banco', async () => {
    await expect(withTenant("' OR '1'='1", async () => null)).rejects.toThrow(/UUID/);
  });
});

describe('conexão crua, fora do Prisma', () => {
  it('mesmo com SQL direto, sem contexto não há linhas', async () => {
    // Simula o pior caso: alguém abriu uma conexão e escreveu SQL à mão,
    // ignorando toda a camada de repositórios.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const forms = await client.query('SELECT id FROM forms');
      const responses = await client.query('SELECT id FROM responses');
      const orgs = await client.query('SELECT id FROM organizations');

      expect(forms.rowCount).toBe(0);
      expect(responses.rowCount).toBe(0);
      expect(orgs.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('SQL direto com contexto de A enxerga apenas A', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', ORG_A.id]);
      const { rows } = await client.query<{ organization_id: string }>('SELECT organization_id FROM forms');
      await client.query('COMMIT');

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.organization_id).toBe(ORG_A.id);
    } finally {
      await client.end();
    }
  });
});
