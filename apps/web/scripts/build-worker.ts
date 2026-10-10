/** Workers 部署构建（ticket 10）：vite build 前端 + 组装静态资产树 + 生成资产清单。
 *
 * 产出 dist/：
 *   dist/<vite 产物>            —— 前端（index.html + JS/CSS）
 *   dist/pack/**                —— 资产包（assets/ 拷贝；**剔除 *.ttf**——18MB 字体不进
 *                                  部署包：字形 fallback 会触发整字体 parse（实测驻留
 *                                  60-80 MB），Workers 上按 fail-fast 语义映射 400，
 *                                  正式裁定归 ticket 15；metrics.json 保留供惰性度量）
 *   dist/pack/glyphs.bin        —— **全部字形 PNG 顺序拼接**（wrangler dev 对 1.3 万
 *                                  散文件的资产注册会 spawn EBADF，实测）；Worker 侧
 *                                  按 src/glyph-index.json 的 [offset,len] 取片段
 *   dist/data/**                —— 冻结数据（data/ 的 JSON 拷贝）
 *   src/asset-manifest.json     —— 已知键清单（Worker 的 has() 语义 = 构建清单）
 *   src/glyph-needed.json       —— 40 张 fixture 经 textBuilder 解析后的文本字符集
 *                                  （builder 会改写文本 → 逐字符派生的盲区，构建期算死）
 *
 * 用法：bun apps/web/scripts/build-worker.ts（先 vite build，再拷贝再生成清单） */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const webRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(webRoot, '../..');
const dist = join(webRoot, 'dist');

// 1. vite build（前端）
Bun.spawnSync({ cmd: ['bun', 'x', 'vite', 'build'], cwd: webRoot, stdout: 'inherit', stderr: 'inherit' });
if (!existsSync(join(dist, 'index.html'))) {
  console.error('[fail] vite build 未产出 dist/index.html');
  process.exit(1);
}

// 2. 资产树组装
rmSync(join(dist, 'pack'), { recursive: true, force: true });
rmSync(join(dist, 'data'), { recursive: true, force: true });
cpSync(join(repoRoot, 'assets'), join(dist, 'pack'), {
  recursive: true,
  filter:    src => {
    const rel = relative(join(repoRoot, 'assets'), src).split('\\').join('/');
    if (rel.startsWith('fonts/') && rel.endsWith('.ttf')) return false; // TTF 不进部署包
    if (rel.startsWith('glyphs/') && rel.endsWith('.png')) return false; // 字形走 glyphs.bin
    return true;
  },
});
cpSync(join(repoRoot, 'data'), join(dist, 'data'), {
  recursive: true,
  filter:    src => /\.(json)$/.test(src) || statSync(src).isDirectory(),
});

// 3. 字形库：assets/glyphs/** 的 PNG 顺序拼接 → dist/pack/glyphs.bin；索引 → src/glyph-index.json
const glyphIndex: Record<string, [number, number]> = {};
{
  const parts: Uint8Array[] = [];
  let off = 0;
  const glyphsRoot = join(repoRoot, 'assets', 'glyphs');
  for (const p of walk(glyphsRoot)) {
    const rel = relative(glyphsRoot, p).split('\\').join('/');
    const key = `glyphs/${rel}`;
    const b = readFileSync(p);
    glyphIndex[key] = [off, b.byteLength];
    parts.push(b);
    off += b.byteLength;
  }
  writeFileSync(join(dist, 'pack', 'glyphs.bin'), Buffer.concat(parts));
  writeFileSync(join(webRoot, 'src', 'glyph-index.json'), JSON.stringify(glyphIndex));
  console.log(`[glyphs.bin] ${Object.keys(glyphIndex).length} entries, ${(off / 1048576).toFixed(1)} MB`);
}

// 4. builder 解析后文本字符集（40 fixtures 全量解析；builder 机制重建的文本字符在
//    逐字符派生之外，构建期算死补盲）
{
  const { resolveFixtureText } = await import('@tcg-cards/hs-text-builder');
  const fxDir = join(repoRoot, 'data', 'fixtures');
  const cps = new Set<number>();
  for (const f of readdirSync(fxDir)) {
    if (!f.endsWith('.json') || f === 'manifest.json') continue;
    const card = JSON.parse(readFileSync(join(fxDir, f), 'utf-8')) as Parameters<typeof resolveFixtureText>[0];
    const resolved = resolveFixtureText(card, 'zhCN', card.cardId).text;
    for (const ch of resolved.replace(/<\/?[bi]>/g, '')) cps.add(ch.codePointAt(0)!);
  }
  writeFileSync(join(webRoot, 'src', 'glyph-needed.json'), JSON.stringify([...cps].sort((a, b) => a - b)));
  console.log(`[glyph-needed] ${cps.size} 码点`);
}

// 5. 资产清单（相对 dist 的 posix 键；Worker 的 has() 与预取都认它）
const keys: string[] = [];
for (const p of walk(dist)) {
  if (p.includes(`${sep()}node_modules`)) continue;
  const rel = relative(dist, p).split('\\').join('/');
  if (rel.startsWith('pack/') || rel.startsWith('data/')) keys.push(rel);
}
keys.sort();
mkdirSync(join(webRoot, 'src'), { recursive: true });
writeFileSync(join(webRoot, 'src', 'asset-manifest.json'), JSON.stringify(keys));

console.log(`[done] dist/ 组装完成；asset-manifest 键数 = ${keys.length}`);

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
