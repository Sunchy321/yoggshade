/** 站点输入 → 渲染器输入（ticket 08：renderModel 形态 → FixtureCard）。
 *
 * 为什么需要这一层：站点没有协议边界（进程内 import），但**渲染器只吃 fixture 形态**
 * （`plan.ts` 的 FixtureCard：tags + preset + name/textInHand + textBuilderType）。
 * 站点侧字段名对齐协议 renderModel，映射集中在这里，一处可审。
 *
 * 站点口径（都源自已有裁决，勿在此另立）：
 *  1. GOLDEN / SIGNATURE 沿用表单品质，DIAMOND 因 RTT 3D 未移植而拒绝；
 *  2. 战棋卡型 → `preset.template = 'Battlegrounds'`（plan.ts:626 消费，决定铸币/tier 图标视觉）；
 *  3. 用户文本走 `textBuilderType = 0`（DEFAULT builder：空白解码 + 富文本转换，不做机制重建），
 *     避免沿用预设卡的 builder 把自定义文本按原卡机制改写。 */
import {
  SIGNATURE_FRAME_TO_SLOT, SLOT_NATIVE_CARD_TYPES, type FixtureCard,
} from '@yoggshade/renderer/plan';
import { decodePngBytes, peekPngSize } from '@yoggshade/renderer/image';
import { KeyMissingError, type AssetSource } from '@yoggshade/renderer/source';
import type { RGBAImage } from '@yoggshade/renderer/types';
import { BG_CARD_TYPES } from './meta.js';
import type { RenderRequest } from './shared.js';

/** GAME_TAG（`plan.ts` 的 TAG/TAG2 子集：站点可编辑的那些面）。 */
const TAG = {
  COST:                    48,
  ATK:                     47,
  HEALTH:                  45,
  ARMOR:                   292,
  CLASS:                   199,
  CARDTYPE:                202,
  RARITY:                  203,
  ELITE:                   114,
  CARDRACE:                200,
  SPELL_SCHOOL:            1635,
  LETTUCE_MERCENARY:       1665,
  LETTUCE_ROLE:            1666,
  LETTUCE_FACTION:         2720,
  LETTUCE_SUMMONED_MINION: 1676,
  LETTUCE_IS_EQUPIMENT:    1855,
} as const;

/** 学派（1635）由表单接管的卡型：法术族 + 佣兵技能（23 的 1635 是真学派，驱动描述板
 *  school 网格替换；见 plan.ts hand-lettuce-ability 分支）。**其他卡型不碰**——饰品卡的
 *  同名 tag 是等级徽章（LESSER/GREATER），写/清会丢等级（parity 实证）。 */
const SPELL_TYPES = new Set([5, 40, 42, 23]);

export class CardRequestError extends Error {}

/** 原画边长上限：PNG 解码成 float64 = 32 B/px，1024² ≈ 33.5 MB（内存口径见 ticket 03 §0） */
const PORTRAIT_MAX_SIDE = 1024;

/** 空卡骨架：无 dbfId（→ 无水印）、无原画、无系列；用户从零填写时用。 */
const EMPTY_BASE: FixtureCard = {
  cardId:          'DIY',
  dbfId:           0,
  preset:          { label: '自定义卡', premium: 'NORMAL', template: 'Normal', zone: 'Hand', reason: '站点自定义卡' },
  textBuilderType: 0,
  name:            { zhCN: '' },
  textInHand:      { zhCN: '' },
  tags:            { 321: 1 },
};

/** dataURL（image/png）→ RGBAImage，并做上传规格校验（ticket 03 findings §0/§4）。
 *  必须 1:1（非方形会被按 W/H 拉伸、不补边）、边长 ≤1024、不含透明像素
 *  （六个帧槽的公式层忽略 alpha，但饰品槽走通用光栅会消费它 → 透明处穿孔）。
 *  前端已按规格裁切并压到不透明底，这里是服务端兜底守卫。
 *  ticket 17（先验后解码）：尺寸从 PNG IHDR 直读（peekPngSize，不 inflate、不大分配），
 *  超规直接 400——此前「先整图解码再查宽高」，恶意超大 PNG 会在校验前吃掉数 GB 内存。 */
