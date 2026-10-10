/** 渲染入口（CLI 与站点共用）：把原 main.ts 的装配序列抽成函数，路径由 dirs 注入。
 *
 * 为什么要有这一层：站点（进程内调用）与 CLI（argv + 写盘）必须走**同一条**渲染序列——
 * 否则站点出图与 L2 验收锚点会分叉（ticket 09 的路径一致性判据 = 同一输入两条路径逐位一致）。
 *
 * 资产仍是文件系统路径（assets/、data/）。Workers/容器运行时的资产源抽象（AssetSource）见
 * explore/2026-10-08-diy-workers-port/findings.md §5，待 ticket 14（运行环境裁定）落地后再做。
 *
 * 取景锚是模块级状态（camera.ts）：renderCard 每次调用前重设，服务端顺序渲染即安全
 * （CLI 是逐卡进程；站点在单请求内独占一次调用）。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPack, loadSpellOverlay, TextureStore, walkWithKey } from './assets.js';
import { SIZE, setFrameAnchor } from './camera.js';
import {
  buildRenderList, rasterBucketZbuf, renderPortraitLayer, composeToRgba8, alphaPlane,
  renderGemsStage, rgbToRgba8, renderSpellOverlays,
} from './render.js';
import type { OverlayGemSource } from './gems.js';
import { encodePngBytes } from './image.js';
import {
  compilePlan, compileFramePlan, CARD_TYPE_TO_SLOT,
  type FixtureCard, type StaticTables, type WatermarkTables,
} from './plan.js';
import type { AssetPack, RenderPlan, RGBAImage } from './types.js';

export interface RenderDirs {
  /** 资产包根（assets/） */
  pack: string;
  /** 冻结数据根（data/） */
  data: string;
}

export type RenderStage = 'p0' | 'p1' | 'p2';

export interface RenderInput {
  fixture:      FixtureCard;
  /** 覆盖帧槽（缺省按 TAG 202 卡型推导；未知卡型回落随从帧） */
  slot?:        string;
  /** p0 = 帧+肖像；p1 = +宝石；p2 = +文字（默认，全链） */
  stage?:       RenderStage;
  /** 上传原画（内存注入，不落盘）：写进计划的原画写点，纹理直接从这份内存图取 */
  portrait?:    RGBAImage;
  /** 上传原画在计划里的键（缺省 portraits/{cardId}.png） */
  portraitKey?: string;
}

export interface RenderResult {
  png:         Uint8Array<ArrayBuffer>;
  slot:        string;
  stage:       RenderStage;
  tris:        number;
  frame_nodes: string[];
  ms:          number;
}

const dataCache = new Map<string, { tables: StaticTables, wmTables: WatermarkTables }>();

/** data/ 静态表（tables + 水印三表）。进程内缓存：站点逐请求用，tables 25 KiB、
 *  card_set_timings 1.66 MB，重读纯属浪费；CLI 一次性进程无影响。
 *  dev 下改了 data/ 想立即生效则调 clearStaticDataCache()。 */
export function loadStaticData(dirs: RenderDirs): { tables: StaticTables, wmTables: WatermarkTables } {
  const hit = dataCache.get(dirs.data);
  if (hit) return hit;
  const read = (rel: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dirs.data, rel), 'utf-8')) as Record<string, unknown>;
  const tables = read('tables.json') as unknown as StaticTables;
  // 卡集水印三表（scripts/extract_watermarks.py 产物；缺失即 fail-fast——数据缺口
  // 不能静默渲染成"无水印"）
  let wmTables: WatermarkTables;
  try {
    wmTables = {
      sets:      read('card_meta/card_set_watermarks.json').sets as WatermarkTables['sets'],
      timings:   read('card_meta/card_set_timings.json').timings as WatermarkTables['timings'],
      overrides: read('card_meta/card_watermark_overrides.json').overrides as WatermarkTables['overrides'],
    };
  } catch (err) {
    throw new Error(
      `[watermark] data/card_meta 三表缺失或不可读（uv run scripts/extract_watermarks.py）`,
      { cause: err });
  }
  const entry = { tables, wmTables };
  dataCache.set(dirs.data, entry);
  return entry;
}

