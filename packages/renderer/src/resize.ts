/** Pillow ImagingResample 的 8bpc 精确复刻（BILINEAR / LANCZOS，uint8 图像往返）。
 *
 * parity 说明（对齐 Pillow src/libImaging/Resample.c）：
 * 1. 系数窗口：center = (xx+0.5)×scale；xmin = trunc(center − support + 0.5)，
 *    xmax = trunc(center + support + 0.5)；核自变量 = (x + xmin − center + 0.5)/filterscale。
 * 2. 下采样时 support × filterscale 展宽（面积加权）。
 * 3. 8bpc：归一化浮点系数量化为 22-bit 定点整数（PRECISION_BITS = 32−8−2），
 *    整数累加后 (acc + 2^21) >> 22 取整；水平/垂直两轴各自独立量化到 uint8。
 *
 * 内存口径（ticket 18，位级等价改造，fixtures 全集字节一致验收）：本口径每个中间值都
 * 落在 1/255 网格——premultiply = trunc((round(v·255)·a+127)/255)/255（两级整数除法）、
 * tmp/out = clip8(...)/255；读回恒等式 Math.round(k/255×255)===k（0≤k≤255）是本文件
 * 既有代码自身依赖的性质（垂直 pass 读回 tmp、unpremultiply 读回 out 同此）。据此：
 *   - premultiply 不再物化整幅副本（ss=4 下 192 MiB），融进水平 pass 逐 tap 整数化；
 *   - 水平 tmp 改 Uint8Array（48→12 MiB）；out 仍以 Float64Array(k/255) 返回，
 *     消费方（ubertext→textstage 的 float 语义）不动。 */
type Kernel = (x: number) => number;

const PRECISION_BITS = 32 - 8 - 2;

const bilinear: Kernel = x => (Math.abs(x) <= 1 ? 1 - Math.abs(x) : 0);
const lanczos: Kernel = x => {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};
const SUPPORT = { bilinear: 1, lanczos: 3 };

interface Coeffs8 { xmin: number, ksize: number, kk: Float64Array }

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
        kk[x] = n < 0
          ? Math.trunc(-0.5 + n * (1 << PRECISION_BITS))
          : Math.trunc(0.5 + n * (1 << PRECISION_BITS));
      }
    }
    out.push({ xmin, ksize: xsize, kk });
  }
  return out;
}

const clip8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 交错图像（值已量化到 1/255 网格）的 PIL 8bpc 重采样；输出同口径量化。
 * premultiply=true 走 Pillow RGBA 路径：premultiply 在水平 pass 逐 tap 内联
 * （RGB×(A·255+127)/255 整数式；A=0 的 tap 对全通道贡献 0）。 */
export function resampleImage(
  src: Float64Array, sw: number, sh: number, ch: number,
  dw: number, dh: number, kind: 'bilinear' | 'lanczos', quantize: boolean,
): Float64Array {
  return resample8bpc(src, sw, sh, ch, dw, dh, kind, quantize && ch === 4);
}

/** 8bpc 核心（单通道语义按通道独立；premultiply 见上）。 */
function resample8bpc(
  src: Float64Array, sw: number, sh: number, ch: number,
  dw: number, dh: number, kind: 'bilinear' | 'lanczos',
  premultiply: boolean,
): Float64Array {
  const kernel = kind === 'bilinear' ? bilinear : lanczos;
  const roundBias = 1 << (PRECISION_BITS - 1);

  // horizontal（8bpc：整数累加 + 舍入移位 + uint8 量化）
  const cx = coefficients8(sw, dw, kernel, SUPPORT[kind]);
  const tmp = new Uint8Array(sh * dw * ch);
  for (let y = 0; y < sh; y++) {
    for (let o = 0; o < dw; o++) {
      const { xmin, ksize, kk } = cx[o];
      const acc = new Float64Array(ch);
      for (let i = 0; i < ksize; i++) {
        const w = kk[i];
        if (w === 0) continue;
        const si = (y * sw + (xmin + i)) * ch;
        if (premultiply) {
          const a8 = Math.round(src[si + 3] * 255);
          if (a8 === 0) continue; // pm 全零 tap：四通道各 += 0，跳过等价
          for (let c = 0; c < ch; c++) {
            // RGB = trunc((v·a8+127)/255)（Pillow RGBa 整数式）；A = a8
            const v = c === 3 ? a8 : Math.trunc((Math.round(src[si + c] * 255) * a8 + 127) / 255);
            acc[c] += v * w;
          }
        } else {
          for (let c = 0; c < ch; c++) acc[c] += Math.round(src[si + c] * 255) * w;
        }
      }
      const di = (y * dw + o) * ch;
      for (let c = 0; c < ch; c++) {
        tmp[di + c] = clip8(Math.trunc((acc[c] + roundBias) / (1 << PRECISION_BITS)));
      }
    }
  }
  // vertical（输入已是 uint8 级；直接读，等于旧口径 round(tmp/255×255)）
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
        for (let c = 0; c < ch; c++) acc[c] += tmp[si + c] * w;
      }
      const di = (o * dw + x) * ch;
      for (let c = 0; c < ch; c++) {
        out[di + c] = clip8(Math.trunc((acc[c] + roundBias) / (1 << PRECISION_BITS))) / 255;
      }
    }
  }
  // RGBA 输出 unpremultiply（Pillow floor(R'×255/A)，A=0 → 0）；res 仍是 k/255 float，
  // round-back 恒等式与旧口径一致。
  if (premultiply) {
    for (let i = 0; i < dw * dh; i++) {
      const a = Math.round(out[i * 4 + 3] * 255);
      if (a === 0) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        out[i * 4 + c] = Math.trunc(Math.round(out[i * 4 + c] * 255) * 255 / a) / 255;
      }
    }
  }
  return out;
}

