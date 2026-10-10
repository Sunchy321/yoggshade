/** 站点 API（Bun 运行时；Worker/容器化见 ticket 14）。
 *
 * 渲染在当前运行时**进程内**调用 `packages/renderer`（用户 2026-10-08 裁定：不实现协议 v1）。
 * 站点与渲染器共用同一条链（`renderCard`），所以站点出图与 L2 验收锚点不会分叉——
 * 路径一致性判据见 ticket 09。
 *
 * 资产（assets/）与冻结数据（data/）**只在服务端**：本进程不向浏览器暴露任何资产文件；
 * 唯一例外是预设原画预览（`GET /api/portrait/:cardId`，即用户"这张卡自带的画"，与出图同源）。 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { renderCard } from '@yoggraph/renderer/render-card';
import { CardRequestError, prepareCard } from './adapter.js';
import { loadMeta } from './meta.js';
import type { RenderRequest } from './shared.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const DIRS = {
  pack: process.env.YOGGRAPH_PACK ?? join(repoRoot, 'assets'),
  data: process.env.YOGGRAPH_DATA ?? join(repoRoot, 'data'),
};
const PORT = Number(process.env.PORT ?? 8787);

export const api = new Hono();

api.get('/api/health', c => c.json({ ok: true, pack: DIRS.pack, data: DIRS.data }));

api.get('/api/meta', c => {
  try {
    return c.json(loadMeta(DIRS));
  } catch (err) {
    console.error('[meta] 装载失败', err);
    return c.json({ error: `枚举数据装载失败：${(err as Error).message}` }, 500);
  }
});

/** 预设自带原画（预览用）。不出资产目录清单，只按 cardId 精确取。 */
api.get('/api/portrait/:cardId', c => {
  const cardId = c.req.param('cardId');
  if (!/^[A-Za-z0-9_]+$/.test(cardId)) return c.notFound();
  const file = join(DIRS.pack, 'portraits', `${cardId}.png`);
  if (!existsSync(file)) return c.notFound();
  return c.body(Bun.file(file).stream(), 200, {
    'Content-Type':  'image/png',
    'Cache-Control': 'public, max-age=3600',
  });
});

api.post('/api/render', async c => {
  let body: RenderRequest;
  try {
    body = await c.req.json<RenderRequest>();
  } catch {
    return c.json({ error: '请求体不是合法 JSON' }, 400);
  }
  try {
    const { fixture, portrait } = prepareCard(body, DIRS);
    const res = await renderCard({ fixture, portrait }, DIRS);
    return c.body(res.png, 200, {
      'Content-Type':  'image/png',
      'Cache-Control': 'no-store',
      'X-Render-Ms':   String(res.ms),
      'X-Render-Slot': res.slot,
    });
  } catch (err) {
    if (err instanceof CardRequestError) return c.json({ error: err.message }, 400);
    console.error('[render] 渲染失败', err);
    return c.json({ error: `渲染失败：${(err as Error).message}` }, 500);
  }
});

export function startApi(port = PORT): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ port, fetch: api.fetch, idleTimeout: 120 });
  console.log(`[api] ${server.url}  pack=${DIRS.pack}  data=${DIRS.data}`);
  return server;
}

if (import.meta.main) startApi();
