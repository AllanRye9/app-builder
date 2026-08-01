import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: run `npm start` in a second terminal (starts server/index.js,
// the real Express server, on :3000) — /api requests from the Vite dev
// server here are proxied straight to it. `npm run dev` alone is fine for
// pure UI iteration without a working backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
