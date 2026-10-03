/** 渲染计划编译（py compile_plan_ally 的卡牌相关子集对译）：pivot 卡数据 + 静态表 → RenderPlan。
 *
 * 静态基底（components 几何/材质、camera、stat_gems、gem 相位）来自资产包 plan.json（帧级，
 * 卡牌无关）；本模块只推导卡牌 delta：类色图集、原画、稀有度宝石、ELITE 龙、攻/血宝石显隐、
 * 种族板、六个文字角色。推导规则与 py 链同源（decomp 出处见 py 注释，此处不重复）。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetPack, FrameMaterial, PlanComponent, PrefabReport, RenderPlan } from './types.js';

export interface PivotCard {
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
  pivot: PivotCard,
  tables: StaticTables,
  base: AssetPack,
  packDir: string,
): RenderPlan {
  const plan = clone(base.plan!) as RenderPlan;
  const tags = pivot.tags;
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

  // ---- 原画（pivot 提取的新路径优先，EX1_350 时代的旧布局兜底；PET 类无原画 → 置空槽，
  //      对应引擎 PET 卡型 SetMaterialNormal 的 no-op 分支 Actor.cs SetMaterial switch）----
  const portraitFile = existsSync(join(packDir, 'portraits', `${pivot.cardId}.png`))
    ? `portraits/${pivot.cardId}.png`
    : existsSync(join(packDir, 'textures', `portrait_${pivot.cardId}.png`))
      ? `textures/portrait_${pivot.cardId}.png`
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
    case 'name': return pivot.name.zhCN ?? '';
    case 'desc': return pivot.textInHand.zhCN ?? '';
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
    dbf_id:  String(pivot.dbfId),
    card_id: pivot.cardId,
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
};

/** 帧 slot → 该帧的原生卡型（ActorNames 的 actor 归属；4=MINION，47=战棋英雄伙伴同用随从 actor）。
 * 别型卡（佣兵技能/战棋法术/宠物等）在专属帧落地前用回落帧渲染，属回归基线不属验收口径。 */
export const SLOT_NATIVE_CARD_TYPES: Record<string, number[]> = {
  'hand-minion':    [4, 47],
  'hand-spell':     [5],
  'hand-hero':      [3],
  'hand-weapon':    [7],
  'hand-location':  [39],
  'hand-heropower': [10],
};

/** GAME_TAG（sc.py:102 同源）+ ARMOR（GAME_TAG.cs:214）。 */
const TAG2 = { ARMOR: 292, SPELL_SCHOOL: 1635 } as const;

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
  pivot: PivotCard,
  tables: StaticTables,
  base: AssetPack,
  packDir: string,
  slot: string,
): RenderPlan {
  const report = base.prefabReport!;
  const rules = FRAME_RULES[slot];
  if (!rules) throw new Error(`未知帧 slot: ${slot}`);
  const tags = pivot.tags;
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
  const portraitFile = existsSync(join(packDir, 'portraits', `${pivot.cardId}.png`))
    ? `portraits/${pivot.cardId}.png`
    : existsSync(join(packDir, 'textures', `portrait_${pivot.cardId}.png`))
      ? `textures/portrait_${pivot.cardId}.png`
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
      else if (rules.noGem === name) visible = !rarityVisible;
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

  // ---- 宝石晶体（攻/血/费）：材质序列化值采集（py _collect_stat_gems 同口径）----
  const statGems: RenderPlan['stat_gems'] = [];
  for (const [path, key] of keyByPath) {
    const name = path.split('/').pop()!;
    if (!['Gem_Attack', 'Gem_Health', 'Gem_Mana'].includes(name)) continue;
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
      if (slot === 'hand-hero') return String(tags[TAG.COST] ?? 0); // 英雄费用缺省显 "0"
      return tags[TAG.COST] !== undefined ? String(tags[TAG.COST]) : '';
    case 'name': return pivot.name.zhCN ?? '';
    case 'desc': return pivot.textInHand.zhCN ?? '';
    case 'race': return slot === 'hand-spell' ? schoolText : raceText;
    case 'attack': return attackText;
    case 'health': return healthText;
    case 'armor': return armorVal > 0 ? String(armorVal) : '';
    default: return '';
    }
  };
  const texts = rules.roles.map(role => {
    const body = bodyFor(role);
    if (!body) return { role, render: false, reason: '文本为空（缺省/规则隐藏）' };
    return { role, render: true, text: body };
  });

  // ---- opaque-edge alpha 修复标记（写点完成后按最终纹理判定；见 needsOpaqueEdgeRepair）----
  markOpaqueEdgeSlots(components, report.nodes);

  const plan: RenderPlan = {
    components,
    input:      { dbf_id: String(pivot.dbfId), card_id: pivot.cardId },
    rarity_gem: {
      visible:      rarityVisible,
      atlas_offset: rarityVisible ? GEM_TEXTURE_OFFSET[rarityName] : undefined,
      tint_rgb:     rarityVisible ? GEM_COLOR[rarityName] : undefined,
    },
    gem:       { enabled: true, t: 0.07 },
    stat_gems: statGems,
    texts,
  };
  return plan;
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

function findNode(hierarchy: unknown, path: string): { renderers?: { materials?: (FrameMaterial | null)[] }[] } | null {
  const h = hierarchy as { path?: string, renderers?: unknown[], children?: unknown[] };
  if (h.path === path) return h as never;
  for (const c of h.children ?? []) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}
