import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };
// vite build --mode coverage keeps the bundle readable and inlines source maps with absolute
// source paths. Browser coverage maps through them; production builds use the default mode.
const coverage = {
  minify: false,
  sourcemap: 'inline',
  rollupOptions: { output: { sourcemapPathTransform: (source, map) => resolve(dirname(map), source) } }
};
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // The sidebar shows the release version; only this field reaches the bundle.
  define: { 'import.meta.env.DOLPHINO_VERSION': JSON.stringify(pkg.version) },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } }
  },
  // The CSP refuses data: fonts; every font subset ships as its own file.
  build: {
    outDir: 'dist',
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    ...(mode === 'coverage' ? coverage : {})
  }
}));
