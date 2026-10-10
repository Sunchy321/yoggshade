# 水印渲染调研：卡集水印链、特征清单与自定义口径（2026-10-07）

任务：研究水印（扩展包/卡集徽记，card set watermark）怎么渲染；确定水印特征；梳理
「自定义水印」的处理口径。§6 决策已定（2026-10-07：移植立项，自定义走官方路径）；
§7 = 官方路径自定义水印的素材要求/处理/尺寸位置实证回答（本机探针）；
§8 = 提取脚本问题清单与移植改造点。

上游正典：Angelia 的 watermark-chain 实验（2026-10-04，findings 与笔记同步于本工作区）
——Angelia 侧已实现并三级门全绿；本仓 TS 侧**零实现**。
「继续」= 沿该研究线补 TS 侧认知，并回答自定义水印问题。

## 1. 引擎水印链（canonical decomp，exporter ilspy 缓存 Assembly-Csharp）

- **唯一调用点**：`Actor.UpdateDescriptionMesh` 恒调 `UpdateWatermark`（Actor.cs:5071 →
  :5075-5135）。手牌五帧（ally/ability/weapon/location/hero_hand）的 desc 材质都吃。
- **写点两个**（:5107-5121 / :5123-5135）：
  1. `m_descriptionMesh` 材质 `_SecondTex` ← 水印纹理、`_SecondTint.a` ← alpha——
     **手牌卡唯一有效层**；
  2. `m_watermarkMesh`（:245 序列化字段）材质 `_MainTex` + `_Color.a`——佣兵/BG 专用：
     手牌 ability prefab 序列化 m_watermarkMesh=null（PathID 0，Angelia 的
     card_hand_ability prefab_report.json 实测；
     Card.cs:1177-1179 HideMercenaryWatermark 控制）。**画像/画窗无水印写点**——肖像材质
     `_SecondTex` 是 BannerAtlas 序列化槽（portrait-chain 正典，本仓 manifest.second_tex
     即该槽，与水印无关）。
- **纹理四级优先**（:5083-5104）：
  1. actor 级 `m_watermarkCardSetOverride`（:506/:1196-1204，由 GAME_TAG
     WATERMARK_OVERRIDE_CARD_SET 驱动；手牌默认 INVALID，不涉）；
  2. 逐卡 `WatermarkTextureOverride`（EntityDef.cs:258-261 → CARD DBF 列
     `m_watermarkTextureOverride`，unpack-notes.md:50；非空即直取，**与 set 活跃性无关**；
     全集 1016 卡非空，多为迷你集图标）；
  3. `CardSetDbfRecord.CardWatermarkTexture`（按 GetCardSet() 的活跃 set）；
  4. `IsCoreCard()`（= 活跃 set 行 m_isCoreCardSet）→ **无条件覆盖**为年标
     `SetRotationIcon.GetYearIconWatermark()`（SetRotationIcon.cs:33-40）：
     `CoreIcon_Odd.tif:66255e…`（奇数轮）/ `CoreIcon_Even.tif:8f3985…`（偶数轮），
     奇偶 = GetActiveSetRotationYear()%2；冻结参照裁决=偶数轮 Even（78325 desc 圣甲虫目检）。
- **alpha**（:5106）：HIDE_WATERMARK（tag 1107）任一侧（entityDef/entity）在 → 0；否则
  `WATERMARK_ALPHA_VALUE = 99f/128f`（:183 ≈ 0.7734）。纹理裁决空串 → 0（:5113-5118 分支）。
- **GetCardSet**（EntityBase.cs:1351-1377）：tag 183（CARD_SET）恒缺省（CARD_TAG 表 0 行）→
  CARD_SET_TIMING 表按序取**首条活跃** timing 的 CardSetId；活跃性 =
  EventTimingManager.IsEventActive_Impl：SPECIAL_EVENT_ALWAYS(203) 恒真、NEVER(164) 恒假、
  其余=服务器窗口（离线判假）→ **离线正典 = 仅 203 判活**；全不活跃 → INVALID → 无水印。
