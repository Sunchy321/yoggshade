/** 站点渲染路径一致性验收（ticket 09 的第一条判据，可复跑）。
 *
 * 判据：对每个帧槽的代表卡，"表单值全部取自该 fixture" 的站点请求经 adapter 还原出的 fixture，
 * 渲染结果必须与**直接渲染该 fixture**（= L2 验收锚点走的那条路）逐位一致。
 * 任何一位不同即说明 adapter 丢了/改了渲染输入（tag/preset/文本重建口径），站点出图就与基准分叉。
 *
 * 用法：bun apps/web/scripts/check-parity.ts
 * （第二轮判据 = DIY 组合冒烟矩阵 + fixture 全量走 HTTP，见 ticket 09 与地图 Not yet specified。） */
import { join, resolve } from 'node:path';
import { renderCard } from '@yoggshade/renderer/render-card';
import { fsSource } from '@yoggshade/renderer/source-fs';
import type { FixtureCard } from '@yoggshade/renderer/plan';
import { encodePngBytes } from '@yoggshade/renderer/image';
import { CardRequestError, prepareCard } from '../src/adapter.js';
import { loadPresets } from '../src/meta.js';
import type { RenderRequest } from '../src/shared.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const DIRS = { pack: fsSource(join(repoRoot, 'assets')), data: fsSource(join(repoRoot, 'data')) };

/** 每个帧槽一张代表卡（覆盖全部帧槽；战棋模板另取一张）。
 *  佣兵四槽（2026-10-11 特性收尾补入）：卡面结构与 tag 组合判定全走专属帧后，
 *  adapter 往返也必须逐位一致——尤其 name 的 builder 链（{0} 占位）与攻血 GetTag 口径。 */
const SLOT_REPS = [
  'GDB_142', // hand-minion
  'TOY_519', // hand-spell
  'BG30_802', // hand-spell（战棋模板）
  'LOOT_392', // hand-weapon
  'AV_205', // hand-hero
  'AV_205p', // hand-heropower
  'TTN_090', // hand-location
  'BG27_Anomaly_580', // hand-bg-anomaly
  'BG32_MagicItem_350', // hand-bg-trinket
  'LT23_802P2', // hand-lettuce-ability（含攻血 0 复刻 + 学派板）
  'LT24_021T1_01c', // hand-lettuce-ability-minion（攻血真值 5/20）
  'LT23_036E2_04', // hand-lettuce-equipment（名字 {0} builder 链）
  'LT23_816H', // hand-mercenary（角色图集/阵营旗/等级）
  'TIME_EVENT_999', // hand-spell-golden
  'JAIL_321', // hand-minion-golden
  'JAIL_450', // hand-weapon-golden
  'WW_0700', // hand-hero-golden
  'JAIL_887', // hand-location-golden
  'RLK_706', // hand-minion-sig1
  'WW_373', // hand-minion-sig2
  'GDB_477', // hand-minion-sig9
  'TLC_433', // hand-spell-sig10
  'SC_754', // hand-hero-sig11
  'TLC_EVENT_402', // hand-weapon-sig12
  'TIME_446', // hand-location-sig13
  'SC_400', // hand-hero; ordinary multiclass hero
  'CATA_190h', // hand-hero-sig14; multiclass hero SIGNATURE
];

function fixtureOf(cardId: string): FixtureCard {
  return JSON.parse(DIRS.data.text(`fixtures/${cardId}.json`)) as FixtureCard;
}

/** 模拟前端：把 meta 的预设字段原样提交回来（文案不动 → 应保留原 textBuilderType） */
function requestOf(cardId: string): RenderRequest {
  const p = loadPresets(DIRS.data, DIRS.pack).find(x => x.cardId === cardId);
  if (!p) throw new Error(`预设不存在：${cardId}`);
  return { ...p.fields, presetId: cardId, name: p.name, text: p.text };
}

