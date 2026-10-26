/** 表单枚举与中文标签（服务端）。
 *
 * 取值域与中文名的来源：研究票 04（`.scratch/diy-card-site/issues/04-form-enumeration-tables.md`
 * 的 `## Answer` 与 findings §1.1/§1.2）——卡型 = `plan.ts` 的 `CARD_TYPE_TO_SLOT`（TAG_CARDTYPE），
 * 职业/稀有度标签 = 游戏 `s_classNames`/`s_rarityNames`，种族/学派 = `data/tables.json`
 * 的 `raceZh`/`schoolZh`。
 *
 * 本文件是**首版最小集**：完整的 14 语言标签表（含系列名）由 ticket 11 落成
 * `scripts/extract_label_tables.py` + 仓内数据文件后替换这里的硬编码标签。 */
import type { AssetSource } from '@yoggshade/renderer/source';
import {
  CARD_TYPE_TO_SLOT, SIGNATURE_FRAME_TO_SLOT, SLOT_NATIVE_CARD_TYPES, type FixtureCard,
} from '@yoggshade/renderer/plan';
import type { CardFields, CardPremium, CardTypeOption, LabelOption, MetaResponse, PresetInfo } from './shared.js';

/** 可渲染卡型（帧槽已移植的 8 槽 + 同槽不同纹理族的奖励/酒馆法术 + 佣兵技能）。
 *  佣兵全族可由表单表达：佣兵技能（23，含召唤/装备形态）走卡型下拉 + 形态字段；
 *  佣兵本体（随从 + 佣兵勾选）走「数值」区的佣兵控件（职业/阵营下拉）。
 *  其余未列卡型（宠物等）仍回落随从帧。 */
const CARD_TYPE_LABELS: [number, string][] = [
  [4, '随从'],
  [5, '法术'],
  [3, '英雄'],
  [7, '武器'],
  [10, '英雄技能'],
  [39, '地标'],
  [42, '酒馆法术'],
  [40, '任务奖励'],
  [43, '战棋畸变'],
  [44, '战棋饰品'],
  [23, '佣兵技能'],
];

/** 战棋模板卡型（plan.ts:626 `preset.template === 'Battlegrounds'` 消费 → 铸币/tier 图标视觉） */
export const BG_CARD_TYPES = new Set([40, 42, 43, 44]);

function cardPremium(value: string | undefined): CardPremium {
  return value === 'GOLDEN' || value === 'SIGNATURE' || value === 'DIAMOND'
    ? value
    : 'NORMAL';
}

/** TAG_CLASS（zhCN 名取自游戏 `s_classNames`，含中立；DREAM/WHIZBANG/INVALID 不进表单）。 */
const CLASS_LABELS: [number, string][] = [
  [1, '死亡骑士'], [2, '德鲁伊'], [3, '猎人'], [4, '法师'], [5, '圣骑士'], [6, '牧师'],
  [7, '潜行者'], [8, '萨满祭司'], [9, '术士'], [10, '战士'], [14, '恶魔猎手'], [12, '中立'],
];

/** TAG_RARITY：0=INVALID 与 2=FREE 不显宝石（plan.ts RARITY_NAMES）。 */
const RARITY_LABELS: [number, string][] = [
  [1, '普通'], [2, '免费'], [3, '稀有'], [4, '史诗'], [5, '传说'],
];

/** 同上，帧槽由 plan.ts 权威表推导（不手抄，避免与渲染端分叉）。 */
export function cardTypes(): CardTypeOption[] {
  return CARD_TYPE_LABELS.map(([tag, label]) => ({
    tag, label, slot: CARD_TYPE_TO_SLOT[tag] ?? 'hand-minion',
  }));
}

export function classes(): LabelOption[] {
  return CLASS_LABELS.map(([tag, label]) => ({ tag, label }));
}

export function rarities(): LabelOption[] {
  return RARITY_LABELS.map(([tag, label]) => ({ tag, label }));
}

