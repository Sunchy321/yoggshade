/** 渲染计划编译（py compile_plan_ally 的卡牌相关子集对译）：fixture 卡数据 + 静态表 → RenderPlan。
 *
 * 静态基底（components 几何/材质、camera、stat_gems、gem 相位）来自资产包 plan.json（帧级，
 * 卡牌无关）；本模块只推导卡牌 delta：类色图集、原画、稀有度宝石、ELITE 龙、攻/血宝石显隐、
 * 种族板、六个文字角色。推导规则与 py 链同源（decomp 出处见 py 注释，此处不重复）。 */
import type { AssetPack, FrameMaterial, PlanComponent, PrefabReport, RenderPlan, WatermarkSpec } from './types.js';
import { resolveFixtureText, transformCardText, tryFormat } from '@tcg-cards/hs-text-builder';

/** 文本重建（@tcg-cards/hs-text-builder）——fail-fast：resolve 抛错 = 数据/实现缺口，
 *  带卡牌上下文重抛让 L2 在该卡上失败，而不是静默渲染错误文本。 */
function resolveDescText(fixture: FixtureCard, cardId: string): string {
  try {
    return resolveFixtureText(fixture, 'zhCN', cardId).text;
  } catch (err) {
    throw new Error(
      `[textbuilder] ${cardId} (type ${fixture.textBuilderType}) 文本重建失败`, { cause: err });
  }
}

export interface FixtureCard {
  cardId: string;
  dbfId:  number;
  preset:                    { label: string; premium: string; template: string; zone: string; reason: string;
    /** CARD DBF m_signatureFrameId（SIGNATURE_FRAME 表键；卡级事实，
                                *  仅 premium=SIGNATURE 时消费——T2 落地，spec 实现决策 3） */
    signatureFrameId?: number; };
  textBuilderType:           number;
  name:                      Record<string, string>;
  textInHand:                Record<string, string>;
  tags:                      Record<string, number>;
  /** CARD DBF m_watermarkTextureOverride 的逐卡镜像（exporter 导出；空串 = 无逐卡覆盖） */
  watermarkTextureOverride?: string;
}

/** 卡集水印三表（scripts/extract_watermarks.py → data/card_meta/，findings
 *  watermark-rendering-2026-10-07 §5）。 */
export interface WatermarkTables {
  /** CARD_SET 全表：set → 水印纹理 ref / core 标记（Actor.cs:5096-5104 消费） */
  sets:      Record<string, { m_isCoreCardSet: number, m_cardWatermarkTexture: string }>;
  /** CARD_SET_TIMING 全表（dbf 表序）：card_id → [[set_id, event], ...]；
   *  GetCardSet = 按序首条 event==203（EntityBase.cs:1351-1377 离线复刻） */
  timings:   Record<string, [number, number][]>;
  /** CARD DBF m_watermarkTextureOverride 非空全集（EntityDef.cs:258-261） */
  overrides: Record<string, string>;
}

export interface StaticTables {
  class:          Record<string, string>; // TAG_CLASS 枚举值 → 枚举名（DRUID/HUNTER/…；见 extract_static_tables.py）
  raceZh:         Record<number, string>; // TAG_RACE 枚举值 → zhCN
  schoolZh?:      Record<number, string>; // TAG_SPELL_SCHOOL 枚举值 → zhCN（法术学派板）
  colorSwitcher:  Record<string, (string | null)[]>; // family → ColorType 下标 → 图集 AssetReference
  hideTags:       Record<string, number>;
  /** factionIconSt：CardColorSwitcher faction* 材质序列化摘要（extract_banner_assets.py），
   *  下标 = FactionColorType（0=GENERIC 空，1..6=帮派/星际）；阵营横幅运行时换材质的编译期输入。 */
  factionIconSt?: { normal: (import('./types.js').FactionMaterialSt | null)[];
    signature:              (import('./types.js').FactionMaterialSt | null)[]; };
}

/** GAME_TAG id（py scene_compiler.py:102 同源）。 */
const TAG = {
  COST:     48, PREMIUM:  12, CLASS:    199, CARDTYPE: 202, RARITY:   203,
  ELITE:    114, CARDRACE: 200, HEALTH:   45, ATK:      47, CARD_SET: 275,
} as const;

/** TAG_CLASS 枚举名 → CardColorSwitcher.ColorType（= switcher 序列化下标；
 * CardColorSwitcher.GetColorTypeForClass switch 对译，explore/ilspy/CardColorSwitcher.cs:171-189）。
 * 表键是 TAG_CLASS 枚举名（tables.class），未列出的（INVALID/NEUTRAL/WHIZBANG）→ 0 = TYPE_GENERIC。 */
const COLOR_TYPE_FOR_CLASS: Record<string, number> = {
  WARLOCK:     10, ROGUE:       8, DRUID:       3, HUNTER:      4, MAGE:        5,
  PALADIN:     6, PRIEST:      7, SHAMAN:      9, WARRIOR:     11,
  DREAM:       4, DEATHKNIGHT: 1, DEMONHUNTER: 2,
};

/** 稀有度宝石图集偏移/着色（Actor.cs:101-115 常量）。 */
const GEM_TEXTURE_OFFSET: Record<string, [number, number]> = {
  Common: [0.0, 0.0], Rare: [0.5, 0.0], Epic: [0.0, 0.5], Legendary: [0.5, 0.5],
};
const GEM_COLOR: Record<string, [number, number, number]> = {
  Common:    [0.549, 0.549, 0.549], Rare:      [0.1529, 0.498, 1.0],
  Epic:      [0.596, 0.1568, 0.7333], Legendary: [1.0, 0.5333, 0.0],
};
/** TAG_RARITY 枚举值 → 名（0=INVALID 2=FREE 不显示宝石）。 */
const RARITY_NAMES: Record<number, string> = { 1: 'Common', 3: 'Rare', 4: 'Epic', 5: 'Legendary' };

/** SetMaterialPremium 类色常量（Actor.cs:107-129 照抄：protected readonly Color CLASS_COLOR_*，
 *  Color(r,g,b) alpha=1）。地标另表 CLASS_COLOR_LOCATION_*（:131-153）——异画地标帧未抽，
 *  入票时再引（GetClassColor 对 IsLocation 分流，Actor.cs:6461-6466）。 */
const CLASS_COLOR: Record<string, [number, number, number]> = {
  GENERIC:     [0.7, 0.7, 0.7],
  WARLOCK:     [0.33, 0.2, 0.4],
  ROGUE:       [0.23, 0.23, 0.23],
  DRUID:       [0.42, 0.29, 0.14],
  SHAMAN:      [0, 0.32, 0.71],
  HUNTER:      [0.26, 0.54, 0.18],
  MAGE:        [0.44, 0.48, 0.69],
  PALADIN:     [0.71, 0.49, 0.2],
  PRIEST:      [1, 1, 1],
  WARRIOR:     [0.43, 0.14, 0.14],
  DEATHKNIGHT: [0.0666667, 0.5294, 0.5843],
  DEMONHUNTER: [0.0902, 0.2275, 0.1961],
};

/** TAG_CARDTYPE → switcher 族（Actor.cs SetMaterialWithTexture + CardColorSwitcher.GetTexture
 * 的 switch 对译；INVALID/QUEST_REWARD → 空串 = 不覆写）。 */
