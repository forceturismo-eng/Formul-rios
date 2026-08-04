import { useState } from 'react';
import {
  PLANS,
  formatBRL,
  formatBRLCompact,
  isUnlimited,
  monthlyEquivalentCents,
  yearlySavingsCents,
  type Plan,
} from '@forms/shared';
import { Link } from '../lib/router.js';

/**
 * Página de preços.
 *
 * A copy é a da seção 10 do documento de produto, ao pé da letra. O que ela
 * NÃO tem, também de propósito: depoimento inventado, logo de cliente que não
 * existe e estatística sem origem. No lugar disso vai o bloco de prova
 * indireta sobre isolamento e LGPD, que é verdade verificável.
 */

const numero = new Intl.NumberFormat('pt-BR');

function precoExibido(plan: Plan, anual: boolean): { destaque: string; complemento: string | null } {
  if (plan.priceMonthlyCents === null) return { destaque: 'Sob consulta', complemento: null };
  if (plan.priceMonthlyCents === 0) return { destaque: 'R$ 0', complemento: null };

  if (!anual) return { destaque: `${formatBRLCompact(plan.priceMonthlyCents)}/mês`, complemento: null };

  const mensalizado = monthlyEquivalentCents(plan.priceYearlyCents as number);
  const economia = yearlySavingsCents(plan.priceMonthlyCents, plan.priceYearlyCents as number);

  return {
    // O equivalente mensal é o número em destaque; o valor cheio vem menor.
    destaque: `${formatBRLCompact(mensalizado)}/mês`,
    complemento: `cobrado ${formatBRL(plan.priceYearlyCents as number)} por ano · você economiza ${formatBRL(economia)}`,
  };
}

const DESTAQUES: Record<string, { chamada: string; itens: string[] }> = {
  free: {
    chamada: '',
    itens: ['3 formulários', '100 respostas/mês', '1 usuário', 'Respostas guardadas por 90 dias'],
  },
  starter: {
    chamada: 'Tudo do Free, mais:',
    itens: [
      '15 formulários e 1.000 respostas/mês',
      '3 membros',
      'Lógica condicional completa e cálculos',
      'Webhooks e exportação em Excel',
      '50 análises com IA por mês',
    ],
  },
  pro: {
    chamada: 'Tudo do Starter, mais:',
    itens: [
      '50 formulários e 5.000 respostas/mês',
      '10 membros',
      '**Seu domínio: formularios.suaempresa.com.br**',
      '**Sem a marca Formulários nos formulários**',
      'API pública e 300 análises com IA',
      'Campos de pagamento e assinatura',
    ],
  },
  business: {
    chamada: 'Tudo do Pro, mais:',
    itens: [
      'Formulários ilimitados e 25.000 respostas/mês',
      '30 membros e 5 domínios próprios',
      'CSS customizado e remetente de e-mail próprio',
      'Boleto mensal disponível',
      'Suporte prioritário em até 8 horas',
    ],
  },
  enterprise: {
    chamada: '',
    itens: [
      'Tudo ilimitado, negociado por contrato',
      'SSO/SAML e DPA personalizado',
      'Banco de dados dedicado',
      'Gerente de conta e SLA de 99,9%',
    ],
  },
};

const CHAMADAS: Record<string, { rotulo: string; destino: string }> = {
  free: { rotulo: 'Criar conta grátis', destino: '/criar-conta' },
  starter: { rotulo: 'Testar 14 dias grátis', destino: '/criar-conta' },
  pro: { rotulo: 'Testar 14 dias grátis', destino: '/criar-conta' },
  business: { rotulo: 'Testar 14 dias grátis', destino: '/criar-conta' },
  enterprise: { rotulo: 'Falar com vendas', destino: '/contato' },
};

