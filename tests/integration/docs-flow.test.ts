import { afterAll, describe, expect, it } from 'vitest';
import { closeApp, getApp } from '../helpers/api.js';
import { API_SCOPES } from '../../apps/api/src/services/api-keys-service.js';
import { WEBHOOK_EVENTS } from '../../apps/api/src/services/webhooks-service.js';
import { ANALYSIS_TYPES } from '../../apps/api/src/ai/provider.js';
import { ERROR_CODES } from '@forms/shared';

/**
 * Documentação da API.
 *
 * O ponto destes testes não é conferir que o JSON tem as chaves certas — é
 * conferir que ele é DERIVADO do código. Documentação escrita à parte envelhece
 * em silêncio, e documentação errada é pior do que documentação ausente.
 *
 * Os casos abaixo falham quando alguém adiciona um escopo, um evento de webhook
 * ou um código de erro e a documentação não acompanha — que é exatamente quando
 * queremos saber.
 */

const HOST = 'localhost';

async function get(url: string, headers: Record<string, string> = {}) {
  const app = await getApp();
  return app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });
}

/** Desce no documento por um caminho, falhando com a chave que faltou. */
function em(raiz: unknown, ...chaves: string[]): unknown {
  let atual = raiz;

  for (const chave of chaves) {
    expect(atual, `caminho interrompido antes de "${chave}"`).toBeTruthy();
    atual = (atual as Record<string, unknown>)[chave];
  }

  return atual;
}

async function documento(): Promise<unknown> {
  return (await get('/openapi.json')).json();
}

afterAll(closeApp);

describe('/openapi.json', () => {
  it('é um documento OpenAPI 3.1 válido no essencial', async () => {
    const resposta = await get('/openapi.json');

    expect(resposta.statusCode).toBe(200);
    const doc = resposta.json() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toHaveProperty('title');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(15);
  });

  it('não exige autenticação — quem integra lê antes de ter conta', async () => {
    expect((await get('/openapi.json')).statusCode).toBe(200);
    expect((await get('/docs')).statusCode).toBe(200);
  });

  it('lista TODOS os escopos de chave que o código conhece', async () => {
    // Se um escopo novo entrar em API_SCOPES e não aparecer aqui, este caso
    // falha — que é a única forma de a documentação não ficar para trás.
    const texto = (await get('/openapi.json')).body;

    for (const escopo of API_SCOPES) {
      expect(texto, `escopo ${escopo} ausente da documentação`).toContain(escopo);
    }
  });

  it('lista todos os eventos de webhook', async () => {
    const eventos = em(
      await documento(),
      'components', 'schemas', 'Webhook', 'properties', 'events', 'items', 'enum',
    ) as string[];

    expect([...eventos].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });

  it('lista todos os tipos de análise', async () => {
    const tipos = em(
      await documento(),
      'components', 'schemas', 'Analise', 'properties', 'type', 'enum',
    ) as string[];

    expect([...tipos].sort()).toEqual([...ANALYSIS_TYPES].sort());
  });

  it('lista todos os códigos de erro', async () => {
    const codigos = em(
      await documento(),
      'components', 'schemas', 'Erro', 'properties', 'error', 'properties', 'code', 'enum',
    ) as string[];

    expect([...codigos].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('documenta os três esquemas de autenticação', async () => {
    const esquemas = em(await documento(), 'components', 'securitySchemes') as Record<string, unknown>;

    expect(Object.keys(esquemas).sort()).toEqual(['chaveDeApi', 'sessao', 'tokenDeAdmin']);
  });

  it('marca como público o que é público', async () => {
    const doc = await documento();

    // `security: []` é o que diz "não precisa de nada". Ausência do campo
    // herdaria a sessão do documento — e submissão pública com sessão seria
    // um formulário que ninguém consegue responder.
    for (const rota of ['/f/{slug}', '/f/{slug}/submit', '/v1/auth/login', '/v1/auth/register']) {
      const metodo = rota.endsWith('submit') || rota.includes('auth') ? 'post' : 'get';
      expect(em(doc, 'paths', rota, metodo, 'security'), rota).toEqual([]);
    }
  });

  it('marca a API pública como autenticada por chave', async () => {
    const doc = await documento();

    expect(em(doc, 'paths', '/api/v1/forms', 'get', 'security')).toEqual([{ chaveDeApi: [] }]);
    expect(em(doc, 'paths', '/admin/metrics', 'get', 'security')).toEqual([{ tokenDeAdmin: [] }]);
  });

  it('diz que recurso de outra empresa responde 404', async () => {
    // É a regra número um do produto. Se ela não estiver na documentação, quem
    // integra vai tratar 404 como bug.
    const texto = (await get('/openapi.json')).body;

    expect(texto).toContain('404');
    expect(texto.toLowerCase()).toContain('outra empresa');
  });
});

describe('/docs', () => {
  it('serve HTML autocontido, sem buscar nada de fora', async () => {
    const resposta = await get('/docs');

    expect(resposta.headers['content-type']).toContain('text/html');

    // Nenhum recurso externo: a nossa própria CSP bloquearia, e uma página de
    // documentação que depende de CDN quebra justamente quando mais importa.
    expect(resposta.body).not.toMatch(/src="https?:\/\//);
    expect(resposta.body).not.toMatch(/href="https?:\/\/[^"]*\.css/);
  });

  it('a CSP da página é restritiva', async () => {
    const csp = (await get('/docs')).headers['content-security-policy'] as string;

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });
});
