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
 * Hidden/TextOutline_Unlit FS 的逐像素仿真（Metal 源码对译，explore/ilspy）：
 *   alpha = clamp(center + Σ8方向taps, 0, 1)；rgb = mix(描边色, 填充色, center)。
 * taps 偏移单位 = 图集 texel = 字体像素（轴向 ±outlineSize、对角 ±0.6×outlineSize）；
 * 采样 = 字形位图双线性（= 引擎动态图集 bilinear）。
 * quad 必须按描边半径外扩 padFont（字体像素）：描边像素落在紧墨迹框之外，quad 不
 * 外扩则描边四边被削平（paste 位相应外移 padFont×scale）。
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
  // 外扩：描边半径（buffer texel → 字体 px）+ 1px 双线性采样余量
  const padFont = radiusOut > 0 ? radiusOut / scale + 1.0 : 0.0;
  const nw = Math.max(1, pyRound((mask.w + 2 * padFont) * scale));
  const nh = Math.max(1, pyRound((mask.h + 2 * padFont) * scale));
  const data = new Float64Array(nw * nh * 4);
  const oc = outline ? outline.color : fill;
  // 8 方向：轴向 ±radiusOut、对角 ±0.6×radiusOut（radiusOut 单位 = 本缓冲 texel；
  // 调用方按 m_OutlineSize=画布 texel 语义换算传入）
  const dirs: [number, number][] = outline
    ? [
      [radiusOut, 0], [-radiusOut, 0], [0, radiusOut], [0, -radiusOut],
      [0.6 * radiusOut, 0.6 * radiusOut], [0.6 * radiusOut, -0.6 * radiusOut],
      [-0.6 * radiusOut, 0.6 * radiusOut], [-0.6 * radiusOut, -0.6 * radiusOut],
    ]
    : [];
  for (let j = 0; j < nh; j++) {
    // buffer 行 j 的中心 → 字体坐标（x 向右，y 自基线向上）；quad 左上 = (minX-pad, maxY+pad)
    const fy = (j + 0.5) / scale - padFont; // 距墨迹框顶（= maxY）
    const fFontY = info.maxY - fy;
    for (let i = 0; i < nw; i++) {
      const fx = (i + 0.5) / scale - padFont; // 距墨迹框左（= minX）
      const fFontX = info.minX + fx;
      const mx = fFontX - info.minX;
      const my = info.maxY - fFontY;
      const center = sampleMask(mask, mx, my);
      let sum = center;
      for (const [dx, dy] of dirs) sum += sampleMask(mask, mx + dx / scale, my + dy / scale);
      const alpha = Math.min(1, Math.max(0, sum));
      const di = (j * nw + i) * 4;
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
