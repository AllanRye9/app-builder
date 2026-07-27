import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api during local `vite dev` to the Express server on :3000,
// so the React app can be developed with hot reload without Docker.
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
