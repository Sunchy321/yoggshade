/** 浏览器端渲染入口（ADR-0002：渲染链跑在用户浏览器，站点零后端计算面）。
 *
 * 资产 = 同源静态文件 /pack/** 与 /data/**（部署 = build-worker.ts 拷进 dist，由
 * Workers Static Assets 直发；dev = vite 中间件直供仓内 assets/ 与 data/）。
 * 键派生与「漏键补取-重跑」沿用 Worker 时代口径（原 worker.ts，2026-10-09 移植）；
 * FreeType wasm 经资产源取 pack/fonts/freetype.wasm 注入 wasmBinary——浏览器是
 * emscripten 的一等环境，无需任何胶水补丁。 */
import { renderCard } from '@yoggraph/renderer/render-card';
import { KeyMissingError, type AssetSource } from '@yoggraph/renderer/source';
import { CARD_TYPE_TO_SLOT } from '@yoggraph/renderer/plan';
import { prepareCard } from './adapter.js';
import { BG_CARD_TYPES, loadMeta } from './meta.js';
import type { MetaResponse, RenderRequest } from './shared.js';
import assetManifest from './asset-manifest.json';
import freetypeWasmUrl from '@yoggraph/renderer/freetype-asset';

/** 构建期生成的已知键清单（pack/** + data/**；scripts/build-worker.ts 再生成）。 */
const KNOWN = new Set(assetManifest as string[]);
/** pack 预取驻留上限；超限整体清空（浏览器标签页内存比 worker isolate 宽裕，放宽）。 */
const BYTES_BUDGET_PACK = 64 * 1024 * 1024;
const RETRY_MAX = 4;

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
    const res = await fetch(`${prefix}/${k}`);
    // HTML 响应 = 静态层没命中、SPA 回退接了盘（dev 回退 index.html）——按缺键处理，
    // 不许把 HTML 字节塞进缓存让下游 JSON.parse 炸出难懂的错误
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || ct.includes('text/html')) throw new KeyMissingError(k);
    const buf = new Uint8Array(await res.arrayBuffer());
    bytes.set(k, buf);
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

// ---- 键派生（原 worker.ts 口径） ----

const FRAME_JSONS = [
  'manifest.json', 'frame_recon.json', 'meshes.json', 'portrait.json',
  'material_props.json', 'prefab_report.json', 'prefab_ubertext.json', 'curved.json',
];
const DATA_STATIC = [
  'tables.json',
  'card_meta/card_set_watermarks.json', 'card_meta/card_set_timings.json',
  'card_meta/card_watermark_overrides.json',
];

let watermarksPrimed = false;

/** 渲染前键派生（漏键 → withRetry 补取兜底）。 */
async function primeForRender(body: RenderRequest): Promise<void> {
  const slot = CARD_TYPE_TO_SLOT[body.cardType] ?? 'hand-minion';
  const dataKeys = [...DATA_STATIC, 'fixtures/manifest.json'];
  if (body.presetId) dataKeys.push(`fixtures/${body.presetId}.json`);
  await dirs.data.prime(dataKeys);

  // FreeType 后端二进制：直接经 vite 资产 URL 取（包内 dist/freetype.wasm），不进 /pack
  // 镜像——dev 中间件无需 mirror node_modules；?url 由打包器在 dev/build 下统一解析
  if (!dirs.pack.hasBytes('fonts/freetype.wasm')) {
    const bin = new Uint8Array(await (await fetch(freetypeWasmUrl)).arrayBuffer());
    dirs.pack.put('fonts/freetype.wasm', bin);
  }

  const fontKeys = [...KNOWN]
    .filter(k => k.startsWith('pack/fonts/') && k.endsWith('.ttf'))
    .map(k => k.slice('pack/'.length));
  const packKeys = [
    'fontdefs.json',
    ...fontKeys,
    ...FRAME_JSONS.map(f => `frames/${slot}/${f}`),
    `portraits/${body.presetId ?? 'DIY'}.png`,
  ];
  await dirs.pack.prime(packKeys);

  // 帧纹理清单（frame manifest.textures：裸文件名 → 帧纹理目录）
  const fm = JSON.parse(dirs.pack.text(`frames/${slot}/manifest.json`)) as { textures?: string[] };
  const texKeys = (fm.textures ?? []).map(t => t.includes('/') ? t : `frames/${slot}/textures/${t}`);
  // 材质纹理（"file": "..." 全量扫描：prefab_report = 帧材质；frame_recon = 宝石/原画通道材质）
  for (const j of ['prefab_report.json', 'frame_recon.json']) {
    const report = dirs.pack.text(`frames/${slot}/${j}`);
    for (const m of report.matchAll(/"file":\s*"([^"]+)"/g)) texKeys.push(m[1]!);
  }
  // 表驱动纹理：tables.json 全量 "file": "..." 扫描（阵营图标/横幅等）
  const tablesText = dirs.data.text('tables.json');
  for (const m of tablesText.matchAll(/"file":\s*"([^"]+)"/g)) texKeys.push(m[1]!);
  // 类色图集 ref（tables.colorSwitcher 的 "Stem.tif:guid" → textures/Stem_guid8.png）
  const tables = JSON.parse(tablesText) as {
    colorSwitcher?: Record<string, Record<string, string>>;
  };
  for (const family of Object.values(tables.colorSwitcher ?? {})) {
    for (const ref of Object.values(family)) {
      const [stem, guid] = ref.split(':');
      if (stem && guid) texKeys.push(`textures/${stem.replace(/\.tif$/, '')}_${guid.slice(0, 8)}.png`);
    }
  }
  // 双形态展开：帧前缀与根两形态都试取（has 门控自动跳过不存在的）。Set 去重。
  const texCandidates = new Set<string>();
  for (const k of texKeys) {
    const norm = k.includes('/') ? k : `textures/${k}`;
    texCandidates.add(norm);
    texCandidates.add(`textures/${norm.split('/').pop()}`);
  }
  await dirs.pack.prime([...texCandidates]);

  // 水印目录一次性全量（resolveWatermark 的占位裁决只查 has，纹理键在编译后才可知）
  if (!watermarksPrimed) {
    await dirs.pack.prime([...KNOWN]
      .filter(k => k.startsWith('pack/watermarks/'))
      .map(k => k.slice('pack/'.length)));
    watermarksPrimed = true;
  }
  // 战棋模板 spell 视觉（小目录）：战棋专属卡型**或预设模板为 Battlegrounds** 都要
  let presetTemplate = '';
  if (body.presetId) {
    try {
      presetTemplate = (JSON.parse(dirs.data.text(`fixtures/${body.presetId}.json`)) as
        { preset?: { template?: string } }).preset?.template ?? '';
    } catch { /* 上一步已 prime，失败交给重试网 */ }
  }
  if (BG_CARD_TYPES.has(body.cardType) || presetTemplate === 'Battlegrounds') {
    await dirs.pack.prime([...KNOWN]
      .filter(k => k.startsWith('pack/spells/'))
      .map(k => k.slice('pack/'.length)));
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
  if (dirs.pack.resetIfOverBudget()) watermarksPrimed = false;
  await primeForRender(body);
  for (let attempt = 0; ; attempt++) {
    try {
      const { fixture, portrait } = prepareCard(body, dirs);
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
