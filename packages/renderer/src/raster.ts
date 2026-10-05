/** z-buffer 三角光栅化（dz_render.raster_zbuf 逐行对译）。 */
import type { RGBAImage } from './types.js';
import { sampleBilinearClamp } from './image.js';

const scratch = new Float64Array(4);

/**
 * 单三角形：barycentric 覆盖（eps -1e-6）→ 世界 Y 深度插值 → LEqual(>=) z-test →
 * 双线性采样（uv + uvOffset）→ tint → 直感 alpha 合成（premultiplied 口径）→ 写色写深。
 * canvas: H*W*4 float64；zbuf: H*W float64（-Inf = 未覆盖）。
 *
 * opaque=true：按不透明绘制（忽略纹理 alpha，写入 alpha=1）。用于官方 opaque-edge 名单材质
 * （地标框体/描述框、符文、铸造/备战/可交易横幅、多职业绶带）——游戏渲染到不透明屏幕帧缓冲，
 * 这些材质的 DXT5 alpha 是形状蒙版而非透明度（见 exporter docs/opaque-edge-alpha-repair-decompile.md）；
 * 离线链若照纹理 alpha 混合，会抠出透明洞让卡背平面透出来。
 *
 * multiply=true：乘法混合（Hero/Multiply/*，见 types.PlanSlot.blend）。FS 输出 rgb=_MainTex.rgb+COLOR0.rgb、
 * a=0；VS 的 COLOR0=顶点色×_Color（本仓网格无顶点色 → 白 → COLOR0=_Color）。
 */
export function rasterZbuf(
  canvas: Float64Array,
  zbuf: Float64Array,
  W: number,
  H: number,
  tri2d: number[][], // [3][2] 屏幕坐标
  triZ: number[], // [3] 世界 Y 深度
  triUv: number[][], // [3][2] UV
  tex: RGBAImage,
  tint: number[], // [4]
  uvOffset: [number, number],
  opaque = false,
  multiply = false,
  additive = false,
  wrapRepeat = false, // _MainTex wrap=repeat（引擎材质默认；缺省 clamp，见 PlanSlot.wrap_repeat）
): void {
  const x0s = tri2d[0][0], y0s = tri2d[0][1];
  const x1s = tri2d[1][0], y1s = tri2d[1][1];
  const x2s = tri2d[2][0], y2s = tri2d[2][1];
  const xmin = Math.max(Math.floor(Math.min(x0s, x1s, x2s)), 0);
  const xmax = Math.min(Math.ceil(Math.max(x0s, x1s, x2s)), W - 1);
  const ymin = Math.max(Math.floor(Math.min(y0s, y1s, y2s)), 0);
  const ymax = Math.min(Math.ceil(Math.max(y0s, y1s, y2s)), H - 1);
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
      // wrap=repeat（Unity _MainTex 默认）：ST 后逐像素取分数部分。多职业绶带阴影的材质
      // ST（scale 0.53/0.48, offset −0.53/−0.048）使采样越过 0 边界，clamp 会拉出边缘条纹；
      // 引擎 repeat 语义 = fract。逐顶点预 fract 不可行（三角形跨缝插值会横穿整张图）。
      const uu = wrapRepeat ? u - Math.floor(u) : u;
      const vv = wrapRepeat ? v - Math.floor(v) : v;
      sampleBilinearClamp(tex, uu * tw - 0.5, (1.0 - vv) * th - 0.5, scratch);
      const ci = pi * 4;
      if (multiply) {
        // 乘法混合（Hero/Multiply/*）：dst.rgb *= 纹理色 + _Color。alpha 保持不变——乘法阴影只压暗，
        // 不产生遮盖（游戏在屏幕帧缓冲里 a=0 无副作用；离线链若让它清 alpha 会把卡角抠空）。
        // **不写深度**：该 shader 的 subshader tag 是 QUEUE=Transparent（ZWrite Off），阴影面片
        // 又比肖像面片更靠前（世界 Y 更大）；写深度会把随后绘制的肖像层挡在 zbuf 之外——游戏里
        // 异画/精英卡的卡图能透过银龙影显示（ETC_210/TLC_433 的画窗上缘），靠的就是这一点。
        canvas[ci] = Math.max(Math.min(canvas[ci] * Math.min(scratch[0] + tr, 1), 1), 0);
        canvas[ci + 1] = Math.max(Math.min(canvas[ci + 1] * Math.min(scratch[1] + tg, 1), 1), 0);
        canvas[ci + 2] = Math.max(Math.min(canvas[ci + 2] * Math.min(scratch[2] + tb, 1), 1), 0);
        continue;
      }
      if (additive) {
        // 加法混合（Hero/Additive/*，SrcAlpha·One）：dst.rgb += src.rgb × tint × src.a；不动 alpha、
        // 不写深度（Transparent 队列语义；星芒/辉光类 FX 只增亮）。
        const sa = scratch[3] * ta;
        canvas[ci] = Math.min(canvas[ci] + scratch[0] * tr * sa, 1);
        canvas[ci + 1] = Math.min(canvas[ci + 1] + scratch[1] * tg * sa, 1);
        canvas[ci + 2] = Math.min(canvas[ci + 2] + scratch[2] * tb * sa, 1);
        continue;
      }
      const sa = opaque ? 1.0 : scratch[3] * ta;
      // 全透明纹素（sa=0）：引擎里要么 ZWrite Off 要么 alpha-test discard，**绝不产生遮挡**。
      // 离线链此前无条件写深度，饰品格子纹章（Trinket_Medallion）被 TrinketLevelIndicatorRing
      // 内圈的透明纹素挡在 zbuf 外（用户报告"大型/小型没渲染上"，2026-10-03）。
      if (sa <= 0) continue;
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