- **offset**（OffsetDescriptionTexture，:6188-6189 双写）：
  `desc._SecondTex.offset = (保留序列化 x=-0.04, withRace ? 0 : 0.07)`（常量 :599-601）；
  watermarkMesh._MainTex 同式。withRace = 种族/学派文本非空（EntityBase.cs:1251-1264）
  || IsWeapon || IsLocation（:6254）；IsHero 早退（:6217）→ hero 帧保留序列化 offset。
- **shader/PS**（`Custom/Card/Unlit_2Texture2uv`，Angelia textless-align 提取）：
  VS：`o1.xy = UV0×_MainTex_ST`；`o1.zw = UV1×_SecondTex_ST`（水印走 desc mesh 的
  **UV1 通道**）。PS：`second_t = _SecondTex@UV1 × _SecondTint × _BlendIntensity(2.0)`；
  `out = lerp(main@UV0, main×second_t, second_t.a)`；尾 `min(out,(out+0.15)×COLOR0)` 恒
  no-op。pass One/Zero 不透明 → desc 面像素纯替换。采样 = Clamp + Bilinear。
  即水印是 desc 框上的**乘法压暗垫图**（emblem 形状的变暗花纹），非加色/透明贴片。
- **desc 材质序列化常量**（五帧，desc_mats_floats.json；ta_watermark.py DESC_MATERIALS）：
  `_SecondTint.rgb` ally/ability/hero=0.569/0.562/0.546、weapon=0.671/0.662/0.644、
  location=0.557 灰；`_SecondTex_ST=(1,1,-0.04,0)`（y 运行时改写）；location 的
  `_Color=0.906 灰`（对 PS 恒 no-op）。

## 2. 协议与数据侧现状

- **exporter 协议 v1**（hearthstone-image-renderer-protocol.md:311）：
  renderModel.`overrideWatermark: string?`——set slug；语义（ExporterController.cs:9232-9246）：
  显式 null → 清 actor override（回退卡自身链）；slug 解析失败 → 清 override +
  打 HIDE_WATERMARK；解析成功 → `WATERMARK_OVERRIDE_CARD_SET`（:4463-4467）。
  renderHints/mechanics 有 `hide-watermark`（tag 1107，协议 :361）。
- **fixture JSON**：每卡顶层 `watermarkTextureOverride` 字段 = CARD DBF 逐卡列的镜像
  （TS 侧因此不需要全量 CARD DBF）。本仓 41 fixtures 中 5 张非空，全是迷你集图标：
  DED_004→SWIcon_MiniSet、SC_004/403/762→GDBIcon_MiniSet、YOG_502→TTNIcon_MiniSet。
  其余卡走 set/年标路径，L2 基准图的 desc 区已含水印像素。
- **TS renderer**：`packages/renderer` 无任何水印代码（grep 零命中）；`FixtureCard`
  接口未消费 `watermarkTextureOverride`；meshes.json 只有 `uv0`（**无 UV1**）；raster.ts
  仅有 opaque/multiply/additive 三种混合，无「UV1 第二纹理乘法压暗」pass。移植需要：
  ① desc mesh UV1 通道补提取（py 侧对应 mesh_uv1_supplement.npz）；② 水印纹理入资产包；
  ③ set 归属/纹理裁决数据（三表）；④ desc 水印 pass（PS 公式 §1）。
- **数据/纹理可用性**：py 侧三表（card_set_timings_v327.json 37221 行 /
  card_watermark_overrides_v327.json 1016 卡 / card_set_watermarks_v327.json）与 67 张
  水印纹理（`{stem}_{guid8}.png`，含 18 张迷你集补提取）在 Windows 侧 REPO
  （ta_watermark.py REPO=D:\code\hearthstone-image-test），**本机无副本**；2026-10-07
  探针实证本机 `/Applications/Hearthstone` 直读可行（CARD_SET 47 条引用全解析、五帧
  desc UV1 可提），移植时本地重提取（脚本改造点见 §8）。

