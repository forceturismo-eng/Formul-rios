import { randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { hashToken } from '../auth/hashing.js';
import { generateTotpSecret, totpUri, totpWindowOf, verifyTotp } from '../auth/totp.js';
import { unauthorized, validationError } from '../http/errors.js';
import { env } from '../config/env.js';

/**
 * MFA para usuários finais.
 *
 * O TOTP em si já existia — ele foi escrito para o admin da plataforma
 * (ADR 0009) e está em `auth/totp.ts`. Aqui é o fluxo de quem usa o produto,
 * que tem uma diferença que muda o desenho: **para o admin, MFA é obrigatório;
 * para o cliente, é escolha dele.**
 *
 * Dessa diferença sai tudo o mais. Como é opcional, precisa haver como
 * desligar; como pode ser desligado, desligar precisa exigir prova; e como a
 * pessoa pode perder o celular, precisam existir códigos de recuperação —
 * senão a única saída seria um chamado para nós, provando identidade por
 * e-mail, que é justamente o fator que o MFA existe para não bastar.
 */

/** Quantos códigos de recuperação e de que tamanho. */
const QUANTOS_CODIGOS = 10;

/**
 * Formato do código de recuperação.
 *
 * Dez caracteres em base32 sem ambiguidade visual — sem `0`, `O`, `1`, `I`.
 * Quem digita esse código está numa situação ruim (perdeu o celular) e não
 * pode perder tempo decidindo se aquilo é um zero ou um ó.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function gerarCodigo(): string {
  const bytes = randomBytes(10);
  let codigo = '';

  for (const byte of bytes) {
    codigo += ALFABETO[byte % ALFABETO.length];
  }

  // Hífen no meio: ajuda a ler em voz alta e a conferir o que foi digitado.
  return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
}

function normalizar(codigo: string): string {
  return codigo.replace(/[\s-]/g, '').toUpperCase();
}

export interface InicioDeMfa {
  secret: string;
  uri: string;
}

/**
 * Começa a configuração: gera o segredo e devolve o QR Code.
 *
 * O MFA NÃO é ligado aqui. Ligar só acontece depois de a pessoa provar que
 * conseguiu ler o QR Code — sem essa separação, um erro na leitura trancaria a
 * conta para sempre.
 */
export async function iniciarMfa(userId: string): Promise<InicioDeMfa> {
  const usuario = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, mfaEnabledAt: true },
  });

  if (usuario.mfaEnabledAt) {
    throw validationError({ mfa: ['A verificação em duas etapas já está ativa nesta conta.'] });
  }

  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });

  return {
    secret,
    uri: totpUri({ secret, account: usuario.email, issuer: env.branding.productName }),
  };
}

export interface MfaAtivado {
  recoveryCodes: string[];
}

/**
 * Conclui a configuração conferindo o primeiro código.
 *
 * Devolve os códigos de recuperação em claro — a ÚNICA vez. Depois disso o
 * banco só tem o hash deles, pelo mesmo motivo de uma senha: um dump não pode
 * virar acesso às contas.
 */
export async function ativarMfa(userId: string, codigo: string): Promise<MfaAtivado> {
  const usuario = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaSecret: true, mfaEnabledAt: true },
  });

  if (usuario.mfaEnabledAt) {
    throw validationError({ mfa: ['A verificação em duas etapas já está ativa.'] });
  }
  if (!usuario.mfaSecret) {
    throw validationError({ mfa: ['Comece a configuração antes de confirmar o código.'] });
  }
  if (!verifyTotp(usuario.mfaSecret, codigo)) {
    throw validationError({ code: ['Código inválido. Confira o horário do seu celular.'] });
  }

  const codigos = Array.from({ length: QUANTOS_CODIGOS }, gerarCodigo);
  const janela = totpWindowOf(usuario.mfaSecret, codigo);

  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaEnabledAt: new Date(),
      mfaRecoveryCodes: codigos.map((item) => hashToken(normalizar(item))),
      ...(janela !== null ? { mfaLastWindow: BigInt(janela) } : {}),
    },
  });

  return { recoveryCodes: codigos };
}

/**
 * Desliga o MFA.
 *
 * Exige a senha atual, não apenas a sessão. Uma sessão roubada não pode
 * remover a proteção que existe justamente para o caso de a senha ter vazado —
 * seria a porta de trás do próprio recurso.
 */
