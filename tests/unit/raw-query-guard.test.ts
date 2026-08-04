import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Camada 4 do isolamento, na parte que uma revisão de código costuma deixar
 * passar: SQL cru espalhado.
 *
 * Uma query crua não passa pelos repositórios e pode esquecer o `where` de
 * organização. O RLS ainda protegeria, mas a regra do projeto é que a
 * aplicação também proteja — e que qualquer SQL cru esteja num lugar só, com
 * comentário explicando por que existe.
 *
 * Este teste é o que transforma essa regra em algo verificável. Sem ele, a
 * proibição é só um parágrafo no README.
 */

const API_SRC = new URL('../../apps/api/src', import.meta.url).pathname;

/** Únicos arquivos autorizados a usar SQL cru, cada um com justificativa própria. */
const ALLOWED = new Set([
  // Escreve `app.current_org_id` na transação. É a origem do contexto de tenant.
  'db/tenant.ts',
  // Chama as funções SECURITY DEFINER de bootstrap. Ver o cabeçalho do arquivo.
  'db/bootstrap.ts',
]);

const RAW_PATTERNS = [/\$queryRaw/, /\$executeRaw/, /\$queryRawUnsafe/, /\$executeRawUnsafe/];

function listTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('SQL cru fora dos módulos auditados', () => {
  const files = listTypeScriptFiles(API_SRC);

  it('encontra os arquivos da API', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((file) => relative(API_SRC, file)))('%s não usa $queryRaw/$executeRaw', (relativePath) => {
    if (ALLOWED.has(relativePath)) return;

    const source = readFileSync(join(API_SRC, relativePath), 'utf8');
    for (const pattern of RAW_PATTERNS) {
      expect(
        pattern.test(source),
        `${relativePath} usa ${pattern.source}. Mova a query para um repositório em db/repositories.ts, ` +
          'ou, se ela precisa mesmo ser crua, para db/bootstrap.ts com o porquê escrito.',
      ).toBe(false);
    }
  });

  it('os arquivos autorizados existem — a lista não pode envelhecer em silêncio', () => {
    const relativePaths = new Set(files.map((file) => relative(API_SRC, file)));
    for (const allowed of ALLOWED) {
      expect(relativePaths.has(allowed), `${allowed} está na lista de exceções mas não existe mais`).toBe(true);
    }
  });

  it('nenhum uso das variantes Unsafe em lugar nenhum, nem nos autorizados', () => {
    // `$queryRawUnsafe` aceita string concatenada: é injeção de SQL esperando
    // acontecer. Não há caso de uso que justifique isso neste projeto.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('$queryRawUnsafe'), `${relative(API_SRC, file)}`).toBe(false);
      expect(source.includes('$executeRawUnsafe'), `${relative(API_SRC, file)}`).toBe(false);
    }
  });
});