## 3. 特征清单（「水印具有什么特征」的直接回答）

一段话：水印 = desc 文字区材质第二纹理槽上的**乘法压暗徽记**，仅此一层（画窗/肖像没有）；
纹理按「actor set override → 逐卡 override → 活跃 set 纹理 → 核心卡年标」四级裁决，
set 归属离线下取 CARD_SET_TIMING 首条 ALWAYS(203) 行；alpha 恒 99/128（HIDE_WATERMARK
或裁决空 → 0）；几何 = desc mesh UV1 × ST(1,1)，offset.y 有种族/学派/武器/地标文本时 0
否则 0.07（hero 帧不改写）；采样 Clamp+Bilinear，混合 = `lerp(main, main×wm×tint×2.0, a)`。

| 维度 | 特征 | 出处 |
|---|---|---|
| 位置 | 仅 desc 文字区（desc 材质 `_SecondTex` 写点）；画窗/肖像无；m_watermarkMesh 层佣兵/BG 专用（手牌 prefab null） | Actor.cs:5107-5135；prefab_report.json |
| 外观 | 变暗的系列徽记花纹（乘法），非独立贴片；随 set 不同（67 种纹理） | PS 公式（textless-align §1） |
| 纹理裁决 | 四级：actor override → 逐卡 override（1016 卡）→ 活跃 set 纹理 → core 年标 CoreIcon_Even/Odd | Actor.cs:5083-5104；SetRotationIcon.cs:33-40 |
| set 归属 | tag 183 恒缺 → CARD_SET_TIMING 首条活跃（离线=仅 203）；全不活跃→无水印 | EntityBase.cs:1351-1377 |
| alpha | 99/128 ≈ 0.7734；HIDE_WATERMARK(1107)→0；纹理空串→0 | Actor.cs:183/:5106/:5113-5118 |
| 几何 | desc mesh **UV1** × _SecondTex_ST(1,1)；offset=(-0.04, withRace?0:0.07)；hero 帧不改写 | Actor.cs:6188；常量 :599-601 |
| 采样/混合 | Clamp+Bilinear；`second_t=wm×_SecondTint×2.0`；`out=lerp(main,main×second_t,st.a)`；不透明替换 | Unlit_2Texture2uv PS |
| per-frame tint | _SecondTint.rgb：ally/ability/hero 0.569/0.562/0.546；weapon 0.671/0.662/0.644；location 0.557 | desc_mats_floats.json |
| 适用帧 | 手牌五帧（ally/ability/weapon/location/hero_hand）都有 desc 写点；英雄技能无 desc 面 → 无水印 | ta_watermark.py DESC_MATERIALS |
| 协议开关 | overrideWatermark（set slug）/ hide-watermark（1107）/ 逐卡 watermarkTextureOverride | 协议 :311/:361；Controller :9232-9246 |

## 4. 与既有事实的衔接

- 本仓 `docs/findings/hero-power-frame-parity-2026-10-03.md` 引用的「水印与参照图 alpha=0
  的 RGB 垃圾块（Angelia findings §7）」：那是参照采集侧的 alpha=0 区域伪影，与本链的
  desc 水印写点无关，勿混淆。
- 水印不是「职业水印」：协议表 :361 的注释 "Suppress class watermark" 是措辞不准——
  引擎语义是**卡集（扩展包）水印**，驱动 tag 是 WATERMARK_OVERRIDE_CARD_SET/HIDE_WATERMARK，
  与职业（class）无关。移植文档应以「卡集水印」为准。
- L2 现状：基准图 desc 区已含水印；TS 未实现 → 相关 fixture 的 L2 diff 中水印家族是
  已知欠账（py 侧同类欠账 2026-10-04 关账：106/106 z_desc 改善）。

## 5. 移植到 TS 侧需要什么（数据/纹理两件已于 2026-10-07 落地）

