# Contexto do projeto

Plataforma SaaS de formulários online no modelo Jotform, multi-empresa, vendida
por assinatura para o mercado brasileiro. A especificação de produto original
(13 seções) foi entregue como "PROMPT MESTRE"; este arquivo guarda o que uma
sessão nova precisa saber para continuar sem reler tudo.

**Sempre responda em português.**

---

## Onde está o resto

| Documento | Para quê |
|---|---|
| [`README.md`](README.md) | Como subir, estrutura, rotas, estado atual |
| [`docs/adr/`](docs/adr/) | **As nove decisões que explicam o "por quê"** — leia antes de mudar qualquer coisa nessas áreas |
| [`docs/guia-dns.md`](docs/guia-dns.md) | Guia de DNS por provedor brasileiro |
| `/openapi.json` e `/docs` | API, gerada a partir das constantes do código |

Os ADRs não são formalidade: cada um registra uma alternativa descartada e o
motivo. Se algo parecer estranho no código, a explicação provavelmente está lá.

---

## Regras que não se negociam

**1. Isolamento entre empresas, em quatro camadas** (ADR 0001). Coluna
`organization_id NOT NULL`, RLS com `ENABLE` + `FORCE`, contexto de request via
`SET LOCAL` dentro da transação, e a camada de repositórios. A suíte
`tests/isolation` é bloqueante — nenhuma mudança avança com ela vermelha.

**2. 404, nunca 403, para recurso de outra empresa.** Um 403 confirma que o
recurso existe. Vale também para ID malformado.

**3. O tenant vem do token verificado.** Nunca de body, query, header (inclusive
`Host`) ou path. A única exceção é o renderizador público, onde o slug resolve a
empresa — e o contexto resultante não alcança respostas nem configurações.

**4. `SECURITY DEFINER` não contorna RLS.** Com `FORCE ROW LEVEL SECURITY` nem o
dono da tabela escapa. Daí existir o papel `app_bootstrap` (NOLOGIN, BYPASSRLS),
dono das funções de bootstrap. Ver ADR 0002.

**5. SQL cru só em `db/tenant.ts` e `db/bootstrap.ts`.** Há um teste que falha
se aparecer em qualquer outro arquivo da API.

**6. Nada de dado pessoal em log, audit log ou mensagem de erro.** Respostas são
cifradas em repouso (envelope, AES-256-GCM por resposta). IP e user-agent só em
hash.

---

## Convenções

- **Código e comentários em português.** Nomes de variáveis e funções também.
- Comentários explicam **por que**, não o que. Comentário que narra a linha
  seguinte é ruído.
- Testes com nome descritivo em português, e um comentário dizendo o que o caso
  protege quando isso não for óbvio.
- Erros ao usuário: linguagem simples, sem jargão, sem culpar quem leu.
- Mensagens ao respondente **nunca** mencionam plano, limite, pagamento — nem o
  nome da plataforma quando o white-label está ativo.

---

## Armadilhas já encontradas (não repetir)

**Retentativa dentro de transação não funciona.** No Postgres, uma violação de
unicidade aborta a transação inteira; o próximo comando falha com um erro que
não é `P2002`. `createForm` abre uma transação **por tentativa** de slug por
causa disso.

**`app_current_org_id()` usa `NULLIF`.** Sem ele, `''::uuid` levanta exceção em
vez de devolver zero linhas.

**Lock otimista por contador `revision`, não por `updatedAt`.** `timestamptz`
tem microssegundos, `Date` tem milissegundos.

**`ancestorsOf` precisa parar em sufixo público.** Sem `isPublicSuffix`, uma
plataforma em `app.produto.com.br` bloquearia todos os `.com.br` dos clientes.

**O CSS do cliente nunca pode produzir `<`.** É a invariante que impede fechar a
`<style>` e virar XSS. Lista de **permissão**, nunca de bloqueio (ADR 0007).

**A redação de PII não é opcional.** O documento chama de "opção"; aqui é
sempre. Ver ADR 0008 para o motivo.

