/** 卡图网站骨架（框架待定）。

集成模型（推荐，见仓库规划）：渲染器以协议 v1（POST /render、GET /status）暴露为
独立 Worker，网站通过 service binding 调用；本包当前只是占位，等框架选定后填充。

渲染器以 workspace 包引入：@yoggraph/renderer（packages/renderer）。
资产包（assets/card-render-v1）与冻结数据（data/）不属于本包，部署时经 R2 或
Worker 静态资产注入渲染器，路径由 YOGGRAPH_PACK / YOGGRAPH_DATA 环境变量指定。
 */
export {};
