/** UberText 布局引擎 —— 引擎语义对译（Wrap / ReduceText_CharSize / SetLineSpacing 状态机）。
 *
 * 2026-10-06 重写（explore/2026-10-06-text-align/findings.md）：旧实现的 resizeToFit 停档
 * 与引擎不同（desc 字形整体偏大 ~10%、块首行偏上、断行不同），根因 =
 * (a) underwear（desc 防护罩）只实现了 Flip=1 的 y 阈值分支且在 ally 装载层被钝化——
 *     Flip=0 帧型（随从/武器/英雄/英雄技能/地标）走「完成行 TextMesh bounds ∩ 左右角盒」路径；
 * (b) fit 判据不同：引擎首轮 y 用 intra 修正、循环内用 raw bounds（UB:2417 vs :2460）；
 * (c) 行高口径：LH = round((asc−desc)×fs/upem)（font.ts），非 py 链的 ceil/floor 组合。
 * 反编译依据（UB = explore/ilspy/UberText.Runtime.full.cs）：
 * - Wrap 主循环/逐词容器重评        UB:3612-3747
 * - GetFinalContainerWidth Flip 分支 UB:4171-4186
 * - GetUnderwearBounds 角盒几何      UB:4109-4128
 * - PrepareTextForUnderwear          UB:3909-3915（GO y=H×0.25）+ UpperCenter（UB:3630）
 * - AdjustUnderwearForLocale         UB:2573-2599（narrow = W×(1−Uw)）
 * - ReduceText_CharSize              UB:2400-2463（循环内 raw y、minCs floor、×0.95、40 轮）
 * - Measure_IntraLine_Height         UB:2389-2398（bounds("|\n|")−2×bounds("|")，实证 y=行框）
 * - SetLineSpacing 语义              UB:2241-2245（multi ×LineSpaceMod / single +SingleLineAdj）
 * - 字号链                           UB:1840-1928（unbound 修饰在 resize 之后才乘）
 * 布局判据：y = 行框 (n−1)pitch+LH；x = ink/advance 混合（lineInkWidthFp）；渲染仍走 PIL 位图框。
 */
import type { FontMetricsLike } from './font.js';

interface LaidChar { ch: string, bold: boolean, italic: boolean }

const CHARACTER_SIZE_SCALE = 0.01; // UB:109
const RESIZE_SHRINK = 0.95; // UB:2434
const RESIZE_MAX_ITERS = 40; // UB:2430
export const BOLD_SIZE_CAP = 10.0; // UB Bold():2692

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

function canWrapBetween(lastCp: number, wideCp: number, _nextCp: number): boolean {
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

function splitRich(text: string): { plain: string, bold: boolean[], italic: boolean[] } {
  // <b>/<i> 状态独立（可嵌套，CATA_190h "<i><b>兆示</b>…"）；其余 <...> tag 剥除。
  // 斜体引擎语义：TextMesh 原生 FontStyle.Italic（UB 不处理 <i>），字形剪切合成、
  // advance 不变——docs/findings/ubertext-text-rendering-2026-10-06.md §3。
  const chars: string[] = [];
  const bold: boolean[] = [];
  const italic: boolean[] = [];
  let curB = false;
  let curI = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<b>', i)) {
      curB = true;
      i += 3;
      continue;
    }
    if (text.startsWith('</b>', i)) {
      curB = false;
      i += 4;
      continue;
    }
    if (text.startsWith('<i>', i)) {
      curI = true;
      i += 3;
      continue;
    }
    if (text.startsWith('</i>', i)) {
      curI = false;
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
    bold.push(curB);
    italic.push(curI);
    i++;
  }
  return { plain: chars.join(''), bold, italic };
}

