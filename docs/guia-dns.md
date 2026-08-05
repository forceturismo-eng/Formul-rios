# Guia de DNS — domínio próprio, provedor por provedor

Este guia é para o **cliente** configurar `formularios.suaempresa.com.br`
apontando para a plataforma. Ele existe porque a instrução errada é a causa
número um de chamado em domínio próprio, e cada provedor brasileiro chama as
mesmas coisas por nomes diferentes.

> Onde este guia diz `custom.SEUDOMINIO` e `SEU.IP.AQUI`, use os valores que a
> tela **Integrações → Domínio próprio** mostra depois de você cadastrar o
> domínio. Eles mudam por ambiente; a tela é a fonte.

---

## Antes de começar: subdomínio ou domínio raiz?

Esta é a decisão que muda tudo o que vem depois.

| Você quer usar | É o quê | Registro |
|---|---|---|
| `formularios.suaempresa.com.br` | subdomínio | **CNAME** |
| `suaempresa.com.br` (a raiz) | apex | **A**, ou ALIAS/ANAME se o provedor tiver |

**Recomendamos o subdomínio.** O apex funciona, mas tem duas desvantagens
reais: o DNS não permite CNAME na raiz (é proibido pela especificação, não é
limitação de provedor), então ele precisa de um registro A apontando para um IP
— e IP muda. Se o nosso IP mudar, o subdomínio acompanha sozinho; o apex exige
que você atualize.

Além disso, usar a raiz do domínio para formulários costuma conflitar com o site
da empresa, que quase sempre já está lá.

---

## Os dois registros

Independente do provedor, você vai criar **dois** registros:

**1. O que aponta para cá.**

```
Tipo:  CNAME
Nome:  formularios
Valor: custom.SEUDOMINIO
```

**2. O que prova que o domínio é seu.**

```
Tipo:  TXT
Nome:  _verify.formularios
Valor: formularios-verificacao=<o token que a tela mostra>
```

O TXT existe porque qualquer pessoa pode apontar um domínio para o nosso IP. Sem
uma prova de posse, alguém poderia forçar a emissão de um certificado em nome de
um domínio que não é dele — o que esgotaria o nosso limite na Let's Encrypt e
nos tornaria infraestrutura de phishing. Depois que o domínio é verificado, você
pode remover o TXT; recomendamos deixar, porque revalidamos semanalmente.

---

## Registro.br

O Registro.br é o registrador dos domínios `.br`. Ele tem DNS próprio, e é onde
a maioria das empresas brasileiras começa.

