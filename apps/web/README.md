# @forms/web

React 18 + TypeScript + Vite + TailwindCSS + TanStack Query + Zustand +
React Hook Form + Zod. Entra na **Fase 2**.

Três aplicações no mesmo pacote, com fronteiras que não podem se misturar:

**Site público** — página de preços (copy da seção 10 do documento de produto),
cadastro e login. Serve no domínio da aplicação.

**Painel autenticado** — builder, recebimentos, membros, cobrança. Serve
**somente** no domínio da aplicação. É o único lugar que guarda sessão.

**Renderizador de formulário** — a parte que roda nos domínios dos clientes.
Stateless: sem cookie de sessão, sem token, sem rota de painel. Recebe apenas
o schema do formulário e o branding da organização.

Essa terceira fronteira é regra de segurança, não de organização de código
(seção 8.1 e `docs/adr/0005`). A API já a impõe: rota autenticada acessada por
domínio de cliente responde 404, e há teste para isso.

Os schemas Zod de validação vêm de `@forms/shared` — os mesmos que o backend
usa. O frontend valida para dar retorno rápido; quem decide é o backend.