export function decodePortrait(dataUrl: string): RGBAImage {
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new CardRequestError('原画必须是 PNG dataURL（由前端裁剪后导出 PNG）');
  // base64 → 字节（浏览器端跑 adapter，ADR-0002：无 Node Buffer，用 atob）
  const bin = atob(m[1]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let dims: { w: number, h: number };
  try {
    dims = peekPngSize(bytes);
  } catch (err) {
    throw new CardRequestError(`原画解码失败：${(err as Error).message}`);
  }
  if (dims.w !== dims.h) {
    throw new CardRequestError(
      `原画必须是 1:1 正方形（当前 ${dims.w}×${dims.h}）：非方形会被拉伸填满画窗，不做补边`);
  }
  if (dims.w > PORTRAIT_MAX_SIDE) {
    throw new CardRequestError(`原画边长不得超过 ${PORTRAIT_MAX_SIDE}px（当前 ${dims.w}）`);
  }
  let img: RGBAImage;
  try {
    img = decodePngBytes(bytes);
  } catch (err) {
    throw new CardRequestError(`原画解码失败：${(err as Error).message}`);
  }
  for (let i = 3; i < img.data.length; i += 4) {
    // uint8 口径（RGBAImage.data 自 ticket 18 起 0..255）：任一像素 alpha≠255 即不透明度不足。
    // 旧 float 口径 `k/255 < 1` 与 `k !== 255` 等价。
    if (img.data[i] !== 255) {
      throw new CardRequestError(
        '原画含有透明像素：请先压到不透明底（饰品卡的原画窗会消费 alpha，透明处会透出框体）');
    }
  }
  return img;
}

function setOrDelete(tags: Record<string, number>, tag: number, value: number): void {
  if (value > 0) tags[String(tag)] = value;
  else delete tags[String(tag)];
}

function loadFixture(cardId: string, data: AssetSource): FixtureCard | undefined {
  try {
    return JSON.parse(data.text(`fixtures/${cardId}.json`)) as FixtureCard;
  } catch (e) {
    if (e instanceof KeyMissingError) return undefined;
    throw e;
  }
}

/** 站点请求 → fixture（+ 可选上传原画）。presetId 给定时以该卡为底：
 *  未在表单管理的 tag（如 321 收藏标记）沿用预设，原画/水印也随预设。 */
export function prepareCard(
  req: RenderRequest,
  dirs: { pack: AssetSource, data: AssetSource },
): { fixture: FixtureCard, portrait?: RGBAImage } {
  if (req.premium === 'DIAMOND') {
    throw new CardRequestError('钻石卡暂不支持：它需要尚未移植的 3D 渲染流程');
  }
  let fixture: FixtureCard;
  let presetBaseText = '';
  let base: FixtureCard | undefined;
  if (req.presetId) {
    const presetIds = new Set(((JSON.parse(dirs.data.text('fixtures/manifest.json')) as
      { presets?: { cardId: string }[] }).presets ?? []).map(p => p.cardId));
    // 预设 ID 必须来自 manifest，避免本地文件系统中其它 fixture 文件被直接当作站点预设。
    if (!presetIds.has(req.presetId)) throw new CardRequestError(`预设不存在：${req.presetId}`);
    base = loadFixture(req.presetId, dirs.data);
    if (!base) throw new CardRequestError(`预设不存在：${req.presetId}`);
    fixture = structuredClone(base);
    presetBaseText = base.textInHand?.zhCN ?? '';
  } else {
    fixture = structuredClone(EMPTY_BASE);
  }

  if (req.premium === 'SIGNATURE') {
    const frameId = base?.preset.signatureFrameId;
    const signatureSlot = frameId === undefined ? undefined : SIGNATURE_FRAME_TO_SLOT[frameId];
    const signatureBaseSlot = signatureSlot?.replace(/-sig\d+$/, '');
    const supported = Boolean(req.presetId && signatureSlot && signatureBaseSlot
      && SLOT_NATIVE_CARD_TYPES[signatureBaseSlot]?.includes(req.cardType)
      && dirs.pack.has(`frames/${signatureSlot}/manifest.json`));
    if (!supported) {
      throw new CardRequestError('异画仅适用于带已移植异画框的原始卡预设，且卡型需与卡框匹配');
    }
  }

  const tags = fixture.tags;
  tags[TAG.CARDTYPE] = req.cardType;
  tags[TAG.CLASS] = req.classTag;
  tags[TAG.RARITY] = req.rarity;
  tags[TAG.COST] = req.cost;
  tags[TAG.ATK] = req.attack;
  tags[TAG.HEALTH] = req.health;
  setOrDelete(tags, TAG.ARMOR, req.armor);
  setOrDelete(tags, TAG.ELITE, req.elite ? 1 : 0);
  setOrDelete(tags, TAG.CARDRACE, req.race);
  // 学派（1635）只对法术类卡型由表单接管（写/清）；**其他卡型不碰**——饰品卡的同名 tag
  // 是等级徽章（LESSER/GREATER，plan.ts TRINKET_SCHOOLS），清掉会丢等级（parity 实证）。
  if (SPELL_TYPES.has(req.cardType)) setOrDelete(tags, TAG.SPELL_SCHOOL, req.school);
  // 佣兵本体三件套（1665 标识 + 1666 职业 + 2720 阵营）：仅随从卡型；非随从/未勾选清空
  // ——1665>0 会把任意卡型抢先分流到 hand-mercenary（plan.ts slotForCardType），
  // 不能让 preset 继承的佣兵 tag 漏到换了卡型的卡上。
  const mercBody = req.cardType === 4 && req.mercenary;
  setOrDelete(tags, TAG.LETTUCE_MERCENARY, mercBody ? 1 : 0);
  setOrDelete(tags, TAG.LETTUCE_ROLE, mercBody ? req.mercRole : 0);
  setOrDelete(tags, TAG.LETTUCE_FACTION, mercBody ? req.mercFaction : 0);
  // 佣兵技能形态（1676 召唤随从 / 1855 装备）：仅卡型 23；值写 1——渲染只判存在性
  // （HasTag 语义，plan.ts slotForCardType）；游戏里 1676 的值是召唤随从的 dbfId
  // （玩法数据，站点无输入面）。
  const lettuceForm = req.cardType === 23 ? req.lettuceForm : 0;
  setOrDelete(tags, TAG.LETTUCE_SUMMONED_MINION, lettuceForm === 1 ? 1 : 0);
  setOrDelete(tags, TAG.LETTUCE_IS_EQUPIMENT, lettuceForm === 2 ? 1 : 0);

  fixture.name = { ...fixture.name, zhCN: req.name };
  fixture.textInHand = { ...fixture.textInHand, zhCN: req.text };
  // 文本重建口径：预设原文未改动时**保留原 textBuilderType**（这样"加载预设不动文案"与
  // L2 基准逐位一致——基准卡里还有 JADE/KAZAKUS 等非 0 builder，强行归 0 会改掉渲染文本）；
  // 一旦用户改了文案，就按原样渲染（DEFAULT builder：空白解码 + 富文本转换，不做机制重建）。
  const baseText = req.presetId ? (presetBaseText ?? '') : '';
  if (!req.presetId || req.text !== baseText) fixture.textBuilderType = 0;
  // 战棋模板：卡型是战棋专属型（酒馆法术/畸变/饰品/任务奖励）→ Battlegrounds；
  // 否则**保留预设自带的 Battlegrounds**（战棋随从 = 卡型 4 + 模板 Battlegrounds，
  // 此前按卡型判定漏掉 → 覆写成 Normal，铸币/tier 视觉丢失，BG33_828/BG34 实测）；
  // 改了卡型的预设不保留（模板跟随新卡型的常规视觉）。
  const presetTemplate = req.presetId && base
    ? (base.tags[TAG.CARDTYPE] === req.cardType ? base.preset.template : 'Normal')
    : 'Normal';
  fixture.preset = {
    ...fixture.preset,
    premium:  req.premium,
    zone:     'Hand',
    template: BG_CARD_TYPES.has(req.cardType) ? 'Battlegrounds' : presetTemplate,
  };

  const portrait = req.portrait ? decodePortrait(req.portrait) : undefined;
  return { fixture, portrait };
}
