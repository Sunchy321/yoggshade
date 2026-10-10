/** 开发服务器：API（本进程）+ Vite（子进程，HMR），单命令单入口（5173）。
 *  Vite 把 /api 反代到本进程的 API 端口（见 vite.config.ts），前端同源无 CORS 问题。 */
import { resolve } from 'node:path';
import { startApi } from './server.js';

const webRoot = resolve(import.meta.dir, '..');
const vitePort = Number(process.env.VITE_PORT ?? 5173);

const api = startApi();
// 本机开发必须绕过 http_proxy：环境里若设了 http_proxy（如 127.0.0.1:7890 的本地代理），
// Vite 的 /api 反代与 API 自身的本地请求会被劫持成 502。这里只影响子进程环境。
const NO_PROXY = 'localhost,127.0.0.1,::1';
const vite = Bun.spawn(['bunx', 'vite', '--port', String(vitePort), '--strictPort'], {
  cwd:   webRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  env:   { ...process.env, NO_PROXY, no_proxy: NO_PROXY },
});

console.log(`\n  站点： http://localhost:${vitePort}\n  API ： ${api.url}\n`);

const shutdown = (): void => {
  vite.kill();
  api.stop(true);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await vite.exited;
