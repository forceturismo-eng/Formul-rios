# ADR 0007 — White-label e CSS escrito pelo cliente

- **Status:** aceito (implementação na Fase 4)
- **Data:** 2026-08-05

## Contexto

A seção 8.5 pede logo, cores, favicon, título da aba, meta tags OG por
organização, remoção da nossa marca nos planos Pro+ e **CSS customizado
sanitizado** no Business+.

O último item é de outra natureza. Os demais são valores estruturados que
validamos com uma expressão regular. CSS customizado é uma linguagem inteira,
escrita por um cliente, que termina dentro de uma tag `<style>` numa página que
**nós** servimos — e não só no domínio do cliente: o mesmo formulário responde
em `<app>/f/<slug>`, o domínio onde vivem as sessões de todo mundo.

Um escape daqui não é um problema de layout. É XSS no nosso domínio.

## Decisão 1 — lista de permissão, nunca de bloqueio

O conjunto de propriedades CSS cresce a cada versão dos navegadores. Uma lista
de bloqueio ficaria desatualizada sozinha, sem ninguém perceber, e a primeira
notícia viria de um incidente.

Então: seletor validado por charset, propriedade conferida contra uma lista
explícita, valor recusado se contiver qualquer trecho perigoso. O que não está
na lista não passa — e pedido de propriedade nova é uma linha em
`packages/shared/src/white-label.ts`, com quem revisa olhando.

**A propriedade que sustenta o resto:** nenhuma entrada produz `<` na saída.
Sem `<` não existe `</style>`, e sem `</style>` não existe fuga para o HTML.
É uma invariante simples o bastante para caber num teste, e o teste existe com
seis vetores.

### Ausências deliberadas

| Propriedade | Por que fica de fora |
| --- | --- |
| `position` | `fixed` cobre a página inteira. Sobreposição em cima de um formulário é phishing convincente. |
| `content` | Injeta texto que não está no formulário — inclusive texto que contradiz o rótulo do campo ao lado. |
| `cursor`, `pointer-events` | Escondem que um elemento é clicável, ou fingem que é. |
| `behavior`, `-moz-binding`, `filter` | Executam script em navegadores antigos. |

E, em qualquer valor: `url(` (exfiltração por GET, sem script nenhum),
`expression(`, `javascript:`, `@import` e `\` — porque escape CSS codifica
todos os outros (`\75 rl(` é `url(`).

`!important` é removido, mas a declaração fica. A folha do cliente já vem
depois da nossa; ela ganha sem precisar disso, e com `!important` ela venceria
também o estilo de erro e o de foco.

## Decisão 2 — sanitizar na leitura, não na gravação

O banco guarda o CSS **cru**, como o cliente escreveu. A sanitização acontece a
cada renderização.

Custa CPU por render. Em troca, endurecer a lista de permissão passa a valer
imediatamente para tudo que já está gravado, sem migração de dados e sem uma
janela em que o conteúdo antigo continua servido pela regra antiga.

Também é o que permite o editor do painel mostrar o texto original: filtrar o
que o cliente está editando apagaria o trabalho dele a cada gravação. O painel
mostra o cru e, ao lado, a lista do que não vai ao ar.

## Decisão 3 — guardar e aplicar são decisões diferentes

`effectiveBranding` recebe a organização e o plano, e é a única função que
decide o que sai na página.

Cenário concreto: a empresa gravou CSS no Business e caiu para Starter por falta
de pagamento. O CSS continua no banco — para voltar inteiro se ela reassinar —
e para de ser servido no mesmo instante. Nenhuma rotina apaga nada.

A gravação, essa sim, é recusada quando o plano não inclui o recurso: deixar
salvar algo que nunca vai aparecer é prometer o que o plano não entrega.

## Decisão 4 — meta tags no HTML, não por script

Meta tag preenchida por JavaScript não serve para o caso que mais importa aqui.
Formulário no Brasil circula por WhatsApp, e o robô que monta o cartão de prévia
não roda script: ele lê o HTML que chegou e vai embora.

Então `GET /f/:slug` responde por negociação de conteúdo:

- `Accept: text/html` → shell da SPA com o `<head>` já preenchido;
- qualquer outro → o JSON de sempre.

Com `Vary: Accept`, porque sem ele um cache compartilhado serviria HTML a quem
pediu JSON.

O `<title>` original do shell é **removido** antes da injeção: dois títulos no
mesmo documento fazem o robô escolher, e ele escolhe o primeiro — que seria o
genérico do índice.

Quem decide o conteúdo das tags é `buildMetaTags`, uma função só, usada tanto
pelo HTML quanto pelo JSON. Duas chamadas independentes seriam duas chances de
divergir.

Todo valor interpolado passa por `escapeHtml`. O nome da empresa é digitado pelo
cliente e termina dentro de um atributo entre aspas.

`noindex, nofollow` em todo formulário: um link que circula por WhatsApp e
aparece no Google é contexto exposto que o cliente não pediu.

## Decisão 5 — a marca some do JSON, não só da tela

Nos planos Pro+, `showBranding` é falso **e** `productName` vem vazio. Esconder
o rodapé na tela não bastaria: o respondente pode abrir o inspetor, e a seção 12
diz que nada menciona a plataforma quando o white-label está ativo.

## Consequências

- A tela não sanitiza nada. Uma segunda implementação da mesma regra no cliente
  seria uma segunda chance de errar, e a que vale é a do servidor.
- `dangerouslySetInnerHTML` numa `<style>` é o único jeito de injetar uma folha
  inteira. O nome do atributo é honesto — o que torna a chamada segura é a
  invariante do `<`, não o React.
- CSS válido que usa propriedade fora da lista some **em silêncio** para quem
  não olha a lista de removidos. Daí a prévia ao lado do editor.
- O shell HTML depende de `apps/web/dist/index.html`. Sem ele — em
  desenvolvimento, com o Vite servindo a SPA — a rota devolve JSON, que é o
  comportamento que ela sempre teve.

## Alternativas descartadas

**Usar uma biblioteca de sanitização de CSS.** As disponíveis são orientadas a
sanitizar CSS *confiável* contra erro, não CSS *hostil* contra ataque, e todas
carregam um parser completo como superfície nova. A lista de permissão é menos
código e mais fácil de auditar.

**Servir o CSS do cliente num arquivo separado com CSP restritiva.** Resolveria
a fuga da tag `<style>` de outro jeito, mas exigiria uma requisição a mais no
caminho mais quente do produto e não resolveria `url()` nem `position`.

**Permitir `position` no Enterprise.** É o pedido mais provável de chegar. Fica
recusado enquanto não houver como distinguir um layout legítimo de uma
sobreposição — e essa distinção não é sintática.
