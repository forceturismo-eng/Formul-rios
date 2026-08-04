#!/usr/bin/env node
/**
 * Bootstrap dos papéis do banco. Roda uma vez por ambiente, como superusuário.
 *
 * Cria dois papéis com propósitos que não se misturam:
 *
 *   app_migrator — dono das tabelas. Roda migrations e seeds. NOBYPASSRLS.
 *   app_runtime  — usado pela API em produção. NOBYPASSRLS, não é dono de nada,
 *                  só recebe SELECT/INSERT/UPDATE/DELETE via GRANT.
 *
 * Por que NOBYPASSRLS nos dois: um papel com BYPASSRLS transforma o isolamento
 * de tenant numa promessa da aplicação. Queremos que seja uma garantia do banco.
 * E por que FORCE ROW LEVEL SECURITY nas tabelas: sem isso, o DONO da tabela
 * ignora as políticas — o que anularia o RLS justamente nos seeds e migrations.
 */
import pg from 'pg';
import { loadEnv } from './load-env.mjs';

const env = loadEnv();

function parse(url, label) {
  if (!url) throw new Error(`${label} não definida.`);
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    host: u.hostname,
    port: Number(u.port || 5432),
  };
}

const superUrl = env.POSTGRES_SUPERUSER_URL;
const runtime = parse(env.DATABASE_URL, 'DATABASE_URL');
const migrator = parse(env.MIGRATE_DATABASE_URL, 'MIGRATE_DATABASE_URL');

