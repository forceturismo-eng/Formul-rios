# Plataforma SaaS de Formulários

Gerenciamento de formulários online no modelo Jotform, vendido por assinatura
para múltiplas empresas, com foco no mercado brasileiro.

> **Estado atual: Fases 1 a 4 concluídas** e a Fase 5 em andamento. Backend e
> frontend completos: multi-tenant com RLS, formulários e submissão, quotas e
> cobrança, domínios próprios com TLS sob demanda, white-label, webhooks, API
> pública por chave, análises com IA com redação de PII, e o admin da
> plataforma com MFA e impersonação auditada.
>
> **Pendências conhecidas:** NFS-e e dunning por e-mail — os dois dependem de
> credenciais externas. Ver [Roteiro](#roteiro).

---

## Como subir

Precisa de Node 22+ e Docker.

```bash
cp .env.example .env          # ajuste o que quiser; os defaults funcionam
docker compose up -d          # postgres, redis, minio, mailhog, caddy
npm install
npm run setup                 # papéis do banco + migrations + seed
npm run dev                   # API em http://localhost:3333
npm run dev:web               # app web em http://localhost:5173
npm run dev -w @forms/worker  # workers das filas, em outro terminal
```

O app web faz proxy de `/v1` e `/f` para a API, então o cookie de sessão viaja
como mesma origem — igual ao que acontece em produção, atrás do Caddy.

`npm run setup` faz três coisas, nesta ordem, e todas são idempotentes:

1. **`db:roles`** — cria os papéis do banco e o banco em si. Roda como
   superusuário e é o único passo que precisa dele.
2. **`db:migrate`** — aplica as migrations com o papel de *migration*.
3. **`seed`** — popula planos e duas empresas de teste.

### Sem Docker

Se você já tem PostgreSQL 16+ e Redis rodando, aponte `POSTGRES_SUPERUSER_URL`,
`DATABASE_URL`, `MIGRATE_DATABASE_URL` e `REDIS_URL` para eles e rode
`npm run setup`.

Os arquivos usam um driver de disco local por padrão (`.storage/`), então MinIO
só é necessário quando você quiser exercitar o caminho S3 de verdade. O driver
fica atrás da interface `StorageProvider` — trocar um pelo outro é uma linha.

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
npm test                # tudo, menos e2e
npm run test:isolation  # a suíte que não pode falhar
npm run test:unit       # regras puras, sem banco
npm run test:e2e        # navegador de verdade (sobe API e web sozinho)
```

| Suíte | O que cobre |
|---|---|
| `unit` | RBAC, planos, quotas, microcopy, aritmética de centavos, CPF/CNPJ, runtime do formulário, validação de upload, roteador do web, guarda de SQL cru |
| `isolation` | Fronteira entre empresas: HTTP, banco, tokens, `Host`, criptografia, arquivos e exportações |
| `integration` | Autenticação, ciclo do formulário, submissão pública, recebimentos, exportação, enforcement de quotas, cobrança, branding, IA e documentação |
| `e2e` | Navegador de verdade: cadastro, criação, publicação, resposta pública e leitura no painel |

A suíte de isolamento sobe a **mesma** aplicação que roda em produção, contra o
**mesmo** Postgres com RLS ligado. Nada é substituído por mock: um teste de
isolamento com banco falso não prova isolamento nenhum.

---

## Isolamento de dados

É a regra número um do produto, e está implementada em quatro camadas
independentes. Detalhes em [`docs/adr/0001`](docs/adr/0001-isolamento-multi-tenant.md).

**1. Modelagem** — toda tabela de negócio tem `organization_id UUID NOT NULL`.
IDs são UUID v4, nunca sequenciais.

**0. Rate limit compartilhado** — o contador vive no Redis quando há
`REDIS_URL`. Em memória ele é por processo, e um limite de "5 tentativas de
login por 15 minutos" vira 20 com quatro instâncias — obedecendo direitinho o
contador de cada uma.

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
- A resposta cifrada da Empresa A não decifra com a chave da Empresa B, nem
  trocando a chave de dados entre as duas.
- Formulários, respostas, comentários, atribuições, exportações e arquivos da
  outra empresa: 404 na leitura, na escrita e na exportação.
- Submissão pública cai na empresa dona do formulário, mesmo com um token de
  outra empresa no header.
- Caminho no bucket sempre prefixado pelo `organization_id`, e download só por
  URL assinada não expirada.
- O worker de exportação roda sob contexto de tenant: exportar formulário
  alheio falha em vez de gerar arquivo vazio.

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
      crypto/       envelope encryption das respostas, redação de PII
      mail/         mailer (memória na Fase 1)
      payments/     PaymentProvider, AsaasProvider e provedor falso
      queue/        filas BullMQ, workers de exportação e cobrança
      routes/       auth, organizações, formulários, respostas, arquivos, público
      services/     regras de autenticação, formulários, submissão, recebimentos
      storage/      StorageProvider e validação de upload
  web/          React + Vite
    src/
      components/   layout do painel e peças de interface
      lib/          cliente de API, sessão e roteador próprio
      pages/        preços, auth, formulários, builder, respostas, cobrança,
                    renderizador público
  worker/       processo dos workers BullMQ
packages/
  shared/       planos, RBAC, schemas Zod, runtime do formulário,
                formatadores BRL, validações BR
  ui/           design system (Fase 3)
prisma/         schema, migrations (RLS incluso), seed
infra/          docker-compose, Caddyfile, Dockerfile
tests/          unit, integration, isolation
docs/adr/       decisões arquiteturais
docs/guia-dns.md  configuração de DNS por provedor brasileiro
```

---

## Papéis do banco

| Papel | Login | BYPASSRLS | Para quê |
|---|---|---|---|
| `app_runtime` | sim | **não** | A aplicação. É quem sofre o RLS. |
| `app_migrator` | sim | **não** | Dono das tabelas. Migrations e seeds. |
| `app_bootstrap` | **não** | sim | Dono das funções `SECURITY DEFINER` de bootstrap. |

`app_bootstrap` é o único papel com `BYPASSRLS` e existe por um motivo
específico: `SECURITY DEFINER` **não** contorna RLS, e com
`FORCE ROW LEVEL SECURITY` nem o dono da tabela escapa. Ele não faz login,
recebe `SELECT` em apenas sete tabelas, e `app_runtime` não é membro dele.
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

## API

### Autenticação — `/v1/auth`

| Método | Rota | O que faz |
|---|---|---|
| POST | `/register` | Cria organização + owner + sessão |
| POST | `/login` | 5 tentativas por 15 min, por IP. Com MFA ligado, responde `mfa_required` (401) até vir o `mfaCode` |
| POST | `/refresh` | Rotação com detecção de reuso |
| POST | `/logout` | Revoga a família da sessão |
| POST | `/verify-email` | Token de uso único |
| POST | `/resend-verification` | Sempre 202 |
| POST | `/accept-invitation` | Cria o vínculo com a empresa |
| POST | `/switch-organization` | Troca de workspace |
| GET | `/me` | Contexto autenticado |
| GET | `/mfa` | Estado do segundo fator e quantos códigos de recuperação restam |
| POST | `/mfa/setup` | Gera a chave e a URI `otpauth://`. **Não liga** o MFA |
| POST | `/mfa/activate` | Confirma com o primeiro código e devolve os 10 códigos de recuperação |
| POST | `/mfa/disable` | Desliga; exige a senha de novo |
| POST | `/mfa/recovery-codes` | Novos códigos; invalida os anteriores. Exige a senha |

### Formulários — `/v1`

| Método | Rota | O que faz |
|---|---|---|
| GET/POST | `/forms` | Lista o que o usuário pode ver; cria em rascunho |
| GET | `/forms/:id/full` | Formulário com definição e tema |
| PATCH | `/forms/:id` | Grava; exige `expectedRevision` (lock otimista) |
| POST | `/forms/:id/publish` | Congela o schema numa `form_version` |
| POST | `/forms/:id/archive` \| `/restore` \| `/duplicate` | |
| GET | `/forms/:id/versions` | Histórico de publicações |
| POST | `/forms/validate-schema` | Valida sem gravar |

### Recebimentos — `/v1`

| Método | Rota | O que faz |
|---|---|---|
| GET | `/forms/:id/responses` | Filtros, busca no conteúdo cifrado, paginação |
| GET | `/responses/:id/full` | Resposta decifrada |
| PATCH/DELETE | `/responses/:id` | Status, marcação; soft delete |
| GET/POST | `/responses/:id/comments` | Comentários com @menção |
| POST | `/responses/:id/assignments` | Atribuição a um membro |
| POST/GET | `/forms/:id/exports` | Pede exportação (202) e lista pedidos |
| GET | `/exports/:id/download-url` | URL assinada, 5 minutos |

### Público — sem autenticação, servido em qualquer domínio

| Método | Rota | O que faz |
|---|---|---|
| GET | `/f/:slug` | Formulário publicado + branding da empresa |
| GET | `/f/:slug` com `Accept: text/html` | O mesmo, como HTML com as meta tags no `<head>` |
| POST | `/f/:slug/submit` | Submissão com honeypot e rate limit |
| POST | `/f/:slug/upload` | Anexo, antes da submissão |

### Admin da plataforma — `/admin`

Autenticação **distinta** da dos clientes: tabela própria, token com audience
própria, MFA obrigatório. Um token de cliente apresentado aqui responde 401.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/admin/auth/login` | Senha + código TOTP. Sem MFA configurado, devolve o QR Code |
| POST | `/admin/auth/mfa/confirm` | Ativa o segundo fator com o primeiro código |
| GET | `/admin/metrics` | MRR, churn, inadimplência, uso — só números |
| GET | `/admin/organizations` | Empresas com metadado e contagens |
| PATCH | `/admin/organizations/:id/status` | Suspender e reativar. Motivo obrigatório |
| PATCH | `/admin/organizations/:id/plan` | Ajustar plano. Motivo obrigatório |
| POST | `/admin/organizations/:id/impersonate` | Token de 15 min, **somente leitura** |
| GET | `/admin/actions` | A trilha do que os operadores fizeram |

O admin lê **agregados**, não linhas de clientes: as funções do banco que servem
essas telas não têm coluna de conteúdo no retorno. Ver dado de cliente exige
impersonar — e impersonar registra nos dois lados e acende um banner permanente
no painel da empresa. Detalhes em
[`docs/adr/0009`](docs/adr/0009-admin-da-plataforma.md).

### Análises com IA — `/v1`

| Método | Rota | O que faz |
|---|---|---|
| GET | `/ai/settings` | Consentimento, cota e tipos disponíveis |
| PUT | `/ai/consent` | Liga e desliga. Padrão: desligado |
| GET | `/forms/:id/ai-analyses` | Análises já feitas |
| POST | `/forms/:id/ai-analyses` | Pede uma. 200 se havia cache, 202 se foi para a fila |

Os dados pessoais são **sempre** removidos antes do envio — não é opção.
Nomes, e-mails, CPFs, CNPJs, telefones, CEPs e cartões viram pseudônimos
estáveis (`[EMAIL_1]`), que preservam a análise sem expor ninguém. Detalhes em
[`docs/adr/0008`](docs/adr/0008-analises-com-ia-e-redacao-de-pii.md).

### Marca — `/v1`

| Método | Rota | O que faz |
|---|---|---|
| GET | `/branding` | Branding gravado, prévia do CSS e o que o plano libera |
| PATCH | `/branding` | Logo, favicon, cor, meta tags e CSS (`null` limpa o campo) |
| POST | `/branding/preview-css` | O que sobra do CSS, e por que o resto saiu |

CSS customizado é sanitizado por lista de **permissão** a cada renderização —
nunca na gravação, para que endurecer a lista valha para o que já está no banco.
Detalhes e o que fica de fora em
[`docs/adr/0007`](docs/adr/0007-white-label-e-css-do-cliente.md).

### Integrações — `/v1`

| Método | Rota | O que faz |
|---|---|---|
| GET/POST/DELETE | `/custom-domains` | Domínio próprio, com instruções de DNS |
| POST | `/custom-domains/:id/verify` | Confere o DNS agora |
| GET/POST/DELETE | `/webhooks` | Webhooks de saída; o segredo aparece uma vez |
| GET/POST/DELETE | `/api-keys` | Chaves da API pública; o segredo aparece uma vez |

### API pública — `/api/v1`, autenticada por chave

`Authorization: Bearer fx_live_…`. Sem cookie, sem sessão. A chave carrega a
organização; o **escopo** carrega a autorização.

| Método | Rota | Escopo exigido |
|---|---|---|
| GET | `/forms` | `forms:read` |
| GET | `/forms/:id/responses` | `responses:read` |
| GET | `/me` | — |

Escopo insuficiente responde 403 nomeando o escopo que falta. Recurso de outra
empresa responde 404, como em todo o resto da API. Detalhes em
[`docs/adr/0006`](docs/adr/0006-api-publica-e-webhooks.md).

### Webhooks de saída

Cada entrega vai assinada:

```
X-Formularios-Event: response.created
X-Formularios-Signature: t=1754400000000,v1=<hmac-sha256 de "<t>.<payload>">
```

Confira a assinatura **e** a idade do timestamp — a tolerância de referência é
de 5 minutos. Só https; o host é resolvido antes de cada entrega e um IP em
faixa privada cancela o envio.

### Recursos — `/v1`

`GET /v1/{recurso}/:id` para: `forms`, `form-versions`, `responses`, `files`,
`comments`, `assignments`, `ai-analyses`, `members`, `invitations`, `webhooks`,
`api-keys`, `custom-domains`, `invoices`.

Mais `organizations/current`, `members`, `invitations`, `audit-logs` e o
catálogo público `plans`.

### Documentação

| Rota | O que é |
|---|---|
| `/openapi.json` | Documento OpenAPI 3.1 |
| `/docs` | Visualizador, autocontido e sem CDN |

O documento é **montado a partir das constantes do código** — escopos de chave,
eventos de webhook, tipos de análise, códigos de erro e planos vêm dos mesmos
lugares que a aplicação usa. Um escopo novo aparece na documentação sozinho, e
há testes que falham se ele não aparecer. Documentação escrita à parte envelhece
em silêncio, e documentação errada é pior do que ausente.

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
| `service_unavailable` | 503 | Terceiro fora do ar — temporário, não é bug nosso |

---

## Segurança

- **Respostas cifradas em repouso** — AES-256-GCM com envelope encryption:
  chave de dados por resposta, cifrada por uma chave derivada por HKDF do
  `organization_id`. A chave que abre uma empresa não abre a outra, mesmo com
  acesso ao banco inteiro.
- **Uploads** — whitelist de MIME, conferência de magic bytes, limite por
  plano, nome aleatório no storage, bucket privado, download só por URL
  assinada e sempre com `Content-Disposition: attachment`.
- **Anti-spam** — honeypot que responde 201 (o robô não aprende nada), rate
  limit por IP no envio e na leitura do formulário público.
- **Senhas** — Argon2id (19 MiB, 2 iterações). E-mail inexistente paga o mesmo
  custo, contra enumeração por tempo. Verificação contra senhas vazadas.
- **Sessões** — access de 15 min no header; refresh de 30 dias em cookie
  `httpOnly` com `Path=/v1/auth`. Segredos separados. Reuso de refresh derruba
  a família inteira.
- **Verificação em duas etapas** — opcional para os clientes (`/seguranca`),
  obrigatória para o admin da plataforma. TOTP com janela consumida gravada,
  então um código interceptado não serve duas vezes. Dez códigos de
  recuperação, guardados como hash e válidos uma vez cada. O segundo fator é
  cobrado **depois** da senha: pedir antes diria que a conta existe.
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
| [0006](docs/adr/0006-api-publica-e-webhooks.md) | API pública por chave e webhooks de saída |
| [0007](docs/adr/0007-white-label-e-css-do-cliente.md) | White-label e CSS escrito pelo cliente |
| [0008](docs/adr/0008-analises-com-ia-e-redacao-de-pii.md) | Análises com IA e redação de PII |
| [0009](docs/adr/0009-admin-da-plataforma.md) | Admin da plataforma, MFA e impersonação |

---

## Roteiro

- [x] **Fase 1 — Fundação.** Monorepo, RLS, autenticação, RBAC, suíte de
      isolamento.
- [x] **Fase 2 — Produto (backend).** Schema de formulário, versionamento,
      renderizador público, submissão, uploads, painel de recebimentos,
      exportações em fila. O builder drag-and-drop e o app React entram junto
      com o frontend, na Fase 3.
- [~] **Fase 3 — Comercialização.** Quotas com buffer de 48h,
      `PaymentProvider` + `AsaasProvider`, boleto/Pix/cartão, máquina de
      estados com tolerância, webhooks idempotentes, reconciliação diária,
      página de preços, painel de cobrança e telas de Pix e boleto.
      **Falta:** emissão de NFS-e e o disparo de dunning por e-mail — os dois
      dependem de credenciais externas.
- [x] **Fase 4 — Domínios e diferenciais.** Domínios próprios com verificação
      de DNS e Caddy + ACME sob demanda, white-label com CSS sanitizado por
      lista de permissão, webhooks de saída assinados, API pública por chave
      com escopos, análises com IA em fila com redação obrigatória de PII.
      Colaboração por tela: convites com papel, troca de papel com trava de
      escalada, comentários com @menção validada contra a equipe, e feed de
      atividades a partir do audit log.
- [~] **Fase 5 — Fechamento.** Admin da plataforma com MFA obrigatório,
      métricas por agregado e impersonação somente leitura auditada dos dois
      lados, OpenAPI derivado do código, guia de DNS por provedor brasileiro
      ([`docs/guia-dns.md`](docs/guia-dns.md)) e testes ponta a ponta com
      Playwright no CI.

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
