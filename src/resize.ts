/** Pillow ImagingResample 的 8bpc 精确复刻（BILINEAR / LANCZOS，uint8 图像往返）。
 *
 * parity 说明（对齐 Pillow src/libImaging/Resample.c）：
 * 1. 系数窗口：center = (xx+0.5)×scale；xmin = trunc(center − support + 0.5)，
 *    xmax = trunc(center + support + 0.5)；核自变量 = (x + xmin − center + 0.5)/filterscale。
 * 2. 下采样时 support × filterscale 展宽（面积加权）。
 * 3. 8bpc：归一化浮点系数量化为 22-bit 定点整数（PRECISION_BITS = 32−8−2），
 *    整数累加后 (acc + 2^21) >> 22 取整；水平/垂直两轴各自独立量化到 uint8。 */
type Kernel = (x: number) => number;

const PRECISION_BITS = 32 - 8 - 2;

const bilinear: Kernel = (x) => (Math.abs(x) <= 1 ? 1 - Math.abs(x) : 0);
const lanczos: Kernel = (x) => {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};
const SUPPORT = { bilinear: 1, lanczos: 3 };

interface Coeffs8 { xmin: number; ksize: number; kk: Float64Array }

/** 单轴 8bpc 系数（PIL precompute_coeffs + normalize_coeffs_8bpc）。 */
function coefficients8(inN: number, outN: number, kernel: Kernel, support: number): Coeffs8[] {
  const scale = inN / outN;
  const filterscale = scale > 1 ? scale : 1;
  const supportIn = support * filterscale;
  const out: Coeffs8[] = [];
  for (let xx = 0; xx < outN; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - supportIn + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + supportIn + 0.5);
    if (xmax > inN) xmax = inN;
    const xsize = xmax - xmin;
    const pre = new Float64Array(xsize);
    let ww = 0;
    for (let x = 0; x < xsize; x++) {
      const w = kernel((x + xmin - center + 0.5) / filterscale);
      pre[x] = w;
      ww += w;
    }
    const kk = new Float64Array(xsize);
    if (ww !== 0) {
      for (let x = 0; x < xsize; x++) {
        const n = pre[x] / ww;
        kk[x] = n < 0 ? Math.trunc(-0.5 + n * (1 << PRECISION_BITS))
                      : Math.trunc(0.5 + n * (1 << PRECISION_BITS));
      }
    }
    out.push({ xmin, ksize: xsize, kk });
  }
  return out;
}

const clip8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 交错 uint8 级 float 图像（h*w*ch，值已量化到 1/255）的 PIL 8bpc 重采样；
 * 输出同口径量化（两轴各自 round 到 8bit）。 */
export function resampleImage(
  src: Float64Array, sw: number, sh: number, ch: number,
  dw: number, dh: number, kind: "bilinear" | "lanczos", quantize: boolean,
): Float64Array {
  // 4 通道 = RGBA：Pillow 12 的 Image.resize 对 RGBA 走 premultiply 路径
  // （convert("RGBa") → resample → convert("RGBA")），RGBa 转换：
  // premultiply (R×A+127)/255；unpremultiply floor(R'×255/A)，A=0 → 0。
  if (quantize && ch === 4) {
    const pm = new Float64Array(src.length);
    for (let i = 0; i < sw * sh; i++) {
      const a = Math.round(src[i * 4 + 3] * 255);
      pm[i * 4 + 3] = a / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) pm[i * 4 + c] = Math.trunc((Math.round(src[i * 4 + c] * 255) * a + 127) / 255) / 255;
    }
    const res = resample8bpc(pm, sw, sh, 4, dw, dh, kind);
    for (let i = 0; i < dw * dh; i++) {
      const a = Math.round(res[i * 4 + 3] * 255);
      if (a === 0) {
        res[i * 4] = res[i * 4 + 1] = res[i * 4 + 2] = 0;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        res[i * 4 + c] = Math.trunc(Math.round(res[i * 4 + c] * 255) * 255 / a) / 255;
      }
    }
    return res;
  }
  return resample8bpc(src, sw, sh, ch, dw, dh, kind);
}

/** 8bpc 核心（单通道语义按通道独立，无 alpha 处理）。 */
function resample8bpc(
  src: Float64Array, sw: number, sh: number, ch: number,
  dw: number, dh: number, kind: "bilinear" | "lanczos",
): Float64Array {
  const kernel = kind === "bilinear" ? bilinear : lanczos;
  const roundBias = 1 << (PRECISION_BITS - 1);

  // horizontal（8bpc：整数累加 + 舍入移位 + uint8 量化）
  const cx = coefficients8(sw, dw, kernel, SUPPORT[kind]);
  const tmp = new Float64Array(sh * dw * ch);
  for (let y = 0; y < sh; y++) {
    for (let o = 0; o < dw; o++) {
      const { xmin, ksize, kk } = cx[o];
      const acc = new Float64Array(ch);
      for (let i = 0; i < ksize; i++) {
        const w = kk[i];
        if (w === 0) continue;
        const si = (y * sw + (xmin + i)) * ch;
        for (let c = 0; c < ch; c++) acc[c] += Math.round(src[si + c] * 255) * w;
      }
      const di = (y * dw + o) * ch;
      for (let c = 0; c < ch; c++) {
        tmp[di + c] = clip8(Math.trunc((acc[c] + roundBias) / (1 << PRECISION_BITS))) / 255;
      }
    }
  }
  // vertical（输入已是 uint8 级）
  const cy = coefficients8(sh, dh, kernel, SUPPORT[kind]);
  const out = new Float64Array(dh * dw * ch);
  for (let o = 0; o < dh; o++) {
    const { xmin: y0, ksize, kk } = cy[o];
    for (let x = 0; x < dw; x++) {
      const acc = new Float64Array(ch);
      for (let i = 0; i < ksize; i++) {
        const w = kk[i];
        if (w === 0) continue;
        const si = ((y0 + i) * dw + x) * ch;
        for (let c = 0; c < ch; c++) acc[c] += Math.round(tmp[si + c] * 255) * w;
      }
      const di = (o * dw + x) * ch;
      for (let c = 0; c < ch; c++) {
        out[di + c] = clip8(Math.trunc((acc[c] + roundBias) / (1 << PRECISION_BITS))) / 255;
      }
    }
  }
  return out;
}
