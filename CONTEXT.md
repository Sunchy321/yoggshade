# CONTEXT.md

本文件是本仓的**长期记忆与术语表**：只记领域词汇与口径，不记实现细节。
实现细节在代码与 findings 文档；决策记录在 `docs/adr/`。

## 术语表

### fixture（输入侧）

双固化的输入半边：`data/fixture.md` 成员表（唯一编辑入口）+ `data/fixtures/*.json`
（每张卡的 canonical renderModel JSON）。fixture 一词**只指输入**——卡集合与请求定义；
来源是 exporter 基准体系（CardPresets 30 张 + glow 基准矩阵 12 卡型 token），见 ADR-0001。

### 基准图 / golden image（输出侧）

`reference/*.png`：exporter 对同 fixture 各变体游戏内导出的期望输出，L2 diff 的参照，
随 templateVersion 锚定。目录名 `reference/` 与 `bun run l2`（compare-reference，
"reference comparison gate"）里的 reference 都指它。

**消歧**：本仓 "golden" 另有两个无关用法，勿混淆——

- **GOLDEN premium**：金卡（卡面品质之一）；金卡样例只是基准图中的一张（TIME_EVENT_999）；
- **py 黄金链（golden chain）**：L1 的参照链（`explore/hs-render/`），指"权威参照"这一含义，
  与基准图不是同一东西（L1 vs py 链，L2 vs 基准图）。

### 双固化（ADR-0001）

fixture 数据 JSON + 基准图 PNG 成对冻结入库，不接全量卡池数据库；
新增行为 = fixture.md 加行 → 重导数据与基准图 → TS 实现 → L2 验收。

### L1 / L2

- **L1**：TS 渲染链 vs py 黄金链的离线一致性 diff（`bun run render` + `bun run diff`）。
  py 链是参照，不是同步目标。
- **L2**：TS 渲染链 vs 基准图的验收 diff（`bun run l2`）。fixture 集合是验收锚点，
  移植行为的验收 = 对同一请求的基准图做 L2 diff。

## 命名口径（2026-10-05 定）

不改动既有路径与代码；用词分工固定为：**fixture = 输入，基准图（golden image）= 输出**。
提到图片时说"基准图"，不再用 fixture 泛指图片；"N 张 fixtures"指 N 对（JSON + PNG）。
