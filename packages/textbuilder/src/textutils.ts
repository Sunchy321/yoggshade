/** TextUtils / GameStrings 文本变换对译（反编译 exporter/tmp/ilspy/Assembly-Csharp/
 *  TextUtils.cs 与 GameStrings.cs）。
 *  TransformCardText（TextUtils.cs:140-150）= Impl($/# token) → ParseLanguageRules
 *  （|1 韩语助词 / |4 复数，GameStrings.cs:1446-1449）→ ParseTextForInfinity
 *  （≥INFINTY_THRESHOLD 连续数字 → ∞，GameMgr 非空且非酒馆时生效，:144-148；
 *  GameUtils.cs:185 INFINTY_THRESHOLD=1e6 → 7 位数）。 */
import type { HsLocale } from './lookup.js';

/** TryFormat（TextUtils.cs:28-44）= C# string.Format；占位符超界等异常时返回原文。
 *  支持 {0}..{5}、"{{"/"}}" 转义（与 .NET 一致）。 */
export function tryFormat(format: string, args: (string | number | undefined)[]): string {
  return format.replace(/\{\{|\}\}|\{(\d+)\}/g, (m, idx?: string) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= args.length) return m; // .NET 抛异常 → 原文
    const v = args[i];
    return v === undefined || v === null ? '' : String(v); // C# null arg → 空串
  });
}

/** DecodeWhitespaces（TextUtils.cs:46-51）：DBF 字面量 "\n"/"\t" 转控制字符。 */
export function decodeWhitespaces(text: string): string {
  return text.replaceAll('\\n', '\n').replaceAll('\\t', '\t');
}

export interface BonusParams {
  damage?:        number;
  damageDouble?:  number;
  healing?:       number;
  healingDouble?: number;
  attack?:        number;
  armor?:         number;
}

const safeAdd = (a: number, b: number): number =>
  b > 0 && a > 2147483647 - b
    ? 2147483647
    : b < 0 && a < -2147483648 - b
      ? -2147483648
      : a + b;

/** TransformCardTextImpl（TextUtils.cs:288-388）：$/# 系 token 展开。
 *  $n 伤害（+DamageBonus、×2^DamageDouble，<0 截 0）；#n 治疗；$an 攻击；$dn 护甲；
 *  有加成时数字包 *高亮对*；$/# 后无数字 → 连同后续一个非数字字符一起吃掉
 *  （j==i continue 语义，TextUtils.cs:312-317）。 */
