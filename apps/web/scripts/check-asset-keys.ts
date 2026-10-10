/** 精确预取键集充分性门禁：对 fixture 全量矩阵，仅以 collectRenderAssetKeys 的键集
 *  hydrate mapSource 跑全链渲染（p2）。任何 KeyMissingError = 键集缺口，即失败。
 *
 * 判据链：收集器与 renderCard 共用同一装配序列（loadStaticData → loadPack →
 * compileFramePlan），键枚举逐点镜像渲染端读取（keys.ts 文件头清单）；本门禁证明
 * 「收集器键集 ⊇ 渲染读取集」在全部 fixture（8 槽 × premium/模板变体）上成立。
 *
 * 用法：bun apps/web/scripts/check-asset-keys.ts
 * 已知盲区（不影响结论）：字体 metrics/freetype 后端有进程级缓存，跨 fixture 复用
 * 会遮蔽重复读取——但字体键由收集器按 fontdefs 确定性输出，不依赖实测。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderCard } from '@yoggraph/renderer/render-card';
import { fsSource } from '@yoggraph/renderer/source-fs';
import { mapSource, KeyMissingError } from '@yoggraph/renderer/source';
import { collectRenderAssetKeys } from '@yoggraph/renderer/keys';

const repoRoot = resolve(import.meta.dir, '../../..');
const disk = {
  pack: fsSource(join(repoRoot, 'assets')),
  data: fsSource(join(repoRoot, 'data')),
};

function hydrate(dir: 'pack' | 'data', keys: readonly string[]): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const k of keys) {
    try {
      m.set(k, disk[dir].bytes(k));
    } catch { /* 缺省键（如 DIY 原画）不 hydrate，mapSource.has 语义与清单一致 */ }
  }
  return m;
}

const fixtures = readdirSync(join(repoRoot, 'data/fixtures'))
  .filter(f => f.endsWith('.json') && f !== 'manifest.json')
  .sort();
let fail = 0;
const rows: string[] = [];
let sumBytes = 0;

for (const f of fixtures) {
  const cardId = f.replace(/\.json$/, '');
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'data/fixtures', f), 'utf-8'));
  const keys = collectRenderAssetKeys({ fixture }, disk);
  const mem = {
    pack: mapSource(hydrate('pack', keys.pack)),
    data: mapSource(hydrate('data', keys.data)),
  };
  let packBytes = 0;
  for (const k of keys.pack) {
    try {
      packBytes += statSync(join(repoRoot, 'assets', k)).size;
    } catch { /* 缺省键 */ }
  }
  sumBytes += packBytes;
  try {
    const res = await renderCard({ fixture, stage: 'p2' }, mem);
    rows.push(`✓ ${cardId.padEnd(22)} slot=${res.slot.padEnd(16)} 键=${String(keys.pack.length).padStart(3)} pack=${(packBytes / 1048576).toFixed(2)}MB ${res.ms}ms`);
  } catch (err) {
    fail++;
    const miss = err instanceof KeyMissingError ? ` 缺键=${err.key}` : '';
    rows.push(`✗ ${cardId.padEnd(22)} ${err instanceof Error ? err.message : err}${miss}`);
  }
}

console.log(rows.join('\n'));
console.log(`\n${fixtures.length} 张 fixture：${fail > 0 ? `${fail} 张失败` : '全部通过'}；平均 pack 键集 ${(sumBytes / fixtures.length / 1048576).toFixed(2)}MB`);
if (fail > 0) process.exit(1);
