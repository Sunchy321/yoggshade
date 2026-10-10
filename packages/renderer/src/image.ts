/** PNG 读写与双线性采样（对齐 py 侧两套采样语义）。
 *
 * 编解码依赖（ADR-0002 前端渲染改造）：渲染链要跑在浏览器里，node:zlib / pngjs
 * （全模块静态 require('zlib')、无 browser 字段）都进不了浏览器包——统一改 fflate
 * （纯 JS，bun/浏览器同字节）：解码 = chunk 解析 + unzlibSync + 手写 unfilter
 * （原 workerd 改造的管线不变，2026-10-09）；编码 = 手写 chunk + zlibSync（filter 0，
 * zlib 包装 deflate）。PNG 无损，换 deflate 实现只变字节不改像素；历史上「与 pngjs
 * 输出逐位一致」的字节级锚点自此作废，像素级 L2 判据不受影响。 */
import { unzlibSync, zlibSync } from 'fflate';
import type { RGBAImage } from './types.js';

const PNG_SIGNATURE = 0x89504e47;
const PNG_SIG_TAIL = 0x0d0a1a0a;
/** 单图解压前像素数护栏（ticket 17：最大合法资产 1024²，上限 4096² 挡解压炸弹——
 *  尺寸从 IHDR 直读，先于任何大分配）。 */
const MAX_PNG_PIXELS = 4096 * 4096;

/** PNG IHDR 预读：不解码、不 inflate、不做大分配，直读签名 + IHDR 宽高。
 *  站点原画入口（adapter.decodePortrait）用它先验后解码（ticket 17）。 */
export function peekPngSize(bytes: Uint8Array): { w: number, h: number } {
  if (bytes.length < 33) throw new Error('not a PNG (truncated)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== PNG_SIGNATURE || dv.getUint32(4) !== PNG_SIG_TAIL) {
    throw new Error('not a PNG (bad signature)');
  }
  if (dv.getUint32(12) !== 0x49484452) throw new Error('not a PNG (IHDR must be first chunk)');
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  if (w === 0 || h === 0) throw new Error(`invalid PNG dimensions ${w}x${h}`);
  return { w, h };
}

/** IHDR 色彩类型 → 通道数（0=灰度 2=RGB 3=调色板 4=灰+A 6=RGBA）。 */
function channelsOf(colorType: number): number {
  switch (colorType) {
  case 0: return 1;
  case 2: return 3;
  case 3: return 1; // 调色板索引
  case 4: return 2;
  case 6: return 4;
  default: throw new Error(`unsupported PNG color type ${colorType}`);
  }
}

/** Paeth 预测器（PNG spec: filter type 4）。 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG 字节 → RGBAImage（uint8 0..255）。内存路径（站点上传原画）与磁盘路径共用。
 *  支持 8-bit depth、非隔行、色型 0/2/3/4/6（含 PLTE/tRNS）。 */
