/** 静态站点构建（ADR-0002 前端渲染）：vite build 前端 + 组装静态资产树 + 生成资产清单。
 *
 * 产出 dist/：
 *   dist/<vite 产物>            —— 前端（index.html + JS/CSS；渲染链在浏览器内跑）
 *   dist/pack/**                —— 资产树（assets/ 拷贝；含 TTF 与 freetype.wasm——
 *                                  浏览器端 FreeType WASM 直渲 TTF，ticket 15 Answer）
 *   dist/data/**                —— 冻结数据（data/ 的 JSON 拷贝）
 *   dist/_headers               —— 静态层缓存规则（/pack、/data、/assets 长 immutable；
 *                                  失配保护 = 资产内容哈希版本 ?v=，见下）
 *   src/asset-manifest.json     —— 已知键清单（render-client 的 has() 语义 = 构建清单）
 *   src/asset-version.ts        —— pack+data 内容哈希（render-client 预取 URL 的 ?v=；
 *                                  内容变 → URL 变 → immutable 缓存不背旧资产）
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

// 3. 资产清单 + 内容哈希版本（相对 dist 的 posix 键；Worker 的 has() 与预取都认它）
const entries: { rel: string, path: string }[] = [];
for (const p of walk(dist)) {
  if (p.includes(`${sep()}node_modules`)) continue;
  const rel = relative(dist, p).split('\\').join('/');
  if (rel.startsWith('pack/') || rel.startsWith('data/')) entries.push({ rel, path: p });
}
entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const keys = entries.map(e => e.rel);
// 版本摘要 = 排序后逐文件（相对路径 + 内容）→ 同内容同哈希
const hasher = new Bun.CryptoHasher('blake2b256');
for (const e of entries) {
  hasher.update(e.rel);
  hasher.update(readFileSync(e.path));
}
hasher.update(keys.join('\n'));
const assetVersion = hasher.digest('hex').slice(0, 16);
mkdirSync(join(webRoot, 'src'), { recursive: true });
writeFileSync(join(webRoot, 'src', 'asset-manifest.json'), JSON.stringify(keys));
writeFileSync(join(webRoot, 'src', 'asset-version.ts'),
  `/** 构建期生成（scripts/build-worker.ts）：pack+data 内容哈希前 16 hex。\n` +
  ` *  render-client 预取 URL 以 ?v=${assetVersion} 携带——资产内容变则版本变，\n` +
  ` *  immutable 缓存（dist/_headers）因此不背旧资产。勿手改。 */\n` +
  `export const ASSET_VERSION = '${assetVersion}';\n`);

// 4. 静态层缓存规则：_headers（Workers Static Assets 原生支持，Pages 同语法）
writeFileSync(join(dist, '_headers'), [
  '# 静态层缓存策略（配合 render-client 的 ?v= 内容版本）：',
  '# /pack、/data 版本 = pack+data 内容哈希（src/asset-version.ts）——内容变 → URL 变 →',
  '# 新 URL 全新抓取，旧条目自然过期，immutable 因此安全；/assets/* 为 vite 哈希文件名，',
  '# 同理。index.html 无规则 = 默认 ETag 协商，新部署即时可见。',
  '/pack/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '/data/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
].join('\n'));

console.log(`[done] dist/ 组装完成；asset-manifest 键数 = ${keys.length}；asset-version = ${assetVersion}`);

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
