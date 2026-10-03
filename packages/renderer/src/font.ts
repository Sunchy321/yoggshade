/** 字体度量与字形光栅化（PIL FreeType getmask2 语义的 TS 等价实现）。
 *
 * parity 说明：py 用 PIL/FreeType hinted 位图（bitmap_left/top/width/rows）+ fontTools hmtx。
 * TS 侧：hmtx/head/hhea 经 opentype.js；字形位图 = unhinted 轮廓 4×4 子采样 non-zero 填充。
 * 已知残差（py 作者自己登记）：Unity 走 FT hinted advance 有 ±1px_font 风险；TS unhinted
 * 位图与 PIL hinted 位图在 AA 边缘可能差 ±1——L1 回归里属可接受噪声。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as opentype from 'opentype.js';
import { PNG } from 'pngjs';

export interface CharInfo {
  advance: number;
  minX:    number;
  maxX:    number;
  minY:    number;
  maxY:    number;
}

export interface GlyphMask {
  w:    number;
  h:    number;
  data: Float64Array; // 0..1（已按 uint8 级量化）
}

interface Pt { x: number, y: number }

const SS = 8; // 每轴子采样数（64 级覆盖度，逼近 FreeType 256 级 AA）

export class FontMetrics implements FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number; // ≤0
  readonly lineHeight: number;
  private font:        opentype.Font;
  private upem:        number;
  private size:        number;
  private cache = new Map<string, { info: CharInfo, mask: GlyphMask }>();

  advance(ch: string): number {
    return this.charInfo(ch).info.advance;
  }

  constructor(ttfPath: string, fontSize: number) {
    const buf = readFileSync(ttfPath);
    this.font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    this.size = Math.trunc(fontSize);
    this.upem = this.font.unitsPerEm;
    this.ascent = Math.ceil((this.font.ascender / this.upem) * this.size);
    this.descent = Math.floor((this.font.descender / this.upem) * this.size);
    this.lineHeight = this.ascent - this.descent;
  }

  charInfo(ch: string): { info: CharInfo, mask: GlyphMask } {
    const hit = this.cache.get(ch);
    if (hit) return hit;
    const glyph = this.font.charToGlyph(ch);
    const advance = Math.round((glyph.advanceWidth * this.size) / this.upem);
    const rawPath = glyph.getPath(0, 0, this.size); // y-down px，基线 y=0
    // 简易 auto-hint：轮廓坐标取整到像素网格（近似 FreeType grid-fitting 的贴格效果；
    // 无法执行 TrueType 字节码，横竖笔画对齐由取整达成，斜/曲边保留 AA）
    const cmds = rawPath.commands.map(c => {
      const o: Record<string, number | string> = { type: c.type };
      for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2'] as const) {
        const v = (c as unknown as Record<string, number | undefined>)[k];
        if (typeof v === 'number') o[k] = Math.round(v);
      }
      return o;
    }) as unknown as import('opentype.js').PathCommand[];
    let out: { info: CharInfo, mask: GlyphMask };
    if (!rawPath.commands.length) {
      out = { info: { advance, minX: 0, maxX: 0, minY: 0, maxY: 0 },
        mask: { w: 1, h: 1, data: new Float64Array(1) } };
    } else {
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const c of cmds) {
        for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2'] as const) {
          const v = (c as unknown as Record<string, number | undefined>)[k];
          if (typeof v === 'number') {
            if (k.startsWith('x')) {
              xMin = Math.min(xMin, v);
              xMax = Math.max(xMax, v);
            } else {
              yMin = Math.min(yMin, v);
              yMax = Math.max(yMax, v);
            }
          }
        }
      }
      const x0 = xMin;
      const topUp = -yMin; // bitmap_top（整数）
      const w = Math.max(1, xMax - x0);
      const h = Math.max(1, topUp + yMax); // topUp − (−yMax)
      const edges = flattenEdges(cmds);
      const data = new Float64Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          let inside = 0;
          for (let sy = 0; sy < SS; sy++) {
            const py = (r - topUp) + (sy + 0.5) / SS;
            for (let sx = 0; sx < SS; sx++) {
              const px = x0 + c + (sx + 0.5) / SS;
              if (windingInside(edges, px, py)) inside++;
            }
          }
          // PIL mask 为 uint8：量化到 8bit（py 侧 mask/255 同口径）
          data[r * w + c] = Math.round((inside / (SS * SS)) * 255) / 255;
        }
      }
      out = { info: { advance, minX: x0, maxX: x0 + w, minY: topUp - h, maxY: topUp },
        mask: { w, h, data } };
    }
    this.cache.set(ch, out);
    return out;
  }
}

/** 路径命令 → 边段（二次曲线细分）。 */
function flattenEdges(commands: opentype.PathCommand[]): [Pt, Pt][] {
  const edges: [Pt, Pt][] = [];
  const N = 16;
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  for (const cmd of commands) {
    switch (cmd.type) {
    case 'M':
      cur = { x: cmd.x, y: cmd.y };
      start = cur;
      break;
    case 'L':
      edges.push([cur, { x: cmd.x, y: cmd.y }]);
      cur = { x: cmd.x, y: cmd.y };
      break;
    case 'C': {
      const p0 = cur;
      for (let i = 1; i <= N; i++) {
        const t = i / N, mt = 1 - t;
        const x = mt * mt * mt * p0.x + 3 * mt * mt * t * (cmd as { x1: number }).x1
          + 3 * mt * t * t * (cmd as { x2: number }).x2 + t * t * t * cmd.x;
        const y = mt * mt * mt * p0.y + 3 * mt * mt * t * (cmd as { y1: number }).y1
          + 3 * mt * t * t * (cmd as { y2: number }).y2 + t * t * t * cmd.y;
        edges.push([cur, { x, y }]);
        cur = { x, y };
      }
      break;
    }
    case 'Q': {
      const p0 = cur;
      for (let i = 1; i <= N; i++) {
        const t = i / N, mt = 1 - t;
        const x = mt * mt * p0.x + 2 * mt * t * (cmd as { x1: number }).x1 + t * t * cmd.x;
        const y = mt * mt * p0.y + 2 * mt * t * (cmd as { y1: number }).y1 + t * t * cmd.y;
        edges.push([cur, { x, y }]);
        cur = { x, y };
      }
      break;
    }
    case 'Z':
      if (cur.x !== start.x || cur.y !== start.y) edges.push([cur, start]);
      cur = start;
      break;
    }
  }
  return edges;
}

