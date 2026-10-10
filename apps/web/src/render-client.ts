/** 浏览器端渲染入口（ADR-0002：渲染链跑在用户浏览器，站点零后端计算面）。
 *
 * 资产 = 同源静态文件 /pack/** 与 /data/**（部署 = build-worker.ts 拷进 dist，由
 * Workers Static Assets 直发；dev = vite 中间件直供仓内 assets/ 与 data/）。
 * 预取 = collectRenderAssetKeys（@yoggraph/renderer/keys）按编译后计划枚举该卡的
 * 精确键集，固定点两轮收敛（spell overlay JSON 首轮未达则次轮展开其纹理）；
 * 此前的 prefab_report/frame_recon 全量 "file" 扫描是 202 文件/69.6MB 的超集
 * （实测 explore/2026-10-10-web-asset-perf/findings.md），已退役。
 * 漏键补取-重跑沿用 Worker 时代口径（原 worker.ts，2026-10-09 移植）；
 * FreeType wasm 经资产源取 pack/fonts/freetype.wasm 注入 wasmBinary。 */
import { renderCard } from '@yoggraph/renderer/render-card';
import { KeyMissingError, type AssetSource } from '@yoggraph/renderer/source';
import { slotForCardType, type FixtureCard } from '@yoggraph/renderer/plan';
import { collectRenderAssetKeys } from '@yoggraph/renderer/keys';
import { prepareCard } from './adapter.js';
import { loadMeta } from './meta.js';
import type { MetaResponse, RenderRequest } from './shared.js';
import assetManifest from './asset-manifest.json';
import freetypeWasmUrl from '@yoggraph/renderer/freetype-asset';

/** 构建期生成的已知键清单（pack/** + data/**；scripts/build-worker.ts 再生成）。 */
const KNOWN = new Set(assetManifest as string[]);
/** pack 预取驻留上限；超限整体清空（精确键集下单卡 ~15MB，正常会话不再触顶）。 */
const BYTES_BUDGET_PACK = 64 * 1024 * 1024;
const RETRY_MAX = 4;

/** 字节级别名：Belwe.ttf 与 Belwe_Outline.ttf 是同一份 TTF（提取产物逐字节相同，
 *  MD5 809c686a…；fontdefs.json 里两字体 zhcn font_object 均 5,664,616 字节、同族
 *  AR LisuGB——描边是渲染端效果不在这份字形数据里）。按键各取会白下 5.4MB：
 *  网络只取 canonical 一份，双键共享同一 Uint8Array。 */
const FONT_ALIAS: Record<string, string> = { 'fonts/Belwe_Outline.ttf': 'fonts/Belwe.ttf' };

type Source = AssetSource & {
  prime(keys: readonly string[]): Promise<void>;
  /** 直写预取缓存（不走 KNOWN 门控——非镜像来源的键，如 FreeType wasm） */
  put(key: string, bytes: Uint8Array): void;
  hasBytes(key: string): boolean;
  /** 超预算时整体清空；返回是否清空——调用方据此重置「一次性全量」标志。 */
  resetIfOverBudget(): boolean;
};

