# Plataforma SaaS de Formulários

Gerenciamento de formulários online no modelo Jotform, vendido por assinatura
para múltiplas empresas, com foco no mercado brasileiro.

> **Estado atual: Fase 1 concluída.** Fundação multi-tenant, autenticação,
> RBAC e a suíte de isolamento. O builder de formulários (Fase 2), a
> comercialização (Fase 3) e os domínios próprios (Fase 4) ainda não existem.
> Ver [Roteiro](#roteiro).

---

## Como subir

Precisa de Node 22+ e Docker.

```bash
cp .env.example .env          # ajuste o que quiser; os defaults funcionam
docker compose up -d          # postgres, redis, minio, mailhog, caddy
npm install
npm run setup                 # papéis do banco + migrations + seed
npm run dev                   # API em http://localhost:3333
```

`npm run setup` faz três coisas, nesta ordem, e todas são idempotentes:

1. **`db:roles`** — cria os papéis do banco e o banco em si. Roda como
   superusuário e é o único passo que precisa dele.
2. **`db:migrate`** — aplica as migrations com o papel de *migration*.
3. **`seed`** — popula planos e duas empresas de teste.

### Sem Docker

Se você já tem PostgreSQL 16+ rodando, só aponte `POSTGRES_SUPERUSER_URL`,
`DATABASE_URL` e `MIGRATE_DATABASE_URL` para ele e rode `npm run setup`. Redis,
MinIO e Mailhog só passam a ser necessários na Fase 2.

### Contas de teste

Senha para todas: `formulario-dev-2026`

| Empresa | owner | editor | viewer |
|---|---|---|---|
| Agência Alfa | `owner@alfa.test` | `editor@alfa.test` | `viewer@alfa.test` |
| Clínica Beta | `owner@beta.test` | `editor@beta.test` | `viewer@beta.test` |

As duas empresas existem para que a suíte de isolamento tenha um lado e o
outro. Sem os dois povoados, os testes passariam por ausência de dado em vez de
por isolamento — que é o pior tipo de teste verde.

---

## Testes

```bash
npm test                # tudo
npm run test:isolation  # a suíte que não pode falhar
npm run test:unit       # regras puras, sem banco
```

| Suíte | O que cobre |
|---|---|
| `unit` | RBAC, planos, aritmética de centavos, CPF/CNPJ, guarda de SQL cru |
| `isolation` | Fronteira entre empresas: HTTP, banco, tokens e `Host` |
| `integration` | Registro, login, refresh rotativo, rate limit |

A suíte de isolamento sobe a **mesma** aplicação que roda em produção, contra o
**mesmo** Postgres com RLS ligado. Nada é substituído por mock: um teste de
isolamento com banco falso não prova isolamento nenhum.

---

## Isolamento de dados

É a regra número um do produto, e está implementada em quatro camadas
independentes. Detalhes em [`docs/adr/0001`](docs/adr/0001-isolamento-multi-tenant.md).

**1. Modelagem** — toda tabela de negócio tem `organization_id UUID NOT NULL`.
IDs são UUID v4, nunca sequenciais.

**2. Row Level Security** — `ENABLE` + `FORCE`, com `USING` e `WITH CHECK`, em
todas elas. Query sem contexto de tenant devolve **zero linhas**, não a base
inteira. A aplicação conecta com um papel **sem** `BYPASSRLS`, e o papel de
migration é outro.

**3. Contexto de request** — `withTenant()` abre transação, grava
`app.current_org_id` nela e só então roda o trabalho. O `organizationId` vem
sempre do token verificado; nunca de body, query, header ou path.

**4. Repositórios** — nenhum controller fala com o Prisma direto. `$queryRaw`
fora de `db/tenant.ts` e `db/bootstrap.ts` quebra o lint **e** um teste.

### O que a suíte de isolamento verifica

- Empresa A pedindo, por ID direto, **cada um dos 13 recursos** da empresa B →
  404 em todos. E 200 nos próprios, para que um bug que responda 404 a tudo não
  faça a suíte passar sem isolamento.
- 404 e nunca 403: um 403 confirmaria que o recurso existe.
- ID malformado responde igual a ID inexistente.
- JWT forjado, payload adulterado, `alg: none`, token de refresh usado como
  access → 401.
- Token com assinatura válida mas sem membership → 401.
- Query sem contexto → zero linhas, inclusive por conexão `pg` crua.
- `INSERT`/`UPDATE`/`DELETE` cruzados → recusados pelo banco.
- Contexto não vaza entre transações na mesma conexão do pool.
- Rota autenticada por domínio de cliente → 404. `Host` forjado não troca o
  tenant.
- `audit_logs` sem `UPDATE`/`DELETE` para o papel da aplicação.
- Nenhum papel que faz login tem `BYPASSRLS`.

---

## Estrutura

```
apps/
  api/          Fastify + Prisma
    src/
      auth/         hashing, política de senha, tokens
      config/       env validado com Zod
      db/           prisma, contexto de tenant, bootstrap, repositórios
      http/         erros, contexto de request
      mail/         mailer (memória na Fase 1)
      routes/       auth, organizações, recursos
      services/     regras de autenticação
  web/          React + Vite (Fase 2)
  worker/       BullMQ (Fase 2)
packages/
  shared/       planos, RBAC, schemas Zod, formatadores BRL, validações BR
  ui/           design system (Fase 2)
prisma/         schema, migrations (RLS incluso), seed
infra/          docker-compose, Caddyfile, Dockerfile
tests/          unit, integration, isolation
docs/adr/       decisões arquiteturais
```

---

## Papéis do banco

| Papel | Login | BYPASSRLS | Para quê |
|---|---|---|---|
| `app_runtime` | sim | **não** | A aplicação. É quem sofre o RLS. |
| `app_migrator` | sim | **não** | Dono das tabelas. Migrations e seeds. |
| `app_bootstrap` | **não** | sim | Dono de três funções `SECURITY DEFINER`. |

`app_bootstrap` é o único papel com `BYPASSRLS` e existe por um motivo
específico: `SECURITY DEFINER` **não** contorna RLS, e com
`FORCE ROW LEVEL SECURITY` nem o dono da tabela escapa. Ele não faz login,
recebe `SELECT` em apenas quatro tabelas, e `app_runtime` não é membro dele.
O raciocínio completo está em
[`docs/adr/0002`](docs/adr/0002-funcoes-de-bootstrap.md).

---

## Papéis do produto

| Papel | Escopo |
|---|---|
| `owner` | Tudo + billing + deletar organização + transferir posse |
| `admin` | Membros, todos os formulários, configurações (sem billing) |
| `editor` | Cria/edita os próprios formulários, vê respostas dos que tem acesso |
| `viewer` | Somente leitura das respostas liberadas |

A matriz vive em `packages/shared/src/rbac.ts`, exposta como
`can(subject, action, resource)`. Nenhuma checagem de permissão em controller.

---

## API (Fase 1)

### Autenticação — `/v1/auth`

| Método | Rota | O que faz |
|---|---|---|
| POST | `/register` | Cria organização + owner + sessão |
| POST | `/login` | 5 tentativas por 15 min, por IP |
| POST | `/refresh` | Rotação com detecção de reuso |
| POST | `/logout` | Revoga a família da sessão |
| POST | `/verify-email` | Token de uso único |
| POST | `/resend-verification` | Sempre 202 |
| POST | `/accept-invitation` | Cria o vínculo com a empresa |
| POST | `/switch-organization` | Troca de workspace |
| GET | `/me` | Contexto autenticado |

### Recursos — `/v1`

`GET /v1/{recurso}/:id` para: `forms`, `form-versions`, `responses`, `files`,
`comments`, `assignments`, `ai-analyses`, `members`, `invitations`, `webhooks`,
`api-keys`, `custom-domains`, `invoices`.

Mais `organizations/current`, `members`, `invitations`, `audit-logs` e o
catálogo público `plans`.

### Erros

```json
{ "error": { "code": "not_found", "message": "..." } }
```

| Código | HTTP | Quando |
|---|---|---|
| `validation_error` | 422 | Entrada inválida |
| `unauthorized` | 401 | Sem sessão válida |
| `forbidden` | 403 | Papel insuficiente, existência já conhecida |
| `not_found` | 404 | Não existe **ou** é de outra empresa |
| `conflict` | 409 | Duplicidade |
| `rate_limited` | 429 | Limite de requisições |
| `quota_exceeded` | 402 | Limite de plano (Fase 3) |

---

## Segurança

- **Senhas** — Argon2id (19 MiB, 2 iterações). E-mail inexistente paga o mesmo
  custo, contra enumeração por tempo. Verificação contra senhas vazadas.
- **Sessões** — access de 15 min no header; refresh de 30 dias em cookie
  `httpOnly` com `Path=/v1/auth`. Segredos separados. Reuso de refresh derruba
  a família inteira.
- **Cabeçalhos** — Helmet com CSP estrita, CORS por lista fechada, HSTS só em
  produção.
- **PII** — IP e user-agent gravados como HMAC com sal. Logs com redação
  automática de `authorization`, `cookie`, `password` e `token`.
- **Auditoria** — `audit_logs` é append-only. A garantia é a ausência do
  privilégio no banco, não uma regra da aplicação.
- **Segredos** — `.env` nunca commitado; `.env.example` versionado e comentado.
  Em produção, o processo se recusa a subir com segredos de exemplo ou
  `COOKIE_SECURE=false`.

---

## Decisões arquiteturais

| ADR | Assunto |
|---|---|
| [0001](docs/adr/0001-isolamento-multi-tenant.md) | Isolamento multi-tenant em quatro camadas |
| [0002](docs/adr/0002-funcoes-de-bootstrap.md) | Funções de bootstrap e o papel `app_bootstrap` |
| [0003](docs/adr/0003-autenticacao-e-sessoes.md) | Autenticação, sessões e RBAC |
| [0004](docs/adr/0004-gateway-de-pagamento.md) | Gateway de pagamento e NFS-e |
| [0005](docs/adr/0005-tls-para-dominios-de-clientes.md) | TLS para domínios de clientes |

---

## Roteiro

- [x] **Fase 1 — Fundação.** Monorepo, RLS, autenticação, RBAC, suíte de
      isolamento.
- [ ] **Fase 2 — Produto.** Builder drag-and-drop, renderizador público,
      submissão, uploads, painel de recebimentos, exportações em fila.
- [ ] **Fase 3 — Comercialização.** Planos, quotas com buffer de 48h,
      `AsaasProvider`, boleto/Pix/cartão, NFS-e, dunning, reconciliação diária,
      página de preços e checkout.
- [ ] **Fase 4 — Domínios e diferenciais.** Domínios próprios com Caddy + ACME,
      white-label, colaboração, análises com IA, webhooks, API pública.
- [ ] **Fase 5 — Fechamento.** Admin da plataforma com MFA e impersonação
      auditada, e2e com Playwright, OpenAPI, guia de DNS por provedor
      brasileiro.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | API em modo watch |
| `npm run build` | Compila `shared` e `api` |
| `npm run typecheck` | Tipos, incluindo os testes |
| `npm run lint` | ESLint |
| `npm test` | Suíte completa |
| `npm run setup` | Papéis + migrations + seed |
| `npm run db:migrate:dev` | Cria migration a partir do schema |
| `npm run db:reset` | Zera o banco (destrutivo) |
