/** 渲染计划编译（py compile_plan_ally 的卡牌相关子集对译）：pivot 卡数据 + 静态表 → RenderPlan。
 *
 * 静态基底（components 几何/材质、camera、stat_gems、gem 相位）来自资产包 plan.json（帧级，
 * 卡牌无关）；本模块只推导卡牌 delta：类色图集、原画、稀有度宝石、ELITE 龙、攻/血宝石显隐、
 * 种族板、六个文字角色。推导规则与 py 链同源（decomp 出处见 py 注释，此处不重复）。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetPack, PlanComponent, RenderPlan } from './types.js';

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
  class:         Record<string, string>; // TAG_CLASS 枚举值 → 英文名
  raceZh:        Record<number, string>; // TAG_RACE 枚举值 → zhCN
  colorSwitcher: Record<string, (string | null)[]>; // family → ColorType 下标 → 图集 AssetReference
  hideTags:      Record<string, number>;
}

/** GAME_TAG id（py scene_compiler.py:102 同源）。 */
const TAG = {
  COST:     48, PREMIUM:  12, CLASS:    199, CARDTYPE: 202, RARITY:   203,
  ELITE:    114, CARDRACE: 200, HEALTH:   45, ATK:      47, CARD_SET: 275,
} as const;

/** TAG_CLASS 英文名 → CardColorType（= switcher 序列化下标；decomp switch 键）。 */
const COLOR_TYPE_FOR_CLASS: Record<string, number> = {
  'Warlock':      10, 'Rogue':        8, 'Druid':        3, 'Hunter':       4, 'Mage':         5,
  'Paladin':      6, 'Priest':       7, 'Shaman':       9, 'Warrior':      11,
  'DREAM':        4, 'Death Knight': 1, 'Demon Hunter': 2,
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
    case 4: return 'minionCardTextures';          // MINION（含 BATTLEGROUND_HERO_BUDDY=47）
    case 47: return 'minionCardTextures';
    case 5: return 'spellCardTextures';           // SPELL
    case 3: return 'heroCardTextures';            // HERO
    case 7: return 'weaponCardTextures';          // WEAPON
    case 39: return 'locationCardTextures';       // LOCATION
    case 42: return 'battlegroundsSpellCardTextures';
    case 44: return 'battlegroundsTrinketCardTextures';
    case 43: return 'battlegroundsAnomalyCardTextures';
    case 23: return 'mercenariesAbilityCardTextures';  // LETTUCE_ABILITY
    default: return '';
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
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
  const plan = clone(base.plan);
  const tags = pivot.tags;
  const binding = (plan as unknown as { actor_binding: Record<string, string | number> }).actor_binding;
  const matIdx = (k: string): number => binding[k] as number;

  // ---- 类色图集（TAG_CLASS → ColorType → family 下标；Neutral/未知 → 槽位 None → 不覆写）----
  const classVal = String(tags[TAG.CLASS] ?? 12);
  const className = tables.class[classVal] ?? 'Neutral';
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
