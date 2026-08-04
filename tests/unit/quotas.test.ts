import { describe, expect, it } from 'vitest';
import {
  BUFFER_HOURS,
  addMonths,
  checkAiQuota,
  checkCountLimit,
  checkResponseQuota,
  checkStorageQuota,
  collectWarnings,
  currentPeriod,
  downgradeBlockers,
  effectiveLimit,
  getPlan,
  projectDaysUntilLimit,
  type UsageSnapshot,
} from '@forms/shared';

/**
 * Regras de quota.
 *
 * O caso mais importante é o buffer de 48h: a promessa da seção 11 é que
 * "nenhuma resposta é apagada", e o teste que garante isso é o que verifica
 * que a submissão continua sendo ACEITA depois de estourar a cota.
 */

const PERIODO_INICIO = new Date('2026-08-01T00:00:00Z');
const PERIODO_FIM = new Date('2026-09-01T00:00:00Z');

function uso(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    responsesCount: 0,
    aiAnalysesCount: 0,
    storageUsedMb: 0,
    formsCount: 0,
    membersCount: 1,
    customDomainsCount: 0,
    apiKeysCount: 0,
    periodStart: PERIODO_INICIO,
    periodEnd: PERIODO_FIM,
    bufferStartedAt: null,
    bufferEndsAt: null,
    ...overrides,
  };
}

describe('limites de contagem', () => {
  it('libera enquanto cabe e bloqueia ao encher', () => {
    // Free permite 3 formulários.
    expect(checkCountLimit('forms', { planCode: 'free', usage: uso({ formsCount: 2 }) }).allowed).toBe(true);
    expect(checkCountLimit('forms', { planCode: 'free', usage: uso({ formsCount: 3 }) }).allowed).toBe(false);
  });

  it('devolve limite e uso atual para a tela montar a mensagem', () => {
    const resultado = checkCountLimit('forms', { planCode: 'free', usage: uso({ formsCount: 3 }) });

    expect(resultado).toMatchObject({ allowed: false, reason: 'limit_reached', limit: 3, current: 3 });
  });

  it('ilimitado nunca bloqueia', () => {
    // Business tem formulários ilimitados (-1).
    const resultado = checkCountLimit('forms', { planCode: 'business', usage: uso({ formsCount: 999_999 }) });

    expect(resultado).toMatchObject({ allowed: true, reason: 'unlimited' });
  });

  it('add-on soma ao limite do plano', () => {
    const semAddon = checkCountLimit('members', { planCode: 'free', usage: uso({ membersCount: 1 }) });
    const comAddon = checkCountLimit('members', {
      planCode: 'free',
      usage: uso({ membersCount: 1 }),
      addons: { responses: 0, aiAnalyses: 0, storageMb: 0, members: 2, customDomains: 0 },
    });

    expect(semAddon.allowed).toBe(false);
    expect(comAddon.allowed).toBe(true);
  });

  it('add-on não transforma limite finito em ilimitado, nem o contrário', () => {
    const plano = getPlan('starter');
    expect(effectiveLimit(plano, 'forms', { responses: 0, aiAnalyses: 0, storageMb: 0, members: 5, customDomains: 0 })).toBe(15);
    // Ilimitado continua ilimitado, sem virar "-1 + 5".
    expect(effectiveLimit(getPlan('business'), 'forms')).toBe(-1);
  });
});

