import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const releaseRepository = process.env.YUNQIAO_RELEASE_REPOSITORY || 'erik00000/yunqiao.me';
if (releaseRepository !== 'erik00000/yunqiao.me') throw new Error('维护版必须使用 erik00000/yunqiao.me GitHub 发布仓库');

export default defineConfig({
  root: path.resolve(__dirname, 'ui'),
  base: './',
  define: { __YUNQIAO_RELEASE_REPOSITORY__: JSON.stringify(releaseRepository) },
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
