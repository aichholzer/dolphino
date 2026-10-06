import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } }
  },
  // The CSP refuses data: fonts; every font subset ships as its own file.
  build: { outDir: 'dist', assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) }
});
