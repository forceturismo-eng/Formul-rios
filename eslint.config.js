import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Regras de lint.
 *
 * As que importam de verdade aqui não são de estilo: são as que impedem SQL
 * cru fora dos módulos auditados e `any` silencioso. Estilo é resolvido lendo
 * o código ao redor.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'apps/web/dist/**', 'prisma/migrations/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },

  {
    // Camada 4 do isolamento, como regra de lint.
    //
    // SQL cru não passa pelos repositórios e pode esquecer o filtro de
    // organização. Só dois arquivos podem usá-lo, cada um com o porquê escrito
    // no cabeçalho. O teste em tests/unit/raw-query-guard.test.ts cobre o
    // mesmo terreno — lint dá o retorno imediato, o teste barra o merge.
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['apps/api/src/db/tenant.ts', 'apps/api/src/db/bootstrap.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name=/^\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)$/]",
          message:
            'SQL cru só é permitido em db/tenant.ts e db/bootstrap.ts. Use um repositório em db/repositories.ts.',
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts', 'prisma/seed.ts', 'scripts/**/*.mjs'],
    rules: {
      // Testes precisam de SQL cru para inspecionar o catálogo do Postgres, e
      // o seed replica a mecânica de contexto de tenant de propósito.
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
