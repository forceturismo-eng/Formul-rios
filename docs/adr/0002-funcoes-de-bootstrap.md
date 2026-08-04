# ADR 0002 — Funções de bootstrap e o papel `app_bootstrap`

- **Status:** aceito
- **Data:** 2026-08-04
- **Fase:** 1

## Contexto

O ADR 0001 estabelece que o `organization_id` sai do token verificado e que o
RLS bloqueia qualquer leitura sem contexto de tenant. Isso cria um problema
circular:

- **Login** precisa saber de quais empresas o usuário participa — está em
  `memberships`, que tem RLS.
- **Refresh** precisa achar a linha do token pelo hash, antes de saber a
  empresa — está em `refresh_tokens`, que tem RLS.
- **Aceitar convite** precisa resolver a empresa a partir do token do e-mail —
  está em `invitations`, que tem RLS.

Nos três casos, quem chama já provou posse de uma credencial. O que falta é
apenas descobrir **qual** tenant setar.

## Tentativa que não funcionou

A primeira implementação criou três funções `SECURITY DEFINER` pertencentes a
`app_migrator`, contando com o fato de que o dono da tabela ignora o RLS.

Falhou. `SECURITY DEFINER` **não desliga RLS** — ele apenas troca o usuário que
executa. E como todas as tabelas usam `FORCE ROW LEVEL SECURITY` (decisão
deliberada do ADR 0001), nem o dono escapa das políticas. As funções devolviam
zero linhas e o login respondia "sua conta não está vinculada a nenhuma
empresa ativa".

Vale registrar porque é um erro convidativo: a leitura natural de
`SECURITY DEFINER` é "roda como superusuário", e não é isso.

## Decisão

Um papel dedicado, `app_bootstrap`, dono das três funções:

```
CREATE ROLE app_bootstrap NOLOGIN NOSUPERUSER BYPASSRLS;
GRANT SELECT ON organizations, memberships, invitations, refresh_tokens
  TO app_bootstrap;
```

É o **único** papel do sistema com `BYPASSRLS`. O que torna isso aceitável:

1. **`NOLOGIN`.** Nenhuma conexão consegue se autenticar como ele. Ele só
   existe emprestando privilégio às funções que possui.
2. **Superfície mínima.** `SELECT` em quatro tabelas. Nada de formulários,
   respostas, arquivos, faturas ou audit logs — nem leitura.
3. **`app_runtime` não é membro dele.** A aplicação não consegue
   `SET ROLE app_bootstrap` para herdar o `BYPASSRLS`. Só pode executar as três
   funções, e há teste em `pg_auth_members` verificando isso.
4. **Nenhuma função aceita `organization_id`.** Não existe forma de pedir "os
   dados do tenant X". Só "os dados de quem já provou posse desta credencial".

### As três funções

| Função | Entrada | Devolve | Credencial exigida |
|---|---|---|---|
| `app_user_memberships(uuid)` | id do usuário | empresas daquele usuário | usuário já autenticado por senha ou refresh |
| `app_invitation_org(text)` | hash do token | ids do convite e da empresa | token que só quem recebeu o e-mail conhece |
| `app_refresh_token_org(text)` | hash do token | ids do token, empresa e usuário | cookie httpOnly do próprio navegador |

Todas são `STABLE`, `SET search_path = public, pg_temp` (contra sequestro de
search path) e devolvem o mínimo necessário para setar o contexto — o conteúdo
de verdade é lido depois, já sob RLS.

`app_refresh_token_org` devolve o token **mesmo revogado ou expirado**, de
propósito: a detecção de reuso precisa enxergar tokens já queimados para saber
que houve reuso.

## Onde isso vive no código

Exclusivamente em `apps/api/src/db/bootstrap.ts`, que é um dos dois arquivos
autorizados a usar `$queryRaw`. O outro é `db/tenant.ts`. A regra é verificada
por `tests/unit/raw-query-guard.test.ts`.

## Consequências

**Boas**

- O caminho de bootstrap é pequeno, nomeado e revisável: três funções, um
  arquivo, uma lista de tabelas.
- Não existe backdoor nas políticas de RLS. Nenhuma política tem cláusula
  "ou quando a flag X estiver ligada".

**Custos aceitos**

- Existe um papel com `BYPASSRLS`. Auditoria de segurança vai perguntar por
  ele, e a resposta precisa ser este documento.
- Adicionar uma função de bootstrap é uma mudança que exige revisão explícita:
  cada nova função amplia a superfície do único papel privilegiado.

## Alternativas descartadas

**Remover `FORCE ROW LEVEL SECURITY`.** Resolveria o problema deixando o
`app_migrator` ignorar as políticas. Também desligaria o isolamento nos seeds e
migrations, que é onde erros passam sem ninguém notar.

**Policies com escape.** Algo como
`USING (organization_id = app_current_org_id() OR current_setting('app.bootstrap', true) = 'on')`.
É um backdoor: qualquer ponto do código que setasse a flag desligaria o
isolamento inteiro, e isso não apareceria em nenhuma revisão de rota.

**Guardar as tabelas de auth fora do RLS.** Tirar `memberships`,
`invitations` e `refresh_tokens` da proteção resolveria o bootstrap, mas
`memberships` é justamente a tabela que responde "quem tem acesso ao quê" —
deixá-la aberta seria abrir a lista de funcionários de todos os clientes.
