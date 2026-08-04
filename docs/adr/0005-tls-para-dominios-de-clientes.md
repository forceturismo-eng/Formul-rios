# ADR 0005 — TLS para domínios de clientes

- **Status:** aceito (implementação na Fase 4)
- **Data:** 2026-08-04

## Contexto

A partir do plano Pro, o cliente publica formulários em
`formularios.suaempresa.com.br` em vez de `<app>/f/slug`. Cada domínio desses
precisa de certificado TLS válido, emitido e renovado sem intervenção.

O risco não é técnico, é de abuso: qualquer pessoa pode apontar um domínio para
o nosso IP. Sem controle, isso força emissão de certificados em nome de
domínios que não são de clientes — o que esgota o rate limit da Let's Encrypt
(50 certificados por domínio registrado por semana) e nos torna infraestrutura
de phishing.

## Decisão

**Caddy** como reverse proxy, com On-Demand TLS e endpoint `ask`.

```
on_demand_tls {
    ask http://api:3333/internal/domains/check
    interval 2m
    burst 5
}
```

Antes de emitir qualquer certificado, o Caddy chama a API. Ela responde **200
somente** quando o domínio existe em `custom_domains`, está com status `active`
e a organização dona não está suspensa nem cancelada. Qualquer outro caso: 404,
e nenhum certificado é emitido.

`interval`/`burst` são a segunda linha: mesmo que o `ask` seja mal implementado
um dia, o estrago tem teto.

## Separação de domínios (a parte que não é sobre TLS)

Esta é a regra de segurança que o TLS apenas viabiliza:

| Domínio | Serve |
|---|---|
| **Aplicação** | Login, painel, API autenticada, cookies de sessão. Só aqui. |
| **Cliente** | Renderização pública de formulário e submissão. Stateless. |

Domínio de cliente não recebe cookie de sessão, não tem rota de painel, não
resolve tenant para nada autenticado. Rota autenticada acessada por domínio de
cliente responde **404**.

O bloqueio real está na API (`requireAppHost`), não no Caddy. O proxy é
conveniência de roteamento; a fronteira é código, e tem teste.

O `Host` resolve tenant **apenas** no renderizador público, e o contexto
resultante é marcado `public_readonly` — sem acesso a respostas, membros ou
configurações.

## Ciclo de vida de um domínio

1. Cliente adiciona → `pending_verification`
2. Instruções de DNS:
   - **Subdomínio (recomendado):** `CNAME formularios → <cname do produto>`
   - **Apex:** registro `A` para o IP do edge, ou ALIAS/ANAME se o provedor
     suportar
   - **Posse:** `TXT _verify.formularios = <token>`
3. Job verifica DNS a cada 30s por 30min, depois de hora em hora
4. Verificado → emissão via ACME (HTTP-01) → `active`
5. Renovação automática 30 dias antes do vencimento
6. **Re-verificação semanal.** Se o DNS deixou de apontar para nós, o domínio
   vira `dangling` e é desativado em 7 dias.

O passo 6 previne *domain takeover*: um cliente que cancela e libera o domínio
não pode deixar nosso certificado servindo conteúdo para quem comprar o domínio
depois.

## Validação de domínio

Normalizar antes de qualquer coisa: minúsculo, sem protocolo, sem porta, sem
path, sem ponto final, punycode.

Bloquear: IPs, `localhost`, domínios reservados, **qualquer subdomínio dos
nossos próprios domínios** e uma blacklist de domínios de terceiros conhecidos.
Um domínio pertence a uma única organização — `UNIQUE` global.

## Roteamento

`resolvePublicTenant`: `Host` → cache Redis (TTL 60s) → `custom_domains` →
`organization_id` + branding. Miss vira 404 com página neutra. Cache é
invalidado em adição, remoção e suspensão.

Organização suspensa ou cancelada mostra página informativa neutra — que,
seguindo a seção 11 do documento de produto, **não menciona plano, limite nem
pagamento**. Inadimplência é assunto entre a plataforma e o cliente, não com o
público dele.

## Alternativa documentada

**Cloudflare for SaaS.** Terceiriza emissão, renovação e o edge. Custa por
hostname, mas elimina a operação de ACME e traz proteção de DDoS junto. É a
escolha certa se o volume de domínios crescer mais rápido que o time de
infraestrutura — a troca é viável porque nada do domínio depende do Caddy além
do `ask`.
