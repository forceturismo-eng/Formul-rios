# ADR 0003 — Autenticação, sessões e RBAC

- **Status:** aceito
- **Data:** 2026-08-04
- **Fase:** 1

## Tokens

**Access token** — JWT HS256, 15 minutos, no header `Authorization: Bearer`.
Carrega `sub` (usuário), `org` (tenant), `role`, `mid` (membership) e `ev`
(e-mail verificado).

**Refresh token** — JWT HS256, 30 dias, em cookie `httpOnly` com
`Path=/v1/auth`. O caminho restrito importa: o cookie não é enviado em nenhuma
outra rota, então nem XSS numa tela do painel nem um endpoint que ecoe headers
conseguem exfiltrá-lo.

### Segredos separados

`JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET` são distintos. Um access token não
pode ser reapresentado como refresh e vice-versa — nem por confusão de código,
nem por um atacante que consiga apenas um dos dois. Há teste cobrindo isso.

A verificação fixa `algorithms: ['HS256']`, o que fecha `alg: none` e confusão
de algoritmo. Também há teste.

### O tenant vem do token, e só dele

O `organizationId` viaja dentro do JWT assinado. Adulterar o payload quebra a
assinatura; forjar do zero exige o segredo. É isso que transforma "trocar de
empresa" em "401" em vez de "acesso ao concorrente".

O login aceita um `organizationId` opcional, mas ele é **preferência, não
autorização**: o servidor só o honra se existir membership aceita. Um id de
empresa alheia cai no fallback, nunca em acesso.

## Rotação com detecção de reuso

Cada refresh queima o token apresentado e emite outro na mesma **família**
(`familyId`).

Se um token **já revogado** for reapresentado, há duas explicações possíveis: o
cookie vazou e alguém usa uma cópia, ou o legítimo está repetindo um request
antigo. Não dá para distinguir. Então a família inteira cai e as duas partes
refazem login.

Perder uma sessão é barato. Manter aberta uma sessão vazada não é.

## Verificação de membership a cada request

O papel no token pode envelhecer: alguém removido da empresa continuaria dentro
por até 15 minutos, com o papel antigo. Por isso `requireAuth` revalida a
membership no banco a cada request e usa o papel **de lá**, não o do token.

O custo é uma consulta por request. Quando isso pesar, o caminho é cachear a
membership no Redis com invalidação na remoção — não voltar a confiar no claim.

## Senhas

Argon2id com `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1` (primeira
recomendação do OWASP). Custo de memória é o que faz GPU render pouco.

**Enumeração por tempo.** Login com e-mail inexistente também paga o custo de
um Argon2id, contra um hash descartável. Sem isso, o tempo de resposta diria
quais contas existem.

**Senhas vazadas.** Lista local de senhas comuns, mais detecção de padrões de
baixa entropia e de "raiz comum + dígitos" — `senha123456`, `password2025`,
`admin1234`. A política de comprimento sozinha deixa todas essas passarem.
A interface `LeakedPasswordChecker` permite plugar HIBP por k-anonymity depois;
a checagem local roda primeiro, para que indisponibilidade de rede nunca deixe
passar o óbvio.

## Enumeração de contas

Três rotas foram tratadas caso a caso:

| Rota | Comportamento | Por quê |
|---|---|---|
| `POST /v1/auth/login` | mensagem idêntica para e-mail inexistente e senha errada | não pode dizer se a conta existe |
| `POST /v1/auth/resend-verification` | sempre 202 | idem |
| `POST /v1/auth/register` | **409 explícito** quando o e-mail já existe | ver abaixo |

O registro destoa de propósito. Esconder a duplicidade quebra o cadastro de
quem esqueceu que já tem conta, e a enumeração continuaria possível pelo fluxo
de convite. O ganho de segurança não paga o custo de usabilidade.

## RBAC

Matriz centralizada em `packages/shared/src/rbac.ts`, exposta como
`can(subject, action, resource)`. Nenhuma checagem de permissão vive em
controller.

| Papel | Escopo |
|---|---|
| `owner` | Tudo + billing + deletar organização + transferir posse |
| `admin` | Membros, todos os formulários, configurações (sem billing) |
| `editor` | Cria/edita os próprios formulários, vê respostas dos que tem acesso |
| `viewer` | Somente leitura das respostas liberadas |

### Decisão sobre `form_permissions`

O documento de produto diz que `form_permissions` "sobrepõe o papel padrão".
Isso foi implementado com uma ressalva: **a sobreposição vale para `editor` e
`viewer`, mas não tira acesso de `owner` e `admin`**.

Permitir que um editor tranque o dono fora de um formulário da própria empresa
criaria dados órfãos sem caminho de recuperação — e o owner é quem responde
legalmente pelo conteúdo perante a LGPD.

### 403 ou 404

- **404** quando o recurso pertence a outra organização, ou quando o usuário
  não tem acesso ao formulário que governa o recurso. Um 403 confirmaria a
  existência, e isso já é vazamento.
- **403** apenas para ações de escopo organizacional em que a existência já é
  conhecida de quem pergunta — um viewer tentando ler o audit log da própria
  empresa, por exemplo.

## Separação de domínios

`requireAppHost` roda antes de qualquer rota autenticada e compara o `Host`
com a lista de hosts da aplicação. Domínio de cliente recebe **404** — pelo
domínio do cliente, o painel não existe.

Como o tenant sai do token e não do `Host`, forjar o header não move ninguém de
empresa: no máximo tira acesso de quem forjou. `X-Forwarded-Host` é ignorado, e
`trustProxy` só é ligado em produção — senão `request.ip` seria o que o cliente
escrever, e o rate limit por IP viraria decoração.
