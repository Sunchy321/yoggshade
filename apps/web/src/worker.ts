/** Workers 入口（ticket 10/14：站点上 Cloudflare Workers）。
 *
 * 形态：前端 = Workers Static Assets（vite build + assets/data 拷贝，scripts/build-worker.ts）；
 * /api/* = 本 Worker（run_worker_first），渲染进程内调用 `renderCard`（AssetSource =
 * 静态资产绑定预取的 mapSource，findings §5.2 方案 A）。
 *
 * 预取口径（ticket 14 答复确认）：**按请求派生**，不是预测性缓存——请求体/帧槽 →
 * 帧 JSON、纹理（材质 file 扫描 + 图集 ref + 双形态展开）、数据表、预设 fixture；
 * 文本字符集（输入 ∪ builder 解析闭集，构建期算死为 glyph-needed.json）× 字形目录 →
 * 字形键。派生漏键由 KeyMissingError → 补取 → 重跑兜底（渲染是纯函数，最多 4 轮）。
 *
 * 字形库（ticket 15 T1 后 1.3 万 PNG）：**不打散部署**（wrangler dev 对万级散文件
 * spawn EBADF，实测）——构建期拼成 pack/glyphs.bin + 索引（glyph-index.json），
 * Worker 首次触字形时整取一次（54 MB 瞬时、按索引切片拷贝所需、立即释放大缓冲，
 * glyphCache 8000 键上限）。TTF 不进部署包：字形 miss → TtfMissingError → 400
 * （fail-fast + 常用闭集覆盖；正式裁定见 ticket 15 Answer）。
 *
 * 限流（ticket 06 v1）：POST /api/render 每 IP 60s 窗口 RENDER_LIMIT 次（vars 可配，
 * 缺省 12），isolate 内滑动窗——跨 isolate 不共享，正式控制面 = WAF 速率规则。
 * 渲染按 isolate 串行排队（CPU 密集单线程本就串行；队列同时保证预算清空不与
 * 并发请求交错）。 */
import { createApi } from './api.js';
import { CARD_TYPE_TO_SLOT } from '@yoggraph/renderer/plan';
import { KeyMissingError, mapSource, type AssetSource } from '@yoggraph/renderer/source';
import type { RenderRequest } from './shared.js';
import assetManifest from './asset-manifest.json';
import glyphIndex from './glyph-index.json';
import glyphNeeded from './glyph-needed.json';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}
interface Env {
  ASSETS:        AssetsBinding;
  /** 每 IP 每分钟渲染上限（vars 配置；缺省 12） */
  RENDER_LIMIT?: string;
}

/** 构建期生成的已知键清单（pack/** + data/**；scripts/build-worker.ts 再生成）。 */
const KNOWN = new Set(assetManifest as string[]);
/** 字形索引：键 = 'glyphs/{dir}/{cp}.png'（assets/glyphs 相对路径，与 AssetSource 键同形），
 * 值 = [glyphs.bin 内偏移, 长度]。 */
const GLYPH_INDEX = glyphIndex as unknown as Record<string, [number, number]>;
const BYTES_BUDGET_PACK = 16 * 1024 * 1024; // 热帧纹理驻留上限（渲染队列轮次开头整体清空）
const GLYPH_CACHE_MAX_KEYS = 8000;

type Source = AssetSource & {
  prime(keys: readonly string[]): Promise<void>;
  /** 超预算时整体清空（只在渲染队列轮次开头调——workerd 的异步请求会交错，
   *  渲染中途清 Map 会把别的请求刚预取的键抹掉，表现为随机 KeyMissing）。
   *  返回是否清空——调用方据此重置「一次性全量」标志（水印/字形库），下轮重取。 */
  resetIfOverBudget(): boolean;
};

