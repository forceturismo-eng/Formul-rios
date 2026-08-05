import { ORG_A } from '../helpers/orgs.js';
import { limparFormulariosDeTeste } from '../helpers/limpeza.js';
import { disconnectPrisma } from '../../apps/api/src/db/prisma.js';

/**
 * Limpeza depois do e2e.
 *
 * Roda uma vez, no fim. Os formulários criados pelos testes levam o prefixo de
 * teste no título; nada mais é tocado.
 */
export default async function teardown(): Promise<void> {
  const apagados = await limparFormulariosDeTeste(ORG_A.id);
  if (apagados > 0) console.info(`[e2e] ${apagados} formulário(s) de teste removido(s).`);
  await disconnectPrisma();
}
