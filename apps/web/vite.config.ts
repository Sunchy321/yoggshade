import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 开发期 /api 反代到本机 API 进程（dev.ts 用同一端口常量启动）。 */
export default defineConfig({
  plugins: [react()],
  server:  {
    port:  5173,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 8787}`,
    },
  },
  build: { outDir: 'dist' },
});
