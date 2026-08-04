import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // A API roda em outra porta em desenvolvimento. O proxy evita CORS aqui e
    // faz o cookie de refresh (Path=/v1/auth) viajar como se fosse mesma
    // origem — que é como será em produção, atrás do Caddy.
    proxy: {
      '/v1': { target: 'http://localhost:3333', changeOrigin: true },
      '/f': { target: 'http://localhost:3333', changeOrigin: true },
      '/health': { target: 'http://localhost:3333', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