function textureFamily(cardType: number): string {
  switch (cardType) {
  case 4: return 'minionCardTextures'; // MINION（含 BATTLEGROUND_HERO_BUDDY=47）
  case 47: return 'minionCardTextures';
  case 5: return 'spellCardTextures'; // SPELL
  case 3: return 'heroCardTextures'; // HERO
  case 7: return 'weaponCardTextures'; // WEAPON
  case 39: return 'locationCardTextures'; // LOCATION
  case 42: return 'battlegroundsSpellCardTextures';
  case 44: return 'battlegroundsTrinketCardTextures';
  case 43: return 'battlegroundsAnomalyCardTextures';
  case 23: return 'mercenariesAbilityCardTextures'; // LETTUCE_ABILITY
  default: return '';
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ============================================================================
// 卡集水印裁决（Actor.UpdateWatermark，Actor.cs:5075-5135 逐条复刻；
// 研究/证据：docs/findings/watermark-rendering-2026-10-07.md；Angelia 参照 =
// ta_watermark.resolve_watermark_ref。写点 = desc 材质 _SecondTex + _SecondTint.a）
// ============================================================================

/** GAME_TAG.HIDE_WATERMARK（game_tag.csv；Actor.cs:5106）。 */
const TAG_HIDE_WATERMARK = 1107;
/** WATERMARK_ALPHA_VALUE（Actor.cs:183）。 */
const WATERMARK_ALPHA = 99 / 128;
/** SPECIAL_EVENT_ALWAYS（EventTimingManager.IsEventActive_Impl：203 恒活、164 恒假、
 *  服务器窗口事件离线判假——冻结参照口径，findings §1）。 */
const EVENT_ALWAYS = 203;
/** 年标 CoreIcon_Even（SetRotationIcon.cs:33-40；奇偶 = 轮换年%2，冻结口径=偶数轮，
 *  78325 参照圣甲虫目检裁决）。 */
const YEAR_ICON_EVEN_REF = 'CoreIcon_Even.tif:8f398522346ce634bb1e26b2f556403f';

/** 水印纹理 ref（"Name.ext:guid"）→ 资产包路径（extract_watermarks.py 命名
 *  {资产实名}_{guid8}.png；官方 47 refs 资产实名与 ref 名一致，探针实证）。 */
function watermarkRefFile(ref: string): string {
  const i = ref.indexOf(':');
  const [name, guid] = i >= 0 ? [ref.slice(0, i), ref.slice(i + 1)] : [ref, ''];
  return `watermarks/${name.replace(/\.[^.]+$/, '')}_${guid.slice(0, 8)}.png`;
}

function resolveWatermark(
  fixture: FixtureCard,
  wmTables: WatermarkTables,
  tags: Record<string, number>,
  ctx: { raceText: string, schoolText: string, cardType: number, isHeroCard: boolean },
  hasAsset: (key: string) => boolean = () => true,
): WatermarkSpec {
  const dbfId = String(fixture.dbfId);
  // GetCardSet（EntityBase.cs:1351-1377）：tag 183 恒缺省（CARD_TAG 表 0 行）→
  // CARD_SET_TIMING 按序首条活跃 timing；全不活跃 → INVALID → set 纹理空 → alpha 0。
  // （actor 级 m_watermarkCardSetOverride = 协议 overrideWatermark →
  // WATERMARK_OVERRIDE_CARD_SET，Actor.cs:5085-5087；TS fixture 链暂无该输入，留 TODO。）
  const setId = (wmTables.timings[dbfId] ?? []).find(([, ev]) => ev === EVENT_ALWAYS)?.[0] ?? null;
  const setRow = setId !== null ? wmTables.sets[String(setId)] : undefined;
  // 纹理四级优先（Actor.cs:5083-5104）：逐卡 override（fixture 字段镜像优先，余查
  // CARD DBF 全表；与 set 活跃性无关）→ 活跃 set 的 CardWatermarkTexture；
  // IsCoreCard（= 活跃 set 行 m_isCoreCardSet，EntityBase.cs:1068-1081）→ 无条件年标。
  let ref = fixture.watermarkTextureOverride || wmTables.overrides[dbfId] || '';
  if (!ref && setRow) ref = setRow.m_cardWatermarkTexture || '';
  if (setRow?.m_isCoreCardSet) ref = YEAR_ICON_EVEN_REF;
  // alpha（:5106/:5113-5118）：HIDE_WATERMARK 或纹理裁决空串 → 0。
  const hide = (tags[TAG_HIDE_WATERMARK] ?? 0) !== 0 || !ref;
  // offset（OffsetDescriptionTexture，Actor.cs:6188 + 常量 :599-601）：
  // y = withRace ? 0 : 0.07；withRace = GetRaceText 非空（随从种族名/法术学派名，
  // EntityBase.cs:1251-1264）|| IsWeapon || IsLocation（:6254）；
  // IsHero 早退（:6217）→ null（x/y 保留序列化值，渲染端从材质读取）。
  const withRace = ctx.isHeroCard
    ? null
    : !!ctx.raceText || !!ctx.schoolText || ctx.cardType === 7 || ctx.cardType === 39;
  // 序列化占位 ref 不渲染水印（ticket 20）：佣兵等集合的 m_cardWatermarkTexture 是
  // 短 guid 序列化占位（GenFX_Set1_Icon.psd:9996d2ef… 家族），不在提取 catalog——
  // extract_watermarks.py 头注释「运行时恒被 UpdateWatermark 改写」。改写结果以基准图
  // 为准：reference/LT23_802P2、LT23_803P2 desc 区 3× 放大目检无水印（对照 GDB_142
  // 同区域有清晰涡纹）= 「纹理空串」语义（Actor.cs:5113-5118 → alpha 0）。故包内无该
  // 纹理文件 → 按空串裁决；catalog 内 47 refs 均已提取，此分支只命中占位家族，
  // 不会掩盖真实提取缺口。
  const file = ref ? watermarkRefFile(ref) : null;
  const placeholderMissing = file !== null && !hasAsset(file);
  return {
    tex_file: file !== null && !placeholderMissing ? file : null,
    alpha:    hide || placeholderMissing ? 0 : WATERMARK_ALPHA,
    offset_y: withRace === null ? null : (withRace ? 0 : 0.07),
  };
}

// ============================================================================
// 官方 opaque-edge alpha 修复（exporter ExporterController.cs:7898-7968 对译）
// ============================================================================
// 游戏渲染到不透明屏幕帧缓冲：opaque 队列材质的 DXT5 alpha 是形状蒙版而非透明度，屏幕上不可见。
// 离线链照纹理 alpha 混合会抠出透明洞（地标左半透出卡背平面；符文/铸造/多职业横幅同理）——
// 官方 RTT 走 Custom/AlphaFillOpaque（FS 输出 alpha=1）给 opaque 几何补满 alpha；exporter 则在
// 导出 PNG 后对命中名单的像素强制 alpha=255。此处按同一名单在光栅期标记 opaque（忽略纹理 alpha）。
// 名单与排除项逐字同源 exporter；shader 白名单（Hero/Unlit[_Transparent]、Custom/Card/Unlit_2Texture2uv）
// 在 exporter 里只与同名条件合取（7908-7922），故本处只看名字条件。

/** OPAQUE_EDGE_ALPHA_REPAIR 名字模式（exporter ExporterController.cs:7925-7947）。 */
const OPAQUE_EDGE_PATTERNS = [
  'Rune_', 'CardRunes', 'CardRune',
  'Forge', 'ForgeBanner', 'Prepare', 'PrepareBanner', 'Tradeable', 'TradeableBanner',
  'Multiclass_Ribbon', 'MulticlassRibbon',
  'Card_Location_InHand_Mat', 'Card_Location_InHand_BannerAtlas', 'Card_InHand_Location',
];

/** soft effect 排除模式（exporter ExporterController.cs:7949-7968 IsSoftEffectAlphaRepairName）。 */
const SOFT_EFFECT_PATTERNS = [
  'Shadow', 'Glow', 'Highlight', 'Spark', 'Mote', 'Smoke', 'Fog', 'Burst', 'Particle', 'Trail',
];

function matchesAny(patterns: string[], name: string | undefined | null): boolean {
  if (!name) return false;
  const low = name.toLowerCase();
  return patterns.some(p => low.includes(p.toLowerCase()));
}

/** 节点名 / 材质名 / 有效纹理名 命中修复名单且不含 soft effect → 该材质按不透明绘制。 */
export function needsOpaqueEdgeRepair(
  nodeName: string | undefined,
  materialName: string | undefined | null,
  texFile: string | undefined | null,
): boolean {
  const texName = texFile ? texFile.split('/').pop()!.replace(/\.png$/i, '') : undefined;
  const names = [nodeName, materialName ?? undefined, texName];
  if (names.some(n => matchesAny(SOFT_EFFECT_PATTERNS, n))) return false;
  return names.some(n => matchesAny(OPAQUE_EDGE_PATTERNS, n));
}

function setSlotTex(comp: PlanComponent, slot: number, file: string | null): void {
  const s = comp.material_slots?.find(x => x.slot === slot);
  if (!s) return;
  if (file === null) delete s._MainTex_runtime;
  else s._MainTex_runtime = { file };
}

export function compilePlan(
  fixture: FixtureCard,
  tables: StaticTables,
  base: AssetPack,
): RenderPlan {
  const plan = clone(base.plan!) as RenderPlan;
  const tags = fixture.tags;
  const binding = (plan as unknown as { actor_binding: Record<string, string | number> }).actor_binding;
  const matIdx = (k: string): number => binding[k] as number;

  // ---- 类色图集（TAG_CLASS → ColorType → family 下标；Neutral/未知 → 槽位 None → 不覆写）----
  const classVal = String(tags[TAG.CLASS] ?? 12);
  const className = tables.class[classVal] ?? '';
  const colorType = COLOR_TYPE_FOR_CLASS[className] ?? 0;
  const family = textureFamily(tags[TAG.CARDTYPE] ?? 4);
  const atlasRef = tables.colorSwitcher[family]?.[colorType] ?? null;
  let atlasFile: string | null = null;
  if (atlasRef) {
    const [stem, guid] = atlasRef.split(':');
    atlasFile = `textures/${stem.replace(/\.tif$/, '')}_${guid.slice(0, 8)}.png`;
  }

  // ---- 原画（fixture 提取的新路径优先，EX1_350 时代的旧布局兜底；PET 类无原画 → 置空槽，
  //      对应引擎 PET 卡型 SetMaterialNormal 的 no-op 分支 Actor.cs SetMaterial switch）----
  const portraitFile = base.src.has(`portraits/${fixture.cardId}.png`)
    ? `portraits/${fixture.cardId}.png`
    : base.src.has(`textures/portrait_${fixture.cardId}.png`)
      ? `textures/portrait_${fixture.cardId}.png`
      : null;

  // ---- 稀有度宝石（RARITY∈四象限 → 显 + 偏移/着色；FREE/INVALID → 隐）----
  const rarityName = RARITY_NAMES[tags[TAG.RARITY] ?? 0] ?? 'INVALID';
  const rarityVisible = rarityName in GEM_TEXTURE_OFFSET;

  // ---- 显隐 flags（HIDE 族 + ELITE + 种族）----
  const hide = (name: string): boolean => (tags[tables.hideTags[name]] ?? 0) !== 0;
  const hideStats = hide('HIDE_STATS');
  const isElite = (tags[TAG.ELITE] ?? 0) !== 0;
  const attackVisible = !(hideStats || hide('HIDE_ATTACK'));
  const healthVisible = !(hideStats || hide('HIDE_HEALTH'));
  const attackText = hide('HIDE_ATTACK_NUMBER') ? '' : String(tags[TAG.ATK] ?? 0);
  const healthText = hide('HIDE_HEALTH_NUMBER') ? '' : String(tags[TAG.HEALTH] ?? 0);
  const raceId = tags[TAG.CARDRACE] ?? 0;
  const raceText = raceId === 0 ? '' : (tables.raceZh[raceId] ?? 'UNKNOWN');
  const raceCount = raceId === 0 ? 0 : 1;

  // ---- 组件 delta：可见性 + 运行时纹理 ----
  const byNode = (name: string): PlanComponent | undefined =>
    plan.components.find(c => (c.node ?? c.path.split('/').pop()) === name);
  const cardMesh = plan.components.find(c => c.path === binding.card_mesh_node);
  const portraitFrame = plan.components.find(c => c.path === binding.portrait_mesh_node);

  for (const [name, visible] of [
    ['RarityGem', rarityVisible],
    ['RarityGemFrame', rarityVisible],
    ['Unique_Ally_Dragon', isElite],
    ['Gem_Attack', attackVisible],
    ['Gem_Health', healthVisible],
    ['RacePlate_mesh', !!raceText && raceCount === 1],
    ['Multi_RacePlate_mesh', !!raceText && raceCount > 1],
  ] as const) {
    const c = byNode(name);
    if (c) c.visible = visible;
  }
  if (atlasFile) {
    if (cardMesh) setSlotTex(cardMesh, matIdx('card_front_mat_idx'), atlasFile);
    if (portraitFrame) setSlotTex(portraitFrame, matIdx('portrait_frame_mat_idx'), atlasFile);
  }
  if (portraitFrame) setSlotTex(portraitFrame, matIdx('portrait_mat_idx'), portraitFile);

  plan.rarity_gem = {
    ...plan.rarity_gem,
    visible:      rarityVisible,
    atlas_offset: rarityVisible ? GEM_TEXTURE_OFFSET[rarityName] : undefined,
    tint_rgb:     rarityVisible ? GEM_COLOR[rarityName] : undefined,
  };

  // ---- 文字角色（六角色；cost/attack/health 空文本 → 不渲染）----
  const bodyFor = (role: string): string => {
    switch (role) {
    case 'cost': return tags[TAG.COST] !== undefined ? String(tags[TAG.COST]) : '';
    case 'name':
      // 名字不是裸 DBF 字符串：EntityDef.GetName → CardTextBuilder.BuildCardName
      // （CardTextBuilder.cs:97-100；Universal 兜底 :1930-1932 同式；仅 INVESTIGATE 特例，
      // fixture 集未用）= TryFormat(TransformCardText(原始名), GetTag(CARD_NAME_DATA_1))。
      // 佣兵装备/技能名带的 {0} 占位由此展开——2890 缺省 GetTag=0（「中立之心{0}」→
      // 「中立之心0」，LT23_036E2_04 实证）；无占位符名字原样通过。textBuilderType 对名字
      // 的影响仅经此公共公式（type 7 不覆写 BuildCardName）。
      return tryFormat(transformCardText(fixture.name.zhCN ?? ''), [tags[TAG3.CARD_NAME_DATA_1] ?? 0]);
    case 'desc': return resolveDescText(fixture, fixture.cardId); // textBuilderType 分派（@/{n}/$# 占位符），fail-fast
    case 'race': return raceText;
    case 'attack': return attackText;
    case 'health': return healthText;
    default: return '';
    }
  };
  plan.texts = ['cost', 'name', 'desc', 'race', 'attack', 'health'].map(role => {
    const body = bodyFor(role);
    if (!body) return { role, render: false, reason: '文本为空（缺省/规则隐藏）' };
    return { role, render: true, text: body };
  });

  (plan as unknown as { input: { dbf_id: string, card_id: string } }).input = {
    dbf_id:  String(fixture.dbfId),
    card_id: fixture.cardId,
  };
  return plan;
}

// ============================================================================
// 帧型（slot）计划编译：prefab_report + 逐帧规则表 → RenderPlan
// 规则出处：Actor.cs（写点/可见性）、py scene_compiler/wf_render/hero_render/location_render
// （explore 快照），逐条带行号见各帧 rule 注释。
// ============================================================================

/** TAG_CARDTYPE → 手牌帧 slot（actor_names.csv; ActorNames.cs）。
 * 英雄技能（10）：GetHandActor 的 HERO_POWER 分支 → ACTOR_ASSET.HISTORY_HERO_POWER
 * （ActorNames.cs:555-556）= History_HeroPower.prefab —— 既不是法术帧（SPELL=5 的 actor），
 * 也不是对局区的 Card_Play_HeroPower（那条是 GetPlayActorByTags 的 PLAY_HERO_POWER）。 */
export const CARD_TYPE_TO_SLOT: Record<number, string> = {
  4:  'hand-minion',
  5:  'hand-spell',
  3:  'hand-hero',
  7:  'hand-weapon',
  39: 'hand-location',
  10: 'hand-heropower',
  // 战棋系（ActorNames.GetHandActor，ActorNames.cs:546-569）：任务奖励(40)/酒馆法术(42) 同用
  // HAND_SPELL；畸变(43)/饰品(44) 走 BIG_CARD_BG_*（Card_Hand_BG_Anomaly / Card_Hand_BG_Trinket）。
  40: 'hand-spell',
  42: 'hand-spell',
  43: 'hand-bg-anomaly',
  44: 'hand-bg-trinket',
  // 佣兵技能（LETTUCE_ABILITY）：GetHandActorByTags（ActorNames.cs:570-591）的
  // IsLettuceAbility 分支 → BIG_CARD_LETTUCE_ABILITY_SPELL（无特殊 tag 的施法/伤害型）。
  // 召唤/装备 tag 组合与佣兵本体在 slotForCardType 组合判定（见彼处注释）。
  23: 'hand-lettuce-ability',
};

/** 佣兵（Lettuce）行为 tag（GAME_TAG.cs:1047-1079；谓词 = EntityBase.cs:466-500 +
 *  LettuceAbilityActor.cs 消费，见 docs/findings/lettuce-frame-teardown-2026-10-10.md）。 */
const TAG3 = {
  LETTUCE_MERCENARY:               1665,
  LETTUCE_ROLE:                    1666,
  LETTUCE_COOLDOWN_CONFIG:         1669,
  LETTUCE_CURRENT_COOLDOWN:        1670,
  LETTUCE_PASSIVE_ABILITY:         1671,
  LETTUCE_ABILITY_SUMMONED_MINION: 1676,
  LETTUCE_MERCENARY_EXPERIENCE:    1852,
  LETTUCE_IS_EQUPIMENT:            1855, // 游戏内枚举拼写即 EQUPIMENT（GAME_TAG.cs:1066）
  LETTUCE_START_OF_GAME_ABILITY:   2241,
  LETTUCE_FACTION:                 2720,
  CARD_NAME_DATA_1:                2890, // 名字 {0} 占位替换源（GAME_TAG.cs:373）
} as const;

/** TAG_ROLE → prefab 角色横幅节点名后缀（TAG_ROLE.cs:1-8：1=CASTER 2=FIGHTER 3=TANK
 *  4=NEUTRAL；节点映射 = prefab 序列化 MercenaryRoleGemObject.m_roleGemObjects 探针实测
 *  （explore/2026-10-10-lettuce-frame/output/merc-bindings.json）：SetRole 对每项
 *  `SetActive(m_role == role)`（MercenaryRoleGemObject.cs:20-27），即恰好一个激活。 */
const ROLE_NODE_SUFFIX: Record<number, string> = {
  1: 'Caster', 2: 'Fighter', 3: 'Protector', 4: 'Neutral',
};

/** TAG_ROLE → CardColorSwitcher.ColorType 基址（UpdateCardColor lettuce 分支，
 *  Actor.cs:6339-6362；+premium 下标（NORMAL 0 / GOLDEN 1 / DIAMOND 2 / SIGNATURE 3）取
 *  Tier1/2/3 图集：minionCardTextures[23..34] = Merc_{Caster,Fighter,Tank,Neutral,Random}_Tier*）。 */
const ROLE_COLOR_TYPE: Record<number, number> = { 1: 23, 2: 26, 3: 29, 4: 32 };

/** TAG_LETTUCE_FACTION → prefab 阵营旗节点名（TAG_LETTUCE_FACTION.cs:1-11：
 *  1=ALLIANCE 2=HORDE 3=EMPIRE 4=EXPLORER 5=LEGION 6=PIRATE 7=SCOURGE；映射 = Actor
 *  序列化 m_factionBannerIcons 探针实测）。 */
const FACTION_NODE: Record<number, string> = {
  1: 'Alliance', 2: 'Horde', 3: 'Empire', 4: 'Explorers', 5: 'Legion', 6: 'Pirate', 7: 'Scourge',
};

/** 佣兵本体（Card_Hand_Mercenary）关键节点路径后缀（Actor 序列化引用 → 帧内路径；
 *  探针 merc-bindings.json + frame_recon）。%s = 角色/阵营名后缀。
 *  （种族/等级文本节点不走此表：extract_frame ROLE_BY_NODE 已按 actor 绑定登记为
 *  role_paths，plan 文字角色直接消费；XP 条三节点按名翻隐见 plan 佣兵段落。） */
const MERC = {
  ROLE_ATTACK_C:       'RootObject/AttackObject/AttackGemRoleObjects/RoleBanner_%s_Attack',
  ROLE_HEALTH_C:       'RootObject/HealthObject/HealthGemRoleObjects/RoleBanner_%s_Health',
  FACTION_BG:          'RootObject/Mesh/Lettuce_Faction_Banner_Mesh',
  FACTION_ICON:        'RootObject/Mesh/Lettuce_Faction_Banner_Mesh/Lettuce_Faction_%s',
  FACTION_ICON_SHADOW: 'RootObject/Mesh/Lettuce_Faction_Banner_Mesh/Lettuce_Faction_Shadow',
  DUAL_PLATE:          'RootObject/Mesh/DualTribeNamePlates/Card_InHand_Ally_Merc_DualTribe_Teir1_mesh',
  LEVEL_TEXT:          'RootObject/Mesh/MercenaryLevelObject/LevelText',
  RARITY_GEM:          'RootObject/Mesh/Portrait/RarityGem',
} as const;

/** 卡型 tag → 帧 slot 的单点入口（renderCard 与资产键收集器 keys.ts 共用，防口径漂移）。
 *  判定序 = GetHandActorByTags（ActorNames.cs:570-591）逐条对译：
 *  佣兵本体（LETTUCE_MERCENARY>0，EntityBase.cs:497-500）→ hand-mercenary（Card_Hand_Mercenary，
 *  注意本体的 CARDTYPE 是 MINION=4，tag 是先决判定）；装备（+IS_EQUPIMENT）→
 *  hand-lettuce-equipment；召唤（+SUMMONED_MINION）→ hand-lettuce-ability-minion；
 *  其余 CARDTYPE 23 → hand-lettuce-ability。 */
export function slotForCardType(tags: FixtureCard['tags']): string {
  const t = tags['202'] ?? 4;
  if ((tags[String(TAG3.LETTUCE_MERCENARY)] ?? 0) > 0) return 'hand-mercenary';
  if (t === 23) {
    if ((tags[String(TAG3.LETTUCE_ABILITY_SUMMONED_MINION)] ?? 0) !== 0) {
      return 'hand-lettuce-ability-minion';
    }
    if ((tags[String(TAG3.LETTUCE_IS_EQUPIMENT)] ?? 0) !== 0) {
      return 'hand-lettuce-equipment';
    }
  }
  return CARD_TYPE_TO_SLOT[t] ?? 'hand-minion';
}

/** SIGNATURE_FRAME frame id → 签名槽位（spec 实现决策 2：命名 hand-{minion,spell,weapon}-
 *  sig{frameId} 直接对表可反查；与卡型无关——GetSignatureActor 命中即返回签名 prefab，
 *  ActorNames.cs:885-923）。帧引用/抽取见 scripts/extract_frame.py SIG_SLOT_TO_FRAME。 */
export const SIGNATURE_FRAME_TO_SLOT: Record<number, string> = {
  1:  'hand-minion-sig1',
  2:  'hand-minion-sig2',
  9:  'hand-minion-sig9',
  10: 'hand-spell-sig10',
  11: 'hand-hero-sig11',
  12: 'hand-weapon-sig12',
  13: 'hand-location-sig13',
  14: 'hand-hero-sig14',
};

/** ActorNames.s_premiumActorAssets 中已抽取的金卡手牌帧；普通帧族到金框帧一一映射。
 *  根因：游戏按 CARDTYPE 选择 actor 后再套 GOLDEN actor 表（ActorNames.cs:483-496, 176-200）；
 *  只登记随从会让法术 TIME_EVENT_999 回落到普通法术帧。 */
export const GOLDEN_SLOT_BY_BASE_SLOT: Record<string, string> = {
  'hand-minion':   'hand-minion-golden',
  'hand-spell':    'hand-spell-golden',
  'hand-weapon':   'hand-weapon-golden',
  'hand-hero':     'hand-hero-golden',
  'hand-location': 'hand-location-golden',
};

export function isGoldenSlot(slot: string): boolean {
  return Object.values(GOLDEN_SLOT_BY_BASE_SLOT).includes(slot);
}

/** 是否签名帧槽位（SIG_SLOT_TO_FRAME 的 TS 侧镜像判定）。 */
export function isSignatureSlot(slot: string): boolean {
  return Object.values(SIGNATURE_FRAME_TO_SLOT).includes(slot);
}

/** premium 帧族选择（renderCard/keys 与 slotForCardType 的 premium 感知包装）：
 *  premium=SIGNATURE 且 preset.signatureFrameId 命中「已实现（FRAME_RULES 有规则）∧
 *  资产包已抽」的签名槽 → 签名帧；GOLDEN 按普通卡型映射到已抽取的同型 premium actor；
 *  任一类别帧缺失则回落普通帧并显式告警。 */
export function slotForFixture(
  fixture: FixtureCard,
  hasFrame?: (manifestKey: string) => boolean,
): string {
  const fallback = slotForCardType(fixture.tags);
  if (fixture.preset.premium === 'GOLDEN') {
    const cardType = fixture.tags[TAG.CARDTYPE] ?? 4;
    const goldenSlot = GOLDEN_SLOT_BY_BASE_SLOT[fallback];
    if (goldenSlot && FRAME_RULES[goldenSlot]
      && (!hasFrame || hasFrame(`frames/${goldenSlot}/manifest.json`))) {
      return goldenSlot;
    }
    console.warn(`[golden] ${fixture.cardId} premium GOLDEN 无可用金卡帧`
      + `（cardType=${cardType}）→ 回落普通帧 ${fallback}`);
    return fallback;
  }
  if (fixture.preset.premium !== 'SIGNATURE') return fallback;
  const fid = fixture.preset.signatureFrameId;
  const sig = fid !== undefined ? SIGNATURE_FRAME_TO_SLOT[fid] : undefined;
  const cardType = fixture.tags[TAG.CARDTYPE] ?? 4;
  const sigBase = sig?.replace(/-sig\d+$/, '');
  const nativeTypes = sig ? (SLOT_NATIVE_CARD_TYPES[sig] ?? SLOT_NATIVE_CARD_TYPES[sigBase ?? '']) : undefined;
  const nativeMatch = nativeTypes?.includes(cardType) ?? false;
  if (sig && nativeMatch && FRAME_RULES[sig]
    && (!hasFrame || hasFrame(`frames/${sig}/manifest.json`))) {
    return sig;
  }
  console.warn(`[signature] ${fixture.cardId} premium SIGNATURE 无可用签名帧`
    + `（signatureFrameId=${fid ?? '缺失'}${sig ? `，槽位=${sig} 原生卡型匹配=${nativeMatch}` : ''}）→ 回落普通帧 ${fallback}`);
  return fallback;
}

/** 帧 slot → 该帧的原生卡型（ActorNames 的 actor 归属；4=MINION，47=战棋英雄伙伴同用随从 actor，
 *  23=LETTUCE_ABILITY 施法/召唤型走 BigCard_LettuceAbility[_Minion]；佣兵本体 actor 由
 *  ActorNames.HAND_MERCENARY 归属，卡型 tag 是 MINION=4）。
 *  别型卡（装备佣兵技能、战棋法术/宠物等）在专属帧落地前用回落帧渲染，属回归基线不属验收口径。 */
export const SLOT_NATIVE_CARD_TYPES: Record<string, number[]> = {
  'hand-lettuce-ability':        [23],
  'hand-lettuce-ability-minion': [23],
  'hand-lettuce-equipment':      [23],
  'hand-mercenary':              [4],
  'hand-minion':                 [4, 47],
  'hand-minion-golden':          [4, 47],
  'hand-spell':                  [5, 40, 42],
  'hand-spell-golden':           [5, 40, 42],
  'hand-hero':                   [3],
  'hand-hero-golden':            [3],
  'hand-weapon':                 [7],
  'hand-weapon-golden':          [7],
  'hand-location':               [39],
  'hand-location-golden':        [39],
  'hand-heropower':              [10],
  'hand-bg-anomaly':             [43],
  'hand-bg-trinket':             [44],
  // 签名帧原生卡型：frame 9 = 随从（异画 fixture GDB_477）；攻血文本走 GetTag-0 原生口径
  // frame 2 / WW_373 同为原生随从帧；ActorNames.GetSignatureActor (ActorNames.cs:885-923)
  // 按 CARD.m_signatureFrameId 选择它。离线 plan 用此表判定缺 tag 时是否写原生 "0"，
  // 漏登记会让 Signature_26 的无值攻/血文本与游戏现场语义不一致。
  'hand-minion-sig2':            [4],
  'hand-minion-sig9':            [4, 47],
  'hand-minion-sig1':            [4],
  // 2026-10-26 T11：DBF SIGNATURE_FRAME 的 11/13/14 prefab 分别绑定 Hero/Location/Hero；
  // ActorNames.GetSignatureActor（ActorNames.cs:885-923）按 frame id 直选，不能让错误 card type
  // 沿用签名槽。类型值来自 UnityPy 提取的 SC_754/TIME_446/CATA_190h CARD records。
  'hand-hero-sig11':             [3],
  'hand-location-sig13':         [39],
  'hand-hero-sig14':             [3],
};

/** GAME_TAG（sc.py:102 同源）+ ARMOR（GAME_TAG.cs:214）+ 战棋模板相关（GAME_TAG.cs 实测行号）：
 *  TECH_LEVEL=1440(:233)、BACON_TIMEWARPED=4503(:381)。 */
const TAG2 = { ARMOR: 292, SPELL_SCHOOL: 1635, TECH_LEVEL: 1440, BACON_TIMEWARPED: 4503 } as const;

/** hand-spell 帧的 alternate-cost 世界位（CostObject × ALT(-0.01,0.003,-0.58)；x/z 即法术分支
 *  altCostWorldPos 的结果）。时空扭曲随从的费用数字也用它：随从帧 CostObject 序列化位比
 *  法术帧偏左 0.0163（引擎原样 → 数字偏左 ~2.9px，两帧预制都未覆盖 ALT 默认值——探针
 *  40 副本全同），用户裁定消除该差异（2026-10-04）。 */
const ALT_COST_WORLD_HAND_SPELL: number[] = [-0.8419, 0.153, 0.6306];

/** TAG_SPELL_SCHOOL 饰品等级枚举值（TAG_SPELL_SCHOOL.cs:14-15）。 */
const TRINKET_SCHOOLS = { LESSER: 11, GREATER: 12 } as const;

/** 全帧型静态隐藏（运行时默认态；出处见 py _frame_components_* 各分支）：
 *  Highlight=无高亮（Actor.cs:4924-4929）；Ghost=ghostCard 默认 NONE；Shadow=ContactShadow(true) 才显；
 *  RuneBanner 族=默认 Hide()；Multiclass_Ribbon=序列化失活（activity 已兜底）；
 *  CostGem_DropShadow_Mesh=乘法阴影（地标帧；队列序语义 v1 未实现，登记残差）。
 *  签名帧（Evergreen 族）的 Ghost/Highlight 节点名带 _Mesh 后缀（探针 T2：
 *  FX_Ghost_Quad_Mesh 等）——不带后缀的普通帧名对不上会漏网：Ghost quad 以 ~0.186
 *  深度浮在卡体前（卡面平面 ~0.0235），漏网时盖住整卡画区（平蓝 GhostCard 纹理）
 *  且把肖像层（0.0287）挡在 zbuf 外（2026-10-25 GDB_477 首渲实测）。 */
const STATIC_HIDDEN = new Set([
  'Highlight_Card_Plane', 'FX_Ghost_Quad', 'FX_Ghost_Quad_Unique',
  'Highlight_Card_Plane_Mesh', 'FX_Ghost_Quad_Mesh', 'FX_Ghost_Quad_Unique_Mesh',
  'Shadow', 'ShadowUnique',
  'RuneHolder_Mesh', 'RuneHolder_Shadow_Mesh', 'HolderGlow_Tutorial',
  'CostGem_DropShadow_Mesh',
]);

/** Signature Evergreen 的四个 Actor.SetRarityGemShape 子物体（Actor.cs:4992-5022）。 */
const SIG_RARITY_VARIANTS = new Set([
  'RarityGem_Common_Mesh', 'RarityGem_Rare_Mesh',
  'RarityGem_Epic_Mesh', 'RarityGem_Legendary_Mesh',
]);

/** 逐帧 tag 规则（节点名 → 谓词键）。 */
interface FrameRules {
  elite:             string[];
  rarity:            string[];
  attack?:           string[];
  health?:           string[]; // 耐久同（HEALTH tag）
  armor?:            string[];
  race?:             string[]; // 单种族板
  multiRace?:        string[];
  noGem?:            string; // !rarity 时显（地标替代件）
  forcedHidden?:     string[];
  /** 饰品等级徽章（TrinketLevelIndicatorRing 族）：SPELL_SCHOOL ∈ {LESSER,GREATER_TRINKET} 才显
   *  （GetTrinketLevel + UpdateBaconTrinketComponents，Actor.cs:5368-5420）。 */
  trinketBadge?:     string[];
  /** 佣兵技能附件（LettuceAbilityActor 运行时子；teardown findings §3）：
   *  speedWing = 速度翼标（被动/开局技 tag 隐藏；m_updateVisualsOnCooldown ∧ 现冷却 tag 也隐）；
   *  hourglass = 冷却沙漏（UpdateHourglassObject：冷却配置/当前冷却文本任一非空才显——
   *  文本非空 = m_cooldownConfigText/m_currentCooldownText 引用已绑定 ∧ 对应 tag ≠ 0；
   *  两个 ability prefab 的引用序列化为空 → 恒隐，谓词按引用绑定建模而不是写死）。 */
  lettuceSpeedWing?: string[];
  lettuceHourglass?: string[];
  roles:             string[];
}

const FRAME_RULES: Record<string, FrameRules> = {
  'hand-minion': {
    elite:     ['Unique_Ally_Dragon'], rarity:    ['RarityGemFrame', 'RarityGem'],
    attack:    ['Gem_Attack'], health:    ['Gem_Health'],
    race:      ['RacePlate_mesh'], multiRace: ['Multi_RacePlate_mesh'],
    roles:     ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // GOLDEN 的 premium ActorNames prefab 保留同一套随从节点规则；材质和网格来自独立金框槽。
  // T09 JAIL_321 的白色弧形龙影来自这个 prefab 的默认 enabled 子节点
  // Unique_Ally_Dragon_Shadow：Actor.UpdateEliteComponent 对 m_eliteObject 子树统一按
  // ELITE 开关 renderer（Actor.cs:5141-5148），但本离线 plan 逐组件匹配节点名，之前只门控父节点。
  // UnityPy 探针 assets/frames/hand-minion-golden/frame_recon.json 显示 m_eliteObject 指向
  // Unique_Ally_Dragon，子节点 Shadow 使用 GenFX_Card_InHand_Premium_BannerAtlas；故非精英卡必须
  // 同样隐藏该子节点，避免把金卡 atlas 的龙形采到画窗外框上。
  'hand-minion-golden': {
    elite:     ['Unique_Ally_Dragon', 'Unique_Ally_Dragon_Shadow'],
    rarity:    ['RarityGemFrame', 'RarityGem'],
    attack:    ['Gem_Attack'], health:    ['Gem_Health'],
    race:      ['RacePlate_mesh'], multiRace: ['Multi_RacePlate_mesh'],
    roles:     ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 法术：elite=InHand_Ability_Unique_Dragon(+shadow)；稀有度=RarityFrame_mesh+RarityGem；
  // 无攻/血/种族；plate=学派文本（Description_mesh/RaceUberText，文本非空才显）
  'hand-spell': {
    elite:  ['InHand_Ability_Unique_Dragon', 'InHand_Ability_Unique_Dragon_shadow'],
    rarity: ['RarityFrame_mesh', 'RarityGem'],
    roles:  ['cost', 'name', 'desc', 'race'],
  },
  // T09 的 elite 龙饰回归：游戏 Actor.UpdateEliteComponent 以 Actor.IsElite 控制 m_eliteObject
  // 的 renderer（Actor.cs:1349-1367, 5141-5148）；金卡法术/英雄 prefab 的序列化节点名与普通
  // prefab 不同，若只匹配普通名，离线 plan 会把默认 active 的金龙误画到非 ELITE 卡上。
  // 把实抽金卡节点名纳入同一 TAG_ELITE 门控，复刻引擎的运行期 renderer 开关。证据：
  // assets/frames/hand-spell-golden/frame_recon.json 的 InHand_Ability_Unique_Dragon_Premium；
  // assets/frames/hand-hero-golden/frame_recon.json 的 HeroCard_InHand_EliteDragon (1)。
  // 金色法术 / 武器 / 英雄 / 地标帧的其余组件规则沿用对应普通帧。
  'hand-spell-golden': {
    elite: ['InHand_Ability_Unique_Dragon', 'InHand_Ability_Unique_Dragon_Premium',
      'InHand_Ability_Unique_Dragon_shadow'],
    rarity: ['RarityFrame_mesh', 'RarityGem'],
    roles:  ['cost', 'name', 'desc', 'race'],
  },
  // 武器：攻/耐久=图标网格（Wep_Swords/Wep_SheildBroken，非宝石）；名字平面 fallback（无载体）
  'hand-weapon': {
    elite:  ['Unique_Weapon_Dragon'], rarity: ['RarityGemFrame', 'RarityGem'],
    attack: ['Wep_Swords'], health: ['Wep_SheildBroken'],
    roles:  ['cost', 'name', 'desc', 'attack', 'health'],
  },
  'hand-weapon-golden': {
    elite:  ['Unique_Weapon_Dragon'], rarity: ['RarityGemFrame', 'RarityGem'],
    attack: ['Wep_Swords'], health: ['Wep_SheildBroken'],
    roles:  ['cost', 'name', 'desc', 'attack', 'health'],
  },
  // 英雄手牌：Gem_Attack（ATK>0 才显，见 attackVisible）、Armor_Whole_mesh（ARMOR>0）、无 Health 节点；
  // 攻数字走 AttackUberText（Actor.UpdateAttackTextMesh 3420-3441）
  'hand-hero': {
    elite:  ['HeroCard_InHand_EliteDragon'], rarity: ['RarityGemFrame', 'RarityGem'],
    attack: ['Gem_Attack'], armor:  ['Armor_Whole_mesh'],
    roles:  ['cost', 'name', 'desc', 'attack', 'armor'],
  },
  'hand-hero-golden': {
    elite:  ['HeroCard_InHand_EliteDragon', 'HeroCard_InHand_EliteDragon (1)'],
    rarity: ['RarityGemFrame', 'RarityGem'],
    attack: ['Gem_Attack'], armor:  ['Armor_Whole_mesh'],
    roles:  ['cost', 'name', 'desc', 'attack', 'armor'],
  },
  // 地标：耐久=Wep_SheildBroken；No_Gem_Mesh=!rarity；RacePlate 强制隐（无种族文本）
  'hand-location': {
    elite:        ['Unique_Ally_Dragon'], rarity:       ['RarityGem'],
    health:       ['Wep_SheildBroken'],
    noGem:        'No_Gem_Mesh', forcedHidden: ['RacePlate_mesh'],
    roles:        ['cost', 'name', 'desc', 'health'],
  },
  'hand-location-golden': {
    elite:        ['Unique_Ally_Dragon'], rarity:       ['RarityGem'],
    health:       ['Wep_SheildBroken'],
    noGem:        'No_Gem_Mesh', forcedHidden: ['RacePlate_mesh'],
    roles:        ['cost', 'name', 'desc', 'health'],
  },
  // 战棋畸变（Card_Hand_BG_Anomaly）：ability 帧家族；无 cost 角色（prefab role_paths 实测，
  // 畸变无费用显示且 Gem_Mana 序列化失活）；稀有度/精英龙同法术帧。
  'hand-bg-anomaly': {
    elite:  ['InHand_Ability_Unique_Dragon', 'InHand_Ability_Unique_Dragon_shadow'],
    rarity: ['RarityFrame_mesh', 'RarityGem'],
    roles:  ['name', 'desc', 'race'],
  },
  // 战棋饰品（Card_Hand_BG_Trinket）：主体 = FrameMesh（m_cardMesh 与 m_portraitMesh 同节点，
  // 肖像槽 1 序列化为空=运行时 CardDef 材质）；等级徽章按 school 显隐+换材质（见 trinketBadge）。
  // "Mesh Old (From Card_Hand_Ability)" 整树序列化失活（activity 兜底）。
  'hand-bg-trinket': {
    elite:        [],
    rarity:       [],
    trinketBadge: ['TrinketLevelIndicatorRing', 'Trinket_Medallion_Portrait_Mesh', 'Trinket_Medallion_Shadow_Mesh'],
    // 单/多族板显隐（Actor.UpdateRace :6152-6170 对译）：raceCount==1 → RacePlate_mesh
    // 渲染器启用、Multi SetActive(false)；>1 → 反之。文本 = BACON_SUBSET 派生的种族名。
    race:         ['RacePlate_mesh'],
    multiRace:    ['Multi_RacePlate_mesh'],
    roles:        ['cost', 'name', 'desc', 'race'],
  },
  // 英雄技能（History_HeroPower）：附件层整个不存在（prefab 无 RarityGem/Gem_Attack/Gem_Health/
  // RacePlate/Unique_*/RuneBanner/MulticlassRibbon 节点，非隐藏——RARITY=FREE 与结构双证），
  // 且本帧是唯一无类色写点的手牌帧（Actor.SetMaterialNormal 的 HERO_POWER 分支 break，
  // Actor.cs:6709-6725 → 帧保持 prefab 序列化材质；九职业英雄技能框色逐位相同即其证）。
  // 帧几何 = Mesh（HeroPowerV2 三子网格：框 / 肖像圆窗 / HeroClass 垫板）+ FrameMesh（横幅/描述板/底带）
  // + Gem_Mana；文字三角色 cost/name/desc（无 attack/health/race 节点）。
  'hand-heropower': {
    elite:  [], rarity: [],
    roles:  ['cost', 'name', 'desc'],
  },
  // 佣兵技能（BigCard_LettuceAbility，LettuceAbilityActor；teardown findings §2/§3/§9）：
  // 攻/血 = spell 变体出厂失活子树，游戏内恒隐（entity 路径从不 Show；机制与 exporter
  // 伪影定案见谓词块注释与 findings §9 修正）→ 文本角色置空、宝石组件不绕层级失活态。
  // 无宝石/精英龙/种族板节点（prefab 64 节点实证）；费用=纯文本（Gem_Mana 失活）；
  // race 角色 = 学派文本（UpdateRace flag5 与 spell 同支，Actor.cs:6143）；
  // 学派板双网格替换见 desc mesh swap（neutral = 整框几何原位重画，不能套 hand-spell 等价成立）。
  'hand-lettuce-ability': {
    elite:            [], rarity:           [],
    attack:           ['Gem_Attack'], health:           ['Gem_Health'],
    lettuceSpeedWing: ['Speed_Wing'],
    lettuceHourglass: ['Hourglass'],
    roles:            ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 佣兵装备（BigCard_LettuceEquipment，LettuceAbilityActor；teardown findings §7.2）：
  // 瓦片布局（m_portraitMesh=Mesh/PortraitMesh，portraitMatIdx=0，tile 16 tris + 框 156 tris）；
  // 角色仅 name/desc（prefab role_paths 实测，装备无费用/攻血显示）；
  // 名字走曲率载体 Adv_StoryMode_PageTitle_BendTextShape（manifest.carrier → renderText RTT）；
  // 底影 ×3（CoinShadow/Shadow/ShadowUnique，Hero/Multiply/Multiply_AlphaFade）——乘法混合由
  // markOpaqueEdgeSlots 按 shader 自动标注；Shadow/ShadowUnique 在 STATIC_HIDDEN（各手牌帧
  // 接触阴影导出不可见的既有口径）。
  // forcedHidden 'Mesh'：装备 prefab 序列化了能力徽章环节点（Lettuce_Spells_Ring_Mesh，[6,208]
  // tris，active+enabled），但基准图（reference/LT23_036E2_04.png）对应区域 alpha=0（不透明
  // bbox 顶 y55 vs 我们 37，高出的 18px 全部来自该节点）；隐藏后整体 SAD 7.36 → 2.57。像素
  // 证据落实现；游戏/导出器代码中均未找到该节点的隐藏出处（LettuceAbilityActor 不触及、
  // exporter 正常路径无名单命中——ApplyPlaceholderGrayMaterials 名单属 textless 路径），根因
  // 未决登记（可能是真实游戏收藏 UI 的装备瓦片装配代码所为，反编译未及）。
  'hand-lettuce-equipment': {
    elite:        [], rarity:       [],
    forcedHidden: ['Mesh'],
    roles:        ['name', 'desc'],
  },
  // 召唤型佣兵技能（BigCard_LettuceAbility_Minion）：与 spell 变体仅两处差异
  // （teardown findings §7.1）——攻/血对象层级激活（AttackObject/HealthObject 自身 True，
  // 标准门控直接成立）；FrameMesh 换 Lettuce_Ability_MinionCaster_Frame 纹理。其余逐项同。
  'hand-lettuce-ability-minion': {
    elite:            [], rarity:           [],
    attack:           ['Gem_Attack'], health:           ['Gem_Health'],
    lettuceSpeedWing: ['Speed_Wing'],
    lettuceHourglass: ['Hourglass'],
    roles:            ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 佣兵本体收集卡（Card_Hand_Mercenary，CARDTYPE 4 + TAG_LETTUCE_MERCENARY>0）：
  // - 精英龙 Unique_Ally_Dragon：序列化 renderer 禁用，且 Actor.IsElite() 对佣兵恒 false
  //   （Actor.cs:1351-1353 `IsLettuceMercenary() || IsLettuceAbility() → false`）→ 双证恒隐。
  // - 稀有度宝石 RarityGem 序列化激活（actor 无 rarityFrameMesh 绑定），颜色/象限按
  //   UpdateRarityComponent 既有口径；图集/滚动速度是 Lettuce 专用材质（见 plan 佣兵段落）。
  // - 攻/血宝石 Gem_Attack/Gem_Health 序列化失活且**无 GemObject 可翻正**（探针：actor 只
  //   在 CostObject 上挂 GemObject；佣兵帧的攻血几何是职业横幅宝石 `RoleBanner_*`，
  //   由 MercenaryRoleGemObject 按角色 SetActive）→ 标准宝石保持不渲染，职业宝石走
  //   gems 阶段公式（DiffuseAlphaMaskScroller 同族）。
  // - 角色仅 name/race/attack/health/level：desc **不渲染**——GetPowersText 在无对局实体
  //   且 !m_showUICardText 时早退 null（Actor.cs:4272-4276，收集卡语境），基准图 desc 区
  //   为空即其证；cost 节点整树序列化失活（费用不在收集卡上显示）。
  // - 等级数字 = LevelText（MercenaryActorLevelObject.m_levelText，探针实证绑定；
  //   文本写点 UpdateMercenaryLevelTextMesh，Actor.cs:3516-3528）。
  'hand-mercenary': {
    elite:        [],
    rarity:       ['RarityGem'],
    forcedHidden: ['Unique_Ally_Dragon'],
    roles:        ['name', 'race', 'attack', 'health', 'level'],
  },
  // 2026-10-25 工单 03：GDB_477（SIGNATURE, signatureFrameId=9）此前因离线 slotForFixture
  // 要求 FRAME_RULES 与抽取帧同时存在而回落 hand-minion；游戏 ActorNames.GetSignatureActor
  // （ActorNames.cs:885-923）按 frameId 直接选 SignatureHand[9]。登记此规则让签名帧主体、类色
  // 子网格与原画进入已有渲染路径。证据：assets/frames/hand-minion-sig9/frame_recon.json；
  // `explore/2026-10-25-signature-frame/output/Uber_UberCardBack_FS_nokw.metal:107-168`
  // （mask/layer blend）、Actor.cs:6577-6599（类色）。
  // 帧结构实证 = research findings §2.2 + T2 抽取（探针对照 5/5 全对上）。
  // - 无精英龙节点；稀有度 = 框环 RarityGem_Frame_Mesh（UberCardBack 静态）+ 四变体宝石
  //   网格（DiffuseAlphaMaskScroller 云纹 + Multiply_AlphaFade 底影，Actor.cs
  //   UpdateRarityComponent:4939-4959 / SetRarityGemShape:4992-5022 按稀有度四选一）。
  //   签名帧不走通用 rarity_gem 图集公式，必须选择该 frame 自身的形状网格。
  // - 攻/血/费用宝石节点名与普通帧同名（Gem_Attack/Gem_Health/Gem_Mana）→ stat_gems
  //   公式管线按签名材质序列化值自动采集，框位随帧。
  // - Evergreen 全出血：RacePlate 无网格（种族文字 = RacePlate_UberText 浮在画上），
  //   描述/名字也全 UberText（无 Description 网格 → 无水印写点）。
  'hand-minion-sig9': {
    elite:        [],
    rarity:       ['RarityGem_Frame_Mesh'],
    attack:       ['Gem_Attack'],
    health:       ['Gem_Health'],
    forcedHidden: [
      'RarityGem_Common_Mesh',
      'RarityGem_Rare_Mesh',
      'RarityGem_Epic_Mesh',
      'RarityGem_Legendary_Mesh',
    ],
    roles: ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 2026-10-26 工单 07：RLK_706 的 Signature_25 Glass pass 之前被通用帧光栅按 MainTex
  // 套 UV0/全纹理 alpha 近似，且被肖像层盖住，缺少 mask 透明度并遮掉名称框两端；映射此帧
  // 原生随从组件，并把 Transluscent_Mesh 延后到肖像之后、文字之前。游戏 RTT 的
  // RenderCommandLists.cs::SortRenderCommands（:70-76）按 sortingOrder 排序；离线链将肖像
  // 作为独立合成阶段；RenderCommandLists.cs::AppendRenderCommands（:49-54,:187-204）选择
  // SRPDefaultUnlit 并排除 Glow passes。探针 assets/frames/hand-minion-sig1/frame_recon.json
  // 记录 RacePlate_Mesh、Gem_*_Mesh 和 RootObject/Mesh/Transluscent_Mesh（323 tris，Atlas + Glass Mask）。
  // DescriptionBox_Mesh 的 MeshFilter.m_Mesh 序列化为空且 MeshRenderer disabled；Actor.cs
  // UpdateDescriptionMesh（:5013-5038）只开关 Renderer/GameObject。可见描述底板来自主 Mesh 的
  // Signature_25 图集几何，不应为这个空节点合成额外网格。
  'hand-minion-sig1': {
    elite:  [],
    rarity: ['RarityGem_Mesh'],
    attack: ['Gem_Attack_Mesh'],
    health: ['Gem_Health_Mesh'],
    race:   ['RacePlate_Mesh'],
    roles:  ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 2026-10-26 工单 05：WW_373 的 SIGNATURE frame 2 过去因无 FRAME_RULES 回落普通随从帧，
  // 使签名图集、框环和宝石双层都未进入渲染。登记原生随从组件并由通用签名分支按稀有度
  // 激活四选一子网格。离线链要求 FRAME_RULES 与资产同时存在才选签名帧；游戏侧
  // ActorNames.GetSignatureActor (ActorNames.cs:885-923) 按 m_signatureFrameId 直接选帧，
  // Actor.cs:4939-4959 / 4992-5022 再切换对应稀有度子网格。探针证据：
  // `assets/frames/hand-minion-sig2/frame_recon.json` 的
  // RootObject/Mesh/RarityGem_Frame_Mesh 含四个 rarity mesh；Legendary 网格含
  // DiffuseAlphaMaskScroller 主体 + Multiply_AlphaFade 底影两个材质子网格。前者 pass 0 的
  // Blend One/Zero + ZWrite=1、alpha=1 公式据 shader_meta.json 与 2026-10-07 rarity alignment
  // NOTES §2；离线通用 alpha-over 会使橙色宝石透掉，故继续走已实现的签名专属双层光栅路径。
  'hand-minion-sig2': {
    elite:        [],
    rarity:       ['RarityGem_Frame_Mesh'],
    attack:       ['Gem_Attack'],
    health:       ['Gem_Health'],
    forcedHidden: [
      'RarityGem_Common_Mesh',
      'RarityGem_Rare_Mesh',
      'RarityGem_Epic_Mesh',
      'RarityGem_Legendary_Mesh',
    ],
    roles: ['cost', 'name', 'desc', 'race', 'attack', 'health'],
  },
  // 2026-10-26 工单 04：TLC_433 / TLC_EVENT_402 的 SIGNATURE 专属帧过去缺 FRAME_RULES，
  // slotForFixture 因而回落普通 spell/weapon 帧（L2 mae_visible 分别 109.384 / 83.008）。
  // 按 prefab 的实际网格绑定各自卡型节点，允许 10/12 帧进入既有签名帧绘制、宝石和文字管线。
  // 游戏证据：ActorNames.GetSignatureActor（ActorNames.cs:885-923）以 CARD.m_signatureFrameId
  // 选择 SignatureHand[10/12]；CardTextureLoader.LoadSignature（CardTextureLoader.cs:235-259）
  // 装载签名材质/原画。探针 `assets/frames/hand-spell-sig10/frame_recon.json` 与
  // `assets/frames/hand-weapon-sig12/frame_recon.json` 分别记录 Evergreen / Weapon Atlas、
  // `RarityGem_Frame_Mesh`、TextGradient/Divider，以及武器 Wep_Swords/Wep_SheildBroken 节点；
  // 结构与 shader 归因见 `docs/findings/signature-frame-research-2026-10-25.md` §2.2/§8.2。
  'hand-spell-sig10': {
    elite:  [], rarity: ['RarityGem_Frame_Mesh'],
    roles:  ['cost', 'name', 'desc', 'race'],
  },
  'hand-weapon-sig12': {
    elite:  ['Unique_Weapon_Dragon'], rarity: ['RarityGem_Frame_Mesh'],
    attack: ['Wep_Swords'], health: ['Wep_SheildBroken'],
    roles:  ['cost', 'name', 'desc', 'attack', 'health'],
  },
  // 2026-10-26 T11：frame 11/14 的活动主 prefab 是签名英雄帧，frame 13 是签名地标帧；
  // 这些新增规则补齐缺失的 signatureFrameId→frame-plan 路径，避免离线选择器回退普通框。
  // ActorNames.GetSignatureActor（ActorNames.cs:885-923）证明游戏按 DBF frame id 选择 prefab；
  // UnityPy `assets/frames/hand-hero-sig11|sig14/prefab_report.json` 绑定 Gem_Attack 与
  // Armor_Whole_mesh，`hand-location-sig13/prefab_report.json` 绑定 Wep_SheildBroken；三个
  // `frame_recon.json` 均含 RarityGem_Frame_Mesh 及四个稀有度子网格。Actor.cs:4934-5022
  // 明确运行时切换四个 rarity 子物体；共用签名光栅已覆盖 Uber/UberCardBack 材质，故只登记节点规则。
  'hand-hero-sig11': {
    elite:        [], rarity:       ['RarityGem_Frame_Mesh'],
    attack:       ['Gem_Attack'], armor:        ['Armor_Whole_mesh'],
    forcedHidden: ['RarityGem_Common_Mesh', 'RarityGem_Rare_Mesh',
      'RarityGem_Epic_Mesh', 'RarityGem_Legendary_Mesh'],
    roles: ['cost', 'name', 'desc', 'attack', 'armor'],
  },
  'hand-location-sig13': {
    elite:        [], rarity:       ['RarityGem_Frame_Mesh'],
    health:       ['Wep_SheildBroken'],
    forcedHidden: ['RarityGem_Common_Mesh', 'RarityGem_Rare_Mesh',
      'RarityGem_Epic_Mesh', 'RarityGem_Legendary_Mesh', 'RacePlate_Mesh'],
    roles: ['cost', 'name', 'desc', 'health'],
  },
  'hand-hero-sig14': {
    elite:        [], rarity:       ['RarityGem_Frame_Mesh'],
    attack:       ['Gem_Attack'], armor:        ['Armor_Whole_mesh'],
    forcedHidden: ['RarityGem_Common_Mesh', 'RarityGem_Rare_Mesh',
      'RarityGem_Epic_Mesh', 'RarityGem_Legendary_Mesh'],
    roles: ['cost', 'name', 'desc', 'attack', 'armor'],
  },
};

/** 战棋种族定位（BACON_SUBSET_*，GAME_TAG.cs:974-985）→ TAG_RACE（EntityBase.cs:25-90
 *  s_raceSubsetToRaceTable）。**饰品种族不走 CARDRACE**，走此族（GetRacesForTrinket，
 *  EntityBase.cs:1133-1152：命中任一 subset tag → 对应 race；BACON_SUBSET_ALL(3436)
 *  短路——清空只留 ALL(26)）。随从（CARDTYPE 4）即使带 subset tag 也仍走 CARDRACE
 *  （GetRaces 按 IsBattlegroundTrinket=cardtype 44 分派，EntityBase.cs:1209-1216）。 */
const BACON_SUBSET_TO_RACE: [number, number][] = [
  [1591, 24], [1592, 14], [1593, 15], [1594, 20], [1595, 17], [1596, 23],
  [1688, 18], [1845, 43], [2272, 92], [2347, 11], [2630, 21],
];
const BACON_SUBSET_ALL = 3436;
const RACE_ALL = 26;
/** SortRaceList 序（EntityBase.cs:1185-1206）：多族才排序；不在表内的族按 IndexOf=-1 排最前。 */
const RACE_SORT_ORDER = [11, 18, 17, 15, 14, 43, 92, 20, 24, 2, 21, 23];

/** CARD_RACE 表（dbf.unity3d "CARD_RACE"，探针 explore/2026-10-07-edge-align/
 *  probe_cardrace_dbf.py；输出 output/cardrace_table.json）：[TAG_RACE, IsRaceTag]。
 *  GetRacesForNonTrinket（EntityBase.cs:1154-1177）在 CARDRACE 之外遍历全表——
 *  HasTag(IsRaceTag)（= GetTag>0）则把 record.ID 追加进种族集（多重种族卡的第二来源，
 *  如 CFM_637 海盗帕奇斯 CARDRACE=23 + tag 2537(DEMON)=1 → 恶魔/海盗 两行）；
 *  isRaceTagId=0 的行（BLANK/ALL/已删族）永不命中，剔除。CARDRACE==ALL(26) 时早退
 *  （:1165-1168），不遍历。 */
const CARD_RACE_IS_TAG: [number, number][] = [
  [1, 2524], [2, 2525], [3, 2526], [4, 2527], [5, 2528], [6, 2529], [7, 2530],
  [8, 2531], [9, 2532], [10, 2533], [11, 2534], [12, 2535], [14, 2536], [15, 2537],
  [16, 2538], [17, 2539], [18, 2540], [19, 2541], [20, 2542], [21, 2543], [22, 2544],
  [23, 2522], [24, 2523], [38, 2545], [43, 2546], [80, 2547], [81, 2548], [83, 2549],
  [84, 2550], [85, 2551], [88, 2552], [92, 2553], [93, 2554], [94, 2555], [95, 2556],
  [96, 2584], [97, 2585], [98, 2586], [99, 2587], [100, 2588], [126, 4756],
];

/** GetRacesForNonTrinket 对译（含 SortRaceList 排序与去重）。 */
function nonTrinketRaces(tags: Record<string, number>): number[] {
  const out: number[] = [];
  const cr = tags[TAG.CARDRACE] ?? 0;
  if (cr !== 0) out.push(cr);
  if (cr === RACE_ALL) return out; // CARDRACE==26 → 早退（EntityBase.cs:1165-1168）
  for (const [race, tag] of CARD_RACE_IS_TAG) {
    if ((tags[tag] ?? 0) > 0) out.push(race);
  }
  const uniq = [...new Set(out)];
  if (uniq.length > 1) {
    uniq.sort((a, b) => RACE_SORT_ORDER.indexOf(a) - RACE_SORT_ORDER.indexOf(b));
  }
  return uniq;
}

/** GetRacesForTrinket 对译：subset tag → race 列表（去重；ALL 短路）。 */
function trinketRaces(tags: Record<string, number>): number[] {
  if ((tags[BACON_SUBSET_ALL] ?? 0) !== 0) return [RACE_ALL];
  const out: number[] = [];
  for (const [tag, race] of BACON_SUBSET_TO_RACE) {
    if ((tags[tag] ?? 0) !== 0) out.push(race);
  }
  const uniq = [...new Set(out)];
  if (uniq.length > 1) {
    uniq.sort((a, b) => RACE_SORT_ORDER.indexOf(a) - RACE_SORT_ORDER.indexOf(b));
  }
  return uniq;
}

/** BuildRaceText（EntityBase.cs:1251-1264，delimited=false）：多族 "\n" 连接。 */
function raceTextOf(raceIds: number[], tables: StaticTables): string {
  return raceIds.map(r => tables.raceZh[r] ?? 'UNKNOWN').join('\n');
}

/** 帧层级 path → active_in_hierarchy（序列化失活子树）。 */
function collectActive(hierarchy: { path?: string, active_in_hierarchy?: boolean, children?: unknown[] },
  out = new Map<string, boolean>()): Map<string, boolean> {
  const h = hierarchy as { path?: string, active_in_hierarchy?: boolean, children?: { path?: string, active_in_hierarchy?: boolean, children?: unknown[] }[] };
  if (h.path) out.set(h.path, h.active_in_hierarchy ?? true);
  for (const c of h.children ?? []) collectActive(c as never, out);
  return out;
}

/** 帧节点 → 网格键索引（npz_key）。 */
function collectKeys(hierarchy: { path?: string, npz_key?: string, children?: unknown[] },
  out = new Map<string, string>()): Map<string, string> {
  const h = hierarchy as { path?: string, npz_key?: string, children?: { path?: string, npz_key?: string, children?: unknown[] }[] };
  if (h.path) out.set(h.path, h.npz_key ?? '');
  for (const c of h.children ?? []) collectKeys(c as never, out);
  return out;
}

/** report→plan：帧组件骨架 + 卡牌 delta（类色/原画/稀有度/ELITE/攻血甲/种族板/文字角色）。 */
export function compileFramePlan(
  fixture: FixtureCard,
  tables: StaticTables,
  base: AssetPack,
  slot: string,
  wmTables: WatermarkTables,
): RenderPlan {
  const report = base.prefabReport!;
  const rules = FRAME_RULES[slot];
  if (!rules) throw new Error(`未知帧 slot: ${slot}`);
  const tags = fixture.tags;
  const actor = report.actor_components[0];
  const refs = actor.object_refs;
  const sc = actor.scalars as Record<string, number>;
  const active = collectActive(base.frameRecon.hierarchy as never);
  const keyByPath = collectKeys(base.frameRecon.hierarchy as never);

  // ---- 卡牌 delta 输入 ----
  const classVal = String(tags[TAG.CLASS] ?? 12);
  const className = tables.class[classVal] ?? '';
  // 类色图集下标：常规 = 职业（COLOR_TYPE_FOR_CLASS）；**佣兵本体走角色分支**
  // （Actor.UpdateCardColor 的 lettuce 分支，Actor.cs:6339-6362：CASTER=23 / FIGHTER=26 /
  // TANK=29 / NEUTRAL=32 + (int)m_premiumType；NORMAL=0 → Tier1 图集，GOLDEN=1 → Tier2…）。
  // 佣兵卡的 CLASS 恒 NEUTRAL，走职业表会取到 Card_Inhand_Generic（首轮渲染实测：整卡变
  // 明亮羊皮纸，与基准的深褐框不符）。
  const premiumOffset = { NORMAL: 0, GOLDEN: 1, DIAMOND: 2, SIGNATURE: 3 }[
    String(fixture.preset?.premium ?? 'NORMAL')] ?? 0;
  const mercColorType = (ROLE_COLOR_TYPE[tags[String(TAG3.LETTUCE_ROLE)] ?? 0] ?? 0);
  const colorType = slot === 'hand-mercenary' && mercColorType
    ? mercColorType + premiumOffset
    : (COLOR_TYPE_FOR_CLASS[className] ?? 0);
  const family = textureFamily(tags[TAG.CARDTYPE] ?? 4);
  const atlasRef = tables.colorSwitcher[family]?.[colorType] ?? null;
  let atlasFile: string | null = null;
  if (atlasRef) {
    const [stem, guid] = atlasRef.split(':');
    atlasFile = `textures/${stem.replace(/\.tif$/, '')}_${guid.slice(0, 8)}.png`;
  }
  // 原画解析（premium 后缀：spec 实现决策 8）——异画签名帧优先 -signature 图：引擎侧 =
  // CardTextureLoader.LoadSignature（CardTextureLoader.cs:235-259）把 CardDef.
  // GetSignaturePortraitRef 的专属原画装进实例化肖像材质；包内约定
  // portraits/{cardId}-signature.png（extract_fixture_assets，异画 fixture 5 张已全在包）。
  // -GOLDEN 由 UberGoldenCard+UberShaderAnimation 在提取期冻结为 PNG，再由 GOLDEN 帧消费。
  // 签名/金卡判定都要求 premium 与对应帧槽同时命中，槽位单看不够——
  // input.slot 可强制签名槽渲染 NORMAL 卡（CLI 调试），裸 sigSlot 门会让肖像后缀/晚通道/
  // rarity 抑制与类色注入口径分裂（2026-10-25 评审指认，T09 同样按 premium 收紧）。
  const sigActive = isSignatureSlot(slot) && fixture.preset.premium === 'SIGNATURE';
  const goldenActive = isGoldenSlot(slot) && fixture.preset.premium === 'GOLDEN'
    && (SLOT_NATIVE_CARD_TYPES[slot]?.includes(tags[TAG.CARDTYPE] ?? 4) ?? false);
  const goldenPortraitFile = `portraits/${fixture.cardId}-golden.png`;
  // DIY 卡没有游戏提供的 -golden 合成图时，保留普通原画并只套金框。基准金卡仍消费
  // UberGoldenCard+UberShaderAnimation 冻结出的专属 PNG；只有该合成图已经是最终材质输出。
  // 上传原画也走普通 Unlit_Portrait（render-card.ts 覆盖下方 direct-output 标记）。
  // 证据：ActorNames.cs:483-496 选择 GOLDEN 帧族；CardTextureLoader.cs:235-259 的异画
  // 专属图按独立后缀装载；T09 golden-stage findings 记录金卡图是提取期 UberGoldenCard 合成。
  const goldenPortraitAvailable = goldenActive && base.src.has(goldenPortraitFile);
  let portraitFile: string | null = null;
  if (sigActive && base.src.has(`portraits/${fixture.cardId}-signature.png`)) {
    portraitFile = `portraits/${fixture.cardId}-signature.png`;
  } else if (goldenPortraitAvailable) {
    portraitFile = goldenPortraitFile;
  } else if (base.src.has(`portraits/${fixture.cardId}.png`)) {
    portraitFile = `portraits/${fixture.cardId}.png`;
  } else if (base.src.has(`textures/portrait_${fixture.cardId}.png`)) {
    portraitFile = `textures/portrait_${fixture.cardId}.png`;
  }

  const rarityName = RARITY_NAMES[tags[TAG.RARITY] ?? 0] ?? 'INVALID';
  const rarityVisible = rarityName in GEM_TEXTURE_OFFSET;

  const hide = (name: string): boolean => (tags[tables.hideTags[name]] ?? 0) !== 0;
  const hideStats = hide('HIDE_STATS');
  const isElite = (tags[TAG.ELITE] ?? 0) !== 0;
  // 攻/血文本与宝石可见性（Actor.UpdateAttackTextMesh 3396-3453 / UpdateHealthTextMesh 3456-3493 对译）：
  // - tag 取值一律 GetTag 口径（缺 tag = 0，不是"空"）→ 无攻随从显示 "0"；血同理。
  // - 特例只有英雄：ATK == 0 → m_attackObject.SetActive(false) + 文本清空（图标与数字一起消失）；
  //   ATK > 0 才显示。
  // - GetTag 口径只对**原生卡型**成立：回落帧（如佣兵技能落随从帧）在游戏里用别的 actor、根本没有该图标，
  //   缺 tag 时保持空文本，避免在错误的帧上多画 "0"（见 SLOT_NATIVE_CARD_TYPES）。
  const cardType = tags[TAG.CARDTYPE] ?? 4;
  const isHeroCard = cardType === 3;
  const nativeCard = SLOT_NATIVE_CARD_TYPES[slot]?.includes(cardType) ?? false;
  // 佣兵技能 spell 变体（hand-lettuce-ability）攻血恒不画：AttackObject/HealthObject 出厂
  // 失活（探针 findings §9.1），而游戏内手牌 actor 从不设置 entityDef（Card.OnActorLoaded
  // Card.cs:6150-6168 只 SetEntity/SetCardDef）→ UpdateTextComponents 走 entity 重载
  // （Actor.cs:3223-3234 → :3685），其 UpdateAttackTextMesh/UpdateHealthTextMesh
  // （Actor.cs:4084-4142/4144-4204）经 UpdateNumberText(shouldHide:false)（Actor.cs:4370-4377）
  // 对非隐藏号只 Jiggle 不 Show（GemObject.m_hiddenFlag 为私有非序列化 bool 恒 false）→
  // "0" 写进失活 UberText、宝石子树现场恒隐，与 ATK/HEALTH tag 有无无关（用户游戏内
  // 复查 + 反编译双证 2026-10-11）。文本角色照登（UberText 被 m_attackTextMesh/m_healthTextMesh
  // 直引、抽取器 runtime-driven texts 豁免）但置空；宝石组件按层级失活态天然隐藏
  // （无旁路，见组件循环与 stat_gems 采集注释）。
  // def 路径（UpdateTextComponentsDef → UpdateAttackTextMesh(entityDef) Actor.cs:3414-3418/
  // 3462-3487 无条件 gemObject.Show()）只在 entityDef 语境发生 = exporter 静态导出伪影：
  // 曾据此复刻攻血 "0"（ticket 01），2026-10-11 定案为伪影、exporter 同步修复、renderer
  // 转正为现场口径；冻结基准 LT23_802P2/803P2 重导前 L2 挂账（残差主体即攻血区，
  // 复刻前 12.807/13.659 即该口径）。
  // minion 变体（hand-lettuce-ability-minion）prefab 出厂激活 + def 自带召唤物真值
  // （LT24_021T1_01c ATK5/HEALTH20；悬停召唤预览同源 Card.cs:827-828）→ 维持 GetTag-0
  // 标准原生口径，不吃此特例。
  const lettuceStatsHidden = slot === 'hand-lettuce-ability';
  const atkVal = tags[TAG.ATK];
  const attackVisible = !(hideStats || hide('HIDE_ATTACK')) && (!isHeroCard || (atkVal ?? 0) > 0);
  const healthVisible = !(hideStats || hide('HIDE_HEALTH'));
  const attackText = hide('HIDE_ATTACK_NUMBER') || (isHeroCard && !atkVal) || lettuceStatsHidden
    ? ''
    : (atkVal !== undefined || nativeCard ? String(atkVal ?? 0) : '');
  const healthText = hide('HIDE_HEALTH_NUMBER') || lettuceStatsHidden
    ? ''
    : (tags[TAG.HEALTH] !== undefined || nativeCard ? String(tags[TAG.HEALTH] ?? 0) : '');
  const armorVal = tags[TAG2.ARMOR] ?? 0;
  // 佣兵技能附件谓词（LettuceAbilityActor 对译；teardown findings §3）：
  // - UpdateSpeedWingState（:84-99）：被动/开局技 tag → 隐；m_updateVisualsOnCooldown ∧
  //   现冷却 tag → 隐（两个 ability prefab m_updateVisualsOnCooldown=0 → 只看被动 tag）。
  // - UpdateHourglassObject（:210-227）：配置/当前冷却文本任一非空才显；文本非空 =
  //   m_cooldownConfigText/m_currentCooldownText 引用绑定 ∧ 对应 tag ≠ 0（null 引用 →
  //   `null?.Text` 恒空 → 隐）。两 ability prefab 引用序列化为空 → 谓词恒假（基准目检：
  //   LT23 基准无沙漏）。
  const lettuceUpdateOnCooldown = ((sc['m_updateVisualsOnCooldown'] ?? 0) !== 0)
    && (tags[String(TAG3.LETTUCE_CURRENT_COOLDOWN)] ?? 0) !== 0;
  const speedWingVisible = !(tags[String(TAG3.LETTUCE_PASSIVE_ABILITY)] ?? 0)
    && !(tags[String(TAG3.LETTUCE_START_OF_GAME_ABILITY)] ?? 0)
    && !lettuceUpdateOnCooldown;
  const cooldownRef = refs['m_cooldownConfigText'] ?? refs['m_currentCooldownText'];
  const hourglassVisible = !!cooldownRef
    && ((tags[String(TAG3.LETTUCE_COOLDOWN_CONFIG)] ?? 0) !== 0
      || (tags[String(TAG3.LETTUCE_CURRENT_COOLDOWN)] ?? 0) !== 0);
  // 种族文本（EntityBase.GetRaceText :1237-1249）：随从走 CARDRACE + CARD_RACE 表循环
  // （nonTrinketRaces，多重种族卡的第二来源），**战棋饰品（CARDTYPE 44）走 BACON_SUBSET_***
  // 族（GetRacesForTrinket，见 trinketRaces 注释）；count>1 时 "\n" 连接（BuildRaceText）。
  // 此前饰品未接 subset、随从未接 CARD_RACE 表 → 单族板画空 / 双种族卡缺第二行。
  const isTrinket = cardType === 44;
  const raceIds = isTrinket ? trinketRaces(tags) : nonTrinketRaces(tags);
  const raceText = raceTextOf(raceIds, tables);
  const raceCount = raceIds.length;
  const schoolId = tags[TAG2.SPELL_SCHOOL] ?? 0;
  const schoolText = schoolId === 0 ? '' : (tables.schoolZh?.[schoolId] ?? 'UNKNOWN');
  // desc 卡集水印写点（引擎对译见 resolveWatermark 上方注释块；仅 desc 组件消费）
  const watermark: WatermarkSpec = resolveWatermark(fixture, wmTables, tags,
    { raceText, schoolText, cardType, isHeroCard },
    key => base.src.has(key));

  // ---- 战棋模板 spell 视觉（exporter ApplyBattlegroundsHandVisualSetup 逐卡型分支对译，
  //      ExporterController.cs:5056-5620；gem 替换 = Actor.UpdateManaGemComponent 隐藏
  //      m_manaObject，Actor.cs:5184-5201；tier 图标 spell 按 GetTechLevelSpellType 选
  //      TECH_LEVEL_MANA_GEM / BACON_TIMEWARPED→TIME_TAVERN_TIER_ICON，Actor.cs:7474-7484）----
  const techLevel = tags[TAG2.TECH_LEVEL] ?? 0;
  const timewarped = (tags[TAG2.BACON_TIMEWARPED] ?? 0) !== 0;
  const isBGTemplate = fixture.preset.template === 'Battlegrounds';
  const spellOverlays: RenderPlan['spell_overlays'] = [];
  let gemReplaced = false;
  let bgHideCost = false;
  let bgAltCost = false; // 费用文本挪 alternate 位（world_delta 标注在 texts.cost 上）
  let bgAltCostTarget: number[] | undefined;
  const lateNodes: string[] = [];
  // 铸币变体按帧选：各帧 actor 的 SpellTable 145 条目是不同的预制——逐表探针
  // explore/2026-10-03-bg-template/scripts/probe_table_refs.py：
  //   hand-spell → Card_Hand_Ability_CoinManaGem；hand-heropower →
  //   History_HeroPower_CoinManaGem；hand-bg-trinket → "Card_Hand_Ability_CoinManaGem 1"
  //   （名字串陈旧，实际 Card_Hand_Trinket_CoinManaGem）。
  let coinKey = 'coin-ability';
  if (slot === 'hand-heropower') coinKey = 'coin-heropower';
  else if (slot === 'hand-bg-trinket') coinKey = 'coin-trinket';
  // 铸币锚点 = 本帧自己的 Gem_Mana 世界位（UpdateManaGemComponent 原位替换语义）。
  const coinTarget = frameGemWorldPos(base, keyByPath);
  if (isBGTemplate) {
    const tierKey = timewarped ? 'tier-icon-timewarp' : 'tech-level-gem';
    if ((cardType === 4 || cardType === 47) && techLevel > 0) {
      // BG 随从：tier 盾+星替换费用宝石（ApplyBattlegroundsHandMinionVisualSetup
      // → ShowTavernTierSpell + HideCoinManaGem）。非时空：费用数字隐藏
      // （HideBattlegroundsHandCostTextNumber；引擎 ShouldHideCost 对 tech-level 随从恒 true）。
      gemReplaced = true;
      if (timewarped) {
        // 时空扭曲随从：等级盾与时空扭曲法术同款。位姿/材质 = 预制纯序列化（根 TRS=0）；
        // 盾面格子由**序列化材质自带的 _MainTex ST** 决定：Bacon_TechLevelBanner_Timewarp_Unlit
        // offset=(0,0.475)（scale 恒等）→ mesh v[0.537,0.971] +0.475 wrap 后 [0.012,0.446] =
        // Bacon_AllTierGuide_TimewarpTavernTier 左下格（渲染端 ST 变换见 render.ts overlay；
        // 提取侧 walk_material 本就采集 scale/offset）。2026-10-04 演进（用户逐轮目验）：
        // 基准实测 world_target 锚定撤销；uv_offset[0,-0.5] 是 ST 的 -0.5 近似——比引擎
        // 0.475 低 0.025v ≈ 5px = "微微下移"的真凶；Default 态换普通盾贴图一轮回滚
        // （游戏内背景就是本素材，用户指认；§7-3 "下面那格 plain" 裁定作废）。
        // 盾下 Chronum 费用铸币 = COST_ALT_TAVERN_COIN，exporter 对 timewarped 随从
        // ActivateSpellBirthState（ExporterController.cs:5443-5450），无重排 → 纯预制位姿
        // （Gem_Coin ≈ 屏幕 (108,250)，盾正下方；同法术分支，2026-10-04 用户目验通过）。
        // 费用数字按法术同法挪 alternate-cost 位（exporter 对 timewarped 随从不调
        // HideBattlegroundsHandCostTextNumber、只 EnableAlternateCostTextPosition；
        // 用户目验数字显示、位置随法术）。目标不用本帧 altCostWorldPos（随从帧 CostObject
        // 序列化位偏左 0.0163 → 引擎原样数字偏左 ~2.9px），用户裁定与法术对齐 → 采用
        // hand-spell 帧的 altCost 世界位。
        spellOverlays.push({ key: tierKey, tech_level: techLevel });
        spellOverlays.push({ key: 'alt-tavern-coin' });
        bgAltCost = true;
        bgAltCostTarget = ALT_COST_WORLD_HAND_SPELL.slice();
      } else {
        spellOverlays.push({ key: tierKey, tech_level: techLevel });
        bgHideCost = true;
      }
    } else if (cardType === 42) {
      // 酒馆法术：tech>0 → 等级徽章（宝石位）+ 铸币/数字在 alternate-cost 文本位
      // （EnableAlternateCostTextPosition → UpdateManaGemOffset，Actor.cs:1178/6454）；
      // timewarped 无铸币、等级盾锚到基准徽章位（用户按基准校准）。否则普通铸币在宝石位。
      gemReplaced = true;
      if (techLevel > 0) {
        const target = altCostWorldPos(base, refs, keyByPath);
        if (timewarped) {
          // 时空扭曲：等级盾 = 预制纯序列化（位姿/材质/UV，证据同上方 cardType 4/47 分支注释；
          // tag 门槛 BACON_TIMEWARPED(4503) → TIME_TAVERN_TIER_ICON，Actor.cs:7474-7484）。
          // Chronum 费用铸币 = 预制纯序列化位姿（2026-10-04，与 coin-bacon-spell 同法）：
          // 预制无 FSM（探针 Card_Hand_Ability_CardsCostAltTavernCoin）、根 TRS=(0,0,0)，
          // LoadSpell AttachAndPreserveLocalTransform 原样挂 actor 根 → Gem_Coin world
          // (-0.8384,0.085,0.5864) ≈ 屏幕 (108,250)——只比费用数字锚点低 ~8px（此前
          // world_target 锚 altCost 使其稍微偏上，用户目验）。exporter 同样不重排
          // （ExporterController.cs:5531-5539）。游戏内该图标本无法正确渲染（用户注），
          // 预制语义即权威。费用数字仍走 altCost（bgAltCostTarget）。
          spellOverlays.push({ key: tierKey, tech_level: techLevel });
          spellOverlays.push({ key: 'alt-tavern-coin' });
        } else {
          // 非时空：等级徽章 = 预制序列化位姿（tech-level-gem 根 TRS = 0；Shield/Stars 的序列化
          // world 组合已就位，泊位只在 local——findings §4）。铸币 = 预制序列化位姿**含根 TRS**
          // （Actor.LoadSpell，Actor.cs:6949：AttachAndPreserveLocalTransform 保留预制本地 TRS，
          // 挂 actor 根下恒等 "Spells" 节点，SpellTable 根缩放 ×1 → 预制根位即游戏内摆位；
          // coin-bacon-spell 根 z=-0.643 → Gem_Health world (-0.829,-0.018,0.597) ≈ 屏幕 (110,248)
          // = 等级徽章正下方。extract_spell 2026-10-04 起不再归零 spell 根平移）。
          spellOverlays.push({ key: tierKey, tech_level: techLevel });
          spellOverlays.push({ key: 'coin-bacon-spell' });
        }
        bgAltCost = true;
        bgAltCostTarget = target;
      } else {
        spellOverlays.push({ key: coinKey, anchor: 'world-target', world_target: coinTarget });
      }
    } else if (cardType === 5) {
      // BG 模板普通法术：tech>0 → 仅 tier 徽章且费用清空（exporter 注释引 ShouldHideCost 分支）；
      // 否则铸币（ApplyBattlegroundsHandCoinVisualSetup）
      gemReplaced = true;
      if (techLevel > 0) {
        bgHideCost = true;
        spellOverlays.push({ key: tierKey, tech_level: techLevel });
      } else {
        spellOverlays.push({ key: coinKey, anchor: 'world-target', world_target: coinTarget });
      }
    } else if (cardType === 44) {
      // 饰品：铸币（ApplyBattlegroundsHandCoinVisualSetup 的 trinket 分支），费用数字保留。
      // 定位 = coin-trinket 预制序列化位姿（无 world-target 锚）：Card_Hand_Trinket_CoinManaGem
      // 的 Gem_Health 序列化世界 (−0.002,−0.018,+1.490) ≠ 本帧 Gem_Mana 世界 (0,·,1.45)，
      // 按 m_manaObject 锚会让铸币低 ~8px（2026-10-08 用户指认；预制在 actor 空间内自查
      // 姿，LoadSpell 挂根保位即终位，与 alt-tavern-coin 同法）。
      gemReplaced = true;
      spellOverlays.push({ key: coinKey });
    } else if (cardType === 10) {
      // 英雄技能：铸币（ApplyBattlegroundsHandCoinVisualSetup 的 IsHeroPower 分支），费用数字保留
      gemReplaced = true;
      spellOverlays.push({ key: coinKey, anchor: 'world-target', world_target: coinTarget });
    } else if (cardType === 40) {
      // 任务奖励：隐 mana gem + 费用清空 + 铸币（ApplyBattlegroundsHandQuestRewardVisualSetup）
      gemReplaced = true;
      bgHideCost = true;
      spellOverlays.push({ key: coinKey, anchor: 'world-target', world_target: coinTarget });
    }
  }

  // ---- 组件骨架（report 节点 × 规则）----
  const components: PlanComponent[] = [];
  const byName = new Map<string, PlanComponent>();
  for (const node of report.nodes) {
    const slots = node.components.renderer?.material_slots;
    if (!slots || !slots.length) continue;
    const name = node.path.split('/').pop()!;
    const isActive = active.get(node.path) ?? true;
    let visible = isActive && !STATIC_HIDDEN.has(name)
      && !(rules.forcedHidden ?? []).includes(name);
    // Signature Evergreen 序列化 prefab 仅激活 Common；Actor.cs UpdateRarityComponent
    // :4939-4959 调 SetRarityGemShape，:4992-5022 按 rarity 对四个子物体 SetActive。
    // T3 曾强制隐藏全部变体，离线图因此缺宝石。重建运行时选择；网格和材质仍取自当前
    // 节点（含 Legendary 自身 UV、云纹材质和阴影子网格）。
    if (sigActive && SIG_RARITY_VARIANTS.has(name)) {
      const variant = rarityName === 'INVALID' ? '' : `RarityGem_${rarityName}_Mesh`;
      visible = rarityVisible && name === variant;
    }
    // 战棋饰品帧例外：Shadow（CardShadow_Ally，Effects/FX_Transparent_ColorAsAlpha）序列化
    // 激活且 renderer 启用，基准图带整卡外圈投影（94k 半透明像素，2026-10-08 对账）；其余
    // 帧型的 Shadow 在导出中不可见（ref 仅抗锯齿软边）维持隐藏。ShadowUnique renderer
    // 序列化禁用，仍由 STATIC_HIDDEN 兜底。
    // 佣兵本体帧同证（CardShadow_Ally，act+enabled，基准图卡框外 alpha 33~94 的黑色软影，
    // 2026-10-10 LT23_816H 实测）。
    if ((slot === 'hand-bg-trinket' || slot === 'hand-mercenary') && name === 'Shadow') visible = isActive;
    if (visible) {
      if (rules.elite.includes(name)) visible = isElite;
      else if (rules.rarity.includes(name)) visible = rarityVisible;
      else if ((rules.attack ?? []).includes(name)) visible = attackVisible;
      else if ((rules.health ?? []).includes(name)) visible = healthVisible;
      else if ((rules.armor ?? []).includes(name)) visible = armorVal > 0;
      else if ((rules.race ?? []).includes(name)) visible = !!raceText && raceCount === 1;
      else if ((rules.multiRace ?? []).includes(name)) visible = !!raceText && raceCount > 1;
      else if ((rules.trinketBadge ?? []).includes(name)) {
        visible = schoolId === TRINKET_SCHOOLS.LESSER || schoolId === TRINKET_SCHOOLS.GREATER;
      } else if ((rules.lettuceSpeedWing ?? []).includes(name)) visible = speedWingVisible;
      else if ((rules.lettuceHourglass ?? []).includes(name)) visible = hourglassVisible;
      else if (rules.noGem === name) visible = !rarityVisible;
    } else if (rules.noGem === name) {
      // 序列化失活的 No_Gem_Mesh 由运行时规则翻正/翻回（地标）
      visible = !rarityVisible;
    }
    const comp: PlanComponent = {
      node:           name, path:           node.path, visible, raster:         true,
      material_slots: slots.map(s => ({ slot: s.slot, empty: !s.name })),
    };
    if (sigActive && slot === 'hand-minion-sig1'
      && ['Gem_Attack_Mesh', 'Gem_Health_Mesh', 'Gem_Mana_Mesh'].includes(name)) {
      // Signature_25 stat meshes use the already-portable DiffuseAlphaMaskScroller shader;
      // render them in the gems stage once, not in both the frame bucket and gems stage.
      // Exact hierarchy/material paths are in frame_recon.json under AttackObject, HealthObject,
      // and CostObject.
      comp.raster = false;
    }
    if (slot === 'hand-spell' && name === 'Description_mesh' && schoolText
      && base.meshes['extra/m_spellDescriptionMeshSchool']) {
      comp.mesh = 'extra/m_spellDescriptionMeshSchool'; // 学派板网格替换（Actor.cs:6240-6252）
    }
    // 佣兵技能 desc 网格替换（UpdateRace flag2||flag5 支，Actor.cs:6175-6186；teardown
    // findings §4）：文本非空 → FrameTribeSpell_Combined（描述板+学派板一体 229 tris）；
    // 空 → m_spellDescriptionMeshNeutral = Lettuce_Ability_Frame_Mesh = **FrameMesh 整框
    // 几何**（243 tris，desc 节点局部 Y +0.036 ≈ 世界 +0.011 原位重画）——与 hand-spell
    // 「序列化网格本就是中性网格」的等价成立情形不同，两分支都要真建模。此分支无基准
    // 覆盖（两张 fixture 均带学派 tag），按反编译口径实现、回归基线不验收。
    if (slot.startsWith('hand-lettuce-ability') && name === 'Description_Spell_Combined') {
      if (schoolText && base.meshes['extra/m_spellDescriptionMeshSchool']) {
        comp.mesh = 'extra/m_spellDescriptionMeshSchool';
      } else if (base.meshes['extra/m_spellDescriptionMeshNeutral']) {
        comp.mesh = 'extra/m_spellDescriptionMeshNeutral';
      }
    }
    // UpdateDescriptionMesh 恒调 UpdateWatermark（Actor.cs:5071）——alpha=0 的阴性卡
    // 也携带写点（desc 整框走引擎语义，见 rasterZbuf wm 分支）
    if (name === 'Description_mesh') comp.watermark = watermark;
    if (comp.visible) byName.set(name, comp);
    components.push(comp);
  }

  // ---- 预乘合成判定（材质 `_SrcBlend=1/_DstBlend=10`）----
  // 实现口径见 raster.ts premultiplied 分支与 types.PlanSlot.premultiplied 注释：rgb 直写 +
  // alpha 覆盖面=1（导出器基准图 alpha 走 AlphaFillOpaque 几何 mask + R2TColorAlphaCombineAdd，
  // 与纹理 alpha 无关——2026-10-11 定案）。全仓仅佣兵帧三代材质命中（其它帧零回归由字节
  // 比对保证）。
  for (const comp of components) {
    if (!comp.visible) continue;
    const node = findNode(base.frameRecon.hierarchy, comp.path);
    for (const materialSlot of comp.material_slots ?? []) {
      const fl = node?.renderers?.[0]?.materials?.[materialSlot.slot]?.floats;
      if (fl?.['_SrcBlend'] === 1 && fl?.['_DstBlend'] === 10) materialSlot.premultiplied = true;
      if (sigActive && slot === 'hand-minion-sig1' && comp.node === 'Transluscent_Mesh') {
        // The selected SRPDefaultUnlit shader pass uses SrcAlpha/OneMinusSrcAlpha,
        // ZTest LEqual, ZWrite Off (essential_base_global-shader-0.unity3d; pass selection in
        // RenderCommandLists.cs:49-54, 187-204). Keep depth testing enabled and preserve z-buffer.
        materialSlot.write_depth = false;
      }
    }
  }

  // ---- 载体节点不参与帧光栅（文字走 RTT 网格采样）----
  const carrierPath = base.frameManifest?.carrier?.node;
  if (carrierPath) {
    const c = components.find(x => x.path === carrierPath);
    if (c) c.raster = false;
  }

  // ---- 写点（Actor.cs:6662-6720 对译）----
  const cardMeshPath = refs['m_cardMesh']?.node;
  const portraitMeshPath = refs['m_portraitMesh']?.node;
  const cardFrontIdx = sc['m_cardFrontMatIdx'] ?? 0;
  const portraitIdx = sc['m_portraitMatIdx'] ?? 0;
  const portraitFrameIdx = sc['m_portraitFrameMatIdx'] ?? 0;
  const cardMeshComp = components.find(c => c.path === cardMeshPath);
  const portraitMeshComp = components.find(c => c.path === portraitMeshPath);
  const cardFrontMatName = report.nodes.find(n => n.path === cardMeshPath)
    ?.components.renderer?.material_slots?.find(s => s.slot === cardFrontIdx)?.name ?? null;
  // Premium actors receive their class-colored ribbon through SetMaterialPremium's
  // m_premiumRibbon write (Actor.cs:6577-6634); replacing the card front with the ordinary
  // CardColorSwitcher atlas would discard the premium frame material. Keep the prefab's own
  // serialized class panel for GOLDEN and SIGNATURE slots.
  // T09 JAIL_450 GOLDEN 的死亡骑士肖像外框需保留 WEAPON 的单色 DK 特支，且两侧装饰花要金色：
  // Actor.SetMaterialWithTexture（Actor.cs:6700-6708）在 WEAPON 且 ColorType=TYPE_DEATHKNIGHT、
  // colors.Count==1 时将类色 atlas 写入 portraitMesh[m_portraitFrameMatIdx]。金卡帧把卡身放在
  // 独立的 premium cardMesh 材质中，但 PortraitFrame_mesh 仍保留单独的框体子网格/材质槽；此前
  // `!goldenActive` 总门控漏掉了这个写点，导致 JAIL_450 区域回落到通用金框（当前框区 MAE=31.614）。
  // 只覆写金卡武器的肖像框槽，不改 premium cardMesh：UnityPy 探针
  // assets/frames/hand-weapon-golden/prefab_report.json 的 m_portraitFrameMatIdx=0、
  // m_portraitMatIdx=1；CardColorSwitcher.cs:78-79/226-272 的 weaponCardTextures[1] 即
  // Card_Inhand_Weapon_DK（assets/textures/Card_Inhand_Weapon_DK_91041c28.png）。
  const goldenDkWeaponFrame = goldenActive
    && (tags[TAG.CARDTYPE] ?? 0) === 7
    && className === 'DEATHKNIGHT'
    && (tags[476] ?? 0) === 0; // MULTIPLE_CLASSES；引擎特支只接受单色（colors.Count == 1）
  const goldenDkWeaponFrameAtlas = 'frames/hand-weapon-golden/textures/Card_Inhand_Weapon_DK_Golden.png';
  if (goldenDkWeaponFrame && !base.src.has(goldenDkWeaponFrameAtlas)) {
    throw new Error(`[golden] ${fixture.cardId} 缺少 DK 金卡武器框合成图 ${goldenDkWeaponFrameAtlas}`);
  }
  if (atlasFile && !sigActive && (!goldenActive || goldenDkWeaponFrame)) {
    if (!goldenActive && cardMeshComp && cardFrontIdx > -1) {
      setSlotTex(cardMeshComp, cardFrontIdx, atlasFile);
    }
    // SPELL 分支恒写 portraitFrameMatIdx；其余帧按"同名材质实例共享"（引擎内同一 Material 资产）
    const isSpell = (tags[TAG.CARDTYPE] ?? 0) === 5 || (tags[TAG.CARDTYPE] ?? 0) === 42;
    if (portraitMeshComp && portraitFrameIdx > -1) {
      const pfName = report.nodes.find(n => n.path === portraitMeshPath)
        ?.components.renderer?.material_slots?.find(s => s.slot === portraitFrameIdx)?.name ?? null;
      if (goldenDkWeaponFrame || isSpell || (pfName && cardFrontMatName && pfName === cardFrontMatName)) {
        // On GOLDEN single-class DK weapons, this submesh atlas also paints both nameplate-side
        // flowers. The base DK atlas makes those ornaments dark; replacing it wholesale with
        // the GOLDEN atlas restores the flowers but loses the DK frame. `PortraitFrame_mesh`
        // has one material slot, so use a deterministic texture composite: GOLDEN texels in the
        // measured flower UV rectangles and DK texels elsewhere. `Actor.cs:6700-6708` writes one
        // class texture into `m_portraitFrameMatIdx`; `CardColorSwitcher.cs:226-272` resolves the
        // weapon class atlas. UnityPy `assets/frames/hand-weapon-golden/prefab_report.json`
        // confirms this mesh uses slot 0 (`m_portraitFrameMatIdx=0`, portrait image slot 1).
        // UV evidence and the reviewed A/B are in `explore/2026-10-26-golden-stage-b/`.
        setSlotTex(portraitMeshComp, portraitFrameIdx,
          goldenDkWeaponFrame ? goldenDkWeaponFrameAtlas : atlasFile);
      }
    }
    const noGemPath = refs['m_rarityNoGemMesh']?.node;
    const noGemComp = components.find(c => c.path === noGemPath);
    if (slot === 'hand-location' && noGemComp) setSlotTex(noGemComp, 0, atlasFile);
  }
  if (portraitMeshComp && portraitIdx > -1 && portraitFile) {
    setSlotTex(portraitMeshComp, portraitIdx, portraitFile);
  }
  // ---- 类色注入（Actor.SetMaterialPremium 对译，Actor.cs:6577-6599；spec 实现决策 7）----
  // m_premiumRibbon（Actor.cs:211，T2 随帧导出）= m_cardMesh 渲染器材质槽索引，
  // 签名帧恒 2（RootObject/Mesh 三 submesh：uber 图集 / 卡背 / 类色——UnlitDualClass-
  // TextureTint 材质 Card_Signature_Evergreen_ClassColor_Mat）。
  // 单类：material.color（Unity 即写 _Color）= CLASS_COLOR_*、_EnableDualClass=0 →
  // Custom/Card/UnlitDualClassTextureTint FS（_nokw 变体反编译）坍缩为
  // out = _Color × tex × vcol（firstMix ≡ 1、secondMix ≡ 0、(1−sum) ≡ 0）→ 渲染端 =
  // material_override._tint_rgb（rgb 乘、alpha=1 同 FS 的 _Color.a）。
  // 多类：_Color=left / _SecondColor=right（GetDualClassColors = combo.colors[0]/[1] 经
  // GetDualClassColor，同 CLASS_COLOR 表）+ _EnableDualClass=1，阶梯按 POSITION.x 对
  // _MiddleValue(材质序列化 −0.04)/_FirstColorRightMargin(0.02) 分左右（VS：TEXCOORD0.z =
  // POSITION.x）。现 fixture 无多类异画卡——阶梯参数已随 T2 材质入包（frame_recon colors/
  // floats），实现留待 fixture 触发（T3 口径）。
  const premiumRibbon = sc['m_premiumRibbon'] ?? -1;
  if ((sigActive || goldenActive) && premiumRibbon >= 0 && cardMeshComp) {
    const ribbonSlot = cardMeshComp.material_slots?.find(s => s.slot === premiumRibbon);
    if (ribbonSlot) {
      ribbonSlot.material_override = {
        _tint_rgb: CLASS_COLOR[className] ?? CLASS_COLOR.GENERIC,
      };
    }
  }
  if (slot === 'hand-bg-trinket' && portraitFile) {
    // 饰品原画窗：NonQuestObjects/Mesh 的 slot0（BG_Trinket_BigCard_FramePortrait_Mat，6 tri
    // 窗 quad）。m_portraitMesh 指向的 FrameMesh 只有 1 个子网格（slot1 序列化为空且无几何），
    // 实际画窗是这个兄弟节点的 FramePortrait 材质（材质名即证）。
    const artPath = `${report.prefab.name}/RootObject/NonQuestObjects/Mesh`;
    const artComp = components.find(c => c.path === artPath);
    if (artComp) {
      setSlotTex(artComp, 0, portraitFile);
      // Custom/Card/Unlit_Portrait 双纹理语义：_SecondTex@UV1 = 窗内蒙版（图集左上白底
      // 黑环块，uv1 x[0.016,0.255] y[0.778,1.002] 正对该块）——白=透、暗环=画窗内圈
      // 阴影。缺失即内圈阴影整环丢失（2026-10-08 BG32 基准对比实证）。渲染端按
      // main×second 乘法合成（second 全不透明、白处 rgb=1；等价 alpha=1 的水印式）。
      const artSlot = artComp.material_slots?.find(sl => sl.slot === 0);
      if (artSlot) artSlot.second_tex_mask = true;
    }
  }
  if (slot === 'hand-bg-trinket' && (schoolId === TRINKET_SCHOOLS.LESSER
    || schoolId === TRINKET_SCHOOLS.GREATER)) {
    // UpdateBaconTrinketComponents（Actor.cs:5404-5420）：m_trinketLevelPortraitMesh 的
    // materials[0] = m_lesserTrinketMaterial / m_greaterTrinketMaterial（整材质替换，含 _Color）。
    const medComp = components.find(c => c.path === refs['m_trinketLevelPortraitMesh']?.node);
    if (medComp) {
      const tex = schoolId === TRINKET_SCHOOLS.LESSER ? 'lesser' : 'greater';
      setSlotTex(medComp, 0, `frames/hand-bg-trinket/textures/TrinketIconHeroSelect_${tex}.png`);
      // swap 材质 _Color=(1,1,1)：序列化 Lid 材质 _Color=(0,0,0,1) 纯黑，不重设 tint 会把纹章染黑。
      const swapMat = (base.frameRecon as { material_refs?: Record<string, { colors?: Record<string, number[]> }> })
        .material_refs?.[schoolId === TRINKET_SCHOOLS.LESSER ? 'm_lesserTrinketMaterial' : 'm_greaterTrinketMaterial'];
      const swapColor = swapMat?.colors?.['_Color'] ?? [1, 1, 1];
      const medSlot = medComp.material_slots?.find(sl => sl.slot === 0);
      if (medSlot) medSlot.material_override = { _tint_rgb: swapColor.slice(0, 3) };
      // 底板：Ring 节点 slot0（6 tri quad，_MainTex=GenFX_white32x32 占位白）深度比纹章近，
      // 盖住纹章 → 徽章激活时不参与光栅（真实底板材质的运行时来源待 exporter 基准确认）。
      const ringComp = components.find(c => c.path === refs['m_trinketLevelIndicator']?.node);
      const ringSlot = ringComp?.material_slots?.find(sl => sl.slot === 0);
      if (ringSlot) ringSlot.skip = true;
      // 阴影 quad 的 UV 是 Anomalies_Atlas 右缘竖带（x 0.85-0.99，v −1.04..2.16 逐段平铺
      // 选阴影块），材质 ST 单位 → 采样越界全靠引擎贴图缺省 wrap=repeat；raster 缺省 clamp
      // 会把越界段拉成边缘白像素、整个乘法阴影不可见（2026-10-08 BG32 实测，徽章外圈
      // 阴影缺失根因）。与多职业缎带阴影（Multiclass_Ribbon_Shadow）同一 wrap 语义。
      const trinketShadowComp = components.find(c => c.node === 'Trinket_Medallion_Shadow_Mesh');
      const trinketShadowSlot = trinketShadowComp?.material_slots?.find(sl => sl.slot === 0);
      if (trinketShadowSlot) trinketShadowSlot.wrap_repeat = true;
      // 徽章子树晚通道：运行时 SetActive 整容器激活（UpdateBaconTrinketComponents，
      // Actor.decompiled.cs:5558-5574——m_trinketLevelIndicator.gameObject.SetActive(flag)
      // 一次性开关子树，无逐子节点顺序），层序 = Unity 材质队列：medallion（Custom/Card/
      // UnlitTexture）与 Ring（Hero/Unlit/Unlit_TextureColor）不透明先画，阴影
      // （Hero/Multiply/Multiply，Transparent 队列 ZWrite Off）最后乘法合成——乘法读
      // dst，先画会被后画的不透明纹章/环完全覆盖（2026-10-08 BG32 实测：阴影最先时
      // 徽章区零像素变化）。
      for (const nm of [...(rules.trinketBadge ?? [])
        .filter(x => x !== 'Trinket_Medallion_Shadow_Mesh'), 'Trinket_Medallion_Shadow_Mesh']) lateNodes.push(nm);
    }
  }

  // ---- 宝石晶体（攻/血/费）：材质序列化值采集（py _collect_stat_gems 同口径）----
  const statGems: RenderPlan['stat_gems'] = [];
  for (const [path, key] of keyByPath) {
    const name = path.split('/').pop()!;
    const gemName = sigActive && slot === 'hand-minion-sig1' ? name.replace(/_Mesh$/, '') : name;
    if (!['Gem_Attack', 'Gem_Health', 'Gem_Mana'].includes(gemName)) continue;
    // 序列化失活子树里的同名节点不采（战棋畸变帧 Gem_Mana 失活=无费用显示；
    // 佣兵技能 spell 变体攻血宝石同口径——出厂失活且运行时 entity 路径从不翻正，
    // 见 hand-lettuce-ability FRAME_RULES 注释与 teardown findings §9 修正）；
    // 战棋模板下 mana gem 被 coin/tier spell 替换（UpdateManaGemComponent 隐藏 m_manaObject）。
    if (!(active.get(path) ?? true)) continue;
    if (gemReplaced && gemName === 'Gem_Mana') continue;
    const comp = byName.get(name);
    if (gemName !== 'Gem_Mana' && !comp) continue;
    const node = findNode(base.frameRecon.hierarchy, path);
    const mat = node?.renderers?.[0]?.materials?.[0];
    if (!mat) continue;
    statGems.push({
      node:          gemName, path, npz_key:       key,
      main_tex_file: mat.tex?.['_MainTex']?.texture?.file ?? '',
      tint_rgb:      (mat.colors?.['_tint'] ?? [1, 1, 1, 1]).slice(0, 3),
      intensity:     mat.floats?.['_Intensity'] ?? 1.0,
      speed_xy:      [mat.floats?.['_XSpeed'] ?? 5.0, mat.floats?.['_YSpeed'] ?? 0.2],
      scale_xy:      [mat.floats?.['_ScaleX'] ?? 1.0, mat.floats?.['_ScaleY'] ?? 1.0],
    });
  }

  // ==========================================================================
  // 佣兵本体（Card_Hand_Mercenary）运行时 delta（ticket 05；结构实证见
  // docs/findings/lettuce-frame-teardown-2026-10-10.md §7.3 + 本票 findings）
  // ==========================================================================
  let levelWorldDelta: number[] | undefined;
  if (slot === 'hand-mercenary') {
    // ---- 职业横幅（攻击 + 生命各一套）----
    // MercenaryRoleGemObject.SetRole（Actor.cs:5262-5271）：角色 = LETTUCE_ROLE tag
    // （GetMercenariesRole :5273-5285），对 AttackObject/HealthObject 上两个 RoleGemObject
    // 的映射表逐项 `SetActive(m_role == role)`——恰好激活一套 {Caster,Fighter,Protector,
    // Neutral} 横幅；INVALID(0) → 全不激活。
    // 激活对象 = 容器（Quad，renderer 序列化 m_Enabled=false 且无启用方）与其中的网格子节点
    // （同名，renderer 启用）——真实绘制的是子节点网格（Lettuce_Merc_Hand_{Damage,Mage,
    // Tank}_mesh / Health 系），容器 Quad 的 _MainTex 为空槽且 renderer 禁用，不画。
    // SetRole 是**互斥**设置：序列化态里 Fighter/Caster 容器是激活的（美术工作残留），
    // 不选中的三套必须显式翻回隐藏，否则旧激活角色与选中角色同时出画（本票首轮渲染实测）。
    // 子节点材质 = Lettuce_Hand_MercGems_Mat（Hero/Diffuse/DiffuseAlphaMaskScroller，
    // 与攻血宝石同族）→ 走 gems 阶段公式（clouds×_tint 项），不进帧光栅；颜色来自
    // Lettuce_MercOval_HeathAttackScarf 图集按角色的 UV 区域（探针实测：Tank=红、
    // Damage=绿、Mage=蓝），无需运行时染色。
    const role = tags[String(TAG3.LETTUCE_ROLE)] ?? 0;
    // 每套横幅 = 容器节点（.../RoleBanner_{X}_{A|H}，Quad）＋同名网格子节点（容器/同名）。
    for (const containerTmpl of [MERC.ROLE_ATTACK_C, MERC.ROLE_HEALTH_C]) {
      for (const [roleId, suffix] of Object.entries(ROLE_NODE_SUFFIX)) {
        const containerRel = containerTmpl.replace(/%s/g, suffix);
        const innerRel = `${containerRel}/${containerRel.split('/').pop()!}`;
        const selected = Number(roleId) === role;
        for (const comp of components) {
          if (comp.path.endsWith(innerRel)) {
            comp.visible = selected; // 网格子节点（真几何）
            if (selected) comp.raster = false; // 宝石 shader 族 → gems 阶段（见上注）
          } else if (comp.path.endsWith(containerRel)) {
            // 容器 Quad：renderer 序列化 m_Enabled=false（无启用方）→ 永不光栅；
            // 未选中角色整树隐藏（序列化态 Fighter/Caster 容器激活是美术残留，
            // 引擎由 SetRole 翻回——不翻会与选中角色同时出画，首轮渲染实测）。
            comp.visible = false;
          }
        }
        if (!selected) continue;
        const comp = components.find(c => c.path.endsWith(innerRel));
        const node = comp ? findNode(base.frameRecon.hierarchy, comp.path) : null;
        const mat = node?.renderers?.[0]?.materials?.[0];
        if (!comp || !mat) continue;
        statGems.push({
          node:          comp.node ?? '',
          path:          comp.path,
          npz_key:       keyByPath.get(comp.path) ?? '',
          main_tex_file: mat.tex?.['_MainTex']?.texture?.file ?? '',
          tint_rgb:      (mat.colors?.['_tint'] ?? [1, 1, 1, 1]).slice(0, 3),
          intensity:     mat.floats?.['_Intensity'] ?? 1.0,
          speed_xy:      [mat.floats?.['_XSpeed'] ?? 5.0, mat.floats?.['_YSpeed'] ?? 0.2],
          scale_xy:      [mat.floats?.['_ScaleX'] ?? 1.0, mat.floats?.['_ScaleY'] ?? 1.0],
          all_subs:      true, // 职业宝石网格 2 子网格（伤/血形状部分），同材质
        });
      }
    }

    // ---- 阵营旗（Actor.UpdateMercenaryFactionBannerMesh，Actor.cs:3530-3560）----
    // flag = LETTUCE_FACTION != NONE → 容器 SetActive(flag) + 恰好一个图标 SetActive
    // （图标表 7 项 1..7 探针实测）。
    const faction = tags[String(TAG3.LETTUCE_FACTION)] ?? 0;
    const factionName = FACTION_NODE[faction];
    if (factionName) {
      const bg = components.find(c => c.path.endsWith(MERC.FACTION_BG));
      if (bg) bg.visible = true;
      const icon = components.find(c => c.path.endsWith(MERC.FACTION_ICON.replace('%s', factionName)));
      if (icon) icon.visible = true;
      // 旗影剪影 `Lettuce_Faction_Shadow`：随容器激活渲染（2026-10-11 修复「旗影未渲染」）。
      // 引擎口径 = Actor.cs:3546 只 SetActive 容器 m_factionBannerBackground、:3547-3555
      // 循环只切换 7 个图标 m_banner，**两个 shadow 节点都无代码触达**（ilspy 全库 grep
      // 「OvalShadow」「Lettuce_Faction_Shadow」零引用）→ 显隐完全由序列化 active_self 决定，
      // 容器激活即连带激活自激活子孙（Unity SetActive 语义）。探针（frame_recon）：
      // Lettuce_Faction_Shadow active_self=true——4 顶点 quad，mesh UV 窗
      // u[0.782,0.969]×v[0.222,0.428] 直指 FactionBanner_Icons 图集剪影象限（探针裁剪实测
      // 核心 rgba≈(0,0,0,245) 纯黑剪影；Horde 象限对照 (131,72,60,253)），材质同图标
      // Faction_Symbols（Hero/Unlit_Transparent alpha-over、_Color 白），世界位 y=0.1048
      // 在旗图标（0.106+）之后/环（0.04）之前 → 画序 = 影→旗，从旗左下缘探出压在环右缘带
      // （§12.14 残差带 x[344,368] y[116,228] 与影 quad 投影 px[338,478]×py[118,270] 左缘
      // 吻合）。此前归因给 `OvalShadow`（§12.8 item 7）系误判：该节点 active_self=false 且
      // 无代码触达 → 引擎从不渲染，随旗激活它属超出引擎行为（本轮回退，连同其 FlagShadow
      // 采样链一并失效；基准旗影由本节点承载）。
      const iconShadow = components.find(c => c.path.endsWith(MERC.FACTION_ICON_SHADOW));
      if (iconShadow) iconShadow.visible = true;
    }

    // ---- 种族板（UpdateRace flag7 支 = IsMinion，Actor.cs:6140-6170）----
    // m_racePlateObject（Race_Tribe_Merc_mesh）只承载文本节点（自身 renderer 无网格）；
    // 单族 → Race_Tribe_Merc_text（序列化激活），多族 → DualRace_Tribe_Merc_text +
    // m_multiRacePlateObject（DualTribe Teir1 板）SetActive(true) 并逐个启用其子 renderer。
    // 多族分支无 fixture 覆盖，按反编译口径实现（回归基线不验收）。
    if (raceCount > 1) {
      const plate = components.find(c => c.path.endsWith(MERC.DUAL_PLATE));
      if (plate) plate.visible = true;
    }

    // ---- 等级数字锚位（基准对账；机制见 findings）----
    // Actor 链只写文本（UpdateMercenaryLevelTextMesh），不做布局；prefab 里 LevelText 节点
    // 位于卡面上部 (207.6,336.5)px，而基准图数字画在稀有度宝石内（glyph 质心 (254,447) vs
    // 宝石世界中心 (255.3,441.7)，≤1px）——移动由 Hearthstone.UI widget 布局/widget FSM 所为
    // （Actor 链外，未及反编译）。复刻口径 = 把等级文本节点平移到 RarityGem 节点世界位。
    const levelNode = findFrameNodeWorld(base, keyByPath, MERC.LEVEL_TEXT);
    const gemNode = findFrameNodeWorld(base, keyByPath, MERC.RARITY_GEM);
    if (levelNode && gemNode) {
      levelWorldDelta = [0, 1, 2].map(i => gemNode.world[i][3] - levelNode.world[i][3]);
    }

    // ---- 等级对象 / 经验条 / 水印（收集卡语境，Actor.cs:4244-4257 分支）----
    // 反编译：`if ((isGameplayMercenary || m_showUICardText) && m_mercenaryLevelObject != null)`
    // → 等级对象 SetActive(true)、**m_xpBar / m_xpBarBacking / m_xpBarCover SetActive(false)**、
    //   `m_watermarkMesh.SetActive(string.IsNullOrEmpty(powersText))`。
    // 基准 LT23_816H（2026-10-10 用户重导）实证该分支成立且对局文本为空：经验条/底衬/盖板
    // 不渲染、desc 区出 `Watermark` 节点的 LET 压暗水印（Mark 网格，材质 Watermark_LET =
    // Hero/Multiply/Multiply + LETIcon——序列化纹理固定为佣兵模式图标，不走卡片集裁决链）。
    for (const nm of ['XPBarBacking', 'MercenaryXPBar', 'XPBarCover']) {
      const comp = components.find(c => c.path.endsWith(`MercenaryLevelObject/${nm}`));
      if (comp) comp.visible = false;
    }
    // 水印节点 = `RootObject/Watermark` 容器下的 Mark（容器自身无 renderer，不在 components 里）
    for (const c of components) {
      if (c.path.includes('/RootObject/Watermark/')) c.visible = true;
    }
  }

  // ---- Signature_25 玻璃层晚通道（PortraitFrame → Transluscent → text）----
  // 工单 07 针对 RLK_706 名称框两端被肖像盖住、Glass Mask 未执行的症状：在离线肖像合成后
  // 重画 Transluscent_Mesh。游戏 RTT 的 RenderCommandLists.cs::SortRenderCommands（:70-76）
  // 按 sortingOrder 排序，而离线链将肖像作为独立阶段；帧节点/材质由
  // assets/frames/hand-minion-sig1/frame_recon.json 的 Transluscent_Mesh 记录，RTT 选 pass
  // 由 RenderCommandLists.cs::AppendRenderCommands（:49-54,:187-204）证明。晚通道保留
  // LEqual 深度测试并由 Shader pass 0 的 ZWrite Off 保持 z-buffer 不变。
  if (sigActive && slot === 'hand-minion-sig1'
    && components.some(c => c.node === 'Transluscent_Mesh' && c.visible)) {
    lateNodes.push('Transluscent_Mesh');
  }

  // ---- 文字压画层晚通道（签名帧特有；spec 实现决策 10 的层序面）----
  // TextGradient（Hero/Multiply/Multiply × card_signature_text_gradient）/Divider
  // （Unlit_TransparentColor）是 Transparent 队列层，引擎里画在**不透明肖像之后**压暗
  // 文字带。本链肖像公式层（renderPortraitLayer）在全帧光栅后强画且全出血覆盖
  // y127-616——若渐变留在主光栅，会被肖像层整片擦掉（2026-10-25 GDB_477 实测：desc 带
  // 压暗完全丢失）。走 late_nodes（肖像/overlay 之后、独立 zbuf 按序合成）复刻队列序。
  if (sigActive) {
    for (const nm of ['TextGradient', 'Divider']) {
      if (components.some(c => c.node === nm && c.visible)) lateNodes.push(nm);
    }
  }

  // ---- 文字角色 ----
  const bodyFor = (role: string): string => {
    switch (role) {
    case 'cost':
      if (bgHideCost) return ''; // 战棋模板：tier 徽章/铸币替换费用显示（见 spellOverlays 规则）
      if (slot === 'hand-hero') return String(tags[TAG.COST] ?? 0); // 英雄费用缺省显 "0"
      return tags[TAG.COST] !== undefined ? String(tags[TAG.COST]) : '';
    case 'name':
      // 名字不是裸 DBF 字符串：EntityDef.GetName → CardTextBuilder.BuildCardName
      // （CardTextBuilder.cs:97-100；Universal 兜底 :1930-1932 同式；仅 INVESTIGATE 特例，
      // fixture 集未用）= TryFormat(TransformCardText(原始名), GetTag(CARD_NAME_DATA_1))。
      // 佣兵装备/技能名带的 {0} 占位由此展开——2890 缺省 GetTag=0（「中立之心{0}」→
      // 「中立之心0」，LT23_036E2_04 实证）；无占位符名字原样通过。textBuilderType 对名字
      // 的影响仅经此公共公式（type 7 不覆写 BuildCardName）。
      return tryFormat(transformCardText(fixture.name.zhCN ?? ''), [tags[TAG3.CARD_NAME_DATA_1] ?? 0]);
    case 'desc': return resolveDescText(fixture, fixture.cardId); // textBuilderType 分派（@/{n}/$# 占位符），fail-fast
    case 'race':
      // 法术与佣兵技能（施法/召唤两变体）的 race 槽 = 学派文本（UpdateRace flag2||flag5
      // 同支，GetRaceText → 学派名；Actor.cs:6143/6160-6166）
      // 签名法术 frame 10 使用独立 RacePlate_UberText（抽取 role_paths），但仍是同一游戏
      // UpdateRace 学派分支；将新槽纳入此判断，避免用 minion raceText 替代 schoolText。
      if (slot === 'hand-spell' || slot === 'hand-spell-sig10'
        || slot.startsWith('hand-lettuce-ability')) return schoolText;
      return raceText;
    case 'level':
      // 佣兵本体等级数字（MercenaryActorLevelObject.SetLevelText，:79-83 =
      // GetMercenaryLevelFromExperience(LETTUCE_MERCENARY_EXPERIENCE).ToString()）。
      return slot === 'hand-mercenary'
        ? String(mercenaryLevelFromExperience(tags[String(TAG3.LETTUCE_MERCENARY_EXPERIENCE)] ?? 0))
        : '';
    case 'attack': return attackText;
    case 'health': return healthText;
    case 'armor': return armorVal > 0 ? String(armorVal) : '';
    default: return '';
    }
  };
  let costWorldDelta: number[] | undefined;
  if (bgAltCost && bgAltCostTarget) {
    const node = findFrameNodeWorld(base, keyByPath, base.frameManifest?.role_paths?.cost ?? '∅');
    if (node) {
      costWorldDelta = [0, 1, 2].map(i => bgAltCostTarget[i] - node.world[i][3]);
    }
  }
  const texts = rules.roles.map(role => {
    const body = bodyFor(role);
    if (!body) return { role, render: false, reason: '文本为空（缺省/规则隐藏）' };
    // 佣兵本体文本：统一下移 1px（用户 2026-10-10 目检「名字/等级/种族都偏高」；三者白墨
    // 质心实测 +0.6/+1.0/~0 px，取整 1px）+ 逐角色字号补偿（见 MERC_TEXT_SCALE_MUL）。
    // world_delta 的 z 轴 = 屏幕 y 反向（camera.ts projectY），故 z -= 1/192 → 下移 1px。
    if (slot === 'hand-mercenary') {
      const dz = -1 / 192;
      if (role === 'level' && levelWorldDelta) {
        return { role, render:      true, text:        body,
          scale_mul:   MERC_TEXT_SCALE_MUL[role],
          world_delta: [levelWorldDelta[0], levelWorldDelta[1], levelWorldDelta[2] + dz] };
      }
      if (['name', 'race'].includes(role)) {
        return { role, render:      true, text:        body,
          ...(MERC_TEXT_SCALE_MUL[role] ? { scale_mul: MERC_TEXT_SCALE_MUL[role] } : {}),
          world_delta: [0, 0, dz] };
      }
    }
    if (role === 'cost' && costWorldDelta) return { role, render: true, text: body, world_delta: costWorldDelta };
    // 佣兵本体等级数字锚位（见上方佣兵段落注释）：平移到 RarityGem 节点世界位
    if (role === 'level' && levelWorldDelta) {
      return { role, render: true, text: body, world_delta: levelWorldDelta };
    }
    // UpdateRace（Actor.cs:6206-6234）：num2>1 时单族 node 文本 SetActive(false)、文本
    // 落到 **Multi_RaceUberText**（m_multiRaceTextMesh），按其自有盒（H 更高）走 grow 拟合；
    // ResizeToFit=false 只设在单族 node（多族下它是隐藏 no-op）。故多族 → 换节点渲染。
    // 佣兵本体帧的多族节点名是 DualRace_Tribe_Merc_text（探针 role 表外的 actor 绑定字段）。
    if (role === 'race' && raceCount > 1) {
      const multiNode = (() => {
        // Evergreen 签名帧的多族节点名（extract_frame ROLE_BY_NODE 注释：带下划线命名族）
        const wanted = new Set(['Multi_RaceUberText', 'DualRace_Tribe_Merc_text',
          'Multi_RacePlate_UberText']);
        const stack: Array<{ path?: string, name?: string, children?: unknown[] }> = [base.frameRecon.hierarchy as never];
        while (stack.length) {
          const n = stack.pop()!;
          if (wanted.has(n.name ?? '') && n.path) return n.path;
          for (const c of n.children ?? []) stack.push(c as never);
        }
        return undefined;
      })();
      if (multiNode) return { role, render: true, text: body, node_path: multiNode };
    }
    return { role, render: true, text: body };
  });

  // ---- opaque-edge alpha 修复标记（写点完成后按最终纹理判定；见 needsOpaqueEdgeRepair）----
  markOpaqueEdgeSlots(components, report.nodes,
    path => findNode(base.frameRecon.hierarchy, path) as
      | { renderers?: { materials?: (FrameMaterial | null)[] }[] } | null);

  // ---- DK 符文横幅（tag 2196/2197/2198 → 显隐 + 图标材质覆写；含图标 opaque 豁免，须在标记后）----
  compileRuneBanner(components, tags);

  // ---- 手牌横幅：可交易/锻造/准备 + 阵营 + 多职业绶带（须在标记后：激活态才判 tint/材质覆写）----
  compileBanners(components, tags, tables, base.frameRecon.hierarchy);

  // 2026-10-26 — frame14 Deathwing's top multiclass orb overlaps the independent signature portrait.
  // `portrait_skip_depth_test` let the portrait redraw over that foreground orb (CATA_190h p0 crop
  // x=244..263/y=625..639: MAE 87.373, top-orb bright pixels 72 vs reference 151). UnityPy probe
  // `assets/frames/hand-hero-sig14/frame_recon.json` gives the backing RootObject/Mesh UberCardBack
  // `_ZWrite=1`, signature ribbon worldY=0.0972267, and Portrait_Mesh worldY=0.0052267. The game
  // gathers both renderers and orders by Renderer.sortingOrder/material.renderQueue
  // (`RenderCommandLists.cs:70-76,209-245`; opaque then transparent in `RenderToTextureUtils.cs:111-138`).
  // Offline draws the whole opaque backing mesh into shared zbuf before its separate portrait pass;
  // the old frame-wide depth bypass fixed the portrait window but incorrectly bypassed the closer ribbon too.
  // Keep backing-mesh color, omit only its depth write, and restore portrait depth testing: art passes
  // through the backing plane while the closer signature ribbon remains in front. The p0 ROI bright
  // mask now matches the reference exactly (151/151 pixels; 0 mismatches), while RGB MAE drops from
  // 87.373 to 10.260 and the lower two badge orbs remain unchanged (MAE 0.39 / 0.51).
  if (sigActive && slot === 'hand-hero-sig14') {
    const body = components.find(c => c.path === `${base.frameRecon.frame_root}/RootObject/Mesh`);
    if (!body) throw new Error(`${fixture.cardId}: frame14 backing mesh component missing`);
    for (const materialSlot of body.material_slots ?? []) materialSlot.write_depth = false;
  }

  // ---- 稀有度宝石材质序列化值（图集文件/滚动速度/缩放/强度）----
  // gems.ts renderRarityGemWrap 的常量（GenFX_RarityGems 图集、_XSpeed 5/_YSpeed 0.2、
  // _ScaleXY 1、_Intensity 1）即随从谱系材质的序列化值（hand-minion 探针实证）；佣兵本体帧
  // 的 RarityGem 是 Lettuce 专用材质（GenFX_RarityGems_Lettuce 图集 + 2/1 滚动速度）——
  // 逐帧从材质序列化值填充，缺省回落既有常数（其余帧材质值与常数相同，渲染逐位不变）。
  const rarityGemComp = components.find(c => c.node === 'RarityGem' && c.visible);
  const rarityGemMat = rarityGemComp
    ? findNode(base.frameRecon.hierarchy, rarityGemComp.path)?.renderers?.[0]?.materials?.[0] ?? null
    : null;
  const rarityGemMatSpec = rarityGemMat
    ? {
      tex_file:  rarityGemMat.tex?.['_MainTex']?.texture?.file ?? undefined,
      speed_xy:  [rarityGemMat.floats?.['_XSpeed'] ?? 5.0, rarityGemMat.floats?.['_YSpeed'] ?? 0.2],
      scale_xy:  [rarityGemMat.floats?.['_ScaleX'] ?? 1.0, rarityGemMat.floats?.['_ScaleY'] ?? 1.0],
      intensity: rarityGemMat.floats?.['_Intensity'] ?? 1.0,
    }
    : {};

  const plan: RenderPlan = {
    components,
    input:                           { dbf_id: String(fixture.dbfId), card_id: fixture.cardId },
    frame_center:                    frameCenter(base, keyByPath, slot, fixture.cardId, fixture.preset.premium, cardType),
    portrait_direct_material_output: goldenPortraitAvailable,
    portrait_skip_depth_test:        false,
    rarity_gem:                      {
      // 签名帧抑制既有稀有度宝石公式（普通帧的宝石位/图集不适用：Evergreen 宝石在框环
      // 大宝石位、四变体网格 + 云纹滚动 + 底影 = 04/05 票范围；变体网格 forcedHidden，
      // 残差记 findings 归因）。
      visible:      rarityVisible && !sigActive,
      atlas_offset: rarityVisible ? GEM_TEXTURE_OFFSET[rarityName] : undefined,
      tint_rgb:     rarityVisible ? GEM_COLOR[rarityName] : undefined,
      ...rarityGemMatSpec,
      // 佣兵本体帧：稀有度宝石在名牌名条之下（基准 LT23_816H 重导实证——名条下半压在
      // 宝石上半）。引擎里两者都在透明队列、按距离排序；本链宝石阶段排在帧光栅后，
      // 需显式深度测试才能复刻（rasterGemTri zs/zbuf；只对纳入帧光栅的 RarityGem 开）。
      depth_test:   slot === 'hand-mercenary' ? true : undefined,
    },
    gem:            { enabled: true, t: 0.07 },
    stat_gems:      statGems,
    texts,
    spell_overlays: spellOverlays.length ? spellOverlays : undefined,
    late_nodes:     lateNodes.length ? lateNodes : undefined,
  };
  return plan;
}

/** LETTUCE_MERCENARY_LEVEL DBF 表（30 行）的 TotalXpRequired 列，按等级序（1..30）。
 *  数据源 = 本机 dbf.unity3d 表 `LETTUCE_MERCENARY_LEVEL`（m_level/m_totalXpRequired；
 *  探针 = 本票 findings，与 extract_fixture_data.py 同库同表口径）。
 *  GetMercenaryLevelFromExperience（GameUtils.cs:3437-3464）逐级比对：experience <
 *  records[level i].TotalXpRequired → 返回 i-1；全不命中 → 满级 30。缺 tag = GetTag 0 →
 *  level 1（等级 1 的 TotalXpRequired = 0），与基准图 LT23_816H 的 "1" 一致。 */
const MERC_LEVEL_XP_REQUIRED = [
  0, 25, 60, 160, 300, 500, 800, 1350, 1900, 2500, 3300, 4200, 5300, 6500, 7900,
  9400, 11100, 13100, 15300, 17600, 20150, 23000, 26000, 29300, 32900, 36600,
  40700, 45100, 50000, 55000,
] as const;
const MERC_MAX_LEVEL = MERC_LEVEL_XP_REQUIRED.length;

/** GetMercenaryLevelFromExperience 对译（经验值 → 等级 1..30）。 */
function mercenaryLevelFromExperience(experience: number): number {
  const exp = Math.max(0, experience);
  for (let i = 1; i <= MERC_MAX_LEVEL; i++) {
    if (exp < MERC_LEVEL_XP_REQUIRED[i - 1]) return i - 1;
  }
  return MERC_MAX_LEVEL;
}

/** 佣兵本体帧的文本节点世界缩放补偿（渲染期 localScale × 该倍数）。
 *  背景：本链 UberText 移植对 name/attack/health/desc/race 与基准逐块吻合（race 白墨
 *  h33/w71 vs 基准 h32/w71 ✓），但 `LevelText` 明显偏小：节点自身 localScale=1.0、世界
 *  in-plane 0.5（父 `MercenaryLevelObject` 0.5），而基准按 **1.0** 渲染 —— 白墨扫描标定
 *  （基准 LT23_816H 2026-10-10 重导，'30' 字形）：mul 1.0→h13/w21、1.4→h19/w30、2.0→
 *  h27/w42 = 基准 h27/w42 逐项吻合。容器 0.5 是真实作者缩放（兄弟 `MercenaryXPBar` 自身
 *  scale 11.8×0.5=5.9 与实测条宽吻合），故差异在「引擎 UberText 排版字号与节点缩放换算」
 *  环节（机制未定，登记 findings §12.8）。补偿值按基准反推（唯一非推导常数，同 desc/cost
 *  校准先例）。 */
const MERC_TEXT_SCALE_MUL: Record<string, number> = { level: 2.0, race: 0.95 };

/** 帧层级里按路径后缀找节点，返回其世界矩阵（找不到返回 null）。 */
function findFrameNodeWorld(
  base: AssetPack,
  keyByPath: Map<string, string>,
  endsWith: string,
): { path: string, world: number[][] } | null {
  const path = [...keyByPath.keys()].find(p => p.endsWith(endsWith) || p === endsWith);
  const node = path ? findNode(base.frameRecon.hierarchy, path) as { world?: number[][] } | null : null;
  return path && node?.world ? { path, world: node.world } : null;
}

// ---- 取景锚（frame_center）----
// exporter FrameCamera 以主体网格世界包围盒中心取景，基准图随之带每帧型常数平移；TS 复刻该
// 口径 = L2 逐位对齐的取景前提（量化/对账/根因：explore/2026-10-06-l2-offset/findings.md）。

/** 适用面 = 手牌帧槽 ∧ 帧原生卡型。用户 2026-10-06 裁定先对齐五大
 *  基本类别，2026-10-08 扩至异象/饰品/英雄技能三帧，2026-10-10 扩至佣兵技能帧
 *  （修正本文件旧注释「佣兵保持原点取景」的假设：TryGetActorFrameBounds 对**任意**
 *  enabled FrameMesh 锚定、无卡型门控，BigCard_LettuceAbility 有 enabled FrameMesh
 *  （ExporterController.cs:11478-11544），故 LT23 基准同为 FrameMesh 锚——锚预测
 *  (x,z)=(−0.0118,−0.0824)，与基准对账见 ticket 01）。金/钻/异画基准换用自家帧网格
 *  导出（取景锚随网格不同）、宠物基准导出时对 FrameCamera 后处理偏移
 *  （ExporterController.cs:7379）——这两类不进本表。 */
const MESH_ANCHORED_SLOTS = new Set([
  'hand-minion', 'hand-minion-golden', 'hand-spell', 'hand-spell-golden',
  'hand-hero', 'hand-hero-golden', 'hand-weapon', 'hand-weapon-golden',
  'hand-location', 'hand-location-golden',
  'hand-heropower', 'hand-bg-anomaly', 'hand-bg-trinket',
  'hand-lettuce-ability', 'hand-lettuce-ability-minion',
  'hand-lettuce-equipment',
  // 佣兵本体（Card_Hand_Mercenary）：无 FrameMesh 节点 → exporter 回落
  // Actor.GetMeshRenderer() = RootObject/Mesh（TryGetActorFrameBounds，:11552-11555）；
  // 锚预测 = 该网格世界包围盒中心 (x,z)=(0,−0.0530) → 相对原点取景 (0,+10.2)px
  // （基准对账：L2 与 XP 条/宝石/文本位置逐项吻合，见 findings）。
  'hand-mercenary',
  // 签名帧（T3）：premium 基准 = premium actor 自家帧网格导出（取景锚随网格不同，
  // 本表头注释既载）；sig9 无 FrameMesh → Mesh 回落支（RootObject/Mesh 三子网格
  // 整体 AABB，与 exporter GetMeshRenderer 口径一致）。
  'hand-minion-sig9',
  // T11 新签名帧按自身 enabled RootObject/Mesh 锚定。UnityPy 世界 AABB 中心 z：
  // frame11=+0.05852、frame13=+0.00506、frame14=+0.07128；findings §15.2。
  'hand-hero-sig11', 'hand-location-sig13', 'hand-hero-sig14',
]);

/** exporter 取景中心 = 主体网格世界包围盒中心（TryGetActorFrameBounds，
 *  ExporterController.cs:11483-11549）：先找**层级激活且 renderer 启用**的 FrameMesh
 *  （FindEnabledMeshRendererByName；hand-bg-trinket 饰品框、hand-heropower 英雄技能框
 *  走此支；hand-spell 的 BG_TrinketMesh/FrameMesh 序列化失活 → 被排除、回落 Mesh 支，
 *  10-06 已验证的 25 张卡口径不变），找不到回落 Actor.GetMeshRenderer() = "Mesh" 渲染器
 *  （RootObject[/NonQuestObjects]/Mesh）。英雄技能特例（heroPowerFrameAnchor，
 *  :11510-11518）：2026-09-25 更新把 normal 帧 FrameMesh 换短（zCenter −0.10）而
 *  premium 帧仍是装饰高框（zCenter +0.07），逐帧取自身中心会让两变体差 ~33px——
 *  修法 = 取景中心 z 钉在 FrameMesh 世界包围盒 min.z + 3.18/2（装饰框半高，两帧底边
 *  一致 → 恒 +0.07/+0.08，与更新前导出库对齐）。世界包围盒 = 局部包围盒 8 角 × 节点
 *  世界矩阵（Unity renderer.bounds 语义；轴对齐矩阵下与仅变换中心点逐位一致）。
 *  预测 vs 基准实测偏移对账残差 ≤0.3px（explore/2026-10-07-edge-align，资产只存
 *  verts、引擎用 float32 AABB，残差在同批已验证帧型的 ≤0.2px 噪声内）。不适用/
 *  找不到 → undefined（= 原点锚，渲染行为与既有链逐位一致）。 */
function frameCenter(
  base: AssetPack,
  keyByPath: Map<string, string>,
  slot: string,
  cardId: string,
  premium: string,
  cardType: number,
): [number, number] | undefined {
  // premium 门：金卡与异画签名帧只在各自帧槽上放行；其它 premium 回落普通帧时保持原点。
  if (!MESH_ANCHORED_SLOTS.has(slot)) return undefined;
  if (premium !== 'NORMAL'
    && !(premium === 'SIGNATURE' && isSignatureSlot(slot))
    && !(premium === 'GOLDEN' && isGoldenSlot(slot))) return undefined;
  if (!SLOT_NATIVE_CARD_TYPES[slot]?.includes(cardType)) return undefined;

  const enabled = (path: string): boolean => {
    const n = findNode(base.frameRecon.hierarchy, path) as
      | { world?: number[][]; mesh_stats?: unknown; active_in_hierarchy?: boolean;
        renderers?: { enabled?: boolean }[]; }
        | null;
    return !!n?.world && !!n.mesh_stats && n.active_in_hierarchy === true
      && n.renderers?.[0]?.enabled === true;
  };
  // FrameMesh 优先；回落 "Mesh"（depth 3 或 NonQuestObjects 下 depth 4，同 10-06 口径）
  const frameMeshPath = [...keyByPath.keys()].find(p => p.endsWith('/FrameMesh') && enabled(p));
  const bodyPath = frameMeshPath ?? [...keyByPath.keys()].find(p => {
    const parts = p.split('/');
    const n = parts.length;
    return parts[n - 1] === 'Mesh' && (n === 3 || (n === 4 && parts[2] === 'NonQuestObjects'));
  });
  if (!bodyPath) return undefined;
  const node = findNode(base.frameRecon.hierarchy, bodyPath) as
    { world?: number[][], local?: { pos?: number[] } | null } | null;
  const mesh = node?.world ? base.meshes[keyByPath.get(bodyPath)!] : undefined;
  if (!mesh?.verts.length) return undefined;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [vx, vy, vz] of mesh.verts) {
    if (vx < x0) x0 = vx;
    if (vx > x1) x1 = vx;
    if (vy < y0) y0 = vy;
    if (vy > y1) y1 = vy;
    if (vz < z0) z0 = vz;
    if (vz > z1) z1 = vz;
  }
  // 世界 AABB（8 角 × M）
  const M = node!.world!;
  let wx0 = Infinity, wx1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
  for (const cx of [x0, x1]) {
    for (const cy of [y0, y1]) {
      for (const cz of [z0, z1]) {
        const wx = M[0][0] * cx + M[0][1] * cy + M[0][2] * cz + M[0][3];
        const wz = M[2][0] * cx + M[2][1] * cy + M[2][2] * cz + M[2][3];
        if (wx < wx0) wx0 = wx;
        if (wx > wx1) wx1 = wx;
        if (wz < wz0) wz0 = wz;
        if (wz > wz1) wz1 = wz;
      }
    }
  }
  const anchorX = (wx0 + wx1) / 2;
  let anchorZ = (wz0 + wz1) / 2;
  // heroPowerFrameAnchor：英雄技能取景中心 z = FrameMesh 世界包围盒 min.z + 装饰框半高
  if (frameMeshPath && cardType === 10) anchorZ = wz0 + 3.18 / 2;

  // 地标底图的节点摆位会带着整张离线卡面左下移；游戏按 actor 根定位结构件，不按 Mesh bounds 取景。
  // 与 exporter 一致，仅当 Mesh world bounds center≈其 localPosition (X/Z, <0.01) 时回到根锚；
  // 已由几何补偿的帧仍使用 bounds 锚。证据：ExporterController.cs:11675-11689；当前普通/金卡帧
  // assets/frames/hand-location{,-golden}/frame_recon.json 的 RootObject/Mesh 都满足该判据，
  // 而 JAIL_887 旧白名单遗漏导致参考图与 TS 输出相差约 6×12px。
  const locationLocalPosition = node?.local?.pos;
  if (!frameMeshPath && slot.startsWith('hand-location')
    && locationLocalPosition && locationLocalPosition.length >= 3
    && Math.abs(anchorX - locationLocalPosition[0]!) < 0.01
    && Math.abs(anchorZ - locationLocalPosition[2]!) < 0.01) {
    return undefined;
  }

  return [anchorX, anchorZ];
}

/** 帧自己的 Gem_Mana 世界平移（铸币原位替换的锚点；UpdateManaGemComponent 语义）。
 *  找不到时返回 undefined（调用方不锚定，按预制序列化位姿渲染）。 */
function frameGemWorldPos(base: AssetPack, keyByPath: Map<string, string>): number[] | undefined {
  const node = findFrameNodeWorld(base, keyByPath, '/Gem_Mana');
  if (!node) return undefined;
  return [node.world[0][3], node.world[1][3], node.world[2][3]];
}

/** alternate-cost 文本位的世界坐标：CostUberText 节点世界矩阵 × 替换 localPosition =
 *  m_alternateCostTextLocalPos（Actor.cs:562 默认 (-0.01,0.003,-0.58)；帧未序列化覆盖）。
 *  hand-spell 帧实测 = (-0.8419, 0.153, 0.6306) → 屏幕 (107,242)，等级徽章位 (110,127) 正下方。 */
function altCostWorldPos(
  base: AssetPack,
  refs: Record<string, { node?: string }>,
  keyByPath: Map<string, string>,
): number[] {
  void refs;
  const suffix = base.frameManifest?.role_paths?.cost ?? '∅';
  const node = findFrameNodeWorld(base, keyByPath, suffix);
  const ub = base.ubertext?.nodes.find(n => n.path.endsWith(suffix));
  if (!node || !ub) return ALT_COST_WORLD_HAND_SPELL.slice(); // hand-spell 帧实测值（解析失败的兜底）
  const mul = (A: number[][], B: number[][]): number[][] => A.map(r =>
    B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j] + (r[3] ?? 0) * (B[3]?.[j] ?? 0)));
  const [px, py, pz] = ub.localPosition ?? [0, 0, 0];
  const [rx, ry, rz, rw] = ub.localRotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = ub.localScale ?? [1, 1, 1];
  const R: number[][] = [
    [1 - 2 * (ry * ry + rz * rz), 2 * (rx * ry - rz * rw), 2 * (rx * rz + ry * rw)],
    [2 * (rx * ry + rz * rw), 1 - 2 * (rx * rx + rz * rz), 2 * (ry * rz - rx * rw)],
    [2 * (rx * rz - ry * rw), 2 * (ry * rz + rx * rw), 1 - 2 * (rx * rx + ry * ry)],
  ];
  const L: number[][] = [
    [R[0][0] * sx, R[0][1] * sy, R[0][2] * sz, px],
    [R[1][0] * sx, R[1][1] * sy, R[1][2] * sz, py],
    [R[2][0] * sx, R[2][1] * sy, R[2][2] * sz, pz],
    [0, 0, 0, 1],
  ];
  const inv = (M: number[][]): number[][] => {
    const a = M.map(r => [...r]);
    const invm = Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => (i === j ? 1 : 0)));
    for (let col = 0; col < 4; col++) {
      let piv = col;
      for (let r = col + 1; r < 4; r++) {
        if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
      }
      const t1 = a[col];
      a[col] = a[piv];
      a[piv] = t1;
      const t2 = invm[col];
      invm[col] = invm[piv];
      invm[piv] = t2;
      const d = a[col][col];
      for (let j = 0; j < 4; j++) {
        a[col][j] /= d;
        invm[col][j] /= d;
      }
      for (let r = 0; r < 4; r++) {
        if (r === col) continue;
        const f = a[r][col];
        for (let j = 0; j < 4; j++) {
          a[r][j] -= f * a[col][j];
          invm[r][j] -= f * invm[col][j];
        }
      }
    }
    return invm;
  };
  const parentWorld = mul(node.world, inv(L));
  const ALT: number[][] = [[1, 0, 0, -0.01], [0, 1, 0, 0.003], [0, 0, 1, -0.58], [0, 0, 0, 1]];
  const W = mul(parentWorld, ALT);
  return [W[0][3], W[1][3], W[2][3]];
}

/** 按 prefab_report 的材质槽名/shader + 计划最终纹理，标注 opaque-edge 修复与乘法混合（见各 needs* 说明）。
 *  findRecon：path → frame_recon 节点（ColorAsAlpha 的 _Intensity/_AlphaIntensity 序列化在
 *  recon 材质 floats 里，report 槽位只有 name/shader/textures）。 */
function markOpaqueEdgeSlots(
  components: PlanComponent[],
  reportNodes: PrefabReport['nodes'],
  findRecon: (path: string) => { renderers?: { materials?: (FrameMaterial | null)[] }[] } | null,
): void {
  const byPath = new Map(reportNodes.map(n => [n.path, n]));
  for (const comp of components) {
    for (const slot of comp.material_slots ?? []) {
      const rep = byPath.get(comp.path)?.components.renderer?.material_slots?.find(s => s.slot === slot.slot);
      slot.opaque = needsOpaqueEdgeRepair(
        comp.node,
        rep?.name,
        slot._MainTex_runtime?.file ?? rep?.textures?.['_MainTex']?.name,
      ) || undefined;
      // 乘法混合材质（Hero/Multiply/*）：精英银龙影、符文底影、多职业绶带影、地标费用宝石投影。
      // 游戏 FS 输出 rgb=_MainTex.rgb+COLOR0.rgb、a=0，VS 的 COLOR0=顶点色×_Color；离线链若按
      // alpha-over 画会涂成不透明黑（TLC_433 右上角被银龙影啃掉一块）。
      if (typeof rep?.shader === 'string' && rep.shader.startsWith('Hero/Multiply/')) {
        slot.blend = 'multiply';
      }
      // ColorAsAlpha 阴影材质（Effects/FX_Transparent_ColorAsAlpha，卡影 CardShadow_*）：
      // FS 反编译（Effects_FX_Transparent_ColorAsAlpha_FS.metal）a = dot((.3,.59,.11),
      // tex.rgb)×_AlphaIntensity、rgb = tex.rgb×_Color.rgb、整体 ×_Intensity——黑影、
      // 亮度即透明度。战棋饰品帧基准带整卡外圈投影（94k 半透明像素，2026-10-08 对账）。
      if (typeof rep?.shader === 'string' && rep.shader.startsWith('Effects/FX_Transparent_ColorAsAlpha')) {
        slot.blend = 'colorAsAlpha';
        const reconMat = findRecon(comp.path)?.renderers?.[0]?.materials?.[slot.slot] ?? null;
        slot.color_as_alpha = {
          color:           (reconMat?.colors?.['_Color'] ?? [0, 0, 0]).slice(0, 3),
          intensity:       reconMat?.floats?.['_Intensity'] ?? 1,
          alpha_intensity: reconMat?.floats?.['_AlphaIntensity'] ?? 1,
        };
      }
    }
  }
}

// ============================================================================
// DK 符文横幅（CardRuneBanner 运行时激活对译；2026-10-05，参照 Angelia dk-runes /
// rune-display / rune-samples 三实验的已验证链）
// ============================================================================
// 数据源：三独立 tag（非 bitmask）COST_BLOOD/FROST/UNHOLY = 2196/2197/2198（game_tag.csv；
// ETC_210 实测三值各 1）。EntityBase.cs:93 HasRuneCost = 血+冰+邪 > 0；
// Actor.cs:6116-6133 UpdateCardRuneBannerComponent 对非符文卡 m_cardRuneBanner.Hide()
// （本链默认态：holder/shadow 在 STATIC_HIDDEN、三布局子树 prefab 序列化失活——双兜底），
// HasRuneCost 才 Show(pattern)。
//
// Show 形态（CardRuneBanner.cs:21-50 + RuneSlotVisual.cs:47-85 + Rune.cs:104-126）：
//   布局 = CombinedValue 1/2/3 → OneRune/TwoRunes/ThreeRunes（switch CardRuneBanner.cs:27-40）；
//   槽 GO 名 = prefab m_deckRuneSlots 实测（rune-samples §3 关账 dk-runes §6.3 缺口 3）：
//   OneRune=Resource_Rune（无序号）、TwoRunes=(1)(2)、ThreeRunes=(3)(4)(5)；
//   填色序 = [BLOOD×b, FROST×f, UNHOLY×u] 从左往右（RunePattern.cs:6-11 ValidRuneTypes
//   顺序展开 + RuneSlotVisual.cs:68-85 槽序填充；与槽位序列绑定无关）；
//   图标材质 = Rune_{type}_sm：_MainTex=CardRunes_DeathKnight_sm（essential_base_global-
//   texture-1 pid -7217558262942142559，与帧 prefab 占位引用的基础版同名异对象——基础版
//   带符文图形、_sm 是无符号宝石面，ref 图标内容实证；提取 scripts/extract_rune_textures.py），
//   ST scale (0.5,0.5)、offset 血(0,.5)/冰(.5,.5)/邪(0,0)（prefab Rune MB m_runeAssetTable
//   序列化实测，dk-runes findings §2）。
// 底座 = m_runeBannerBackground=Card_Hand_Deathknight_Banner SetActive(true)
// （CardRuneBanner.cs:45-48）：RuneHolder_Mesh（RuneBanner_Card；底座不随布局变形，
// rune-samples §4 holder 足迹三布局同值）+ RuneHolder_Shadow_Mesh（RuneBanner_Card_Shadow_Mat，
// Hero/Multiply/ → markOpaqueEdgeSlots 按乘法混合标注）。
// 阴影混合：阴影 shader PS `add o0.rgb = tex + COLOR`（COLOR0=顶点色×_Color，_Color=(0,0,0,1)
// → 0）、blend DstColor/Zero → final = dst.rgb × tex.rgb（rune-display 反汇编定案，关闭
// dk-runes §6.2 缺口 2）；本链 multiply 分支公式 dst*(tex+_Color) 在 _Color 黑时恒同语义——
// 无需 Angelia 的 _tint_rgb 白修正（那是修它自家 rgb=tex×tint 公式把黑乘进因子的 bug，本链无）。
// 图标 opaque 豁免：Hero/Unlit_Transparent = SrcAlpha/OneMinusSrcAlpha + _Cutoff 0.9
// （dk-runes shader pass dump），_sm 图集 alpha 近二值镂空（宝石面仅 ~37% 象限）——须按 alpha
// 镂空画；exporter 的 opaque-edge 名单修复只补导出 PNG 的 alpha 通道（repair RT 上镂空区
// 无几何写入、不补），按不透明画整张 quad 会把透明角涂成垃圾 RGB。
// 残差登记：① 引擎采样 MIP_POINT bias −0.5（mip-sampler 定案；rune-display bias 诊断极小
// −0.75 差 0.09，浅谷族），本链无 mip 设施按 L0 双线性——图标偏锐；是否引入 mip 属架构
// 决策（Angelia 全链 mip 补丁后仍有 mae_icon 0.86–3.12/槽 同族余量），未做。
// ② 异画/钻石等 premium 卡（GDB_477/RLK_706/WW_373/TLC_433/TTN_850）的参考图用 premium
// actor 导出，其 RuneBanner 连同框体整体比本链回落普通帧的几何偏上右 ~10px——premium 帧
// 族未移植（five-cardtypes §6 已知边界）的既有家族，非符文管线误差（ETC_210 普通 premium
// 亚像素吻合；槽位投影与 Angelia 引擎 blob ≤0.5px 互证）。

const RUNE_TAG = { BLOOD: 2196, FROST: 2197, UNHOLY: 2198 } as const;
type RuneType = keyof typeof RUNE_TAG;

/** Rune_*_sm 材质图集偏移/缩放（prefab Rune MB m_runeAssetTable 序列化实测）。 */
const RUNE_ATLAS_OFFSET: Record<RuneType, [number, number]> = {
  BLOOD: [0.0, 0.5], FROST: [0.5, 0.5], UNHOLY: [0.0, 0.0],
};
const RUNE_ATLAS_SCALE: [number, number] = [0.5, 0.5];

/** CombinedValue → 布局节点/槽 GO 名（CardRuneBanner.cs:27-40 switch × prefab
 * m_deckRuneSlots 实测；rune-samples §3 + rune-display LAYOUT_SLOTS 正典表）。 */
const RUNE_LAYOUTS: Record<number, { layout: string, slots: string[] }> = {
  1: { layout: 'OneRune', slots: ['Resource_Rune'] },
  2: { layout: 'TwoRunes', slots: ['Resource_Rune (1)', 'Resource_Rune (2)'] },
  3: { layout: 'ThreeRunes', slots: ['Resource_Rune (3)', 'Resource_Rune (4)', 'Resource_Rune (5)'] },
};

const RUNE_SM_TEX = 'textures/CardRunes_DeathKnight_sm.png';

/** 符文横幅 delta（tags 2196/2197/2198 → 节点显隐 + 图标材质覆写）。非符文卡零操作
 * （默认隐藏态 = 引擎 Hide() 路径）。帧间 RuneBanner 子树同构，按路径后缀匹配。 */
function compileRuneBanner(components: PlanComponent[], tags: Record<string, number>): void {
  const blood = tags[RUNE_TAG.BLOOD] ?? 0;
  const frost = tags[RUNE_TAG.FROST] ?? 0;
  const unholy = tags[RUNE_TAG.UNHOLY] ?? 0;
  const combined = blood + frost + unholy;
  // HasRuneCost（EntityBase.cs:93）+ Show 的 switch default：CombinedValue ∉ 1..3 时
  // Show 直接 return（CardRuneBanner.cs:26 `default: return;`）——容器/底座都不激活
  if (combined <= 0 || combined > 3) return;

  const bySuffix = (suffix: string): PlanComponent | undefined =>
    components.find(c => c.path.endsWith(suffix));
  // 底座：CardRuneBanner.cs:45-48 m_runeBannerBackground SetActive(true)
  for (const node of ['RuneHolder_Mesh', 'RuneHolder_Shadow_Mesh']) {
    const comp = bySuffix(`RuneBanner/Card_Hand_Deathknight_Banner/${node}`);
    if (comp) comp.visible = true;
  }

  // 布局与填色（CardRuneBanner.cs:28-39 m_runeSlotVisuals[combined-1].Show；RuneSlotVisual.cs:47-85）
  const { layout, slots } = RUNE_LAYOUTS[combined];
  const seq = Object.entries({ BLOOD: blood, FROST: frost, UNHOLY: unholy } as const)
    .flatMap(([rt, n]) => Array<RuneType>(n).fill(rt as RuneType));
  for (let i = 0; i < seq.length; i++) {
    const comp = bySuffix(`RuneBanner/RuneLayouts/${layout}/${slots[i]}/Rune`);
    if (!comp) continue;
    // 运行时激活（CardRuneBanner.Show → SetActive）：序列化失活节点的 visible 与 raster 一并翻回
    // （dk-runes findings §5.2 勘误）
    comp.visible = true;
    comp.raster = true;
    const slot = comp.material_slots?.[0];
    if (slot) {
      // Rune.ShowRune（Rune.cs:104-126）：Default 态材质 = Rune_{type}_sm（整材质替换语义
      // ——纹理与 ST 一并换，序列化 Rune_Blood 占位的偏移不生效）
      slot._MainTex_runtime = { file: RUNE_SM_TEX };
      slot.material_override = {
        '_MainTex.offset': [...RUNE_ATLAS_OFFSET[seq[i]]],
        '_MainTex.scale':  [...RUNE_ATLAS_SCALE],
      };
      // 图标按 alpha 镂空画（Hero/Unlit_Transparent；见块注「图标 opaque 豁免」），
      // 清掉 needsOpaqueEdgeRepair 对 Rune_/CardRunes 名单的命中
      slot.opaque = undefined;
    }
  }
}

// ============================================================================
// 手牌横幅：可交易/锻造/准备（DeckActionBanner）+ 阵营（HearthstoneFactionBanner）
// + 多职业绶带（MulticlassRibbon）（2026-10-05，探针 explore/2026-10-05-banner-recon）
// ============================================================================
// 数据源与激活语义（反编译出处）：
// - 刷新链 Actor.UpdateAllComponents（Actor.cs:1993）→ UpdateMeshComponents（4877-4889）。
// - Actor.UpdateCardColor（6304-6452，6418-6445）：deck-action 三容器 SetActive 后按
//   else-if 链互斥实例化（tradeable→forge→prepare，同一锚位）；判定 = HasTag
//   （TRADEABLE=1720 / FORGE=2785 / PREPARE=4354，EntityBase.cs:1282-1300，GAME_TAG.cs:826-830）。
//   阵营容器 HasHearthstoneFaction（VALID_FACTIONS 优先序 Actor.cs:205-213：GRIMY_GOONS 482 >
//   KABAL 484 > JADE_LOTUS 483 > ZERG 3457 > TERRAN 3458 > PROTOSS 3469）→ SetFactionType
//   (premium, GetFactionColorTypeForTag)（CardColorSwitcher.cs:199-212 → FactionColorType 1..6）。
// - Actor.UpdateMulticlassRibbon（Actor.cs:6027-6034）：GetClasses().Count > 2 才 SetActive；
//   GetClasses = MULTIPLE_CLASSES=476 位掩码逐位展开（bit1→TAG_CLASS 1，EntityBase.cs:1087-1110），
//   为 0 时取 CLASS（=1 类）。双职业（2 类）只换框体材质（CardColorSwitcher *_DUALCLASS，
//   走既有类色图集链），不显绶带。
// - 几何/材质 = 提取期合并的嵌套 prefab 子树（scripts/extract_banner_assets.py；激活语义
//   NestedPrefabBase.cs:86-96：容器下 localPosition 置零、保留 prefab 根 rot/scale）。
//   合并节点全部 active_in_hierarchy=false（容器序列化失活），本函数按 tag 翻 visible（符文横幅同模式）。
// 材质语义（探针实测 + L2 参考佐证）：
// - 主 quad（Tradeable/Forgeable/Prepare_Banner、Faction_Banner、Multiclass_Ribbon，
//   Hero/Unlit/Unlit_Texture）序列化 _Color=(1,0,0,1) 而游戏内为棕褐贴图本色——该 shader 不把
//   _Color.rgb 乘进基色；离线链 alpha 分支乘 tint.rgb 会染红 → _tint_rgb 白中和（仅基色，
//   alpha 仍取贴图）。
// - 阴影 quad（*_shadow，Hero/Multiply/Multiply）序列化 _Color≈0.1038 参与 dst*(tex+_Color)
//   （raster multiply 分支既有语义），保持序列化值不中和。
// - 阵营图标 = Faction_Icons 4×4 图集象限（材质 _MainTex ST，tables.factionIconSt），运行时
//   整体换材质（CardColorSwitcher.GetMaterialIcon）；绶带底板按阵营换贴图（帮派=Faction_Banner
//   贴图、星际=Faction_Banner_Starcraft，row.banner）。
// - 绶带普通版阴影 ST（scale 0.53/0.48、offset −0.53/−0.048）采样越过 [0,1] 边界：引擎
//   _MainTex wrap=repeat，raster 缺省 clamp → 该槽标 wrap_repeat 逐像素 fract。
// 残差登记：① SC_004（ZERG+4 类）L2 的 faction icon/banner 使用 normal 静态象限，游戏
//   signature material 为 FX 滚动材质，见上方 faction 注释；② Glow_Green/Blue 拖拽高亮
//   （Custom/Selection/Highlight，renderer 序列化 enabled=false）默认态不渲染，未移植；
//   ③ 英雄通用帧无 deck-action 容器字段（Actor 序列化即无）——英雄不可能显示可交易/锻造横幅，
//   与引擎一致。

const BANNER_TAG = {
  TRADEABLE:        1720, FORGE:            2785, PREPARE:          4354,
  GRIMY_GOONS:      482, KABAL:            484, JADE_LOTUS:       483,
  ZERG:             3457, TERRAN:           3458, PROTOSS:          3469, MULTIPLE_CLASSES: 476,
} as const;

/** 阵营 tag → FactionColorType 下标（CardColorSwitcher.cs:56-65），按 VALID_FACTIONS 优先序。 */
const FACTION_PRIORITY: [number, number][] = [
  [BANNER_TAG.GRIMY_GOONS, 1], [BANNER_TAG.KABAL, 2], [BANNER_TAG.JADE_LOTUS, 3],
  [BANNER_TAG.ZERG, 4], [BANNER_TAG.TERRAN, 5], [BANNER_TAG.PROTOSS, 6],
];

/** deck-action 容器节点名（Actor m_*BannerContainer → 容器 GO；hand-location 的锻造容器
 *  拼写变体 ForgeBannerContainer）。顺序 = Actor.cs:6431-6445 else-if 互斥序。 */
const DECK_CONTAINERS: [number, string[]][] = [
  [BANNER_TAG.TRADEABLE, ['TradableBannerContainer']],
  [BANNER_TAG.FORGE, ['ForgeableBannerContainer', 'ForgeBannerContainer']],
  [BANNER_TAG.PREPARE, ['PrepareableBannerContainer']],
];

/** 拖拽高亮（默认不渲染，见块注残差③）。 */
const BANNER_GLOW_NODES = new Set(['Glow_Green', 'Glow_Blue']);

/** 主 quad（基色不乘 _Color，见块注）的节点名 → _tint_rgb 白中和。
 * Signature ribbon uses the sibling node `Multiclass_Ribbon_Signature_mesh` with the same
 * Hero/Unlit/Unlit_Texture material serialized as `_Color=(1,0,0,1)`; frame_recon probes for
 * signature frames 11/14 confirm this material. It needs the same neutral override as normal or
 * the correct signature mesh renders red instead of the reference's brown/cream emblem. */
const BANNER_TINT_NEUTRAL_NODES = new Set([
  'Tradeable_Banner_mesh', 'Forgeable_Banner_mesh', 'Prepareable_Banner_mesh',
  'Faction_Banner', 'Multiclass_Ribbon_mesh', 'Multiclass_Ribbon_Signature_mesh',
]);

/** EntityBase.GetClasses（EntityBase.cs:1087-1110）：位掩码逐位计数；为 0 取 CLASS（≠INVALID → 1 类）。 */
function bannerClassCount(tags: Record<string, number>): number {
  const mask = tags[BANNER_TAG.MULTIPLE_CLASSES] ?? 0;
  if (mask) {
    let n = 0;
    for (let m = mask; m > 0; m >>= 1) n += m & 1;
    return n;
  }
  return (tags[TAG.CLASS] ?? 0) !== 0 ? 1 : 0;
}

/** 激活容器名下合并子树的全部组件（嵌套 prefab 提取期合并，见块注）；Glow 与死槽排除。 */
function activateBannerSubtree(components: PlanComponent[], container: string, skipDeadSlot?: string): boolean {
  const seg = `/${container}/`;
  let hit = false;
  for (const c of components) {
    if (!c.path.includes(seg)) continue;
    hit = true;
    const name = c.node ?? '';
    if (BANNER_GLOW_NODES.has(name) || (skipDeadSlot && c.path.includes(`/${skipDeadSlot}`))) {
      c.visible = false;
      continue;
    }
    c.visible = true;
  }
  return hit;
}

/** 手牌横幅 delta（tags → 容器子树显隐 + 运行时材质覆写）。无横幅 tag 的卡零操作。 */
function compileBanners(
  components: PlanComponent[],
  tags: Record<string, number>,
  tables: StaticTables,
  hierarchy: AssetPack['frameRecon']['hierarchy'],
): void {
  // deck-action else-if 链（Actor.cs:6431-6445）：tradeable > forge > prepare，至多一个。
  let deckShown = false;
  for (const [tag, containers] of DECK_CONTAINERS) {
    if (deckShown || (tags[tag] ?? 0) === 0) continue;
    for (const container of containers) {
      if (activateBannerSubtree(components, container)) {
        deckShown = true;
        break;
      }
    }
  }

  // 阵营横幅（HasHearthstoneFaction → FactionColorType；SetFactionType 换图标/底板材质）。
  // 2026-10-26 工单 08：2026-10-05 裁定只管 faction banner 的静态图标选择，不代表 SIGNATURE
  // 帧族仍按 NORMAL 渲染。帧族延后实现的历史结论见 five-cardtypes findings §6，已被
  // 2026-10-25 用户确认的 signature-frames spec 与阶段 A 移植取代（signature findings §14）；
  // 此处的 banner 规则仍生效：材质取 normal 表（有静态图标象限），游戏签名材质为 FX 滚动
  // （Unlit_TransparentTexAlpha2uvScroll，无静态象限），其近似残差仍单独记录。
  let factionIdx = 0;
  for (const [tag, idx] of FACTION_PRIORITY) {
    if ((tags[tag] ?? 0) !== 0) {
      factionIdx = idx;
      break;
    }
  }
  if (factionIdx > 0) {
    // Faction_Banner_mesh 是 prefab 里的失活遗留槽（probe dump），激活时排除
    activateBannerSubtree(components, 'FactionBannerContainer', 'Faction_Banner_mesh');
    const st = tables.factionIconSt?.['normal']?.[factionIdx];
    if (st?.file) {
      const icon = components.find(c => c.visible && c.node === 'Faction_Icon');
      const iconSlot = icon?.material_slots?.[0];
      if (iconSlot) {
        iconSlot._MainTex_runtime = { file: st.file };
        iconSlot.material_override = {
          ...iconSlot.material_override,
          '_MainTex.offset': st.offset ?? [0, 0],
          '_MainTex.scale':  st.scale ?? [1, 1],
        };
      }
      const bannerTex = st.banner?.file;
      const banner = components.find(c => c.visible && c.node === 'Faction_Banner');
      const bannerSlot = banner?.material_slots?.[0];
      if (bannerSlot && bannerTex) {
        bannerSlot._MainTex_runtime = { file: bannerTex };
      }
    }
  }

  // 多职业绶带（UpdateMulticlassRibbon：classes.Count > 2）。游戏只激活 MulticlassRibbon
  // 容器（Actor.cs:6027-6034），容器内 normal/signature 子网格由 prefab 的 activeSelf 选变体。
  // frame11/14 的 probe（assets/frames/hand-hero-sig{11,14}/frame_recon.json）显示普通
  // Multiclass_Ribbon_mesh.active_self=false、Multiclass_Ribbon_Signature_mesh.active_self=true；
  // 旧离线逻辑无视这组状态，强制显示普通网格，导致两张异画基准的多职业徽记倾斜/形状错误。
  // 隔离的 prefab 子树在提取后 active_in_hierarchy 全为 false，故这里重建父容器激活，并按
  // 变体根节点 active_self 恢复 Unity 实际会显示的一个网格。
  if (bannerClassCount(tags) > 2) {
    for (const c of components) {
      if (!c.path.includes('/Multiclass_Ribbon/') && !c.path.includes('/MulticlassRibbon/')) continue;
      if (BANNER_GLOW_NODES.has(c.node ?? '')) continue;
      const variant = c.path.includes('/Multiclass_Ribbon_Signature_mesh')
        ? '/Multiclass_Ribbon_Signature_mesh'
        : c.path.includes('/Multiclass_Ribbon_mesh') ? '/Multiclass_Ribbon_mesh' : null;
      if (!variant) continue;
      const variantRoot = c.path.slice(0, c.path.indexOf(variant) + variant.length);
      const activeSelf = findNode(hierarchy, variantRoot) as { active_self?: boolean } | null;
      c.visible = activeSelf?.active_self ?? !variant.includes('Signature');
    }
    // 绶带阴影 repeat wrap（材质 ST 越界；见块注）。序列化 GO 名带尾随空格
    // （"Multiclass_Ribbon_Shadow_mesh "，帧预制原样）——精确等值会 miss，
    // wrap 缺失时 ST (0.53,0.48)/(−0.53,−0.048) 被 clamp 拉出边缘条纹。
    const shadow = components.find(c => c.visible && c.node?.trim() === 'Multiclass_Ribbon_Shadow_mesh');
    const shadowSlot = shadow?.material_slots?.[0];
    if (shadowSlot) shadowSlot.wrap_repeat = true;
  }

  // 主 quad 基色白中和（Hero/Unlit/Unlit_Texture 不乘 _Color；见块注材质语义）
  for (const c of components) {
    if (!c.visible || !BANNER_TINT_NEUTRAL_NODES.has(c.node ?? '')) continue;
    for (const s of c.material_slots ?? []) {
      s.material_override = { ...s.material_override, _tint_rgb: [1, 1, 1] };
    }
  }
}

function findNode(hierarchy: unknown, path: string): { renderers?: { materials?: (FrameMaterial | null)[] }[] } | null {
  const h = hierarchy as { path?: string, renderers?: unknown[], children?: unknown[] };
  if (h.path === path) return h as never;
  for (const c of h.children ?? []) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}
