/** 字体度量与字形光栅化（PIL FreeType getmask2 语义的 TS 等价实现）。
 *
 * parity 说明：py 用 PIL/FreeType hinted 位图（bitmap_left/top/width/rows）+ fontTools hmtx。
 * TS 侧：hmtx/head/hhea 经 opentype.js；字形位图 = unhinted 轮廓 4×4 子采样 non-zero 填充。
 * 已知残差（py 作者自己登记）：Unity 走 FT hinted advance 有 ±1px_font 风险；TS unhinted
 * 位图与 PIL hinted 位图在 AA 边缘可能差 ±1——L1 回归里属可接受噪声。 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** Unity CharacterInfo 语义的 ink 框（int 字体像素）——布局判据专用（wrap/fit/underwear）。 */
export interface InkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Pt { x: number, y: number }

const SS = 8; // 每轴子采样数（64 级覆盖度，逼近 FreeType 256 级 AA）

/** opentype.Font 按文件去重（ticket 18）：getFontMetrics 每个字号档 new 一个 FontMetrics，
 * 同一 TTF（如 Belwe_Outline）会在 36/45/74 三档被重复 parse（5.7 MB 字体 ×3 ≈ 60+ MB
 * 驻留，实测 explore/2026-10-08-workers-mem-reduction 驻留曲线 141→165 MB 平台期）。
 * Font 对象只读（charToGlyph/getPath），跨 FontMetrics 共享安全；度量按 size 存实例。 */
const otFontCache = new Map<string, opentype.Font>();

function parseFontCached(ttfPath: string): opentype.Font {
  let font = otFontCache.get(ttfPath);
  if (!font) {
    const buf = readFileSync(ttfPath);
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    otFontCache.set(ttfPath, font);
  }
  return font;
}

/** 静态度量（hhea.ascender/descender + head.unitsPerEm）：assets/fonts/metrics.json
 *  （scripts/extract_fonts.py 产出）。FontMetrics 用它提供 ascent/descent/lineHeight 并把
 *  opentype.parse **推迟到首个真正需要 fallback 字形的 charInfo**——pack 字形全覆盖的卡
 *  不再把 5.7-7.3 MB TTF parse 成 opentype 对象（ticket 18 实测 dedupe 后仍 ~20 MB 驻留）。
 *  数值与 opentype.js 运行时同源同表（font.ascender=hhea.ascender、descender=hhea.descender、
 *  unitsPerEm=head.unitsPerEm；实证 Belwe 900/−124/1024、Franklin 502/−113/512），
 *  fixtures 字节门禁验证。文件/键缺失 → null → 回落即时 parse，行为不变。 */
interface FontStaticMetrics { ascender: number, descender: number, unitsPerEm: number }

const staticMetricsCache = new Map<string, FontStaticMetrics | null>();

function staticMetrics(ttfPath: string): FontStaticMetrics | null {
  const hit = staticMetricsCache.get(ttfPath);
  if (hit !== undefined) return hit;
  let out: FontStaticMetrics | null = null;
  try {
    const all = JSON.parse(readFileSync(join(dirname(ttfPath), 'metrics.json'), 'utf-8')) as
      Record<string, FontStaticMetrics>;
    out = all[basename(ttfPath)] ?? null;
  } catch {
    out = null;
  }
  staticMetricsCache.set(ttfPath, out);
  return out;
}

