import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, getApp, clearSessionCache } from '../helpers/api.js';
import { ORG_A, SEED_PASSWORD } from '../helpers/orgs.js';
import { prisma } from '../../apps/api/src/db/prisma.js';
import { generateTotp, totpAt } from '../../apps/api/src/auth/totp.js';

/**
 * Verificação em duas etapas para usuários finais.
 *
 * O TOTP já era testado (vetores do RFC 6238 em `tests/unit/totp.test.ts`).
 * O que este arquivo cobre é o FLUXO, e nele o que importa é o que NÃO deve
 * funcionar: entrar sem o código, reusar um código, desligar sem senha, e usar
 * duas vezes o mesmo código de recuperação.
 */

const HOST = 'localhost';
const EMAIL = ORG_A.viewer;

/** IPs distintos por caso: o login tem rate limit de 5 por 15 minutos, por IP. */
const BLOCO = Math.floor(Math.random() * 250);
let contador = 0;
function ipDoTeste(): string {
  contador += 1;
  return `203.0.${BLOCO}.${contador % 250}`;
}

async function entrar(payload: Record<string, unknown>) {
  const app = await getApp();
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: ipDoTeste(),
    headers: { host: HOST },
    payload: payload as never,
  });
}

async function comSessao(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  const app = await getApp();
  return app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });
}

/** Entra e devolve o access token, resolvendo o segundo fator se houver. */
async function tokenDe(mfaCode?: string): Promise<string> {
  const resposta = await entrar({ email: EMAIL, password: SEED_PASSWORD, ...(mfaCode ? { mfaCode } : {}) });

  if (resposta.statusCode !== 200) {
    throw new Error(`Login falhou: ${resposta.statusCode} ${resposta.body}`);
  }

  return (resposta.json() as { accessToken: string }).accessToken;
}

async function desligarNoBanco(): Promise<void> {
  await prisma.user.update({
    where: { email: EMAIL },
    data: { mfaEnabledAt: null, mfaSecret: null, mfaLastWindow: null, mfaRecoveryCodes: [] },
  });
}

beforeAll(desligarNoBanco);

afterEach(async () => {
  await desligarNoBanco();
  // O helper memoriza sessões por e-mail; com o MFA entrando e saindo, um token
  // memorizado de antes confundiria o caso seguinte.
  clearSessionCache();
});

afterAll(closeApp);

describe('ativação', () => {
  it('a configuração NÃO liga o MFA sozinha', async () => {
    // Ligar antes de a pessoa provar que leu o QR Code trancaria a conta se a
    // leitura desse errado.
    const token = await tokenDe();

    const setup = await comSessao('POST', '/v1/auth/mfa/setup', token);
    expect(setup.statusCode).toBe(200);
    expect((setup.json() as { uri: string }).uri.startsWith('otpauth://totp/')).toBe(true);

    const estado = (await comSessao('GET', '/v1/auth/mfa', token)).json() as { enabled: boolean };
    expect(estado.enabled).toBe(false);

    // E o login continua funcionando sem código.
    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD })).statusCode).toBe(200);
  });

  it('ativa com o primeiro código e devolve os códigos de recuperação', async () => {
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };

    const ativacao = await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) });

    expect(ativacao.statusCode).toBe(200);
    const { recoveryCodes } = ativacao.json() as { recoveryCodes: string[] };

    expect(recoveryCodes).toHaveLength(10);
    // Sem `0`, `O`, `1` e `I`: quem digita isso perdeu o celular e não pode
    // perder tempo decidindo se aquilo é um zero ou um ó.
    for (const codigo of recoveryCodes) {
      expect(codigo).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });

  it('recusa código errado na ativação', async () => {
    const token = await tokenDe();
    await comSessao('POST', '/v1/auth/mfa/setup', token);

    expect((await comSessao('POST', '/v1/auth/mfa/activate', token, { code: '000000' })).statusCode).toBe(422);
  });

  it('o banco guarda hash dos códigos, não os códigos', async () => {
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };
    const { recoveryCodes } = (
      await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) })
    ).json() as { recoveryCodes: string[] };

    const guardado = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
      select: { mfaRecoveryCodes: true },
    });

    // Mesmo motivo de uma senha: um dump do banco não pode virar acesso.
    for (const codigo of recoveryCodes) {
      expect(guardado.mfaRecoveryCodes).not.toContain(codigo);
    }
    expect(guardado.mfaRecoveryCodes).toHaveLength(10);
  });
});

