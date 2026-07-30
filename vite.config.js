import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: run `vercel dev` (serves both /api/* functions and this Vite
// app together on one port) — that's the only way to exercise the API
// functions locally, since they're Vercel Serverless Functions, not an
// Express app. Plain `npm run dev` still works for pure UI iteration, with
// /api requests proxied to `vercel dev` running separately on :3000.
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
