/**
 * Dinheiro. Sempre BRL, sempre em centavos (integer).
 *
 * Nunca use float para valor monetário: 0.1 + 0.2 !== 0.3 e uma fatura errada
 * por um centavo é um problema fiscal, não um arredondamento.
 */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const BRL_NO_CENTS = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** 19900 -> "R$ 199,00" */
export function formatBRL(cents: number): string {
  return BRL.format(cents / 100);
}

/** 19900 -> "R$ 199"  |  19950 -> "R$ 199,50" (mantém centavos quando existem) */
export function formatBRLCompact(cents: number): string {
  return cents % 100 === 0 ? BRL_NO_CENTS.format(cents / 100) : BRL.format(cents / 100);
}

/**
 * Equivalente mensal de um preço anual, para o card de preços.
 * 199000 -> 19917 (R$ 199,17/mês). Arredonda para cima: nunca prometemos
 * um valor menor do que o cliente vai pagar.
 */
export function monthlyEquivalentCents(priceYearlyCents: number): number {
  return Math.ceil(priceYearlyCents / 12);
}

/** Quanto o ciclo anual economiza frente a 12 meses avulsos. */
export function yearlySavingsCents(priceMonthlyCents: number, priceYearlyCents: number): number {
  return Math.max(0, priceMonthlyCents * 12 - priceYearlyCents);
}

/**
 * Pro-rata em centavos para troca de plano no meio do ciclo.
 * Trunca em favor do cliente (arredonda para baixo o que ele deve).
 */
export function prorateCents(amountCents: number, daysRemaining: number, daysInCycle: number): number {
  if (daysInCycle <= 0) return 0;
  const clamped = Math.max(0, Math.min(daysRemaining, daysInCycle));
  return Math.floor((amountCents * clamped) / daysInCycle);
}

/** Boletos abaixo deste valor não são emitidos (seção 7.2). */
export const MIN_BOLETO_CENTS = 500;
