/** compare-reference — 生成图 × reference/ 基准图逐像素对比（L2 回归门）。
 *
 * 口径逐条同源 Angelia 已有设计（ur_compare.py / imgutil.py / ct_ledger.py，
 * ../Angelia/lab/2026-10-03-corpus-textless 与 ../Angelia/scripts；2026-10-04 用户裁定
 * 随渲染器 bun 工作流走、自 scripts/compare_reference.py 移植 TS）：
 *  - 载入即 α 合成黑底（α=0 垃圾区就此清除；uint8 截断语义同 numpy astype(uint8)）；
 *  - 可见域 vis = 基准图 α>0（引擎导出口径）；整卡 MAE = 可见域逐像素 max|ΔRGB|
 *    均值（round 3 半奇偶舍入同 Python round，空域 = NaN）；
 *  - 文字掩码 / 分区矩形 = ct_ledger.TEXT_MASK / ZONES 同表（512×768 exporter 取景
 *    空间，MINION/SPELL 两族；卡型映射 = TAG_CARDTYPE 4/47→MINION、5/40/42→SPELL，
 *    其余无表跳过）；
 *  - 热图 = |ΔRGB| 通道和 ×gain，黑→红→黄 LUT（imgutil.heat 同式），任一侧 α=0 置黑；
 *  - 位级 = RGBA 数组逐位相等（imgutil.png_bitwise 同式）。
 *
 * 用法：
 *   bun packages/renderer/src/compare-reference.ts                    # out/fixtures × reference/ 全量
 *   bun packages/renderer/src/compare-reference.ts --only GDB_142     # 单卡（可重复）
 *   bun packages/renderer/src/compare-reference.ts --baseline out/l2/summary.json   # 回归门
 * 产出 out/l2/：summary.json（NaN 写作 null，读回还原）+ 逐卡 {ID}_heat.png / {ID}_side.png。
 * --baseline 时逐卡逐键 ≤ 基线判定（NaN 视为相等；基线缺失的键跳过），有回归退出码 1。 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

// ct_ledger.TEXT_MASK / ZONES 同表（../Angelia/lab/2026-10-03-corpus-textless/scripts/ct_ledger.py:31-44）
const TEXT_MASK: Record<string, [number, number, number, number][]> = {
  SPELL:  [[30, 78, 200, 200], [95, 325, 415, 398], [85, 392, 428, 552], [175, 538, 340, 592]],
  MINION: [[50, 78, 175, 200], [79, 322, 437, 415], [96, 396, 418, 589],
    [46, 490, 171, 622], [354, 495, 454, 620], [107, 544, 396, 599]],
};
const ZONES: Record<string, Record<string, [number, number, number, number]>> = {
  SPELL: {
    cost:       [30, 78, 160, 200], art:        [75, 195, 437, 330], banner:     [95, 325, 415, 398],
    desc:       [85, 392, 428, 552], type_row:   [140, 530, 372, 600], rarity_gem: [225, 525, 290, 575],
  },
  MINION: {
    cost:       [50, 78, 175, 200], art:        [85, 200, 427, 325], banner:     [79, 322, 437, 415],
    desc:       [96, 396, 418, 589], attack:     [46, 490, 171, 622], health:     [354, 495, 454, 620],
    race:       [107, 544, 396, 599], rarity_gem: [230, 540, 285, 590],
  },
};

/** round 3，半奇偶舍入（Python round(x, 3) 同语义）。 */
function round3(x: number): number {
  const s = x * 1000;
  const f = Math.floor(s);
  const d = s - f;
  const r = d > 0.5
    ? f + 1
    : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
  return r / 1000;
}

interface Img { w: number, h: number, raw: Uint8Array, rgb: Uint8Array, alpha: Uint8Array }

/** α 合成黑底（imgutil.load_rgb_composited 同式；uint8 截断 = numpy astype(uint8)）。 */
function loadComposited(path: string): Img {
  const png = PNG.sync.read(readFileSync(path));
  const { width: w, height: h, data: raw } = png;
  const n = w * h;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = raw[i * 4 + 3];
    alpha[i] = a;
    rgb[i * 3] = Math.trunc(raw[i * 4] * a / 255);
    rgb[i * 3 + 1] = Math.trunc(raw[i * 4 + 1] * a / 255);
    rgb[i * 3 + 2] = Math.trunc(raw[i * 4 + 2] * a / 255);
  }
  return { w, h, raw, rgb, alpha };
}

