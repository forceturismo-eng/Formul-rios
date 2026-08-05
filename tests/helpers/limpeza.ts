import { withTenant } from '../../apps/api/src/db/tenant.js';

/**
 * Limpeza dos recursos que as suítes criam.
 *
 * Existe por um motivo específico. No CI o banco nasce vazio a cada execução, e
 * uma suíte que não limpa passa para sempre. Localmente, onde o banco é o mesmo
 * de ontem, ela vai acumulando até esbarrar num limite de plano — e aí falha
 * por um motivo que não tem nada a ver com a mudança em teste.
 *
 * Foi exatamente o que aconteceu aqui: 484 formulários acumulados numa empresa
 * cujo plano permite 50, e o teste ponta a ponta falhando na criação com 402.
 * O CI nunca teria mostrado isso.
 */

/**
 * Marca que identifica um formulário criado por teste.
 *
 * Prefixo e não sufixo: `startsWith` usa índice, e a limpeza roda ao fim de
 * cada suíte. O texto é feio de propósito — ele nunca deve ser confundido com
 * um título que um cliente escreveria.
 */
export const PREFIXO_DE_TESTE = '[suite] ';

/** Título de teste, já marcado e único. */
export function tituloDeTeste(descricao: string): string {
  return `${PREFIXO_DE_TESTE}${descricao} ${Date.now()}`;
}

/**
 * Apaga os formulários marcados, e o que pende deles.
 *
 * Por prefixo, nunca "tudo": apagar tudo levaria junto os formulários do seed,
 * que outras suítes usam como ponto de partida.
 */
export async function limparFormulariosDeTeste(organizationId: string): Promise<number> {
  return withTenant(organizationId, async ({ tx }) => {
    const alvos = await tx.form.findMany({
      where: { organizationId, title: { startsWith: PREFIXO_DE_TESTE } },
      select: { id: true },
    });

    if (alvos.length === 0) return 0;

    const ids = alvos.map((alvo) => alvo.id);

    // Ordem explícita, embora o cascade do banco desse conta. Ser explícito
    // documenta o que está sendo apagado — alguém vai ler isto um dia
    // procurando o que sumiu.
    await tx.aiAnalysis.deleteMany({ where: { organizationId, formId: { in: ids } } });
    await tx.webhook.deleteMany({ where: { organizationId, formId: { in: ids } } });
    await tx.response.deleteMany({ where: { organizationId, formId: { in: ids } } });
    await tx.formVersion.deleteMany({ where: { organizationId, formId: { in: ids } } });
    await tx.form.deleteMany({ where: { organizationId, id: { in: ids } } });

    return ids.length;
  });
}
