/** @tcg-cards/hs-text-builder —— 炉石卡面文本重建（CardTextBuilder 家族全量对译）。
 *
 * 入口 resolveCardText(ctx)：按 CardTextBuilderType（DBF m_cardTextBuilderType 数值，
 * Assets/Card.cs:7 枚举）分派到各 builder 的静态（EntityDef）/运行时（Entity）路径。
 * 反编译依据：exporter/tmp/ilspy/Assembly-Csharp/{CardTextBuilder,TextUtils,<Builder>}.cs；
 * builder→类映射：CardTextBuilderFactory.cs switch。语义细节与逐类型行号见 builders.ts。
 */
import { builders } from './builders.js';
import type { ResolveContext } from './builders.js';
import type { HsLocale, TextLookupHooks, RuntimeState } from './lookup.js';
import { builtinLookup, type BuiltinOptions } from './builtin.js';

export { builtinLookup, type BuiltinOptions } from './builtin.js';

export { TAG } from './tags.js';
export { tryFormat, decodeWhitespaces, transformCardText } from './textutils.js';
export type { TextLookupHooks, RuntimeState, TextEntityInput } from './lookup.js';
export type { ResolveContext, BuilderPair } from './builders.js';
export { BUILDER_TYPE_NAMES } from './names.js';

/** fixture textBuilderType 数值 → 协议 slug（Assets/Card.cs:7 CardTextBuilderType）。 */
export const CARD_TEXT_BUILDER_TYPES = {
  DEFAULT:                                                 0, JADE_GOLEM:                                              1, JADE_GOLEM_TRIGGER:                                      2, MODULAR_ENTITY:                                          3,
  KAZAKUS_POTION_EFFECT:                                   4, PRIMORDIAL_WAND:                                         5, ALTERNATE_CARD_TEXT:                                     6,
  SCRIPT_DATA_NUM_1:                                       7, GALAKROND_COUNTER:                                       8, DECORATE:                                                9,
  PLAYER_TAG_THRESHOLD:                                    10, ENTITY_TAG_THRESHOLD:                                    11, MULTIPLE_ENTITY_NAMES:                                   12,
  GAMEPLAY_STRING:                                         13, ZOMBEAST:                                                14, ZOMBEAST_ENCHANTMENT:                                    15, HIDDEN_CHOICE:                                           16,
  INVESTIGATE:                                             17, REFERENCE_CREATOR_ENTITY:                                18, REFERENCE_SCRIPT_DATA_NUM_1_ENTITY:                      19,
  REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY:                20, UNDATAKAH_ENCHANT:                                       21,
  SPELL_DAMAGE_ONLY:                                       22, DRUSTVAR_HORROR:                                         23, HIDDEN_ENTITY:                                           24,
  SCORE_VALUE_COUNT_DOWN:                                  25, SCRIPT_DATA_NUM_1_NUM_2:                                 26, POWERED_UP:                                              27,
  MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS:                      28, REFERENCE_SCRIPT_DATA_NUM_1_ENTITY_POWER:                29,
  REFERENCE_SCRIPT_DATA_NUM_1_CARD_DBID:                   30, REFERENCE_SCRIPT_DATA_NUM_CARD_RACE:                     31,
  BG_QUEST:                                                32, MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS_REF_SDN6_CARD_DBID:   33,
  ZILLIAX_DELUXE_3000:                                     34, REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY_POWER:          35,
  BATTLEGROUNDS_ZILLIAX:                                   36, SPELL_ABSORB:                                            37,
  ALT_TEXT_REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY_POWER: 38,
  REWIND_MECHANIC_CARD_TEXT_BUILDER:                       39, BATTLEGROUNDS_TAVERN_SPELL:                              40,
  DYNAMIC_KEYWORD:                                         41, REFERENCE_SCRIPT_DATA_NUM_1_CLASS:                       42, HERALD:                                                  43,
  ALTERNATE_CARD_TEXT_WITH_SCRIPT_DATA:                    44, BATTLEGROUNDS_DEEP_BLUES_SPELL:                          45,
  SILVER_HAND_RECRUIT:                                     46,
} as const;

export interface ResolveResult {
  text:  string;
  /** 恒 true——未知 textBuilderType 现在直接抛错（fail-fast），不再静默透传 */
  exact: true;
}

export function resolveCardText(
  ctx: ResolveContext & { lookup?: TextLookupHooks, runtime?: RuntimeState },
  builtinOpts?: BuiltinOptions,
): ResolveResult {
  ctx = { ...ctx, lookup: builtinLookup(ctx.lookup, builtinOpts) };
  const builder = builders[ctx.builderType];
  const def = builder?.def;
  if (!builder || !def) {
    // fail-fast：未知类型静默按 DEFAULT 渲染会把数据缺口埋进产物——抛给调用方处理
    throw new Error(`hs-text-builder: unknown textBuilderType ${ctx.builderType} (card ${ctx.cardId})`);
  }
  return { text: def.call(builder, ctx), exact: true };
}

/** 运行时（Entity）路径：bonus/对局态经 ctx.bonuses / ctx.runtime / ctx.lookup 注入。 */
export function resolveEntityText(ctx: ResolveContext, builtinOpts?: BuiltinOptions): ResolveResult {
  ctx = { ...ctx, lookup: builtinLookup(ctx.lookup, builtinOpts) };
  const builder = builders[ctx.builderType];
  const fn = builder ? builder.entity ?? builder.def : undefined;
  if (!builder || !fn) {
    throw new Error(`hs-text-builder: unknown textBuilderType ${ctx.builderType} (card ${ctx.cardId})`);
  }
  return { text: fn.call(builder, { ...ctx, mode: 'entity' }), exact: true };
}

/** 便利封装：从 fixture JSON 文档解析文本（静态口径）。 */
export function resolveFixtureText(fixture: {
  textBuilderType?: number;
  textInHand:       Record<string, string>;
  tags:             Record<string, number>;
}, lang: HsLocale = 'zhCN', cardId = '', builtinOpts?: BuiltinOptions): ResolveResult {
  // lang 三处贯穿：文本变体选择、内嵌数据语言（builtinOpts.lang）、
  // |4 复数规则的 GetPluralIndex 分派（ctx.locale）
  return resolveCardText({
    builderType: fixture.textBuilderType ?? 0,
    cardId,
    text:        fixture.textInHand[lang] ?? '',
    tags:        fixture.tags,
    locale:      lang,
  }, { lang, ...builtinOpts });
}