function makeSource(prefix: 'pack' | 'data'): Source {
  const bytes = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<void>>();
  let total = 0;

  const load = async (k: string): Promise<void> => {
    // 别名重定向：网络只取 canonical；两侧键共享同一份字节，预算只记一份
    const canonical = FONT_ALIAS[k] ?? k;
    const shared = canonical !== k ? bytes.get(canonical) : undefined;
    if (shared !== undefined) {
      bytes.set(k, shared);
      return;
    }
    const res = await fetch(`${prefix}/${canonical}`);
    // HTML 响应 = 静态层没命中、SPA 回退接了盘（dev 回退 index.html）——按缺键处理，
    // 不许把 HTML 字节塞进缓存让下游 JSON.parse 炸出难懂的错误
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || ct.includes('text/html')) throw new KeyMissingError(k);
    const buf = new Uint8Array(await res.arrayBuffer());
    bytes.set(k, buf);
    if (canonical !== k) bytes.set(canonical, buf);
    total += buf.byteLength;
  };

  const source: Source = {
    text: k => {
      const b = bytes.get(k);
      if (b !== undefined) return new TextDecoder().decode(b);
      throw new KeyMissingError(k);
    },
    bytes: k => {
      const b = bytes.get(k);
      if (b !== undefined) return b;
      throw new KeyMissingError(k);
    },
    // 存在性：构建清单（元数据级，不要求已预取——meta 枚举原画存在性走这里）
    has: k => KNOWN.has(`${prefix}/${k}`),
    put: (k, b) => {
      if (!bytes.has(k)) total += b.byteLength;
      bytes.set(k, b);
    },
    hasBytes: k => bytes.has(k),
    prime:    async keys => {
      const todo = keys.filter(k => !bytes.has(k) && KNOWN.has(`${prefix}/${k}`));
      // 分批并发（12 路）；同键去重靠 pending 表防并发请求重复取
      for (let i = 0; i < todo.length; i += 12) {
        await Promise.all(todo.slice(i, i + 12).map(async k => {
          let p = pending.get(k);
          if (!p) {
            p = load(k).finally(() => pending.delete(k));
            pending.set(k, p);
          }
          return p;
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

/** 标签页级单例：跨渲染复用预取字节（浏览器缓存之下再省一层重复解析）。 */
const dirs: { pack: Source, data: Source } = {
  pack: makeSource('pack'),
  data: makeSource('data'),
};

// ---- 预取（键派生移交 @yoggraph/renderer/keys，此处只管时序） ----

const FRAME_JSONS = [
  'manifest.json', 'frame_recon.json', 'meshes.json', 'portrait.json',
  'material_props.json', 'prefab_report.json', 'prefab_ubertext.json', 'curved.json',
];
const DATA_STATIC = [
  'tables.json',
  'card_meta/card_set_watermarks.json', 'card_meta/card_set_timings.json',
  'card_meta/card_watermark_overrides.json',
];

/** 渲染前预取：帧 JSON（收集器输入）→ 键集固定点两轮。data 静态表与 fixture 键
 *  由 renderOnce 在 prepareCard 之前 prime（adapter 读 fixtures/<preset>.json）。 */
async function primeForRender(fixture: FixtureCard): Promise<void> {
  // FreeType 后端二进制：直接经 vite 资产 URL 取（包内 dist/freetype.wasm），不进 /pack
  // 镜像——dev 中间件无需 mirror node_modules；?url 由打包器在 dev/build 下统一解析
  if (!dirs.pack.hasBytes('fonts/freetype.wasm')) {
    const bin = new Uint8Array(await (await fetch(freetypeWasmUrl)).arrayBuffer());
    dirs.pack.put('fonts/freetype.wasm', bin);
  }

  const slot = slotForCardType(fixture.tags);
  await dirs.pack.prime(['fontdefs.json', ...FRAME_JSONS.map(f => `frames/${slot}/${f}`)]);

  // 固定点：第二轮补 overlay JSON 就绪后才能枚举的纹理（首轮大多已收敛，二次
  // collect 只做纯 JSON 遍历，无网络）
  for (let round = 0; round < 2; round++) {
    const keys = collectRenderAssetKeys({ fixture }, dirs);
    await Promise.all([dirs.pack.prime(keys.pack), dirs.data.prime(keys.data)]);
  }
}

// ---- 渲染串行链（防并发渲染交错清预算） ----

let chain: Promise<unknown> = Promise.resolve();

export interface RenderResult {
  /** PNG blob URL（调用方负责 revoke） */
  url:  string;
  ms:   number;
  slot: string;
}

async function renderOnce(body: RenderRequest): Promise<RenderResult> {
  // 预算击穿即清空重来（精确键集下重取走浏览器 HTTP 缓存，代价可忽略）
  dirs.pack.resetIfOverBudget();
  const dataKeys = [...DATA_STATIC, 'fixtures/manifest.json'];
  if (body.presetId) dataKeys.push(`fixtures/${body.presetId}.json`);
  await dirs.data.prime(dataKeys);
  const { fixture, portrait } = prepareCard(body, dirs);
  await primeForRender(fixture);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await renderCard({ fixture, portrait }, dirs);
      const blob = new Blob([res.png], { type: 'image/png' });
      return { url: URL.createObjectURL(blob), ms: res.ms, slot: res.slot };
    } catch (err) {
      if (err instanceof KeyMissingError && attempt < RETRY_MAX) {
        await Promise.allSettled([
          dirs.pack.prime([err.key]),
          dirs.data.prime([err.key]),
        ]);
        continue;
      }
      throw err;
    }
  }
}

/** 渲染一张卡（串行排队；KeyMissing 自动补取重跑，最多 4 轮）。 */
export function renderClient(body: RenderRequest): Promise<RenderResult> {
  const run = chain.then(() => renderOnce(body));
  chain = run.catch(() => {});
  return run;
}

/** 表单枚举（预设/卡型/职业/…；数据源 = /data/**，原画存在性 = 构建清单）。 */
export async function loadMetaClient(): Promise<MetaResponse> {
  const fixtureKeys = [...KNOWN]
    .filter(k => /^data\/fixtures\/[^/]+\.json$/.test(k))
    .map(k => k.slice('data/'.length));
  await dirs.data.prime([...DATA_STATIC, 'fixtures/manifest.json', ...fixtureKeys]);
  return loadMeta(dirs);
}

export { CardRequestError } from './adapter.js';
