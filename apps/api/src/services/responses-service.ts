import { allFields, formSchema, type FormDefinition, type Subject } from '@forms/shared';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '../db/tenant.js';
import { auditLogsRepository, responsesRepository } from '../db/repositories.js';
import { decryptResponseData } from '../crypto/envelope.js';
import { notFound } from '../http/errors.js';
import { loadFormFor } from './forms-service.js';
import { mentionEmail, sendMail } from '../mail/mailer.js';

/**
 * Painel de recebimentos.
 *
 * A decisão que molda este arquivo: as respostas estão cifradas em repouso,
 * então filtrar por conteúdo não pode virar `WHERE data LIKE '%texto%'` — o
 * banco não enxerga o conteúdo, e é para ser assim.
 *
 * A saída é decifrar em memória, dentro do contexto de tenant, e filtrar ali.
 * Isso limita a busca ao que cabe numa página, e é uma troca consciente:
 * busca full-text sobre resposta cifrada exigiria um índice de termos que
 * derrotaria o propósito da criptografia. Quando o volume pedir, o caminho é
 * um índice cifrado por organização — não abrir mão da cifra.
 */

export interface ResponseFilters {
  status?: 'new' | 'reviewed' | 'archived';
  isFlagged?: boolean;
  from?: Date;
  to?: Date;
  /** Busca no conteúdo decifrado. Ver o comentário do topo. */
  search?: string;
  page: number;
  pageSize: number;
}

export interface DecryptedResponse {
  id: string;
  formId: string;
  formVersion: number;
  status: string;
  isFlagged: boolean;
  isBuffered: boolean;
  createdAt: Date;
  values: Record<string, unknown>;
  fileIds: string[];
}

function decrypt(organizationId: string, row: { dataEncrypted: Uint8Array; dataKeyEncrypted: Uint8Array }) {
  return decryptResponseData<Record<string, unknown>>(organizationId, row);
}

function matchesSearch(values: Record<string, unknown>, termo: string): boolean {
  const alvo = termo.trim().toLowerCase();
  if (!alvo) return true;

  return Object.values(values).some((valor) => {
    if (valor === null || valor === undefined) return false;
    const texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
    return texto.toLowerCase().includes(alvo);
  });
}

export interface ResponsePage {
  responses: DecryptedResponse[];
  total: number;
  page: number;
  pageSize: number;
  form: { id: string; title: string; definition: FormDefinition };
}

export async function listResponses(
  ctx: TenantContext,
  subject: Subject,
  formId: string,
  filters: ResponseFilters,
): Promise<ResponsePage> {
  const { form } = await loadFormFor(ctx, subject, formId, 'response:read');
  if (!form) throw notFound();

  const where: Prisma.ResponseWhereInput = {
    organizationId: ctx.organizationId,
    formId,
    deletedAt: null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.isFlagged !== undefined ? { isFlagged: filters.isFlagged } : {}),
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  // Sem busca textual, a paginação é feita pelo banco — que é o certo.
  if (!filters.search) {
    const [total, rows] = await Promise.all([
      ctx.tx.response.count({ where }),
      ctx.tx.response.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include: { files: { select: { id: true } } },
      }),
    ]);

    return {
      responses: rows.map((row) => toDecrypted(ctx.organizationId, row)),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      form: { id: form.id, title: form.title, definition: formSchema.parse(form.schemaJson) },
    };
  }

  // Com busca, é preciso decifrar para comparar. O teto de 5.000 linhas existe
  // para que uma busca larga não vire um OOM: acima disso, o usuário precisa
  // estreitar por data ou status antes.
  const rows = await ctx.tx.response.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 5_000,
    include: { files: { select: { id: true } } },
  });

  const filtradas = rows
    .map((row) => toDecrypted(ctx.organizationId, row))
    .filter((resposta) => matchesSearch(resposta.values, filters.search as string));

  const inicio = (filters.page - 1) * filters.pageSize;

  return {
    responses: filtradas.slice(inicio, inicio + filters.pageSize),
    total: filtradas.length,
    page: filters.page,
    pageSize: filters.pageSize,
    form: { id: form.id, title: form.title, definition: formSchema.parse(form.schemaJson) },
  };
}

