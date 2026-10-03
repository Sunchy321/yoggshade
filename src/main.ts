/** 渲染 CLI：
 *  bun src/main.ts [packDir] [outPng] [stage]           —— 资产包内嵌 plan（EX1_350 基线）
 *  bun src/main.ts --card CARD_ID [--out out.png]       —— pivot 卡编译渲染（data/pivots + data/tables）
 * stage: p0 = 帧+肖像；p1 = +宝石；p2 = +文字（全链，默认） */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPack, TextureStore } from './assets.js';
import { SIZE } from './camera.js';
import {
  buildRenderList, rasterBucketZbuf, renderPortraitLayer, composeToRgba8,
  renderGemsStage, rgbToRgba8,
} from './render.js';
import { encodePng } from './image.js';
import { compilePlan, type PivotCard, type StaticTables } from './plan.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hasFlags = process.argv.slice(2).some(a => a.startsWith('--'));
const packDir = arg('--pack') ?? (hasFlags ? 'assets/card-render-v1' : process.argv[2] ?? 'assets/card-render-v1');
const cardId = arg('--card');
const outPng = arg('--out') ?? (cardId ? `out/ts_${cardId}.png` : hasFlags ? 'out/ts_p2.png' : process.argv[3] ?? 'out/ts_p2.png');
const stage = arg('--stage') ?? (hasFlags ? 'p2' : process.argv[4] ?? 'p2');

const t0 = Date.now();
const pack = loadPack(packDir);
const pivotFile = arg('--pivot-file');
if (cardId || pivotFile) {
  const pivot = JSON.parse(
    readFileSync(pivotFile ?? `data/pivots/${cardId}.json`, 'utf-8'),
  ) as PivotCard;
  const tables = JSON.parse(readFileSync('data/tables.json', 'utf-8')) as StaticTables;
  pack.plan = compilePlan(pivot, tables, pack, packDir);
}
const textures = new TextureStore(packDir);
const W = SIZE[0], H = SIZE[1];

const frameNodes = buildRenderList(pack.frameRecon.hierarchy, pack.plan);
const canvas = new Float64Array(W * H * 4);
const zbuf = new Float64Array(W * H).fill(-Infinity);

const nTris = rasterBucketZbuf(frameNodes, pack, textures, canvas, zbuf);
renderPortraitLayer(pack, textures, canvas, zbuf);

let rgba8: Uint8Array;
if (stage === 'p0') {
  rgba8 = composeToRgba8(canvas);
} else {
  const rgb = renderGemsStage(canvas, pack, textures);
  if (stage === 'p2') {
    const { renderTextStage } = await import('./textstage.js');
    renderTextStage(rgb, pack);
  }
  rgba8 = rgbToRgba8(rgb);
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
