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
import { fsSource } from '@yoggshade/renderer/source';
import type { FixtureCard } from '@yoggshade/renderer/plan';
import { prepareCard } from '../src/adapter.js';
import { loadPresets } from '../src/meta.js';
import type { RenderRequest } from '../src/shared.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const DIRS = { pack: fsSource(join(repoRoot, 'assets')), data: fsSource(join(repoRoot, 'data')) };

/** 每个帧槽一张代表卡（覆盖 8 槽；战棋模板另取一张） */
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

console.log(failures === 0
  ? `\n全部 ${SLOT_REPS.length} 张逐位一致。`
  : `\n${failures} / ${SLOT_REPS.length} 张不一致。`);
process.exit(failures === 0 ? 0 : 1);