1. **数据**（✅ 已提取：`scripts/extract_watermarks.py` → `data/card_meta/` 三表，
   本机 build 36.6.253216 与 py 正典 v327 逐项同数）：
   CARD_SET（60 行/49 非空纹理）+ CARD_SET_TIMING（36022 卡，表序）+ CARD override
   列（1016 卡/20 纹理）；年标奇偶口径（冻结=Even）记在各表 `_meta.semantics`。
2. **资产**（✅ 已提取：`assets/watermarks/` 66 张唯一纹理 ← 67 refs，gitignored 可复现）。
   注：`HallOfFameIcon.psd` 与 `.tif` 是同一 GUID 的两个 DBF 引用别名 → 一张文件；
   py 侧"67 张"即按 refs 计数，口径一致。
3. **网格**：desc mesh UV1 通道提取入 assets（现 meshes.json 仅 uv0；`extract_frame.py`
   `extract_mesh` 已提 uv1，仅 `tris_json` 落盘时丢弃——持久化补列即可）。
4. **渲染**：desc 水印 pass——UV1 采样 + §1 PS 公式 + 运行时 alpha/offset 写点；与
   textstage/ubertext 的 z 序关系按 py 侧「desc 为最后写入者的像素集」口径处理。
5. **验收**：L2 对基准图（有水印卡 desc 区收敛 + 无水印卡零回归），参照 py 侧专项账口径。

## 6. 自定义水印的处理口径（已定：官方路径；三选项存档）

**用户裁定（2026-10-07）**：移植立项；自定义水印**采取官方路径**（层 1——游戏链原生
机制的纹理替换/换系列/隐藏），不设任意图协议扩展（选项 A 不采纳，存档）。

「自定义水印」分两层，第一层游戏链已原生支持，第二层超出游戏语义需要协议扩展：

**层 1：换用/隐藏游戏内已有水印（零新机制，游戏忠实）——已采纳**
- 换系列：`overrideWatermark` = 目标 set slug（→ WATERMARK_OVERRIDE_CARD_SET）；
- 换纹理：逐卡 `watermarkTextureOverride`（游戏 DBF 语义，只能指向游戏资产包内纹理，
  本仓语境 = §7 规格的资产包水印纹理，官方 47 张 + 自制同规格）；
- 隐藏：`hide-watermark`（tag 1107）或 overrideWatermark 给未知 slug。

**层 2：任意自定义图作水印（超出游戏；游戏无此路径——DBF 只能指向游戏资产）——未采纳**
- 选项 A（原推荐）：协议扩展 `renderModel.watermark.texture`。机制保真但加协议面，
  且无 L2 参照可对（验收只能靠机制忠实 + 目检）。
- 选项 B：只允许层 1。**即本次裁定**——自定义=官方机制的纹理内容替换（§7 规格），
  渲染数学零偏离，一切照官方语义。
- 选项 C：水印作为渲染外叠加（站点侧后处理）。违反本仓「不以 post-processing
  糊弄渲染」的精神，排除。

（附注：若「自定义水印」指站点对输出图打的**版权水印**，那属分发层职责，不进
renderer 协议——与 Blizzard 资产边界和渲染保真目标都无关。）

## 7. 官方路径自定义水印：素材要求 / 处理 / 尺寸位置（三问实证回答）

证据 = `explore/2026-10-07-watermark-custom/probe_wm_facts.py`（本机只读探针，
2026-10-07 跑通；47/47 官方水印纹理全量统计 + 五帧 desc mesh UV1 实测）+
`probe_wm_facts.json`（原始数据）。

### 7.1 素材图有什么要求

官方全集的实测画像（47 张：45 set 纹理 + 2 年标 CoreIcon_Odd/Even）：