/** TextMesh bounds x = xMin₀ + (n−1)×adv + xMax_last（ink 框，UB Wrap 逐词 SetText 实测语义）。 */
function lineInkWidthFp(line: LaidChar[], fm: FontMetricsLike): number {
  if (!line.length) return 0;
  let adv = 0;
  for (let i = 0; i < line.length - 1; i++) adv += fm.advance(line[i].ch);
  const a = fm.inkChar(line[0].ch);
  const b = fm.inkChar(line[line.length - 1].ch);
  return a.minX + adv + b.maxX;
}

function maxInkWidthFp(lines: LaidChar[][], fm: FontMetricsLike): number {
  let width = 0;
  for (const l of lines) {
    const w = lineInkWidthFp(l, fm);
    if (w > width) width = w;
  }
  return width;
}

/** TextMesh bounds.y = **行框**口径：(n−1)×pitch + LH（fp，自首行行框顶向下）。
 *  出处：引擎 Measure_IntraLine_Height（UB:2389-2398）实测 bounds("|") = LH（非 ink）→
 *  Unity 把 TextMesh mesh.bounds 设为 TextGenerator 行框；Angelia 1929 实证的
 *  (n−2)pitch+2LH resize 判据同口径。x 方向仍是字形 ink/advance 混合（lineInkWidthFp）。 */
function meshLineBoxHeightFp(lineCount: number, pitchFp: number, fm: FontMetricsLike): number {
  if (lineCount <= 0) return 0;
  return (lineCount - 1) * pitchFp + fm.lineHeight;
}

interface WrapCtx {
  fm:             FontMetricsLike;
  k:              number; // cs×0.1（world/fontpx）
  pitchFp:        number; // fm.lineHeight × 当前 lineSpacing 状态（underwear y 度量用）
  width:          number; // OriginalWidth = GetWidth()
  height:         number; // settings.Height = GetHeight()
  useUnderwear:   boolean;
  flip:           boolean;
  uwWidth:        number; // m_UnderwearWidth（RAW，角盒几何用，UB:4115）
  uwHeight:       number; // m_UnderwearHeight（RAW）
  uwNarrow:       number; // UnderwearWidthLocaleAdjustment = width×(1−Uw)（UB:2598）
  uwHeightLocale: number; // flip: H×Uh；!flip: H×(1−Uh)（UB:2592/2596）
}

/** 引擎 Wrap 的逐词换行（UB:3648-3741；单段）。done = 已完成行（跨段共享 + 本段已断行者）。 */
function wrapSegment(
  seg: LaidChar[], ctx: WrapCtx, done: LaidChar[][], underwearOn: boolean,
): LaidChar[][] {
  const { fm, k } = ctx;
  const words = breakIntoWords(seg);
  const lines: LaidChar[][] = [];
  let cur: LaidChar[] = [];
  let anyOutput = false;
  // GetFinalContainerWidth（UB:4171-4186）：按 s_newText（已完成行 + 当前行已接受词，
  // 不含候选词——UB:3655/3659 的 SetText 次序）bounds 重评容器宽
  const containerOf = (): number => {
    if (!underwearOn || (done.length === 0 && cur.length === 0)) return ctx.width;
    const n = done.length + (cur.length ? 1 : 0);
    if (n === 0) return ctx.width;
    const widthFp = maxInkWidthFp([...done, cur], fm);
    if (!ctx.flip) {
      // 角盒相交（UB:4109-4128 几何 + UB:4181 Intersects）；测量态 UpperCenter + GO y=H×0.25
      // （UB:3630/3913）→ 行框顶挂 GO 原点：bounds.y ∈ [0, (n−1)pitch+LH]（y-down）
      const goY = ctx.height * 0.25;
      const topW = goY;
      const botW = goY - meshLineBoxHeightFp(n, ctx.pitchFp, fm) * k;
      const cY = (topW + botW) / 2;
      const eY = (topW - botW) / 2; // y-up：topW > botW
      const eX = (widthFp * k) / 2;
      const halfW = ctx.width * ctx.uwWidth * 0.25;
      const halfH = ctx.height * ctx.uwHeight * 0.25;
      const cxB = ctx.width * 0.5 - ctx.width * 0.5 * ctx.uwWidth * 0.5;
      const cyB = -ctx.height * 0.5 + ctx.height * ctx.uwHeight * 0.5;
      const hit = (bcx: number): boolean =>
        Math.abs(0 - bcx) <= eX + halfW && Math.abs(cY - cyB) <= eY + halfH;
      return (hit(cxB) || hit(-cxB)) ? ctx.uwNarrow : ctx.width;
    }
    const y = meshLineBoxHeightFp(n, ctx.pitchFp, fm) * k;
    return (y - (ctx.height - y) * 0.2 < ctx.uwHeightLocale) ? ctx.uwNarrow : ctx.width;
  };
  for (const word of words) {
    const cand = [...cur, ...word];
    const x = lineInkWidthFp(cand, fm) * k;
    const container = containerOf();
    if (x < container) {
      cur = cand;
      continue;
    }
    // 断行（UB:3721-3731）：s_newText 非空则补 '\n'（空行也占槽）；新行词 TrimStart(' ')
    if (anyOutput || cur.length) {
      lines.push(cur);
      done.push(cur);
    }
    anyOutput = true;
    let w = word;
    while (w.length && w[0].ch === ' ') w = w.slice(1);
    cur = w;
  }
  lines.push(cur);
  return lines;
}

