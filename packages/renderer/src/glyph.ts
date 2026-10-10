/** 字形合成：Hidden/TextOutline_Unlit shader 的逐像素仿真（Metal 源码对译，explore/ilspy）。 */

/** Python round() 语义（银行家舍入：.5 → 偶数）。 */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export interface GlyphRGBA {
  data: Float64Array; // nh_t × nw_t × 4
  w:    number;
  h:    number;
  ox:   number;
  oy:   number;
}

/** float RGBA source-over（自动裁剪；dst/ss 缓冲 HxWx4）。 */
export function composite(
  dst: Float64Array, dW: number, dH: number,
  src: Float64Array, sW: number, sH: number,
  x: number, y: number,
): void {
  const x0 = Math.max(x, 0), y0 = Math.max(y, 0);
  const x1 = Math.min(x + sW, dW), y1 = Math.min(y + sH, dH);
  if (x0 >= x1 || y0 >= y1) return;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const si = ((yy - y) * sW + (xx - x)) * 4;
      const di = (yy * dW + xx) * 4;
      const sa = src[si + 3];
      const da = dst[di + 3];
      const outA = sa + da * (1 - sa);
      const safe = outA > 1e-6 ? outA : 1.0;
      for (let c = 0; c < 3; c++) {
        dst[di + c] = (src[si + c] * sa + dst[di + c] * da * (1 - sa)) / safe;
      }
      dst[di + 3] = outA;
    }
  }
}

/** 双线性采样字形位图（0..1 alpha），越外为 0。x/y 为位图像素坐标（可为负/超界）。 */
function sampleMask(mask: { w: number, h: number, data: Float64Array }, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number): number =>
    xx >= 0 && yy >= 0 && xx < mask.w && yy < mask.h ? mask.data[yy * mask.w + xx] : 0;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
    + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * 文字 shader 族逐像素仿真（Metal 源码对译，exporter/tmp/shader/Hidden_*.metal）。
 * <b> 字形在 TextMesh 里属 submesh1 专属 pass，与普通字形（submesh0）不同 shader：
 * - TextOutline_Unlit（描边普通字形）：taps = 中心 + 8 方向（轴向 ±outline、对角 ±0.6×），
 *   α = clamp(Σ9)；rgb = mix(描边色, 填充色, center)。
 * - Text_Bold（无描边粗体，desc <b>）：taps = 8 方向（轴向 ±bold、对角 ±0.6×bold）、
 *   **无中心**；α = Σ8 × 0.23（FS 常数，无 clamp → blend 硬件饱和，字形内部实心）；
 *   rgb = 填充色。
 * - TextBoldOutline（描边+粗体）：taps = 中心 + 右/上/下 + 4×0.6 对角（**缺左**，
 *   VS 把 TEXCOORD3.zw 让给中心 tap）；半径 = _OutlineOffset = texel×(outline+0.75×bold)
 *   （UpdateOutlineProperties UB:2678）；α = Σ9 × 0.23；rgb = 填充色（无描边色混合）。
 * tap 偏移单位 = 图集 texel = 字形像素（动态图集按字号 1:1 光栅）→ boldPx/m_BoldSize
 * 直接以字体像素传入，×scale 转本缓冲 texel；采样 = 字形位图双线性（= 引擎图集 bilinear）。
 * quad 按 tap 半径外扩 padFont（字体像素），paste 位相应外移（否则光晕被削平）。
 * 首帧 Bold() 的 texel=(0,0) 陷阱（UB:2687 在 SetFont 前调用）：基准图是 settled 态，
 * 离线链直接取真值。
 */
export function glyphOutlineShader(
  mask: { w: number, h: number, data: Float64Array },
  info: { minX: number, maxY: number },
  scale: number,
  fill: [number, number, number],
  outline: { r: number, color: [number, number, number] } | null,
  boldPx: number,
  radiusOut = 0.0,
): GlyphRGBA {
  const isBold = boldPx > 0;
  let padFont: number;
  let taps: [number, number][]; // 本缓冲 texel 偏移
  let centerTap: boolean;
  let alphaGain: number; // α = clamp(Σtaps × gain)
  let oc: [number, number, number];
  if (outline && isBold) {
    const r = (outline.r + 0.75 * boldPx) * scale;
    padFont = outline.r + 0.75 * boldPx + 1.0;
    taps = [
      [r, 0], [0, r], [0, -r],
      [0.6 * r, 0.6 * r], [0.6 * r, -0.6 * r], [-0.6 * r, 0.6 * r], [-0.6 * r, -0.6 * r],
    ];
    centerTap = true;
    alphaGain = 0.23;
    oc = fill;
  } else if (outline) {
    padFont = radiusOut > 0 ? radiusOut / scale + 1.0 : 0.0;
    taps = [
      [radiusOut, 0], [-radiusOut, 0], [0, radiusOut], [0, -radiusOut],
      [0.6 * radiusOut, 0.6 * radiusOut], [0.6 * radiusOut, -0.6 * radiusOut],
      [-0.6 * radiusOut, 0.6 * radiusOut], [-0.6 * radiusOut, -0.6 * radiusOut],
    ];
    centerTap = true;
    alphaGain = 1.0;
    oc = outline.color;
  } else if (isBold) {
    const b = boldPx * scale;
    padFont = boldPx + 1.0;
    taps = [
      [b, 0], [-b, 0], [0, b], [0, -b],
      [0.6 * b, 0.6 * b], [0.6 * b, -0.6 * b], [-0.6 * b, 0.6 * b], [-0.6 * b, -0.6 * b],
    ];
    centerTap = false;
    alphaGain = 0.23;
    oc = fill;
  } else {
    padFont = 0.0;
    taps = [];
    centerTap = true;
    alphaGain = 1.0;
    oc = fill;
  }
  const nw = Math.max(1, pyRound((mask.w + 2 * padFont) * scale));
  const nh = Math.max(1, pyRound((mask.h + 2 * padFont) * scale));
  const data = new Float64Array(nw * nh * 4);
  for (let j = 0; j < nh; j++) {
    // buffer 行 j 的中心 → 字体坐标（x 向右，y 自基线向上）；quad 左上 = (minX-pad, maxY+pad)
    const fy = (j + 0.5) / scale - padFont; // 距墨迹框顶（= maxY）
    const fFontY = info.maxY - fy;
    for (let i = 0; i < nw; i++) {
      const fx = (i + 0.5) / scale - padFont; // 距墨迹框左（= minX）
      const fFontX = info.minX + fx;
      const mx = fFontX - info.minX;
      const my = info.maxY - fFontY;
      const center = centerTap ? sampleMask(mask, mx, my) : 0;
      let sum = center;
      for (const [dx, dy] of taps) sum += sampleMask(mask, mx + dx / scale, my + dy / scale);
      const alpha = Math.min(1, Math.max(0, sum * alphaGain));
      const di = (j * nw + i) * 4;
      // rgb = lerp(oc, fill, center)：描边字形 center 处取填充色；bold pass oc=fill 恒填充色
      data[di] = fill[0] * center + oc[0] * (1 - center);
      data[di + 1] = fill[1] * center + oc[1] * (1 - center);
      data[di + 2] = fill[2] * center + oc[2] * (1 - center);
      data[di + 3] = alpha;
    }
  }
  return {
    data, w:  nw, h:  nh,
    ox: (padFont - info.minX) * scale,
    oy: (info.maxY + padFont) * scale,
  };
}
