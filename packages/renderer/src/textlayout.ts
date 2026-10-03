/** UberText 布局引擎（uber_text.py 布局段逐行对译；纯逻辑，无字体依赖之外的 IO）。 */
import type { FontMetricsLike } from './font.js';

export const CHARACTER_SIZE_SCALE = 0.01; // UB:109
export const RESIZE_SHRINK = 0.95; // UB ReduceText_CharSize:2423
export const RESIZE_MAX_ITERS = 40; // UB:2421
export const BOLD_SIZE_CAP = 10.0; // UB Bold():2690

// CanWrapBetween（UB:3949-4107）zhCN 生效分支
const WRAP_AFTER_FORBIDDEN = new Set([
  36, 40, 91, 92, 123, 8216, 8220, 8245,
  12296, 12298, 12300, 12302, 12304, 12308, 12317,
  65113, 65115, 65117, 65284, 65288, 65339, 65371, 65505, 65509, 65510,
]);
const WRAP_BEFORE_FORBIDDEN = new Set([
  33, 37, 41, 44, 46, 58, 59, 63, 93, 125, 176, 183,
  8211, 8212, 8217, 8221, 8226, 8230, 8231, 8242, 8243, 8451,
  12289, 12290, 12297, 12299, 12301, 12303, 12305, 12309, 12318, 12540,
  65072, 65104, 65105, 65106, 65108, 65109, 65110, 65111,
  65114, 65116, 65118, 65281, 65285, 65289, 65292, 65294,
  65306, 65307, 65311, 65341, 65373, 65392, 65438, 65439, 65504,
]);
const WRAP_CJK_RANGES: [number, number][] = [
  [4352, 4607], [12288, 55215], [63744, 64255], [65280, 65439], [65440, 65500],
];

function isCjk(cp: number): boolean {
  return WRAP_CJK_RANGES.some(([lo, hi]) => lo <= cp && cp <= hi);
}

export function canWrapBetween(lastCp: number, wideCp: number, _nextCp: number): boolean {
  if (lastCp === 45) return !(48 <= wideCp && wideCp <= 57);
  if (lastCp === 59) return true;
  if (wideCp === 124) return true;
  if (/\s/.test(String.fromCodePoint(lastCp))) return false;
  if (/\s/.test(String.fromCodePoint(wideCp))) return true;
  if (WRAP_AFTER_FORBIDDEN.has(lastCp)) return false;
  if (WRAP_BEFORE_FORBIDDEN.has(wideCp)) return false;
  if (lastCp === 12290 || lastCp === 65292) return true;
  return isCjk(wideCp);
}

export function splitRich(text: string): { plain: string, bold: boolean[] } {
  const chars: string[] = [];
  const bold: boolean[] = [];
  let cur = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<b>', i)) {
      cur = true;
      i += 3;
      continue;
    }
    if (text.startsWith('</b>', i)) {
      cur = false;
      i += 4;
      continue;
    }
    if (text[i] === '<') {
      const j = text.indexOf('>', i);
      if (j !== -1) {
        i = j + 1;
        continue;
      }
    }
    chars.push(text[i]);
    bold.push(cur);
    i++;
  }
  return { plain: chars.join(''), bold };
}

export function breakIntoWords(
  text: string, fm: FontMetricsLike, k: number, _container: number,
): string[] {
  const words: string[] = [];
  let buf = text[0];
  let _num = fm.advance(text[0]) * k;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    _num += fm.advance(c) * k;
    const lastCp = text.codePointAt(i - 1)!;
    const wideCp = c.codePointAt(0)!;
    const nextCp = i < text.length - 1 ? text.codePointAt(i + 1)! : 0;
    if (canWrapBetween(lastCp, wideCp, nextCp)) {
      words.push(buf);
      buf = c;
      _num = fm.advance(c) * k;
    } else {
      buf += c; // m_ForceWrapLargeWords=0（zhCN）：num 与 container 不比较，继续粘
    }
  }
  words.push(buf);
  return words;
}

/** TextMesh bounds x = xMin₀ + (n−1)×adv + xMax_last。 */
export function lineMeshWidth(line: string, fm: FontMetricsLike, k: number): number {
  if (!line) return 0;
  const i0 = fm.charInfo(line[0]).info;
  const il = fm.charInfo(line[line.length - 1]).info;
  let inner = 0;
  for (const c of line.slice(0, -1)) inner += fm.advance(c);
  return (i0.minX + inner + il.maxX) * k;
}

export function lineAdvanceWidth(line: string, fm: FontMetricsLike, k: number): number {
  let s = 0;
  for (const c of line) s += fm.advance(c);
  return s * k;
}

