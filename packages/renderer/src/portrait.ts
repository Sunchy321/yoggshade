/** 肖像层引擎公式（dz_portrait_layer.render_portrait_submesh 逐行对译）。 */
import type { RGBAImage } from './types.js';
import { sampleTrilinearClamp001 } from './image.js';

const mainS = new Float64Array(4);
const secS = new Float64Array(4);

/** 每三角形纹理足迹（texels/screen-px，取 |∂u/∂x|、|∂u/∂y|、|∂v/∂x|、|∂v/∂y| 最大者 ×
 *  纹理尺寸）的 log2 = 该三角形的三线性 mip 层 λ。放大/1:1 → λ≤0 → 采样与原 level0
 *  逐位同值。UV 的 v 翻转在采样器内做，导数幅值不受影响。 */
function triLambda(
  px: number[], py: number[],
  ua: number[], ub: number[], uc: number[],
  ia: number, ib: number, ic: number,
  texW: number, texH: number,
): number {
  const e1x = px[ib] - px[ia], e1y = py[ib] - py[ia];
  const e2x = px[ic] - px[ia], e2y = py[ic] - py[ia];
  const det = e1x * e2y - e1y * e2x;
  if (Math.abs(det) < 1e-9) return 0;
  const du1 = ub[0] - ua[0], du2 = uc[0] - ua[0];
  const dv1 = ub[1] - ua[1], dv2 = uc[1] - ua[1];
  const dudx = (du1 * e2y - du2 * e1y) / det;
  const dudy = (du2 * e1x - du1 * e2x) / det;
  const dvdx = (dv1 * e2y - dv2 * e1y) / det;
  const dvdy = (dv2 * e1x - dv1 * e2x) / det;
  const foot = Math.max(Math.abs(dudx) * texW, Math.abs(dudy) * texW,
    Math.abs(dvdx) * texH, Math.abs(dvdy) * texH);
  return Math.max(Math.log2(foot), 0);
}

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
  directMaterialOutput = false,
  skipDepthTest = false,
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
    // 引擎三线性过滤（mipmap）：λ 由该三角形自身的屏幕↔UV 缩放决定（见 triLambda 注）
    const lamMain = triLambda(px, py, uv0[ia], uv0[ib], uv0[ic], ia, ib, ic, mainRgba.w, mainRgba.h);
    const lamSec = triLambda(px, py, uv1[ia], uv1[ib], uv1[ic], ia, ib, ic, secondRgba.w, secondRgba.h);
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
        // Deathwing frame 14's opaque UberCardBack RootObject/Mesh writes depth over the art
        // window before this independent Portrait_Mesh is composed. Unity assigns the SIGNATURE
        // material to Actor.m_portraitMesh (Actor.cs:2960-2976, 3051-3079) and submits renderer
        // queues separately (RenderCommandLists.cs:209-245); offline render-card uses one shared
        // zbuf for frame then portrait. The CATA signature probe is blank with that shared test
        // and reveals the portrait when cleared; plan.ts enables this bypass only for frame 14.
        if (!skipDepthTest && !(zpix >= zbuf[pi])) continue;

        const u0 = l0 * uv0[ia][0] + l1 * uv0[ib][0] + l2 * uv0[ic][0];
        const v0 = l0 * uv0[ia][1] + l1 * uv0[ib][1] + l2 * uv0[ic][1];
        const u1 = l0 * uv1[ia][0] + l1 * uv1[ib][0] + l2 * uv1[ic][0];
        const v1 = l0 * uv1[ia][1] + l1 * uv1[ib][1] + l2 * uv1[ic][1];
        sampleTrilinearClamp001(mainRgba, u0, v0, lamMain, mainS);
        sampleTrilinearClamp001(secondRgba, u1, v1, lamSec, secS);

        const w = secS[3] * tA;
        const fR = (1.0 - w) + secS[0] * tR * w;
        const fG = (1.0 - w) + secS[1] * tG * w;
        const fB = (1.0 - w) + secS[2] * tB * w;
        const bR = mainS[0] * fR;
        const bG = mainS[1] * fG;
        const bB = mainS[2] * fB;
        // min((blend, 1), ((blend+0.15)*1, 1.15*1)) —— vcolor 恒 1
        const ci = pi * 4;
        if (directMaterialOutput) {
          // GOLDEN Actor.SetPortraitMaterial replaces the frame's initial portrait shader with
          // UberGoldenCard. Its frozen material composite is already final; applying the initial
          // Unlit_Portrait second-texture and +0.15 lift here would double-shade that image.
          canvas[ci] = mainS[0];
          canvas[ci + 1] = mainS[1];
          canvas[ci + 2] = mainS[2];
          canvas[ci + 3] = mainS[3];
          zbuf[pi] = zpix;
          continue;
        }
        canvas[ci] = Math.min(bR, (bR + 0.15));
        canvas[ci + 1] = Math.min(bG, (bG + 0.15));
        canvas[ci + 2] = Math.min(bB, (bB + 0.15));
        canvas[ci + 3] = Math.min(1.0, 1.15);
        zbuf[pi] = zpix;
      }
    }
  }
}
