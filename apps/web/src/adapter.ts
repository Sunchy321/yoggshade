/** 站点输入 → 渲染器输入（ticket 08：renderModel 形态 → FixtureCard）。
 *
 * 为什么需要这一层：站点没有协议边界（进程内 import），但**渲染器只吃 fixture 形态**
 * （`plan.ts` 的 FixtureCard：tags + preset + name/textInHand + textBuilderType）。
 * 站点侧字段名对齐协议 renderModel，映射集中在这里，一处可审。
 *
 * 三处站点口径（都源自已有裁决，勿在此另立）：
 *  1. premium 恒 NORMAL —— premium 帧族未移植（地图 Out of scope）；
 *  2. 战棋卡型 → `preset.template = 'Battlegrounds'`（plan.ts:626 消费，决定铸币/tier 图标视觉）；
 *  3. 用户文本走 `textBuilderType = 0`（DEFAULT builder：空白解码 + 富文本转换，不做机制重建），
 *     避免沿用预设卡的 builder 把自定义文本按原卡机制改写。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureCard } from '@yoggraph/renderer/plan';
import { decodePngBytes } from '@yoggraph/renderer/image';
import type { RGBAImage } from '@yoggraph/renderer/types';
import { BG_CARD_TYPES } from './meta.js';
import type { RenderRequest } from './shared.js';

/** GAME_TAG（`plan.ts` 的 TAG/TAG2 子集：站点可编辑的那些面）。 */
const TAG = {
  COST:         48, ATK:          47, HEALTH:       45, ARMOR:        292,
  CLASS:        199, CARDTYPE:     202, RARITY:       203, ELITE:        114, CARDRACE:     200,
  SPELL_SCHOOL: 1635,
} as const;

/** 法术类卡型（学派文本只在这些卡型的 race 行显示，plan.ts:905）。 */
const SPELL_TYPES = new Set([5, 40, 42]);

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
 *  前端已按规格裁切并压到不透明底，这里是服务端兜底守卫。 */
export function decodePortrait(dataUrl: string): RGBAImage {
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new CardRequestError('原画必须是 PNG dataURL（由前端裁剪后导出 PNG）');
  let img: RGBAImage;
  try {
    img = decodePngBytes(Buffer.from(m[1]!, 'base64'));
  } catch (err) {
    throw new CardRequestError(`原画解码失败：${(err as Error).message}`);
  }
  if (img.w !== img.h) {
    throw new CardRequestError(
      `原画必须是 1:1 正方形（当前 ${img.w}×${img.h}）：非方形会被拉伸填满画窗，不做补边`);
  }
  if (img.w > PORTRAIT_MAX_SIDE) {
    throw new CardRequestError(`原画边长不得超过 ${PORTRAIT_MAX_SIDE}px（当前 ${img.w}）`);
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

function loadFixture(cardId: string, dataDir: string): FixtureCard | undefined {
  const p = join(dataDir, 'fixtures', `${cardId}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf-8')) as FixtureCard;
}

/** 站点请求 → fixture（+ 可选上传原画）。presetId 给定时以该卡为底：
 *  未在表单管理的 tag（如 321 收藏标记）沿用预设，原画/水印也随预设。 */
export function prepareCard(
  req: RenderRequest,
  dirs: { pack: string, data: string },
): { fixture: FixtureCard, portrait?: RGBAImage } {
  let fixture: FixtureCard;
  let presetBaseText = '';
  if (req.presetId) {
    const base = loadFixture(req.presetId, dirs.data);
    if (!base) throw new CardRequestError(`预设不存在：${req.presetId}`);
    fixture = structuredClone(base);
    presetBaseText = base.textInHand?.zhCN ?? '';
  } else {
    fixture = structuredClone(EMPTY_BASE);
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

  fixture.name = { ...fixture.name, zhCN: req.name };
  fixture.textInHand = { ...fixture.textInHand, zhCN: req.text };
  // 文本重建口径：预设原文未改动时**保留原 textBuilderType**（这样"加载预设不动文案"与
  // L2 基准逐位一致——基准卡里还有 JADE/KAZAKUS 等非 0 builder，强行归 0 会改掉渲染文本）；
  // 一旦用户改了文案，就按原样渲染（DEFAULT builder：空白解码 + 富文本转换，不做机制重建）。
  const baseText = req.presetId ? (presetBaseText ?? '') : '';
  if (!req.presetId || req.text !== baseText) fixture.textBuilderType = 0;
  fixture.preset = {
    ...fixture.preset,
    premium:  'NORMAL',
    zone:     'Hand',
    template: BG_CARD_TYPES.has(req.cardType) ? 'Battlegrounds' : 'Normal',
  };

  const portrait = req.portrait ? decodePortrait(req.portrait) : undefined;
  return { fixture, portrait };
}
