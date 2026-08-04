import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { closeApp, get, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B, inventoryOf, type ResourceInventory } from '../helpers/orgs.js';
import { env } from '../../apps/api/src/config/env.js';

/**
 * TESTE BLOQUEANTE — o tenant vem do token assinado e de nenhum outro lugar.
 *
 * Três ataques, o mesmo desfecho esperado:
 *   1. Forjar um token do zero com o organization_id da vítima.
 *   2. Pegar um token legítimo e adulterar o payload.
 *   3. Assinar com o segredo errado (ou com "alg: none").
 */

let tokenA: string;
let inventoryB: ResourceInventory;

const encoder = new TextEncoder();

beforeAll(async () => {
  const session = await loginAs(ORG_A.owner);
  tokenA = session.accessToken;
  inventoryB = await inventoryOf(ORG_B.id);
});

afterAll(closeApp);

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('token sem payload');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Reescreve o payload mantendo header e assinatura originais. */
function tamperPayload(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('token malformado');
  const decoded = { ...decodePayload(token), ...changes };
  const encoded = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  return `${header}.${encoded}.${signature}`;
}

describe('token adulterado', () => {
  it('trocar o organization_id no payload invalida a assinatura', async () => {
    const tampered = tamperPayload(tokenA, { org: ORG_B.id });
    expect(decodePayload(tampered).org).toBe(ORG_B.id);

    const response = await get(`/v1/forms/${inventoryB.forms}`, { token: tampered });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('um viewer que se promove a owner no payload é recusado', async () => {
    const viewer = await loginAs(ORG_A.viewer);
    expect(decodePayload(viewer.accessToken).role).toBe('viewer');

    const tampered = tamperPayload(viewer.accessToken, { role: 'owner' });
    expect(decodePayload(tampered).role).toBe('owner');

    const response = await get('/v1/organizations/current', { token: tampered });
    expect(response.statusCode).toBe(401);
  });

  it('mesmo com assinatura válida, o papel vem do banco e não do token', async () => {
    // Segunda linha de defesa: se um token legítimo carregar um papel
    // desatualizado (promoção ou rebaixamento entre a emissão e o uso), quem
    // vale é a membership no banco.
    const viewer = await loginAs(ORG_A.viewer);
    const response = await get('/v1/audit-logs', { token: viewer.accessToken });

    // `audit:read` não pertence ao viewer.
    expect(response.statusCode).toBe(403);
  });

  it('estender a expiração invalida a assinatura', async () => {
    const tampered = tamperPayload(tokenA, { exp: Math.floor(Date.now() / 1000) + 86_400 * 365 });
    const response = await get('/v1/organizations/current', { token: tampered });
    expect(response.statusCode).toBe(401);
  });
});

describe('token forjado', () => {
  it('token assinado com o segredo errado é recusado', async () => {
    const forged = await new SignJWT({ org: ORG_B.id, role: 'owner', mid: ORG_B.id, ev: true })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ORG_B.id)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setJti('00000000-0000-4000-8000-000000000001')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(encoder.encode('segredo-que-o-atacante-inventou-000000'));

    const response = await get(`/v1/forms/${inventoryB.forms}`, { token: forged });
    expect(response.statusCode).toBe(401);
  });

  it('token assinado com o segredo do REFRESH não vale como access token', async () => {
    // Segredos separados existem exatamente para isto: mesmo quem obtiver um
    // deles não consegue produzir o outro tipo de token.
    const forged = await new SignJWT({ org: ORG_A.id, role: 'owner', mid: ORG_A.id, ev: true })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ORG_A.id)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setJti('00000000-0000-4000-8000-000000000002')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(encoder.encode(env.JWT_REFRESH_SECRET));

    const response = await get('/v1/organizations/current', { token: forged });
    expect(response.statusCode).toBe(401);
  });

  it('token com "alg: none" é recusado', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: ORG_B.id,
        org: ORG_B.id,
        role: 'owner',
        mid: ORG_B.id,
        ev: true,
        jti: 'x',
        iss: env.JWT_ISSUER,
        aud: env.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    const response = await get(`/v1/forms/${inventoryB.forms}`, { token: `${header}.${payload}.` });
    expect(response.statusCode).toBe(401);
  });

  it('token válido de um usuário sem membership na empresa do claim é recusado', async () => {
    // Assinatura correta, segredo correto, mas o vínculo não existe. A
    // revalidação da membership a cada request é o que fecha esta porta.
    const sessionA = await loginAs(ORG_A.owner);

    const forged = await new SignJWT({
      org: ORG_B.id,
      role: 'owner',
      mid: '00000000-0000-4000-8000-000000000003',
      ev: true,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(sessionA.userId)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setJti('00000000-0000-4000-8000-000000000004')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(encoder.encode(env.JWT_ACCESS_SECRET));

    const response = await get(`/v1/forms/${inventoryB.forms}`, { token: forged });
    expect(response.statusCode).toBe(401);
  });
});

describe('ausência de token', () => {
  it('rota autenticada sem token responde 401', async () => {
    const response = await get('/v1/organizations/current');
    expect(response.statusCode).toBe(401);
  });

  it('esquema de autorização diferente de Bearer é ignorado', async () => {
    const app = await import('../helpers/api.js');
    const response = await (await app.getApp()).inject({
      method: 'GET',
      url: '/v1/organizations/current',
      headers: { host: 'localhost', authorization: `Basic ${tokenA}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
