/** Pillow ImagingResample 风格的可分离重采样（BILINEAR / LANCZOS）。 */
type Kernel = (x: number) => number;

const bilinear: Kernel = (x) => (Math.abs(x) <= 1 ? 1 - Math.abs(x) : 0);
const lanczos: Kernel = (x) => {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};
const SUPPORT = { bilinear: 1, lanczos: 3 };

/** 单轴系数表（Pillow ImagingResample 语义）：
 * filterscale = max(1, in/out)；输入侧窗半径 = support×filterscale；核自变量除以 filterscale。
 * （上采样窗= support 不放大，下采样按比例展宽做面积加权——修前写反导致整体过糊。） */
function coefficients(inN: number, outN: number, kernel: Kernel, support: number): Float64Array[] {
  const sscale = inN / outN;
  const fscale = sscale > 1 ? sscale : 1;
  const supportIn = support * fscale;
  const out: Float64Array[] = [];
  for (let o = 0; o < outN; o++) {
    const center = ((o + 0.5) * inN) / outN - 0.5;
    const xmin = Math.max(0, Math.ceil(center - supportIn));
    const xmax = Math.min(inN - 1, Math.floor(center + supportIn));
    const co = new Float64Array(xmax - xmin + 2);   // [xmin, weights..., 0]
    co[0] = xmin;
    let sum = 0;
    for (let i = 0; i <= xmax - xmin; i++) {
      const w = kernel((xmin + i - center) / fscale);
      co[i + 1] = w;
      sum += w;
    }
    if (sum !== 0) for (let i = 1; i < co.length; i++) co[i] /= sum;
    out.push(co);
  }
  return out;
}

/** 交错多通道 float 图像（h*w*ch，0..1）重采样；quantize=true 时输出按 uint8 级量化
 * （对齐 PIL uint8 图像往返：输入需已量化，输出 round 到 8bit）。 */
export function resampleImage(
  src: Float64Array, sw: number, sh: number, ch: number,
  dw: number, dh: number, kind: "bilinear" | "lanczos", quantize: boolean,
): Float64Array {
  const kernel = kind === "bilinear" ? bilinear : lanczos;
  const support = SUPPORT[kind];

  // horizontal
  const cx = coefficients(sw, dw, kernel, support);
  const tmp = new Float64Array(sh * dw * ch);
  for (let y = 0; y < sh; y++) {
    for (let o = 0; o < dw; o++) {
      const co = cx[o];
      const x0 = co[0];
      const acc = new Float64Array(ch);
      for (let i = 1; i < co.length; i++) {
        const w = co[i];
        if (w === 0) continue;
        const si = (y * sw + (x0 + i - 1)) * ch;
        for (let c = 0; c < ch; c++) acc[c] += src[si + c] * w;
      }
      const di = (y * dw + o) * ch;
      for (let c = 0; c < ch; c++) tmp[di + c] = acc[c];
    }
  }
  // vertical
  const cy = coefficients(sh, dh, kernel, support);
  const out = new Float64Array(dh * dw * ch);
  for (let o = 0; o < dh; o++) {
    const co = cy[o];
    const y0 = co[0];
    for (let x = 0; x < dw; x++) {
      const acc = new Float64Array(ch);
      for (let i = 1; i < co.length; i++) {
        const w = co[i];
        if (w === 0) continue;
        const si = ((y0 + i - 1) * dw + x) * ch;
        for (let c = 0; c < ch; c++) acc[c] += tmp[si + c] * w;
      }
      const di = (o * dw + x) * ch;
      for (let c = 0; c < ch; c++) {
        let v = acc[c];
        if (quantize) v = Math.round(Math.min(Math.max(v, 0), 1) * 255) / 255;
        out[di + c] = v;
      }
    }
  }
  return out;
}
