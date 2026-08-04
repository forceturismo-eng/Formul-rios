import { normalizeHost } from './branding.js';

/**
 * Validação de domínio de cliente (seção 8.4).
 *
 * O risco aqui não é técnico, é de abuso. Qualquer pessoa pode apontar um
 * domínio para o nosso IP. Sem controle, isso vira emissão de certificado em
 * nome de domínio que não é de cliente — o que esgota o rate limit da
 * Let's Encrypt e nos torna infraestrutura de phishing.
 *
 * Este módulo é a primeira barreira: o que ele recusa nem chega a virar linha
 * em `custom_domains`. A segunda é a verificação de posse por TXT, e a terceira
 * é o endpoint `ask` do Caddy.
 */

export type DomainRejection =
  | 'vazio'
  | 'formato_invalido'
  | 'ip'
  | 'reservado'
  | 'proprio'
  | 'lista_negra'
  | 'muito_longo'
  | 'rotulo_invalido';

export interface DomainValidation {
  ok: boolean;
  /** Domínio normalizado, pronto para gravar. */
  domain: string;
  reason?: DomainRejection;
  message?: string;
  /** Subdomínio aceita CNAME; apex precisa de A ou ALIAS. */
  type: 'subdomain' | 'apex';
}

/**
 * Sufixos reservados. `localhost` e `.local` resolvem para a própria máquina;
 * `.internal` e `.test` são de uso interno por padrão.
 */
const SUFIXOS_RESERVADOS = ['localhost', '.localhost', '.local', '.internal', '.home.arpa', '.example'];

/**
 * Domínios de terceiros que não podem ser apontados para cá.
 *
 * Alguém que consiga criar um subdomínio num serviço de hospedagem
 * compartilhada e apontá-lo para nós ganharia um certificado com aquele nome.
 */
const LISTA_NEGRA = [
  'amazonaws.com',
  'azurewebsites.net',
  'cloudfront.net',
  'github.io',
  'herokuapp.com',
  'netlify.app',
  'ngrok.io',
  'pages.dev',
  'vercel.app',
  'web.app',
  'workers.dev',
];

const ROTULO_VALIDO = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SO_DIGITOS_E_PONTOS = /^[\d.]+$/;

/** Domínio de segundo nível brasileiro: `com.br`, `org.br`, e afins. */
const SEGUNDO_NIVEL_BR = new Set([
  'com',
  'net',
  'org',
  'gov',
  'edu',
  'mil',
  'art',
  'blog',
  'eco',
  'ind',
  'inf',
  'rec',
  'srv',
  'tur',
  'adv',
  'eng',
  'med',
]);

/**
 * `formularios.empresa.com.br` é subdomínio; `empresa.com.br` é apex.
 *
 * A distinção importa porque apex não aceita CNAME pelo padrão do DNS — o
 * cliente precisa de registro A ou de ALIAS/ANAME, se o provedor dele
 * suportar. Instruir errado aqui gera chamado de suporte.
 */
export function classifyDomain(domain: string): 'subdomain' | 'apex' {
  const partes = domain.split('.');
  if (partes.length <= 2) return 'apex';

  // Trata `empresa.com.br` como apex, não como subdomínio de `com.br`.
  if (partes.length === 3 && partes[2] === 'br' && SEGUNDO_NIVEL_BR.has(partes[1] as string)) return 'apex';

  return 'subdomain';
}

export interface ValidateDomainOptions {
  /** Nossos próprios domínios. Nenhum subdomínio deles pode ser cadastrado. */
  ownDomains: string[];
}

/**
 * `true` quando o domínio é um sufixo público — algo sob o qual qualquer um
 * registra, como `com.br` ou `com`.
 *
 * Isto existe para o cálculo de ancestrais não sair bloqueando meio país: se a
 * plataforma vive em `app.produto.com.br`, um ancestral ingênuo seria
 * `com.br`, e bloqueá-lo recusaria TODOS os domínios dos clientes.
 */
function isPublicSuffix(domain: string): boolean {
  const partes = domain.split('.');

  if (partes.length === 1) return true;
  if (partes.length === 2 && partes[1] === 'br' && SEGUNDO_NIVEL_BR.has(partes[0] as string)) return true;

  return false;
}

/**
 * O domínio e seus ancestrais registráveis.
 *
 * `app.produto.com.br` produz `app.produto.com.br` e `produto.com.br`, e para
 * aí. Bloquear os dois impede que alguém cadastre o domínio-pai da plataforma
 * — e, com ele, sirva conteúdo num nome que os nossos clientes reconhecem
 * como nosso.
 */
