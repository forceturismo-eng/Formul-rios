# ADR 0008 — Análises com IA e redação de PII

- **Status:** aceito (implementação na Fase 4)
- **Data:** 2026-08-05

## Contexto

A seção 5.3 pede análises das respostas — sentimento, temas recorrentes, resumo
executivo, outliers, sugestões de melhoria do formulário — com opt-in explícito,
sempre em fila, com cache por `input_hash`, contabilidade de token e **opção de
redigir PII antes do envio**.

O problema não é técnico. É de quem decide o quê.

A resposta de um formulário é dado pessoal do **cliente do nosso cliente** —
alguém que nunca ouviu falar de nós, não leu nossos termos e não consentiu com
nada. Mandar isso para uma API de terceiro é uma escolha com consequência para
essa pessoa, e ela não é nossa para fazer por conta própria.

Daí duas decisões que o documento trata como opcionais e aqui não são.

## Decisão 1 — a redação não é opcional

O documento diz "opção de redigir PII antes do envio". Implementamos como
**sempre**, sem interruptor.

Um interruptor de redação seria um botão cujo estado desligado significa
"vazar dados de terceiros" — e alguém acabaria clicando nele, por engano ou por
achar que a análise fica melhor. A análise fica boa o suficiente com
pseudônimos, e o risco do contrário é grande demais para caber numa preferência.

### Duas camadas, e a ordem importa

| Camada | Como funciona | Pega o quê |
| --- | --- | --- |
| **Tipo de campo** | O schema diz que o campo é `cpf_cnpj`, `email`, `phone_br`, `cep`, `address`, `signature` | O valor inteiro, mesmo mal formatado |
| **Padrão no texto** | Regex sobre o conteúdo | CPF digitado dentro de "Conte o que aconteceu" |

A primeira é a forte; a segunda é a rede. Campo que o schema não conhece — um
campo removido do formulário depois de já ter respostas — cai na segunda, nunca
passa direto.

Nome vem de heurística de rótulo (`Nome`, `Responsável`, `Contato`) em campos de
texto curto. Ela erra nos dois sentidos: "Nome do produto" some sem precisar, e
"Como podemos te chamar" passa. **Escolhemos errar para o lado de apagar
demais** — perder um dado da análise custa menos do que vazá-lo.

### Pseudônimo estável, não asterisco

`[CPF_1]`, e o mesmo valor recebe o mesmo rótulo em toda a análise. Com `***`,
todo mundo vira a mesma pessoa e a IA não consegue mais dizer "a mesma pessoa
reclamou duas vezes" — que é justamente o tipo de conclusão pela qual o cliente
paga.

Um redator por análise. Compartilhar o mapa entre análises faria `[CPF_1]`
significar pessoas diferentes em cada uma e, pior, permitiria correlacioná-las.
O mapa vive na memória do job e morre com ele: gravá-lo seria reconstruir
exatamente o que a redação desfez.

### A ordem dos padrões não é arbitrária

```
e-mail → cartão → CNPJ → CPF → telefone → CEP
```

- e-mail primeiro: `39053344705@exemplo.com.br` tem um CPF dentro;
- cartão antes de CNPJ e CPF: 16 dígitos contêm sequências de 14 e 11;
- CNPJ antes de CPF: 14 dígitos começam com 11 que parecem CPF;
- CEP por último, e **só com hífen**: `\d{8}` cru apagaria número de protocolo.

Cartão exige dígito verificador de Luhn. Sem isso, todo número de pedido longo
sumiria da análise.

### Três conferências

`assertRedacted` roda ao montar o job, no worker antes de chamar, e dentro do
provedor imediatamente antes do `fetch`. É barato e fecha o caso em que um
caminho novo monta o prompt sem passar pela redação: o job quebra em vez de
mandar dado para fora.

O provedor **falso dos testes implementa a mesma trava**. Um falso permissivo
deixaria a suíte verde exatamente no caso que ela existe para pegar.

## Decisão 2 — consentimento antes de qualquer leitura

Padrão desligado, com data e autor gravados. Só quem tem `ai:configure` muda, e
a mudança vai para o audit log nos dois sentidos.

O portão vem **antes** de decifrar qualquer resposta. Se ele estivesse depois, o
conteúdo já teria virado prompt em memória antes de alguém perceber — e a ordem
é o que torna a garantia verificável por teste.

## Decisão 3 — fila, sempre

A API prepara, confere os portões e enfileira. Quem chama o modelo é o worker.

Duas consequências: a chamada leva dezenas de segundos e não caberia num
request, e **a chave da API vive só no processo dos workers** — nenhum caminho
que o frontend alcança tem acesso a ela.

Concorrência 2, baixa de propósito: cada job é uma chamada longa e paga, e uma
rajada de análises vira custo antes de virar valor.

## Decisão 4 — cache por `input_hash`, conferido duas vezes

O hash é do conteúdo **já redigido**, mais o tipo. Pedir de novo a mesma análise
sobre as mesmas respostas devolve o resultado gravado, com HTTP 200 em vez de
202, sem gastar token nem cota.

O worker confere o cache **de novo** antes de chamar: entre o enfileiramento e a
execução, outro job pode ter produzido exatamente esta análise.

A cota é debitada **depois** de a análise existir. Cobrar por uma chamada que
falhou seria cobrar pelo nosso problema.

## Decisão 5 — o worker não confia no `formId` do job

Payload de fila não é fonte confiável de autorização. E a checagem de chave
estrangeira do Postgres **não passa pelo RLS** — ela roda como sistema —, então
um `formId` de outra organização gravaria uma linha com referência cruzada sem
erro nenhum.

O worker confere que o formulário pertence à organização do job antes de
escrever. Isto foi encontrado por teste, não por revisão.

## Consequências

- Uma resposta que não decifra **não derruba a análise das outras**. Linha
  corrompida, restauração parcial ou rotação de chave malfeita são raros e
  possíveis; nenhum é motivo para o recurso parar. Elas ficam de fora, são
  contadas, e o número aparece para quem pediu.
- O prompt de sistema explica os pseudônimos ao modelo. Sem isso ele tenta
  "corrigi-los" inventando nomes.
- O corpo de erro do provedor **não** entra na mensagem de exceção: ele pode
  ecoar o prompt, e o prompt vai para o log de quem estiver depurando.
- O audit log registra a análise sem o conteúdo dela. Ele é lido por gente que
  não precisa ver resposta de cliente.
- Todo resultado na tela leva o selo "Gerado por IA", e o interruptor de
  desligar fica na mesma tela onde o recurso é usado — não escondido em
  configurações.

## Alternativas descartadas

**Mandar as respostas sem redigir, com aviso no termo de uso.** É o que a maior
parte do mercado faz. Descartado: o termo é aceito pelo nosso cliente, e quem
tem o dado exposto é o cliente dele.

**Cifrar o prompt e deixar o provedor decifrar.** Não existe: se o modelo lê, o
provedor lê.

**Guardar o mapa de pseudônimos para poder "des-redigir" o resultado.** Faria a
análise citar nomes reais, o que soa útil no suporte. Descartado: guardar o mapa
é guardar exatamente o que a redação removeu, e num lugar novo.

**Rodar um modelo local para não enviar nada.** Resolveria o problema de raiz e
é a direção certa a prazo. Fora de escopo agora: exige GPU dedicada e uma
operação que a plataforma ainda não tem.
