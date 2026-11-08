/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The browser reuses the module's pure engine (spacetime/src/propagation.ts) for
  // non-authoritative previews, so allow serving files from the repo root.
  server: { port: 5173, fs: { allow: ['..'] } },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          spacetimedb: ['spacetimedb'],
          charts: ['recharts'],
          graph: ['@xyflow/react'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/tests/setup.ts'],
  },
});
