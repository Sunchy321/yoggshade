/** 静态站点构建（ADR-0002 前端渲染）：vite build 前端 + 组装静态资产树 + 生成资产清单。
 *
 * 产出 dist/：
 *   dist/<vite 产物>            —— 前端（index.html + JS/CSS；渲染链在浏览器内跑）
 *   dist/pack/**                —— 资产树（assets/ 拷贝；含 TTF 与 freetype.wasm——
 *                                  浏览器端 FreeType WASM 直渲 TTF，ticket 15 Answer）
 *   dist/data/**                —— 冻结数据（data/ 的 JSON 拷贝）
 *   src/asset-manifest.json     —— 已知键清单（render-client 的 has() 语义 = 构建清单）
 *
 * 用法：bun apps/web/scripts/build-worker.ts（先 vite build，再拷贝再生成清单） */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // 提取字形已退役（ticket 15 Answer：FreeType WASM 直渲 TTF）——不进部署包
    if (rel.startsWith('glyphs/')) return false;
    return true;
  },
});
// FreeType WASM 后端二进制 → 资产树（浏览器渲染时经资产源取 pack/fonts/freetype.wasm
// 注入 wasmBinary；ADR-0002 前端渲染，workerd 胶水补丁链路已随 worker.ts 退役）
mkdirSync(join(dist, 'pack', 'fonts'), { recursive: true });
cpSync(join(repoRoot, 'packages/renderer/node_modules/@zkl2333/freetype-wasm/dist/freetype.wasm'),
  join(dist, 'pack', 'fonts', 'freetype.wasm'));
cpSync(join(repoRoot, 'data'), join(dist, 'data'), {
  recursive: true,
  filter:    src => /\.(json)$/.test(src) || statSync(src).isDirectory(),
});

// 3. 资产清单（相对 dist 的 posix 键；Worker 的 has() 与预取都认它）
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