if (runtime.database !== migrator.database) {
  throw new Error('DATABASE_URL e MIGRATE_DATABASE_URL devem apontar para o mesmo banco.');
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
// CREATE/ALTER ROLE são comandos utilitários: o Postgres não aceita parâmetros
// ligados neles, então a senha precisa ir como literal escapado.
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function run() {
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();

  // Papel que empresta privilégio às três funções de bootstrap.
  //
  // Ele é o ÚNICO com BYPASSRLS no sistema, e existe porque SECURITY DEFINER
  // sozinho não resolve: `FORCE ROW LEVEL SECURITY` sujeita até o dono da
  // tabela às políticas, então uma função pertencente ao migrator também
  // enxergaria zero linhas.
  //
  // O que o torna aceitável:
  //   - NOLOGIN: nenhuma conexão pode se autenticar como ele.
  //   - Recebe SELECT em apenas quatro tabelas (ver a migration de RLS).
  //   - `app_runtime` não é membro dele, então a aplicação nunca herda o
  //     BYPASSRLS — só pode chamar as funções, que não aceitam
  //     `organization_id` como entrada.
  const BOOTSTRAP_ROLE = 'app_bootstrap';
  const { rowCount: bootstrapExists } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    BOOTSTRAP_ROLE,
  ]);
  if (bootstrapExists === 0) {
    await admin.query(`CREATE ROLE ${quoteIdent(BOOTSTRAP_ROLE)} NOLOGIN NOSUPERUSER BYPASSRLS`);
    console.log(`papel criado: ${BOOTSTRAP_ROLE}`);
  } else {
    await admin.query(`ALTER ROLE ${quoteIdent(BOOTSTRAP_ROLE)} WITH NOLOGIN NOSUPERUSER BYPASSRLS`);
    console.log(`papel já existia, atributos reaplicados: ${BOOTSTRAP_ROLE}`);
  }

  for (const role of [migrator, runtime]) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.user]);
    if (rowCount === 0) {
      await admin.query(
        `CREATE ROLE ${quoteIdent(role.user)} LOGIN PASSWORD ${quoteLiteral(role.password)} ` +
          `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      console.log(`papel criado: ${role.user}`);
    } else {
      // Idempotente: reaplica senha e, principalmente, reforça NOBYPASSRLS.
      await admin.query(
        `ALTER ROLE ${quoteIdent(role.user)} WITH LOGIN PASSWORD ${quoteLiteral(role.password)} NOSUPERUSER NOBYPASSRLS`,
      );
      console.log(`papel já existia, atributos reaplicados: ${role.user}`);
    }
  }

  // O banco da aplicação e o shadow database do `prisma migrate dev`.
  // Criar o shadow aqui é o que permite manter `app_migrator` sem CREATEDB.
  const shadowDatabase = env.SHADOW_DATABASE_URL ? parse(env.SHADOW_DATABASE_URL, 'SHADOW_DATABASE_URL').database : null;

  for (const database of [migrator.database, shadowDatabase].filter(Boolean)) {
    const { rowCount: dbExists } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (dbExists === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(migrator.user)}`);
      console.log(`banco criado: ${database}`);
    } else {
      await admin.query(`ALTER DATABASE ${quoteIdent(database)} OWNER TO ${quoteIdent(migrator.user)}`);
      console.log(`banco já existia: ${database}`);
    }
  }
  await admin.end();

  // Agora dentro do banco da aplicação.
  const dbAdmin = new pg.Client({ connectionString: withDatabase(superUrl, migrator.database) });
  await dbAdmin.connect();

  const M = quoteIdent(migrator.user);
  const R = quoteIdent(runtime.user);
  const B = quoteIdent(BOOTSTRAP_ROLE);

  // O migrator precisa ser membro de app_bootstrap para poder transferir a
  // posse das funções de bootstrap a ele na migration. Isso não é escalada: o
  // migrator já é dono de todas as tabelas.
  // `app_runtime` fica de fora desta concessão — é o que impede a aplicação de
  // herdar BYPASSRLS com um `SET ROLE`.
  await dbAdmin.query(`GRANT ${B} TO ${M}`);
  await dbAdmin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(migrator.database)} TO ${B}`);
  await dbAdmin.query(`GRANT USAGE ON SCHEMA public TO ${B}`);
  // O Postgres exige que o dono de um objeto tenha CREATE no schema onde ele
  // vive — sem isto, `ALTER FUNCTION ... OWNER TO app_bootstrap` é recusado.
  // Como o papel é NOLOGIN e só o migrator é membro dele, ninguém consegue
  // usar esse CREATE para criar coisa alguma.
  await dbAdmin.query(`GRANT CREATE ON SCHEMA public TO ${B}`);

  await dbAdmin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(migrator.database)} TO ${R}`);
  await dbAdmin.query(`ALTER SCHEMA public OWNER TO ${M}`);
  await dbAdmin.query(`GRANT USAGE ON SCHEMA public TO ${R}`);
  // O runtime não cria tabela. Migration é trabalho do migrator.
  await dbAdmin.query(`REVOKE CREATE ON SCHEMA public FROM ${R}`);
  await dbAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

  // Objetos que o migrator criar de agora em diante já nascem acessíveis ao runtime.
  await dbAdmin.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${M} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${R}`,
  );
  await dbAdmin.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${M} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${R}`,
  );
  await dbAdmin.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${M} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${R}`);

  // E os que já existem (re-execuções e bancos já migrados).
  await dbAdmin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${R}`);
  await dbAdmin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${R}`);

  // O GRANT amplo acima é conveniente, mas devolveria privilégios que a
  // migration de RLS revogou de propósito. Reaplicar as revogações aqui faz
  // com que a ORDEM entre `db:roles` e `db:migrate` deixe de importar —
  // rodar o bootstrap de papéis depois das migrations não pode reabrir buraco.
  //
  // Cada revogação existe por um motivo, documentado na migration de RLS:
  //   audit_logs         -> append-only. Log reescrevível não é auditoria.
  //   plans              -> catálogo. Quem escreve é o seed, via migrator.
  //   _prisma_migrations -> o runtime não tem por que ver histórico de DDL.
  const revocations = [
    ['audit_logs', 'UPDATE, DELETE'],
    ['plans', 'INSERT, UPDATE, DELETE'],
    ['_prisma_migrations', 'ALL'],
  ];
  for (const [table, privileges] of revocations) {
    const { rowCount } = await dbAdmin.query('SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2', [
      'public',
      table,
    ]);
    if (rowCount > 0) {
      await dbAdmin.query(`REVOKE ${privileges} ON ${quoteIdent(table)} FROM ${R}`);
    }
  }

  await dbAdmin.end();
  console.log('papéis e privilégios prontos.');
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
