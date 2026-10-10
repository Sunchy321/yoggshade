/** CardTextBuilder 家族全量对译（47 类型）。
 *  每个 builder 对译其 BuildCardTextInHand(EntityDef)（静态卡面，exporter 基准图口径）
 *  与 BuildCardTextInHand(Entity)（运行时，bonus/对局态经 RuntimeState/钩子注入）。
 *  反编译出处：exporter/tmp/ilspy/Assembly-Csharp/<Builder>.cs；基类 CardTextBuilder.cs。
 *  输入 tags = DBF CARD_TAG 数字键（GAME_TAG 枚举值，GAME_TAG.cs）；缺 tag = GetTag 缺省 0。 */
import { TAG } from './tags.js';
import { decodeWhitespaces, transformCardText, tryFormat, type BonusParams } from './textutils.js';
import type { HsLocale, RuntimeState, TextLookupHooks } from './lookup.js';

export interface ResolveContext {
  builderType: number;
  cardId:      string;
  /** DBF TextInHand 原文（GetRawCardTextInHand = CardDbfRecord.TextInHand，CardTextBuilder.cs:20-28） */
  text:        string;
  tags:        Record<string, number>;
  /** 文本语言（= 游戏内 Localization locale；|4 复数规则 GetPluralIndex 按此分派，缺省 enUS 口径） */
  locale?:     HsLocale;
  /** 'entitydef' = 静态卡面（基准图口径，GameMgr==null）；'entity' = 运行时（缺省静态） */
  mode?:       'entitydef' | 'entity';
  bonuses?:    BonusParams;
  lookup?:     TextLookupHooks;
  runtime?:    RuntimeState;
}

const tag = (ctx: ResolveContext, id: number): number => {
  const v = ctx.tags[String(id)];
  if (v === undefined) return 0; // EntityDef.GetTag 缺省语义
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    // fail-fast：坏数据静默变 0 会产错文本——抛给调用方处理
    throw new Error(`hs-text-builder: tag ${id} value ${JSON.stringify(v)} is not finite (card ${ctx.cardId})`);
  }
  return n;
};
const raw = (ctx: ResolveContext): string => ctx.text;
const unknownName = (ctx: ResolveContext): string =>
  ctx.lookup?.gameString?.('GAMEPLAY_UNKNOWN_CREATED_BY') ?? 'GAMEPLAY_UNKNOWN_CREATED_BY';
/** 引用实体名（HasValidDisplayName 判定失败 → UNKNOWN） */
const refName = (ctx: ResolveContext, dbfId: number): string =>
  (dbfId !== 0 ? ctx.lookup?.entityName?.(dbfId) : undefined) ?? unknownName(ctx);

/** GetAltTextIndex（CardTextBuilder.cs:30-45）：955 值，0 视为段 0；
 *  SUPPRESS_ALT_CARD_TEXT_FOR_OPPONENT 只在 Entity 态判定，静态=无 suppress。 */
const altTextIndex = (ctx: ResolveContext): number => {
  const v = tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT);
  if (v === 0) return 0;
  if (ctx.mode === 'entity' && tag(ctx, TAG.SUPPRESS_ALT_CARD_TEXT_FOR_OPPONENT) !== 0
    && (ctx.runtime?.suppressAltForViewer || ctx.runtime?.zone === undefined)) return 0;
  return v;
};

/** TransformCardText 口径：∞ 恒生效（游戏内 GameMgr 非空口径，≥1e6 → ∞）；
 *  |1/|4 复数规则按 ctx.locale 分派（ResolveContext.locale，缺省 enUS 口径）；
 *  static（EntityDef）无 bonus，entity（Entity）带 bonuses。 */
const transform = (ctx: ResolveContext, text: string): string =>
  transformCardText(text, {
    locale:            ctx.locale,
    infinityMinDigits: 7,
    bonuses:           ctx.mode === 'entity' ? ctx.bonuses : undefined,
  });

// ---------------------------------------------------------------------------
// 各 builder（键 = CardTextBuilderType 枚举值；值 = { def?, entity? }，缺省回落基类）
// ---------------------------------------------------------------------------

export interface BuilderPair {
  /** BuildCardTextInHand(EntityDef)（静态）；缺省 = 基类 default 语义 */
  def?:    (ctx: ResolveContext) => string;
  /** BuildCardTextInHand(Entity)（运行时）；缺省 = 同 def（bonus 经 transform 生效） */
  entity?: (ctx: ResolveContext) => string;
}

const baseDef = (ctx: ResolveContext): string => transform(ctx, decodeWhitespaces(raw(ctx)));
const baseEntity = (ctx: ResolveContext): string => transform(ctx, decodeWhitespaces(raw(ctx)));

/** TAG_CLASS 数值 → 枚举名（TAG_CLASS.cs；Herald 的 GAMEPLAY_HERALD_<NAME> key 构造） */
const TAG_CLASS_NAMES: Record<number, string> = {
  1:  'DEATHKNIGHT', 2:  'DRUID', 3:  'HUNTER', 4:  'MAGE', 5:  'PALADIN',
  6:  'PRIEST', 7:  'ROGUE', 8:  'SHAMAN', 9:  'WARLOCK', 10: 'WARRIOR', 14: 'DEMONHUNTER',
};

/** JadeGolem：FormatJadeGolemText（JadeGolemCardTextBuilder.cs:24-33）——
 *  {0}="jade/jade"、{1}="n"（jade∈{8,11,18} 时法语等 n 类词形；zhCN 无 {1} 占位）。
 *  @ 分段：EntityDef 固定取 @ 后段；Entity 按 zone（!=PLAY 或 showStats → 前段）。 */
