import { describe, expect, it } from 'vitest';
import {
  ADDONS,
  PLANS,
  UNLIMITED,
  formatBRL,
  formatBRLCompact,
  getPlan,
  isUnlimited,
  monthlyEquivalentCents,
  planSupportsBoleto,
  prorateCents,
  remainingQuota,
  withinLimit,
  yearlySavingsCents,
} from '@forms/shared';

/** Catálogo de planos e aritmética de dinheiro — seções 6 e 7.4. */

describe('catálogo', () => {
  it('tem os cinco planos, em ordem', () => {
    expect(PLANS.map((p) => p.code)).toEqual(['free', 'starter', 'pro', 'business', 'enterprise']);
    expect(PLANS.map((p) => p.sortOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('o anual é dez vezes o mensal — dois meses grátis', () => {
    for (const plan of PLANS) {
      if (plan.priceMonthlyCents === null || plan.priceYearlyCents === null) continue;
      expect(plan.priceYearlyCents, plan.code).toBe(plan.priceMonthlyCents * 10);
    }
  });

  it('todo preço é inteiro em centavos', () => {
    for (const plan of PLANS) {
      for (const price of [plan.priceMonthlyCents, plan.priceYearlyCents]) {
        if (price === null) continue;
        expect(Number.isInteger(price), plan.code).toBe(true);
      }
    }
    for (const addon of ADDONS) {
      expect(Number.isInteger(addon.priceCents), addon.code).toBe(true);
    }
  });

  it('só o Enterprise é sob consulta', () => {
    const semPreco = PLANS.filter((p) => p.priceMonthlyCents === null);
    expect(semPreco.map((p) => p.code)).toEqual(['enterprise']);
    expect(getPlan('enterprise').isContactSales).toBe(true);
  });

  it('cada plano tem tudo do anterior, ou mais', () => {
    const escada = ['free', 'starter', 'pro', 'business'] as const;
    for (let i = 1; i < escada.length; i++) {
      const anterior = getPlan(escada[i - 1]!);
      const atual = getPlan(escada[i]!);

      for (const [chave, limiteAnterior] of Object.entries(anterior.limits)) {
        const limiteAtual = atual.limits[chave as keyof typeof atual.limits];
        if (isUnlimited(limiteAtual)) continue;
        expect(isUnlimited(limiteAnterior), `${atual.code}.${chave} regrediu para limitado`).toBe(false);
        expect(limiteAtual, `${atual.code}.${chave}`).toBeGreaterThanOrEqual(limiteAnterior);
      }
    }
  });

  it('Free não tem trial, nem forma de pagamento', () => {
    const free = getPlan('free');
    expect(free.trialDays).toBe(0);
    expect(free.allowedBillingTypes).toHaveLength(0);
    expect(free.priceMonthlyCents).toBe(0);
  });

  it('boleto segue o que a página de preços promete', () => {
    // "Boleto está disponível no plano anual do Starter, no semestral e anual
    // do Pro, e também no mensal no Business." (FAQ da seção 10)
    expect(planSupportsBoleto(getPlan('starter'), 'annual')).toBe(true);
    expect(planSupportsBoleto(getPlan('starter'), 'monthly')).toBe(false);
    expect(planSupportsBoleto(getPlan('starter'), 'semiannual')).toBe(false);

    expect(planSupportsBoleto(getPlan('pro'), 'semiannual')).toBe(true);
    expect(planSupportsBoleto(getPlan('pro'), 'annual')).toBe(true);
    expect(planSupportsBoleto(getPlan('pro'), 'monthly')).toBe(false);

    expect(planSupportsBoleto(getPlan('business'), 'monthly')).toBe(true);
  });

  it('cartão e Pix funcionam em todos os planos pagos', () => {
    for (const plan of PLANS) {
      if (plan.code === 'free') continue;
      expect(plan.allowedBillingTypes, plan.code).toContain('credit_card');
      expect(plan.allowedBillingTypes, plan.code).toContain('pix');
    }
  });

  it('domínio próprio começa no Pro', () => {
    expect(getPlan('free').features.customDomain).toBe(false);
    expect(getPlan('starter').features.customDomain).toBe(false);
    expect(getPlan('pro').features.customDomain).toBe(true);
    expect(getPlan('pro').limits.customDomains).toBe(1);
  });

  it('remover a marca começa no Pro', () => {
    expect(getPlan('starter').features.removeBranding).toBe(false);
    expect(getPlan('pro').features.removeBranding).toBe(true);
  });

  it('Business e Enterprise exigem MFA no owner', () => {
    expect(getPlan('business').requiresOwnerMfa).toBe(true);
    expect(getPlan('enterprise').requiresOwnerMfa).toBe(true);
    expect(getPlan('pro').requiresOwnerMfa).toBeUndefined();
  });

  it('getPlan explode com código desconhecido', () => {
    expect(() => getPlan('gold' as never)).toThrow(/Plano desconhecido/);
  });
});

describe('limites e o caso do -1', () => {
  it('-1 é ilimitado e nunca é comparado como número', () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(withinLimit(UNLIMITED, 1_000_000)).toBe(true);
    expect(remainingQuota(UNLIMITED, 1_000_000)).toBeNull();
  });

  it('limite finito bloqueia ao encher', () => {
    expect(withinLimit(3, 2)).toBe(true);
    expect(withinLimit(3, 3)).toBe(false);
    expect(withinLimit(3, 1, 2)).toBe(true);
    expect(withinLimit(3, 1, 3)).toBe(false);
  });

  it('cota restante nunca é negativa', () => {
    expect(remainingQuota(100, 40)).toBe(60);
    expect(remainingQuota(100, 140)).toBe(0);
  });
});

describe('dinheiro', () => {
  it('formata em BRL', () => {
    // O `Intl` separa "R$" do valor com espaço não-quebrável (U+00A0), não com
    // espaço comum. Normalizar aqui deixa a asserção legível sem esconder isso.
    const normalizar = (valor: string): string => valor.replace(/\u00a0/g, ' ');

    expect(normalizar(formatBRL(19900))).toBe('R$ 199,00');
    expect(normalizar(formatBRL(0))).toBe('R$ 0,00');
    expect(normalizar(formatBRLCompact(19900))).toBe('R$ 199');
    expect(normalizar(formatBRLCompact(19950))).toBe('R$ 199,50');
  });

  it('equivalente mensal do anual arredonda para cima', () => {
    // Nunca prometer um valor menor do que o cliente vai pagar.
    expect(monthlyEquivalentCents(199000)).toBe(16584);
    expect(monthlyEquivalentCents(79000)).toBe(6584);
  });

  it('economia do anual bate com a copy do Pro', () => {
    const pro = getPlan('pro');
    // "você economiza R$ 398" — dois meses de R$ 199.
    expect(yearlySavingsCents(pro.priceMonthlyCents!, pro.priceYearlyCents!)).toBe(39800);
  });

  it('pro-rata trunca em favor do cliente', () => {
    expect(prorateCents(19900, 15, 30)).toBe(9950);
    expect(prorateCents(19900, 10, 31)).toBe(6419);
    expect(prorateCents(19900, 0, 30)).toBe(0);
    expect(prorateCents(19900, 40, 30)).toBe(19900);
    expect(prorateCents(19900, 5, 0)).toBe(0);
  });
});

describe('add-ons', () => {
  it('os seis pacotes existem, com preço inteiro', () => {
    expect(ADDONS.map((a) => a.code)).toEqual([
      'responses_1k',
      'responses_5k',
      'storage_10gb',
      'ai_500',
      'member_extra',
      'domain_extra',
    ]);
  });

  it('membro e domínio extra são recorrentes; pacotes de consumo, não', () => {
    expect(ADDONS.find((a) => a.code === 'member_extra')?.recurring).toBe(true);
    expect(ADDONS.find((a) => a.code === 'domain_extra')?.recurring).toBe(true);
    expect(ADDONS.find((a) => a.code === 'responses_5k')?.recurring).toBeUndefined();
  });
});
