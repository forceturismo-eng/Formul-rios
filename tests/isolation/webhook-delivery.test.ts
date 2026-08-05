import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { checkDeliveryTarget, deliverWebhook } from '../../apps/api/src/queue/webhook-worker.js';

/**
 * Entrega de webhook: SSRF e isolamento.
 *
 * O destino de um webhook é escolhido pelo cliente, o que faz da entrega um
 * pedido HTTP arbitrário partindo de dentro da nossa rede. Duas barreiras
 * seguram isso, e as duas estão aqui:
 *
 *  1. o nome é RESOLVIDO antes de conectar, e um IP interno cancela a entrega;
 *  2. o job carrega `organizationId`, e o worker abre o contexto de tenant com
 *     ele — um job com o id de webhook errado não alcança a outra empresa.
 */

const URL_INTERNA = 'https://hooks.exemplo-interno.test/entrega';

/** Resolvedor de mentira: devolve o IP que o teste quiser, sem tocar no DNS. */
function resolvendoPara(endereco: string) {
  return async () => endereco;
}

let webhookDaAlfa: string;
let webhookDaBeta: string;

beforeAll(async () => {
  webhookDaAlfa = await withTenant(ORG_A.id, async ({ tx }) => {
    const criado = await tx.webhook.create({
      data: {
        organizationId: ORG_A.id,
        url: URL_INTERNA,
        secret: 'whsec_teste_entrega',
        events: ['response.created'],
        isActive: true,
      },
      select: { id: true },
    });
    return criado.id;
  });

  webhookDaBeta = await withTenant(ORG_B.id, async ({ tx }) => {
    const existente = await tx.webhook.findFirstOrThrow({ select: { id: true } });
    return existente.id;
  });
});

afterEach(async () => {
  // Cada caso começa com o webhook ativo e sem histórico de falha.
  await withTenant(ORG_A.id, ({ tx }) =>
    tx.webhook.update({
      where: { id: webhookDaAlfa },
      data: { isActive: true, failureCount: 0, lastStatus: null },
    }),
  );
});

afterAll(async () => {
  await withTenant(ORG_A.id, async ({ tx }) => {
    await tx.webhookDelivery.deleteMany({ where: { webhookId: webhookDaAlfa } });
    await tx.webhook.delete({ where: { id: webhookDaAlfa } });
  });
  await closeApp();
});

describe('checagem do destino no momento da entrega', () => {
  it('recusa nome que resolve para o metadata da nuvem', async () => {
    // Este é o ataque inteiro: `hooks.empresa.com.br` passa na validação do
    // cadastro e aponta, hoje, para 169.254.169.254. Só a resolução na hora
    // da entrega vê isso.
    const resultado = await checkDeliveryTarget(URL_INTERNA, resolvendoPara('169.254.169.254'));

    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toContain('rede interna');
  });

  it('recusa nome que resolve para loopback ou faixa privada', async () => {
    for (const endereco of ['127.0.0.1', '10.0.3.4', '192.168.0.7', '172.20.1.1', '::1', 'fd00::5']) {
      const resultado = await checkDeliveryTarget(URL_INTERNA, resolvendoPara(endereco));
      expect(resultado.ok, endereco).toBe(false);
    }
  });

  it('aceita nome que resolve para IP público', async () => {
    expect(await checkDeliveryTarget(URL_INTERNA, resolvendoPara('203.0.113.10'))).toMatchObject({ ok: true });
  });

  it('nome que não resolve não vira tentativa de conexão', async () => {
    const resultado = await checkDeliveryTarget(URL_INTERNA, async () => {
      throw new Error('ENOTFOUND');
    });

    expect(resultado.ok).toBe(false);
  });

  it('a checagem de protocolo continua valendo mesmo com IP público', async () => {
    // Um resolvedor benigno não pode servir de desvio para o http.
    const resultado = await checkDeliveryTarget('http://hooks.exemplo.test/x', resolvendoPara('203.0.113.10'));
    expect(resultado.ok).toBe(false);
  });
});

describe('entrega bloqueada', () => {
  it('desliga o webhook e registra a tentativa sem conectar', async () => {
    const resultado = await deliverWebhook(
      {
        organizationId: ORG_A.id,
        requestedBy: 'system',
        webhookId: webhookDaAlfa,
        event: 'response.created',
        payload: JSON.stringify({ event: 'response.created', data: { cpf: '390.533.447-05' } }),
        attempt: 1,
      },
      resolvendoPara('169.254.169.254'),
    );

    expect(resultado.status).toBe('bloqueado');

    const depois = await withTenant(ORG_A.id, ({ tx }) =>
      tx.webhook.findFirstOrThrow({ where: { id: webhookDaAlfa } }),
    );

    // Desligado, não só marcado: repetir a tentativa é repetir o SSRF.
    expect(depois.isActive).toBe(false);
    expect(depois.failureCount).toBe(1);
  });

  it('a tentativa registrada guarda o hash, nunca o payload', async () => {
    const payload = JSON.stringify({ event: 'response.created', data: { cpf: '390.533.447-05' } });

    await deliverWebhook(
      {
        organizationId: ORG_A.id,
        requestedBy: 'system',
        webhookId: webhookDaAlfa,
        event: 'response.created',
        payload,
        attempt: 1,
      },
      resolvendoPara('10.0.0.9'),
    );

    const tentativas = await withTenant(ORG_A.id, ({ tx }) =>
      tx.webhookDelivery.findMany({ where: { webhookId: webhookDaAlfa } }),
    );

    expect(tentativas.length).toBeGreaterThan(0);

    for (const tentativa of tentativas) {
      // O payload carrega a resposta do formulário — dado pessoal. O histórico
      // de entregas não é lugar para uma segunda cópia dele.
      expect(tentativa.payloadHash).not.toContain('390.533.447-05');
      expect(JSON.stringify(tentativa)).not.toContain('390.533.447-05');
      expect(tentativa.payloadHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('isolamento do job', () => {
  it('job com o id de webhook da outra empresa não entrega nada', async () => {
    // Um job forjado — ou um bug que trocasse o id — não pode fazer o worker
    // ler o webhook da Beta com o contexto da Alfa.
    const resultado = await deliverWebhook(
      {
        organizationId: ORG_A.id,
        requestedBy: 'system',
        webhookId: webhookDaBeta,
        event: 'response.created',
        payload: '{}',
        attempt: 1,
      },
      resolvendoPara('203.0.113.10'),
    );

    expect(resultado.status).toBe('falhou');
    expect(resultado.motivo).toBe('webhook inativo');

    // E nada foi escrito do lado da Beta.
    const daBeta = await withTenant(ORG_B.id, ({ tx }) =>
      tx.webhookDelivery.count({ where: { webhookId: webhookDaBeta } }),
    );
    expect(daBeta).toBe(0);
  });

  it('webhook desativado não é entregue', async () => {
    await withTenant(ORG_A.id, ({ tx }) =>
      tx.webhook.update({ where: { id: webhookDaAlfa }, data: { isActive: false } }),
    );

    const resultado = await deliverWebhook(
      {
        organizationId: ORG_A.id,
        requestedBy: 'system',
        webhookId: webhookDaAlfa,
        event: 'response.created',
        payload: '{}',
        attempt: 1,
      },
      resolvendoPara('203.0.113.10'),
    );

    expect(resultado.status).toBe('falhou');
  });
});