describe('cota de respostas e o buffer de 48h', () => {
  const agora = new Date('2026-08-15T12:00:00Z');

  it('aceita normalmente abaixo do limite', () => {
    const resultado = checkResponseQuota({ planCode: 'free', usage: uso({ responsesCount: 50 }), now: agora });
    expect(resultado).toMatchObject({ allowed: true, reason: 'within_limit' });
  });

  it('ao estourar a cota, ACEITA a resposta e marca como buffered', () => {
    // A promessa da seção 11: "Continuamos recebendo tudo normalmente por mais
    // 48 horas para você não perder nada."
    const resultado = checkResponseQuota({ planCode: 'free', usage: uso({ responsesCount: 100 }), now: agora });

    expect(resultado.allowed).toBe(true);
    expect(resultado).toMatchObject({ reason: 'buffered' });
  });

  it('a cortesia dura exatamente 48 horas a partir da primeira resposta excedente', () => {
    const resultado = checkResponseQuota({ planCode: 'free', usage: uso({ responsesCount: 100 }), now: agora });

    if (resultado.allowed && resultado.reason === 'buffered') {
      const horas = (resultado.bufferEndsAt.getTime() - agora.getTime()) / (60 * 60 * 1000);
      expect(horas).toBeCloseTo(BUFFER_HOURS, 5);
    } else {
      throw new Error('esperava resultado buffered');
    }
  });

  it('continua aceitando durante a janela, mesmo com mais respostas', () => {
    const fimDoBuffer = new Date(agora.getTime() + BUFFER_HOURS * 60 * 60 * 1000);

    const resultado = checkResponseQuota({
      planCode: 'free',
      usage: uso({ responsesCount: 314, bufferStartedAt: agora, bufferEndsAt: fimDoBuffer }),
      now: new Date(agora.getTime() + 47 * 60 * 60 * 1000),
    });

    expect(resultado.allowed).toBe(true);
  });

  it('bloqueia só depois de a janela fechar', () => {
    const fimDoBuffer = new Date(agora.getTime() + BUFFER_HOURS * 60 * 60 * 1000);

    const resultado = checkResponseQuota({
      planCode: 'free',
      usage: uso({ responsesCount: 314, bufferStartedAt: agora, bufferEndsAt: fimDoBuffer }),
      now: new Date(fimDoBuffer.getTime() + 1000),
    });

    expect(resultado).toMatchObject({ allowed: false, reason: 'buffer_expired' });
  });

  it('plano ilimitado nunca entra em buffer', () => {
    const resultado = checkResponseQuota({
      planCode: 'enterprise',
      usage: uso({ responsesCount: 10_000_000 }),
      now: agora,
    });
    expect(resultado).toMatchObject({ allowed: true, reason: 'unlimited' });
  });
});

describe('armazenamento e IA bloqueiam o novo, não o existente', () => {
  it('armazenamento recusa upload que estoura o limite', () => {
    // Free: 100 MB.
    expect(
      checkStorageQuota({ planCode: 'free', usage: uso({ storageUsedMb: 95 }), additionalMb: 4 }).allowed,
    ).toBe(true);
    expect(
      checkStorageQuota({ planCode: 'free', usage: uso({ storageUsedMb: 95 }), additionalMb: 10 }).allowed,
    ).toBe(false);
  });

  it('IA bloqueia nova análise ao encher a cota', () => {
    // Starter: 50 análises.
    expect(checkAiQuota({ planCode: 'starter', usage: uso({ aiAnalysesCount: 49 }) }).allowed).toBe(true);
    expect(checkAiQuota({ planCode: 'starter', usage: uso({ aiAnalysesCount: 50 }) }).allowed).toBe(false);
  });

  it('Free não tem IA nenhuma', () => {
    expect(checkAiQuota({ planCode: 'free', usage: uso() }).allowed).toBe(false);
  });
});

describe('aviso de 80%', () => {
  it('não avisa antes dos 80%', () => {
    const avisos = collectWarnings({ planCode: 'free', usage: uso({ responsesCount: 79 }) });
    expect(avisos).toHaveLength(0);
  });

  it('avisa a partir dos 80%', () => {
    const avisos = collectWarnings({ planCode: 'free', usage: uso({ responsesCount: 80 }) });

    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ key: 'responsesPerMonth', used: 80, limit: 100 });
  });

  it('projeta quantos dias faltam no ritmo atual', () => {
    // 4.100 de 5.000 em 10 dias => 410/dia => 900 restantes => ~2 dias.
    const dias = projectDaysUntilLimit(4100, 5000, PERIODO_INICIO, new Date('2026-08-11T00:00:00Z'));
    expect(dias).toBe(2);
  });

  it('não projeta quando não há dados suficientes', () => {
    expect(projectDaysUntilLimit(0, 100, PERIODO_INICIO, new Date('2026-08-05T00:00:00Z'))).toBeNull();
    // Menos de um dia decorrido: a taxa seria ruído.
    expect(projectDaysUntilLimit(10, 100, PERIODO_INICIO, new Date('2026-08-01T06:00:00Z'))).toBeNull();
  });

  it('avisa sobre várias cotas ao mesmo tempo', () => {
    const avisos = collectWarnings({
      planCode: 'starter',
      usage: uso({ responsesCount: 900, storageUsedMb: 1900, aiAnalysesCount: 45 }),
    });

    expect(avisos.map((a) => a.key).sort()).toEqual(['aiAnalysesPerMonth', 'responsesPerMonth', 'storageMb']);
  });
});