function makeSource(prefix: 'pack' | 'data', env: Env, origin: string): Source {
  const bytes = new Map<string, Uint8Array>();
  let total = 0;

  const source: Source = {
    text: k => {
      const b = bytes.get(k) ?? (prefix === 'pack' ? glyphCache.get(k) : undefined);
      if (b !== undefined) return new TextDecoder().decode(b);
      throw new KeyMissingError(k);
    },
    bytes: k => {
      const b = bytes.get(k) ?? (prefix === 'pack' ? glyphCache.get(k) : undefined);
      if (b !== undefined) return b;
      throw new KeyMissingError(k);
    },
    // 存在性：构建清单（常规资产）∪ 字形索引（pack/glyphs/**）
    has: k => KNOWN.has(`${prefix}/${k}`)
      || (prefix === 'pack' && k.startsWith('glyphs/') && k in GLYPH_INDEX),
    prime: async keys => {
      const todo = keys.filter(k => !bytes.has(k) && !(prefix === 'pack' && glyphCache.has(k))
        && (KNOWN.has(`${prefix}/${k}`) || (prefix === 'pack' && k.startsWith('glyphs/'))));
      // 分批并发（16 路）：数百键的全并发会压垮本地资产服务，且无吞吐收益
      for (let i = 0; i < todo.length; i += 16) {
        await Promise.all(todo.slice(i, i + 16).filter(k => !k.startsWith('glyphs/')).map(async k => {
          // 用请求自身 origin：本地 wrangler 的 ASSETS 绑定不吃假 host（生产同式可用）
          const res = await env.ASSETS.fetch(new Request(`${origin}/${prefix}/${k}`));
          if (!res.ok) throw new KeyMissingError(k);
          const buf = new Uint8Array(await res.arrayBuffer());
          bytes.set(k, buf);
          total += buf.byteLength;
        }));
      }
    },
    resetIfOverBudget: () => {
      if (prefix === 'pack' && total > BYTES_BUDGET_PACK) {
        bytes.clear();
        total = 0;
        return true;
      }
      return false;
    },
  };
  return source;
}

// ---- 字形库（glyphs.bin 整取一次 → 按索引切片 → glyphCache；超上限清空后下轮重取）----

const glyphCache = new Map<string, Uint8Array>();

async function ensureGlyphs(env: Env, origin: string, keys: readonly string[]): Promise<void> {
  const todo = keys.filter(k => !glyphCache.has(k) && k in GLYPH_INDEX);
  if (!todo.length) return;
  const res = await env.ASSETS.fetch(new Request(`${origin}/pack/glyphs.bin`));
  if (!res.ok) throw new KeyMissingError('pack/glyphs.bin');
  const bin = new Uint8Array(await res.arrayBuffer());
  for (const k of todo) {
    const [off, len] = GLYPH_INDEX[k]!;
    // 必须拷贝：视图会钉住 54 MB 的大缓冲，GC 无法释放
    glyphCache.set(k, bin.slice(off, off + len));
  }
  if (glyphCache.size > GLYPH_CACHE_MAX_KEYS) glyphCache.clear();
}

// ---- 键派生 ----

const FRAME_JSONS = [
  'manifest.json', 'frame_recon.json', 'meshes.json', 'portrait.json',
  'material_props.json', 'prefab_report.json', 'prefab_ubertext.json', 'curved.json',
];
const DATA_STATIC = [
  'tables.json',
  'card_meta/card_set_watermarks.json', 'card_meta/card_set_timings.json',
  'card_meta/card_watermark_overrides.json',
];
const STAT_CHARS = new Set('0123456789+');
const GLYPH_META_KEYS = Object.keys(GLYPH_INDEX).filter(k => k.endsWith('/meta.json'));
const BG_CARD_TYPES = new Set([40, 42, 43, 44]);

let watermarksPrimed = false;