/** 分段 wrap（'\n' 硬换行分段；跨段共享 underwear 已完成行状态）。 */
function engineWrapSegments(segments: LaidChar[][], ctx: WrapCtx): LaidChar[][] {
  const { fm, k } = ctx;
  // IsUnderwearNeeded（UB:4188-4216）：!flip 恒 true；flip 走逐词溢出测试
  let underwearOn = false;
  if (ctx.useUnderwear) {
    if (!ctx.flip) {
      underwearOn = true;
    } else {
      let acc: LaidChar[] = [];
      outer:
      for (const seg of segments) {
        for (const word of breakIntoWords(seg)) {
          acc = [...acc, ...word];
          if (lineInkWidthFp(acc, fm) * k >= ctx.width) {
            underwearOn = true;
            break outer;
          }
        }
      }
    }
  }
  const out: LaidChar[][] = [];
  let completed: LaidChar[][] = [];
  for (const seg of segments) {
    const segLines = wrapSegment(seg, ctx, completed, underwearOn);
    out.push(...segLines);
    completed = out.slice();
  }
  return out;
}

function breakIntoWords(chars: LaidChar[]): LaidChar[][] {
  if (!chars.length) return [];
  const words: LaidChar[][] = [];
  let buf: LaidChar[] = [chars[0]];
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i];
    const lastCp = chars[i - 1].ch.codePointAt(0)!;
    const wideCp = c.ch.codePointAt(0)!;
    const nextCp = i < chars.length - 1 ? chars[i + 1].ch.codePointAt(0)! : 0;
    if (canWrapBetween(lastCp, wideCp, nextCp)) {
      words.push(buf);
      buf = [c];
    } else {
      buf.push(c); // m_ForceWrapLargeWords=0（zhCN）：不比 container，继续粘
    }
  }
  words.push(buf);
  return words;
}

export interface LaidGlyph { ch: string, penX: number, bold: boolean, italic: boolean }
export interface Layout {
  lines:        LaidGlyph[][];
  lineWidths:   number[];
  pitch:        number;
  boxH:         number;
  fs:           number;
  k:            number;
  lineHeightPx: number;
}

