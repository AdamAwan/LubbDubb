import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The SPA lives in web/ and builds to web/dist, which the Fastify server serves
// in production. In dev, `npm run web:dev` proxies /api and /ws to the server.
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4300',
      '/ws': { target: 'ws://localhost:4300', ws: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
