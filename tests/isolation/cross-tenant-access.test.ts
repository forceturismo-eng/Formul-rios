import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, get, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B, inventoryOf, type ResourceInventory } from '../helpers/orgs.js';
import { RESOURCE_PATHS } from '../../apps/api/src/routes/resources.js';

/**
 * TESTE BLOQUEANTE — a Fase 1 não avança se algum caso aqui falhar.
 *
 * Autentica como owner da empresa A e pede, por ID direto, CADA recurso da
 * empresa B. Todos precisam responder 404.
 *
 * 404 e não 403, sempre: um 403 confirmaria que o recurso existe. Com isso um
 * concorrente mapearia quantos formulários, respostas e domínios a outra
 * empresa tem, sem ler o conteúdo de nenhum — e "só metadado" também é
 * vazamento.
 */

let inventoryA: ResourceInventory;
let inventoryB: ResourceInventory;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  [inventoryA, inventoryB] = await Promise.all([inventoryOf(ORG_A.id), inventoryOf(ORG_B.id)]);
  tokenA = (await loginAs(ORG_A.owner)).accessToken;
  tokenB = (await loginAs(ORG_B.owner)).accessToken;
});

afterAll(closeApp);

describe('cobertura da suíte', () => {
  it('cobre todos os recursos expostos pela API', () => {
    // Se alguém adicionar um recurso em routes/resources.ts sem povoá-lo no
    // seed e listá-lo no inventário, este teste falha antes que o recurso novo
    // entre em produção sem prova de isolamento.
    expect([...RESOURCE_PATHS].sort()).toEqual(Object.keys(inventoryA).sort());
  });
});

describe('empresa A tentando alcançar recursos da empresa B', () => {
  it('a suíte tem inventário completo das duas empresas', () => {
    expect(Object.keys(inventoryA).length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(inventoryB).length).toBe(Object.keys(inventoryA).length);
    // Os IDs precisam ser realmente diferentes, senão o teste não testa nada.
    for (const key of Object.keys(inventoryA) as Array<keyof ResourceInventory>) {
      expect(inventoryA[key]).not.toBe(inventoryB[key]);
    }
  });

  it.each(RESOURCE_PATHS)('GET /v1/%s/:id da empresa B responde 404 para a empresa A', async (path) => {
    const idFromB = inventoryB[path as keyof ResourceInventory];
    const response = await get(`/v1/${path}/${idFromB}`, { token: tokenA });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    // A resposta não pode conter o ID pedido: nem em mensagem de erro.
    expect(response.body).not.toContain(idFromB);
  });

  it.each(RESOURCE_PATHS)('GET /v1/%s/:id da empresa A responde 404 para a empresa B', async (path) => {
    const idFromA = inventoryA[path as keyof ResourceInventory];
    const response = await get(`/v1/${path}/${idFromA}`, { token: tokenB });

    expect(response.statusCode).toBe(404);
  });

  it.each(RESOURCE_PATHS)('GET /v1/%s/:id da própria empresa responde 200', async (path) => {
    const ownId = inventoryA[path as keyof ResourceInventory];
    const response = await get(`/v1/${path}/${ownId}`, { token: tokenA });

    // Sem este contrapeso, um bug que respondesse 404 para tudo faria a suíte
    // inteira passar sem isolamento nenhum.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ownId });
  });
});

describe('listagens não atravessam a fronteira', () => {
  it('GET /v1/members lista apenas membros da própria empresa', async () => {
    const response = await get('/v1/members', { token: tokenA });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { members: Array<{ user: { email: string } }> };
    expect(body.members.length).toBeGreaterThan(0);
    for (const member of body.members) {
      expect(member.user.email).toMatch(/@alfa\.test$/);
    }
  });

  it('GET /v1/organizations/current devolve a empresa do token, não a do pedido', async () => {
    const response = await get('/v1/organizations/current', { token: tokenA });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ORG_A.id, name: ORG_A.name });
  });

  it('GET /v1/audit-logs não mostra eventos da outra empresa', async () => {
    const response = await get('/v1/audit-logs', { token: tokenA });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { logs: Array<{ organizationId: string }> };
    for (const log of body.logs) {
      expect(log.organizationId).toBe(ORG_A.id);
    }
  });
});

describe('enumeração de IDs', () => {
  it('todo ID de recurso é UUID v4, nunca sequencial', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const inventory of [inventoryA, inventoryB]) {
      for (const [resource, id] of Object.entries(inventory)) {
        expect(id, `${resource} não é UUID v4`).toMatch(uuidV4);
      }
    }
  });

  it('ID inexistente e ID malformado respondem igual', async () => {
    // Distinguir os dois daria ao atacante o sinal de que o formato certo
    // levaria a algum lugar.
    const inexistente = await get('/v1/forms/00000000-0000-4000-8000-000000000000', { token: tokenA });
    const malformado = await get('/v1/forms/1', { token: tokenA });

    expect(inexistente.statusCode).toBe(404);
    expect(malformado.statusCode).toBe(404);
    expect(malformado.json()).toEqual(inexistente.json());
  });
});