/** ct_ledger.mae 同式：可见域（∩rect）逐像素 max|ΔRGB| 均值，round 3；空域 = NaN。 */
function mae(a: Uint8Array, b: Uint8Array, sel: Uint8Array, w: number, h: number,
  rect: [number, number, number, number] | null): number {
  let sum = 0, count = 0;
  const x0 = rect ? rect[0] : 0, y0 = rect ? rect[1] : 0;
  const x1 = rect ? rect[2] : w - 1, y1 = rect ? rect[3] : h - 1;
  for (let y = Math.max(y0, 0); y <= Math.min(y1, h - 1); y++) {
    for (let x = Math.max(x0, 0); x <= Math.min(x1, w - 1); x++) {
      const i = y * w + x;
      if (!sel[i]) continue;
      const d = Math.max(Math.abs(a[i * 3] - b[i * 3]),
        Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
      sum += d;
      count++;
    }
  }
  return count ? round3(sum / count) : NaN;
}

// imgutil._lut 同式：黑→红→黄；numpy linspace 终点强制、uint8 赋值截断。
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 128; i++) {
  LUT[i * 3] = Math.trunc(i * 255 / 127);
  LUT[i * 3 + 1] = Math.trunc((i * 255 / 127) ** 2 / 255);
}
for (let i = 0; i < 128; i++) {
  LUT[(128 + i) * 3] = 255;
  LUT[(128 + i) * 3 + 1] = Math.trunc(255 + i * (60 - 255) / 127);
  LUT[(128 + i) * 3 + 2] = Math.trunc((i * 128 / 127) ** 2 / 128);
}

/** imgutil.heat 同式：|ΔRGB| 通道和 ×3 → LUT；任一侧 α=0 的像素置黑（双掩码）。 */
function heat(a: Uint8Array, b: Uint8Array, dualMask: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = dualMask[i] === 0
      ? 0
      : Math.min(255, (Math.abs(a[i * 3] - b[i * 3])
        + Math.abs(a[i * 3 + 1] - b[i * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[i * 3 + 2])) * 3);
    out[i * 3] = LUT[v * 3];
    out[i * 3 + 1] = LUT[v * 3 + 1];
    out[i * 3 + 2] = LUT[v * 3 + 2];
  }
  return out;
}

/** TAG_CARDTYPE → 分区表族（plan.ts CARD_TYPE_TO_SLOT 同映射方向）：4/47→MINION、5/40/42→SPELL。 */
function cardFamily(dataDir: string, cardId: string): string | null {
  let tags: Record<string, number>;
  try {
    tags = (JSON.parse(readFileSync(join(dataDir, `${cardId}.json`), 'utf-8')) as { tags?: Record<string, number> }).tags ?? {};
  } catch {
    return null;
  }
  const ct = tags['202'] ?? 4;
  if (ct === 4 || ct === 47) return 'MINION';
  if (ct === 5 || ct === 40 || ct === 42) return 'SPELL';
  return null;
}

interface Row { [key: string]: number | boolean | undefined }

/** ur_compare.verdict_row 同式：逐键 ≤ 判定（NaN 视为相等；基线缺失的键跳过）。 */
function verdictRow(cand: Row, base: Row): { pass: boolean, regressions: { zone: string, cand: number, base: number, delta: number }[] } {
  const regressions: { zone: string, cand: number, base: number, delta: number }[] = [];
  for (const [k, v] of Object.entries(cand)) {
    if (typeof v !== 'number' || typeof base[k] !== 'number') continue;
    const bv = base[k] as number;
    const ok = (Number.isNaN(v) && Number.isNaN(bv)) || v <= bv + 1e-9;
    if (!ok) regressions.push({ zone: k, cand: v, base: bv, delta: round3(v - bv) });
  }
  return { pass: !regressions.length, regressions };
}

// ---- CLI ----
let renderedDir = join(REPO, 'out', 'fixtures');
let referenceDir = join(REPO, 'reference');
let dataDir = join(REPO, 'data', 'fixtures');
let outDir = join(REPO, 'out', 'l2');
let baselinePath: string | undefined;
let noArtifacts = false;
const only: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--rendered') renderedDir = process.argv[++i];
  else if (a === '--reference') referenceDir = process.argv[++i];
  else if (a === '--data') dataDir = process.argv[++i];
  else if (a === '--out') outDir = process.argv[++i];
  else if (a === '--baseline') baselinePath = process.argv[++i];
  else if (a === '--only') only.push(process.argv[++i]);
  else if (a === '--no-artifacts') noArtifacts = true;
}

mkdirSync(outDir, { recursive: true });
const ids = readdirSync(referenceDir).filter(f => f.endsWith('.png'))
  .map(f => f.slice(0, -4))
  .filter(id => !only.length || only.includes(id))
  .sort();

