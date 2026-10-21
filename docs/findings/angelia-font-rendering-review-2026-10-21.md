# Angelia 最新字体研究对照（2026-10-21）

## 范围与结论

只读研究，不修改渲染器、资产、fixture、基准图或既有校准，不作架构决定。核对工作树：yoggshade HEAD `4810499`；Angelia HEAD `ab81c1c`。上游主账是 `../Angelia/lab/2026-10-17-text-rdc-align/`，目录日期虽为 10-17，记录已追加到 10-18 第十五轮；另核对 10-19 text-residual-batch、10-20 heropower-name-rtt、location-text-residual、text-last-composite 等。

**有大量可用成果，核心是采样、度量与 RTT 合成的机制证据。不能概括为“Python 全部文字已经 bit-exact”，也不能整包搬用其相位与基准。** 本地 Angelia 有日志、证据 JSON 与当前源码，但缺最新 `data/card-image/`、`data/full_cs/`、完整新图集和抓帧运行环境；上游 MAE 均为已保存研究报告的读数，本次未重跑。TS 部分为当前源码核对，未声称已得到本仓 L2 改善。

## 1. 两套基准不能直接比较

| 项目 | yoggshade | Angelia 本轮 |
|---|---|---|
| 相机/出图 | exporter FrameCamera，512×768 | SnapshotCamera / RenderDoc，512×707 |
| 世界到像素 | 192 px/u | 176.75 px/u |
| 取景锚 | frame_center，按主体网格；部分帧有 exporter 特例 | 上游 SnapshotCamera 同批次摆位 |
| 输入/语料 | ADR-0001 冻结 JSON + reference PNG | corpus_t/mode/style/variant 等组合，阶段间语料也变过 |
| 文字量测 | 本仓 L2 是合成黑底 RGB 的分区 max-channel MAE | textonly 派生 alpha、float alpha、RT 原始读回、origin 分区等多种域 |

原始反编译也可本机交叉核对：`explore/ilspy/Blizzard.T5.UberText.Runtime.decompiled.cs:2247-2297` 明确空载体走平面RTT及AA；`:5915` SetupMatrices 与 `:6268` SetTextMeshRenderToTextureTransform 均含±3000位置。它们支持机制判断，但不能证明本仓基准的底层shader与Windows抓帧逐指令相同。

本仓依据：`packages/renderer/src/camera.ts:1-17`、`plan.ts:1442` 起取景说明、`compare-reference.ts:1-15,82`；`docs/adr/0001-fixture-frozen-benchmark-data.md`。本次直接检查 `reference/{AV_205p,ETC_210,TTN_090}.png` PNG IHDR 均为 512×768。上游依据：text-rdc-align/NOTES.md 第一站、findings/float-truth.md §1。

上游 10-20 consumption-alignment-audit/NOTES.md 明确其活客户端/真值/decomp 为 **37.0.0 Build 254477**；不能假设与本仓冻结图和已提取资源同版本。未来任何移植验收须先核对字体文件/FontDef、prefab 字段、文本内容、卡型、premium/template、动画时刻和相机。

192/176.75≈1.08628 是世界投影密度比，**不等于把他们 PNG 拉伸即可得到我们的基准**：锚点、AA、RT 大小、量化和亚像素位置都影响结果。`COST_PHASE=-0.25`、数字附加 `1/64 px`、name `content_scale=0.95`（当前上游源码注称由 `1−m_ResizeToGrowStep` 推出）等都要核对本仓节点与同请求证据，不能当通用常数。

## 2. “像素级对齐”的准确边界

以下均为上游原文口径，alpha 误差以 0–255 级计，不是本仓 L2：

