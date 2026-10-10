/** FreeType WASM 字形度量（ticket 15 Answer：预提取字形退役，字体直渲）。
 *
 * 为什么：像素级还原游戏文字需要 FreeType 的 hinted 光栅化 + Unity 口径的字符度量，
 * JS 生态没有 FreeType；此前用提取字形（PIL 预烘 PNG）绕开——但提取链对 Pillow 版本
 * 敏感（Pillow 12 的 ImagingCore buffer 布局变化使 T1 扩容写入的字形为条纹噪声，
 * 2026-10-09 实测）。FreeType WASM（@zkl2333/freetype-wasm，FreeType 2.14.3 与
 * PIL 环境同版本）直接渲染 TTF。
 *
 * 语义对齐（与旧 PackFontMetrics/meta 口径逐项对齐——首版实现曾把纵向映射写反
 * （maxY = pilAscent − bitmapTop），导致全字下移 26px、fit 档位漂移，2026-10-09 修正）：
 *   mask      = FT 紧油墨框（hinted 轮廓，LOAD_DEFAULT|NO_BITMAP + RENDER_NORMAL）；
 *   minX      = bitmap_left（油墨绝对位置 = 旧盒内 ink 位于 bitmap_left，等价）；
 *   maxX      = minX + w；
 *   maxY      = bitmap_top（== 旧 meta.maxY：PIL oy = pilAscent − bitmap_top，
 *               meta.maxY = pilAscent − oy = bitmap_top，逐字符实证 每 33==33）；
 *   minY      = maxY − rows；
 *   advance   = round(metrics.horiAdvance / 64)（**无 hinting 线性值**：hinted advance
 *               与旧 hmtx 线性口径差 ±px 会漂移笔位/断行，故二次 NO_HINTING 加载取线性）；
 *   inkChar   = [0, advance] × [minY, maxY]（旧 PIL 盒 = advance 全宽，fit/wrap 停档
 *               判据按它校准——GDB_142 停档实证）。
 * 初始化：`initFreeTypeBackend` 必须在首次渲染前 await（renderPackToRgba8/renderCard
 * 入口调用）。wasm 二进制：默认由包内 locateFile 解析（Bun/Node）；Workers 传
 * `wasmBinary`（部署资产 pack/fonts/freetype.wasm）。TTF 缺失（未部署字体）→
 * TtfMissingError → 站点层映射 400（fail-fast，ticket 15）。 */
import type { AssetSource } from './source.js';
import { KeyMissingError } from './source.js';
import type { CharInfo, FontMetricsLike, GlyphMask, InkBounds } from './font.js';

type FTLib = any;
// FreeType load/render 常量（freetype.h 稳定 ABI 值）
const FT_LOAD_DEFAULT = 0;
const FT_LOAD_NO_BITMAP = 2;
const FT_LOAD_NO_HINTING = 4;
const FT_RENDER_MODE_NORMAL = 0;
let library: FTLib | null = null;
let initPromise: Promise<void> | null = null;

/** fallback 需要 opentype 而 TTF 不在源内（Workers 无字体包）时抛——站点映射 400。 */
export class TtfMissingError extends Error {
  char?: string;
  constructor(public readonly key: string, char?: string) {
    super(`font ttf not available in asset source: ${key}${char ? ` (char U+${char.codePointAt(0)!.toString(16)} '${char}')` : ''}`);
    this.name = 'TtfMissingError';
    this.char = char;
  }
}

export function initFreeTypeBackend(opts: { wasmBinary?: Uint8Array } = {}): Promise<void> {
  if (library) return Promise.resolve();
  // 动态引入 @zkl2333/freetype-wasm（emscripten 胶水）：bun 与浏览器都是一等环境。
  // wasmBinary 由调用方注入——CLI 靠包内 locateFile，浏览器经资产源取 pack/fonts/freetype.wasm
  // （renderPackToRgba8 传入；ADR-0002 前端渲染，workerd 补丁胶水链路整体退役）
  initPromise ??= (async () => {
    const mod = await import('@zkl2333/freetype-wasm');
    library = await mod.default(opts);
  })();
  return initPromise;
}
export class FreeTypeWasmMetrics implements FontMetricsLike {
  // 实例经静态 create 工厂构造（Face 建构需要 TTF 字节与度量推导）；本类亦可被继承。

  readonly ascent:     number;
  readonly descent:    number; // ≤0
  readonly lineHeight: number;
  private cache = new Map<string, { info: CharInfo, mask: GlyphMask }>();
  protected facePtr:   ReturnType<FTLib['newFace']> | null = null;