export function decodePngBytes(bytes: Uint8Array): RGBAImage {
  const { w, h } = peekPngSize(bytes);
  if (w * h > MAX_PNG_PIXELS) {
    throw new Error(`PNG too large: ${w}x${h} (limit ${MAX_PNG_PIXELS} px)`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let depth = 0, colorType = 0, interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  let ended = false;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = dv.getUint32(pos + 4);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 0x49484452) {
      // IHDR body: w(4) h(4) depth(1) colorType(1) compression(1) filter(1) interlace(1)
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 0x504c5445) { // PLTE
      plte = body.slice();
    } else if (type === 0x54524e53) { // tRNS
      trns = body.slice();
    } else if (type === 0x49444154) { // IDAT
      idat.push(body);
      idatLen += len;
    } else if (type === 0x49454e44) { // IEND
      ended = true;
      break;
    }
    pos += 12 + len; // 长度 + 类型 + 数据 + CRC
  }
  if (!ended) throw new Error('PNG truncated (no IEND)');
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (interlace !== 0) throw new Error('unsupported PNG interlacing (Adam7)');
  const ch = channelsOf(colorType);

  // zlib 流 = 串接的全部 IDAT 一次 inflate（zlib 头在流内，跨 chunk 无缝）
  const z = new Uint8Array(idatLen);
  let off = 0;
  for (const part of idat) {
    z.set(part, off);
    off += part.length;
  }
  const stride = w * ch;
  const raw = unzlibSync(z);
  if (raw.length < (stride + 1) * h) throw new Error('PNG pixel data truncated');

  // 逐行 unfilter（PNG spec filter 0-4）；原地恢复采样值
  const img = new Uint8Array(w * h * ch);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ftype = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch]! : 0; // 左
      const b = prev[x]!; // 上
      const c = x >= ch ? prev[x - ch]! : 0; // 左上
      let v = row[x]!;
      switch (ftype) {
      case 0:
        break;
      case 1:
        v = (v + a) & 0xff;
        break;
      case 2:
        v = (v + b) & 0xff;
        break;
      case 3:
        v = (v + ((a + b) >> 1)) & 0xff;
        break;
      case 4:
        v = (v + paeth(a, b, c)) & 0xff;
        break;
      default:
        throw new Error(`unsupported PNG filter ${ftype}`);
      }
      row[x] = v;
      img[y * stride + x] = v;
    }
    prev.set(row);
  }

  // 展开 RGBA（pngjs 语义：非 alpha 色型 alpha=255；调色板 tRNS 缺省 255）
  const data = new Uint8ClampedArray(w * h * 4);
  if (colorType === 6) {
    data.set(img);
  } else if (colorType === 2) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = img[i * 3]!;
      data[i * 4 + 1] = img[i * 3 + 1]!;
      data[i * 4 + 2] = img[i * 3 + 2]!;
      data[i * 4 + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = img[i]!;
      data[i * 4 + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = img[i * 2]!;
      data[i * 4 + 3] = img[i * 2 + 1]!;
    }
  } else { // 3 = 调色板
    if (!plte) throw new Error('palette PNG missing PLTE');
    for (let i = 0; i < w * h; i++) {
      const idx = img[i]! * 3;
      data[i * 4] = plte[idx]!;
      data[i * 4 + 1] = plte[idx + 1]!;
      data[i * 4 + 2] = plte[idx + 2]!;
      data[i * 4 + 3] = trns && idx / 3 < trns.length ? trns[idx / 3]! : 255;
    }
  }
  return { w, h, data };
}

/** ---- PNG 编码（手写 chunk + fflate zlibSync）----
 * PNG chunk = len(BE) + type + data + crc32(type+data)。 */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** uint8 RGBA（h×w×4，行主序）→ PNG 字节（8-bit RGBA、filter 0 逐行、zlib 包装 deflate）。 */
export function encodePngBytes(w: number, h: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 每行前置 filter 字节 0（None）：无损、简单；体积略大于自适应滤波
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });
  const bytes = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = bytes.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bytes) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/**
 * scene_compiler.sample_bilinear 语义：px/py 先 clip 到 [0, w/h-1]，x1/y1 = min(x0+1, 边界)。
 * col/row 由调用方算好（col = u*w - 0.5，row = (1-v)*h - 0.5）。写入 out[0..3]。
 * 纹理存储为 uint8：读值 /255 —— 与历史「解码时预展开 float64」是同一个 IEEE 除法，
 * 双线性权重算式逐位相同（ticket 18）。
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
    const a = data[(y0 * w + x0) * 4 + c] / 255 * (1 - fx) + data[(y0 * w + x1) * 4 + c] / 255 * fx;
    const b = data[(y1 * w + x0) * 4 + c] / 255 * (1 - fx) + data[(y1 * w + x1) * 4 + c] / 255 * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/**
 * dz_portrait_layer.sample_bilinear 语义：clamp 到 [0, w-1.001]，x1/y1 = x0+1（不夹边界）。
 * u/v 是 UV（v 向上），函数内部做 (1-v)*h。uint8 读值 /255（同 sampleBilinearClamp 注）。
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
    const a = data[(y0 * w + x0) * 4 + c] / 255 * (1 - fx) + data[(y0 * w + x1) * 4 + c] / 255 * fx;
    const b = data[(y1 * w + x0) * 4 + c] / 255 * (1 - fx) + data[(y1 * w + x1) * 4 + c] / 255 * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}
