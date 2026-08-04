import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  dnsInstructions,
  getPlan,
  normalizeHost,
  validateCustomDomain,
  verificationRecordName,
  type PlanCode,
  type Subject,
} from '@forms/shared';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository, customDomainsRepository } from '../db/repositories.js';
import { AppError, conflict, notFound, validationError } from '../http/errors.js';
import { assertCanAddDomain } from './usage-service.js';
import { env } from '../config/env.js';

/**
 * Domínios personalizados.
 *
 * Três barreiras, nesta ordem:
 *
 *  1. `validateCustomDomain` recusa IP, reservado, nosso próprio domínio e
 *     hospedagem compartilhada — nada disso chega a virar linha na tabela.
 *  2. Verificação de posse por TXT: só quem controla o DNS consegue publicar
 *     o token que nós geramos.
 *  3. O endpoint `ask` do Caddy, que só autoriza emissão de certificado para
 *     domínio que passou pelas duas primeiras E cuja organização está ativa.
 *
 * A terceira é a que impede que apontar DNS para o nosso IP seja suficiente
 * para conseguir um certificado no nosso nome.
 */

/** Resolver próprio, com timeout: consulta DNS travada não pode segurar um job. */
function criarResolver(): Resolver {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  return resolver;
}

export function ownDomains(): string[] {
  return [env.branding.appDomain, env.branding.cnameDomain].filter(Boolean);
}

export async function addDomain(ctx: TenantContext, subject: Subject, entrada: string) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });

  const plano = getPlan(organizacao.planCode as PlanCode);
  if (!plano.features.customDomain) {
    throw new AppError('quota_exceeded', 'Domínio próprio faz parte do plano Pro.', {
      extra: { upgradeUrl: '/planos' },
    });
  }

  await assertCanAddDomain(ctx);

  const validacao = validateCustomDomain(entrada, { ownDomains: ownDomains() });
  if (!validacao.ok) throw validationError({ domain: [validacao.message as string] });

  const token = `formularios-verificacao=${randomBytes(16).toString('hex')}`;

  try {
    const dominio = await customDomainsRepository.create(ctx, {
      domain: validacao.domain,
      type: validacao.type,
      verificationToken: token,
      status: 'pending_verification',
    });

    await auditLogsRepository.record(ctx, {
      actorUserId: subject.userId,
      action: 'custom_domain.added',
      resourceType: 'custom_domain',
      resourceId: dominio.id,
      metadataJson: { domain: dominio.domain, type: dominio.type },
    });

    return dominio;
  } catch (erro) {
    if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002') {
      // Unique global: o domínio pertence a UMA organização. A mensagem não
      // diz a qual — isso confirmaria que outro cliente nosso o usa.
      throw conflict('Esse domínio já está em uso.');
    }
    throw erro;
  }
}

export interface DnsCheckResult {
  verified: boolean;
  txtFound: boolean;
  targetOk: boolean;
  error?: string;
}

/**
 * Confere se o DNS já aponta para nós e se o token de posse está publicado.
 *
 * Os dois precisam bater. Só o CNAME provaria que alguém apontou para cá —
 * inclusive alguém que não é dono do domínio, num serviço onde subdomínios são
 * livres. Só o TXT provaria posse sem o tráfego chegar. Juntos, resolvem.
 */
export async function checkDns(domain: string, verificationToken: string): Promise<DnsCheckResult> {
  const resolver = criarResolver();
  const alvo = normalizeHost(env.branding.cnameDomain);

  let txtFound = false;
  let targetOk = false;
  let erro: string | undefined;

  try {
    const registros = await resolver.resolveTxt(`${verificationRecordName(domain)}.${domain.split('.').slice(1).join('.')}`);
    txtFound = registros.some((partes) => partes.join('').trim() === verificationToken);
  } catch {
    // Ausência de TXT não é erro de sistema: é o estado normal de quem ainda
    // não criou o registro.
    txtFound = false;
  }

  try {
    const cnames = await resolver.resolveCname(domain).catch(() => [] as string[]);
    targetOk = cnames.some((valor) => normalizeHost(valor) === alvo);

    if (!targetOk) {
      // Apex não tem CNAME: nesse caso o que vale é o A apontar para o mesmo
      // endereço que o nosso CNAME resolve.
      const [nossosIps, ipsDoCliente] = await Promise.all([
        resolver.resolve4(alvo).catch(() => [] as string[]),
        resolver.resolve4(domain).catch(() => [] as string[]),
      ]);
      targetOk = ipsDoCliente.length > 0 && ipsDoCliente.some((ip) => nossosIps.includes(ip));
    }
  } catch (problema) {
    erro = problema instanceof Error ? problema.message : 'Falha ao consultar o DNS.';
  }

  return {
    verified: txtFound && targetOk,
    txtFound,
    targetOk,
    ...(erro ? { error: erro } : {}),
  };
}

/** Roda a verificação e atualiza o estado do domínio. */
export async function verifyDomain(ctx: TenantContext, domainId: string) {
  const dominio = await customDomainsRepository.findById(ctx, domainId);
  if (!dominio) throw notFound();

  const resultado = await checkDns(dominio.domain, dominio.verificationToken);

  const atualizado = await ctx.tx.customDomain.update({
    where: { id: dominio.id, organizationId: ctx.organizationId },
    data: {
      status: resultado.verified ? 'active' : 'verifying',
      dnsLastCheckedAt: new Date(),
      dnsError: resultado.verified
        ? null
        : !resultado.txtFound
          ? 'O registro TXT de verificação ainda não foi encontrado.'
          : 'O domínio ainda não aponta para a plataforma.',
      // O certificado é emitido pelo Caddy sob demanda, na primeira visita.
      ...(resultado.verified && !dominio.certIssuedAt ? { certIssuedAt: new Date() } : {}),
    },
  });

  return { domain: atualizado, check: resultado };
}

