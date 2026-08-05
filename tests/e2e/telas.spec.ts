import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { PREFIXO_DE_TESTE } from '../helpers/limpeza.js';

/**
 * Captura das telas, para revisão visual.
 *
 * Não é um teste: não afirma nada. Existe para gerar imagens do produto rodando
 * de verdade, contra o banco de verdade — que é diferente de um mockup.
 *
 * Roda só quando `CAPTURAR_TELAS=1`, para não pesar o CI.
 */

const CAPTURAR = process.env['CAPTURAR_TELAS'] === '1';
const PASTA = 'telas';

const SEED = { email: 'owner@alfa.test', senha: 'formulario-dev-2026' };

test.skip(!CAPTURAR, 'defina CAPTURAR_TELAS=1 para gerar as imagens');

test.use({ viewport: { width: 1440, height: 900 } });

test('captura as telas do produto', async ({ page, context }) => {
  test.setTimeout(180_000);
  mkdirSync(PASTA, { recursive: true });

  async function capturar(nome: string) {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${PASTA}/${nome}.png`, fullPage: true });
  }

  // Página de preços — sem sessão.
  await page.goto('/precos');
  await capturar('01-precos');

  // Login.
  await page.goto('/entrar');
  await capturar('02-entrar');

  await page.getByLabel(/e-mail/i).fill(SEED.email);
  await page.getByLabel(/senha/i).fill(SEED.senha);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL(/\/formularios/, { timeout: 30_000 });
  await capturar('03-formularios');

  // Builder, com alguns campos.
  await page.getByRole('button', { name: /criar formulário/i }).click();
  await page.waitForURL(/\/formularios\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const formId = page.url().split('/').pop() as string;

  await page.locator('input').first().fill(`${PREFIXO_DE_TESTE}Pesquisa de satisfação`);
  for (const tipo of ['Texto curto', 'E-mail', 'NPS', 'Texto longo']) {
    await page.getByRole('button', { name: new RegExp(`^${tipo}$`, 'i') }).first().click();
    await page.waitForTimeout(150);
  }
  await capturar('04-builder');

  await page.getByRole('button', { name: /^salvar$/i }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^publicar$/i }).click();
  await page.waitForTimeout(1500);
  await capturar('05-builder-publicado');

  const href = (await page.getByRole('link', { name: /^\/f\// }).first().getAttribute('href')) as string;

  // Formulário público, como o respondente vê.
  const origem = new URL(page.url()).origin;
  const respondente = await context.browser()!.newContext({
    baseURL: origem,
    viewport: { width: 900, height: 900 },
  });
  const abaPublica = await respondente.newPage();

  await abaPublica.goto(`${origem}${href}`);
  await abaPublica.waitForTimeout(900);
  await abaPublica.screenshot({ path: `${PASTA}/06-formulario-publico.png`, fullPage: true });

  const campos = abaPublica.locator('input[type="text"], input[type="email"], textarea');
  if ((await campos.count()) > 0) {
    await campos.nth(0).fill('Marina Duarte');
    if ((await campos.count()) > 1) await campos.nth(1).fill('marina@empresa.test');
    const longo = abaPublica.locator('textarea').first();
    if (await longo.isVisible().catch(() => false)) {
      await longo.fill('O atendimento foi rápido e a equipe explicou tudo com paciência.');
    }
  }

  await abaPublica.getByRole('button', { name: /enviar/i }).first().click();
  await abaPublica.waitForTimeout(1500);
  await abaPublica.screenshot({ path: `${PASTA}/07-resposta-enviada.png`, fullPage: true });
  await respondente.close();

  // Recebimentos.
  await page.goto(`/formularios/${formId}/respostas`);
  await capturar('08-respostas');

  // Análises com IA.
  await page.goto(`/formularios/${formId}/analises`);
  await capturar('09-analises-ia');

  // Marca (white-label).
  await page.goto('/marca');
  await capturar('10-marca');

  // Integrações.
  await page.goto('/integracoes');
  await capturar('11-integracoes');

  // Cobrança.
  await page.goto('/cobranca');
  await capturar('12-cobranca');

  // Equipe.
  await page.goto('/equipe');
  await capturar('13-equipe');

  // Área do admin da plataforma.
  await page.goto('/admin');
  await capturar('14-admin-login');

  // Documentação da API.
  await page.goto(`${origem.replace('5174', '3334')}/docs`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${PASTA}/15-docs-api.png`, fullPage: false });
});
