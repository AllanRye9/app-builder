import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api during local `vite dev` to the FastAPI server on :8000
// (app/main.py, or `PORT` if you've overridden it), so the React app can
// be developed with hot reload without Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
