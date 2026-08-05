import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configurável para que os testes e2e possam subir a API numa porta própria,
// sem colidir com um servidor de desenvolvimento já aberto.
const alvoDaApi = `http://localhost:${process.env['VITE_API_PORT'] ?? '3333'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // A API roda em outra porta em desenvolvimento. O proxy evita CORS aqui e
    // faz o cookie de refresh (Path=/v1/auth) viajar como se fosse mesma
    // origem — que é como será em produção, atrás do Caddy.
    proxy: {
      '/v1': { target: alvoDaApi, changeOrigin: true },
      '/f': {
        target: alvoDaApi,
        changeOrigin: true,
        // A rota `/f/:slug` tem dois consumidores: o NAVEGADOR, que quer a
        // página, e a SPA, que busca o JSON do formulário. Em produção quem
        // separa os dois é o `Accept` — a API devolve o shell com as meta tags
        // para quem pede HTML.
        //
        // Em desenvolvimento isso não serve: o shell da API referencia os
        // assets do build, que não existem enquanto o Vite está servindo. Aqui,
        // navegação vai para o index do Vite e só o fetch atravessa o proxy.
        bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
      },
      '/health': { target: alvoDaApi, changeOrigin: true },
      // A área de administração tem prefixo próprio e também precisa do proxy.
      '/admin': { target: alvoDaApi, changeOrigin: true },
      '/api': { target: alvoDaApi, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
