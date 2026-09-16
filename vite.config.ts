import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], state: ['mobx', 'mobx-react-lite', '@tanstack/react-query'], forms: ['react-hook-form', 'zod', '@hookform/resolvers'] } } },
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: { host: '127.0.0.1' },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
    },
  },
  test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', css: true },
});