export class FontMetrics implements FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number; // ≤0
  readonly lineHeight: number;
  private ttfPath:     string;
  private _font:       opentype.Font | null = null;
  private upem:        number;
  private size:        number;
  private cache = new Map<string, { info: CharInfo, mask: GlyphMask }>();

  /** 惰性 parse：metrics.json 提供度量时，直到首个 pack-miss 字形才真正 parse TTF。 */
  private get font(): opentype.Font {
    if (!this._font) this._font = parseFontCached(this.ttfPath);
    return this._font;
  }

  advance(ch: string): number {
    return this.charInfo(ch).info.advance;
  }

  inkChar(ch: string): InkBounds {
    const { info } = this.charInfo(ch);
    return { minX: info.minX, maxX: info.maxX, minY: info.minY, maxY: info.maxY };
  }

  constructor(ttfPath: string, fontSize: number) {
    this.ttfPath = ttfPath;
    this.size = Math.trunc(fontSize);
    const st = staticMetrics(ttfPath);
    if (st) {
      this.upem = st.unitsPerEm;
      this.ascent = Math.ceil((st.ascender / this.upem) * this.size);
      this.descent = Math.floor((st.descender / this.upem) * this.size);
      // 行高 = round((asc−desc)×fs/upem)（Unity TextGenerator 口径）。旧 ceil(asc)−floor(desc)
      // 组合得 49（BG@40），但 resizeToFit 停档与基准断行（GDB_142 12/12/12/7、DMF 10/10/9/8
      // 逐字一致）只在 48（round(48.05)）下复现——行高与基线（ascent/descent）是两个量，
      // TextGenerator 的行进用 round 的整行高。explore/2026-10-06-text-align/findings.md §5。
      this.lineHeight = Math.round(((st.ascender - st.descender) / this.upem) * this.size);
    } else {
      const f = parseFontCached(ttfPath);
      this._font = f;
      this.upem = f.unitsPerEm;
      this.ascent = Math.ceil((f.ascender / this.upem) * this.size);
      this.descent = Math.floor((f.descender / this.upem) * this.size);
      this.lineHeight = Math.round(((f.ascender - f.descender) / this.upem) * this.size);
    }
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
  /** 布局判据用 ink 框（Unity CharacterInfo 语义，UB:3930 GetCharacterInfo）。
   *  与渲染用的 PIL 位图框分离：PIL 包横向存的是 advance 框（'1' minX=0/maxX=22=advance），
   *  不能作 ink；引擎 wrap/fit/underwear 判据全部按 TextMesh ink bounds 计。 */
  inkChar(ch: string): InkBounds;
}

interface PackGlyphMeta {
  line_height?: number;
  [cp: string]: unknown;
}

/** PIL 预格子缓存版（glyphs/{fontStem}-{fs}/，提取层 PIL/FreeType hinted 落盘 → 与 py 像素一致）。
 * 未命中字符回退 rasterized 实现。
 * shear > 0：斜体变体（<i> 跑字）——引擎对 FontStyle.Italic 由 FreeType 按剪切矩阵合成
 * 字形进图集（UB 全文无 italic 代码，TextMesh 原生；UberTextMgr.cs:73-74 双 style 请求），
 * advance 不变、字形按 x' = x + shear·(基线上高度) 剪切、CharacterInfo minX/maxX 随动
 * （docs/findings/ubertext-text-rendering-2026-10-06.md §3）。离线在 mask 加载时做等价
 * 双线性剪切；剪切常数 = tan(12°)（FreeType synthetic italic 经典角），三卡（BG30_802/
 * ETC_210/CATA_190h）斜体行 NCC 扫描实证 0.2126 最优（explore/2026-10-07-edge-align §10）。
 * 环境变量 YOGGRAPH_ITALIC_SHEAR 可覆盖（标定/实验用）。 */
export const ITALIC_SHEAR = Number(process.env.YOGGRAPH_ITALIC_SHEAR ?? 0.2126);

