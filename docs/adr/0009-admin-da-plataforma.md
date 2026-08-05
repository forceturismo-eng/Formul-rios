# ADR 0009 — Admin da plataforma, MFA e impersonação

- **Status:** aceito (implementação na Fase 5)
- **Data:** 2026-08-05

## Contexto

A seção 5.5 pede uma área para quem opera o SaaS: lista de organizações, MRR,
churn, uso agregado, inadimplência, suspender e reativar conta, ajustar plano, e
impersonar cliente **apenas** com registro em `audit_logs` e banner visível
permanente. Autenticação distinta e MFA obrigatório.

O que está em jogo: é a única conta do sistema que enxerga todos os clientes. O
resto da plataforma foi desenhado para que ninguém consiga sair do próprio
tenant — e aqui, deliberadamente, criamos alguém que consegue. Cada decisão
abaixo existe para tornar esse alguém o mais estreito possível.

## Decisão 1 — tabela separada, não uma coluna em `users`

`platform_admins` é uma tabela própria, com credenciais próprias e rotas
próprias.

Uma coluna `is_platform_admin` em `users` significaria que toda consulta de
login precisa acertar a checagem, para sempre — e que um bug na autenticação de
cliente pode virar acesso de admin. Com tabelas distintas, os dois caminhos não
se encontram: nem por confusão de código, nem por um `WHERE` esquecido.

O token tem **audience própria** (`<audience>:admin`). Um token de cliente
apresentado numa rota de admin falha na verificação de audience antes de
qualquer checagem de papel, e o contrário também. Isso não é defesa contra um
atacante — quem tem o segredo de assinatura forja o que quiser. É defesa contra
nós, contra o dia em que alguém chamar `verifyAccessToken` numa rota de admin
por descuido.

Sessão de 30 minutos, **sem refresh**. A conveniência de ficar logado não paga o
risco de uma sessão de admin esquecida aberta.

## Decisão 2 — MFA obrigatório de verdade

Enquanto `totp_enabled_at` for nulo, `loadAdmin` devolve `null` e **nenhuma**
rota de admin responde. O primeiro login com a senha correta devolve o QR Code e
mais nada.

O segredo é gravado no primeiro login, mas o MFA só é **ligado** depois que o
admin prova ter conseguido lê-lo. Sem essa separação, um erro na leitura do QR
Code trancaria a conta para sempre.

TOTP implementado à mão (`apps/api/src/auth/totp.ts`): são quarenta linhas de
HMAC e aritmética, o algoritmo está congelado desde 2011, e uma dependência no
caminho da autenticação do admin é superfície que precisaria ser auditada a cada
atualização. Os vetores do RFC 6238 estão no teste — é o que prova
compatibilidade com Google Authenticator e afins, e não só consigo mesmo.

**Reuso de código bloqueado.** Um TOTP vale por até 90 segundos (janela atual
mais uma para cada lado). `last_totp_window` guarda a janela consumida, e um
código já usado é recusado dentro do tempo em que ainda seria matematicamente
válido.

## Decisão 3 — o admin lê agregados, não linhas

Esta é a decisão que mais reduz o risco, e ela é estrutural em vez de
processual.

MRR, churn, inadimplência e uso são servidos por funções `SECURITY DEFINER` que
**só sabem devolver número e metadado**: `app_admin_metrics()`,
`app_admin_organizations()`, `app_admin_organization()`. Não existe parâmetro
que as faça devolver conteúdo de resposta, porque a função não tem essa coluna
no retorno.

O efeito prático: mesmo com um bug nas rotas de admin — um `where` esquecido, um
parâmetro mal validado — o conteúdo dos clientes não sai por ali. Há um teste em
`rls-database.test.ts` que lê a assinatura das funções no catálogo do Postgres e
falha se alguém acrescentar uma coluna de conteúdo ao retorno.

O único dado pessoal que aparece sem impersonar é o **e-mail do owner**, na tela
de detalhe, e ele existe para o suporte conseguir responder a quem abriu o
chamado.

## Decisão 4 — impersonação é somente leitura

A seção 5.5 exige trilha e banner. Nós fomos além: **nenhuma escrita** durante a
impersonação. Qualquer método que não seja `GET`/`HEAD`/`OPTIONS` responde 403.

O motivo é o caso de uso. Impersonar serve para suporte — "não estou vendo meu
formulário" —, e ver não precisa de escrita. Escrever sob impersonação é o
cenário ruim: um operador nosso alterando ou apagando dado na conta de um
cliente, com o registro dizendo que foi o cliente. Nem a trilha resolve isso
direito, porque o estrago já aconteceu.

