/** 内置缺省数据（"尽可能内置"）：反编译硬编码表 + GameStrings 提取（data/gamestrings.json，
 *  scripts/extract_textbuilder_strings.py 从 hsdata/Strings 14 语言提取）。
 *  优先级：调用方显式钩子 > 本模块内置缺省 > key 透传（调试可见）。
 *  可变化部分（游戏更新会漂移的表/文本）按同一键名经钩子动态替换（DIY 覆盖点）。 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAG } from './tags.js';
import type { TextLookupHooks } from './lookup.js';

// ---- ZilliaxDeluxe3000 功能模块表（ZilliaxDeluxe3000CardTextBuilder.cs
//      m_zilliaxDeluxe3000FunctionalModules，dbfId → 组合编号）----
const ZILLIAX_FUNCTIONAL_MODULES: Record<number, number> = {
  104944: 8,
  104945: 4,
  104946: 5,
  104947: 3,
  104948: 1,
  104949: 7,
  104950: 6,
  104951: 2,
};

// ---- BattlegroundsZilliax 三倍化底卡 → 关键词 GAME_TAG（BattlegroundsZilliaxCardTextBuilder.cs
//      m_zilliaxMinionDBIDToKeywords）----
const BG_ZILLIAX_KEYWORDS: Record<number, number> = {
  107909: TAG.TAUNT,
  107910: TAG.REBORN,
  107911: TAG.DIVINE_SHIELD,
  108931: TAG.STEALTH,
  109802: TAG.WINDFURY,
  109811: TAG.MAGNETIC,
};

// ---- GameplayString per-card 前缀（GameplayStringTextBuilder.cs GetGameStringsKey）----
const GAMEPLAY_STRING_PREFIXES: [prefix: string, key: string][] = [
  ['LOOT_507', 'GAMEPLAY_DIAMOND_SPELLSTONE_'],
  ['LOOT_091', 'GAMEPLAY_PEARL_SPELLSTONE_'],
  ['LOOT_064', 'GAMEPLAY_SAPPHIRE_SPELLSTONE_'],
  ['LOOT_051', 'GAMEPLAY_JASPER_SPELLSTONE_'],
  ['LOOT_043', 'GAMEPLAY_AMETHYST_SPELLSTONE_'],
  ['LOOT_103', 'GAMEPLAY_RUBY_SPELLSTONE_'],
  ['LOOT_503', 'GAMEPLAY_ONYX_SPELLSTONE_'],
  ['LOOT_526d', 'GAMEPLAY_LOOT_526d_DARKNESS_'],
  ['TOT_109t', 'GAMEPLAY_TOT_109t_STASIS_DRAGON_'],
  ['TRLA_1', 'GAMEPLAY_TRLA_TROLL_SHRINE_'],
];

// ---- GameStrings 内置缺省（data/gamestrings.json，14 语言）----
type LangTable = Record<string, string>;
type GameStringsTable = Record<string, LangTable & {
  keywords?: Record<string, string>;
  classes?:  Record<string, string>;
}>;

let cachedGameStrings: GameStringsTable | null = null;

function loadGameStrings(): GameStringsTable {
  if (cachedGameStrings) return cachedGameStrings;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    cachedGameStrings = JSON.parse(
      readFileSync(join(here, '..', 'data', 'gamestrings.json'), 'utf-8')) as GameStringsTable;
  } catch {
    cachedGameStrings = {};
  }
  return cachedGameStrings;
}

export interface BuiltinOptions {
  /** GameStrings 语言（缺省 zhCN）；数据来自 data/gamestrings.json */
  lang?:             string;
  /** 关闭内置 GameStrings（只用调用方钩子） */
  noBuiltinStrings?: boolean;
}

/** 合成内置缺省 hooks。调用方传入的 hooks 每个键优先于内置（DIY 覆盖点）。
 *  内置缺省也不命中时 → 返回 undefined（上游按 key 透传，调试可见）。 */
export function builtinLookup(
  hooks: TextLookupHooks | undefined,
  opts: BuiltinOptions = {},
): TextLookupHooks {
  const strings = opts.noBuiltinStrings ? {} : loadGameStrings();
  const table = strings[opts.lang ?? 'zhCN'] ?? {};
  const gameString = (key: string): string | undefined =>
    hooks?.gameString?.(key) ?? table[key];
  // GetKeywordName（GameStrings.cs:1550-1557）：KEYWORD_TEXT(tag).Name → Get(key)；
  // GetClassName（GameStrings.cs:1465-1470）：s_classNames[tag] → Get(key)；缺失 → "UNKNOWN"。
  const keywords = (table as { keywords?: Record<string, string> }).keywords ?? {};
  const classes = (table as { classes?: Record<string, string> }).classes ?? {};
  const races = (table as { races?: Record<string, string> }).races ?? {};
  const racesBg = (table as { racesBattlegrounds?: Record<string, string> }).racesBattlegrounds ?? {};
  return {
    gameString,
    keywordName: gameTag => hooks?.keywordName?.(gameTag)
      ?? keywords[String(gameTag)] ?? 'UNKNOWN',
    className: classTag => hooks?.className?.(classTag)
      ?? classes[String(classTag)] ?? 'UNKNOWN',
    cardName:         dbfId => hooks?.cardName?.(dbfId),
    entityName:       dbfId => hooks?.entityName?.(dbfId),
    card:             dbfId => hooks?.card?.(dbfId),
    buildCardText:    dbfId => hooks?.buildCardText?.(dbfId),
    bgZilliaxKeyword: dbfId =>
      hooks?.bgZilliaxKeyword?.(dbfId) ?? BG_ZILLIAX_KEYWORDS[dbfId],
    zilliaxModule: dbfId =>
      hooks?.zilliaxModule?.(dbfId) ?? ZILLIAX_FUNCTIONAL_MODULES[dbfId],
    raceName:              raceTag => hooks?.raceName?.(raceTag) ?? races[String(raceTag)] ?? 'UNKNOWN',
    raceBattlegroundsName: raceTag => hooks?.raceBattlegroundsName?.(raceTag)
      ?? racesBg[String(raceTag)] ?? 'UNKNOWN',
    gameplayStringPrefix: cardId =>
      hooks?.gameplayStringPrefix?.(cardId)
      ?? GAMEPLAY_STRING_PREFIXES.find(([p]) => cardId.includes(p))?.[1],
  };
}
