/** 渲染 CLI：bun src/main.ts [packDir] [outPng] [stage]
 * stage: p0 = 帧+肖像；p1 = +宝石；p2 = +文字（全链，默认） */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPack, TextureStore } from './assets.js';
import { SIZE } from './camera.js';
import {
  buildRenderList, rasterBucketZbuf, renderPortraitLayer, composeToRgba8,
  renderGemsStage, rgbToRgba8,
} from './render.js';
import { encodePng } from './image.js';

const packDir = process.argv[2] ?? 'assets/card-render-v1';
const outPng = process.argv[3] ?? 'out/ts_p2.png';
const stage = process.argv[4] ?? 'p2';

const t0 = Date.now();
const pack = loadPack(packDir);
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
  out:         outPng, stage,
  frame_nodes: frameNodes.map(n => n.name),
  tris:        nTris, ms,
}, null, 1));