describe('downgrade', () => {
  it('não bloqueia quando o uso cabe no plano menor', () => {
    const bloqueios = downgradeBlockers({
      targetPlanCode: 'starter',
      usage: uso({ formsCount: 10, membersCount: 2 }),
    });
    expect(bloqueios).toHaveLength(0);
  });

  it('lista tudo que precisa ser ajustado, com a ação de cada item', () => {
    // O exemplo da seção 11: 28 formulários, 6 membros, 1 domínio.
    const bloqueios = downgradeBlockers({
      targetPlanCode: 'starter',
      usage: uso({ formsCount: 28, membersCount: 6, customDomainsCount: 1 }),
    });

    expect(bloqueios).toHaveLength(3);

    const formularios = bloqueios.find((b) => b.key === 'forms');
    expect(formularios).toMatchObject({ current: 28, limit: 15, excess: 13, action: 'arquive 13' });

    const membros = bloqueios.find((b) => b.key === 'members');
    expect(membros).toMatchObject({ current: 6, limit: 3, excess: 3, action: 'remova 3' });

    const dominios = bloqueios.find((b) => b.key === 'customDomains');
    expect(dominios?.action).toBe('serão desativados');
  });

  it('add-on recorrente conta a favor no downgrade', () => {
    const bloqueios = downgradeBlockers({
      targetPlanCode: 'starter',
      usage: uso({ membersCount: 5 }),
      addons: { responses: 0, aiAnalyses: 0, storageMb: 0, members: 2, customDomains: 0 },
    });

    expect(bloqueios.find((b) => b.key === 'members')).toBeUndefined();
  });
});

describe('período do ciclo', () => {
  it('começa na data da assinatura, não no dia 1', () => {
    const { start, end } = currentPeriod(new Date('2026-01-12T10:30:00Z'), new Date('2026-08-04T00:00:00Z'));

    expect(start.toISOString()).toBe('2026-07-12T10:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-12T10:30:00.000Z');
  });

  it('assinatura no dia 31 não transborda para o mês seguinte', () => {
    // 31 de janeiro + 1 mês não pode virar 3 de março.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2024-01-31T00:00:00Z'), 1).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    // E volta ao dia 31 quando o mês comporta.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('o ciclo de quem assinou dia 31 não anda para frente ao longo do ano', () => {
    const assinatura = new Date('2026-01-31T00:00:00Z');
    const { start } = currentPeriod(assinatura, new Date('2026-04-15T00:00:00Z'));

    expect(start.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('no primeiro mês, o período é o da própria assinatura', () => {
    const assinatura = new Date('2026-08-01T09:00:00Z');
    const { start, end } = currentPeriod(assinatura, new Date('2026-08-15T00:00:00Z'));

    expect(start.toISOString()).toBe(assinatura.toISOString());
    expect(end.toISOString()).toBe('2026-09-01T09:00:00.000Z');
  });

  it('o período sempre contém o instante consultado', () => {
    const assinatura = new Date('2025-03-15T14:22:00Z');
    for (const iso of ['2025-03-15T14:22:00Z', '2025-12-31T23:59:59Z', '2026-08-04T00:00:00Z']) {
      const agora = new Date(iso);
      const { start, end } = currentPeriod(assinatura, agora);

      expect(start.getTime(), iso).toBeLessThanOrEqual(agora.getTime());
      expect(end.getTime(), iso).toBeGreaterThan(agora.getTime());
    }
  });
});