const rows: Record<string, Row> = {};
const skipped: string[] = [];
for (const cid of ids) {
  const candPng = join(renderedDir, `${cid}.png`);
  const refPng = join(referenceDir, `${cid}.png`);
  let cand: Img;
  try {
    cand = loadComposited(candPng);
  } catch {
    skipped.push(cid);
    continue;
  }
  const ref = loadComposited(refPng);
  if (cand.w !== ref.w || cand.h !== ref.h) {
    console.log(`[size] ${cid}: ${cand.w}x${cand.h} vs ${ref.w}x${ref.h} —— 跳过`);
    continue;
  }
  const n = cand.w * cand.h;
  const vis = new Uint8Array(n);
  for (let i = 0; i < n; i++) vis[i] = ref.alpha[i] > 0 ? 1 : 0;
  const row: Row = { mae_visible: mae(cand.rgb, ref.rgb, vis, cand.w, cand.h, null) };
  const family = cardFamily(dataDir, cid);
  if (family && TEXT_MASK[family]) {
    const tmask = new Uint8Array(n);
    for (const [x0, y0, x1, y1] of TEXT_MASK[family]) {
      for (let y = y0; y <= y1; y++) tmask.fill(1, y * cand.w + x0, y * cand.w + x1 + 1);
    }
    const nontext = new Uint8Array(n);
    for (let i = 0; i < n; i++) nontext[i] = vis[i] && !tmask[i] ? 1 : 0;
    row.mae_nontext = mae(cand.rgb, ref.rgb, nontext, cand.w, cand.h, null);
  }
  for (const [zn, rect] of Object.entries(ZONES[family ?? ''] ?? {})) {
    row[`z_${zn}`] = mae(cand.rgb, ref.rgb, vis, cand.w, cand.h, rect);
  }
  row.bitwise_equal = cand.raw.length === ref.raw.length && cand.raw.every((v, i) => v === ref.raw[i]);
  rows[cid] = row;

  if (!noArtifacts) {
    const dualMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) dualMask[i] = ref.alpha[i] === 0 || cand.alpha[i] === 0 ? 0 : 1;
    const hm = heat(cand.rgb, ref.rgb, dualMask, n);
    const heatPng = new PNG({ width: cand.w, height: cand.h });
    for (let i = 0; i < n; i++) {
      heatPng.data[i * 4] = hm[i * 3];
      heatPng.data[i * 4 + 1] = hm[i * 3 + 1];
      heatPng.data[i * 4 + 2] = hm[i * 3 + 2];
      heatPng.data[i * 4 + 3] = 255;
    }
    writeFileSync(join(outDir, `${cid}_heat.png`), PNG.sync.write(heatPng));
    const side = new PNG({ width: cand.w * 2, height: cand.h });
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        side.data[i * 4 + c] = ref.rgb[i * 3 + c];
        side.data[(i + cand.w) * 4 + c] = cand.rgb[i * 3 + c];
      }
      side.data[i * 4 + 3] = 255;
      side.data[(i + cand.w) * 4 + 3] = 255;
    }
    writeFileSync(join(outDir, `${cid}_side.png`), PNG.sync.write(side));
  }
}

const maeKey = (id: string): number => (Number.isNaN(rows[id].mae_visible as number) ? -Infinity : rows[id].mae_visible as number);
const order = Object.keys(rows).sort((a, b) => maeKey(b) - maeKey(a));
console.log('card'.padEnd(18) + 'mae_vis'.padStart(8) + 'mae_nontext'.padStart(12) + 'worst_zone'.padStart(23) + 'bitwise'.padStart(9));
for (const cid of order) {
  const r = rows[cid];
  let worst: string | null = null;
  for (const k of Object.keys(r)) {
    if (!k.startsWith('z_')) continue;
    const v = r[k] as number;
    if (!Number.isNaN(v) && (worst === null || v > (r[worst] as number))) worst = k;
  }
  const nt = r.mae_nontext === undefined ? '-' : (r.mae_nontext as number).toFixed(3);
  const worstS = worst ? `${worst.slice(2)}=${r[worst]}` : '-';
  console.log(cid.padEnd(18) + (r.mae_visible as number).toFixed(3).padStart(8) + nt.padStart(12)
    + worstS.padStart(23) + String(r.bitwise_equal).padStart(9));
}

// NaN → null（JSON 无 NaN），读回时还原，保证基线往返
const summary = JSON.stringify(rows, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? null : v), 1);
writeFileSync(join(outDir, 'summary.json'), summary + '\n');
console.log(`[done] ${Object.keys(rows).length} 卡 → ${join(outDir, 'summary.json')}`);
if (skipped.length) console.log(`[skip] 生成图缺失 ${skipped.length} 张: ${skipped.join(', ')}`);

if (baselinePath) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf-8'), (_k, v) => (v === null ? NaN : v)) as Record<string, Row>;
  const regressions: string[] = [];
  for (const [cid, r] of Object.entries(rows)) {
    if (!(cid in base)) continue;
    const v = verdictRow(r, base[cid]);
    if (!v.pass) {
      regressions.push(`[regress] ${cid}: ` + v.regressions.map(b => `${b.zone} ${b.base}→${b.cand} (+${b.delta})`).join(', '));
    }
  }
  if (regressions.length) {
    for (const line of regressions) console.log(line);
    process.exit(1);
  }
  console.log('[gate] 无回归');
}
