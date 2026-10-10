/** 站点 API 的 Bun 壳（本地 dev / VPS 用）。路由在 api.ts（运行时无关）；
 *  Workers 入口 = worker.ts（注入预取 mapSource）。 */
import { join, resolve } from 'node:path';
import { fsSource } from '@yoggraph/renderer/source';
import { createApi } from './api.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const PACK_DIR = process.env.YOGGRAPH_PACK ?? join(repoRoot, 'assets');
const DATA_DIR = process.env.YOGGRAPH_DATA ?? join(repoRoot, 'data');
const PORT = Number(process.env.PORT ?? 8787);

export const api = createApi({ pack: fsSource(PACK_DIR), data: fsSource(DATA_DIR) });

export function startApi(port = PORT): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ port, fetch: api.fetch, idleTimeout: 120 });
  console.log(`[api] ${server.url}  pack=${PACK_DIR}  data=${DATA_DIR}`);
  return server;
}

if (import.meta.main) startApi();
