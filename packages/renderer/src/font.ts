/** 字体度量与字形来源（ticket 15 Answer：FreeType WASM 直渲，TTF 即字形源）。
 *
 * 历史：py 黄金链用 PIL/FreeType（hinted）；TS 曾用 opentype.js 轮廓 + 自研 unhinted
 * 光栅（MAE 23-36/255）作兜底、并靠「提取字形」预烘 PNG 对冲。2026-10-09 起改用
 * FreeType WASM（@zkl2333/freetype-wasm，FreeType 2.14.3 = PIL 环境同版本）直接渲染
 * TTF：位图与 PIL 同源、无提取环节、任意字符现渲；度量/装框语义与旧 meta 逐项对齐
 * （freetype-metrics.ts 头注释），fixtures 40/40 逐像素一致实证。
 *
 * TTF 经 AssetSource 读取：CLI/本地 = 资产包内（assets/fonts/**）；Workers = 部署资产。
 * 缺失 → TtfMissingError → 站点层映射 400（fail-fast）。
 */
import type { AssetSource } from './source.js';
import { FreeTypeWasmMetrics, TtfMissingError } from './freetype-metrics.js';

export { TtfMissingError };

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
  data: Float64Array; // 0..1（uint8 级量化）
}

/** Unity CharacterInfo 语义的 ink 框（int 字体像素）——布局判据专用（wrap/fit/underwear）。 */
export interface InkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 斜体字形系数：tan(12°)（FreeType synthetic italic 经典角）。三卡（BG30_802/
 * ETC_210/CATA_190h）斜体行 NCC 扫描实证 0.2126 最优（explore/2026-10-07-edge-align §10）。
 * 环境变量 YOGGRAPH_ITALIC_SHEAR 可覆盖（CLI/标定用；浏览器无 process，经
 * globalThis 可选链取默认——ADR-0002 前端渲染）。 */
export const ITALIC_SHEAR = Number(globalThis.process?.env.YOGGRAPH_ITALIC_SHEAR ?? 0.2126);

/** 字形度量提供方接口（渲染与布局判据共用）。 */
export interface FontMetricsLike {
  readonly ascent:     number;
  readonly descent:    number; // ≤0
  readonly lineHeight: number;
  charInfo(ch: string): { info: CharInfo, mask: GlyphMask };
  advance(ch: string): number;
  /** ink 框（Unity CharacterInfo 语义，UB:3930 GetCharacterInfo）——wrap/fit/underwear
   *  判据全部按 ink bounds 计。 */
  inkChar(ch: string): InkBounds;
}

export class FreeTypeMetrics extends FreeTypeWasmMetrics {}

/** (src, ttfKey, fs, shear) → FontMetricsLike 的便捷别名（供 ubertext 构造）。 */
export function createFontMetrics(src: AssetSource, ttfKey: string, fs: number, shear = 0): FontMetricsLike {
  return FreeTypeWasmMetrics.create(src, ttfKey, fs, shear);
}
