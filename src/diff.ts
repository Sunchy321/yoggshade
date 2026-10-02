/** 像素 diff CLI：bun src/diff.ts <a.png> <b.png> [outPrefix]
 * 输出 mse/mae/maxAbs/超阈值像素计数 + 热区图（|d|×8）与并排对照图。 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { encodePng } from "./image.js";

function readU8(p: string) {
  const png = PNG.sync.read(readFileSync(p));
  return { w: png.width, h: png.height, data: png.data as Uint8Array };
}

const [aPath, bPath, prefix] = process.argv.slice(2);
const A = readU8(aPath);
const B = readU8(bPath);
if (A.w !== B.w || A.h !== B.h) throw new Error(`尺寸不一致: ${A.w}x${A.h} vs ${B.w}x${B.h}`);

let se = 0, ae = 0, gMax = 0, gt1 = 0, gt2 = 0, gt4 = 0;
const heat = new Uint8Array(A.w * A.h * 4);
for (let i = 0; i < A.w * A.h; i++) {
  let dMax = 0;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(A.data[i * 4 + c] - B.data[i * 4 + c]);
    se += d * d;
    ae += d;
    if (d > dMax) dMax = d;
  }
  if (dMax > 1) gt1++;
  if (dMax > 2) gt2++;
  if (dMax > 4) gt4++;
  if (dMax > gMax) gMax = dMax;
  const v = Math.min(255, Math.round(dMax * 8));
  heat[i * 4] = v; heat[i * 4 + 1] = v; heat[i * 4 + 2] = v; heat[i * 4 + 3] = 255;
}
const maxAbs = gMax;
const n = A.w * A.h * 3;
const mse = se / n, mae = ae / n;

if (prefix) {
  encodePng(`${prefix}_heat.png`, A.w, A.h, heat);
  const side = new Uint8Array(A.w * 2 * A.h * 4);
  for (let y = 0; y < A.h; y++) {
    side.set(A.data.subarray(y * A.w * 4, (y + 1) * A.w * 4), y * A.w * 2 * 4);
    side.set(B.data.subarray(y * B.w * 4, (y + 1) * B.w * 4), (y * A.w * 2 + A.w) * 4);
  }
  encodePng(`${prefix}_side.png`, A.w * 2, A.h, side);
}

console.log(JSON.stringify({
  a: aPath, b: bPath,
  mse: Math.round(mse * 100) / 100,
  mae: Math.round(mae * 1000) / 1000,
  maxAbs, px_gt1: gt1, px_gt2: gt2, px_gt4: gt4, px_total: A.w * A.h,
}, null, 1));
