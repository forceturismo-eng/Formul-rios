import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, loginAs } from '../helpers/api.js';
import { ORG_A, ORG_B } from '../helpers/orgs.js';
import { withTenant } from '../../apps/api/src/db/tenant.js';
import { invalidatePublicTenantCache } from '../../apps/api/src/services/domains-service.js';

/**
 * TESTE BLOQUEANTE — o endpoint que autoriza emissão de certificado.
 *
 * Sem ele, apontar DNS para o nosso IP bastaria para conseguir um certificado
 * no nosso nome. Isso esgota o rate limit da Let's Encrypt e nos torna
 * infraestrutura de phishing — por isso ele tem teste próprio, e por isso ele
 * mora na suíte que não pode falhar.
 */

const HOST = 'localhost';
let tokenA: string;

async function comoA(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${tokenA}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

async function perguntarAoCaddy(domain: string) {
  const app = await getApp();
  return app.inject({
    method: 'GET',
    url: `/internal/domains/check?domain=${encodeURIComponent(domain)}`,
    headers: { host: HOST },
  });
}

/** Coloca um domínio no estado desejado, como o job de verificação faria. */
async function ajustarDominio(organizationId: string, domain: string, dados: Record<string, unknown>) {
  await withTenant(organizationId, ({ tx }) =>
    tx.customDomain.updateMany({ where: { organizationId, domain }, data: dados }),
  );
  invalidatePublicTenantCache(domain);
}

beforeAll(async () => {
  tokenA = (await loginAs(ORG_A.owner)).accessToken;
});

afterAll(closeApp);

describe('endpoint ask do Caddy', () => {
  it('autoriza domínio ativo de organização ativa', async () => {
    // O seed deixa `formularios.alfa.test` ativo.
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'active' });
    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { subscriptionStatus: 'active' } }),
    );

    expect((await perguntarAoCaddy(ORG_A.domain)).statusCode).toBe(200);
  });

  it('recusa domínio que não existe', async () => {
    // Este é o ataque: apontar DNS para o nosso IP e esperar o certificado.
    expect((await perguntarAoCaddy('phishing.example.com')).statusCode).toBe(404);
    expect((await perguntarAoCaddy('banco-falso.com.br')).statusCode).toBe(404);
  });

  it('recusa domínio cadastrado mas ainda não verificado', async () => {
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'pending_verification' });
    expect((await perguntarAoCaddy(ORG_A.domain)).statusCode).toBe(404);

    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'verifying' });
    expect((await perguntarAoCaddy(ORG_A.domain)).statusCode).toBe(404);
  });

  it('recusa domínio marcado como dangling', async () => {
    // Domínio que deixou de apontar para nós não renova certificado: é o que
    // previne takeover quando o cliente libera o domínio.
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'dangling' });
    expect((await perguntarAoCaddy(ORG_A.domain)).statusCode).toBe(404);
  });

  it('recusa domínio de organização suspensa', async () => {
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'active' });
    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { subscriptionStatus: 'suspended' } }),
    );

    expect((await perguntarAoCaddy(ORG_A.domain)).statusCode).toBe(404);

    await withTenant(ORG_A.id, ({ tx }) =>
      tx.organization.update({ where: { id: ORG_A.id }, data: { subscriptionStatus: 'active' } }),
    );
  });

  it('não diz a diferença entre inexistente e inativo', async () => {
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'disabled' });

    const inativo = await perguntarAoCaddy(ORG_A.domain);
    const inexistente = await perguntarAoCaddy('nunca-existiu.example.com');

    // Respostas idênticas: a diferença seria informação para quem sonda.
    expect(inativo.statusCode).toBe(inexistente.statusCode);
    expect(inativo.body).toBe(inexistente.body);

    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'active' });
  });

  it('normaliza o domínio antes de consultar', async () => {
    await ajustarDominio(ORG_A.id, ORG_A.domain, { status: 'active' });

    expect((await perguntarAoCaddy(ORG_A.domain.toUpperCase())).statusCode).toBe(200);
    expect((await perguntarAoCaddy(`${ORG_A.domain}.`)).statusCode).toBe(200);
  });

  it('entrada malformada não derruba nem autoriza', async () => {
    for (const entrada of ['', '   ', '../../etc/passwd', 'a'.repeat(300)]) {
      const resposta = await perguntarAoCaddy(entrada);
      expect([400, 404], entrada).toContain(resposta.statusCode);
    }
  });
});

describe('domínios entre empresas', () => {
  it('a Empresa A não vê os domínios da Empresa B', async () => {
    const lista = (await comoA('GET', '/v1/custom-domains')).json() as {
      domains: Array<{ domain: string }>;
    };

    expect(lista.domains.every((d) => d.domain !== ORG_B.domain)).toBe(true);
  });

  it('a Empresa A não remove o domínio da Empresa B', async () => {
    const dominioDeB = await withTenant(ORG_B.id, ({ tx }) =>
      tx.customDomain.findFirstOrThrow({ where: { organizationId: ORG_B.id } }),
    );

    expect((await comoA('DELETE', `/v1/custom-domains/${dominioDeB.id}`)).statusCode).toBe(404);

    // E o domínio continua lá.
    const aindaExiste = await withTenant(ORG_B.id, ({ tx }) =>
      tx.customDomain.count({ where: { id: dominioDeB.id } }),
    );
    expect(aindaExiste).toBe(1);
  });

  it('a Empresa A não cadastra um domínio que já é da Empresa B', async () => {
    const resposta = await comoA('POST', '/v1/custom-domains', { domain: ORG_B.domain });

    expect(resposta.statusCode).toBe(409);
    // A mensagem não diz de quem é: isso confirmaria que outro cliente nosso
    // usa aquele domínio.
    const corpo = JSON.stringify(resposta.json());
    expect(corpo).not.toContain(ORG_B.name);
    expect(corpo).not.toContain(ORG_B.id);
  });

  it('a Empresa A não cadastra um domínio da própria plataforma', async () => {
    for (const proibido of ['app.formularios.local', 'custom.formularios.local', 'qualquer.formularios.local']) {
      const resposta = await comoA('POST', '/v1/custom-domains', { domain: proibido });
      expect(resposta.statusCode, proibido).toBe(422);
    }
  });
});

describe('validação antes de cadastrar', () => {
  it('a prévia recusa o que o cadastro recusaria', async () => {
    const resposta = await comoA('POST', '/v1/custom-domains/validate', { domain: '192.168.0.1' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ ok: false });
  });

  it('a prévia devolve as instruções de DNS de um domínio válido', async () => {
    const corpo = (await comoA('POST', '/v1/custom-domains/validate', {
      domain: 'formularios.novaempresa.com.br',
    })).json() as { ok: boolean; type: string; instructions: { registros: Array<{ tipo: string }> } };

    expect(corpo.ok).toBe(true);
    expect(corpo.type).toBe('subdomain');
    expect(corpo.instructions.registros.map((r) => r.tipo).sort()).toEqual(['CNAME', 'TXT']);
  });
});