export function transformCardTextImpl(text: string, p: BonusParams = {}): string {
  if (!/[#$]/.test(text)) return text;
  const damage = p.damage ?? 0, damageDouble = p.damageDouble ?? 0;
  const healing = p.healing ?? 0, healingDouble = p.healingDouble ?? 0;
  const attack = p.attack ?? 0, armor = p.armor ?? 0;
  const flagDmg = damage !== 0 || damageDouble > 0;
  const flagHeal = healing !== 0 || healingDouble > 0;
  let out = '';
  let i = 0;
  while (i < text.length) {
    let c = text[i];
    if (c !== '$' && c !== '#') {
      out += c;
      i++;
      continue;
    }
    i++;
    if (i < text.length && (text[i] === 'a' || text[i] === 'd')) {
      c = text[i];
      i++;
    }
    let j = i;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    if (j === i) {
      i++; // 无数字 continue → 吃掉一个非数字字符
      continue;
    }
    let n = Number.parseInt(text.slice(i, j), 10);
    switch (c) {
    case '$':
      n = safeAdd(n, damage);
      for (let k = 0; k < damageDouble; k++) n = safeAdd(n, n);
      if (n < 0) n = 0;
      break;
    case '#':
      n = safeAdd(n, healing);
      for (let k = 0; k < healingDouble; k++) n = safeAdd(n, n);
      break;
    case 'a':
      n = safeAdd(n, attack);
      if (n < 0) n = 0;
      break;
    case 'd':
      n += armor;
      if (n < 0) n = 0;
      break;
    }
    if ((flagDmg && c === '$') || (flagHeal && c === '#')) out += `*${n}*`;
    else out += String(n);
    i = j;
  }
  return out;
}

/** ParseTextForInfinity（TextUtils.cs:152-177）：连续数字段 ≥minDigits 且数值在
 *  [INFINTY_THRESHOLD(1e6), 2^31-1] → 该数字段替换为 ∞（**子串替换**，非整串；
 *  s_infinityRegex.Replace 回调语义，:171-176）。 */
export function parseTextForInfinity(text: string, minDigits = 7): string {
  return text.replace(/[0-9]+/g, run => {
    if (run.length < minDigits) return run;
    const n = Number.parseInt(run, 10);
    return n >= 1000000 && n <= 2147483647 ? '∞' : run;
  });
}

// ---------------------------------------------------------------------------
// GameStrings 语言规则（GameStrings.cs:2222-2457）
// ---------------------------------------------------------------------------

/** FindPrecedingChar（GameStrings.cs:2173-2229）：向前找"前导字符"，韩文取原码；
 *  拉丁字母 L/R→일(51068)、M/m/n/n→영(50689)、其余→이(51060)——**大写 N(78) 未映射是
 *  游戏原代码 bug**（4 个版本反编译一致：`77||109||110||110` 重复 n），按 1:1 复刻保留；
 *  数字 0/3/6→영、1/7/8→일、其余→이；跳过右括号类与 <tag> 尾部；找不到 → 이。 */
function findPrecedingChar(preStr: string): number {
  let num = preStr.length - 1;
  let preceding = preStr.charCodeAt(num);
  const closers = ')}]:;?/*&^!~`/\\|_\'"';
  while (num >= 0) {
    preceding = preStr.charCodeAt(num);
    if (preceding >= 44032 && preceding <= 55203) break;
    if ((preceding >= 65 && preceding <= 90) || (preceding >= 97 && preceding <= 122)) {
      if (preceding === 76 || preceding === 108 || preceding === 82 || preceding === 114) preceding = 51068;
      else if (preceding === 77 || preceding === 109 || preceding === 110) preceding = 50689;
      else preceding = 51060;
      break;
    }
    if (!closers.includes(preStr[num])) {
      if (preceding === 62 && num >= 3 && preStr[num - 3] === '<') num -= 3; // <tag> 尾
      if (preceding >= 48 && preceding <= 57) {
        if (preceding === 48 || preceding === 51 || preceding === 54) preceding = 50689;
        else if (preceding === 49 || preceding === 55 || preceding === 56) preceding = 51068;
        else preceding = 51060;
        break;
      }
    }
    num--;
  }
  if (num < 0) preceding = 51060;
  return preceding;
}

/** ParseLanguageRule1（GameStrings.cs:2222-2298）：|1(有终声,无终声) 韩语助词选择。
 *  终声判定 = (前导字符−44032)%28==0 → 无终声取 args[1]；args[1][0]==='로' 且 %28==8
 *  也取 args[1]（ㄹ 规则）；解析失败（无前导/括号不配/参数≠2/前导非韩文域）→ 保留原文。 */
export function parseLanguageRule1(str: string): string {
  let idx = str.indexOf('|1');
  if (idx < 0) return str;
  let out = '';
  while (idx >= 0) {
    const pre = str.slice(0, idx);
    if (pre.length === 0) break; // invalid preStr → 保留原文
    const open = str.indexOf('(', idx);
    const close = open >= 0 ? str.indexOf(')', open) : -1;
    if (open < 0 || close < 0) break;
    const args = str.slice(open + 1, close).split(',');
    if (args.length !== 2) break;
    const preceding = findPrecedingChar(pre);
    if (preceding < 44032 || preceding > 55203) break; // 非韩文域 → 保留原文
    const rem = (preceding - 44032) % 28;
    out += pre;
    out += args[rem === 0 || (args[1][0] === '로' && rem === 8) ? 1 : 0];
    str = str.slice(close + 1);
    idx = str.indexOf('|1');
  }
  return out + str;
}

const NUM_RUN = /(?<!\/)(?:[0-9]+,)*[0-9]+(?!\/)/g;
const NUM_RUN_FALLBACK = /(?<!\/)(?:[0-9]+,)*[0-9]+/g;

/** ParseLanguageRuleArgs（GameStrings.cs:2107-2160）：取 (…) 参数并**屏蔽纯数字**
 *  （数字位换 '0'，防 |4 数字解析误吃参数），再按 / 分段。 */
function parseRuleArgs(str: string, ruleIndex: number): { args: string[], end: number } | null {
  const open = str.indexOf('(', ruleIndex + 2);
  if (open < 0) return null;
  const close = str.indexOf(')', open + 1);
  if (close < 0) return null;
  let masked = str.slice(open + 1, close);
  const matches = [...masked.matchAll(NUM_RUN)];
  const re = matches.length > 0 ? NUM_RUN : NUM_RUN_FALLBACK;
  const runs = [...masked.matchAll(re)];
  if (runs.length > 0) {
    let s = '';
    let pos = 0;
    for (const m of runs) {
      s += masked.slice(pos, m.index) + '0'.repeat(m[0].length);
      pos = m.index + m[0].length;
    }
    s += masked.slice(pos);
    masked = s;
  }
  // LANGUAGE_RULE_ARG_DELIMITERS = ','（GameStrings.cs:29）
  return { args: masked.split(','), end: close };
}

/** ParseLanguageRule4Number_Foreward/Backward（GameStrings.cs:2358-2382）：
 *  在规则参数后的文本里找首个/末个数字串（逗号千分位可整体出现）。 */
function rule4Number(text: string, backward: boolean): number | null {
  const re = backward ? NUM_RUN_FALLBACK : NUM_RUN;
  const runs = [...text.matchAll(re)];
  const m = backward ? runs[runs.length - 1] : runs[0];
  if (!m) return null;
  const n = Number.parseInt(m[0].replaceAll(',', ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** GetPluralIndex（GameStrings.cs:2408-2457）：按 locale 的复数段选择。 */
function getPluralIndex(locale: HsLocale, number: number): number {
  switch (locale) {
  case 'frFR': case 'koKR': case 'zhTW': case 'zhCN':
    return number <= 1 ? 0 : 1;
  case 'ruRU': {
    const hun = number % 100;
    if (hun >= 11 && hun <= 14) return 2;
    switch (number % 10) {
    case 1: return 0;
    case 2: case 3: case 4: return 1;
    default: return 2;
    }
  }
  case 'plPL':
    if (number === 1) return 0;
    if (number === 0) return 2;
    {
      const hun = number % 100;
      if (hun >= 11 && hun <= 14) return 2;
      const ten = number % 10;
      if (ten >= 2 && ten <= 4) return 1;
      return 2;
    }
  default: // enUS 等：1 → 单数
    return number === 1 ? 0 : 1;
  }
}

/** ParseLanguageRule4（GameStrings.cs:2291-2356）：|4(单数/复数/…) 复数段选择。
 *  数值来源 = 两个规则之间的文本（先 Forward 后 Backward）或 PluralNumber（本离线链无）。
 *  解析失败的规则跳过（保留标记），与反编译 continue 一致。 */
export function parseLanguageRule4(str: string, locale: HsLocale): string {
  let out: string | null = null;
  let lastEnd = 0;
  for (let at = str.indexOf('|4'); at >= 0; at = str.indexOf('|4', at + 2)) {
    const parsed = parseRuleArgs(str, at);
    if (!parsed) continue;
    const between = str.slice(lastEnd, at);
    const number = rule4Number(between, false) ?? rule4Number(between, true);
    if (number === null) continue; // 反编译：解析失败 continue（标记保留）
    const pluralIndex = getPluralIndex(locale, number);
    if (pluralIndex >= parsed.args.length) continue; // 参数不足 → 跳过
    if (out === null) out = '';
    out += between;
    out += parsed.args[pluralIndex];
    lastEnd = parsed.end + 1;
  }
  if (out === null) return str;
  return out + str.slice(lastEnd);
}

/** ParseLanguageRules（GameStrings.cs:1446-1451） */
export function parseLanguageRules(text: string, locale: HsLocale): string {
  return parseLanguageRule4(parseLanguageRule1(text), locale);
}

export interface TransformOptions {
  bonuses?:           BonusParams;
  /** Infinity 阈值（含，1e6 → 7 位）。游戏内渲染恒生效；传 false 关闭（纯 DBF 口径）。 */
  infinityMinDigits?: number | false;
  /** |1/|4 复数规则的 locale（缺省 enUS 口径） */
  locale?:            HsLocale;
}

/** TransformCardText（TextUtils.cs:140-150）= Impl → ParseLanguageRules → ParseTextForInfinity。 */
export function transformCardText(text: string, opts: TransformOptions = {}): string {
  let out = transformCardTextImpl(text, opts.bonuses);
  out = parseLanguageRules(out, opts.locale ?? 'enUS');
  const inf = opts.infinityMinDigits;
  if (inf !== false) out = parseTextForInfinity(out, typeof inf === 'number' ? inf : 7);
  return out;
}
