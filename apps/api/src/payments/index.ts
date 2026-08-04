import { env } from '../config/env.js';
import { createAsaasProvider } from './asaas.js';
import { setPaymentProvider } from './provider.js';

/**
 * Registra o provedor de pagamento na subida.
 *
 * Sem `ASAAS_API_KEY`, nenhum provedor é registrado e as rotas de cobrança
 * respondem que a cobrança está indisponível. Isso é melhor do que subir com
 * um provedor falso em produção por engano: quem está desenvolvendo o builder
 * não precisa de credencial, e quem faz deploy sem a chave descobre na
 * primeira tentativa de assinar, não no fim do mês.
 */
export function registerPaymentProvider(): void {
  const asaas = createAsaasProvider({
    ASAAS_API_KEY: process.env['ASAAS_API_KEY'],
    ASAAS_ENV: process.env['ASAAS_ENV'],
    ASAAS_WEBHOOK_TOKEN: process.env['ASAAS_WEBHOOK_TOKEN'],
  });

  if (asaas) {
    setPaymentProvider(asaas);
    return;
  }

  if (env.isProduction) {
    throw new Error('ASAAS_API_KEY não definida. A cobrança não pode subir sem provedor em produção.');
  }
}

export * from './provider.js';
