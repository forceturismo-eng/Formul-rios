import {
  effectiveBranding,
  getPlan,
  isValidAssetUrl,
  isValidBrandColor,
  sanitizeCustomCss,
  type BrandingEfetivo,
  type PlanCode,
  type Subject,
} from '@forms/shared';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository } from '../db/repositories.js';
import { AppError, validationError } from '../http/errors.js';

/**
 * White-label da organização.
 *
 * A regra que organiza este arquivo: **guardar e aplicar são decisões
 * diferentes**. O cliente do plano Business escreve CSS; se ele baixar para
 * Starter, o CSS continua no banco — para voltar inteiro se ele reassinar — mas
 * para de ser servido no mesmo instante.
 *
 * A sanitização acontece na leitura, não na gravação. Assim, endurecer a lista
 * de propriedades permitidas passa a valer para o que já está gravado, sem
 * migração de dados.
 */

export interface BrandingInput {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  ogImageUrl?: string | null;
  primaryColor?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  customCss?: string | null;
}

const CAMPOS_DE_IMAGEM = ['logoUrl', 'faviconUrl', 'ogImageUrl'] as const;

export async function loadBranding(ctx: TenantContext) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: {
      name: true,
      planCode: true,
      logoUrl: true,
      faviconUrl: true,
      ogImageUrl: true,
      primaryColor: true,
      metaTitle: true,
      metaDescription: true,
      customCss: true,
    },
  });

  const plano = getPlan(organizacao.planCode as PlanCode);
  const { css, removidos } = sanitizeCustomCss(organizacao.customCss ?? '');

  return {
    branding: {
      logoUrl: organizacao.logoUrl,
      faviconUrl: organizacao.faviconUrl,
      ogImageUrl: organizacao.ogImageUrl,
      primaryColor: organizacao.primaryColor,
      metaTitle: organizacao.metaTitle,
      metaDescription: organizacao.metaDescription,
      // O painel mostra o CSS CRU: é o que o cliente escreveu, e editar um
      // texto que a tela já filtrou seria perder o próprio trabalho a cada
      // gravação.
      customCss: organizacao.customCss,
    },
    /** O que de fato sairia na página hoje, com o plano de hoje. */
    preview: { css, removidos },
    features: { removeBranding: plano.features.removeBranding, customCss: plano.features.customCss },
  };
}

export async function updateBranding(ctx: TenantContext, subject: Subject, entrada: BrandingInput) {
  const organizacao = await ctx.tx.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: { planCode: true },
  });
  const plano = getPlan(organizacao.planCode as PlanCode);

  const erros: Record<string, string[]> = {};

  for (const campo of CAMPOS_DE_IMAGEM) {
    const valor = entrada[campo];
    if (valor != null && valor !== '' && !isValidAssetUrl(valor)) {
      erros[campo] = ['Informe um endereço https de imagem.'];
    }
  }

  if (entrada.primaryColor != null && entrada.primaryColor !== '' && !isValidBrandColor(entrada.primaryColor)) {
    erros['primaryColor'] = ['Use uma cor no formato #RRGGBB.'];
  }

  if (Object.keys(erros).length > 0) throw validationError(erros);

  // CSS customizado é do Business para cima. Recusamos a GRAVAÇÃO, e não só a
  // renderização: deixar salvar algo que nunca vai aparecer é prometer o que o
  // plano não entrega.
  if (entrada.customCss != null && entrada.customCss.trim() !== '' && !plano.features.customCss) {
    throw new AppError('quota_exceeded', 'CSS customizado faz parte do plano Business.', {
      extra: { upgradeUrl: '/planos' },
    });
  }

  const dados = {
    ...(entrada.logoUrl !== undefined ? { logoUrl: vazioComoNulo(entrada.logoUrl) } : {}),
    ...(entrada.faviconUrl !== undefined ? { faviconUrl: vazioComoNulo(entrada.faviconUrl) } : {}),
    ...(entrada.ogImageUrl !== undefined ? { ogImageUrl: vazioComoNulo(entrada.ogImageUrl) } : {}),
    ...(entrada.primaryColor !== undefined ? { primaryColor: vazioComoNulo(entrada.primaryColor) } : {}),
    ...(entrada.metaTitle !== undefined ? { metaTitle: vazioComoNulo(entrada.metaTitle) } : {}),
    ...(entrada.metaDescription !== undefined
      ? { metaDescription: vazioComoNulo(entrada.metaDescription) }
      : {}),
    ...(entrada.customCss !== undefined ? { customCss: vazioComoNulo(entrada.customCss) } : {}),
  };

  const atualizada = await ctx.tx.organization.update({
    where: { id: ctx.organizationId },
    data: dados,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'branding.updated',
    resourceType: 'organization',
    resourceId: ctx.organizationId,
    // Só os nomes dos campos: o valor do CSS não tem por que virar linha de
    // auditoria, e o log é lido por gente que não precisa dele.
    metadataJson: { fields: Object.keys(dados) },
  });

  return {
    logoUrl: atualizada.logoUrl,
    faviconUrl: atualizada.faviconUrl,
    ogImageUrl: atualizada.ogImageUrl,
    primaryColor: atualizada.primaryColor,
    metaTitle: atualizada.metaTitle,
    metaDescription: atualizada.metaDescription,
    customCss: atualizada.customCss,
  };
}

/**
 * Branding que o renderizador público aplica, já filtrado pelo plano.
 *
 * Recebe a organização já lida para não abrir uma segunda consulta no caminho
 * mais quente do produto — a página do formulário.
 */
export function publicBrandingOf(organizacao: {
  name: string;
  planCode: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  primaryColor: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  customCss: string | null;
}): BrandingEfetivo {
  const plano = getPlan(organizacao.planCode as PlanCode);

  return effectiveBranding(
    {
      name: organizacao.name,
      logoUrl: organizacao.logoUrl,
      faviconUrl: organizacao.faviconUrl,
      ogImageUrl: organizacao.ogImageUrl,
      primaryColor: organizacao.primaryColor,
      metaTitle: organizacao.metaTitle,
      metaDescription: organizacao.metaDescription,
      customCss: organizacao.customCss,
    },
    { removeBranding: plano.features.removeBranding, customCss: plano.features.customCss },
  );
}

function vazioComoNulo(valor: string | null): string | null {
  if (valor === null) return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}