function toDecrypted(
  organizationId: string,
  row: {
    id: string;
    formId: string;
    formVersion: number;
    status: string;
    isFlagged: boolean;
    isBuffered: boolean;
    createdAt: Date;
    dataEncrypted: Uint8Array;
    dataKeyEncrypted: Uint8Array;
    files?: Array<{ id: string }>;
  },
): DecryptedResponse {
  let values: Record<string, unknown>;
  try {
    values = decrypt(organizationId, row);
  } catch {
    // Uma resposta que não decifra é grave, mas não pode derrubar a listagem
    // inteira: as outras continuam legíveis e o problema fica visível na tela.
    values = { _erro: 'Não foi possível decifrar esta resposta.' };
  }

  return {
    id: row.id,
    formId: row.formId,
    formVersion: row.formVersion,
    status: row.status,
    isFlagged: row.isFlagged,
    isBuffered: row.isBuffered,
    createdAt: row.createdAt,
    values,
    fileIds: (row.files ?? []).map((f) => f.id),
  };
}

export async function getResponse(ctx: TenantContext, subject: Subject, responseId: string): Promise<DecryptedResponse> {
  const row = await ctx.tx.response.findFirst({
    where: { id: responseId, organizationId: ctx.organizationId, deletedAt: null },
    include: { files: { select: { id: true } } },
  });
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'response:read');
  return toDecrypted(ctx.organizationId, row);
}

export async function updateResponse(
  ctx: TenantContext,
  subject: Subject,
  responseId: string,
  changes: { status?: 'new' | 'reviewed' | 'archived'; isFlagged?: boolean },
) {
  const row = await responsesRepository.findById(ctx, responseId);
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'response:update');

  const atualizada = await ctx.tx.response.update({
    where: { id: responseId, organizationId: ctx.organizationId },
    data: changes,
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'response.updated',
    resourceType: 'response',
    resourceId: responseId,
    metadataJson: changes,
  });

  return atualizada;
}

/** Soft delete. A purga definitiva é o job de retenção. */
export async function deleteResponse(ctx: TenantContext, subject: Subject, responseId: string): Promise<void> {
  const row = await responsesRepository.findById(ctx, responseId);
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'response:delete');

  await ctx.tx.response.update({
    where: { id: responseId, organizationId: ctx.organizationId },
    data: { deletedAt: new Date() },
  });

  await auditLogsRepository.record(ctx, {
    actorUserId: subject.userId,
    action: 'response.deleted',
    resourceType: 'response',
    resourceId: responseId,
    metadataJson: { softDelete: true },
  });
}

export async function addComment(ctx: TenantContext, subject: Subject, responseId: string, body: string) {
  const row = await responsesRepository.findById(ctx, responseId);
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'response:read');

  // @menções: só valem para quem já é da empresa.
  //
  // A validação contra a lista de membros não é detalhe. Sem ela, escrever
  // `@qualquer@coisa.com` faria a plataforma mandar e-mail para um endereço
  // arbitrário — de graça, em nome do cliente, e com o nosso domínio como
  // remetente. É spam com a nossa reputação.
  const citados = [...body.matchAll(/@([\w.+-]+@[\w-]+\.[\w.-]+)/g)]
    .map((achado) => achado[1])
    .filter((email): email is string => Boolean(email));

  const membrosCitados =
    citados.length === 0
      ? []
      : await ctx.tx.membership.findMany({
          where: {
            organizationId: ctx.organizationId,
            acceptedAt: { not: null },
            user: { email: { in: [...new Set(citados.map((email) => email.toLowerCase()))] } },
          },
          include: { user: { select: { id: true, email: true, name: true } } },
        });

  const comentario = await ctx.tx.comment.create({
    data: {
      organizationId: ctx.organizationId,
      responseId,
      userId: subject.userId,
      body: body.trim(),
      // Guarda só quem existe. Um e-mail de fora citado no texto continua no
      // corpo do comentário, mas não vira destinatário.
      mentionsJson: membrosCitados.map((membro) => membro.user.email),
    },
  });

  await notificarMencionados(ctx, subject, {
    comentario,
    formId: row.formId,
    mencionados: membrosCitados.map((membro) => membro.user),
  });

  return comentario;
}

