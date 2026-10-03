# ADR-0001: 渲染验收数据源 = exporter 基准 pivot 双固化

日期：2026-10-03。状态：已接受。

## 背景

TS 离线渲染链（本仓）的移植目标是对齐 `../exporter`（游戏内导出器）的全部协议行为
（见 `explore/exporter-port-checklist-commits.md`）。原 Phase 1 计划需要"真实卡牌数据源"
（候选：Blizzard API / hearth-sight PG / exporter 机直出 DBF），用于支撑任意卡的渲染。

手写 fixture 已造成过一次实际偏差（EX1_350 文本/种族与游戏不符）。

## 决策

**不接全量卡池数据库。采用 exporter 基准 pivot 双固化：**

1. **pivot 卡集合** = exporter 自己的基准体系，两个来源：
   - `CardPresets.md`（30 张）：每张卡用 Reason 字段锚定一类渲染行为
     （卡型 × premium × template × 符文/双职业/时空等机制）；
   - custom-glow 基准矩阵（12 卡型 token × buff/nerf）：全部位同图点亮，
     exporter 左右按钮各导一张。
2. **双固化进本仓**（版本随 templateVersion 锚定）：
   - **数据**：每张 pivot 卡按协议 renderModel 形状导出 canonical JSON
     （EntityDef tags + 本地化串 + renderMechanics 输入键）；
   - **基准图**：exporter 对同 pivot 的各变体导出 PNG，作为 L2 黄金参照逐张入库。
3. **纹理/网格等图像素材**：走既有拆包脚本（Python/UnityPy 提取层 → 版本化资产包，
   `assets/card-render-v1` 模式），不进 pivot 固化流程。

## 理由

- **验收同源**：exporter 的行为修复史（72 commits）就是用这套 pivot 验证的；
  pivot 一一对应 commit 级清单的验收条件，L2 diff 直接可解释。
- **规模纪律**：30 卡 + 24 glow 图 ≈ 一百多张基准，远小于全卡池；
  保真度验证不需要任意卡——需要的是行为矩阵覆盖，pivot 恰好按行为设计。
- **确定性**：协议要求等价请求等价输出；固定 pivot + 固定图 = 可重复的回归基线。
- **离线性**：无外部 API 依赖，Workers/CI 全离线可跑。

## 后果

- `.gitignore` 中 `assets/` 的忽略行按需移除（或改选择性跟踪），
  基准图与资产包进版本管理；暴雪版权资产仅存私有仓，不进分发路径（沿用既有纪律）。
- 新增行为（exporter 新 commit）→ 流程 = CardPresets 加行/扩 token → 重导 pivot 数据 +
  基准图 → TS 实现 → L2 验收。
- 任意卡渲染（DIY 场景）不受影响：文字/text-shaper 兜底本就支持任意文本；
  非 pivot 卡的完整渲染超出本阶段验收范围，留待有真实需求再接数据源。
- pivot 覆盖缺口（如某 renderMechanics 键无卡锚定）→ 按 exporter 惯例补预设行，
  而不是引入第二数据源。

## 关联

- `explore/roadmap.md` Phase 1（数据源阻塞已解除）
- `explore/exporter-port-checklist-commits.md`（验收条目）
