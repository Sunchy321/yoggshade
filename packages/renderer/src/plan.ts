/** 渲染计划编译（py compile_plan_ally 的卡牌相关子集对译）：fixture 卡数据 + 静态表 → RenderPlan。
 *
 * 静态基底（components 几何/材质、camera、stat_gems、gem 相位）来自资产包 plan.json（帧级，
 * 卡牌无关）；本模块只推导卡牌 delta：类色图集、原画、稀有度宝石、ELITE 龙、攻/血宝石显隐、
 * 种族板、六个文字角色。推导规则与 py 链同源（decomp 出处见 py 注释，此处不重复）。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetPack, FrameMaterial, PlanComponent, PrefabReport, RenderPlan } from './types.js';

export interface FixtureCard {
  cardId:          string;
  dbfId:           number;
  preset:          { label: string, premium: string, template: string, zone: string, reason: string };
  textBuilderType: number;
  name:            Record<string, string>;
  textInHand:      Record<string, string>;
  tags:            Record<string, number>;
}

export interface StaticTables {
  class:         Record<string, string>; // TAG_CLASS 枚举值 → 枚举名（DRUID/HUNTER/…；见 extract_static_tables.py）
  raceZh:        Record<number, string>; // TAG_RACE 枚举值 → zhCN
  schoolZh?:     Record<number, string>; // TAG_SPELL_SCHOOL 枚举值 → zhCN（法术学派板）
  colorSwitcher: Record<string, (string | null)[]>; // family → ColorType 下标 → 图集 AssetReference
  hideTags:      Record<string, number>;
  /** factionIconSt：CardColorSwitcher faction* 材质序列化摘要（extract_banner_assets.py），
   *  下标 = FactionColorType（0=GENERIC 空，1..6=帮派/星际）；阵营横幅运行时换材质的编译期输入。 */
  factionIconSt?: { normal: (import('./types.js').FactionMaterialSt | null)[],
                    signature: (import('./types.js').FactionMaterialSt | null)[] };
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
  packDir: string,
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
  const portraitFile = existsSync(join(packDir, 'portraits', `${fixture.cardId}.png`))
    ? `portraits/${fixture.cardId}.png`
    : existsSync(join(packDir, 'textures', `portrait_${fixture.cardId}.png`))
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
    case 'name': return fixture.name.zhCN ?? '';
    case 'desc': return fixture.textInHand.zhCN ?? '';
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
};

/** 帧 slot → 该帧的原生卡型（ActorNames 的 actor 归属；4=MINION，47=战棋英雄伙伴同用随从 actor）。
 * 别型卡（佣兵技能/战棋法术/宠物等）在专属帧落地前用回落帧渲染，属回归基线不属验收口径。 */