export function wrapLines(
  text: string, fm: FontMetricsLike, k: number, width: number, height: number,
  lineSpacing: number, underwear: { w: number, h: number } | null,
): string[] {
  const words = breakIntoWords(text, fm, k, width);
  const underW = underwear ? width * (1.0 - underwear.w) : null;
  const underH = underwear ? height * underwear.h : null;
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const cand = cur + w;
    const x = lineMeshWidth(cand, fm, k);
    let container = width;
    if (underH !== null) {
      const nDone = lines.length ? lines.length + 1 : 0;
      const y = nDone
        ? ((nDone - 1) * fm.lineHeight * lineSpacing + fm.lineHeight) * k
        : 0.0;
      if (y - (height - y) * 0.2 < underH) container = underW!;
    }
    if (x < container) {
      cur = cand;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface LaidGlyph { ch: string, penX: number, bold: boolean }
export interface Layout {
  lines:        LaidGlyph[][];
  lineWidths:   number[];
  pitch:        number;
  boxH:         number;
  fs:           number;
  k:            number;
  lineHeightPx: number;
}

export interface TextFields {
  f(key: string, d?: number): number;
  f(key: string, d?: number | null): number | null;
}

/** 字段读取器：py ns.f(key, default)（None 透传）。 */
export function fieldGetter(fields: Record<string, unknown>) {
  return (key: string, d: number | null = null): number | null => {
    const v = fields[key];
    return typeof v === 'number' ? v : d;
  };
}

export interface LayoutInputs {
  fields:  Record<string, unknown>;
  locale:  Record<string, number>;
  fontdef: Record<string, number>;
  fm:      FontMetricsLike;
  text:    string;
}

export function layoutText(inp: LayoutInputs): Layout {
  const { fields, locale, fontdef: fd, fm } = inp;
  const f = fieldGetter(fields) as (key: string, d?: number | null) => number | null;
  const plainBold = splitRich(inp.text);
  const fs = Math.trunc(
    (fd['m_FontSizeModifier'] ?? 1) * (locale['m_FontSizeModifier'] ?? 1) * (f('m_FontSize') ?? 0));
  let cs = (f('m_CharacterSize') ?? 1) * (fd['m_CharacterSizeModifier'] ?? 1) * CHARACTER_SIZE_SCALE;
  cs *= (fd['m_UnboundCharacterSizeModifier'] ?? 1) * (locale['m_UnboundCharacterSizeModifier'] ?? 1);
  let k = cs * 0.1;
  const width = f('m_Width') ?? 0;
  const height = f('m_Height') ?? 0;
  const wordWrap = !!(f('m_WordWrap') ?? 0);

  const spSingle = (f('m_LineSpacing') ?? 0) + (f('m_SingleLineAdjustment') ?? 0)
    + (locale['m_SingleLineAdjustment'] ?? 0);
  const spMulti = (f('m_LineSpacing') ?? 0)
    * ((fd['m_LineSpaceModifier'] ?? 1) * (locale['m_LineSpaceModifier'] ?? 1));

  let underwear: { w: number, h: number } | null = null;
  if (wordWrap && f('m_Underwear')) {
    underwear = { w: f('m_UnderwearWidth') ?? 0, h: f('m_UnderwearHeight') ?? 0 };
  }
  let lineTexts: string[];
  let spEff: number;
  if (wordWrap) {
    lineTexts = wrapLines(plainBold.plain, fm, k, width, height, spMulti, underwear);
    spEff = spMulti;
  } else {
    lineTexts = plainBold.plain.split('\n');
    spEff = lineTexts.length === 1 ? spSingle : spMulti;
  }

  if (f('m_ResizeToFit')) {
    for (let it = 0; it < RESIZE_MAX_ITERS; it++) {
      const y = lineTexts.length > 1
        ? (lineTexts.length - 2) * fm.lineHeight * k * spEff + 2 * fm.lineHeight * k
        : fm.lineHeight * k;
      const x = Math.max(...lineTexts.map(t => lineMeshWidth(t, fm, k)));
      if (y <= height && x <= width) break;
      cs *= RESIZE_SHRINK;
      const floorCs = (f('m_MinCharacterSize') ?? 0) * CHARACTER_SIZE_SCALE;
      if (cs <= floorCs) {
        cs = floorCs;
        k = cs * 0.1;
        if (wordWrap) lineTexts = wrapLines(plainBold.plain, fm, k, width, height, spEff, underwear);
        break;
      }
      k = cs * 0.1;
      if (wordWrap) lineTexts = wrapLines(plainBold.plain, fm, k, width, height, spEff, underwear);
    }
  }

  const pitch = fm.lineHeight * k * spEff;
  const lines: LaidGlyph[][] = [];
  const lineWidths: number[] = [];
  let gi = 0;
  for (const lt of lineTexts) {
    const row: LaidGlyph[] = [];
    let pen = 0;
    for (const ch of lt) {
      row.push({ ch, penX: pen, bold: gi < plainBold.bold.length ? plainBold.bold[gi] : false });
      pen += fm.advance(ch) * k;
      gi++;
    }
    lines.push(row);
    lineWidths.push(lineAdvanceWidth(lt, fm, k));
  }
  return { lines, lineWidths, pitch, boxH: lineTexts.length * pitch, fs, k, lineHeightPx: fm.lineHeight };
}
