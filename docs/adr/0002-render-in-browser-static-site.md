# ADR-0002: 站点渲染位置 = 用户浏览器（纯静态部署）

日期：2026-10-09。状态：已接受（用户裁定）。

## 背景

站点渲染位置经历两次裁定：研究票 01 立项时以「**服务端出图、资产不出服务端**」为前提，
选定 Workers 进程内渲染；2026-10-08 内存实测推翻 CPU 假设后，票 14 在「Workers 内存改造
vs Containers vs 混合」中重裁，用户选 Workers spike（票 18 落地，位级等价门禁全过）。
前端渲染从未进入选项池——被票 01 的资产前提排除。

2026-10-09 Workers 链路上线时，emscripten 胶水在 workerd 连续暴露三类环境问题
（bundled 模块 `import.meta.url` 为 undefined 的两处顶层解引用崩溃、注入后仍未消除的
初始化挂起）。同时部署形态已经演变：`build-worker.ts` 把整个资产树（含 TTF 与
freetype.wasm）拷进 `dist/pack/**`，Workers Static Assets 对非 `/api/*` 路径直接发文件
——**资产事实上已经公开下发**，「资产不出服务端」前提名存实亡。

## 决策

**渲染链整体移到用户浏览器，站点退化为纯静态：**

1. `@yoggraph/renderer` 经 vite 打包进前端产物；浏览器内完成键派生 → 资产预取
   （`/pack/**`、`/data/**` 同源静态文件）→ `renderCard` 出图。
2. Worker 计算面整体退役：`worker.ts` / `api.ts` / `server.ts` / `src/ft/`（胶水补丁）
   删除；wrangler 改 assets-only 部署；限流（票 06 v1）、渲染队列、按请求预取、
   Workers Paid 门槛全部不再需要。
3. 渲染核心的 Node 依赖清除：`source.ts` 拆出 `source-fs.ts`（node:fs 归 CLI）、
   `image.ts` 弃 pngjs/node:zlib 改 fflate（解码 unzlibSync + 手写 unfilter 不变；
   编码手写 chunk + zlibSync）、`png-file.ts` 收容文件 IO；`adapter.ts` 的
   `Buffer.from(base64)` 改 atob。

## 理由

- **浏览器是 emscripten 的一等环境**：胶水零补丁直接跑，workerd 的三连环境问题
  （本次移植的全部阻塞）从根上消失。
- **成本归零**：服务端单卡 ~2.2s CPU（票 01 实测）使免费版 10ms CPU 上限不可用，
  Workers Paid（$5/月）是 Workers/Containers 两路线的共同底价；前端渲染后算力由
  用户设备承担，随用户数天然水平扩展。
- **资产暴露无增量**：部署形态已公开 `/pack/**`，前端渲染不额外暴露任何文件。
- **像素确定性不受影响**：同一 FreeType wasm 二进制 + 纯 JS 定点/整数管线，
  跨浏览器逐位一致；L2 验收锚点（ADR-0001）继续有效。

## 后果

- **首卡延迟换常驻零成本**：首次出图需下载 wasm（830KB）+ 字体 TTF + 帧纹理（MB 级）；
  浏览器 HTTP 缓存 + 标签页内预取 Map 缓解，后续渲染秒级。若不可接受，回头路径是
  票 14 的 Containers 选项（报价已留档）。
- **PNG 编码字节级锚点作废**：pngjs → 手写编码器后，渲染 PNG 与历史输出不再逐字节
  一致（deflate 实现差异）；无损编码像素不变，L2 像素判据不受影响。
  票 18/19 时代的字节级门禁仅对 CLI 侧重跑基线时需要重建认知。
- **验收形态变化**：CLI（`bun run render`）与浏览器共用同一渲染核心与同一 AssetSource
  抽象，站点出图与 L2 锚点不分叉的性质（ticket 09）保持；本地 dev 由 vite 中间件
  直供 `assets/`、`data/`。
- renderer 包的 `@zkl2333/freetype-wasm` 动态导入在 bun 与浏览器下都走包内默认胶水
  （wasmBinary 注入口不变）；workerd 专用的胶水补丁、注入器（`setFreeTypeLoader` /
  `registerInit`）一并删除。

## 关联

- `.scratch/diy-card-site/issues/01-workers-runtime-port.md`（原前提「资产不出服务端」自此废止）
- `.scratch/diy-card-site/issues/14-render-runtime-memory-vs-containers.md`（Containers 报价留档，
  为回头路径）
- `.scratch/diy-card-site/issues/10-deploy-and-ops.md`（部署形态改为 assets-only）