const jadeGolem = (showStatsInPlay: boolean): BuilderPair => ({
  // EntityDef（JadeGolemCardTextBuilder.cs:37-45）：仅取 @ 后段，**不做** {0} 格式化
  // （FormatJadeGolemText 只在 Entity 路径调用）；CFM_902 基准图实证。
  def: ctx => {
    const t = decodeWhitespaces(raw(ctx));
    const at = t.indexOf('@');
    return transform(ctx, at >= 0 ? t.slice(at + 1) : t);
  },
  // Entity（:6-20）：zone!=PLAY（或 showStats）→ @ 前段；TryFormat(text, "jade/jade", "n")
  entity: ctx => {
    let t = decodeWhitespaces(raw(ctx));
    const at = t.indexOf('@');
    const inPlay = ctx.runtime?.zone === 'play';
    if (at >= 0) t = (inPlay && !showStatsInPlay) ? t.slice(at + 1) : t.slice(0, at);
    const jade = tag(ctx, TAG.JADE_GOLEM);
    return transform(ctx, tryFormat(t, [`${jade}/${jade}`, isFrenchStyleN(jade) ? 'n' : '']));
  },
});

/** AlternateCardText 的 GetAlternateCardText（AlternateCardTextCardTextBuilder.cs:13-33）：
 *  循环跳 idx 个 @ 再截到下一个 @（≈ Split('@')[idx]，越界取尾段）。 */
const skipSegments = (text: string, idx: number): string => {
  let t = text;
  let at = t.indexOf('@');
  for (let i = 0; i < idx && at >= 0; i++) {
    t = t.slice(at + 1);
    at = t.indexOf('@');
  }
  if (at >= 0) t = t.slice(0, at);
  return t;
};

/** 玉莲/银手等 "n" 词形判定（JadeGolemCardTextBuilder.cs:26 / SilverHandCardTextBuilder.cs） */
const isFrenchStyleN = (n: number): boolean => n === 8 || n === 11 || n === 18;

