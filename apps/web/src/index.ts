/** 卡图网站（@yoggshade/web）。
 *
 * 形态（ADR-0002，2026-10-09 裁定）：纯前端站点——渲染链在用户浏览器内跑
 * （@yoggshade/renderer 经 vite 打包进前端产物），资产与冻结数据作为同源静态文件
 * 下发（/pack/**、/data/**），无 Worker/API 计算面。
 * 入口：src/main.tsx（React）；渲染管线：src/render-client.ts；
 * 部署：wrangler assets（dist/ = build-worker.ts 产物）。 */
export {};