/** 子矩形输入 resample（ticket 18 位级等价）：renderText 的印章只落在字形 tile 并集 box 内，
 * box 外画布恒 0——quantTruncBuf 不改 0（trunc(clamp(0)·255)=0），resample 任意窗口对 0 的
 * 响应恒 0（acc=0 → clip8(trunc(bias/2²²))=0；RGBA unpremultiply a=0 → rgb=0）。故只计算
 * 窗口与 box 相交的输出像素，其余写 0，与全画布结果逐位一致。src = box 尺寸 float64 RGBA
 * （1/255 网格）；premultiply 融合与 resample8bpc 同式；返回全尺寸 dw×dh×4（k/255）。 */
export function resampleImageSub(
  src: Float64Array, bw: number, bh: number,
  sw: number, sh: number,
  box: { x0: number, y0: number, x1: number, y1: number },
  dw: number, dh: number, kind: 'bilinear' | 'lanczos',
): Float64Array {
  const kernel = kind === 'bilinear' ? bilinear : lanczos;
  const roundBias = 1 << (PRECISION_BITS - 1);
  const cx = coefficients8(sw, dw, kernel, SUPPORT[kind]);
  const cy = coefficients8(sh, dh, kernel, SUPPORT[kind]);
  // 输出 range：窗口 [xmin,xmin+ksize) 与 box 相交的 o（窗口随 o 单调 → 连续区间）
  let ox0 = -1, ox1 = 0, oy0 = -1, oy1 = 0;
  for (let o = 0; o < dw; o++) {
    if (cx[o].xmin + cx[o].ksize > box.x0 && cx[o].xmin < box.x1) { if (ox0 < 0) ox0 = o; ox1 = o + 1; }
  }
  for (let o = 0; o < dh; o++) {
    if (cy[o].xmin + cy[o].ksize > box.y0 && cy[o].xmin < box.y1) { if (oy0 < 0) oy0 = o; oy1 = o + 1; }
  }
  const out = new Float64Array(dh * dw * 4);
  if (ox0 < 0 || oy0 < 0) return out;
  // 水平只需（垂直窗口 span ∩ box 行）内的行；列限 [ox0,ox1)，box 外 tap 恒 0 跳过
  const hy0 = Math.max(cy[oy0].xmin, box.y0);
  const hy1 = Math.min(cy[oy1 - 1].xmin + cy[oy1 - 1].ksize, box.y1);
  const ow = ox1 - ox0;
  const tmp = new Uint8Array(Math.max(0, hy1 - hy0) * ow * 4);
  for (let y = hy0; y < hy1; y++) {
    for (let o = ox0; o < ox1; o++) {
      const { xmin, ksize, kk } = cx[o];
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = 0; i < ksize; i++) {
        const w = kk[i];
        if (w === 0) continue;
        const xi = xmin + i;
        if (xi < box.x0 || xi >= box.x1) continue;
        const si = ((y - box.y0) * bw + (xi - box.x0)) * 4;
        const a8 = Math.round(src[si + 3] * 255);
        if (a8 === 0) continue;
        a0 += Math.trunc((Math.round(src[si] * 255) * a8 + 127) / 255) * w;
        a1 += Math.trunc((Math.round(src[si + 1] * 255) * a8 + 127) / 255) * w;
        a2 += Math.trunc((Math.round(src[si + 2] * 255) * a8 + 127) / 255) * w;
        a3 += a8 * w;
      }
      const di = ((y - hy0) * ow + (o - ox0)) * 4;
      tmp[di] = clip8(Math.trunc((a0 + roundBias) / (1 << PRECISION_BITS)));
      tmp[di + 1] = clip8(Math.trunc((a1 + roundBias) / (1 << PRECISION_BITS)));
      tmp[di + 2] = clip8(Math.trunc((a2 + roundBias) / (1 << PRECISION_BITS)));
      tmp[di + 3] = clip8(Math.trunc((a3 + roundBias) / (1 << PRECISION_BITS)));
    }
  }
  // vertical：只算 [oy0,oy1)×[ox0,ox1) 写全尺寸 out；窗口越过 [hy0,hy1) 的行贡献 0
  for (let o = oy0; o < oy1; o++) {
    const { xmin: ty0, ksize, kk } = cy[o];
    for (let x = ox0; x < ox1; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = 0; i < ksize; i++) {
        const w = kk[i];
        if (w === 0) continue;
        const yi = ty0 + i;
        if (yi < hy0 || yi >= hy1) continue;
        const si = ((yi - hy0) * ow + (x - ox0)) * 4;
        a0 += tmp[si] * w;
        a1 += tmp[si + 1] * w;
        a2 += tmp[si + 2] * w;
        a3 += tmp[si + 3] * w;
      }
      const di = (o * dw + x) * 4;
      out[di] = clip8(Math.trunc((a0 + roundBias) / (1 << PRECISION_BITS))) / 255;
      out[di + 1] = clip8(Math.trunc((a1 + roundBias) / (1 << PRECISION_BITS))) / 255;
      out[di + 2] = clip8(Math.trunc((a2 + roundBias) / (1 << PRECISION_BITS))) / 255;
      out[di + 3] = clip8(Math.trunc((a3 + roundBias) / (1 << PRECISION_BITS))) / 255;
    }
  }
  // unpremultiply（box 外恒 a=0 → rgb=0，全扫描与旧口径逐位一致）
  for (let i = 0; i < dw * dh; i++) {
    const a = Math.round(out[i * 4 + 3] * 255);
    if (a === 0) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.trunc(Math.round(out[i * 4 + c] * 255) * 255 / a) / 255;
    }
  }
  return out;
}
