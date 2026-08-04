import { Worker, type Job } from 'bullmq';
import writeXlsxFile from 'write-excel-file/node';
import { withTenant } from '../db/tenant.js';
import { listResponses, toTabular } from '../services/responses-service.js';
import { auditLogsRepository } from '../db/repositories.js';
import { buildObjectKey, storage } from '../storage/provider.js';
import { QUEUE_NAMES, redisConnection, type ExportJobData } from './queues.js';
import type { Subject } from '@forms/shared';

/**
 * Worker de exportação.
 *
 * Roda fora do request porque exportar 25.000 respostas leva minutos: cada uma
 * precisa ser decifrada individualmente, e não existe atalho para isso — é o
 * preço da criptografia em repouso, e é um preço que vale.
 *
 * O arquivo gerado vai para o storage com validade de 24 horas e é entregue
 * por URL assinada. Nunca por link permanente: uma exportação é o conteúdo
 * inteiro de um formulário num arquivo só.
 */

const EXPIRACAO_HORAS = 24;

/** CSV com BOM e ponto e vírgula — é o que o Excel brasileiro abre certo. */
export function toCsv(header: string[], rows: string[][]): Buffer {
  const escapar = (valor: string): string => {
    const texto = String(valor ?? '');
    // Prefixar fórmula com apóstrofo: uma célula começando com = ou + vira
    // execução quando o arquivo é aberto no Excel (CSV injection).
    const seguro = /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
    return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };

  const linhas = [header, ...rows].map((linha) => linha.map(escapar).join(';'));
  // BOM para o Excel reconhecer UTF-8 e não estropiar os acentos.
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(linhas.join('\r\n'), 'utf8')]);
}

export async function generateExport(data: ExportJobData): Promise<{ key: string; rowCount: number }> {
  const subject: Subject = {
    userId: data.requestedBy,
    organizationId: data.organizationId,
    // A exportação foi autorizada quando o pedido entrou na fila. Aqui o papel
    // é `owner` apenas para que `listResponses` não recuse por permissão — o
    // job nunca é criado sem que `response:export` tenha sido conferido.
    role: 'owner',
  };

  return withTenant(data.organizationId, async (ctx) => {
    const pagina = await listResponses(ctx, subject, data.formId, {
      ...(data.filters.status ? { status: data.filters.status } : {}),
      ...(data.filters.isFlagged !== undefined ? { isFlagged: data.filters.isFlagged } : {}),
      ...(data.filters.from ? { from: new Date(data.filters.from) } : {}),
      ...(data.filters.to ? { to: new Date(data.filters.to) } : {}),
      ...(data.filters.search ? { search: data.filters.search } : {}),
      page: 1,
      pageSize: 50_000,
    });

    const { header, rows } = toTabular(pagina.form.definition, pagina.responses);

    let bytes: Buffer;
    let extensao: string;

    if (data.format === 'json') {
      bytes = Buffer.from(JSON.stringify(pagina.responses, null, 2), 'utf8');
      extensao = 'json';
    } else if (data.format === 'xlsx') {
      const planilha = [
        header.map((texto) => ({ value: texto, fontWeight: 'bold' as const })),
        ...rows.map((linha) => linha.map((valor) => ({ value: valor, type: String }))),
      ];
      bytes = (await writeXlsxFile(planilha, { buffer: true })) as Buffer;
      extensao = 'xlsx';
    } else {
      bytes = toCsv(header, rows);
      extensao = 'csv';
    }

    const key = `${buildObjectKey(data.organizationId, 'exportacoes')}.${extensao}`;
    await storage().put(key, bytes, mimeOf(extensao));

    await ctx.tx.export.update({
      where: { id: data.exportId, organizationId: ctx.organizationId },
      data: {
        status: 'done',
        s3Key: key,
        rowCount: rows.length,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + EXPIRACAO_HORAS * 60 * 60 * 1000),
      },
    });

    await auditLogsRepository.record(ctx, {
      actorUserId: data.requestedBy,
      action: 'response.exported',
      resourceType: 'export',
      resourceId: data.exportId,
      // O que foi exportado fica registrado: exportação é acesso em massa a
      // dado pessoal, e a LGPD pede trilha disso.
      metadataJson: { formId: data.formId, format: data.format, rowCount: rows.length },
    });

    return { key, rowCount: rows.length };
  });
}

function mimeOf(extensao: string): string {
  if (extensao === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extensao === 'json') return 'application/json';
  return 'text/csv';
}

export function startExportWorker(): Worker<ExportJobData> {
  const worker = new Worker<ExportJobData>(
    QUEUE_NAMES.export,
    async (job: Job<ExportJobData>) => generateExport(job.data),
    { connection: redisConnection(), concurrency: 2 },
  );

  worker.on('failed', async (job, error) => {
    if (!job) return;
    // A falha precisa aparecer para o usuário na tela de exportações, não só
    // no log de quem opera.
    await withTenant(job.data.organizationId, (ctx) =>
      ctx.tx.export.update({
        where: { id: job.data.exportId, organizationId: ctx.organizationId },
        data: { status: 'failed', error: error.message.slice(0, 500), completedAt: new Date() },
      }),
    ).catch(() => undefined);
  });

  return worker;
}