const FAQ = [
  {
    pergunta: 'O que acontece se eu passar do limite de respostas?',
    resposta:
      'Nada é perdido. Avisamos quando você chegar a 80% da cota e continuamos aceitando respostas por mais 48 horas depois do limite. Nesse período você decide se faz upgrade ou compra um pacote avulso. Nenhuma resposta é apagada.',
  },
  {
    pergunta: 'Posso pagar no boleto?',
    resposta:
      'Sim. Boleto está disponível no plano anual do Starter, no semestral e anual do Pro, e também no mensal no Business. Cartão de crédito e Pix funcionam em todos os planos e ciclos.',
  },
  {
    pergunta: 'Vocês emitem nota fiscal?',
    resposta:
      'Sim. A NFS-e é emitida automaticamente após a confirmação do pagamento e fica disponível para download no painel.',
  },
  {
    pergunta: 'Preciso de cartão para testar?',
    resposta:
      'Não. São 14 dias completos, sem cartão. Se você não assinar ao final, a conta vira Free — seus formulários continuam lá.',
  },
  {
    pergunta: 'Posso trocar de plano depois?',
    resposta:
      'A qualquer momento. Ao subir, cobramos só a diferença proporcional. Ao descer, aplicamos crédito na próxima fatura.',
  },
  {
    pergunta: 'Meus dados ficam separados dos de outras empresas?',
    resposta:
      'Sim, e não é só uma configuração da aplicação: o isolamento é aplicado no próprio banco de dados. Nenhuma consulta consegue enxergar dados de outra empresa, mesmo em caso de falha no código.',
  },
  {
    pergunta: 'Vocês usam minhas respostas para treinar IA?',
    resposta:
      'Não. A análise com IA é opcional e vem desligada. Quando você ativa, pode mascarar dados pessoais antes do envio, e nada é usado para treinar nenhum modelo.',
  },
  {
    pergunta: 'E se eu cancelar?',
    resposta:
      'Seus dados ficam disponíveis para exportação por 30 dias. Depois disso, apagamos tudo em definitivo.',
  },
];

/** Rende **negrito** sem trazer um parser de markdown para a página. */
function ComDestaque({ texto }: { texto: string }) {
  const partes = texto.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {partes.map((parte, i) =>
        parte.startsWith('**') && parte.endsWith('**') ? (
          <strong key={i} className="font-semibold text-slate-900">
            {parte.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{parte}</span>
        ),
      )}
    </>
  );
}

function limiteLegivel(valor: number): string {
  return isUnlimited(valor) ? 'Ilimitado' : numero.format(valor);
}