export function clearStaticDataCache(): void {
  dataCache.clear();
}

/** 上传原画注入（ticket 03 findings §2.1 的写法 A：编译后覆写计划的原画写点）。
 *  计划编译期只在"资产包内存在该文件"时才写 _MainTex_runtime（plan.ts:575-579/815-817），
 *  自定义卡 id 没有对应文件 → 这里补写，并让 TextureStore 从内存取图。
 *  饰品帧的画窗不在 m_portraitMesh 上（plan.ts:818-833）：落 NonQuestObjects/Mesh slot0
 *  并置 second_tex_mask（窗内蒙版走 main×second 合成）。 */
export function setPortraitOverride(
  pack: AssetPack,
  plan: RenderPlan,
  key: string,
  img: RGBAImage,
  textures: TextureStore,
): void {
  const portraitIdx = pack.manifest.portrait_mat_idx ?? 0;
  const node = [...walkWithKey(pack.frameRecon.hierarchy)]
    .find(([n]) => n.mesh_stats && n.npz_key === pack.manifest.portrait_node_key);
  const comp = node ? plan.components.find(c => c.path === node[2]) : undefined;
  const slot = comp?.material_slots?.find(s => s.slot === portraitIdx);
  if (slot) {
    slot._MainTex_runtime = { file: key };
  } else if (pack.slot === 'hand-bg-trinket') {
    const artComp = plan.components.find(c => c.path.endsWith('/RootObject/NonQuestObjects/Mesh'));
    const artSlot = artComp?.material_slots?.find(s => s.slot === 0);
    if (!artSlot) throw new Error('hand-bg-trinket 原画写点缺失（NonQuestObjects/Mesh slot0）');
    artSlot._MainTex_runtime = { file: key };
    artSlot.second_tex_mask = true;
  } else {
    throw new Error(`帧 ${pack.slot}: 原画写点缺失（portrait_mat_idx=${portraitIdx}）`);
  }
  textures.set(key, img);
}

