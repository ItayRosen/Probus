import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: here,
  build: {
    outDir: path.resolve(here, '..', 'dist', 'web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
    // In dev mode, proxy /api to the backend so SSE & POSTs work.
    proxy: {
      '/api': {
        target: process.env.PROBUS_BACKEND ?? 'http://127.0.0.1:9091',
        changeOrigin: false,
        ws: false,
      },
    },
  },
});