  protected constructor(private src: AssetSource, private key: string, private fs: number,
    private shear = 0) {
    const face = library!.newFace(src.bytes(key));
    face.setPixelSize(fs);
    this.facePtr = face;
    const info = face.info();
    const upem = info.unitsPerEM;
    this.ascent = Math.ceil((info.ascender / upem) * fs);
    this.descent = Math.floor((info.descender / upem) * fs);
    // 行高 = round((asc−desc)×fs/upem)（Unity TextGenerator 口径，见旧 FontMetrics 注释）
    this.lineHeight = Math.round(((info.ascender - info.descender) / upem) * fs);
  }

  static create(src: AssetSource, key: string, fs: number, shear = 0): FreeTypeWasmMetrics {
    return new FreeTypeWasmMetrics(src, key, fs, shear);
  }

  protected face(): ReturnType<FTLib['newFace']> {
    if (!this.facePtr) throw new Error('FreeType face not initialized');
    return this.facePtr;
  }

  charInfo(ch: string): { info: CharInfo, mask: GlyphMask } {
    const hit = this.cache.get(ch);
    if (hit) return hit;
    const cp = ch.codePointAt(0)!;
    // 位图 = hinted 轮廓渲染（NO_BITMAP 强制轮廓：字体带内嵌位图 strike，DEFAULT 会命中
    // 1bpp strike → RenderGlyph 0x62，且旧「提取条纹噪声」同源）
    let g: ReturnType<ReturnType<FTLib['newFace']>['loadGlyph']>;
    try {
      g = this.face().loadGlyph({
        char:       cp,
        flags:      FT_LOAD_DEFAULT | FT_LOAD_NO_BITMAP,
        render:     true,
        renderMode: FT_RENDER_MODE_NORMAL,
      });
    } catch (e) {
      if (e instanceof KeyMissingError) throw new TtfMissingError(this.key, ch);
      throw new Error(`FT loadGlyph '${ch}' (U+${cp.toString(16)}) in ${this.key}@${this.fs}: ${(e as Error).message}`, { cause: e });
    }
    // advance = 线性值（与旧 int(round(hmtx×fs/upem)) 同式）：NO_HINTING 加载的 metrics
    // 即无约束线性 26.6——hinted advance 会漂移笔位/断行（2026-10-09 实测）
    const gl = this.face().loadGlyph({ char: cp, flags: FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP });
    const advance = Math.round(gl.metrics.horiAdvance / 64);
    const info: CharInfo = {
      advance,
      minX: g.bitmapLeft,
      maxX: g.bitmapLeft + g.width,
      maxY: g.bitmapTop, // == 旧 meta.maxY（见头注释）
      minY: g.bitmapTop - g.rows,
    };
    const mask: GlyphMask = g.width > 0 && g.rows > 0
      ? { w: g.width, h: g.rows, data: Float64Array.from(g.buffer, (b: number) => b / 255) }
      : { w: 1, h: 1, data: new Float64Array(1) }; // 空白字符：1×1 空位图（旧提取同语义）
    const out = { info, mask };
    const sheared = this.shear > 0 ? this.applyShear(out.info, out.mask) : out;
    this.cache.set(ch, sheared);
    return sheared;
  }

  /** 斜体剪切：与旧 PackFontMetrics.load 完全同式（行位移双线性，advance 不变）。 */
  private applyShear(info: CharInfo, mask: GlyphMask): { info: CharInfo, mask: GlyphMask } {
    const leftPad = info.minY < 0 ? Math.ceil(-this.shear * info.minY) : 0;
    const rightPad = info.maxY > 0 ? Math.ceil(this.shear * info.maxY) : 0;
    const nw = mask.w + leftPad + rightPad;
    const out = new Float64Array(nw * mask.h);
    for (let r = 0; r < mask.h; r++) {
      const dx = this.shear * (info.maxY - r - 0.5);
      for (let x = 0; x < mask.w; x++) {
        const sx = x - dx;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const c0 = x0 >= 0 && x0 < mask.w ? mask.data[r * mask.w + x0]! : 0;
        const c1 = x0 + 1 >= 0 && x0 + 1 < mask.w ? mask.data[r * mask.w + x0 + 1]! : 0;
        out[r * nw + x + leftPad] = c0 * (1 - fx) + c1 * fx;
      }
    }
    return {
      info: { ...info, minX: info.minX - leftPad, maxX: info.maxX + rightPad },
      mask: { w: nw, h: mask.h, data: out },
    };
  }

  advance(ch: string): number {
    return this.charInfo(ch).info.advance;
  }

  /** ink 框 = 旧 PIL 盒口径 [0, advance] × [maxY−h, maxY]——wrap/fit 停档判据按它校准
   *  （GDB_142 停档实证；紧油墨框会使档位漂移）。 */
  inkChar(ch: string): InkBounds {
    const { info } = this.charInfo(ch);
    return { minX: 0, maxX: info.advance, minY: info.maxY - this.charInfo(ch).mask.h, maxY: info.maxY };
  }
}
