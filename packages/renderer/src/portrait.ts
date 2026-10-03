/** 肖像层引擎公式（dz_portrait_layer.render_portrait_submesh 逐行对译）。 */
import type { RGBAImage } from './types.js';
import { sampleBilinearClamp001 } from './image.js';

const mainS = new Float64Array(4);
const secS = new Float64Array(4);

/**
 * PS 772B 直译：out.rgb = main.rgb * lerp(1, second.rgb*_SecondTint.rgb, w)，w=second.a*t.a
 * （t=_SecondTint*_BlendIntensity）；min 支亮度抬升 (blend+0.15)*vcol / alpha 1.15*vcol.a；
 * out.a 恒有效 1（min(1,1.15)）。同一全局 zbuf LEqual 测试 + 写深；桶内 py 均值画家序。
 */
export function renderPortraitSubmesh(
  canvas: Float64Array,
  zbuf: Float64Array,
  W: number,
  H: number,
  depth: number[], // 顶点世界 Y
  px: number[], // 顶点屏幕 x
  py: number[], // 顶点屏幕 y
  uv0: number[][],
  uv1: number[][],
  tris: number[][],
  mainRgba: RGBAImage,
  secondRgba: RGBAImage,
  secondTint: number[], // [r,g,b,a]
  blendIntensity: number,
): void {
  const tR = secondTint[0] * blendIntensity;
  const tG = secondTint[1] * blendIntensity;
  const tB = secondTint[2] * blendIntensity;
  const tA = secondTint[3] * blendIntensity;

  const order = tris
    .map((tri, i) => [tri, i] as const)
    .sort((a, b) => {
      const ma = (py[a[0][0]] + py[a[0][1]] + py[a[0][2]]) / 3;
      const mb = (py[b[0][0]] + py[b[0][1]] + py[b[0][2]]) / 3;
      return ma - mb;
    })
    .map(([tri]) => tri);

  for (const tri of order) {
    const ia = tri[0], ib = tri[1], ic = tri[2];
    const x0s = px[ia], y0s = py[ia];
    const x1s = px[ib], y1s = py[ib];
    const x2s = px[ic], y2s = py[ic];
    const xmin = Math.max(Math.floor(Math.min(x0s, x1s, x2s)), 0);
    const xmax = Math.min(Math.ceil(Math.max(x0s, x1s, x2s)), W - 1);
    const ymin = Math.max(Math.floor(Math.min(y0s, y1s, y2s)), 0);
    const ymax = Math.min(Math.ceil(Math.max(y0s, y1s, y2s)), H - 1);
    if (xmin > xmax || ymin > ymax) continue;
    const d = (x1s - x0s) * (y2s - y0s) - (x2s - x0s) * (y1s - y0s);
    if (Math.abs(d) < 1e-12) continue;

    const zA = depth[ia], zB = depth[ib], zC = depth[ic];

    for (let y = ymin; y <= ymax; y++) {
      const gy = y + 0.5;
      for (let x = xmin; x <= xmax; x++) {
        const gx = x + 0.5;
        const l1 = ((gx - x0s) * (y2s - y0s) - (gy - y0s) * (x2s - x0s)) / d;
        const l2 = ((x1s - x0s) * (gy - y0s) - (y1s - y0s) * (gx - x0s)) / d;
        const l0 = 1.0 - l1 - l2;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const zpix = l0 * zA + l1 * zB + l2 * zC;
        const pi = y * W + x;
        if (!(zpix >= zbuf[pi])) continue;

        const u0 = l0 * uv0[ia][0] + l1 * uv0[ib][0] + l2 * uv0[ic][0];
        const v0 = l0 * uv0[ia][1] + l1 * uv0[ib][1] + l2 * uv0[ic][1];
        const u1 = l0 * uv1[ia][0] + l1 * uv1[ib][0] + l2 * uv1[ic][0];
        const v1 = l0 * uv1[ia][1] + l1 * uv1[ib][1] + l2 * uv1[ic][1];
        sampleBilinearClamp001(mainRgba, u0, v0, mainS);
        sampleBilinearClamp001(secondRgba, u1, v1, secS);

        const w = secS[3] * tA;
        const fR = (1.0 - w) + secS[0] * tR * w;
        const fG = (1.0 - w) + secS[1] * tG * w;
        const fB = (1.0 - w) + secS[2] * tB * w;
        const bR = mainS[0] * fR;
        const bG = mainS[1] * fG;
        const bB = mainS[2] * fB;
        // min((blend, 1), ((blend+0.15)*1, 1.15*1)) —— vcolor 恒 1
        const ci = pi * 4;
        canvas[ci] = Math.min(bR, (bR + 0.15));
        canvas[ci + 1] = Math.min(bG, (bG + 0.15));
        canvas[ci + 2] = Math.min(bB, (bB + 0.15));
        canvas[ci + 3] = Math.min(1.0, 1.15);
        zbuf[pi] = zpix;
      }
    }
  }
}
