/**
 * Seed do ambiente de desenvolvimento.
 *
 * Cria o catálogo de planos e DUAS organizações completas, com o mesmo conjunto
 * de recursos em cada uma: formulário, versão, resposta, arquivo, comentário,
 * atribuição, análise de IA, membro, convite, webhook, API key, domínio e
 * fatura.
 *
 * As duas organizações não estão aqui por acaso — a suíte de isolamento
 * autentica em uma e tenta alcançar, por ID direto, cada recurso da outra.
 * Sem os dois lados povoados, os testes passariam por ausência de dado em vez
 * de por isolamento, que é o pior tipo de teste verde.
 *
 * Roda com o papel de MIGRATION (`app_migrator`). Como as tabelas usam
 * FORCE ROW LEVEL SECURITY, nem ele escapa das políticas: o seed precisa setar
 * `app.current_org_id` a cada bloco, exatamente como a aplicação faz.
 */
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';
import { PLANS } from '@forms/shared';

const prisma = new PrismaClient();

/** Mesmos parâmetros de apps/api/src/auth/hashing.ts. 2 = Argon2id. */
const ARGON_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

/** Mesma mecânica de `withTenant` da API: SET LOCAL dentro da transação. */
async function withTenant<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}::text, true)`;
      return fn(tx);
    },
    { timeout: 30_000 },
  );
}

async function seedPlans(): Promise<void> {
  for (const plan of PLANS) {
    const data = {
      name: plan.name,
      tagline: plan.tagline,
      priceMonthlyCents: plan.priceMonthlyCents,
      priceYearlyCents: plan.priceYearlyCents,
      limitsJson: plan.limits as unknown as Prisma.InputJsonValue,
      featuresJson: plan.features as unknown as Prisma.InputJsonValue,
      allowedBillingTypes: [...plan.allowedBillingTypes],
      boletoCycles: [...plan.boletoCycles],
      isPublic: plan.isPublic,
      isHighlighted: plan.isHighlighted ?? false,
      isContactSales: plan.isContactSales ?? false,
      requiresOwnerMfa: plan.requiresOwnerMfa ?? false,
      trialDays: plan.trialDays,
      sortOrder: plan.sortOrder,
    };
    await prisma.plan.upsert({ where: { code: plan.code }, create: { code: plan.code, ...data }, update: data });
  }
  console.log(`planos: ${PLANS.length}`);
}

interface OrgSpec {
  id: string;
  name: string;
  slug: string;
  planCode: string;
  primaryColor: string;
  owner: { email: string; name: string };
  editor: { email: string; name: string };
  viewer: { email: string; name: string };
  invitee: string;
  domain: string;
  formTitle: string;
  formSlug: string;
}

const PASSWORD = 'formulario-dev-2026';

const ORGS: OrgSpec[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Agência Alfa',
    slug: 'agencia-alfa',
    // Business (formulários ilimitados) de propósito: a suíte de integração
    // cria dezenas de formulários por execução, e o enforcement de quota é
    // exercitado trocando o plano dentro do próprio teste.
    planCode: 'business',
    primaryColor: '#2563eb',
    owner: { email: 'owner@alfa.test', name: 'Ana Owner' },
    editor: { email: 'editor@alfa.test', name: 'Edu Editor' },
    viewer: { email: 'viewer@alfa.test', name: 'Val Viewer' },
    invitee: 'convidado@alfa.test',
    domain: 'formularios.alfa.test',
    formTitle: 'Briefing de campanha',
    formSlug: 'briefing-campanha-alfa',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Clínica Beta',
    slug: 'clinica-beta',
    planCode: 'business',
    primaryColor: '#16a34a',
    owner: { email: 'owner@beta.test', name: 'Bruno Owner' },
    editor: { email: 'editor@beta.test', name: 'Bia Editor' },
    viewer: { email: 'viewer@beta.test', name: 'Beto Viewer' },
    invitee: 'convidado@beta.test',
    domain: 'formularios.beta.test',
    formTitle: 'Ficha de anamnese',
    formSlug: 'ficha-anamnese-beta',
  },
];

const FORM_SCHEMA = {
  pages: [
    {
      id: 'p1',
      title: 'Seus dados',
      fields: [
        { id: 'nome', type: 'short_text', label: 'Nome completo', required: true },
        { id: 'email', type: 'email', label: 'E-mail', required: true },
        { id: 'documento', type: 'cpf_cnpj', label: 'CPF ou CNPJ', required: false },
        { id: 'cep', type: 'cep', label: 'CEP', required: false },
      ],
    },
    {
      id: 'p2',
      title: 'Sobre a demanda',
      fields: [
        { id: 'mensagem', type: 'long_text', label: 'Conte o que você precisa', required: true },
        { id: 'nps', type: 'nps', label: 'De 0 a 10, qual a urgência?', required: false },
      ],
    },
  ],
};

async function seedOrganization(spec: OrgSpec): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);

  await withTenant(spec.id, async (tx) => {
    await tx.organization.upsert({
      where: { id: spec.id },
      update: {},
      create: {
        id: spec.id,
        name: spec.name,
        slug: spec.slug,
        planCode: spec.planCode,
        primaryColor: spec.primaryColor,
        subscriptionStatus: 'active',
      },
    });

    const users = await Promise.all(
      (['owner', 'editor', 'viewer'] as const).map(async (role) => {
        const person = spec[role];
        const user = await tx.user.upsert({
          where: { email: person.email },
          update: {},
          create: {
            email: person.email,
            name: person.name,
            passwordHash,
            emailVerifiedAt: new Date(),
          },
        });
        await tx.membership.upsert({
          where: { userId_organizationId: { userId: user.id, organizationId: spec.id } },
          update: {},
          create: { userId: user.id, organizationId: spec.id, role, acceptedAt: new Date() },
        });
        return { role, user };
      }),
    );

    const owner = users.find((u) => u.role === 'owner')!.user;
    const editor = users.find((u) => u.role === 'editor')!.user;

    await tx.invitation.upsert({
      where: { tokenHash: hashToken(`convite-${spec.slug}`) },
      update: {},
      create: {
        organizationId: spec.id,
        email: spec.invitee,
        role: 'editor',
        tokenHash: hashToken(`convite-${spec.slug}`),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedBy: owner.id,
      },
    });

    const form = await tx.form.upsert({
      where: { slugPublic: spec.formSlug },
      update: {},
      create: {
        organizationId: spec.id,
        createdBy: editor.id,
        title: spec.formTitle,
        description: `Formulário de exemplo da ${spec.name}.`,
        slugPublic: spec.formSlug,
        schemaJson: FORM_SCHEMA as unknown as Prisma.InputJsonValue,
        status: 'published',
        version: 1,
      },
    });

    await tx.formVersion.upsert({
      where: { formId_version: { formId: form.id, version: 1 } },
      update: {},
      create: {
        organizationId: spec.id,
        formId: form.id,
        version: 1,
        schemaJson: FORM_SCHEMA as unknown as Prisma.InputJsonValue,
        publishedBy: editor.id,
      },
    });

    const existingResponse = await tx.response.findFirst({ where: { organizationId: spec.id, formId: form.id } });
    const response =
      existingResponse ??
      (await tx.response.create({
        data: {
          organizationId: spec.id,
          formId: form.id,
          formVersion: 1,
          // O conteúdo real é cifrado com envelope encryption na Fase 2. Aqui
          // vão bytes de exemplo só para a coluna não ficar vazia.
          dataEncrypted: randomBytes(64),
          dataKeyEncrypted: randomBytes(48),
          status: 'new',
        },
      }));

    const hasFile = await tx.file.findFirst({ where: { organizationId: spec.id, responseId: response.id } });
    if (!hasFile) {
      await tx.file.create({
        data: {
          organizationId: spec.id,
          responseId: response.id,
          // Prefixo por organização: o caminho no bucket já é isolado.
          s3Key: `${spec.id}/respostas/${response.id}/anexo.pdf`,
          filename: 'anexo.pdf',
          mime: 'application/pdf',
          sizeBytes: 128_000,
          scanStatus: 'clean',
        },
      });
    }

    const hasComment = await tx.comment.findFirst({ where: { organizationId: spec.id, responseId: response.id } });
    if (!hasComment) {
      await tx.comment.create({
        data: {
          organizationId: spec.id,
          responseId: response.id,
          userId: owner.id,
          body: 'Resposta conferida, seguir com o atendimento.',
        },
      });
    }

    const hasAssignment = await tx.assignment.findFirst({ where: { organizationId: spec.id, responseId: response.id } });
    if (!hasAssignment) {
      await tx.assignment.create({
        data: { organizationId: spec.id, responseId: response.id, assigneeId: editor.id, status: 'open' },
      });
    }

    await tx.aiAnalysis.upsert({
      where: {
        organizationId_formId_type_inputHash: {
          organizationId: spec.id,
          formId: form.id,
          type: 'summary',
          inputHash: hashToken(`analise-${spec.slug}`),
        },
      },
      update: {},
      create: {
        organizationId: spec.id,
        formId: form.id,
        type: 'summary',
        inputHash: hashToken(`analise-${spec.slug}`),
        resultJson: { resumo: 'Exemplo de resumo gerado por IA.' } as Prisma.InputJsonValue,
        model: 'claude-sonnet-4-5',
        tokensUsed: 1200,
        costCents: 3,
      },
    });

    const hasWebhook = await tx.webhook.findFirst({ where: { organizationId: spec.id, formId: form.id } });
    if (!hasWebhook) {
      await tx.webhook.create({
        data: {
          organizationId: spec.id,
          formId: form.id,
          url: `https://webhook.${spec.slug}.test/respostas`,
          secret: randomBytes(24).toString('hex'),
          events: ['response.created'],
        },
      });
    }

    await tx.apiKey.upsert({
      where: { keyHash: hashToken(`apikey-${spec.slug}`) },
      update: {},
      create: {
        organizationId: spec.id,
        name: 'Integração ERP',
        keyHash: hashToken(`apikey-${spec.slug}`),
        prefix: `fx_${spec.slug.slice(0, 4)}`,
        scopes: ['responses:read'],
      },
    });

    await tx.customDomain.upsert({
      where: { domain: spec.domain },
      update: {},
      create: {
        organizationId: spec.id,
        domain: spec.domain,
        type: 'subdomain',
        verificationToken: randomUUID(),
        status: 'active',
        isPrimary: true,
      },
    });

    const subscription = await tx.subscription.findFirst({ where: { organizationId: spec.id } });
    const periodStart = new Date(Date.UTC(2026, 7, 1));
    const periodEnd = new Date(Date.UTC(2026, 8, 1));
    const created =
      subscription ??
      (await tx.subscription.create({
        data: {
          organizationId: spec.id,
          planCode: spec.planCode,
          billingType: 'boleto',
          cycle: 'monthly',
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          amountCents: spec.planCode === 'business' ? 49900 : 19900,
        },
      }));

    const hasInvoice = await tx.invoice.findFirst({ where: { organizationId: spec.id } });
    if (!hasInvoice) {
      await tx.invoice.create({
        data: {
          organizationId: spec.id,
          subscriptionId: created.id,
          amountCents: created.amountCents,
          status: 'paid',
          billingType: 'boleto',
          dueDate: periodEnd,
          paidAt: new Date(),
        },
      });
    }

    await tx.usageCounter.upsert({
      where: { organizationId_periodStart: { organizationId: spec.id, periodStart } },
      update: {},
      create: {
        organizationId: spec.id,
        periodStart,
        periodEnd,
        responsesCount: 1,
        formsCount: 1,
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: spec.id,
        actorUserId: owner.id,
        action: 'seed.created',
        resourceType: 'organization',
        resourceId: spec.id,
        metadataJson: {},
      },
    });
  });

  console.log(`organização: ${spec.name} (${spec.id})`);
}

/**
 * Admin da plataforma para desenvolvimento.
 *
 * SEM segredo TOTP: o primeiro login devolve o QR Code e obriga a configurar o
 * segundo fator. Semear um segredo conhecido derrotaria o propósito do MFA e,
 * pior, criaria o hábito de copiá-lo para produção.
 */
async function seedPlatformAdmin(): Promise<void> {
  const email = 'admin@plataforma.test';

  await prisma.platformAdmin.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: 'Admin da Plataforma',
      passwordHash: await hashPassword(PASSWORD),
    },
  });

  console.log(`admin da plataforma: ${email}`);
}

async function main(): Promise<void> {
  await seedPlans();
  for (const spec of ORGS) await seedOrganization(spec);
  await seedPlatformAdmin();

  console.log('');
  console.log('Contas de teste — senha para todas:', PASSWORD);
  for (const spec of ORGS) {
    console.log(`  ${spec.name}: ${spec.owner.email} / ${spec.editor.email} / ${spec.viewer.email}`);
  }
  console.log('  Admin da plataforma: admin@plataforma.test (o primeiro login pede para configurar o MFA)');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