export const SLOT_NATIVE_CARD_TYPES: Record<string, number[]> = {
  'hand-minion':     [4, 47],
  'hand-spell':      [5, 40, 42],
  'hand-hero':       [3],
  'hand-weapon':     [7],
  'hand-location':   [39],
  'hand-heropower':  [10],
  'hand-bg-anomaly': [43],
  'hand-bg-trinket': [44],
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
 *  CostGem_DropShadow_Mesh=乘法阴影（地标帧；队列序语义 v1 未实现，登记残差）。 */
const STATIC_HIDDEN = new Set([
  'Highlight_Card_Plane', 'FX_Ghost_Quad', 'FX_Ghost_Quad_Unique',
  'Shadow', 'ShadowUnique',
  'RuneHolder_Mesh', 'RuneHolder_Shadow_Mesh', 'HolderGlow_Tutorial',
  'CostGem_DropShadow_Mesh',
]);

/** 逐帧 tag 规则（节点名 → 谓词键）。 */
interface FrameRules {
  elite:         string[];
  rarity:        string[];
  attack?:       string[];
  health?:       string[]; // 耐久同（HEALTH tag）
  armor?:        string[];
  race?:         string[]; // 单种族板
  multiRace?:    string[];
  noGem?:        string; // !rarity 时显（地标替代件）
  forcedHidden?: string[];
  /** 饰品等级徽章（TrinketLevelIndicatorRing 族）：SPELL_SCHOOL ∈ {LESSER,GREATER_TRINKET} 才显
   *  （GetTrinketLevel + UpdateBaconTrinketComponents，Actor.cs:5368-5420）。 */
  trinketBadge?: string[];
  roles:         string[];
}

const FRAME_RULES: Record<string, FrameRules> = {
  'hand-minion': {
    elite:     ['Unique_Ally_Dragon'], rarity:    ['RarityGemFrame', 'RarityGem'],
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
  // 武器：攻/耐久=图标网格（Wep_Swords/Wep_SheildBroken，非宝石）；名字平面 fallback（无载体）
  'hand-weapon': {
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
  // 地标：耐久=Wep_SheildBroken；No_Gem_Mesh=!rarity；RacePlate 强制隐（无种族文本）
  'hand-location': {
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
    roles:        ['cost', 'name', 'desc'],
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
};

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
  packDir: string,
  slot: string,
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
  const colorType = COLOR_TYPE_FOR_CLASS[className] ?? 0;
  const family = textureFamily(tags[TAG.CARDTYPE] ?? 4);
  const atlasRef = tables.colorSwitcher[family]?.[colorType] ?? null;
  let atlasFile: string | null = null;
  if (atlasRef) {
    const [stem, guid] = atlasRef.split(':');
    atlasFile = `textures/${stem.replace(/\.tif$/, '')}_${guid.slice(0, 8)}.png`;
  }
  const portraitFile = existsSync(join(packDir, 'portraits', `${fixture.cardId}.png`))
    ? `portraits/${fixture.cardId}.png`
    : existsSync(join(packDir, 'textures', `portrait_${fixture.cardId}.png`))
      ? `textures/portrait_${fixture.cardId}.png`
      : null;

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
  const atkVal = tags[TAG.ATK];
  const attackVisible = !(hideStats || hide('HIDE_ATTACK')) && (!isHeroCard || (atkVal ?? 0) > 0);
  const healthVisible = !(hideStats || hide('HIDE_HEALTH'));
  const attackText = hide('HIDE_ATTACK_NUMBER') || (isHeroCard && !atkVal)
    ? ''
    : (atkVal !== undefined || nativeCard ? String(atkVal ?? 0) : '');
  const healthText = hide('HIDE_HEALTH_NUMBER')
    ? ''
    : (tags[TAG.HEALTH] !== undefined || nativeCard ? String(tags[TAG.HEALTH] ?? 0) : '');
  const armorVal = tags[TAG2.ARMOR] ?? 0;
  const raceId = tags[TAG.CARDRACE] ?? 0;
  const raceText = raceId === 0 ? '' : (tables.raceZh[raceId] ?? 'UNKNOWN');
  const raceCount = raceId === 0 ? 0 : 1;
  const schoolId = tags[TAG2.SPELL_SCHOOL] ?? 0;
  const schoolText = schoolId === 0 ? '' : (tables.schoolZh?.[schoolId] ?? 'UNKNOWN');

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
      // 饰品：铸币（ApplyBattlegroundsHandCoinVisualSetup 的 trinket 分支），费用数字保留
      gemReplaced = true;
      spellOverlays.push({ key: coinKey, anchor: 'world-target', world_target: coinTarget });
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
    let visible = isActive && !STATIC_HIDDEN.has(name) && !(rules.forcedHidden ?? []).includes(name);
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
      } else if (rules.noGem === name) visible = !rarityVisible;
    } else if (rules.noGem === name) {
      // 序列化失活的 No_Gem_Mesh 由运行时规则翻正/翻回（地标）
      visible = !rarityVisible;
    }
    const comp: PlanComponent = {
      node:           name, path:           node.path, visible, raster:         true,
      material_slots: slots.map(s => ({ slot: s.slot, empty: !s.name })),
    };
    if (slot === 'hand-spell' && name === 'Description_mesh' && schoolText
      && base.meshes['extra/m_spellDescriptionMeshSchool']) {
      comp.mesh = 'extra/m_spellDescriptionMeshSchool'; // 学派板网格替换（Actor.cs:6240-6252）
    }
    if (comp.visible) byName.set(name, comp);
    components.push(comp);
  }

  // 载体节点不参与帧光栅（文字走 RTT 网格采样）
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
  if (atlasFile) {
    if (cardMeshComp && cardFrontIdx > -1) setSlotTex(cardMeshComp, cardFrontIdx, atlasFile);
    // SPELL 分支恒写 portraitFrameMatIdx；其余帧按"同名材质实例共享"（引擎内同一 Material 资产）
    const isSpell = (tags[TAG.CARDTYPE] ?? 0) === 5 || (tags[TAG.CARDTYPE] ?? 0) === 42;
    if (portraitMeshComp && portraitFrameIdx > -1) {
      const pfName = report.nodes.find(n => n.path === portraitMeshPath)
        ?.components.renderer?.material_slots?.find(s => s.slot === portraitFrameIdx)?.name ?? null;
      if (isSpell || (pfName && cardFrontMatName && pfName === cardFrontMatName)) {
        setSlotTex(portraitMeshComp, portraitFrameIdx, atlasFile);
      }
    }
    const noGemPath = refs['m_rarityNoGemMesh']?.node;
    const noGemComp = components.find(c => c.path === noGemPath);
    if (slot === 'hand-location' && noGemComp) setSlotTex(noGemComp, 0, atlasFile);
  }
  if (portraitMeshComp && portraitIdx > -1 && portraitFile) {
    setSlotTex(portraitMeshComp, portraitIdx, portraitFile);
  }
  if (slot === 'hand-bg-trinket' && portraitFile) {
    // 饰品原画窗：NonQuestObjects/Mesh 的 slot0（BG_Trinket_BigCard_FramePortrait_Mat，6 tri
    // 窗 quad）。m_portraitMesh 指向的 FrameMesh 只有 1 个子网格（slot1 序列化为空且无几何），
    // 实际画窗是这个兄弟节点的 FramePortrait 材质（材质名即证）。
    const artPath = `${report.prefab.name}/RootObject/NonQuestObjects/Mesh`;
    const artComp = components.find(c => c.path === artPath);
    if (artComp) setSlotTex(artComp, 0, portraitFile);
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
      // 徽章子树晚通道：运行时 SetActive 激活（Actor.cs:5418），后激活者合成在上。
      for (const nm of ['Trinket_Medallion_Shadow_Mesh', ...(rules.trinketBadge ?? [])
        .filter(x => x !== 'Trinket_Medallion_Shadow_Mesh')]) lateNodes.push(nm);
    }
  }

  // ---- 宝石晶体（攻/血/费）：材质序列化值采集（py _collect_stat_gems 同口径）----
  const statGems: RenderPlan['stat_gems'] = [];
  for (const [path, key] of keyByPath) {
    const name = path.split('/').pop()!;
    if (!['Gem_Attack', 'Gem_Health', 'Gem_Mana'].includes(name)) continue;
    // 序列化失活子树里的同名节点不采（战棋畸变帧 Gem_Mana 失活=无费用显示）；
    // 战棋模板下 mana gem 被 coin/tier spell 替换（UpdateManaGemComponent 隐藏 m_manaObject）。
    if (!(active.get(path) ?? true)) continue;
    if (gemReplaced && name === 'Gem_Mana') continue;
    const comp = byName.get(name);
    if (name !== 'Gem_Mana' && !comp) continue;
    const node = findNode(base.frameRecon.hierarchy, path);
    const mat = node?.renderers?.[0]?.materials?.[0];
    if (!mat) continue;
    statGems.push({
      node:          name, path, npz_key:       key,
      main_tex_file: mat.tex?.['_MainTex']?.texture?.file ?? '',
      tint_rgb:      (mat.colors?.['_tint'] ?? [1, 1, 1, 1]).slice(0, 3),
      intensity:     mat.floats?.['_Intensity'] ?? 1.0,
      speed_xy:      [mat.floats?.['_XSpeed'] ?? 5.0, mat.floats?.['_YSpeed'] ?? 0.2],
      scale_xy:      [mat.floats?.['_ScaleX'] ?? 1.0, mat.floats?.['_ScaleY'] ?? 1.0],
    });
  }

  // ---- 文字角色 ----
  const bodyFor = (role: string): string => {
    switch (role) {
    case 'cost':
      if (bgHideCost) return ''; // 战棋模板：tier 徽章/铸币替换费用显示（见 spellOverlays 规则）
      if (slot === 'hand-hero') return String(tags[TAG.COST] ?? 0); // 英雄费用缺省显 "0"
      return tags[TAG.COST] !== undefined ? String(tags[TAG.COST]) : '';
    case 'name': return fixture.name.zhCN ?? '';
    case 'desc': return fixture.textInHand.zhCN ?? '';
    case 'race': return slot === 'hand-spell' ? schoolText : raceText;
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
    if (role === 'cost' && costWorldDelta) return { role, render: true, text: body, world_delta: costWorldDelta };
    return { role, render: true, text: body };
  });

  // ---- opaque-edge alpha 修复标记（写点完成后按最终纹理判定；见 needsOpaqueEdgeRepair）----
  markOpaqueEdgeSlots(components, report.nodes);

  // ---- DK 符文横幅（tag 2196/2197/2198 → 显隐 + 图标材质覆写；含图标 opaque 豁免，须在标记后）----
  compileRuneBanner(components, tags);

  // ---- 手牌横幅：可交易/锻造/准备 + 阵营 + 多职业绶带（须在标记后：激活态才判 tint/材质覆写）----
  compileBanners(components, tags, tables);

  const plan: RenderPlan = {
    components,
    input:      { dbf_id: String(fixture.dbfId), card_id: fixture.cardId },
    rarity_gem: {
      visible:      rarityVisible,
      atlas_offset: rarityVisible ? GEM_TEXTURE_OFFSET[rarityName] : undefined,
      tint_rgb:     rarityVisible ? GEM_COLOR[rarityName] : undefined,
    },
    gem:            { enabled: true, t: 0.07 },
    stat_gems:      statGems,
    texts,
    spell_overlays: spellOverlays.length ? spellOverlays : undefined,
    late_nodes:     lateNodes.length ? lateNodes : undefined,
  };
  return plan;
}

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

