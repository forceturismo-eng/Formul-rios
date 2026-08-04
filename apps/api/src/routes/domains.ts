import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, dnsInstructions, normalizeHost, validateCustomDomain } from '@forms/shared';
import { requireAuth, requireVerifiedEmail, subjectOf, withRequestTenant } from '../http/context.js';
import { withoutTenant } from '../db/tenant.js';
import { resolveCustomDomainOrg } from '../db/bootstrap.js';
import {
  addDomain,
  invalidatePublicTenantCache,
  listDomains,
  ownDomains,
  removeDomain,
  verifyDomain,
} from '../services/domains-service.js';
import { env } from '../config/env.js';

const uuidParam = z.object({ id: z.string().uuid() });

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/custom-domains', async (request) => {
    assertCan(subjectOf(request), 'domain:manage');
    const domains = await withRequestTenant(request, (ctx) => listDomains(ctx));
    return { domains, cnameTarget: env.branding.cnameDomain };
  });

  app.post('/custom-domains', { preHandler: requireVerifiedEmail }, async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'domain:manage');

    const { domain } = z.object({ domain: z.string().min(3).max(253) }).parse(request.body);
    const criado = await withRequestTenant(request, (ctx) => addDomain(ctx, subject, domain));

    return reply.status(201).send({
      id: criado.id,
      domain: criado.domain,
      type: criado.type,
      status: criado.status,
      instructions: dnsInstructions({
        domain: criado.domain,
        verificationToken: criado.verificationToken,
        cnameTarget: env.branding.cnameDomain,
      }),
    });
  });

  /** Confere o DNS agora. A tela chama isto quando o cliente diz "já configurei". */
  app.post('/custom-domains/:id/verify', async (request) => {
    const subject = subjectOf(request);
    assertCan(subject, 'domain:manage');

    const { id } = uuidParam.parse(request.params);
    const resultado = await withRequestTenant(request, (ctx) => verifyDomain(ctx, id));

    if (resultado.check.verified) invalidatePublicTenantCache(resultado.domain.domain);

    return {
      status: resultado.domain.status,
      verified: resultado.check.verified,
      txtFound: resultado.check.txtFound,
      targetOk: resultado.check.targetOk,
      dnsError: resultado.domain.dnsError,
    };
  });

  app.delete('/custom-domains/:id', async (request, reply) => {
    const subject = subjectOf(request);
    assertCan(subject, 'domain:manage');

    const { id } = uuidParam.parse(request.params);
    await withRequestTenant(request, (ctx) => removeDomain(ctx, subject, id));

    return reply.status(204).send();
  });

  /** Prévia da validação, para a tela avisar antes de o cliente salvar. */
  app.post('/custom-domains/validate', async (request) => {
    assertCan(subjectOf(request), 'domain:manage');

    const { domain } = z.object({ domain: z.string().max(253) }).parse(request.body);
    const resultado = validateCustomDomain(domain, { ownDomains: ownDomains() });

    return {
      ok: resultado.ok,
      domain: resultado.domain,
      type: resultado.type,
      message: resultado.message ?? null,
      instructions: resultado.ok
        ? dnsInstructions({
            domain: resultado.domain,
            verificationToken: '(gerado ao cadastrar)',
            cnameTarget: env.branding.cnameDomain,
          })
        : null,
    };
  });
}

/**
 * Endpoint `ask` do Caddy (seção 8.3).
 *
 * O Caddy chama isto ANTES de emitir certificado para um domínio que ele nunca
 * viu. Responder 200 autoriza a emissão; qualquer outra coisa a impede.
 *
 * Sem este endpoint, apontar DNS para o nosso IP bastaria para conseguir um
 * certificado no nosso nome — o que esgota o rate limit da Let's Encrypt e nos
 * torna infraestrutura de phishing.
 *
 * Autoriza somente quando:
 *   - o domínio existe em `custom_domains`;
 *   - o status dele é `active` (ou seja, o DNS e a posse já foram verificados);
 *   - a organização dona não está apagada, suspensa nem cancelada.
 */
const STATUS_QUE_NAO_AUTORIZAM = new Set(['suspended', 'canceled']);

export async function internalDomainRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/internal/domains/check',
    {
      config: {
        // O Caddy consulta uma vez por domínio novo; um pico aqui é sinal de
        // varredura, não de uso legítimo.
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const query = z.object({ domain: z.string().max(253) }).safeParse(request.query);
      if (!query.success) return reply.status(404).send();

      const domain = normalizeHost(query.data.domain);
      if (!domain) return reply.status(404).send();

      const encontrado = await withoutTenant((tx) => resolveCustomDomainOrg(tx, domain));

      if (
        !encontrado ||
        encontrado.domainStatus !== 'active' ||
        encontrado.organizationDeleted ||
        STATUS_QUE_NAO_AUTORIZAM.has(encontrado.subscriptionStatus)
      ) {
        // 404 e nada mais: a resposta não diz se o domínio existe e está
        // inativo ou se nunca existiu.
        request.log.info({ domain }, 'emissão de certificado recusada');
        return reply.status(404).send();
      }

      return reply.status(200).send();
    },
  );
}

/**
 * Resolve o formulário público quando o acesso vem por domínio de cliente.
 *
 * O `Host` resolve tenant APENAS aqui, e o contexto resultante é público e
 * somente leitura (seção 8.1). Ele não dá acesso a respostas, membros nem
 * configurações — serve para escolher de quem é o formulário e qual branding
 * aplicar.
 */
export async function publicTenantFromHost(hostHeader: string | undefined): Promise<{
  organizationId: string;
  paused: boolean;
} | null> {
  const host = normalizeHost(hostHeader);
  if (!host) return null;

  const encontrado = await withoutTenant((tx) => resolveCustomDomainOrg(tx, host));
  if (!encontrado || encontrado.organizationDeleted) return null;
  if (encontrado.domainStatus !== 'active') return null;

  return {
    organizationId: encontrado.organizationId,
    // Organização suspensa mostra página informativa neutra, sem mencionar
    // plano ou pagamento (seção 8.4 e seção 11).
    paused: STATUS_QUE_NAO_AUTORIZAM.has(encontrado.subscriptionStatus),
  };
}
