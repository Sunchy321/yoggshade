/** 渲染 CLI：
 *  bun src/main.ts [packDir] [outPng] [stage]           —— 资产包内嵌 plan（EX1_350 基线）
 *  bun src/main.ts --card CARD_ID [--out out.png]       —— fixture 卡编译渲染（data/fixtures + data/tables）
 * stage: p0 = 帧+肖像；p1 = +宝石；p2 = +文字（全链，默认）
 * 路径注入：--pack/--data 或 YOGGRAPH_PACK/YOGGRAPH_DATA（默认相对 CWD：assets、data）。 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadPack, loadSpellOverlay, TextureStore, walkWithKey } from './assets.js';
import { SIZE } from './camera.js';
import {
  buildRenderList, rasterBucketZbuf, renderPortraitLayer, composeToRgba8, alphaPlane,
  renderGemsStage, rgbToRgba8, renderSpellOverlays,
} from './render.js';
import type { OverlayGemSource } from './gems.js';
import { encodePng } from './image.js';
import { compilePlan, compileFramePlan, CARD_TYPE_TO_SLOT, type FixtureCard, type StaticTables } from './plan.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hasFlags = process.argv.slice(2).some(a => a.startsWith('--'));
const packDefault = process.env.YOGGRAPH_PACK ?? 'assets';
const dataDir = arg('--data') ?? process.env.YOGGRAPH_DATA ?? 'data';
const packDir = arg('--pack') ?? (hasFlags ? packDefault : process.argv[2] ?? packDefault);
const cardId = arg('--card');
const outPng = arg('--out') ?? (cardId ? `out/ts_${cardId}.png` : hasFlags ? 'out/ts_p2.png' : process.argv[3] ?? 'out/ts_p2.png');
const stage = arg('--stage') ?? (hasFlags ? 'p2' : process.argv[4] ?? 'p2');

const t0 = Date.now();
const fixtureFile = arg('--fixture-file');
const slotOverride = arg('--slot');
let pack;
if (cardId || fixtureFile) {
  const fixture = JSON.parse(
    readFileSync(fixtureFile ?? join(dataDir, 'fixtures', `${cardId}.json`), 'utf-8'),
  ) as FixtureCard;
  const tables = JSON.parse(readFileSync(join(dataDir, 'tables.json'), 'utf-8')) as StaticTables;
  // 卡型 → 手牌帧 slot（TAG_CARDTYPE；actor_names.csv/ActorNames.cs）；未知卡型回落随从帧
  const slot = slotOverride ?? CARD_TYPE_TO_SLOT[fixture.tags['202'] ?? 4] ?? 'hand-minion';
  pack = loadPack(packDir, slot);
  pack.plan = pack.prefabReport
    ? compileFramePlan(fixture, tables, pack, packDir, slot)
    : compilePlan(fixture, tables, pack, packDir);
} else {
  pack = loadPack(packDir);
}
const textures = new TextureStore(packDir);
const W = SIZE[0], H = SIZE[1];

const lateNames = new Set(pack.plan!.late_nodes ?? []);
const frameNodes = buildRenderList(pack.frameRecon.hierarchy, pack.plan!, lateNames);
const canvas = new Float64Array(W * H * 4);
const zbuf = new Float64Array(W * H).fill(-Infinity);

const nTris = rasterBucketZbuf(frameNodes, pack, textures, canvas, zbuf);
renderPortraitLayer(pack, textures, canvas, zbuf);
// 战棋模板 spell 视觉（coin / tavern-tier）：SpellTable 预制与帧同管线、同 zbuf
const overlayPacks = (pack.plan!.spell_overlays ?? []).map(o => loadSpellOverlay(packDir, o.key));
renderSpellOverlays(overlayPacks, pack.plan!, textures, canvas, zbuf);
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
for (const name of pack.plan!.late_nodes ?? []) {
  const passNodes = buildRenderList(
    pack.frameRecon.hierarchy, pack.plan!, lateNames, new Set([name]));
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
    renderTextStage(rgb, pack, alpha);
  }
  rgba8 = rgbToRgba8(rgb, alpha);
}

mkdirSync(dirname(outPng), { recursive: true });
encodePng(outPng, W, H, rgba8);

const ms = Date.now() - t0;
console.log(JSON.stringify({
  out:         outPng,
  stage,
  card:        cardId ?? 'EX1_350(plan)',
  frame_nodes: frameNodes.map(n => n.name),
  tris:        nTris, ms,
}, null, 1));
