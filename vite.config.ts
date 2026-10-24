import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Forward /api/* to the FastAPI server during development.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
