import { defineConfig } from 'vitest/config';

/**
 * Três suítes, propósitos diferentes:
 *
 *   unit      — regras puras (RBAC, planos, dinheiro, CPF/CNPJ). Sem banco.
 *   isolation — a suíte que não pode falhar. Sobe a API de verdade contra o
 *               Postgres com RLS e tenta atravessar a fronteira entre empresas.
 *   integration — fluxos ponta a ponta de autenticação.
 *
 * `fileParallelism: false` nas suítes com banco porque elas compartilham as
 * mesmas duas organizações do seed. Rodar em paralelo tornaria falhas
 * intermitentes e, pior, verdes intermitentes.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: { NODE_ENV: 'test' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: { NODE_ENV: 'test' },
        },
      },
    ],
  },
});