- **平面角色**：findings/float-truth.md §0、§2 的角色均值（括号区间需另看原表）：cost 0.0278、attack 0.0340、durability 0.0449；race/race_multi/plate 约 0.034–0.039。health 0.0622、desc 0.0619，仍未到 0.05。
- **名字 CPU 正式链**：findings/name-rtt-canon.md §18：逐顶点 VS float32 链落地后，3 帧 RT alpha MAE 0.0751–0.0994；10 卡卡面均值 0.4760→0.1021。
- **名字 GPU 实验**：同文 §19：引擎原始 DXBC、VB/IB、常量和纹理重放可逐位为零；用我方生成输入的 GPU 合成 PoC，8 张曲面卡均≤0.05，均值 0.0368。该 GPU 路径**没有落入正式默认实现**，仍有设备/驱动与确定性约束。
- **英雄技能平面 RTT**：10-20-heropower-name-rtt/NOTES.md：229 textonly banner 49.208→0.262，bbox 精确相同；14/14 同帧 origin banner 改善，但部分 off-corpus 卡仍明显残差，不能称整个帧族逐像素一致。

日志会保留被后续否证的推断。特别注意：name-rtt-canon §17 的“驱动限制”被 §18 的 VS float32 根因修正；race-atlas-canon 开头的 2.5–4.2 残差被 §14 后续工作大幅降低；float-truth 升级后也不能再把所有 0.06 残差都归为 8-bit 基准噪声。

## 3. 与 TS 当前实现逐项对照

| 可复用发现与证据 | 本仓现状 | 适用判断 |
|---|---|---|
| 目标输出像素逆映射到 glyph/atlas，直接 bilinear 后做 9-tap 或 center。上游 text_atlas.py `render_atlas_text`、`_paste_glyph`；findings/cost-atlas-proto.md、general-atlas-roles.md | ubertext.ts:233-290 仍把每字绘到 4×缓冲、四舍五入 paste 坐标，再 Lanczos 缩小 | **主要缺口**。9-tap 公式已有，并不代表采样链相同；直接采样有望同时解释边缘和位置差 |
| 普通描边 9-tap；bold 8-tap×0.23，粗体字仅在独立第二绘制中出现 | glyph.ts:72-115 已有相同 shader 族；ubertext.ts:277 按文本顺序逐字绘 | 不能把上游从 `_dilate` 切 9-tap 的改善当作我们的预计收益；第二 pass 顺序在字形重叠处仍需对账 |
| desc 浮点 ascent；name/race/plate 消费含 lineGap 的 bounds；数字不能全局套此规则。desc-atlas-canon.md §2、linegap-promotion.md §0、race-atlas-canon.md §15.1 | freetype-metrics.ts:76-81 用 ceil/floor ascent/descent、lineSpan 只有 asc−desc；textlayout.ts:411-428 渲染用浮点 span，但 fit/wrap 仍用整数 lineHeight | **有明确差异**，须按角色分开核对。不能简单把 lineHeight 全局替换：上游数字47层全回退；desc 字体 lineGap=0 |
| underwear 收窄判断应使用浮点行高。desc-atlas-canon.md §8.2 | textlayout.ts:339 `pitchFp: fm.lineHeight * sp` | 直接值得隔离验证，尤其长文本折行；本仓已有 L2 停档约束，不能未验证就统一改判据 |
| 引擎斜体是 FontStyle.Italic 的独立光栅结果。desc-atlas-canon.md §4 | font.ts:45 常数 shear；freetype-metrics.ts:133 起对正体位图二次双线性剪切 | **字形源仍有近似**。上游某些正体13/13 bit-exact，不证明所有字体、字号、斜体均能由现有 WASM 设置重现 |
| 无 RenderOnObject 仍走平面 RTT。10-20-heropower-name-rtt/NOTES.md | ubertext.ts:226-230 无 curved 时近似直绘，武器和英雄技能同类缺口 | **机制证据最直接**，优先候选。无需照搬229像素坐标，可用本仓AV_205p与LOOT_392/DED_004同请求基准验证 |
| RTT 内容9-tap、GPU混合与合成4对角AA是两个阶段。text_atlas.py:393-435；name-rtt-canon.md | ubertext.ts:296-361 2×RT后Lanczos；glyph.ts:21 标准straight source-over；后续网格采样直接贴回 | **主链缺口**。RT alpha 同因子 SrcAlpha/InvSrcAlpha 时 `Aout=s²+Adst(1−s)`，不同于当前 `s+Adst(1−s)`；AA阶段也不能省略 |
| ±3000变换抵消留下逐顶点float32误差。text_atlas.py:58-93；name-rtt-canon.md §18 | TS 使用Float64数学，且RT是逐字取整paste | 可复用机制，但应先恢复正确RT链，再验证此精度层，不能补一个统一平移常数代替 |
| name合成采样器aniso9，平面文字13/13角色与bilinear相同。name-rtt-canon.md §19；plane-sampler-audit.md | TS曲面单次bilinear | 曲面最后边缘精度的后续边界；不应扩散为所有文字需要GPU。GPU方案涉及产品/架构决定，未选择 |