| 维度 | 实测 | 自制要求 |
|---|---|---|
| 画布 | 全部**正方形幂次**：128×128 或 256×256（新系列偏 256） | 256×256 推荐（128 亦可；非幂次无先例，勿用） |
| 颜色空间/格式 | DXT5（除 TTNIcon=RGBA32）；离线链消费解码后 RGBA | PNG-32（RGBA）；无需压缩（DXT 是游戏侧存储细节） |
| RGB | **浅灰**，亮度 0.85–0.91（p1≈0.74）；个别微暖（BotB 0.914/0.888） | 灰度 0.85–0.91；**不要用深色稿**——水印靠 `wm.rgb×tint.rgb×2` 乘法压暗，深色稿会渲染出远超官方家族的暗斑（实证：|Δout| 中位 0.012、99 分位 0.13@中灰底） |
| alpha | 徽记覆盖率蒙版，覆盖率 17–44% 画布，软边（a≥0.5 区略小于 a>0.01 区） | alpha=徽记覆盖蒙版，抗锯齿软边可；画布 17–44% 覆盖的单一徽记 |
| 边缘 | bbox 全部收在 0.008–0.992 内，**边缘留透明边** | **必须**：四边至少 2–3px 透明（128px 画布）——desc UV1 超出 [0,1] 靠 Clamp 收边，边缘不透明的徽记会把边行/列 texel 拉丝到 desc 框两侧留白区 |
| 采样态 | wrap=Clamp；filter 双线性/三线性混有 | 无需指定——离线链按 Clamp+Bilinear 统一采样（py 正典同语义，104/104 噪声带实证） |

### 7.2 要怎么处理（官方路径全流程）

1. **按 §7.1 规格自制 PNG**（或选用官方 47 张之一）。
2. **入资产包水印目录**（提取产物命名沿 py 先例 `{资产实名}_{guid8}.png`；自制纹理
   用稳定自定后缀即可——离线链的 ref 只是文件查找，不查 catalog）。
3. **挂到卡上**（三选一，语义同 §1 四级裁决）：
   - 逐卡：fixture/renderModel `watermarkTextureOverride`（= CARD DBF
     `m_watermarkTextureOverride` 镜像，优先级高于 set 纹理、低于年标）；
   - 换系列：`overrideWatermark`（set slug → WATERMARK_OVERRIDE_CARD_SET）；
   - 隐藏：`hide-watermark`（tag 1107）。
4. 渲染——其余一切（采样、tint、alpha 99/128、offset、PS 公式）由 desc 水印 pass
   固定复刻，用户零参数。

### 7.3 尺寸/位置需要单独指定吗

**不需要，也没有入口——几何全部由引擎几何死死固定**：

- desc mesh **UV1 实测**（ally：`x∈[−0.491, 1.491]`、`y∈[−0.112, 1.024]`；weapon/
  location 同构）——纹理以**居中正方区**贴上 desc 框：纹理 1 UV 单位 = 框宽的 ~1/2
  （0.847/1.694 世界单位）× 框高的 ~0.88（0.852/0.968），纵横比 2.00/1.136≈1.76 与
  desc 框 1.694/0.968≈1.75 匹配 → **无拉伸变形**；框两侧留白采样 Clamp 后的透明边缘
  texel。官方 47 张无一例外是「居中徽记 + 透明边距」画布，位置全烘在纹理里。
- 运行时唯一变量 = offset.y（`withRace ? 0 : 0.07`，Actor.cs:6188 + :599-601），
  由卡是否有种族/学派文本（或武器/地标）自动决定，**不是可指定参数**；x 恒 −0.04
  （序列化）；hero 帧连 offset 改写都早退（IsHero，:6217）。
- 结论：**"放哪/多大"的答案是"画进纹理"**——想要不同位置/大小的徽记，改变它在画布
  中的位置和占比即可（保持 §7.1 边距要求）；渲染管线不提供逐卡几何覆写。

