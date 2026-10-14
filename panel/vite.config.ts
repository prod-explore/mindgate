import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The hub serves the built panel under /admin/ (next to /admin/api), so every asset URL starts there.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // no inline polyfill script: the hub sends a Content-Security-Policy that allows scripts from its own origin only
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    // `npm run dev` here, the hub on :3000 (`cd ../gate && npm run dev`)
    proxy: { '/admin/api': { target: process.env['MINDGATE_URL'] ?? 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