/** 渲染前键派生（见模块头注释；漏键 → 重试网兜底）。 */
async function primeForRender(env: Env, origin: string, body: RenderRequest): Promise<void> {
  const { pack, data } = getRuntime(env, origin);
  const slot = CARD_TYPE_TO_SLOT[body.cardType] ?? 'hand-minion';
  const dataKeys = [...DATA_STATIC, 'fixtures/manifest.json'];
  if (body.presetId) dataKeys.push(`fixtures/${body.presetId}.json`);
  await data.prime(dataKeys);

  const packKeys = [
    'fontdefs.json', 'fonts/metrics.json',
    ...FRAME_JSONS.map(f => `frames/${slot}/${f}`),
    `portraits/${body.presetId ?? 'DIY'}.png`,
  ];
  await pack.prime(packKeys);

  // 帧纹理清单（frame manifest.textures：裸文件名 → 帧纹理目录）
  const fm = JSON.parse(pack.text(`frames/${slot}/manifest.json`)) as { textures?: string[] };
  const texKeys = (fm.textures ?? []).map(t => t.includes('/') ? t : `frames/${slot}/textures/${t}`);
  // 材质纹理（"file": "..." 全量扫描：prefab_report = 帧材质；frame_recon = 宝石/原画
  // 通道材质（plan.ts StatGem.main_tex_file 的来源）——两处都要扫）
  for (const j of ['prefab_report.json', 'frame_recon.json']) {
    const report = pack.text(`frames/${slot}/${j}`);
    for (const m of report.matchAll(/"file":\s*"([^"]+)"/g)) texKeys.push(m[1]!);
  }
  // 表驱动纹理：tables.json 全量 "file": "..." 扫描（factionIconSt 的阵营图标/横幅
  // Card_Inhand_Faction_Banner_* 等——此前只扫帧 JSON，这些键漏网）。
  const tablesText = data.text('tables.json');
  for (const m of tablesText.matchAll(/"file":\s*"([^"]+)"/g)) texKeys.push(m[1]!);
  // 类色图集 ref（tables.colorSwitcher 的 "Stem.tif:guid" → textures/Stem_guid8.png）
  const tables = JSON.parse(tablesText) as {
    colorSwitcher?: Record<string, Record<string, string>>;
    raceZh?:        Record<string, string>;
    schoolZh?:      Record<string, string>;
  };
  for (const family of Object.values(tables.colorSwitcher ?? {})) {
    for (const ref of Object.values(family)) {
      const [stem, guid] = ref.split(':');
      if (stem && guid) texKeys.push(`textures/${stem.replace(/\.tif$/, '')}_${guid.slice(0, 8)}.png`);
    }
  }
  // 双形态展开：同一纹理在包里可能以帧前缀与根两种形态存在（StatGem 主纹理 = 根形态，
  // 帧材质 = 帧前缀形态），两形态都试取（has 门控自动跳过不存在的）。Set 去重。
  const texCandidates = new Set<string>();
  for (const k of texKeys) {
    const norm = k.includes('/') ? k : `textures/${k}`;
    texCandidates.add(norm);
    texCandidates.add(`textures/${norm.split('/').pop()}`);
  }
  await pack.prime([...texCandidates]);

  // 水印目录一次性全量（resolveWatermark 的占位裁决只查 has，纹理键在编译后才可知）
  if (!watermarksPrimed) {
    await pack.prime([...KNOWN]
      .filter(k => k.startsWith('pack/watermarks/'))
      .map(k => k.slice('pack/'.length)));
    watermarksPrimed = true;
  }
  // 战棋模板 spell 视觉（小目录）：键在计划编译后才可知，直接全量。判据 = 战棋专属卡型
  // **或预设模板为 Battlegrounds**（战棋随从 = 卡型 4 + 模板 Battlegrounds，plan.ts:626
  // 消费；只按卡型判会漏 → BG34_Giant_072 的 tier-icon spell 纹理缺键）。
  let presetTemplate = '';
  if (body.presetId) {
    try {
      presetTemplate = (JSON.parse(data.text(`fixtures/${body.presetId}.json`)) as
        { preset?: { template?: string } }).preset?.template ?? '';
    } catch { /* 上一步已 prime，失败交给重试网 */ }
  }
  if (BG_CARD_TYPES.has(body.cardType) || presetTemplate === 'Battlegrounds') {
    await pack.prime([...KNOWN]
      .filter(k => k.startsWith('pack/spells/'))
      .map(k => k.slice('pack/'.length)));
  }

  // 字形：字符集 = 请求文本 ∪ 数字 ∪ 种族/学派中文名 ∪ builder 解析闭集（构建期
  // glyph-needed.json），目录 × 索引门控 → ensureGlyphs 按 bin 索引切片。
  // meta.json 一并入库（PackFontMetrics 构造器读它做 CharInfo/meta 门控）。
  const chars = new Set<string>(STAT_CHARS);
  for (const s of [body.name, body.text]) {
    for (const ch of (s ?? '').replace(/<\/?[bi]>/g, '')) chars.add(ch);
  }
  if (body.race) for (const ch of tables.raceZh?.[String(body.race)] ?? '') chars.add(ch);
  if (body.school !== undefined) {
    for (const ch of tables.schoolZh?.[String(body.school)] ?? '') chars.add(ch);
  }
  for (const cp of glyphNeeded as number[]) chars.add(String.fromCodePoint(cp));
  const glyphKeys: string[] = [];
  const dirs = new Set(GLYPH_META_KEYS.map(k => k.slice('glyphs/'.length).replace(/\/meta\.json$/, '')));
  for (const d of dirs) {
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      const key = `glyphs/${d}/${cp}.png`;
      if (key in GLYPH_INDEX) glyphKeys.push(key);
    }
    glyphKeys.push(`glyphs/${d}/meta.json`);
  }
  await ensureGlyphs(env, origin, glyphKeys);
}

