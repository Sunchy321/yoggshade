/** 站点 API 路由（运行时无关；Bun 壳 = server.ts，Workers 入口 = worker.ts）。
 *
 * 渲染在当前运行时**进程内**调用 `packages/renderer`（用户 2026-10-08 裁定：不实现协议 v1）。
 * 站点与渲染器共用同一条链（`renderCard`），所以站点出图与 L2 验收锚点不会分叉——
 * 路径一致性判据见 ticket 09。
 *
 * 资产（assets/）与冻结数据（data/）**只在服务端**：本进程不向浏览器暴露任何资产文件；
 * 唯一例外是预设原画预览（`GET /api/portrait/:cardId`，即用户"这张卡自带的画"，与出图同源）。 */
import { Hono } from 'hono';
import { renderCard } from '@yoggraph/renderer/render-card';
import { KeyMissingError, type AssetSource } from '@yoggraph/renderer/source';
import { CardRequestError, prepareCard } from './adapter.js';
import { loadMeta } from './meta.js';
import type { RenderRequest } from './shared.js';

export type Dirs = { pack: AssetSource, data: AssetSource };

/** 路由工厂：Bun 与 Workers 各自注入 AssetSource（CLI/本地 = fsSource，Workers = 预取 mapSource）。 */
export function createApi(dirs: Dirs): Hono {
  const api = new Hono();

  // Hono 默认把处理函数抛出的异常吞成 500 纯文本响应——Workers 入口的补取-重跑网
  // （withRetry 捕获 KeyMissingError）因此收不到异常、静默失效（表现为「派生漏键 →
  // 裸 500 且无日志」，2026-10-09 排查钉死）。重抛让错误穿透到入口的 catch。
  api.onError(err => {
    throw err;
  });

  api.get('/api/health', c => c.json({ ok: true }));

  api.get('/api/meta', c => {
    try {
      return c.json(loadMeta(dirs));
    } catch (err) {
      console.error('[meta] 装载失败', err);
      return c.json({ error: `枚举数据装载失败：${(err as Error).message}` }, 500);
    }
  });

  /** 预设自带原画（预览用）。不出资产目录清单，只按 cardId 精确取。 */
  api.get('/api/portrait/:cardId', c => {
    const cardId = c.req.param('cardId');
    if (!/^[A-Za-z0-9_]+$/.test(cardId)) return c.notFound();
    const key = `portraits/${cardId}.png`;
    if (!dirs.pack.has(key)) return c.notFound();
    const png = dirs.pack.bytes(key);
    return c.body(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 200, {
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
      const { fixture, portrait } = prepareCard(body, dirs);
      const res = await renderCard({ fixture, portrait }, dirs);
      return c.body(res.png.buffer.slice(res.png.byteOffset, res.png.byteOffset + res.png.byteLength) as ArrayBuffer, 200, {
        'Content-Type':  'image/png',
        'Cache-Control': 'no-store',
        'X-Render-Ms':   String(res.ms),
        'X-Render-Slot': res.slot,
      });
    } catch (err) {
      if (err instanceof CardRequestError) return c.json({ error: err.message }, 400);
      // 预取漏键：重抛给入口的补取-重跑网（worker.ts withRetry）——吞掉会让重试网失效
      if (err instanceof KeyMissingError) throw err;
      // 字形 miss 且字体不在源内（Workers 无 TTF，ticket 14/15）：按用户输入错误处理（400），
      // 不泄漏资产拓扑，也不许一次 fallback parse 撑爆 isolate 内存预算
      if (err instanceof Error && err.name === 'TtfMissingError') {
        const ch = (err as Error & { char?: string }).char;
        console.error('[render] TTF missing:', (err as Error).message);
        return c.json({ error: `卡牌文字包含暂不支持的字（${ch ?? '特殊字符'}），请改用常见汉字/字母/数字。` }, 400);
      }
      console.error('[render] 渲染失败', err);
      return c.json({ error: `渲染失败：${(err as Error).message}` }, 500);
    }
  });

  return api;
}
