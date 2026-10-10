import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件路径 = apps/web/vite.config.ts → 上两级 = 仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png':  'image/png',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.wasm': 'application/wasm',
  '.bin':  'application/octet-stream',
};

/** dev 直供仓内资产树（ADR-0002：浏览器渲染直接取 /pack/** 与 /data/**）。
 *  部署态由 scripts/build-worker.ts 把 assets/ 与 data/ 拷进 dist/ 交给静态托管。
 *  freetype.wasm 不走这里——render-client 经 vite ?url 资产导入直接从包内取。
 *  connect 的 use(prefix) 会剥掉前缀——处理器里的 req.url 是前缀后的相对路径。 */
function repoAssets(): Plugin {
  const serve = (root: string): Connect.NextHandleFunction => (req, res, next) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]!);
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(resolve(root) + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      return next();
    }
    res.setHeader('Content-Type', MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'repo-assets',
    configureServer(server) {
      server.middlewares.use('/pack', serve(join(repoRoot, 'assets')));
      server.middlewares.use('/data', serve(join(repoRoot, 'data')));
    },
  };
}

export default defineConfig({
  plugins: [react(), repoAssets()],
  server:  { port: 5173 },
  build:   { outDir: 'dist' },
});
