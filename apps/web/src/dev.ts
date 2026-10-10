/** 开发服务器：Vite 单进程（ADR-0002 前端渲染后无 API 进程）。
 *  /pack、/data 由 vite 中间件直供仓内 assets/ 与 data/（见 vite.config.ts）。 */
import { resolve } from 'node:path';

const webRoot = resolve(import.meta.dir, '..');
const vitePort = Number(process.env.VITE_PORT ?? 5173);

// 本机开发必须绕过 http_proxy：环境里若设了 http_proxy（如本地代理），Vite 页面内的
// /pack、/data 预取会被劫持成 502。这里只影响子进程环境。
const NO_PROXY = 'localhost,127.0.0.1,::1';
const vite = Bun.spawn(['bunx', 'vite', '--port', String(vitePort), '--strictPort'], {
  cwd:   webRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  env:   { ...process.env, NO_PROXY, no_proxy: NO_PROXY },
});

console.log(`\n  站点： http://localhost:${vitePort}\n`);

const shutdown = (): void => {
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await vite.exited;