describe('login com o segundo fator', () => {
  async function ativar(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };
    const { recoveryCodes } = (
      await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) })
    ).json() as { recoveryCodes: string[] };

    return { secret, recoveryCodes };
  }

  /**
   * Código da PRÓXIMA janela.
   *
   * A ativação consome a janela atual — é o mesmo bloqueio de reuso que impede
   * reapresentar um código interceptado. Na vida real isso não incomoda: quem
   * acabou de ativar já está logado. No teste, é preciso pular para a janela
   * seguinte, que a verificação aceita pela tolerância de deriva.
   */
  function codigoDaProximaJanela(secret: string): string {
    return totpAt(secret, Math.floor(Date.now() / 1000 / 30) + 1);
  }

  it('senha certa SEM código não entra', async () => {
    await ativar();

    const resposta = await entrar({ email: EMAIL, password: SEED_PASSWORD });

    expect(resposta.statusCode).toBe(401);
    // Código próprio: a tela precisa distinguir "senha errada" de "falta o
    // segundo fator" para saber qual campo mostrar.
    expect(resposta.json()).toMatchObject({ error: { code: 'mfa_required' } });
    expect(resposta.body).not.toContain('accessToken');
  });

  it('senha ERRADA com código certo não entra', async () => {
    const { secret } = await ativar();

    const resposta = await entrar({
      email: EMAIL,
      password: 'senha-errada-mas-bem-longa-2026',
      mfaCode: codigoDaProximaJanela(secret),
    });

    expect(resposta.statusCode).toBe(401);
    // E não vaza que a conta tem MFA: a mensagem é a de credencial inválida.
    expect(resposta.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('senha e código certos entram', async () => {
    const { secret } = await ativar();

    const resposta = await entrar({
      email: EMAIL,
      password: SEED_PASSWORD,
      mfaCode: codigoDaProximaJanela(secret),
    });
    expect(resposta.statusCode).toBe(200);
  });

  it('o mesmo código não vale duas vezes', async () => {
    // Ele continua válido por até 90 segundos. Sem registrar a janela
    // consumida, um código interceptado pode ser reapresentado dentro dela.
    const { secret } = await ativar();
    const codigo = codigoDaProximaJanela(secret);

    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo })).statusCode).toBe(200);

    const segunda = await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo });
    expect(segunda.statusCode).toBe(401);
    expect(segunda.body).toContain('já foi usado');
  });

  it('código de recuperação entra e serve UMA vez', async () => {
    const { recoveryCodes } = await ativar();
    const codigo = recoveryCodes[0] as string;

    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo })).statusCode).toBe(200);

    // Segunda tentativa com o mesmo: recusada.
    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo })).statusCode).toBe(401);

    // E ele saiu da lista.
    const guardado = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
      select: { mfaRecoveryCodes: true },
    });
    expect(guardado.mfaRecoveryCodes).toHaveLength(9);
  });

  it('duas tentativas SIMULTÂNEAS com o mesmo código: só uma entra', async () => {
    /**
     * Este é o caso que a checagem em memória não cobre.
     *
     * Sequencialmente o teste acima já passava: a primeira grava a janela, a
     * segunda lê a janela gravada. Em paralelo as duas leem antes de qualquer
     * uma gravar, e as duas achariam o código livre. Quem decide é o `WHERE` do
     * UPDATE, que o Postgres reavalia depois do lock da linha.
     */
    const { secret, recoveryCodes } = await ativar();

    const porTotp = await Promise.all([
      entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigoDaProximaJanela(secret) }),
      entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigoDaProximaJanela(secret) }),
    ]);
    expect(porTotp.filter((resposta) => resposta.statusCode === 200)).toHaveLength(1);

    const codigo = recoveryCodes[0] as string;
    const porRecuperacao = await Promise.all([
      entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo }),
      entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: codigo }),
    ]);
    expect(porRecuperacao.filter((resposta) => resposta.statusCode === 200)).toHaveLength(1);

    // E só um código saiu da lista — a gravação da perdedora não pode ter
    // ressuscitado nada nem apagado a mais.
    const guardado = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
      select: { mfaRecoveryCodes: true },
    });
    expect(guardado.mfaRecoveryCodes).toHaveLength(9);
  });

  it('aceita o código de recuperação com ou sem hífen', async () => {
    // Quem digita isso está numa situação ruim. O formato não deve atrapalhar.
    const { recoveryCodes } = await ativar();
    const semHifen = (recoveryCodes[0] as string).replace('-', '').toLowerCase();

    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: semHifen })).statusCode).toBe(200);
  });
});

describe('desligar exige senha', () => {
  it('uma sessão sozinha não desliga', async () => {
    // Uma sessão roubada não pode remover a proteção que existe justamente
    // para o caso de a senha ter vazado — seria a porta de trás do recurso.
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };
    await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) });

    const comSenhaErrada = await comSessao('POST', '/v1/auth/mfa/disable', token, {
      password: 'chute-de-quem-roubou-a-sessao',
    });

    expect(comSenhaErrada.statusCode).toBe(401);

    // Continua ativo.
    const estado = (await comSessao('GET', '/v1/auth/mfa', token)).json() as { enabled: boolean };
    expect(estado.enabled).toBe(true);
  });

  it('com a senha certa, desliga e limpa tudo', async () => {
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };
    await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) });

    expect((await comSessao('POST', '/v1/auth/mfa/disable', token, { password: SEED_PASSWORD })).statusCode).toBe(200);

    const guardado = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
      select: { mfaSecret: true, mfaEnabledAt: true, mfaRecoveryCodes: true, mfaLastWindow: true },
    });

    // O segredo sai junto: um segredo órfão no banco é material de ataque sem
    // nenhuma contrapartida.
    expect(guardado.mfaSecret).toBeNull();
    expect(guardado.mfaEnabledAt).toBeNull();
    expect(guardado.mfaLastWindow).toBeNull();
    expect(guardado.mfaRecoveryCodes).toHaveLength(0);
  });

  it('gerar novos códigos também exige senha, e invalida os antigos', async () => {
    const token = await tokenDe();
    const { secret } = (await comSessao('POST', '/v1/auth/mfa/setup', token)).json() as { secret: string };
    const { recoveryCodes } = (
      await comSessao('POST', '/v1/auth/mfa/activate', token, { code: generateTotp(secret) })
    ).json() as { recoveryCodes: string[] };

    expect((await comSessao('POST', '/v1/auth/mfa/recovery-codes', token, { password: 'errada' })).statusCode).toBe(
      401,
    );

    const novos = await comSessao('POST', '/v1/auth/mfa/recovery-codes', token, { password: SEED_PASSWORD });
    expect(novos.statusCode).toBe(200);

    // O código antigo deixou de valer.
    const antigo = recoveryCodes[0] as string;
    expect((await entrar({ email: EMAIL, password: SEED_PASSWORD, mfaCode: antigo })).statusCode).toBe(401);
  });
});
