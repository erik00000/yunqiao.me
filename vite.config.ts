import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'ui'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'ui/src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
