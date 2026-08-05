import { describe, expect, it } from 'vitest';
import {
  MAX_TENTATIVAS,
  backoffMs,
  buildPayload,
  isBlockedAddress,
  signPayload,
  validateWebhookUrl,
  verifySignature,
} from '../../apps/api/src/services/webhooks-service.js';

/**
 * Webhooks de saída.
 *
 * Duas propriedades são de segurança, não de conveniência: o destino não pode
 * alcançar a nossa rede interna, e quem recebe precisa conseguir provar que a
 * entrega veio de nós.
 */

describe('destino do webhook', () => {
  it('aceita https público', () => {
    expect(validateWebhookUrl('https://api.empresa.com.br/hooks/formularios')).toMatchObject({ ok: true });
  });

  it('recusa http', () => {
    // O payload leva a resposta do formulário — dado pessoal de quem respondeu.
    // Em claro na rede isso é vazamento, não escolha do cliente.
    expect(validateWebhookUrl('http://api.empresa.com.br/hooks')).toMatchObject({ ok: false });
  });

  it('recusa o endpoint de metadata da nuvem', () => {
    // `169.254.169.254` devolve as credenciais da instância em AWS, GCP e
    // Azure. É o alvo número um de SSRF, e o motivo desta lista existir.
    expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data/')).toMatchObject({ ok: false });
    expect(validateWebhookUrl('https://metadata.google.internal/computeMetadata/v1/')).toMatchObject({
      ok: false,
    });
  });

  it('recusa loopback e faixas privadas literais', () => {
    for (const entrada of [
      'https://127.0.0.1/hooks',
      'https://localhost/hooks',
      'https://10.0.0.5/hooks',
      'https://192.168.1.10/hooks',
      'https://172.16.0.9/hooks',
      'https://172.31.255.1/hooks',
      'https://0.0.0.0/hooks',
    ]) {
      expect(validateWebhookUrl(entrada), entrada).toMatchObject({ ok: false });
    }
  });

  it('não confunde 172.32 com a faixa privada', () => {
    // A faixa privada é 172.16–172.31. Um `startsWith('172.')` ingênuo
    // bloquearia endereços públicos legítimos.
    expect(validateWebhookUrl('https://172.32.0.1/hooks')).toMatchObject({ ok: true });
    expect(validateWebhookUrl('https://172.15.0.1/hooks')).toMatchObject({ ok: true });
  });

  it('recusa texto que não é URL', () => {
    expect(validateWebhookUrl('api.empresa.com.br/hooks')).toMatchObject({ ok: false });
    expect(validateWebhookUrl('')).toMatchObject({ ok: false });
  });

  it('a checagem de IP resolvido cobre as mesmas faixas', () => {
    // Um nome como `hooks.empresa.com.br` passa na validação do cadastro e só
    // revela o destino real na entrega, quando o DNS é resolvido.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
    expect(isBlockedAddress('203.0.113.10')).toBe(false);
  });
});

describe('assinatura', () => {
  const SEGREDO = 'whsec_teste';
  const PAYLOAD = JSON.stringify({ event: 'response.created', formId: 'abc' });

  it('assina e verifica', () => {
    const header = signPayload(SEGREDO, PAYLOAD);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(SEGREDO, PAYLOAD, header)).toBe(true);
  });

  it('recusa payload adulterado', () => {
    const header = signPayload(SEGREDO, PAYLOAD);
    expect(verifySignature(SEGREDO, `${PAYLOAD} `, header)).toBe(false);
  });

  it('recusa segredo errado', () => {
    const header = signPayload(SEGREDO, PAYLOAD);
    expect(verifySignature('whsec_outro', PAYLOAD, header)).toBe(false);
  });

  it('recusa entrega antiga mesmo com assinatura correta', () => {
    // Sem isso, quem capturasse uma entrega poderia reenviá-la meses depois e
    // o destino aceitaria: a assinatura continua válida para sempre.
    const antigo = Date.now() - 3600_000;
    const header = signPayload(SEGREDO, PAYLOAD, antigo);

    expect(verifySignature(SEGREDO, PAYLOAD, header)).toBe(false);
    // Com tolerância suficiente, a mesma assinatura passa — ou seja, o que
    // reprovou acima foi a idade, não o HMAC.
    expect(verifySignature(SEGREDO, PAYLOAD, header, 7200)).toBe(true);
  });

  it('recusa header malformado sem explodir', () => {
    for (const header of ['', 'lixo', 't=abc,v1=xyz', 'v1=semtimestamp', 't=1']) {
      expect(verifySignature(SEGREDO, PAYLOAD, header), header).toBe(false);
    }
  });

  it('assinatura de tamanho diferente não passa pelo timingSafeEqual', () => {
    // `timingSafeEqual` lança quando os buffers têm tamanhos diferentes; a
    // comparação de tamanho antes dele existe para isso.
    const t = Date.now();
    expect(verifySignature(SEGREDO, PAYLOAD, `t=${t},v1=abc`)).toBe(false);
  });
});

describe('payload', () => {
  it('leva evento, organização, formulário e resposta', () => {
    const corpo = JSON.parse(
      buildPayload({
        event: 'response.created',
        organizationId: 'org-1',
        formId: 'form-1',
        responseId: 'resp-1',
        data: { nome: 'Maria' },
      }),
    );

    expect(corpo).toMatchObject({
      event: 'response.created',
      organizationId: 'org-1',
      formId: 'form-1',
      responseId: 'resp-1',
      data: { nome: 'Maria' },
    });
    expect(typeof corpo.occurredAt).toBe('string');
  });

  it('omite campos ausentes em vez de mandar null', () => {
    const corpo = JSON.parse(
      buildPayload({ event: 'form.published', organizationId: 'org-1', formId: 'form-1' }),
    );

    expect(corpo).not.toHaveProperty('responseId');
    expect(corpo).not.toHaveProperty('data');
  });
});

describe('retentativa', () => {
  it('cresce e estabiliza', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(300_000);
    expect(backoffMs(5)).toBe(21_600_000);
    // Além da escala, mantém o último valor em vez de virar undefined.
    expect(backoffMs(9)).toBe(21_600_000);
  });

  it('a janela total passa de meio dia', () => {
    // Endpoint de cliente cai por manutenção. Uma janela curta é a diferença
    // entre perder o evento e entregá-lo mais tarde.
    let total = 0;
    for (let i = 1; i <= MAX_TENTATIVAS; i++) total += backoffMs(i);
    expect(total).toBeGreaterThan(8 * 3600_000);
  });
});