export class PackFontMetrics implements FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number;
  readonly lineHeight: number;
  private meta:        PackGlyphMeta | null = null;
  private cache = new Map<string, { info: CharInfo, mask: GlyphMask }>();

  constructor(private dir: string, fontStem: string, fontSize: number,
    private fallback: FontMetricsLike,
    private shear = 0) {
    // 行高用 fallback 的 round 口径（meta.line_height 是 py 提取层的 ceil/floor 口径=49，
    // 与引擎 TextGenerator 行高 48 不符——GDB_142 停档实证，见 font.ts 构造器注释）。
    this.ascent = fallback.ascent;
    this.descent = fallback.descent;
    this.lineHeight = fallback.lineHeight;
    try {
      this.meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')) as PackGlyphMeta;
    } catch {
      this.meta = null;
    }
    void fontStem;
    void fontSize;
  }

  private load(ch: string): { info: CharInfo, mask: GlyphMask } | null {
    if (!this.meta) return null;
    const m = this.meta[String(ch.codePointAt(0))] as
      { advance: number, minX: number, maxX: number, minY: number, maxY: number, w: number, h: number } | undefined;
    if (!m) return null;
    let png: import('pngjs').PNGWithMetadata;
    try {
      png = PNG.sync.read(readFileSync(join(this.dir, `${ch.codePointAt(0)}.png`)));
    } catch {
      // meta 幽灵条目（meta 有码位、PNG 缺失/损坏）：按「包内无此字形」处理，回退自研光栅。
      // 这与 meta 缺条目的既有语义一致——不改变任何可完成的渲染，只是把 ENOENT 崩溃修复掉。
      // 实证（拆包探查）：assets/glyphs/FranklinGothic-40 的 meta 含「伙/伴」条目而对应 PNG
      // 缺失（BG24_Reward_310 描述文本复现 font.ts:253 ENOENT，`bun run fixtures` 因此中断）；
      // Belwe_Outline-45 存在反向不一致（PNG 有而 meta 无 → 本就走 fallback）。
      // 缓存扩容与 miss 语义的正式裁定仍归 ticket 15。
      return null;
    }
    const data = new Float64Array(m.w * m.h);
    for (let i = 0; i < m.w * m.h; i++) data[i] = png.data[i * 4] / 255;
    const info: CharInfo = { advance: m.advance, minX: m.minX, maxX: m.maxX, minY: m.minY, maxY: m.maxY };
    let mask: GlyphMask = { w: m.w, h: m.h, data };
    if (this.shear > 0) {
      // 斜体：行位移 dx(r) = shear×(maxY − r − 0.5)（r = 自字形顶起的行号；基线上高度）。
      // 内容向**右**倾：输出 x 取源 (x − dx)（dx 在顶部最大）。advance 不变；
      // minX/maxX 随剪切外扩（引擎 CharacterInfo 同语义）。
      const leftPad = m.minY < 0 ? Math.ceil(-this.shear * m.minY) : 0;
      const rightPad = m.maxY > 0 ? Math.ceil(this.shear * m.maxY) : 0;
      const nw = m.w + leftPad + rightPad;
      const out = new Float64Array(nw * m.h);
      for (let r = 0; r < m.h; r++) {
        const dx = this.shear * (m.maxY - r - 0.5);
        for (let x = 0; x < m.w; x++) {
          const sx = x - dx; // 采样原 mask 列（内容右倾）
          const x0 = Math.floor(sx);
          const fx = sx - x0;
          const c0 = x0 >= 0 && x0 < m.w ? data[r * m.w + x0] : 0;
          const c1 = x0 + 1 >= 0 && x0 + 1 < m.w ? data[r * m.w + x0 + 1] : 0;
          out[r * nw + x + leftPad] = c0 * (1 - fx) + c1 * fx;
        }
      }
      info.minX -= leftPad;
      info.maxX += rightPad;
      mask = { w: nw, h: m.h, data: out };
    }
    return { info, mask };
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

  /** ink 框：优先 PIL 包度量（glyphs/ 提取层 = 引擎 RequestCharactersInTexture 直采的
   *  CharacterInfo，含 Unity 图集 padding——'每' 0..40 全宽框，比 opentype ink 宽 ~3fp；
   *  wrap/fit 的停档临界对此敏感，GDB_142 差一档即由此来）。无包字符回退 opentype ink。 */
  inkChar(ch: string): InkBounds {
    const m = this.meta?.[String(ch.codePointAt(0))] as
      { minX: number, maxX: number, minY: number, maxY: number } | undefined;
    if (m) return { minX: m.minX, maxX: m.maxX, minY: m.minY, maxY: m.maxY };
    return this.fallback.inkChar(ch);
  }
}