/** non-zero 缠绕数内点测试（+x 射线）。 */
function windingInside(edges: [Pt, Pt][], px: number, py: number): boolean {
  let winding = 0;
  for (const [a, b] of edges) {
    if ((a.y > py) !== (b.y > py)) {
      const xint = a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (px < xint) winding += b.y > a.y ? 1 : -1;
    }
  }
  return winding !== 0;
}

/** 字形度量提供方（自研光栅化 / PIL 预格子缓存 共用接口）。 */
export interface FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number;
  readonly lineHeight: number;
  charInfo(ch: string): { info: CharInfo, mask: GlyphMask };
  advance(ch: string): number;
}

interface PackGlyphMeta {
  line_height?: number;
  [cp: string]: unknown;
}

/** PIL 预格子缓存版（glyphs/{fontStem}-{fs}/，提取层 PIL/FreeType hinted 落盘 → 与 py 像素一致）。
 * 未命中字符回退 rasterized 实现。 */
export class PackFontMetrics implements FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number;
  readonly lineHeight: number;
  private meta:        PackGlyphMeta | null = null;
  private cache = new Map<string, { info: CharInfo, mask: GlyphMask }>();

  constructor(private dir: string, fontStem: string, fontSize: number,
    private fallback: FontMetrics) {
    this.ascent = fallback.ascent;
    this.descent = fallback.descent;
    this.lineHeight = fallback.lineHeight;
    try {
      this.meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')) as PackGlyphMeta;
      if (typeof this.meta['line_height'] === 'number') {
        this.lineHeight = this.meta['line_height'] as number;
      }
    } catch {
      this.meta = null;
    }
    void fontStem;
  }

  private load(ch: string): { info: CharInfo, mask: GlyphMask } | null {
    if (!this.meta) return null;
    const m = this.meta[String(ch.codePointAt(0))] as
      { advance: number, minX: number, maxX: number, minY: number, maxY: number, w: number, h: number } | undefined;
    if (!m) return null;
    const png = PNG.sync.read(readFileSync(join(this.dir, `${ch.codePointAt(0)}.png`)));
    const data = new Float64Array(m.w * m.h);
    for (let i = 0; i < m.w * m.h; i++) data[i] = png.data[i * 4] / 255;
    return { info: { advance: m.advance, minX: m.minX, maxX: m.maxX, minY: m.minY, maxY: m.maxY },
      mask: { w: m.w, h: m.h, data } };
  }

  charInfo(ch: string): { info: CharInfo, mask: GlyphMask } {
    const hit = this.cache.get(ch);
    if (hit) return hit;
    const loaded = this.load(ch);
    const out = loaded ?? this.fallback.charInfo(ch);
    this.cache.set(ch, out);
    return out;
  }

  advance(ch: string): number {
    return this.charInfo(ch).info.advance;
  }
}