export async function removeDomain(ctx: TenantContext, subject: Subject, domainId: string): Promise<void> {
  const dominio = await customDomainsRepository.findById(ctx, domainId);
  if (!dominio) throw notFound();

  await ctx.tx.customDomain.delete({ where: { id: dominio.id, organizationId: ctx.organizationId } });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'custom_domain.removed',
    resourceType: 'custom_domain',
    resourceId: dominio.id,
    metadataJson: { domain: dominio.domain },
  });

  // O cache precisa cair junto, senão o domínio continua servindo por até 60s
  // depois de removido.
  invalidatePublicTenantCache(dominio.domain);
}

export async function listDomains(ctx: TenantContext) {
  const dominios = await ctx.tx.customDomain.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return dominios.map((dominio) => ({
    id: dominio.id,
    domain: dominio.domain,
    type: dominio.type,
    status: dominio.status,
    isPrimary: dominio.isPrimary,
    dnsLastCheckedAt: dominio.dnsLastCheckedAt,
    dnsError: dominio.dnsError,
    certExpiresAt: dominio.certExpiresAt,
    createdAt: dominio.createdAt,
    instructions: dnsInstructions({
      domain: dominio.domain,
      verificationToken: dominio.verificationToken,
      cnameTarget: env.branding.cnameDomain,
    }),
  }));
}

// -----------------------------------------------------------------------------
// Resolução pública por Host
// -----------------------------------------------------------------------------

interface TenantPublico {
  organizationId: string;
  domainId: string;
  /** `true` quando a organização está suspensa ou cancelada. */
  paused: boolean;
}

/**
 * Cache de `Host` → tenant, com TTL de 60 segundos (seção 8.4).
 *
 * Sem ele, cada visita a um formulário público custaria uma consulta ao banco
 * antes mesmo de saber de quem é o formulário. Com ele, uma campanha que traz
 * dez mil visitas em um minuto custa uma consulta.
 *
 * Em produção com várias instâncias, isto vira Redis. O contrato é o mesmo.
 */
const cacheDeTenant = new Map<string, { valor: TenantPublico | null; expiraEm: number }>();
const TTL_MS = 60_000;

export function invalidatePublicTenantCache(domain?: string): void {
  if (domain) cacheDeTenant.delete(normalizeHost(domain));
  else cacheDeTenant.clear();
}

/**
 * Resolve o tenant a partir do `Host`.
 *
 * O contexto que sai daqui é público e somente leitura: ele serve para
 * renderizar formulário e receber submissão, nada mais. Rota autenticada
 * acessada por este caminho responde 404 antes de chegar aqui (seção 8.1).
 */
export async function resolvePublicTenant(
  hostHeader: string | undefined,
  buscar: (domain: string) => Promise<TenantPublico | null>,
): Promise<TenantPublico | null> {
  const host = normalizeHost(hostHeader);
  if (!host) return null;

  const emCache = cacheDeTenant.get(host);
  if (emCache && emCache.expiraEm > Date.now()) return emCache.valor;

  const encontrado = await buscar(host);
  // O miss também é cacheado: sem isso, um host inexistente sondado em laço
  // consultaria o banco a cada requisição.
  cacheDeTenant.set(host, { valor: encontrado, expiraEm: Date.now() + TTL_MS });

  return encontrado;
}

/**
 * Marca como `dangling` o domínio cujo DNS deixou de apontar para nós.
 *
 * Previne domain takeover: um cliente que cancela e libera o domínio não pode
 * deixar nosso certificado servindo conteúdo para quem comprar o domínio
 * depois. Sete dias de carência, e então desativa (seção 8.2).
 */
export const DIAS_ATE_DESATIVAR_DANGLING = 7;

export async function reverifyDomain(ctx: TenantContext, domainId: string, agora = new Date()) {
  const dominio = await customDomainsRepository.findById(ctx, domainId);
  if (!dominio || dominio.status === 'disabled') return null;

  const resultado = await checkDns(dominio.domain, dominio.verificationToken);

  if (resultado.targetOk) {
    return ctx.tx.customDomain.update({
      where: { id: dominio.id, organizationId: ctx.organizationId },
      data: { status: 'active', dnsLastCheckedAt: agora, dnsError: null },
    });
  }

  const jaEstavaSolto = dominio.status === 'dangling' && dominio.dnsLastCheckedAt;
  const diasSolto = jaEstavaSolto
    ? (agora.getTime() - (dominio.dnsLastCheckedAt as Date).getTime()) / (24 * 60 * 60 * 1000)
    : 0;

  const proximoStatus = diasSolto >= DIAS_ATE_DESATIVAR_DANGLING ? 'disabled' : 'dangling';

  const atualizado = await ctx.tx.customDomain.update({
    where: { id: dominio.id, organizationId: ctx.organizationId },
    data: {
      status: proximoStatus,
      // `dnsLastCheckedAt` só avança quando o estado muda: é ele que conta os
      // sete dias, e reescrevê-lo a cada verificação zeraria o relógio.
      ...(jaEstavaSolto ? {} : { dnsLastCheckedAt: agora }),
      dnsError: 'O domínio deixou de apontar para a plataforma.',
    },
  });

  invalidatePublicTenantCache(dominio.domain);
  return atualizado;
}
