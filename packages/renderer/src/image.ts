/** PNG 读写与双线性采样（对齐 py 侧两套采样语义）。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { RGBAImage } from './types.js';

/** PNG 字节 → RGBAImage（值域 0..1）。内存路径（站点上传原画）与磁盘路径共用。 */
export function decodePngBytes(bytes: Uint8Array): RGBAImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  const { width: w, height: h, data } = png;
  const out = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) out[i] = data[i] / 255;
  return { w, h, data: out };
}

export function decodePng(path: string): RGBAImage {
  return decodePngBytes(readFileSync(path));
}

/** uint8 RGBA（h×w×4，行主序）→ PNG 字节。 */
export function encodePngBytes(w: number, h: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  const png = new PNG({ width: w, height: h });
  png.data.set(rgba);
  return new Uint8Array(PNG.sync.write(png)) as Uint8Array<ArrayBuffer>;
}

/** uint8 RGBA（h×w×4，行主序）→ PNG。 */
export function encodePng(path: string, w: number, h: number, rgba: Uint8Array): void {
  writeFileSync(path, encodePngBytes(w, h, rgba));
}

/**
 * scene_compiler.sample_bilinear 语义：px/py 先 clip 到 [0, w/h-1]，x1/y1 = min(x0+1, 边界)。
 * col/row 由调用方算好（col = u*w - 0.5，row = (1-v)*h - 0.5）。写入 out[0..3]。
 */
export function sampleBilinearClamp(img: RGBAImage, px: number, py: number, out: Float64Array): void {
  const { w, h, data } = img;
  const x = Math.min(Math.max(px, 0), w - 1);
  const y = Math.min(Math.max(py, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
    const b = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/**
 * dz_portrait_layer.sample_bilinear 语义：clamp 到 [0, w-1.001]，x1/y1 = x0+1（不夹边界）。
 * u/v 是 UV（v 向上），函数内部做 (1-v)*h。
 */
export function sampleBilinearClamp001(
  img: RGBAImage, u: number, v: number, out: Float64Array,
): void {
  const { w, h, data } = img;
  const x = Math.min(Math.max(u * w - 0.5, 0), w - 1.001);
  const y = Math.min(Math.max((1 - v) * h - 0.5, 0), h - 1.001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
    const b = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}
