/** P0 渲染 CLI：bun src/main.ts <packDir> <outPng> */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadPack, TextureStore } from "./assets.js";
import { SIZE } from "./camera.js";
import { buildRenderList, rasterBucketZbuf, renderPortraitLayer, composeToRgba8 } from "./render.js";
import { encodePng } from "./image.js";

const packDir = process.argv[2] ?? "assets/card-render-v1";
const outPng = process.argv[3] ?? "out/ts_p0.png";

const t0 = Date.now();
const pack = loadPack(packDir);
const textures = new TextureStore(packDir);
const W = SIZE[0], H = SIZE[1];

const frameNodes = buildRenderList(pack.frameRecon.hierarchy, pack.plan);
const canvas = new Float64Array(W * H * 4);
const zbuf = new Float64Array(W * H).fill(-Infinity);

const nTris = rasterBucketZbuf(frameNodes, pack, textures, canvas, zbuf);
renderPortraitLayer(pack, textures, canvas, zbuf);

mkdirSync(dirname(outPng), { recursive: true });
encodePng(outPng, W, H, composeToRgba8(canvas));

const ms = Date.now() - t0;
console.log(JSON.stringify({
  out: outPng,
  frame_nodes: frameNodes.map((n) => n.name),
  tris: nTris,
  ms,
}, null, 1));