/** 按 prefab_report 的材质槽名/shader + 计划最终纹理，标注 opaque-edge 修复与乘法混合（见各 needs* 说明）。 */
function markOpaqueEdgeSlots(
  components: PlanComponent[],
  reportNodes: PrefabReport['nodes'],
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
// - Actor.UpdateMulticlassRibbon（6068-6075）：GetClasses().Count > 2 才 SetActive；
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
// 残差登记：① CATA_190h 的 L2 用 Deathwing 签名帧（金色透视绶带变体=序列化激活的
//   Multiclass_Ribbon_Signature_mesh，仅存在于该 premium 帧），本链回落普通帧只能显普通棕绶带
//   ——premium 帧族未移植（five-cardtypes §6）的家族缺口，非本管线误差；② SC_004（ZERG+
//   4 类）L2 用 Evergreen 签名英雄帧，同族不可对齐（普通帧按统一反编译逻辑渲染绶带）；
//   ③ Glow_Green/Blue 拖拽高亮（Custom/Selection/Highlight，renderer 序列化 enabled=false）
//   默认态不渲染，未移植；④ 英雄通用帧无 deck-action 容器字段（Actor 序列化即无）——英雄
//   不可能显示可交易/锻造横幅，与引擎一致。

const BANNER_TAG = {
  TRADEABLE: 1720, FORGE: 2785, PREPARE: 4354,
  GRIMY_GOONS: 482, KABAL: 484, JADE_LOTUS: 483,
  ZERG: 3457, TERRAN: 3458, PROTOSS: 3469, MULTIPLE_CLASSES: 476,
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

/** 主 quad（基色不乘 _Color，见块注）的节点名 → _tint_rgb 白中和。 */
const BANNER_TINT_NEUTRAL_NODES = new Set([
  'Tradeable_Banner_mesh', 'Forgeable_Banner_mesh', 'Prepareable_Banner_mesh',
  'Faction_Banner', 'Multiclass_Ribbon_mesh',
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
  // SIGNATURE premium 按用户裁定（2026-10-05）照常渲染（SC_004 凯瑞甘需出虫族横幅）；
  // 材质取 normal 表（真实图标象限）——引擎签名卡用 FX 滚动材质
  // （Unlit_TransparentTexAlpha2uvScroll，无静态象限），静态近似登记残差。
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

  // 多职业绶带（UpdateMulticlassRibbon：classes.Count > 2；normal/signature 网格变体按
  // 序列化自激活取 normal——signature 变体只在 premium 专用帧上激活，见块注残差①）
  if (bannerClassCount(tags) > 2) {
    for (const c of components) {
      if (!c.path.includes('/Multiclass_Ribbon/') && !c.path.includes('/MulticlassRibbon/')) continue;
      if (BANNER_GLOW_NODES.has(c.node ?? '')) continue;
      c.visible = !(c.node ?? '').includes('Signature');
    }
    // 绶带阴影 repeat wrap（材质 ST 越界；见块注）
    const shadow = components.find(c => c.visible && c.node === 'Multiclass_Ribbon_Shadow_mesh');
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