export async function desativarMfa(userId: string, senhaConferida: boolean): Promise<void> {
  if (!senhaConferida) throw unauthorized('Confirme sua senha para desligar a verificação em duas etapas.');

  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabledAt: null, mfaSecret: null, mfaLastWindow: null, mfaRecoveryCodes: [] },
  });
}

export interface EstadoDoMfa {
  enabled: boolean;
  enabledAt: Date | null;
  /** Quantos códigos de recuperação ainda não foram usados. */
  recoveryCodesLeft: number;
}

export async function estadoDoMfa(userId: string): Promise<EstadoDoMfa> {
  const usuario = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaEnabledAt: true, mfaRecoveryCodes: true },
  });

  return {
    enabled: usuario.mfaEnabledAt !== null,
    enabledAt: usuario.mfaEnabledAt,
    recoveryCodesLeft: usuario.mfaRecoveryCodes.length,
  };
}

/** Gera códigos novos, invalidando os anteriores. */
export async function regenerarCodigos(userId: string, senhaConferida: boolean): Promise<string[]> {
  if (!senhaConferida) throw unauthorized('Confirme sua senha para gerar novos códigos.');

  const usuario = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaEnabledAt: true },
  });

  if (!usuario.mfaEnabledAt) {
    throw validationError({ mfa: ['A verificação em duas etapas não está ativa.'] });
  }

  const codigos = Array.from({ length: QUANTOS_CODIGOS }, gerarCodigo);

  await prisma.user.update({
    where: { id: userId },
    data: { mfaRecoveryCodes: codigos.map((item) => hashToken(normalizar(item))) },
  });

  return codigos;
}

// -----------------------------------------------------------------------------
// Verificação no login
// -----------------------------------------------------------------------------

/**
 * Confere o segundo fator: código do app OU código de recuperação.
 *
 * Aceita os dois no mesmo campo de propósito. Quem perdeu o celular está numa
 * situação ruim e não deve ter que descobrir em qual campo digitar — o formato
 * distingue sozinho, e a tela fica com um campo só.
 */
export async function verificarSegundoFator(userId: string, codigo: string): Promise<void> {
  const usuario = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaSecret: true, mfaLastWindow: true, mfaRecoveryCodes: true },
  });

  if (!usuario.mfaSecret) throw unauthorized('Código inválido.');

  const limpo = normalizar(codigo);

  // Código de recuperação: 10 caracteres do alfabeto, sem dígitos de TOTP.
  if (limpo.length === 10) {
    const hash = hashToken(limpo);
    const indice = usuario.mfaRecoveryCodes.findIndex((guardado) => comparaEmTempoConstante(guardado, hash));

    if (indice === -1) throw unauthorized('Código inválido.');

    /**
     * Serve UMA vez — e quem garante isso é o banco, não a checagem acima.
     *
     * Duas tentativas simultâneas com o mesmo código leem a mesma lista antes
     * de qualquer uma gravar, e as duas achariam o código lá. Por isso o
     * `updateMany` condiciona a gravação à lista continuar exatamente como foi
     * lida: o Postgres serializa os UPDATE na mesma linha e reavalia o `WHERE`
     * depois do lock, então o segundo não encontra nada para atualizar.
     */
    const restantes = usuario.mfaRecoveryCodes.filter((_, posicao) => posicao !== indice);
    const gravou = await prisma.user.updateMany({
      where: { id: userId, mfaRecoveryCodes: { equals: usuario.mfaRecoveryCodes } },
      data: { mfaRecoveryCodes: restantes },
    });

    if (gravou.count === 0) throw unauthorized('Código inválido.');

    return;
  }

  const janela = totpWindowOf(usuario.mfaSecret, limpo);
  if (janela === null) throw unauthorized('Código inválido.');

  /**
   * O mesmo código vale por até 90 segundos. Sem registrar a janela consumida,
   * um código interceptado pode ser reapresentado dentro dela.
   *
   * A comparação vai no `WHERE` pelo mesmo motivo do código de recuperação:
   * decidir em memória deixaria duas tentativas simultâneas passarem juntas.
   */
  const consumiu = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ mfaLastWindow: null }, { mfaLastWindow: { lt: BigInt(janela) } }],
    },
    data: { mfaLastWindow: BigInt(janela) },
  });

  if (consumiu.count === 0) throw unauthorized('Este código já foi usado. Aguarde o próximo.');
}

function comparaEmTempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
