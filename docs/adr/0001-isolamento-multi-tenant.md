# ADR 0001 — Isolamento multi-tenant em quatro camadas

- **Status:** aceito
- **Data:** 2026-08-04
- **Fase:** 1

## Contexto

Uma plataforma de formulários guarda o que há de mais sensível na operação dos
clientes: cadastro de pacientes, dados fiscais, currículos, denúncias. Um
vazamento entre empresas não é um incidente de disponibilidade — é o fim do
produto.

O erro clássico do multi-tenant compartilhado é fazer o isolamento depender de
`WHERE organization_id = ?` espalhado pelos controllers. Funciona até o dia em
que alguém escreve uma query sem o `WHERE`. E esse dia sempre chega: numa
correção às pressas, num relatório novo, numa query de suporte.

## Decisão

Quatro camadas independentes, cada uma capaz de barrar sozinha.

### 1. Modelagem

Toda tabela de negócio tem `organization_id UUID NOT NULL` com FK para
`organizations`. IDs são UUID v4 gerados por `gen_random_uuid()`. Nada de ID
sequencial: sequencial é convite à enumeração e entrega volume de negócio do
cliente para quem contar.

Ficam de fora, por serem globais por natureza:

| Tabela | Por quê |
|---|---|
| `users` | A pessoa existe antes de qualquer empresa e pode pertencer a várias. |
| `email_verification_tokens` | Ligada ao usuário, não à empresa. Acesso só por hash de token. |
| `plans` | Catálogo público. Runtime só lê (INSERT/UPDATE/DELETE revogados). |
| `payment_events` | Chega do gateway antes de sabermos o tenant. |

`users` é o único caso que merece atenção: não tendo RLS, uma query por ID
arbitrário devolveria o usuário. A contenção é a camada de repositório —
listar membros passa por `memberships`, que **tem** RLS — e há teste de
isolamento cobrindo `GET /v1/members/:id` cruzado.

### 2. Row Level Security no PostgreSQL

Todas as tabelas com `organization_id`, mais `organizations` (que usa `id`):

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (organization_id = app_current_org_id())
  WITH CHECK (organization_id = app_current_org_id());
```

Três detalhes que não são cosméticos:

**`FORCE`** — sem ele, o dono da tabela ignora as políticas. Como o seed e as
migrations rodam como dono, o isolamento estaria desligado exatamente onde
ninguém olha.

**`WITH CHECK`** — sem ele, um bug conseguiria *inserir* uma linha carimbada com
o `organization_id` de outra empresa, mesmo sem conseguir lê-la. Plantar dado no
tenant alheio é tão grave quanto lê-lo.

**`app_current_org_id()` em vez do `current_setting` direto** — o documento de
produto sugeria `current_setting('app.current_org_id', true)::uuid`. Isso
funciona quando a variável nunca foi setada (devolve `NULL`), mas levanta
exceção depois de um `set_config(..., '', true)`, porque `''::uuid` é inválido.
A função normaliza com `NULLIF`:

```sql
SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
```

Com `NULL`, toda comparação vira `NULL`, que a política trata como falso:
query sem contexto enxerga **zero linhas**, nunca a base inteira.

### 3. Contexto de requisição

`withTenant(organizationId, fn)` abre uma transação, grava
`app.current_org_id` **nela** (`set_config` com `is_local = true`) e só então
roda o trabalho.

O `SET LOCAL` e as queries precisam estar na mesma conexão e na mesma
transação. Um `SET` fora da transação vazaria para o próximo request que
pegasse aquela conexão do pool — que é precisamente o bug que o RLS deveria
impedir. Há teste para isso.

O `organizationId` vem **sempre** do access token verificado. Nunca de body,
query, header (inclusive `Host`) ou path.

### 4. Camada de repositório

Nenhum controller fala com o Prisma direto. Todo acesso passa por
`db/repositories.ts`, e toda função recebe um `TenantContext`.

Os repositórios repetem `organizationId` nos `where` mesmo com RLS ligado. É
redundância deliberada: se um dia alguém rodar a aplicação com um papel que
tenha `BYPASSRLS`, ou esquecer o `FORCE` numa tabela nova, a filtragem da
aplicação continua de pé.

`$queryRaw` e `$executeRaw` são proibidos fora de `db/tenant.ts` e
`db/bootstrap.ts`. Isso não é convenção: `tests/unit/raw-query-guard.test.ts`
falha se aparecer em qualquer outro arquivo.

## Papéis do banco

| Papel | Login | BYPASSRLS | Para quê |
|---|---|---|---|
| `app_runtime` | sim | **não** | A aplicação. É quem sofre o RLS. |
| `app_migrator` | sim | **não** | Dono das tabelas. Migrations e seeds. Nunca serve request. |
| `app_bootstrap` | **não** | sim | Dono das três funções de bootstrap. Ver ADR 0002. |

## O problema de ovo e galinha

Para descobrir a organização de um request é preciso ler tabelas que já estão
protegidas por organização. Login precisa de `memberships`; refresh precisa de
`refresh_tokens`; aceitar convite precisa de `invitations`.

A saída são três funções `SECURITY DEFINER`, detalhadas no ADR 0002. Nenhuma
delas aceita `organization_id` como entrada — logo, nenhuma pode ser usada para
escolher o tenant que se quer ler.

## Consequências

**Boas**

- Uma query sem `WHERE organization_id` devolve zero linhas em vez de tudo.
- SQL escrito à mão, fora da aplicação, também é barrado — provado por teste
  com conexão `pg` crua.
- O modo de falha é "não vê nada", não "vê demais".

**Custos aceitos**

- Todo acesso a dado de negócio custa uma transação. Em troca, o contexto de
  tenant nunca escapa.
- Consultas administrativas cross-tenant (o painel do dono do SaaS, Fase 5)
  precisam de caminho próprio e auditado. É desconforto de propósito.
- Uma tabela nova sem `organization_id` e sem política passaria despercebida —
  por isso o teste varre `information_schema` e falha se encontrar tabela com
  a coluna e sem `FORCE RLS`.

## Alternativas descartadas

**Um schema por tenant.** Isolamento forte, mas migrations viram N migrations e
a conta de conexões explode com milhares de clientes.

**Um banco por tenant.** É o que o plano Enterprise promete
(`dedicatedDatabase: true`), e ali faz sentido. Para os demais planos, o custo
operacional inviabiliza um Free de R$ 0.

**Só filtro na aplicação.** É o modelo que este ADR existe para recusar.