let failures = 0;
for (const cardId of SLOT_REPS) {
  const anchor = await renderCard({ fixture: fixtureOf(cardId) }, DIRS);
  const { fixture, portrait } = prepareCard(requestOf(cardId), DIRS);
  const viaSite = await renderCard({ fixture, portrait }, DIRS);
  const same = anchor.png.length === viaSite.png.length
    && anchor.png.every((b, i) => b === viaSite.png[i]);
  if (!same) failures++;
  console.log(
    `${same ? '逐位一致' : '有差异！'}  ${cardId.padEnd(20)} slot=${anchor.slot.padEnd(16)}`
    + ` 锚点 ${anchor.ms}ms / 站点 ${viaSite.ms}ms`,
  );
}

// 空白 DIY 卡没有 `-golden` 预合成图：已上传原画仍应通过普通肖像材质配金框输出。
const diyPortrait = encodePngBytes(1, 1, Uint8Array.from([180, 120, 40, 255]));
const diyRequest: RenderRequest = {
  premium:     'GOLDEN', cardType:    4, classTag:    12, rarity:      1,
  cost:        1, attack:      1, health:      1, armor:       0, elite:       false, race:        0, school:      0,
  mercenary:   false, mercRole:    0, mercFaction: 0, lettuceForm: 0,
  name:        '自定义金卡', text:        '',
  portrait:    `data:image/png;base64,${Buffer.from(diyPortrait).toString('base64')}`,
};
const diyPrepared = prepareCard(diyRequest, DIRS);
const diyRendered = await renderCard(diyPrepared, DIRS);
const diyPassed = diyPrepared.fixture.preset.premium === 'GOLDEN'
  && diyRendered.slot === 'hand-minion-golden';
if (!diyPassed) failures++;
console.log(`${diyPassed ? '金卡 DIY 可渲' : '金卡 DIY 失败'}  无专属卡图使用上传原画 + ${diyRendered.slot}`);

// SIGNATURE 只允许选择带已移植帧的原始预设；空白 DIY、未移植帧与错卡型请求均由 adapter 拒绝。
let diySignatureRejected = false;
try {
  prepareCard({ ...diyRequest, premium: 'SIGNATURE' }, DIRS);
} catch (error) {
  diySignatureRejected = error instanceof CardRequestError;
}
const supportedSignaturePreset = loadPresets(DIRS.data, DIRS.pack)
  .find(p => p.cardId === 'GDB_477');
const availableSignaturePresets = loadPresets(DIRS.data, DIRS.pack)
  .filter(p => p.signatureAvailable);
const eligibleSignaturePresetsAccepted = availableSignaturePresets.every(p => {
  const prepared = prepareCard({ ...requestOf(p.cardId), premium: 'SIGNATURE' }, DIRS);
  return prepared.fixture.preset.premium === 'SIGNATURE';
});
let mismatchedSignatureRejected = false;
try {
  prepareCard({ ...requestOf('GDB_477'), cardType: 5 }, DIRS);
} catch (error) {
  mismatchedSignatureRejected = error instanceof CardRequestError;
}
const signaturePassed = diySignatureRejected && supportedSignaturePreset?.signatureAvailable
  && eligibleSignaturePresetsAccepted && mismatchedSignatureRejected;
if (!signaturePassed) failures++;
console.log(`${signaturePassed ? '异画预设限制通过' : '异画预设限制失败'}  可用预设 ${availableSignaturePresets.length} 张均接受；空白卡和错卡型均拒绝`);

// DIAMOND 预设只作为普通品质底稿载入，显式提交 DIAMOND 则由 adapter 拒绝。
const diamondPreset = loadPresets(DIRS.data, DIRS.pack).find(p => p.cardId === 'TTN_850');
let diamondRequestRejected = false;
try {
  prepareCard({ ...diyRequest, premium: 'DIAMOND' }, DIRS);
} catch (error) {
  diamondRequestRejected = error instanceof CardRequestError;
}
const diamondPassed = diamondPreset?.premium === 'DIAMOND'
  && diamondPreset.fields.premium === 'NORMAL'
  && diamondRequestRejected;
if (!diamondPassed) failures++;
console.log(`${diamondPassed ? '钻石保持锁定' : '钻石锁定校验失败'}  预设以普通品质加载，显式请求被拒绝`);

console.log(failures === 0
  ? `\n全部 ${SLOT_REPS.length} 张逐位一致。`
  : `\n${failures} / ${SLOT_REPS.length} 张不一致。`);
process.exit(failures === 0 ? 0 : 1);