**Impersonação é somente leitura.** Aperto além do que a seção 5.5 pede
(ADR 0009).

**Suítes que criam formulários precisam limpar.** No CI o banco nasce vazio e o
acúmulo nunca aparece; localmente chegou a 484 formulários num plano de 50.
Use `PREFIXO_DE_TESTE` de `tests/helpers/limpeza.ts` nos títulos.

**O seed cifra de verdade.** Já gravou `randomBytes` fingindo ser conteúdo
cifrado por três fases sem ninguém notar.

**@menção só vale para quem é da empresa.** Sem validar contra a lista de
membros, `@qualquer@coisa.com` faria a plataforma mandar e-mail para endereço
arbitrário, em nome do cliente e com a nossa reputação de remetente.

**O aviso de menção não leva o comentário.** Ele fala de uma resposta de
formulário; e-mail é o canal menos controlado que existe.

**Gestão de equipe é onde a escalada de privilégio mora.** Três travas:
ninguém dá papel acima do próprio, ninguém mexe em quem está acima, e o último
`owner` não pode ser rebaixado nem sair.

**Ativar o MFA consome a janela TOTP.** É o que impede reusar um código
interceptado — e é também por que o teste que ativa e depois entra precisa do
código da janela *seguinte*, não do mesmo. Ver `codigoDaProximaJanela` em
`tests/integration/mfa-flow.test.ts`.

**O segundo fator é cobrado depois da senha e das memberships.** Pedir o código
antes de conferir a senha responderia `mfa_required` para e-mail qualquer,
dizendo quais contas existem.

**"Serve uma vez" só vale se quem decide for o `WHERE` do UPDATE.** Duas
tentativas simultâneas leem o mesmo estado antes de qualquer uma gravar, e a
checagem em memória deixa as duas passarem. Daí os `updateMany` condicionais em
`verificarSegundoFator` — o Postgres reavalia o `WHERE` depois do lock da linha.

**O rate limit vive no Redis, com prefixo por processo em teste.** Ele passou a
ser compartilhado e a sobreviver 15 minutos; sem o prefixo, uma execução da
suíte estouraria o limite da seguinte. E `enableOfflineQueue` fica LIGADO: com
ele desligado, os comandos emitidos antes de a conexão ficar pronta falham e o
`skipOnError` os engole em silêncio.

---

## Estado

Fases 1 a 5 concluídas, colaboração e MFA de clientes inclusos. 791 testes de
suíte + 3 e2e; lint e typecheck limpos.

Branch de trabalho: `claude/criar-sistema-g1np9i`.

### Pendências conhecidas

| O quê | Observação |
|---|---|
| NFS-e | Depende de credencial de provedor fiscal |
| Dunning por e-mail | Depende de SMTP/Resend real; o mailer atual é em memória com outbox |
| Mailer real | Idem |
| Driver S3 | Existe a interface `StorageProvider`; o driver ativo grava em disco |
| Builder multi-página e editor de lógica | O schema suporta; a interface ainda não |
| Checkout com cartão | Pix e boleto funcionam |

### Marcadores do documento original

`[PRODUTO]`, `[DOMINIO_APP]` e `[DOMINIO_CNAME]` ficaram configuráveis por
`.env` (`PRODUCT_NAME`, `APP_DOMAIN`, `CNAME_DOMAIN`) porque o usuário optou por
decidir depois. Não os fixe em código.

---

## Ambiente de desenvolvimento

Este container não tem Docker daemon. PostgreSQL e Redis rodam nativamente:

```bash
service postgresql start && service redis-server start
```

Eles caem quando o container recicla — se um teste falhar com "Can't reach
database server", é isso antes de ser qualquer outra coisa.

Playwright usa o Chromium já instalado em `/opt/pw-browsers`. Para capturar as
telas do produto:

```bash
CAPTURAR_TELAS=1 npx playwright test tests/e2e/telas.spec.ts
```

`npm run db:reset` é destrutivo e o Prisma exige consentimento explícito do
usuário — pergunte antes.