async function primeForMeta(env: Env, origin: string): Promise<void> {
  const { data } = getRuntime(env, origin);
  const fixtureKeys = [...KNOWN]
    .filter(k => /^data\/fixtures\/[^/]+\.json$/.test(k))
    .map(k => k.slice('data/'.length));
  await data.prime([...DATA_STATIC, 'fixtures/manifest.json', ...fixtureKeys]);
}

// ---- 限流（ticket 06 v1；跨 isolate 不共享，正式控制面 = WAF 速率规则）----

const RENDER_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function allowRender(ip: string, limit: number): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter(t => now - t < RENDER_WINDOW_MS);
  if (arr.length >= limit) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.every(t => now - t >= RENDER_WINDOW_MS)) hits.delete(k);
  }
  return true;
}

// ---- 入口 ----

interface Runtime {
  pack: Source;
  data: Source;
  api:  ReturnType<typeof createApi>;
}

/** isolate 级单例：env 对象与站点 origin 在 isolate 存活期内稳定。 */
let runtime: Runtime | null = null;
function getRuntime(env: Env, origin: string): Runtime {
  if (!runtime) {
    const pack = makeSource('pack', env, origin);
    const data = makeSource('data', env, origin);
    runtime = { pack, data, api: createApi({ pack, data }) };
  }
  return runtime;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      if (url.pathname === '/api/render' && req.method === 'POST') {
        const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
        if (!allowRender(ip, Number(env.RENDER_LIMIT ?? 12))) {
          return Response.json({ error: '出图太频繁了，请稍等一分钟再试。' }, { status: 429 });
        }
        if ((Number(req.headers.get('content-length')) || 0) > 8_000_000) {
          return Response.json({ error: '请求体过大：原画请压到 1024×1024 以内再上传。' }, { status: 413 });
        }
        // 解析一次做键派生；重试时用同一文本重建 Request（body 流不可复用）。
        // 渲染按 isolate 串行排队：CPU 密集单线程本就串行；排队还保证「预算清空」
        // 只发生在队列轮次开头，不会抹掉并发请求刚预取的字节。
        const parsed = await req.json() as RenderRequest;
        const raw = JSON.stringify(parsed);
        const run = chain.then(async () => {
          if (getRuntime(env, url.origin).pack.resetIfOverBudget()) watermarksPrimed = false;
          await primeForRender(env, url.origin, parsed);
          return withRetry(env, url, raw);
        });
        chain = run.catch(() => {});
        // await 让外层 catch 罩住队列拒绝（直接 return run 会把异常逃逸成裸 500、无日志）
        return await run;
      }
      if (url.pathname === '/api/meta') {
        await primeForMeta(env, url.origin);
        return await withRetry(env, url);
      }
      const pm = /^\/api\/portrait\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (pm) {
        await getRuntime(env, url.origin).pack.prime([`portraits/${pm[1]}.png`]);
        return await withRetry(env, url);
      }
      return await getRuntime(env, url.origin).api.fetch(req);
    } catch (err) {
      if (err instanceof KeyMissingError) {
        // 派生完全没盖住的键（理论上不应发生）：补一次再回 500，错误可见不静默
        try {
          await getRuntime(env, url.origin).pack.prime([err.key]);
          await getRuntime(env, url.origin).data.prime([err.key]);
        } catch { /* ignore */ }
      }
      console.error('[worker] unhandled', err);
      return Response.json({ error: `服务内部错误：${(err as Error).message}` }, { status: 500 });
    }
  },
};

const RETRY_MAX = 4;
/** 渲染串行队列（isolate 内）；链上吞错保持存活。 */
let chain: Promise<unknown> = Promise.resolve();

async function withRetry(env: Env, url: URL, rawBody?: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const req = new Request(url, rawBody === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody });
      return await getRuntime(env, url.origin).api.fetch(req);
    } catch (err) {
      if (err instanceof KeyMissingError && attempt < RETRY_MAX) {
        const { pack, data } = getRuntime(env, url.origin);
        await Promise.allSettled([
          pack.prime([err.key]),
          data.prime([err.key]),
          ensureGlyphs(env, url.origin, [err.key]),
        ]);
        continue;
      }
      throw err;
    }
  }
}
