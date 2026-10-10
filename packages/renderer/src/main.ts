/** 渲染 CLI（薄壳；渲染序列在 render-card.ts，与站点共用同一条链）：
 *  bun src/main.ts [packDir] [outPng] [stage]           —— 资产包内嵌 plan（EX1_350 基线）
 *  bun src/main.ts --card CARD_ID [--out out.png]       —— fixture 卡编译渲染（data/fixtures + data/tables）
 * stage: p0 = 帧+肖像；p1 = +宝石；p2 = +文字（全链，默认）
 * 路径注入：--pack/--data 或 YOGGRAPH_PACK/YOGGRAPH_DATA（默认相对 CWD：assets、data）。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPack, TextureStore } from './assets.js';
import { SIZE } from './camera.js';
import { encodePngBytes } from './image.js';
import { fsSource } from './source.js';
import { renderCard, renderPackToRgba8, type RenderStage } from './render-card.js';
import type { FixtureCard } from './plan.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hasFlags = process.argv.slice(2).some(a => a.startsWith('--'));
const packDefault = process.env.YOGGRAPH_PACK ?? 'assets';
const dataDir = arg('--data') ?? process.env.YOGGRAPH_DATA ?? 'data';
const packDir = arg('--pack') ?? (hasFlags ? packDefault : process.argv[2] ?? packDefault);
const cardId = arg('--card');
const outPng = arg('--out') ?? (cardId ? `out/ts_${cardId}.png` : hasFlags ? 'out/ts_p2.png' : process.argv[3] ?? 'out/ts_p2.png');
const stage = (arg('--stage') ?? (hasFlags ? 'p2' : process.argv[4] ?? 'p2')) as RenderStage;

const t0 = Date.now();
const fixtureFile = arg('--fixture-file');
const slotOverride = arg('--slot');
const dirs = { pack: fsSource(packDir), data: fsSource(dataDir) };
mkdirSync(dirname(outPng), { recursive: true });

if (cardId || fixtureFile) {
  const fixture = JSON.parse(
    dirs.data.text(fixtureFile ?? `fixtures/${cardId}.json`),
  ) as FixtureCard;
  const res = await renderCard({ fixture, slot: slotOverride, stage }, dirs);
  writeFileSync(outPng, res.png);
  console.log(JSON.stringify({
    out:         outPng,
    stage,
    card:        cardId ?? fixture.cardId,
    frame_nodes: res.frame_nodes,
    tris:        res.tris,
    slot:        res.slot,
    ms:          Date.now() - t0,
  }, null, 1));
} else {
  // 资产包内嵌 plan（历史 py export_asset_pack 产物）：无卡牌 delta，直接渲 plan.json
  const pack = loadPack(dirs.pack);
  const textures = new TextureStore(dirs.pack);
  const { rgba8, tris, frame_nodes } = await renderPackToRgba8(
    pack, textures, pack.plan!, dirs, stage);
  writeFileSync(outPng, encodePngBytes(SIZE[0], SIZE[1], rgba8));
  console.log(JSON.stringify({
    out:  outPng,
    stage,
    card: 'EX1_350(plan)',
    frame_nodes,
    tris,
    ms:   Date.now() - t0,
  }, null, 1));
}