移植细节备注（非素材要求）：hand-hero 帧 desc mesh **无 UV1 通道**（probe B 实测
uv1_present=False；顶点通道表：channel4=UV0 在、channel5=UV1 缺）+ 序列化
`_SecondTex_ST=(5,5,−2.01,−0.54)`。**引擎对缺失 UV1 的语义 = uv0 回退**（2026-10-07
用户指认 AV_205 参照明确有水印，(0,0) 零填假设被证伪）：采样 = uv0×(5,5)+offset →
水印以 5× 放大窗出现在 desc 框中部——TS 修复后 AV_205 desc 残差 31.57→30.77、
CATA_190h +1.40 改善，与参照目检匹配。IsHero 早退（:6217）使该序列化 ST 不被
withRace 规则改写。

## 8. 提取脚本问题清单（移植改造点；"注意提取脚本的问题"）

上游两脚本均不可在本机直接跑，且部分依赖不可移植——移植时**重写为 yoggshade
`scripts/extract_watermarks.py`**（复用本仓 Resolver，探针已验证 47/47 全解析）：

| # | 问题 | 影响 | 移植处置 |
|---|---|---|---|
| 1 | `ta_extract_watermarks.py` REPO/GAME/HS_CARD_SET_JSON 全部硬编码 `D:\…`（:42/:46/:50） | 本机必然失败 | yoggshade 版用本仓 `scripts/resolve_asset_ref.py`（默认 `/Applications/Hearthstone/Data/OSX`，探针实证可用） |
| 2 | 同脚本 (c)(d) 部分（UV1 npz + 材质 floats）依赖 4 个前任实验 npz 对齐基准 + `desc_mats.json`（:68-77/:326） | 产物不在本机，不可复现 | **yoggshade 不需要**：`extract_frame.py` 本就提取 uv1（`extract_mesh` :206），只是 `tris_json`（:397）落 meshes.json 时丢弃——移植=持久化补上；材质 ST/tint/floats 已在 frame_recon renderers（探针 §manifest 实证） |
| 3 | `PLACEHOLDER_REF` 短 guid 前缀 hack（`GenFX_Set1_Icon.psd:9996d2ef`，ta_extract :57） | catalog 只认 32 位 guid；探针实证该 ref 不在 catalog 且实名不在预期 bundle | 占位纹理是序列化默认槽、运行时恒被改写——**跳过不提取**（本仓资产包已有其 PNG） |
| 4 | `wc_extract_card_set_timings.py` GAME 硬编码 `D:\game\…`（:48）+ 依赖 Angelia 侧 `card_assets_v327.csv` 作 override 源（:62） | 同 1；CSV 本机在但属跨仓依赖 | CARD/CARD_SET/CARD_SET_TIMING 三表全部直读本机 `dbf.unity3d`（yoggshade `extract_fixture_data.py` 已有同法先例）；override 列从 CARD DBF 直取 |
| 5 | DBF 水印引用全为 32 位 guid（探针 47/47），notes 中 `JAILIcon.tif:90002553` 式短串只是**文件名词干** | 勿把短串当 guid 去 catalog 查 | 命名沿用 `{实名}_{guid8}.png`（解析后的对象实名 + guid 前 8 位） |
| 6 | 活跃性口径「仅 203 判活」是 v3 冻结近似（服务器窗口事件离线判假） | 换参照会话口径时需重验 | 沿用冻结口径并在表 `_meta` 记语义（同 py 先例） |

§5 移植清单据此修订；其中 ①② 已完成（2026-10-07，`scripts/extract_watermarks.py`
重写落地并跑通：三表哨兵 127155→(1988,203)→JAILIcon、68299→(1646,203)→ClassicIcon
与 py 正典逐项一致；纹理 67 refs→66 张，HallOfFameIcon 双扩展名别名共用一 GUID）；
③④ 已实现（同日：`extract_frame.py` uv1 持久化 + 八帧重导；`plan.ts` resolveWatermark
+ `rasterZbuf` 第二纹理公式 + `render.ts` 接线——typecheck/lint 过，验收账见 §9）；
⑤ 验收进行中，遗留一个基准图口径分支点（§9.2，待用户裁决）。

## 9. TS 移植验收账（2026-10-07；uv0 回退修正后为第二轮账）

