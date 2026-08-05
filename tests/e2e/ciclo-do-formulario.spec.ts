import { expect, test } from '@playwright/test';
import { PREFIXO_DE_TESTE } from '../helpers/limpeza.js';

/**
 * O caminho que sustenta o produto inteiro, num navegador de verdade.
 *
 * O que só estes casos provam: que a tela chama a API certa, que o cookie de
 * sessão viaja, que o formulário renderiza os campos que o schema descreve, e
 * que o que uma pessoa digita chega decifrado do outro lado.
 *
 * São poucos casos, de propósito. E2e é caro e frágil; o que justifica cada um
 * aqui é ser um caminho que nenhuma outra suíte consegue exercitar.
 */

const SEED = { email: 'owner@alfa.test', senha: 'formulario-dev-2026' };

/** E-mail único por execução: o banco não é zerado entre rodadas. */
function emailNovo(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}@exemplo.test`;
}

test('cadastro cria conta e empresa, e pede confirmação de e-mail', async ({ page }) => {
  // O registro cria a empresa junto — não existe usuário sem empresa. E o
  // painel abre já avisando que ações que criam dado dependem da confirmação.
  await page.goto('/criar-conta');

  await page.getByLabel(/nome da empresa/i).fill(`Empresa E2E ${Date.now()}`);
  await page.getByLabel(/seu nome/i).fill('Pessoa do Teste');
  await page.getByLabel(/e-mail/i).fill(emailNovo());
  await page.getByLabel(/senha/i).fill('Formulario-e2e-2026!');

  await page.getByRole('button', { name: /criar minha conta/i }).click();

  await expect(page).toHaveURL(/\/formularios/, { timeout: 30_000 });
  await expect(page.getByText(/confirme seu e-mail/i)).toBeVisible();
});

test('login, formulário, publicação, resposta e leitura', async ({ page, context }) => {
  // Conta do seed, com e-mail já confirmado. Registrar aqui não serviria: criar
  // formulário exige confirmação, e o e2e não tem como abrir a caixa de entrada.
  await page.goto('/entrar');
  await page.getByLabel(/e-mail/i).fill(SEED.email);
  await page.getByLabel(/senha/i).fill(SEED.senha);
  await page.getByRole('button', { name: /entrar/i }).click();

  await expect(page).toHaveURL(/\/formularios/, { timeout: 30_000 });

  // ---------------------------------------------------------------------------
  // Cria e publica
  // ---------------------------------------------------------------------------
  await page.getByRole('button', { name: /criar formulário/i }).click();
  await expect(page).toHaveURL(/\/formularios\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  const formId = page.url().split('/').pop() as string;

  // Título marcado: é por ele que a limpeza no fim da execução encontra o que
  // apagar. Sem isso, cada rodada deixa um formulário para trás e a empresa vai
  // empurrando o limite do plano — falhando, um dia, por acúmulo.
  const tituloDoFormulario = page.locator('input').first();
  await tituloDoFormulario.fill(`${PREFIXO_DE_TESTE}Ciclo e2e ${Date.now()}`);

  // Um formulário novo nasce sem campos, e o botão de publicar fica desligado
  // até haver pelo menos um — publicar formulário vazio não faria sentido.
  await expect(page.getByText(/adicionar campo/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^texto curto$/i }).click();

  await expect(page.getByText(/escolha um tipo de campo/i)).toBeHidden();

  // Salvar antes de publicar: o campo existe no navegador, e publicar promove
  // o que está no SERVIDOR. Sem o save, sairia uma versão sem campo nenhum.
  await page.getByRole('button', { name: /^salvar$/i }).click();

  const publicar = page.getByRole('button', { name: /^publicar$/i });
  await expect(publicar).toBeEnabled({ timeout: 30_000 });
  await publicar.click();

  const linkPublico = page.getByRole('link', { name: /^\/f\// }).first();
  await expect(linkPublico).toBeVisible({ timeout: 30_000 });

  const href = (await linkPublico.getAttribute('href')) as string;
  expect(href).toMatch(/^\/f\//);

  // ---------------------------------------------------------------------------
  // Responde — em outro contexto, SEM sessão, como um respondente de verdade
  // ---------------------------------------------------------------------------
  // `baseURL` do config NÃO é herdado por um contexto criado à mão, então a
  // URL aqui é absoluta. É também mais fiel ao que acontece: o respondente
  // recebe um link completo por WhatsApp, não um caminho relativo.
  const origem = new URL(page.url()).origin;
  const respondente = await context.browser()!.newContext({ baseURL: origem });
  const abaPublica = await respondente.newPage();

  await abaPublica.goto(`${origem}${href}`);
  await expect(abaPublica.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });

  const marca = `resposta-e2e-${Date.now()}`;
  const campos = abaPublica.locator('input[type="text"], textarea').filter({ visible: true });
  const quantosCampos = await campos.count();

  if (quantosCampos > 0) await campos.first().fill(marca);

  await abaPublica.getByRole('button', { name: /enviar/i }).first().click();

  await expect(abaPublica.getByText(/recebemos|obrigad|enviad/i).first()).toBeVisible({ timeout: 30_000 });

  // A confirmação ao respondente não menciona plano, limite nem pagamento —
  // a relação comercial é entre a plataforma e o dono do formulário.
  const confirmacao = (await abaPublica.locator('body').innerText()).toLowerCase();
  expect(confirmacao).not.toContain('limite do plano');
  expect(confirmacao).not.toContain('pagamento');
  expect(confirmacao).not.toContain('assinatura');

  await respondente.close();

  // ---------------------------------------------------------------------------
  // Lê no painel, decifrada
  // ---------------------------------------------------------------------------
  await page.goto(`/formularios/${formId}/respostas`);

  if (quantosCampos > 0) {
    // O que a pessoa digitou volta legível: a criptografia em repouso não é
    // decorativa, e o caminho de volta funciona ponta a ponta.
    await expect(page.getByText(marca).first()).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.getByText(/1 resposta|1 recebiment|há 1/i).first()).toBeVisible({ timeout: 30_000 });
  }

});

test('formulário inexistente não vaza a existência de nada', async ({ page }) => {
  await page.goto('/f/formulario-que-nao-existe-mesmo');

  await expect(page.getByText(/não está disponível/i)).toBeVisible({ timeout: 30_000 });

  // Nada sugere que o formulário existiu um dia: "apagado" e "despublicado"
  // são informações que o respondente não deve conseguir distinguir de
  // "nunca existiu".
  const texto = (await page.locator('body').innerText()).toLowerCase();
  expect(texto).not.toContain('excluíd');
  expect(texto).not.toContain('despublicad');
  expect(texto).not.toContain('arquivad');
});
