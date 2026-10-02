/** z-buffer 三角光栅化（dz_render.raster_zbuf 逐行对译）。 */
import type { RGBAImage } from "./types.js";
import { sampleBilinearClamp } from "./image.js";

const scratch = new Float64Array(4);

/**
 * 单三角形：barycentric 覆盖（eps -1e-6）→ 世界 Y 深度插值 → LEqual(>=) z-test →
 * 双线性采样（uv + uvOffset）→ tint → 直感 alpha 合成（premultiplied 口径）→ 写色写深。
 * canvas: H*W*4 float64；zbuf: H*W float64（-Inf = 未覆盖）。
 */
export function rasterZbuf(
  canvas: Float64Array,
  zbuf: Float64Array,
  W: number,
  H: number,
  tri2d: number[][],   // [3][2] 屏幕坐标
  triZ: number[],      // [3] 世界 Y 深度
  triUv: number[][],   // [3][2] UV
  tex: RGBAImage,
  tint: number[],      // [4]
  uvOffset: [number, number],
): void {
  const x0s = tri2d[0][0], y0s = tri2d[0][1];
  const x1s = tri2d[1][0], y1s = tri2d[1][1];
  const x2s = tri2d[2][0], y2s = tri2d[2][1];
  let xmin = Math.max(Math.floor(Math.min(x0s, x1s, x2s)), 0);
  let xmax = Math.min(Math.ceil(Math.max(x0s, x1s, x2s)), W - 1);
  let ymin = Math.max(Math.floor(Math.min(y0s, y1s, y2s)), 0);
  let ymax = Math.min(Math.ceil(Math.max(y0s, y1s, y2s)), H - 1);
  if (xmin > xmax || ymin > ymax) return;

  const d = (x1s - x0s) * (y2s - y0s) - (x2s - x0s) * (y1s - y0s);
  if (Math.abs(d) < 1e-12) return;

  const tw = tex.w, th = tex.h;
  const u0 = triUv[0][0], v0 = triUv[0][1];
  const u1 = triUv[1][0], v1 = triUv[1][1];
  const u2 = triUv[2][0], v2 = triUv[2][1];
  const tr = tint[0], tg = tint[1], tb = tint[2], ta = tint[3];

  for (let y = ymin; y <= ymax; y++) {
    const gy = y + 0.5;
    for (let x = xmin; x <= xmax; x++) {
      const gx = x + 0.5;
      const l1 = ((gx - x0s) * (y2s - y0s) - (gy - y0s) * (x2s - x0s)) / d;
      const l2 = ((x1s - x0s) * (gy - y0s) - (y1s - y0s) * (gx - x0s)) / d;
      const l0 = 1.0 - l1 - l2;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const z = l0 * triZ[0] + l1 * triZ[1] + l2 * triZ[2];
      const pi = y * W + x;
      if (!(z >= zbuf[pi])) continue;

      const u = l0 * u0 + l1 * u1 + l2 * u2 + uvOffset[0];
      const v = l0 * v0 + l1 * v1 + l2 * v2 + uvOffset[1];
      sampleBilinearClamp(tex, u * tw - 0.5, (1.0 - v) * th - 0.5, scratch);
      const sa = scratch[3] * ta;
      const ci = pi * 4;
      const dstA = canvas[ci + 3];
      const outA = sa + dstA * (1 - sa);
      const safe = outA > 1e-6 ? outA : 1.0;
      canvas[ci] = (scratch[0] * tr * sa + canvas[ci] * dstA * (1 - sa)) / safe;
      canvas[ci + 1] = (scratch[1] * tg * sa + canvas[ci + 1] * dstA * (1 - sa)) / safe;
      canvas[ci + 2] = (scratch[2] * tb * sa + canvas[ci + 2] * dstA * (1 - sa)) / safe;
      canvas[ci + 3] = outA;
      zbuf[pi] = z;
    }
  }
}