/**
 * Avisa quem foi mencionado.
 *
 * Fora da transação do comentário seria o ideal, mas o mailer atual é em
 * memória e a falha dele não deve derrubar o comentário — daí o `catch`. Com um
 * SMTP de verdade isto vira job de fila, como o resto.
 */
async function notificarMencionados(
  ctx: TenantContext,
  subject: Subject,
  params: {
    comentario: { id: string; responseId: string };
    formId: string;
    mencionados: Array<{ id: string; email: string; name: string }>;
  },
): Promise<void> {
  // Quem escreveu não é notificado do próprio comentário.
  const destinatarios = params.mencionados.filter((pessoa) => pessoa.id !== subject.userId);
  if (destinatarios.length === 0) return;

  const [autor, formulario, organizacao] = await Promise.all([
    ctx.tx.user.findUnique({ where: { id: subject.userId }, select: { name: true } }),
    ctx.tx.form.findFirst({ where: { id: params.formId }, select: { title: true } }),
    ctx.tx.organization.findFirst({ where: { id: ctx.organizationId }, select: { name: true } }),
  ]);

  await Promise.all(
    destinatarios.map((pessoa) =>
      sendMail(
        mentionEmail({
          to: pessoa.email,
          mentionedBy: autor?.name ?? 'Alguém',
          organizationName: organizacao?.name ?? '',
          formTitle: formulario?.title ?? 'um formulário',
          formId: params.formId,
          responseId: params.comentario.responseId,
        }),
      ).catch(() => undefined),
    ),
  );
}

export async function listComments(ctx: TenantContext, subject: Subject, responseId: string) {
  const row = await responsesRepository.findById(ctx, responseId);
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'response:read');

  return ctx.tx.comment.findMany({
    where: { organizationId: ctx.organizationId, responseId },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function assignResponse(
  ctx: TenantContext,
  subject: Subject,
  responseId: string,
  assigneeId: string,
  dueAt?: Date,
) {
  const row = await responsesRepository.findById(ctx, responseId);
  if (!row) throw notFound();

  await loadFormFor(ctx, subject, row.formId, 'assignment:manage');

  // O responsável precisa ser membro DESTA empresa. Sem esta checagem, um id
  // de usuário de outra organização entraria como responsável.
  const membro = await ctx.tx.membership.findFirst({
    where: { userId: assigneeId, organizationId: ctx.organizationId },
  });
  if (!membro) throw notFound();

  return ctx.tx.assignment.create({
    data: {
      organizationId: ctx.organizationId,
      responseId,
      assigneeId,
      status: 'open',
      ...(dueAt ? { dueAt } : {}),
    },
  });
}

/** Cabeçalhos e linhas prontos para CSV ou XLSX. */
export function toTabular(definition: FormDefinition, responses: DecryptedResponse[]) {
  const campos = allFields(definition);

  const header = ['ID da resposta', 'Recebida em', 'Status', ...campos.map((f) => f.label)];

  const rows = responses.map((resposta) => [
    resposta.id,
    resposta.createdAt.toISOString(),
    resposta.status,
    ...campos.map((campo) => {
      const valor = resposta.values[campo.id];
      if (valor === null || valor === undefined) return '';
      if (Array.isArray(valor)) return valor.join('; ');
      if (typeof valor === 'object') return JSON.stringify(valor);
      // Moeda é guardada em centavos; na exportação volta a reais.
      if (campo.type === 'currency' && typeof valor === 'number') return (valor / 100).toFixed(2);
      return String(valor);
    }),
  ]);

  return { header, rows };
}