export const builders: Record<number, BuilderPair> = {
  // DEFAULT（CardTextBuilder.cs:107-110 → GetDefaultCardTextInHand:62-64）
  0: { def: baseDef, entity: baseEntity },

  // JADE_GOLEM + JADE_GOLEM_TRIGGER（JadeGolemCardTextBuilder / JadeGolemTriggerCardTextBuilder：
  // trigger 子类仅 m_showJadeGolemStatsInPlay=true）
  1: jadeGolem(false),
  2: jadeGolem(true),

  // MODULAR_ENTITY（ModularEntityCardTextBuilder.cs:22-25）：EntityDef 静态 → 空串
  // （奇利亚斯本体手牌文本由模块拼装，模块 dbf 在 MODULAR_ENTITY_PART_1/2）。
  3: {
    def:    () => '',
    entity: ctx => {
      // BuildFormattedText(Entity)（ModularEntityCardTextBuilder.cs:77-82）：两模块卡文本
      // @ 后段 → TryFormat(raw, power1, power2)
      const p1 = tag(ctx, TAG.MODULAR_ENTITY_PART_1);
      const p2 = tag(ctx, TAG.MODULAR_ENTITY_PART_2);
      const powerOf = (dbfId: number): string => {
        const c = dbfId !== 0 ? ctx.lookup?.card?.(dbfId) : undefined;
        if (!c?.textInHand) return '';
        const t = c.textInHand;
        const at = t.indexOf('@');
        return transform(ctx, at >= 0 ? t.slice(at + 1) : t);
      };
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), [powerOf(p1), powerOf(p2)]));
    },
  },

  // KAZAKUS_POTION_EFFECT（KazakusPotionEffectCardTextBuilder.cs:22-28）：@ 前段
  4: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      return at >= 0 ? t.slice(0, at) : t;
    },
    entity: undefined, // Entity 同（:15-20）
  },

  // PRIMORDIAL_WAND（PrimordialWandCardTextBuilder.cs）：@ 前段
  5: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      return at >= 0 ? t.slice(0, at) : t;
    },
  },

  // ALTERNATE_CARD_TEXT（AlternateCardTextCardTextBuilder.cs:36-40）：按 955 跳段
  6: {
    def:    ctx => skipSegments(baseDef(ctx), tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT)),
    entity: ctx => skipSegments(baseEntity(ctx), altTextIndex(ctx)),
  },

  // SCRIPT_DATA_NUM_1（ScriptDataNum1CardTextBuilder.cs EntityDef 路径）：
  // 恰 2 个 @ 且 NUM_1==0 → 截断于首个 @（**不**替换尾段 @——Entity 路径才那样，本路径直接返回）；
  // 其余：全部 @ 替换为 NUM_1。
  7: {
    def: ctx => {
      const t = decodeWhitespaces(raw(ctx));
      const delim: number[] = [];
      for (let i = t.indexOf('@'); i >= 0; i = t.indexOf('@', i + 1)) delim.push(i);
      const num1 = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      if (delim.length === 2 && num1 === 0) {
        return transform(ctx, t.slice(0, delim[0]));
      }
      return transform(ctx, t.replaceAll('@', String(num1)));
    },
    entity: ctx => {
      // Entity 路径（ScriptDataNum1CardTextBuilder.cs:20-44 BuildCardTextInternal）：
      // 双 @ 且 NUM_1==0 → 段0 + 段1（剩余 @→NUM_1）
      const t = decodeWhitespaces(raw(ctx));
      const delim: number[] = [];
      for (let i = t.indexOf('@'); i >= 0; i = t.indexOf('@', i + 1)) delim.push(i);
      const num1 = String(tag(ctx, TAG.SCRIPT_DATA_NUM_1));
      let out: string;
      if (delim.length === 2 && tag(ctx, TAG.SCRIPT_DATA_NUM_1) === 0) {
        out = t.slice(0, delim[0]) + t.slice(delim[0] + 1).replaceAll('@', num1);
      } else {
        out = t.replaceAll('@', num1);
      }
      return transform(ctx, out);
    },
  },

  // GALAKROND_COUNTER（GalakrondCounterCardTextBuilder.cs:17-23）：
  // @ → GAMEPLAY_GALAKROND...（NUM_2−NUM_1==1 → ONCE else TWICE；GameStrings key 经钩子）
  8: {
    def: ctx => {
      const once = tag(ctx, TAG.SCRIPT_DATA_NUM_2) - tag(ctx, TAG.SCRIPT_DATA_NUM_1) === 1;
      const key = once ? 'GALAKROND_ONCE' : 'GALAKROND_TWICE';
      const v = ctx.lookup?.gameString?.(key) ?? key;
      return transform(ctx, decodeWhitespaces(raw(ctx)).replaceAll('@', v));
    },
  },

  // DECORATE（DecorateCardTextBuilder.cs:5-10）：TryFormat(raw, COST, NUM_2)——Entity only，
  // EntityDef 无重载 → 基类默认（静卡不触发 decoration 文本）。
  9: {
    def:    baseDef,
    entity: ctx => transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
      [tag(ctx, 48), tag(ctx, TAG.SCRIPT_DATA_NUM_2)])), // GAME_TAG.COST=48
  },

  // PLAYER_TAG_THRESHOLD（PlayerTagThresholdCardTextBuilder.cs）：EntityDef @ 前段；
  // Entity 三段 @（controller 的 PLAYER_TAG_THRESHOLD_TAG_ID 指向的玩家 tag ≥ VALUE → 段0+段2，否则段1+{0}=差值）。
  10: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      return at >= 0 ? t.slice(0, at) : t;
    },
    entity: ctx => {
      const t = baseEntity(ctx);
      const a = t.indexOf('@');
      const b = t.indexOf('@', a + 1);
      if (a < 0 || b < 0) return t;
      const tagId = tag(ctx, TAG.PLAYER_TAG_THRESHOLD_TAG_ID);
      const have = ctx.runtime?.controllerTag?.(tagId) ?? 0;
      const threshold = tag(ctx, TAG.PLAYER_TAG_THRESHOLD_VALUE);
      const prefix = t.slice(0, a);
      if (have >= threshold) return prefix + t.slice(b + 1);
      return prefix + tryFormat(t.slice(a + 1, b), [threshold - have]);
    },
  },

  // ENTITY_TAG_THRESHOLD（EntityTagThresholdCardTextBuilder.cs）：同上但读本实体 tag
  // （ENTITY_TAG_THRESHOLD_TAG_ID=2459 指向的 tag 值 vs VALUE=2460）。
  11: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      return at >= 0 ? t.slice(0, at) : t;
    },
    entity: ctx => {
      const t = baseEntity(ctx);
      const a = t.indexOf('@');
      const b = t.indexOf('@', a + 1);
      if (a < 0 || b < 0) return t;
      const tagId = tag(ctx, TAG.ENTITY_TAG_THRESHOLD_TAG_ID);
      const have = tag(ctx, tagId);
      const threshold = tag(ctx, TAG.ENTITY_TAG_THRESHOLD_VALUE);
      const prefix = t.slice(0, a);
      if (have >= threshold) return prefix + t.slice(b + 1);
      return prefix + tryFormat(t.slice(a + 1, b), [threshold - have]);
    },
  },

  // MULTIPLE_ENTITY_NAMES（MultipleEntityNamesCardTextBuilder.cs:7-31）：
  // {0}..{9} ← CARDTEXT_ENTITY_0-9 指向实体名（无效 → GAMEPLAY_UNKNOWN_CREATED_BY）。
  12: {
    // EntityDef（:7-31）：tag==0 → UNKNOWN 占位。
    def: ctx => {
      const names = Array.from({ length: 10 }, (_, i) =>
        refName(ctx, tag(ctx, TAG.CARDTEXT_ENTITY_0 + i)));
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), names));
    },
    // Entity（BuildText :63-101）：tag==0 → **空串**（与 EntityDef 不同）；非零但实体
    // 缺失/无效 → UNKNOWN 占位（对手可见性分支需对局态，离线不建模，注释备案）。
    entity: ctx => {
      const names = Array.from({ length: 10 }, (_, i) => {
        const dbf = tag(ctx, TAG.CARDTEXT_ENTITY_0 + i);
        if (dbf === 0) return '';
        return ctx.lookup?.entityName?.(dbf) ?? unknownName(ctx);
      });
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), names));
    },
  },

  // GAMEPLAY_STRING（GameplayStringTextBuilder.cs）：@ 前缀 + GameStrings(key 前缀+序号)。
  // EntityDef：序号 1（:36-46）；Entity：NUM_1+1 clamp NUM_2（:5-19）。
  13: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      if (at < 0) return t;
      const prefix = ctx.lookup?.gameplayStringPrefix?.(ctx.cardId);
      if (!prefix) return t;
      const v = ctx.lookup?.gameString?.(`${prefix}1`) ?? `${prefix}1`;
      return t.slice(0, at + 1).replaceAll('@', v);
    },
    entity: ctx => {
      const t = baseEntity(ctx);
      const at = t.indexOf('@');
      if (at < 0) return t;
      const prefix = ctx.lookup?.gameplayStringPrefix?.(ctx.cardId);
      if (!prefix) return t;
      let n = tag(ctx, TAG.SCRIPT_DATA_NUM_1) + 1;
      const total = tag(ctx, TAG.SCRIPT_DATA_NUM_2);
      if (n > total) n = total;
      const v = ctx.lookup?.gameString?.(`${prefix}${n}`) ?? `${prefix}${n}`;
      return t.slice(0, at + 1).replaceAll('@', v);
    },
  },

  // ZOMBEAST（ZombeastCardTextBuilder.cs:5-30，ZombeastCardTextBuilder : ModularEntity）：
  // 两模块 powers 文本（去 [x]、换行折空格、冲突 tag 移除）→ string.Format。
  // 模板卡 ICC_828t；EntityDef → ''（ModularEntity 基类）。
  14: {
    def:    () => '',
    entity: ctx => {
      const powerOf = (dbfId: number): string => {
        const c = dbfId !== 0 ? ctx.lookup?.card?.(dbfId) : undefined;
        if (!c?.textInHand) return '';
        let t = c.textInHand;
        const at = t.indexOf('@');
        if (at >= 0) t = t.slice(at + 1);
        t = t.replaceAll('[x]', '');
        if (t.length !== c.textInHand.length - (c.textInHand.includes('[x]') ? 3 : 0)) t = t.replaceAll('\n', ' ');
        return t;
      };
      const p1 = powerOf(tag(ctx, TAG.MODULAR_ENTITY_PART_1));
      const p2 = powerOf(tag(ctx, TAG.MODULAR_ENTITY_PART_2));
      // GetRawCardTextInHandForCardBeingBuilt：power1 为空时模板换 ICC_828t 文本（{0}\n{1}）
      let template = decodeWhitespaces(raw(ctx));
      if (!p1) {
        const zombeastTpl = ctx.lookup?.card?.(0)?.textInHand ?? '{0}\n{1}';
        template = zombeastTpl;
      }
      return transform(ctx, tryFormat(template, [p1, p2]));
    },
  },

  // ZOMBEAST_ENCHANTMENT（ZombeastEnchantmentCardTextBuilder.cs:5-17）：
  // 两模块 EntityDef 名 → TryFormat(raw, name1, name2)；无模块 → ''。
  15: {
    def: ctx => {
      const d1 = tag(ctx, TAG.MODULAR_ENTITY_PART_1);
      const d2 = tag(ctx, TAG.MODULAR_ENTITY_PART_2);
      if (d1 === 0 || d2 === 0) return '';
      const n1 = ctx.lookup?.cardName?.(d1) ?? '';
      const n2 = ctx.lookup?.cardName?.(d2) ?? '';
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), [n1, n2]));
    },
  },

  // HIDDEN_CHOICE（HiddenChoiceCardTextBuilder.cs GetCorrectSubstring:6-16）：
  // Split('@')[(OVERRIDE || HIDDEN_CHOICE)]，越界返回原文。
  16: {
    def: ctx => {
      const t = baseDef(ctx);
      const idx = tag(ctx, TAG.HIDDEN_CHOICE_OVERRIDE) || tag(ctx, TAG.HIDDEN_CHOICE);
      const segs = t.split('@');
      return idx < segs.length ? segs[idx] : t;
    },
  },

  // INVESTIGATE（InvestigateCardTextBuilder.cs）：EntityDef → 空串
  17: { def: () => '' },

  // REFERENCE_CREATOR_ENTITY（ReferenceCreatorEntityCardTextBuilder.cs:3-11）：
  // {0} ← CREATOR(313) 实体名；Entity only（EntityDef → 基类）。
  18: {
    def:    baseDef,
    entity: ctx => transform(ctx,
      tryFormat(decodeWhitespaces(raw(ctx)), [refName(ctx, tag(ctx, TAG.CREATOR))])),
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_ENTITY（ReferenceScriptDataNum1EntityCardTextBuilder.cs:31-42）：
  // @ → NUM_2（仅当文本含 @）；{0} ← NUM_1 实体名。
  19: {
    def: ctx => {
      let t = decodeWhitespaces(raw(ctx));
      if (t.includes('@')) t = t.replaceAll('@', String(tag(ctx, TAG.SCRIPT_DATA_NUM_2)));
      return transform(ctx, tryFormat(t, [refName(ctx, tag(ctx, TAG.SCRIPT_DATA_NUM_1))]));
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY（ReferenceScriptDataNum1Num2EntityCardTextBuilder.cs）：
  // {0}/{1} ← NUM_1/NUM_2 实体名。
  20: {
    def: ctx => transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), [
      refName(ctx, tag(ctx, TAG.SCRIPT_DATA_NUM_1)),
      refName(ctx, tag(ctx, TAG.SCRIPT_DATA_NUM_2)),
    ])),
  },

  // UNDATAKAH_ENCHANT（UndatakahCardTextBuilder.cs:4-26）：CUSTOMTEXT1-3 有无选
  // GAMEPLAY_UNDATAKAH1/2/3 模板 → TryFormat(模板, 名1, 名2, 名3)；Entity only。
  21: {
    def:    baseDef,
    entity: ctx => {
      const has = (t: number) => tag(ctx, t) !== 0;
      const key = has(TAG.CUSTOMTEXT3)
        ? 'GAMEPLAY_UNDATAKAH3'
        : has(TAG.CUSTOMTEXT2)
          ? 'GAMEPLAY_UNDATAKAH2'
          : has(TAG.CUSTOMTEXT1) ? 'GAMEPLAY_UNDATAKAH1' : '';
      if (!key) return baseEntity(ctx);
      const tpl = ctx.lookup?.gameString?.(key) ?? key;
      return transform(ctx, tryFormat(tpl, [
        refName(ctx, tag(ctx, TAG.CUSTOMTEXT1)),
        refName(ctx, tag(ctx, TAG.CUSTOMTEXT2)),
        refName(ctx, tag(ctx, TAG.CUSTOMTEXT3)),
      ]));
    },
  },

  // SPELL_DAMAGE_ONLY（SpellDamageOnlyCardTextBuilder.cs:4-11）：TransformCardText
  // 仅带 DamageBonus（GetDamageBonus() = SPELL_POWER 类 tag 合并，调用方经 bonuses 提供）。
  22: {
    def:    baseDef,
    entity: ctx => transformCardText(decodeWhitespaces(raw(ctx)),
      { bonuses: { damage: ctx.bonuses?.damage ?? 0 }, infinityMinDigits: 7 }),
  },

  // HIDDEN_ENTITY（HiddenEntityCardTextBuilder.cs:4-16）：Split('@')[0]；
  // HIDDEN_CHOICE>0 → TryFormat(seg[1], 该 dbfId 的卡名)。
  24: {
    def: ctx => {
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      const choice = tag(ctx, TAG.HIDDEN_CHOICE);
      if (choice > 0 && segs.length > 1) {
        return transform(ctx, tryFormat(segs[1], [ctx.lookup?.cardName?.(choice) ?? '']));
      }
      return transform(ctx, segs[0]);
    },
  },

  // SCORE_VALUE_COUNT_DOWN（ScoreValueCountDownCardTextBuilder.cs）：
  // Entity：@ → SCORE_VALUE_1−SCORE_VALUE_2（<0 截 0）；EntityDef：@ → SCORE_VALUE_1。
  25: {
    def: ctx => transform(ctx,
      decodeWhitespaces(raw(ctx)).replaceAll('@', String(tag(ctx, TAG.SCORE_VALUE_1)))),
    entity: ctx => {
      const remain = Math.max(0, tag(ctx, TAG.SCORE_VALUE_1) - tag(ctx, TAG.SCORE_VALUE_2));
      return transform(ctx, decodeWhitespaces(raw(ctx)).replaceAll('@', String(remain)));
    },
  },

  // SCRIPT_DATA_NUM_1_NUM_2（ScriptDataNum1Num2CardTextBuilder.cs:26-32）
  26: {
    def: ctx => transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), [
      tag(ctx, TAG.SCRIPT_DATA_NUM_1), tag(ctx, TAG.SCRIPT_DATA_NUM_2),
    ])),
  },

  // MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS（MultiAltTextScriptDataNumsCardTextBuilder.cs
  // GetAlternateTextSubstring(EntityDef)+SubstituteScriptDataNums）：Split('@') 按 955
  // （缺省 0；时空扭曲 alt index 依赖对局态经 runtime.baconAltTavernActive）→ TryFormat NUM_1..NUM_6。
  28: {
    def: ctx => {
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      let idx = tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT);
      if (idx === 0 && ctx.runtime?.baconAltTavernActive) {
        idx = tag(ctx, TAG.HAS_TIMEWARPED_TAVERN_ALT_TEXT);
      }
      idx = Math.min(Math.max(idx, 0), segs.length - 1);
      const nums = [TAG.SCRIPT_DATA_NUM_1, TAG.SCRIPT_DATA_NUM_2, TAG.DATA_NUM_3,
        TAG.DATA_NUM_4, TAG.DATA_NUM_5, TAG.DATA_NUM_6].map(t => tag(ctx, t));
      return transform(ctx, tryFormat(segs[idx], nums));
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_CARD_DBID（ReferenceScriptDataNum1CardDBIDCardTextBuilder.cs）：
  // {0} ← NUM_1 指向卡名（0 → GAMEPLAY_UNKNOWN_CREATED_BY）。
  30: {
    def: ctx => {
      const dbf = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      const name = dbf !== 0 ? ctx.lookup?.cardName?.(dbf) : undefined;
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
        [name ?? unknownName(ctx)]));
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_CARD_RACE（ReferenceScriptDataNumCardRaceCardTextBuilder.cs
  // BuildFormatedText 全文）：count!=0 → @→count；{0}..{5} ← NUM_1..NUM_6 的种族名
  // （GetRaceString：count>1 → GetRaceNameBattlegrounds，否则 GetRaceName；0 → 空串）。
  31: {
    def: ctx => {
      let t = decodeWhitespaces(raw(ctx));
      const count = tag(ctx, TAG.QUEST_PROGRESS_TOTAL);
      if (count !== 0) t = t.replaceAll('@', String(count));
      const race = (raceTag: number): string => {
        if (raceTag === 0) return '';
        return count > 1
          ? ctx.lookup?.raceBattlegroundsName?.(raceTag) ?? 'UNKNOWN'
          : ctx.lookup?.raceName?.(raceTag) ?? 'UNKNOWN';
      };
      const nums = [TAG.SCRIPT_DATA_NUM_1, TAG.SCRIPT_DATA_NUM_2, TAG.DATA_NUM_3,
        TAG.DATA_NUM_4, TAG.DATA_NUM_5, TAG.DATA_NUM_6];
      return transform(ctx, tryFormat(t, nums.map(n => race(tag(ctx, n)))));
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_ENTITY_POWER（ReferenceScriptDataNum1EntityPower.cs）：
  // EntityDef：@ 前段；Entity：非构建态 → 段1 + {0}=NUM_1 实体的 BuildCardTextInHand（去换行/[x]）。
  29: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      return at >= 0 ? t.slice(0, at) : t;
    },
    entity: ctx => {
      const refDbf = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      const refText = refDbf !== 0 ? ctx.lookup?.buildCardText?.(refDbf) : undefined;
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      if (refText === undefined) return transform(ctx, segs[0]);
      const body = refText.replaceAll('\n', ' ').replaceAll('[x]', '');
      return transform(ctx, tryFormat(segs[1] ?? segs[0], [body]));
    },
  },

  // SPELL_ABSORB（SpellAbsorbCardTextBuilder.cs）：EntityDef = @ → NUM_1 段选
  // （GetAlternateCardText builtText 版）；Entity 另加 {0} ← SCRIPT_DATA_ENT_1(4) 实体名。
  37: {
    def: ctx => {
      const t = baseDef(ctx);
      const at = t.indexOf('@');
      if (at < 0) return t;
      const num1 = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      // GetAlternateCardText(builtText)：num1==0 → @ 后段（引用法术未定）；else 按值跳段
      const segs = t.split('@');
      return num1 === 0 ? (segs[1] ?? t) : (segs[Math.min(num1, segs.length - 1)] ?? t);
    },
  },

  // DRUSTVAR_HORROR（DrustvarHorrorTargetingTextBuilder.cs）：
  // string.Format(raw, UNKNOWN, UNKNOWN)（{0}{1} 缺省引用名）。
  23: {
    def: ctx => transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
      [unknownName(ctx), unknownName(ctx)])),
  },

  // REWIND_MECHANIC_CARD_TEXT_BUILDER（RewindMechanicCardTextBuilder.cs:8-18）：
  // USED_REWIND>0 → 删 "<b>Rewind</b>"；TryFormat(raw) 无参（{{}} 转义仍在）。
  39: {
    def:    ctx => transform(ctx, decodeWhitespaces(raw(ctx))),
    entity: ctx => {
      let t = decodeWhitespaces(raw(ctx));
      if (tag(ctx, TAG.USED_REWIND) > 0) t = t.replaceAll('<b>Rewind</b>', '');
      return transform(ctx, tryFormat(t, []));
    },
  },

  // ALT_TEXT_REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY_POWER
  // （AltTextScriptDataNum1Num2EntityPowerCardTextBuilder.cs）：
  // EntityDef：基类文本 → 955 分段；Entity：BuildTextWithReferenceEntityPowers（同 35）。
  38: {
    def:    ctx => skipSegments(baseDef(ctx), tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT)),
    entity: ctx => {
      const d1 = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      const d2 = tag(ctx, TAG.SCRIPT_DATA_NUM_2);
      const t1 = d1 !== 0 ? ctx.lookup?.buildCardText?.(d1) : undefined;
      const t2 = d2 !== 0 ? ctx.lookup?.buildCardText?.(d2) : undefined;
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      if (t1 === undefined || t2 === undefined) return transform(ctx, segs[0]);
      const clean = (x: string): string => x.replaceAll('\n', ' ').replaceAll('[x]', '');
      return transform(ctx, tryFormat(segs[1] ?? segs[0], [clean(t1), clean(t2)]));
    },
  },

  // BATTLEGROUNDS_TAVERN_SPELL（BattlegroundsTavernSpellCardTextBuilder.cs）：
  // 分段（TAVERN_SPELL_*_INCREASE>0 且对应 NUM==0 → 段1）+ TryFormat(段, NUM1..NUM4+加成)。
  40: {
    def: ctx => {
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      let idx = 0;
      const atkBuff = ctx.runtime?.controllerTag?.(TAG.TAVERN_SPELL_ATTACK_INCREASE) ?? 0;
      const hpBuff = ctx.runtime?.controllerTag?.(TAG.TAVERN_SPELL_HEALTH_INCREASE) ?? 0;
      if (atkBuff > 0 && tag(ctx, TAG.SCRIPT_DATA_NUM_1) === 0) idx = 1;
      else if (hpBuff > 0 && tag(ctx, TAG.SCRIPT_DATA_NUM_2) === 0) idx = 1;
      const seg = segs[Math.min(idx, segs.length - 1)];
      const n1 = tag(ctx, TAG.SCRIPT_DATA_NUM_1) + atkBuff;
      const n2 = tag(ctx, TAG.SCRIPT_DATA_NUM_2) + hpBuff;
      const n3 = tag(ctx, TAG.DATA_NUM_3) + atkBuff;
      const n4 = tag(ctx, TAG.DATA_NUM_4) + hpBuff;
      return transform(ctx, tryFormat(seg, [n1, n2, n3, n4]));
    },
  },

  // DYNAMIC_KEYWORD（DynamicKeywordCardTextBuilder.cs BuildFormatedText(2 参)）：
  // {0}/{1} ← DYNAMIC_KEYWORD1/2 指向 GAME_TAG 的关键词名。
  41: {
    def: ctx => {
      const kw = (t: number): string =>
        tag(ctx, t) !== 0 ? ctx.lookup?.keywordName?.(tag(ctx, t)) ?? '' : '';
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
        [kw(TAG.DYNAMIC_KEYWORD_1), kw(TAG.DYNAMIC_KEYWORD_2)]));
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_CLASS（ReferenceScriptDataNum1Class.cs:58-68）：
  // GetAlternateCardText(raw, classIndex!=0)（bool 重载：true→@ 后段）+ {0} ← GetClassName。
  42: {
    def: ctx => {
      const classIdx = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      const seg = classIdx !== 0 ? (segs[1] ?? segs[0]) : segs[0];
      const name = classIdx !== 0 ? ctx.lookup?.className?.(classIdx) ?? '' : '';
      return transform(ctx, tryFormat(seg, [name]));
    },
  },

  // HERALD（HeraldCardTextBuilder.cs）：{0} ← 巨型随从职业名、{1} ← NUM_1。
  // EntityDef（GetHeraldColossalName(EntityDef)：DraftManager 对局征召态离线无 →
  // entityDef.GetClass()（GAME_TAG.CLASS=199）→ GAMEPLAY_HERALD_<TAG_CLASS 名>，未知 → DEFAULT）；
  // Entity（GetHeraldColossalName(Entity)）：controller 的 HERALD_COLOSSAL_CLASS(4534)。
  43: {
    def: ctx => {
      const classTag = tag(ctx, 199); // GAME_TAG.CLASS
      const enumName = TAG_CLASS_NAMES[classTag];
      const name = ctx.lookup?.gameString?.(enumName ? `GAMEPLAY_HERALD_${enumName}` : 'GAMEPLAY_HERALD_DEFAULT')
        ?? 'GAMEPLAY_HERALD_DEFAULT';
      return transform(ctx, decodeWhitespaces(raw(ctx))
        .replaceAll('{0}', name)
        .replaceAll('{1}', String(tag(ctx, TAG.SCRIPT_DATA_NUM_1))));
    },
    entity: ctx => {
      const classTag = ctx.runtime?.controllerTag?.(TAG.HERALD_COLOSSAL_CLASS) ?? 0;
      const enumName = TAG_CLASS_NAMES[classTag];
      const name = ctx.lookup?.gameString?.(enumName ? `GAMEPLAY_HERALD_${enumName}` : 'GAMEPLAY_HERALD_DEFAULT')
        ?? 'GAMEPLAY_HERALD_DEFAULT';
      return transform(ctx, decodeWhitespaces(raw(ctx))
        .replaceAll('{0}', name)
        .replaceAll('{1}', String(tag(ctx, TAG.SCRIPT_DATA_NUM_1))));
    },
  },

  // ALTERNATE_CARD_TEXT_WITH_SCRIPT_DATA（AlternateCardTextWitheScriptDataCardTextBuilder.cs）：
  // 分段（955）→ TryFormat(段, "", NUM_1..NUM_6)（{0} 恒空串）。
  44: {
    def: ctx => {
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      const idx = Math.min(Math.max(tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT), 0), segs.length - 1);
      const nums = [TAG.SCRIPT_DATA_NUM_1, TAG.SCRIPT_DATA_NUM_2, TAG.DATA_NUM_3,
        TAG.DATA_NUM_4, TAG.DATA_NUM_5, TAG.DATA_NUM_6].map(t => tag(ctx, t));
      return transform(ctx, tryFormat(segs[idx], ['', ...nums]));
    },
  },

  // BATTLEGROUNDS_DEEP_BLUES_SPELL（BattlegroundsDeepBluesCardTextBuilder.cs）：
  // TryFormat(raw, NUM_1×(1+BACON_DEEP_BLUE), NUM_2×(1+…))（加成取玩家态钩子，静态=0）。
  45: {
    def: ctx => {
      const mult = 1 + (ctx.runtime?.localPlayerTag?.(TAG.BACON_DEEP_BLUE) ?? 0);
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)), [
        tag(ctx, TAG.SCRIPT_DATA_NUM_1) * mult,
        tag(ctx, TAG.SCRIPT_DATA_NUM_2) * mult,
      ]));
    },
  },

  // POWERED_UP（PoweredUpTargetingTextBuilder.cs）：无 BuildCardTextInHand 重载 → 基类。
  27: { def: baseDef, entity: baseEntity },

  // BG_QUEST（BGQuestCardTextBuilder.cs BuildText）：
  // TryFormat(raw, QUEST_PROGRESS_TOTAL, 奖励卡名, race1 名, race2 名)；
  // GetRaceString：count>1 → 酒馆种族名；@：QUEST_REWARD_DATABASE_ID!=0 → 删 @ 字符，否则截前段。Entity only。
  32: {
    def:    baseDef,
    entity: ctx => {
      const progress = tag(ctx, TAG.QUEST_PROGRESS_TOTAL);
      const reward = tag(ctx, TAG.QUEST_REWARD_DATABASE_ID);
      const rewardName = reward !== 0 ? ctx.lookup?.cardName?.(reward) ?? '' : '';
      const raceStr = (raceTag: number): string => {
        if (tag(ctx, raceTag) === 0) return '';
        return progress > 1
          ? ctx.lookup?.raceBattlegroundsName?.(tag(ctx, raceTag)) ?? 'UNKNOWN'
          : ctx.lookup?.raceName?.(tag(ctx, raceTag)) ?? 'UNKNOWN';
      };
      let out = tryFormat(decodeWhitespaces(raw(ctx)), [
        progress, rewardName, raceStr(TAG.SCRIPT_DATA_NUM_1), raceStr(TAG.SCRIPT_DATA_NUM_2),
      ]);
      const at = out.indexOf('@');
      if (at >= 0) out = reward !== 0 ? out.slice(0, at) + out.slice(at + 1) : out.slice(0, at);
      return transform(ctx, out);
    },
  },

  // MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS_REF_SDN6_CARD_DBID（MultiAltTextScriptDataNums 的
  // CardDBID 变体：SetTagRefType(NUM_6, CardDBID) → {5} 为 NUM_6 指向卡名；其余同 28）。
  33: {
    def: ctx => {
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      let idx = tag(ctx, TAG.USE_ALTERNATE_CARD_TEXT);
      if (idx === 0 && ctx.runtime?.baconAltTavernActive) {
        idx = tag(ctx, TAG.HAS_TIMEWARPED_TAVERN_ALT_TEXT);
      }
      idx = Math.min(Math.max(idx, 0), segs.length - 1);
      const dbf6 = tag(ctx, TAG.DATA_NUM_6);
      const name6 = dbf6 !== 0 ? ctx.lookup?.cardName?.(dbf6) : undefined;
      const nums = [TAG.SCRIPT_DATA_NUM_1, TAG.SCRIPT_DATA_NUM_2, TAG.DATA_NUM_3,
        TAG.DATA_NUM_4, TAG.DATA_NUM_5].map(t => tag(ctx, t));
      return transform(ctx, tryFormat(segs[idx], [...nums, name6 ?? unknownName(ctx)]));
    },
  },

  // ZILLIAX_DELUXE_3000（ZilliaxDeluxe3000CardTextBuilder.cs BuildFormattedText(EntityDef)）：
  // 两有效模块 → GameStrings(ZILLIAX_DELUXE_COMBINED_MODULE_min_max)；1 个 → 该模块文本；
  // 0 个 → 基类默认。功能模块表（dbf→组合编号）经钩子 zilliaxModule 提供。
  34: {
    def: ctx => {
      const d1 = tag(ctx, TAG.MODULAR_ENTITY_PART_1);
      const d2 = tag(ctx, TAG.MODULAR_ENTITY_PART_2);
      const m1 = d1 !== 0 ? ctx.lookup?.zilliaxModule?.(d1) : undefined;
      const m2 = d2 !== 0 ? ctx.lookup?.zilliaxModule?.(d2) : undefined;
      const valid = [m1, m2].filter(m => m !== undefined);
      if (valid.length === 2 && m1 !== undefined && m2 !== undefined) {
        const a = Math.min(m1, m2), b = Math.max(m1, m2);
        const key = `ZILLIAX_DELUXE_COMBINED_MODULE_${a}_${b}`;
        return transform(ctx, ctx.lookup?.gameString?.(key) ?? key);
      }
      if (valid.length === 1 && (m1 !== undefined || m2 !== undefined)) {
        // GetTextOfOneValidModule（ZilliaxDeluxe3000CardTextBuilder.cs）：
        // 单有效模块 → 该模块卡的 default 文本（LookupTextOfZilliaxModule = GetDefaultCardTextInHand）
        const dbf = (m1 !== undefined ? d1 : d2);
        const mod = ctx.lookup?.card?.(dbf);
        return transform(ctx, mod?.textInHand ? decodeWhitespaces(mod.textInHand) : '');
      }
      return baseDef(ctx);
    },
  },

  // REFERENCE_SCRIPT_DATA_NUM_1_NUM_2_ENTITY_POWER（ReferenceScriptDataNum1Num2EntityPower.cs
  // BuildTextWithReferenceEntityPowers）：两实体 BuildCardTextInHand 递归（去换行/[x]）→
  // string.Format(段1, 文本1, 文本2)；任一缺 → 段0。Entity only（EntityDef → 基类）。
  35: {
    def:    baseDef,
    entity: ctx => {
      const d1 = tag(ctx, TAG.SCRIPT_DATA_NUM_1);
      const d2 = tag(ctx, TAG.SCRIPT_DATA_NUM_2);
      const t1 = d1 !== 0 ? ctx.lookup?.buildCardText?.(d1) : undefined;
      const t2 = d2 !== 0 ? ctx.lookup?.buildCardText?.(d2) : undefined;
      const segs = decodeWhitespaces(raw(ctx)).split('@');
      if (t1 === undefined || t2 === undefined) return transform(ctx, segs[0]);
      const clean = (x: string): string => x.replaceAll('\n', ' ').replaceAll('[x]', '');
      return transform(ctx, tryFormat(segs[1] ?? segs[0], [clean(t1), clean(t2)]));
    },
  },

  // BATTLEGROUNDS_ZILLIAX（BattlegroundsZilliaxCardTextBuilder.cs BuildCardText）：
  // @ ← 三倍化底卡（1471/3499/3500，去重）关键词名换行拼接（表经钩子 bgZilliaxKeyword）。
  36: {
    def: ctx => {
      const ids = [TAG.BACON_TRIPLED_BASE_MINION_ID, TAG.BACON_TRIPLED_BASE_MINION_ID2,
        TAG.BACON_TRIPLED_BASE_MINION_ID3];
      const seen = new Set<number>();
      let keywords = '';
      for (const t of ids) {
        const dbf = tag(ctx, t);
        if (dbf === 0 || seen.has(dbf)) continue;
        seen.add(dbf);
        const kwTag = ctx.lookup?.bgZilliaxKeyword?.(dbf);
        const kwName = kwTag !== undefined ? ctx.lookup?.keywordName?.(kwTag) : undefined;
        keywords = keywords ? `${keywords}\n${kwName ?? ''}` : kwName ?? '';
      }
      return transform(ctx, decodeWhitespaces(raw(ctx)).replaceAll('@', keywords));
    },
  },

  // SILVER_HAND_RECRUIT（SilverHandCardTextBuilder.cs FormatSilverHandText）：
  // TryFormat(raw, "atk/hp", "n")——EntityDef 固定 (1,1)；Entity 经 runtime.recruitStats。
  46: {
    def: ctx => {
      const atk = 1, hp = 1;
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
        [`${atk}/${hp}`, isFrenchStyleN(atk) ? 'n' : '']));
    },
    entity: ctx => {
      const atk = ctx.runtime?.recruitStats?.atk ?? 1;
      const hp = ctx.runtime?.recruitStats?.hp ?? 1;
      return transform(ctx, tryFormat(decodeWhitespaces(raw(ctx)),
        [`${atk}/${hp}`, isFrenchStyleN(atk) ? 'n' : '']));
    },
  },
};
