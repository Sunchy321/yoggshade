/** 字形合成：8 向膨胀（描边/粗体）+ 双线性重采样 + 双 pass 颜色（uber_text._dilate/_resample/glyph_rgba 对译）。 */
import { resampleImage } from "./resize.js";

/** Python round() 语义（银行家舍入：.5 → 偶数）。 */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** 8 向偏移取 max（八边形），半径 r texel。 */
export function dilate(a: Float64Array, w: number, h: number, r: number): Float64Array {
  if (r < 0.5) return a;
  const ri = Math.max(1, Math.floor(r + 0.5));
  const out = a.slice();
  for (const dy of [-ri, 0, ri]) {
    for (const dx of [-ri, 0, ri]) {
      if (dx === 0 && dy === 0) continue;
      const sx0 = Math.max(dx, 0), sx1 = w + Math.min(dx, 0);
      const sy0 = Math.max(dy, 0), sy1 = h + Math.min(dy, 0);
      const tx0 = Math.max(-dx, 0), tx1 = w + Math.min(-dx, 0);
      const ty0 = Math.max(-dy, 0), ty1 = h + Math.min(-dy, 0);
      if (sx1 > sx0 && sy1 > sy0) {
        for (let y = ty0; y < ty1; y++) {
          for (let x = tx0; x < tx1; x++) {
            const v = a[(y - ty0 + sy0) * w + (x - tx0 + sx0)];
            const oi = y * w + x;
            if (v > out[oi]) out[oi] = v;
          }
        }
      }
    }
  }
  return out;
}

/** PIL L 图像双线性 resize 的 uint8 往返等价：量化 → 双线性 → uint8 级量化。 */
function resampleMask(a: Float64Array, w: number, h: number, nw: number, nh: number): Float64Array {
  const q = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    q[i] = Math.round(Math.min(Math.max(a[i], 0), 1) * 255) / 255;
  }
  return resampleImage(q, w, h, 1, nw, nh, "bilinear", true);
}

export interface GlyphRGBA {
  data: Float64Array;   // nh_t × nw_t × 4
  w: number;
  h: number;
  ox: number;
  oy: number;
}

/** 单字 → RGBA + 落位偏移（paste 位 = (pen − ox, baseline − oy)）。 */
export function glyphRgba(
  mask: { w: number; h: number; data: Float64Array },
  info: { minX: number; maxY: number },
  scale: number,
  fill: [number, number, number],
  outline: { r: number; color: [number, number, number] } | null,
  boldPx: number,
): GlyphRGBA {
  const mh = mask.h, mw = mask.w;
  const r = outline ? outline.r : 0.0;
  const m = Math.ceil(Math.max(r, boldPx) + 1.0) + 1;
  const bw = mw + 2 * m, bh = mh + 2 * m;
  const big = new Float64Array(bw * bh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) big[(y + m) * bw + (x + m)] = mask.data[y * mw + x];
  }
  const aFill = boldPx >= 0.5 ? dilate(big, bw, bh, boldPx) : big;
  const aOut = outline ? dilate(big, bw, bh, r) : aFill;
  const nwT = Math.max(1, pyRound(bw * scale));
  const nhT = Math.max(1, pyRound(bh * scale));
  const outS = resampleMask(aOut, bw, bh, nwT, nhT);
  const fillS = resampleMask(aFill, bw, bh, nwT, nhT);
  const rgba = new Float64Array(nhT * nwT * 4);
  for (let i = 0; i < nwT * nhT; i++) {
    if (outline) {
      const af = fillS[i];
      for (let c = 0; c < 3; c++) {
        rgba[i * 4 + c] = outline.color[c] * (1 - af) + fill[c] * af;
      }
      rgba[i * 4 + 3] = outS[i];
    } else {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = fill[c];
      rgba[i * 4 + 3] = fillS[i];
    }
  }
  return {
    data: rgba, w: nwT, h: nhT,
    ox: (m - info.minX) * scale,
    oy: (m + info.maxY) * scale,
  };
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