### 本仓已具备、不应重复移植或误判的项目

- `plan.ts:1289` 已取真实 armor；费用来源也在 plan 中按 tags 生成。Angelia 10-19 的英雄费用硬编码0是其旧实现问题，不能直接类推本仓。
- `textlayout.ts:313-320` 硬换行后 cursor 已加1，与本仓 flags 含换行的方式一致；上游修“换行后bold错一位”不表示本仓必有同一bug。
- 本仓 `ResizeToFitAndGrow` 已实现（textlayout.ts:348-373），需查其bounds度量差异，不是补一个完全缺失的grow功能。
- 面内缩放已在 settingsFromNode 修过，见本仓 `explore/2026-10-10-text-offset/findings.md`。上游攻字 **+1.151°面内旋转** 仍值得核对：NodeSettings目前只传worldPos与标量localScale，未携带角度。
- 上游10-20的“文字最后合成”解决其水印V-pass覆盖AA背景。当前本仓 `render-card.ts:160-196` 是帧/水印/宝石后 `renderTextStage`，所以**没有证据证明存在同一顺序bug**。借鉴其 `(1−alpha)·背景差` 归因方法即可，不应照搬V-pass补丁。

## 4. 验证建议（供用户选择，尚未实施）

按证据清晰度建议先验证**平面 RTT（英雄技能/武器名字）**和**平面文字目标分辨率直接采样**，再处理角色度量与曲面名字精度。建议各做独立变量实验，现有校准保持为对照，不自动撤销用户曾批准的校准值。

- 数字：随从攻/血/费、武器耐久、英雄护甲；特别验证节点旋转及BG alternate-cost，不能只测正常费用。
- 描述：普通/粗体/斜体/粗斜体、硬换行、长文本underwear；确认实际fixture文本含目标标签后选卡。
- 名字：AV_205p平面RTT、LOOT_392/DED_004武器平面、随从/法术曲面、佣兵装备非1缩放。
- 种族/学派：DMF_709、CFM_637、REV_365及BG饰品等；上游plate在本仓是race角色，移植时需按实际节点区分。

验收仍是本仓同请求 `reference/` 的L2前后账，并辅以独立文字层、RT中间缓冲、alpha域、bbox和连通块。若需要他们textonly/float真值，只能作为上游行为仲裁或另外建实验对照，不能替换ADR-0001基准。所有实验另建output，不覆盖历史产物。

**尚未解决的前提**：最新图集/抓帧未同步到本机；字体/资产版本与本仓冻结图尚未逐文件比对；上游Windows D3D11指令及量化细节是否适用于我们基准的采集后端也需确认。现有证据足以定位候选机制，不足以承诺本仓移植后的误差数字。

## 5. 上游实现与证据的附加边界

- shader有9-tap证据，但当前Python数字分支为保住cost桥，默认仍只用8个外tap；race/plate/name显式补center（`../Angelia/scripts/render/game/uber_text.py:1422-1427`）。应迁移有证据的机制，不能照抄其兼容例外。
- lineGap逐角色分叉有完整A/B；为何数字与bounds消费不同的底层原理，上游仍留未闭项（linegap-promotion.md:126-150）。不能把实证分组说成已证明的通用引擎规律。
- 图集682字来自134 dbf渲染文并集，并非DIY任意文字覆盖。是否使用图集、保留何种FreeType路径属于待用户选择的实现问题，本次不决定。
- 上游后续门从305条三态变成以126张origin为默认；门全绿只表示不劣于其blessed误差，不能当作game逐像素相同。

更多上游精确行号和取证边界见 [独立证据核查](../../explore/2026-10-21-angelia-font-review/upstream-evidence.md)（explore为本地实验目录，不随git收档）。
