# ADR 0006 — API pública por chave e webhooks de saída

- **Status:** aceito (implementação na Fase 4)
- **Data:** 2026-08-05

## Contexto

A partir do plano Pro o cliente integra os formulários ao próprio sistema. Isso
abre duas portas novas, e cada uma tem um problema próprio:

- **API pública.** Um segundo caminho de autenticação, sem cookie e sem sessão.
  Toda porta nova é uma chance nova de esquecer o `withTenant`.
- **Webhooks de saída.** O destino é uma URL escolhida pelo cliente. Isso é SSRF
  por construção: o nosso servidor passa a fazer requisições HTTP para onde um
  usuário mandar.

## Decisão 1 — a chave carrega o tenant, e o escopo carrega a autorização

O request chega com `Authorization: Bearer fx_live_…` e nada mais. O hash da
chave resolve a organização por `app_api_key_org(text)` — uma função
`SECURITY DEFINER` de dono `app_bootstrap`, o mesmo padrão do ADR 0002. O que
autoriza a consulta é a posse do segredo: a função recebe o **hash**, e só quem
tem a chave consegue produzi-lo.

A partir daí é o `withTenant` de sempre. Nenhum cabeçalho, parâmetro de query ou
campo de corpo participa da decisão de qual organização o request enxerga —
coberto por teste em `tests/isolation/api-keys.test.ts`.

Quem autoriza a ação é o **escopo da chave**, não o papel de um usuário: a chave
não pertence a uma pessoa. O `subject` sintético usa papel `owner` justamente
porque a limitação real acontece antes, na checagem de escopo.

Escopo insuficiente responde **403 com o nome do escopo que falta** — e não 404.
O recurso é da própria organização, esconder sua existência não protege ninguém
e atrapalha quem está integrando. Cross-tenant continua sendo 404.

O segredo aparece **uma vez**, na criação. O banco guarda apenas o hash e um
prefixo de 16 caracteres para identificar a chave na lista. Um dump do banco não
vira acesso à API dos clientes.

Chave inexistente, revogada e expirada respondem exatamente igual. O log
distingue os três casos; o cliente, não.

## Decisão 2 — o destino do webhook é validado duas vezes

Uma vez no cadastro, outra na entrega, e elas checam coisas diferentes:

| Momento | O que checa | Por quê |
| --- | --- | --- |
| Cadastro | protocolo https, host proibido, **IP literal** em faixa privada | feedback imediato ao cliente |
| Entrega | tudo isso **mais o IP resolvido** do host | `hooks.cliente.com.br` pode apontar para `127.0.0.1` |

A segunda é a que importa. Um nome DNS passa trivialmente na primeira barreira e
só revela o destino real na resolução — e o destino de referência é
`169.254.169.254`, o endpoint de metadata de AWS, GCP e Azure, que devolve as
credenciais da instância.

Duas decisões acompanham:

- **`redirect: 'manual'`.** Seguir um redirect anularia a checagem de IP que
  acabou de acontecer.
- **O corpo da resposta nunca volta ao cliente.** Resta uma janela de TOCTOU —
  o DNS pode mudar entre a resolução e a conexão — e fechá-la exigiria conectar
  por IP com Host manual, o que quebra SNI e certificado. A mitigação prática é
  a checagem mais o fato de que, mesmo num SSRF bem sucedido, nenhum conteúdo
  interno chega a quem cadastrou o webhook.

## Decisão 3 — o histórico de entregas guarda hash, não payload

`webhook_deliveries` registra evento, status, tentativa e um SHA-256 truncado do
corpo. O corpo em si contém a resposta do formulário, que é dado pessoal: uma
segunda cópia dele numa tabela de auditoria é superfície a mais sem contrapartida.
O hash basta para correlacionar as tentativas de um mesmo evento.

A tabela `webhooks` — que guarda o segredo do HMAC — está na lista de tabelas que
`app_bootstrap` **não** enxerga, verificada em `tests/isolation/rls-database.test.ts`.

## Decisão 4 — assinatura com timestamp

`X-Formularios-Signature: t=<timestamp>,v1=<hmac-sha256>`, sobre
`<timestamp>.<payload>`. O timestamp entra no HMAC para que uma entrega
capturada não possa ser reenviada meses depois; quem recebe confere a assinatura
**e** a idade (tolerância padrão de 5 minutos).

`verifySignature` é exportada para o cliente conferir do lado dele, e compara com
`timingSafeEqual`.

## Consequências

- O disparo acontece **fora** da transação que gravou a resposta. Enfileirar
  dentro dela entregaria webhooks de respostas que o rollback desfez.
- Falha de Redis não sobe para quem respondeu o formulário: o respondente não
  tem relação com a integração do dono do formulário.
- 20 falhas seguidas desligam o webhook. Bater indefinidamente num servidor morto
  é ruído para o cliente e custo para nós — e a tela de integrações mostra o
  estado desligado com o motivo.
- Retentativa em 1min, 5min, 30min, 2h e 6h. A janela total passa de meio dia
  porque endpoint de cliente cai por manutenção, e uma janela curta é a diferença
  entre perder o evento e entregá-lo mais tarde.

## Alternativas descartadas

**Guardar o payload das entregas para permitir reenvio manual.** Seria útil no
suporte, mas duplica dado pessoal numa tabela que ninguém cifra. Se virar
necessidade, entra cifrado com o mesmo envelope das respostas.

**Permitir http para endpoints internos do cliente.** Pedido comum de quem tem
o sistema numa rede fechada. Recusado: o payload leva dados de quem respondeu o
formulário, e em claro na rede isso é vazamento — não escolha do cliente.

**Lista de permissão de IPs de saída em vez de lista de bloqueio.** Mais seguro,
porém inviável: o cliente cadastra qualquer host público, e não há como enumerá-los.
A lista de bloqueio cobre exatamente as faixas que não podem ser alcançadas.