**实现**：`extract_frame.py` uv1 持久化（**缺通道回退 uv0 = 引擎语义**，见 §7.3 勘误——
零填假设被参照证伪后修正）+ 八帧重导（快照 diff 仅 meshes.json 变；banner 合并子树由
extract_banner_assets.py 幂等恢复）；`plan.ts` resolveWatermark（四级裁决逐条复刻
Actor.cs:5083-5104）+ `rasterZbuf` wm 第二纹理公式（PS 逐指令；水印寄生于 desc 三角形
光栅，零排序改动）；fixture 链经 `compileFramePlan` 接线。typecheck 过。

**自基线零回归**：40 张 fixture 改前/改后逐位对比——阴性卡（英雄技能/无活跃 timing）
逐位不变；变化集 = 恰好水印目标卡。两张地标卡（SC_403/TTN_090）整 desc 框变化 =
「main 不乘 _Color」的引擎语义生效（location 0.906 旧 tint 偏差去除），L2 mae 无回归。

**hero 帧 uv0 回退修正账（第二轮）**：AV_205 desc 残差 31.57→30.77、CATA_190h
+1.40 改善（参照确有水印，5× 放大窗形态目检匹配）；全量 L2 门对修正前账唯一回归 =
SC_004 +0.081（override 卡，见 §9.2 系统性缺席的又一实证）。

### 9.1 L2 前后账（z_desc，out/l2 + evidence/l2_summary_{before,after}.json）

- **set 纹理路径 11/13 改善**：CFM_621 −0.67 / CFM_637 −0.69 / CFM_685 −0.76 /
  CFM_902 −0.85 / DMF_709 −0.43 / ETC_210 −0.66 / GDB_142 −1.17 / JAIL_407 −0.81 /
  REV_365 −0.52 / TOY_519 −0.44 / TTN_477 −0.50 / WON_332 −0.61；微升三项全为
  SIGNATURE/DIAMOND/GOLDEN 高残差卡（z_desc 86~102 的 premium desc 大欠账上叠噪声
  +0.08~+0.42）。全部 z_desc 均值 33.992 → 33.761。
- **override 路径 2/2 恶化**：SC_762 +0.83、YOG_502 +0.38（DED_004 武器帧
  mae_visible +0.089）——见 §9.2。

### 9.2 发现：本仓基准图导出会话丢失逐卡 override 水印（待用户裁决）

目检实证（explore/2026-10-07-watermark-custom/evidence/）：

- GDB_142（set 路径）参照 desc 有清晰 GDBIcon 行星徽记、CFM_621 有 GangsIcon 圆环
  ——**set 纹理水印在基准图里存在**，我方绘制后 L2 收敛（§9.1）；
- YOG_502/SC_762（逐卡 override 迷你集）参照 desc **无徽记**（ref−基线 delta 干净），
  我方按引擎绘制 → desc 残差上升。

引擎链（Actor.cs:5083-5104）与 Angelia 参照（115624 等 override 卡水印 z≈0.67=存在）
都证明 override 水印是引擎真实行为 → 本仓基准图导出会话特定地丢了 override（机制
未定：zhCN 变体解析已排除；IsExplicitNullConfigValue(null)=true 排除缺省隐藏；
exporter 源码 BuildPlaceholderDisplayOverrides 的 HIDE_WATERMARK 仅占位卡）。
三选项（A 保留绘制+登记欠账+择机重导基准图 / B 匹配现行基准图不画 override /
C 先考证导出会话）见 `.scratch/watermark-port/issues/04-l2-accept.md`，待用户裁决。

### 9.3 登记残差（非本卡）

- 水印纹理 mip 链（MipBias −0.5）缩小采样 speckle——全局家族。
- premium（SIGNATURE/DIAMOND/GOLDEN）desc 大欠账（z_desc 86~102），水印噪声叠其上。
- 协议 overrideWatermark（set slug → actor 级覆盖）TS 侧暂无输入，留 TODO 接口。