1. Entre em [registro.br](https://registro.br) e vá em **Painel → Meus
   domínios**.
2. Clique no domínio, depois em **DNS → Editar zona**.
3. Clique em **Adicionar registro** e preencha:

   | Campo | Valor |
   |---|---|
   | Nome do host | `formularios` |
   | Tipo | `CNAME` |
   | Dados | `custom.SEUDOMINIO.` |

4. Adicione o segundo registro:

   | Campo | Valor |
   |---|---|
   | Nome do host | `_verify.formularios` |
   | Tipo | `TXT` |
   | Dados | `"formularios-verificacao=<token>"` |

5. Clique em **Salvar alterações**.

**O ponto final importa.** No Registro.br, o campo "Dados" de um CNAME precisa
terminar com ponto (`custom.SEUDOMINIO.`). Sem ele, o servidor entende o valor
como relativo e monta `custom.SEUDOMINIO.suaempresa.com.br`, que não existe. É o
erro mais comum neste provedor.

**Se o seu domínio usa outro DNS.** Muita empresa registra no Registro.br mas
aponta os servidores de nomes para Cloudflare, HostGator ou outro. Nesse caso, a
zona editada no Registro.br **não vale** — configure no provedor que está
respondendo. Para descobrir qual é: no painel do Registro.br, veja o campo
**Servidores DNS**.

**Propagação:** de alguns minutos a 4 horas.

---

## HostGator

1. Acesse o **cPanel** (não o "Painel do Cliente" — são coisas diferentes).
2. Em **Domínios**, abra **Zone Editor**.
3. Ao lado do seu domínio, clique em **Gerenciar**.
4. **Adicionar registro → Adicionar registro CNAME**:

   | Campo | Valor |
   |---|---|
   | Nome | `formularios.suaempresa.com.br.` |
   | TTL | `14400` |
   | CNAME | `custom.SEUDOMINIO.` |

5. **Adicionar registro → Adicionar registro TXT**:

   | Campo | Valor |
   |---|---|
   | Nome | `_verify.formularios.suaempresa.com.br.` |
   | TTL | `14400` |
   | Registro | `formularios-verificacao=<token>` |

**No cPanel o nome é completo.** Diferente do Registro.br, aqui o campo "Nome"
pede o domínio inteiro, terminado em ponto. Digitar só `formularios` cria
`formularios.suaempresa.com.br.suaempresa.com.br`.

**Cuidado com o registro que já existe.** Se já houver um A ou CNAME para
`formularios`, remova-o antes: dois registros para o mesmo nome dão resultado
imprevisível.

**Propagação:** até 4 horas (o TTL padrão é 14400 segundos).

---

## Locaweb

1. Entre no **Painel de Controle Locaweb**.
2. Vá em **Hospedagem de Sites → Domínios → Editar zona DNS**.
3. Clique em **Novo registro**:

   | Campo | Valor |
   |---|---|
   | Host | `formularios` |
   | Tipo | `CNAME` |
   | Aponta para | `custom.SEUDOMINIO` |

4. Novo registro, para a verificação:

   | Campo | Valor |
   |---|---|
   | Host | `_verify.formularios` |
   | Tipo | `TXT` |
   | Valor | `formularios-verificacao=<token>` |

5. **Salvar** e aguardar a confirmação por e-mail.

**A Locaweb aplica em lote.** As alterações não valem no instante em que você
salva: o painel enfileira e aplica em janelas. Espere o e-mail de confirmação
antes de clicar em "Verificar" na nossa tela.

**Underscore no nome.** Alguns painéis antigos da Locaweb recusam `_` no campo
Host. Se acontecer, abra um chamado pedindo a criação do TXT — eles criam pelo
suporte. É uma limitação do painel, não do DNS.

**Propagação:** de 30 minutos a 24 horas.

---

## Cloudflare

A Cloudflare é a mais simples das quatro, e a única com uma armadilha que faz o
domínio parecer configurado quando não está.

1. Entre em [dash.cloudflare.com](https://dash.cloudflare.com) e escolha o
   domínio.
2. Vá em **DNS → Records → Add record**:

   | Campo | Valor |
   |---|---|
   | Type | `CNAME` |
   | Name | `formularios` |
   | Target | `custom.SEUDOMINIO` |
   | Proxy status | **DNS only** (nuvem cinza) |
   | TTL | `Auto` |

3. Adicione o TXT:

   | Campo | Valor |
   |---|---|
   | Type | `TXT` |
   | Name | `_verify.formularios` |
   | Content | `formularios-verificacao=<token>` |

### A nuvem precisa ficar CINZA

Este é o ponto que gera mais chamado na Cloudflare.

Quando o proxy está ligado (nuvem **laranja**), a Cloudflare responde ao mundo
com os IPs dela, não com o nosso. Duas coisas quebram:

- **O certificado.** Nós emitimos o certificado do seu domínio validando que ele
  aponta para os nossos servidores. Com o proxy ligado, ele não aponta — a
  validação falha e o certificado nunca é emitido.
- **O erro que você vê.** Normalmente `525` ou `526` da própria Cloudflare, que
  não diz nada sobre a causa real.

Clique na nuvem laranja para deixá-la **cinza** (`DNS only`). Você perde o CDN e
o WAF da Cloudflare **neste subdomínio** — o resto do seu domínio continua igual.
Não é perda relevante: os formulários já são servidos com cache e TLS do nosso
lado.

Se a sua política interna exige proxy em tudo, fale com a gente: existe caminho,
mas ele envolve certificado de origem e configuração manual.

**Propagação:** 1 a 5 minutos. É a mais rápida das quatro.

---

## Domínio raiz (apex)

Se você precisa mesmo usar `suaempresa.com.br` sem subdomínio:

| Provedor | O que usar |
|---|---|
| Cloudflare | **CNAME** na raiz — a Cloudflare faz o "CNAME flattening" sozinha |
| Registro.br | Registro **A** para `SEU.IP.AQUI` |
| HostGator | Registro **A** para `SEU.IP.AQUI` |
| Locaweb | Registro **A** para `SEU.IP.AQUI` |

Onde houver **ALIAS** ou **ANAME**, prefira: eles se comportam como CNAME e
sobrevivem a uma troca de IP nossa. Com registro A, se mudarmos de IP, você
precisa atualizar — nós avisamos com antecedência, mas a alteração é sua.

---

## Conferindo por conta própria

Antes de clicar em "Verificar", dá para conferir no seu computador:

```bash
# O CNAME está apontando?
dig +short formularios.suaempresa.com.br CNAME

# O TXT de verificação está lá?
dig +short _verify.formularios.suaempresa.com.br TXT
```

No Windows, sem `dig`:

```
nslookup -type=CNAME formularios.suaempresa.com.br
nslookup -type=TXT _verify.formularios.suaempresa.com.br
```

Se os comandos não devolvem nada, a propagação ainda não terminou. Se devolvem
valores diferentes dos que a tela mostra, confira se você não editou a zona do
provedor errado — o caso do Registro.br descrito acima.

---

## Quando dá errado

| Sintoma | Causa mais provável |
|---|---|
| "Não encontramos os registros" depois de horas | Zona editada no provedor errado. Confira quem responde pelos servidores DNS do domínio. |
| CNAME aponta para `custom.SEUDOMINIO.suaempresa.com.br` | Faltou o ponto final no Registro.br, ou o nome completo no cPanel. |
| Erro `525` ou `526` no navegador | Proxy da Cloudflare ligado. Deixe a nuvem cinza. |
| Funciona sem `https`, falha com | O certificado ainda não foi emitido. Ele sai poucos minutos depois da verificação. |
| Funcionava e parou | O DNS deixou de apontar. Revalidamos toda semana e desativamos em 7 dias — é o que impede um domínio abandonado de ser sequestrado por outra pessoa. |

Se nada acima resolver, fale com o suporte com o resultado dos comandos `dig`
acima. Eles dizem em trinta segundos o que uma troca de e-mails leva um dia
para descobrir.