/** 字段读取器：py ns.f(key, default)（None 透传）。 */
function fieldGetter(fields: Record<string, unknown>) {
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
  const width = f('m_Width') ?? 0;
  const height = f('m_Height') ?? 0;
  const wordWrap = !!(f('m_WordWrap') ?? 0);
  const resizeToFit = !!(f('m_ResizeToFit') ?? 0);
  const andGrow = !!(f('m_ResizeToFitAndGrow') ?? 0); // UB:2299-2324 ResizeTextToFit 分派（grow → Bounds_CharSize）
  const mLineSpacing = f('m_LineSpacing') ?? 0;

  // SetLineSpacing（UB:2241-2245）：multi → v×(FontDef×locale LineSpaceMod)；single → v+SingleLineAdj
  const spMultiOf = (v: number): number =>
    v * ((fd['m_LineSpaceModifier'] ?? 1) * (locale['m_LineSpaceModifier'] ?? 1));
  const spSingleOf = (v: number): number =>
    v + ((fd['m_SingleLineAdjustment'] ?? 0) + (locale['m_SingleLineAdjustment'] ?? 0));

  // 硬换行分段（TextMesh '\n' 硬语义；空段=空行占槽）
  const segments: LaidChar[][] = [];
  {
    let cursor = 0;
    for (const segStr of plainBold.plain.split('\n')) {
      const segBold = plainBold.bold.slice(cursor, cursor + segStr.length);
      const segItalic = plainBold.italic.slice(cursor, cursor + segStr.length);
      cursor += segStr.length + 1;
      segments.push(segStr.split('').map((ch, i) =>
        ({ ch, bold: segBold[i] ?? false, italic: segItalic[i] ?? false })));
    }
  }

  // underwear 上下文（UpdateWordWrapSettings UB:2553 + AdjustUnderwearForLocale UB:2573）
  const useUnderwear = wordWrap && !!(f('m_Underwear') ?? 0);
  const flip = !!(f('m_UnderwearFlip') ?? 0);
  const uwWidth = f('m_UnderwearWidth') ?? 0;
  const uwHeight = f('m_UnderwearHeight') ?? 0;

  // 初始 lineSpacing 状态：RenderText:1768 SetLineSpacing(m_LineSpacing) 按空文本（single 公式）
  let spEff = spSingleOf(mLineSpacing);
  let k = cs * 0.1;

  const doWrap = (curK: number, sp: number): LaidChar[][] => engineWrapSegments(segments, {
    fm, k:              curK, pitchFp:        fm.lineHeight * sp, width, height,
    useUnderwear, flip, uwWidth, uwHeight,
    uwNarrow:       width * (1 - uwWidth),
    uwHeightLocale: flip ? height * uwHeight : height * (1 - uwHeight),
  });

  let wrapped: LaidChar[][];

  if (wordWrap && !resizeToFit) {
    // UB:1888-1897：wrap 一轮；行数比硬行数多才重设 lineSpacing（UB:1893-1896）
    wrapped = doWrap(k, spEff);
    if (wrapped.length > segments.length) spEff = spMultiOf(mLineSpacing);
  } else if (resizeToFit && andGrow && !wordWrap) {
    // ResizeToFitBounds_CharSize（UB:2470-2520）!wordWrap 分支：宽度与框失配 >1% 时
    // **一次性**缩放 charSize ×= min(boxH/meshH, boxW/meshW)（可增可减、不迭代、不换行）。
    // 全帧型仅 RaceUberText 族（11 节点）带 AndGrow=1——minion 种族文本恰好落在框内
    // （失配 ≤1% 不触发）故旧 shrink 路径与引擎同值；trinket 种族框更高（H 0.27 vs 0.17）
    // 且文本偏小 → 引擎放大、此前的 shrink-only 实现画小（2026-10-08 用户报告）。
    // 盒尺寸 = GetWidth/GetHeight（UB:2171-2246）：locale m_Width/m_Height>0 覆盖序列化值。
    wrapped = segments;
    spEff = wrapped.length > 1 ? spMultiOf(mLineSpacing) : spSingleOf(0);
    const locWv = locale['m_Width'], locHv = locale['m_Height'];
    const boxW = typeof locWv === 'number' && locWv > 0 ? locWv : width;
    const boxH = typeof locHv === 'number' && locHv > 0 ? locHv : height;
    const bx = maxInkWidthFp(wrapped, fm) * k;
    const by = meshLineBoxHeightFp(wrapped.length, fm.lineHeight * spEff, fm) * k;
    const narrower = bx - bx * 0.01 < boxW;
    const wider = bx + bx * 0.01 > boxW;
    if (bx > 0 && by > 0 && (narrower || wider)) {
      let num = cs * Math.min(boxH / by, boxW / bx);
      const minCs = (f('m_MinCharacterSize') ?? 0) * CHARACTER_SIZE_SCALE;
      if (num <= minCs * 0.01) num = minCs * 0.01;
      cs = num;
      k = cs * 0.1;
    }
    spEff = wrapped.length > 1 ? spMultiOf(mLineSpacing) : spSingleOf(mLineSpacing);
  } else if (resizeToFit) {
    // ResizeTextToFit（UB:2299-2336）→ ReduceText_CharSize（UB:2400-2463）
    wrapped = wordWrap ? doWrap(k, spEff) : segments;
    // 入口按当前文本行数重设（UB:2405-2412）
    spEff = wrapped.length > 1 ? spMultiOf(mLineSpacing) : spSingleOf(0);
    const minCs = (f('m_MinCharacterSize') ?? 0) * CHARACTER_SIZE_SCALE;
    const locW = locale['m_ResizeToFitWidthModifier'];
    const resizeWMod = locW && locW > 0 ? locW : 1;
    // intra = bounds("|\n|") − 2×bounds("|") = pitch − LH（UB:2389-2398，行框口径）
    const meshH = (): number => meshLineBoxHeightFp(wrapped.length, fm.lineHeight * spEff, fm) * k;
    const meshW = (): number => maxInkWidthFp(wrapped, fm) * k;
    let x = meshW();
    // 首判 y = raw − intra（UB:2417）
    let y = meshH() - (fm.lineHeight * spEff - fm.lineHeight) * k;
    let iters = 0;
    while (y > height || x > width * resizeWMod) {
      iters++;
      if (iters > RESIZE_MAX_ITERS) break;
      cs *= RESIZE_SHRINK;
      if (cs <= minCs) {
        cs = minCs;
        k = cs * 0.1;
        if (wordWrap) wrapped = doWrap(k, spEff); // floor 分支（UB:2439-2443，ellipses 本仓未触发）
        break;
      }
      k = cs * 0.1;
      if (wordWrap) wrapped = doWrap(k, spEff);
      spEff = wrapped.length > 1 ? spMultiOf(mLineSpacing) : spSingleOf(0); // UB:2450-2457
      x = meshW();
      y = meshH(); // 循环内 raw bounds（UB:2460）
    }
    spEff = wrapped.length > 1 ? spMultiOf(mLineSpacing) : spSingleOf(mLineSpacing); // UB:2462
  } else {
    wrapped = segments;
  }

  // unbound 修饰在 resize 之后才乘（UB:1920-1928）
  cs *= (fd['m_UnboundCharacterSizeModifier'] ?? 1) * (locale['m_UnboundCharacterSizeModifier'] ?? 1);
  k = cs * 0.1;

  const pitch = fm.lineHeight * k * spEff;
  const lines: LaidGlyph[][] = [];
  const lineWidths: number[] = [];
  for (const lt of wrapped) {
    const row: LaidGlyph[] = [];
    let pen = 0;
    for (const c of lt) {
      row.push({ ch: c.ch, penX: pen, bold: c.bold, italic: c.italic });
      pen += fm.advance(c.ch) * k;
    }
    lines.push(row);
    let s = 0;
    for (const c of lt) s += fm.advance(c.ch);
    lineWidths.push(s * k);
  }
  return { lines, lineWidths, pitch, boxH: wrapped.length * pitch, fs, k, lineHeightPx: fm.lineHeight };
}
