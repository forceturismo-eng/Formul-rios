import { defineConfig, devices } from '@playwright/test';

/**
 * Testes ponta a ponta.
 *
 * O que eles cobrem e as outras suítes não: o navegador de verdade. A suíte de
 * integração fala com o Fastify por `inject` e prova que a API responde certo —
 * ela não prova que a tela chama a API certa, que o cookie de sessão viaja,
 * que o formulário renderiza os campos que o schema descreve, ou que a resposta
 * digitada por uma pessoa chega ao painel.
 *
 * São poucos casos, e de propósito. E2e é caro e frágil; o que justifica cada
 * um aqui é ser um caminho que NENHUMA outra suíte consegue exercitar.
 *
 * Os dois servidores sobem pelo próprio Playwright. O web faz proxy de `/v1` e
 * `/f` para a API — a mesma configuração do desenvolvimento, e a mesma origem
 * que existirá em produção atrás do Caddy.
 */

const PORTA_WEB = 5174;
const PORTA_API = 3334;

export default defineConfig({
  testDir: './tests/e2e',
  // Remove os formulários que os casos criaram, pelo prefixo no título.
  globalTeardown: './tests/e2e/teardown.ts',
  // Um caso e2e que passa em 3 minutos está escondendo um problema.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Sem paralelismo: os casos compartilham o mesmo banco, e uma empresa criada
  // por um caso mudaria a contagem que o outro observa.
  fullyParallel: false,
  workers: 1,

  // Nenhuma retentativa. Um e2e que só passa na segunda tentativa está
  // escondendo uma corrida, e escondê-la é pior do que vê-la falhar.
  retries: 0,
  forbidOnly: Boolean(process.env['CI']),

  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORTA_WEB}`,
    // Rastro só do que falhou: gravar tudo deixa o CI lento e o artefato enorme.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // O ambiente já traz o Chromium; baixar outro é desperdício e uma
        // fonte de divergência entre máquinas.
        ...(process.env['PLAYWRIGHT_BROWSERS_PATH']
          ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } }
          : {}),
      },
    },
  ],

  webServer: [
    {
      command: `npm run dev -w @forms/api`,
      port: PORTA_API,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      // A API lê `API_PORT`, não `PORT`.
      env: { API_PORT: String(PORTA_API), NODE_ENV: 'test', LOG_LEVEL: 'error' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npm run dev -w @forms/web -- --port ${PORTA_WEB} --strictPort`,
      port: PORTA_WEB,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { VITE_API_PORT: String(PORTA_API) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