export function PaginaPrecos() {
  const [anual, setAnual] = useState(false);
  const publicos = PLANS.filter((plano) => plano.isPublic);

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-lg font-semibold text-slate-900">
            Formulários
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/entrar" className="text-sm font-medium text-slate-600 hover:text-slate-900">
              Entrar
            </Link>
            <Link to="/criar-conta" className="botao-primario">
              Criar conta grátis
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-8 pt-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Preço por resposta, não por formulário.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">
          Todos os planos incluem construtor completo, lógica condicional e análise das respostas. Comece com 14
          dias grátis, sem cartão de crédito.
        </p>

        <div className="mt-8 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => setAnual(false)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              anual ? 'text-slate-600 hover:text-slate-900' : 'bg-white text-slate-900 shadow-sm'
            }`}
          >
            Mensal
          </button>
          <button
            type="button"
            onClick={() => setAnual(true)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              anual ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Anual · 2 meses grátis
          </button>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 pb-16 lg:grid-cols-3">
        {publicos.map((plano) => {
          const preco = precoExibido(plano, anual);
          const destaque = DESTAQUES[plano.code];
          const chamada = CHAMADAS[plano.code];

          return (
            <div
              key={plano.code}
              className={`relative flex flex-col rounded-2xl border p-6 ${
                plano.isHighlighted ? 'border-slate-900 shadow-lg' : 'border-slate-200'
              }`}
            >
              {plano.isHighlighted && (
                <span className="absolute -top-3 left-6 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                  Mais escolhido
                </span>
              )}

              <h2 className="text-lg font-semibold text-slate-900">{plano.name}</h2>
              <p className="mt-1 text-sm text-slate-500">{plano.tagline}</p>

              <div className="mt-5">
                <p className="text-3xl font-semibold tracking-tight text-slate-900">{preco.destaque}</p>
                {preco.complemento && <p className="mt-1 text-xs text-slate-500">{preco.complemento}</p>}
              </div>

              <Link
                to={chamada?.destino ?? '/criar-conta'}
                className={`mt-6 w-full justify-center ${
                  plano.isHighlighted ? 'botao-primario' : 'botao-secundario'
                }`}
              >
                {chamada?.rotulo ?? 'Criar conta grátis'}
              </Link>

              {destaque?.chamada && <p className="mt-6 text-sm font-medium text-slate-700">{destaque.chamada}</p>}

              <ul className="mt-4 space-y-2.5 text-sm text-slate-600">
                {destaque?.itens.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true" className="mt-0.5 text-emerald-600">
                      ✓
                    </span>
                    <span>
                      <ComDestaque texto={item} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* Prova indireta — sem depoimento inventado nem logo de cliente que não existe. */}
      <section className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center">
          <h2 className="text-2xl font-semibold text-slate-900">Seus dados ficam no Brasil e sob seu controle</h2>
          <p className="mt-3 text-slate-600">
            Respostas criptografadas, isolamento total entre empresas e conformidade com a LGPD. Você exporta ou
            apaga tudo quando quiser.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-2xl font-semibold text-slate-900">Não sabe qual escolher?</h2>
        <p className="mt-2 text-slate-600">
          A conta é simples: quantas respostas você recebe por mês e quantas pessoas precisam ver.
        </p>

        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="py-3 font-medium">Você é…</th>
              <th className="py-3 font-medium">Comece com</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <tr>
              <td className="py-3 text-slate-700">Profissional autônomo ou equipe de até 3</td>
              <td className="py-3 font-medium text-slate-900">Starter</td>
            </tr>
            <tr>
              <td className="py-3 text-slate-700">Empresa com formulário no site e clientes externos</td>
              <td className="py-3 font-medium text-slate-900">Pro</td>
            </tr>
            <tr>
              <td className="py-3 text-slate-700">Operação com múltiplas equipes e alto volume</td>
              <td className="py-3 font-medium text-slate-900">Business</td>
            </tr>
          </tbody>
        </table>

        <h3 className="mt-12 text-lg font-semibold text-slate-900">Limites por plano</h3>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-3 font-medium">Limite</th>
                {publicos.map((plano) => (
                  <th key={plano.code} className="py-3 font-medium">
                    {plano.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(
                [
                  ['Formulários', 'forms'],
                  ['Respostas por mês', 'responsesPerMonth'],
                  ['Membros', 'members'],
                  ['Domínios próprios', 'customDomains'],
                  ['Análises com IA', 'aiAnalysesPerMonth'],
                ] as const
              ).map(([rotulo, chave]) => (
                <tr key={chave}>
                  <td className="py-3 text-slate-700">{rotulo}</td>
                  {publicos.map((plano) => (
                    <td key={plano.code} className="py-3 text-slate-900">
                      {limiteLegivel(plano.limits[chave])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-3xl px-4 py-16">
          <h2 className="text-2xl font-semibold text-slate-900">Perguntas frequentes</h2>
          <dl className="mt-8 space-y-8">
            {FAQ.map((item) => (
              <div key={item.pergunta}>
                <dt className="font-medium text-slate-900">{item.pergunta}</dt>
                <dd className="mt-2 text-slate-600">{item.resposta}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h2 className="text-3xl font-semibold text-slate-900">Comece hoje, decida depois.</h2>
        <p className="mt-3 text-slate-600">
          14 dias com tudo liberado, sem cartão de crédito. Se não for para você, não fazemos nada — a conta
          simplesmente volta para o plano Free.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/criar-conta" className="botao-primario">
            Criar minha conta grátis
          </Link>
          <Link to="/contato" className="botao-secundario">
            Falar com vendas
          </Link>
        </div>
      </section>
    </div>
  );
}