function ancestorsOf(domain: string): string[] {
  const partes = domain.split('.');
  const resultado: string[] = [];

  for (let i = 0; i <= partes.length - 2; i++) {
    const candidato = partes.slice(i).join('.');
    if (isPublicSuffix(candidato)) break;
    resultado.push(candidato);
  }

  return resultado;
}

export function validateCustomDomain(raw: string, options: ValidateDomainOptions): DomainValidation {
  const domain = normalizeHost(raw);
  const tipo = domain ? classifyDomain(domain) : 'apex';

  const recusa = (reason: DomainRejection, message: string): DomainValidation => ({
    ok: false,
    domain,
    reason,
    message,
    type: tipo,
  });

  if (!domain) return recusa('vazio', 'Informe o domínio.');
  if (domain.length > 253) return recusa('muito_longo', 'Esse domínio passa do tamanho máximo permitido.');

  // Endereço IP não é domínio, e certificado para IP não é o que o cliente quer.
  if (SO_DIGITOS_E_PONTOS.test(domain) || domain.includes(':')) {
    return recusa('ip', 'Informe um domínio, não um endereço IP.');
  }

  const rotulos = domain.split('.');

  for (const rotulo of rotulos) {
    if (!ROTULO_VALIDO.test(rotulo)) {
      return recusa('rotulo_invalido', 'Esse domínio tem caracteres que o DNS não aceita.');
    }
  }

  // "É nosso" vem ANTES de "é reservado" e de "tem poucos rótulos": quando os
  // dois valem, a razão mais específica é a mais útil para quem lê a mensagem.
  //
  // Nenhum subdomínio nosso: quem cadastrasse `app.nossodominio.com.br`
  // passaria a servir conteúdo no domínio onde vive a sessão dos clientes.
  for (const proprio of options.ownDomains.map(normalizeHost).filter(Boolean)) {
    for (const nosso of ancestorsOf(proprio)) {
      if (domain === nosso || domain.endsWith(`.${nosso}`)) {
        return recusa('proprio', 'Esse domínio já pertence à plataforma.');
      }
    }
  }

  for (const sufixo of SUFIXOS_RESERVADOS) {
    if (domain === sufixo.replace(/^\./, '') || domain.endsWith(sufixo)) {
      return recusa('reservado', 'Esse domínio é reservado e não pode ser usado.');
    }
  }

  // Depois dos casos específicos: um domínio de um rótulo só que não seja
  // reservado nem nosso é simplesmente incompleto.
  if (rotulos.length < 2) {
    return recusa('formato_invalido', 'Informe um domínio completo, como formularios.suaempresa.com.br.');
  }

  for (const bloqueado of LISTA_NEGRA) {
    if (domain === bloqueado || domain.endsWith(`.${bloqueado}`)) {
      return recusa('lista_negra', 'Esse serviço de hospedagem não pode ser usado como domínio próprio.');
    }
  }

  return { ok: true, domain, type: tipo };
}

/** Nome do registro TXT de verificação de posse. */
export function verificationRecordName(domain: string): string {
  const [primeiro, ...resto] = domain.split('.');
  return resto.length > 0 ? `_verify.${primeiro}` : '_verify';
}

export interface DnsInstructions {
  type: 'subdomain' | 'apex';
  registros: Array<{ tipo: string; nome: string; valor: string; observacao?: string }>;
}

/**
 * O que o cliente precisa criar no provedor de DNS dele.
 *
 * Instrução errada aqui é a causa número um de chamado de suporte em domínio
 * próprio — por isso ela sai daqui, calculada, e não de um texto fixo na tela.
 */
export function dnsInstructions(params: {
  domain: string;
  verificationToken: string;
  cnameTarget: string;
  edgeIp?: string;
}): DnsInstructions {
  const tipo = classifyDomain(params.domain);
  const [primeiro] = params.domain.split('.');

  const verificacao = {
    tipo: 'TXT',
    nome: verificationRecordName(params.domain),
    valor: params.verificationToken,
    observacao: 'Comprova que o domínio é seu. Pode ser removido depois que o domínio ficar ativo.',
  };

  if (tipo === 'subdomain') {
    return {
      type: 'subdomain',
      registros: [
        { tipo: 'CNAME', nome: primeiro as string, valor: params.cnameTarget },
        verificacao,
      ],
    };
  }

  return {
    type: 'apex',
    registros: [
      {
        tipo: 'A',
        nome: '@',
        valor: params.edgeIp ?? '',
        observacao:
          'Domínio raiz não aceita CNAME pelo padrão do DNS. Se o seu provedor oferecer ALIAS ou ANAME, ' +
          `use ${params.cnameTarget} — assim o endereço acompanha mudanças de infraestrutura sozinho.`,
      },
      verificacao,
    ],
  };
}