/** 种族标签直接用渲染端表（data/tables.json → raceZh，42 项）；0 = 无种族。 */
export function races(data: AssetSource): LabelOption[] {
  const tables = JSON.parse(data.text('tables.json')) as { raceZh: Record<string, string> };
  return Object.entries(tables.raceZh ?? {}).map(([tag, label]) => ({ tag: Number(tag), label }));
}

/** 法术学派标签（data/tables.json → schoolZh，8 项；与渲染端能力严格一致，缺的不列）。 */
export function schools(data: AssetSource): LabelOption[] {
  const tables = JSON.parse(data.text('tables.json')) as { schoolZh?: Record<string, string> };
  return Object.entries(tables.schoolZh ?? {}).map(([tag, label]) => ({ tag: Number(tag), label }));
}

export function loadPresets(data: AssetSource, pack: AssetSource): PresetInfo[] {
  // 只从 manifest.presets 枚举站点预设；Workers 的 mapSource 也以此清单为准。
  const presetCards = (JSON.parse(data.text('fixtures/manifest.json')) as
    { presets: { cardId: string }[] }).presets;
  const out: PresetInfo[] = [];
  for (const { cardId } of presetCards) {
    // 佣兵卡（LT23_*/LT24_*）此前因「回落随从帧 = 误导性错误框架」被摘除（ticket 20）；
    // 四个专属帧族落地后（.scratch/lettuce-frames），过滤移除、全部恢复收录。
    const fx = JSON.parse(data.text(`fixtures/${cardId}.json`)) as FixtureCard;
    const t = (k: number): number => fx.tags[String(k)] ?? 0;
    const presetPremium = cardPremium(fx.preset?.premium);
    const signatureFrameId = fx.preset?.signatureFrameId;
    const signatureSlot = signatureFrameId === undefined
      ? undefined
      : SIGNATURE_FRAME_TO_SLOT[signatureFrameId];
    const signatureBaseSlot = signatureSlot?.replace(/-sig\d+$/, '');
    const cardType = t(202);
    const signatureAvailable = Boolean(signatureSlot && signatureBaseSlot
      && SLOT_NATIVE_CARD_TYPES[signatureBaseSlot]?.includes(cardType)
      && pack.has(`frames/${signatureSlot}/manifest.json`));
    const fields: CardFields = {
      // DIAMOND remains inspectable as a preset, but never enters the unsupported render path.
      premium:     presetPremium === 'DIAMOND' ? 'NORMAL' : presetPremium,
      cardType:    t(202),
      classTag:    t(199),
      rarity:      t(203),
      cost:        t(48),
      attack:      t(47),
      health:      t(45),
      armor:       t(292),
      elite:       t(114) !== 0,
      race:        t(200),
      school:      t(1635),
      mercenary:   t(1665) !== 0,
      mercRole:    t(1666),
      mercFaction: t(2720),
      lettuceForm: t(1676) !== 0 ? 1 : t(1855) !== 0 ? 2 : 0,
    };
    out.push({
      cardId:      fx.cardId,
      label:       fx.preset?.label ?? fx.cardId,
      name:        fx.name?.zhCN ?? '',
      text:        fx.textInHand?.zhCN ?? '',
      premium:     presetPremium,
      signatureFrameId,
      signatureAvailable,
      hasPortrait: pack.has(`portraits/${fx.cardId}.png`),
      fields,
    });
  }
  return out;
}

/** 预设原画是否存在（供出图前提示"这张卡自带哪张画"；站点不向用户暴露资产文件本身）。 */
export function presetHasPortrait(pack: AssetSource, cardId: string): boolean {
  return pack.has(`portraits/${cardId}.png`);
}

export function loadMeta(dirs: { pack: AssetSource, data: AssetSource }): MetaResponse {
  return {
    cardTypes: cardTypes(),
    classes:   classes(),
    rarities:  rarities(),
    races:     races(dirs.data),
    schools:   schools(dirs.data),
    presets:   loadPresets(dirs.data, dirs.pack),
  };
}