/** 编译好的 pack + plan → RGBA8。帧光栅 / 肖像 / 战棋 spell 视觉 / 晚通道 / 宝石 / 文字。 */
export async function renderPackToRgba8(
  pack: AssetPack,
  textures: TextureStore,
  plan: RenderPlan,
  dirs: RenderDirs,
  stage: RenderStage,
): Promise<{ rgba8: Uint8Array, tris: number, frame_nodes: string[] }> {
  const W = SIZE[0], H = SIZE[1];
  const lateNames = new Set(plan.late_nodes ?? []);
  const frameNodes = buildRenderList(pack.frameRecon.hierarchy, plan, lateNames);
  const canvas = new Float64Array(W * H * 4);
  const zbuf = new Float64Array(W * H).fill(-Infinity);

  const nTris = rasterBucketZbuf(frameNodes, pack, textures, canvas, zbuf);
  renderPortraitLayer(pack, textures, canvas, zbuf);
  // 战棋模板 spell 视觉（coin / tavern-tier）：SpellTable 预制与帧同管线、同 zbuf
  const overlayPacks = (plan.spell_overlays ?? []).map(o => loadSpellOverlay(dirs.pack, o.key));
  renderSpellOverlays(overlayPacks, plan, textures, canvas, zbuf);
  // coin 的 Gem_Health 是宝石 shader 家族（DiffuseAlphaMaskScroller）→ 走 gems 阶段公式
  // （与 stat gem 同源；普通 unlit 光栅会丢 clouds×_tint 项——实测铸币被染成 _Color 绿）。
  // 收集必须在 renderSpellOverlays 之后：alt-cost 锚定会平移 overlay 层级。
  const overlayGems: OverlayGemSource = { packs: overlayPacks, gems: [] };
  for (const ov of overlayPacks) {
    for (const [n, key, path] of walkWithKey(ov.hierarchy)) {
      if ((n.name !== 'Gem_Health' && n.name !== 'Gem_Coin') || !n.mesh_stats
        || n.active_in_hierarchy === false) continue;
      const mat = n.renderers?.[0]?.materials?.[0];
      if (!mat) continue;
      overlayGems.gems.push({
        node:          n.name, path, npz_key:       key, overlay:       ov.key,
        main_tex_file: mat.tex?.['_MainTex']?.texture?.file ?? '',
        tint_rgb:      (mat.colors?.['_tint'] ?? [1, 1, 1, 1]).slice(0, 3),
        intensity:     mat.floats?.['_Intensity'] ?? 1.0,
        speed_xy:      [mat.floats?.['_XSpeed'] ?? 5.0, mat.floats?.['_YSpeed'] ?? 0.2],
        scale_xy:      [mat.floats?.['_ScaleX'] ?? 1.0, mat.floats?.['_ScaleY'] ?? 1.0],
      });
    }
  }

  // 晚通道：运行时激活的覆盖层（如饰品徽章子树）按激活序合成，每节点独立深度缓冲
  for (const name of plan.late_nodes ?? []) {
    const passNodes = buildRenderList(
      pack.frameRecon.hierarchy, plan, lateNames, new Set([name]));
    const nodeZbuf = new Float64Array(W * H).fill(-Infinity); // 激活序合成：不与兄弟互 z
    rasterBucketZbuf(passNodes, pack, textures, canvas, nodeZbuf);
  }

  let rgba8: Uint8Array;
  if (stage === 'p0') {
    rgba8 = composeToRgba8(canvas);
  } else {
    // 透明背景：宝石/文字阶段只消费直感 RGB，覆盖率平面随之并行累加（凸出卡框的
    // 宝石/数字的覆盖也在卡框轮廓外），末尾与 RGB 拼合输出
    const alpha = alphaPlane(canvas);
    const rgb = renderGemsStage(canvas, pack, textures, overlayGems, alpha);
    if (stage === 'p2') {
      const { renderTextStage } = await import('./textstage.js');
      await renderTextStage(rgb, pack, alpha);
    }
    rgba8 = rgbToRgba8(rgb, alpha);
  }
  return { rgba8, tris: nTris, frame_nodes: frameNodes.map(n => n.name) };
}

/** fixture → PNG（单卡全链）。CLI 与站点唯一入口。 */
export async function renderCard(input: RenderInput, dirs: RenderDirs): Promise<RenderResult> {
  const t0 = Date.now();
  const stage = input.stage ?? 'p2';
  const { tables, wmTables } = loadStaticData(dirs);
  // 卡型 → 手牌帧 slot（TAG_CARDTYPE；actor_names.csv/ActorNames.cs）；未知卡型回落随从帧
  const slot = input.slot ?? CARD_TYPE_TO_SLOT[input.fixture.tags['202'] ?? 4] ?? 'hand-minion';
  const pack = loadPack(dirs.pack, slot);
  pack.plan = pack.prefabReport
    ? compileFramePlan(input.fixture, tables, pack, dirs.pack, slot, wmTables)
    : compilePlan(input.fixture, tables, pack, dirs.pack);
  // 取景锚（exporter FrameCamera 主体网格中心口径；camera.ts 同源注释）：渲染前设置，
  // 本进程内所有投影（网格/肖像/overlay/宝石/文字）统一跟随。
  const fc = pack.plan.frame_center;
  if (fc) setFrameAnchor(fc[0], fc[1]);

  const textures = new TextureStore(dirs.pack);
  if (input.portrait) {
    setPortraitOverride(
      pack, pack.plan, input.portraitKey ?? `portraits/${input.fixture.cardId}.png`,
      input.portrait, textures,
    );
  }

  const { rgba8, tris, frame_nodes } = await renderPackToRgba8(pack, textures, pack.plan, dirs, stage);
  return {
    png: encodePngBytes(SIZE[0], SIZE[1], rgba8),
    slot, stage, tris, frame_nodes,
    ms:  Date.now() - t0,
  };
}
