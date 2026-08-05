import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBRL, type CopyBlock } from '@forms/shared';
import { ApiError, api } from '../lib/api.js';
import { LayoutPainel, TituloDaPagina } from '../components/layout.js';
import { Banner, MensagemDeErro, Selo, Spinner } from '../components/ui.js';
import { usePermission } from '../lib/session.js';

/**
 * Painel de cobrança.
 *
 * Só o `owner` chega aqui — `admin` administra a equipe, não o dinheiro
 * (seção 4). A tela esconde o menu, e o backend responde 403 de qualquer forma:
 * esconder é cortesia, quem decide é a API.
 */

interface VisaoDeCobranca {
  subscription: {
    planCode: string;
    status: string;
    billingType: string;
    cycle: string;
    amountFormatted: string;
    currentPeriodEnd: string;
    nextDueDate: string | null;
  } | null;
  billingProfile: { document: string; legalName: string; emailBilling: string } | null;
  invoices: Array<{
    id: string;
    amountCents: number;
    amountFormatted: string;
    status: string;
    billingType: string;
    dueDate: string;
    paidAt: string | null;
    boletoUrl: string | null;
    nfseUrl: string | null;
  }>;
}

const dataCurta = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function PaginaCobranca() {
  const { is } = usePermission();
  const cliente = useQueryClient();
  const [pix, setPix] = useState<{ qrCode: string; copyPaste: string } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['cobranca'],
    queryFn: () => api<VisaoDeCobranca>('/v1/billing'),
    enabled: is('owner'),
  });

  const { data: banners } = useQuery({
    queryKey: ['banners-cobranca'],
    queryFn: () => api<{ banners: CopyBlock[] }>('/v1/billing/banners'),
    enabled: is('owner'),
  });

  const gerarPix = useMutation({
    mutationFn: (invoiceId: string) =>
      api<{ qrCode: string; copyPaste: string }>(`/v1/billing/invoices/${invoiceId}/pix`, { method: 'POST' }),
    onSuccess: setPix,
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos gerar o Pix agora.'),
  });

  const segundaVia = useMutation({
    mutationFn: (invoiceId: string) =>
      api<{ boletoUrl: string }>(`/v1/billing/invoices/${invoiceId}/reissue-boleto`, { method: 'POST' }),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['cobranca'] }),
    onError: (problema: unknown) =>
      setErro(problema instanceof ApiError ? problema.message : 'Não conseguimos emitir a segunda via agora.'),
  });

  if (!is('owner')) {
    return (
      <LayoutPainel>
        <TituloDaPagina titulo="Cobrança" />
        <div className="cartao text-sm text-slate-600">
          Só quem é dono da conta acessa a cobrança. Peça a essa pessoa se você precisa de uma nota fiscal ou do
          histórico de pagamentos.
        </div>
      </LayoutPainel>
    );
  }

  return (
    <LayoutPainel>
      <TituloDaPagina titulo="Cobrança" descricao="Assinatura, faturas e dados fiscais." />

      {erro && (
        <div className="mb-6">
          <MensagemDeErro>{erro}</MensagemDeErro>
        </div>
      )}

      {banners?.banners.map((bloco, i) => (
        <div key={i} className="mb-4">
          <Banner bloco={bloco} />
        </div>
      ))}

      {isLoading && <Spinner label="Carregando cobrança" />}

      {data && (
        <div className="space-y-6">
          <div className="cartao">
            <h2 className="font-medium text-slate-900">Assinatura</h2>

            {data.subscription ? (
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-slate-500">Plano</dt>
                  <dd className="mt-0.5 font-medium capitalize text-slate-900">{data.subscription.planCode}</dd>
                </div>
                <div>
                  <dt className="text-sm text-slate-500">Situação</dt>
                  <dd className="mt-0.5">
                    <Selo estado={data.subscription.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-slate-500">Valor</dt>
                  <dd className="mt-0.5 font-medium text-slate-900">{data.subscription.amountFormatted}</dd>
                </div>
                <div>
                  <dt className="text-sm text-slate-500">Próximo vencimento</dt>
                  <dd className="mt-0.5 text-slate-900">
                    {data.subscription.nextDueDate
                      ? dataCurta.format(new Date(data.subscription.nextDueDate))
                      : '—'}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                Sua conta está no período de teste. Escolha um plano quando quiser continuar.
              </p>
            )}
          </div>

          {data.billingProfile && (
            <div className="cartao">
              <h2 className="font-medium text-slate-900">Dados fiscais</h2>
              <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-sm text-slate-500">Razão social</dt>
                  <dd className="mt-0.5 text-slate-900">{data.billingProfile.legalName}</dd>
                </div>
                <div>
                  <dt className="text-sm text-slate-500">Documento</dt>
                  <dd className="mt-0.5 text-slate-900">{data.billingProfile.document}</dd>
                </div>
                <div>
                  <dt className="text-sm text-slate-500">E-mail de cobrança</dt>
                  <dd className="mt-0.5 text-slate-900">{data.billingProfile.emailBilling}</dd>
                </div>
              </dl>
            </div>
          )}

          {pix && (
            <div className="cartao">
              <h2 className="font-medium text-slate-900">Pagar por Pix</h2>
              <div className="mt-4 flex flex-wrap items-start gap-6">
                <img
                  src={`data:image/png;base64,${pix.qrCode}`}
                  alt="QR Code do Pix"
                  className="h-40 w-40 rounded-lg border border-slate-200"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-500">Pix copia e cola</p>
                  <p className="mt-1 break-all rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                    {pix.copyPaste}
                  </p>
                  <button
                    type="button"
                    className="botao-secundario mt-3"
                    onClick={() => {
                      void navigator.clipboard.writeText(pix.copyPaste);
                      setCopiado(true);
                      window.setTimeout(() => setCopiado(false), 2000);
                    }}
                  >
                    {copiado ? 'Copiado' : 'Copiar código Pix'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="cartao">
            <h2 className="mb-4 font-medium text-slate-900">Faturas</h2>

            {data.invoices.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhuma fatura ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-sm">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 font-medium">Vencimento</th>
                      <th className="py-2 font-medium">Valor</th>
                      <th className="py-2 font-medium">Situação</th>
                      <th className="py-2 font-medium">Nota fiscal</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.invoices.map((fatura) => (
                      <tr key={fatura.id}>
                        <td className="py-3 text-slate-700">{dataCurta.format(new Date(fatura.dueDate))}</td>
                        <td className="py-3 font-medium text-slate-900">
                          {fatura.amountFormatted || formatBRL(fatura.amountCents)}
                        </td>
                        <td className="py-3">
                          <Selo estado={fatura.status} />
                        </td>
                        <td className="py-3">
                          {fatura.nfseUrl ? (
                            <a
                              href={fatura.nfseUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-600 hover:text-slate-900 hover:underline"
                            >
                              Baixar NFS-e
                            </a>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          {fatura.status !== 'paid' && (
                            <div className="flex justify-end gap-2">
                              {fatura.boletoUrl && (
                                <a
                                  href={fatura.boletoUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sm text-slate-600 hover:text-slate-900"
                                >
                                  Baixar boleto
                                </a>
                              )}
                              {fatura.billingType === 'boleto' && (
                                <button
                                  type="button"
                                  className="text-sm text-slate-600 hover:text-slate-900"
                                  onClick={() => segundaVia.mutate(fatura.id)}
                                >
                                  Emitir segunda via
                                </button>
                              )}
                              <button
                                type="button"
                                className="text-sm text-slate-600 hover:text-slate-900"
                                onClick={() => gerarPix.mutate(fatura.id)}
                              >
                                Pagar por Pix
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </LayoutPainel>
  );
}