Se um dia for preciso escrever em nome do cliente — corrigir um cadastro a
pedido dele —, que seja uma rota de admin explícita, com o motivo registrado, e
não um efeito colateral de estar "dentro da conta".

### Como funciona

O token de impersonação é um **access token de cliente comum**, com dois claims
a mais (`imp`, `impe`). Reaproveitar o formato é proposital: toda rota de
cliente enxerga a impersonação sem precisar saber que ela existe, e nenhuma
delas pode esquecer de conferir. O RLS, o tenant e o papel continuam exatamente
os mesmos.

Quinze minutos, sem renovação. Tempo de olhar um problema.

O alvo é sempre o **owner mais antigo** da empresa: é a conta com visão
completa, e fixar o critério evita que a escolha vire mais uma decisão do
operador.

## Decisão 5 — a trilha é registrada dos DOIS lados, antes de emitir

`admin_actions` é nossa: quem fez, em qual empresa, por quê. `audit_logs` da
empresa recebe a entrada correspondente, porque **é direito do cliente saber que
alguém da plataforma entrou na conta dele** — no próprio painel, sem precisar
pedir.

A gravação acontece **antes** de o token ser emitido. Se ela falhar, não há
token: melhor uma impersonação que não aconteceu do que uma sem rastro.

Motivo é obrigatório em toda ação sobre a conta de um cliente — impersonar,
suspender, mudar plano. Uma trilha que diz "alguém suspendeu" sem dizer por quê
não resolve a pergunta que se faz três meses depois.

`admin_actions` é **append-only**: o papel da aplicação tem `SELECT` e `INSERT`,
nunca `UPDATE` ou `DELETE`. Trilha que o próprio operador pode editar não é
trilha. A revogação está tanto na migration quanto em `scripts/db-roles.mjs`,
para a ordem entre os dois deixar de importar.

## Decisão 6 — RLS em `admin_actions`, com política invertida

A tabela tem `organization_id`, e a regra do projeto é que toda tabela com essa
coluna tenha RLS habilitado e forçado. Mas ela não é do cliente.

A política diz isso em SQL:

```sql
CREATE POLICY admin_actions_sem_tenant ON admin_actions
  USING (app_current_org_id() IS NULL)
  WITH CHECK (app_current_org_id() IS NULL);
```

Visível **apenas fora** de um contexto de tenant. Um request de cliente sempre
passa por `withTenant`, que faz o `SET LOCAL`; para ele, a tabela é vazia. As
rotas de admin não abrem contexto de tenant, e por isso enxergam.

O efeito colateral é útil: se alguém um dia ler esta tabela de dentro de um
request de cliente, por engano, o resultado é vazio em vez de vazamento.

## Consequências

- O banner de impersonação vem do **servidor**, em `/v1/organizations/current`.
  Um banner que a tela pudesse escolher não desenhar não seria garantia nenhuma.
- O rate limit do login de admin é 5 tentativas por 15 minutos, por IP — mais
  apertado que o de cliente, porque são poucas contas e força bruta aqui vale
  muito mais para quem tenta. A suíte de testes injeta de IPs diferentes em vez
  de afrouxar o limite.
- O seed cria `admin@plataforma.test` **sem** segredo TOTP. Semear um segredo
  conhecido derrotaria o propósito do MFA e, pior, criaria o hábito de copiá-lo
  para produção.
- `app_bootstrap` passou a enxergar `invoices`, `responses`, `usage_counters` e
  `users` — necessário para contar. A justificativa está escrita no teste que
  trava essa lista, e o que a torna aceitável é o formato do retorno das
  funções, não o papel de quem chama.

## Alternativas descartadas

**Um papel `superadmin` dentro do modelo de RBAC existente.** Seria menos
código, e é o que a maioria dos SaaS faz. Descartado: significaria que a
autorização de cliente e a de operador compartilham a mesma tabela de
permissões, e um erro nela vaza nos dois sentidos.

**Impersonação com escrita, liberada por um segundo motivo.** Some com a
distinção que torna a trilha confiável — se o operador pode escrever, "foi o
cliente" deixa de ser verificável.

**Dashboard com acesso direto às tabelas, filtrando na aplicação.** É o caminho
óbvio e o que quase sempre se faz. Descartado porque transforma cada consulta
nova do painel numa oportunidade de vazar conteúdo, e nenhuma revisão de código
pega todas.

**MFA opcional, "recomendado".** Opcional significa desligado na conta que mais
importa. Aqui ele bloqueia o acesso enquanto não estiver configurado.
