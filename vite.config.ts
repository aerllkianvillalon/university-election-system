import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  // The app talks to the API on the same origin (cookies are SameSite=Strict). In dev and preview that means proxying /api.
  const proxy = { '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: false } };
  return {
    plugins: [react()],
    server: { host: '0.0.0.0', port: 3000, strictPort: true, proxy },
    preview: { host: '0.0.0.0', port: 3000, strictPort: true, proxy },
    build: { modulePreload: { polyfill: false } },
  };
});
