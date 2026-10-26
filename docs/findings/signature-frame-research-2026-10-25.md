# 异画（SIGNATURE）渲染研究

日期：2026-10-25。性质：**研究记录**（用户口径的「异画」= `TAG_PREMIUM.SIGNATURE`）；阶段 A 的实现与收口结果后续追加于 §8–§14。
前置：`docs/findings/five-cardtypes-frame-parity-2026-10-03.md` §6（首次记录帧族事实）、
exporter `docs/premium-card-rendering-decompile.md`（premium 反编译总表）。本文补齐：帧族逐 prefab
结构、shader 变体实况、L2 现状、素材/工具缺口、移植路径。

## 0. TL;DR

- **L2 前 8 名全是 premium 帧族缺口**（`bun run l2` 实测 2026-10-25）：异画 5 张
  TLC_433 **109.4** / WW_373 **102.0** / GDB_477 **92.2** / RLK_706 **91.9** / TLC_EVENT_402
  **83.0**（另钻石 TTN_850 95.7、金卡 TIME_EVENT_999 73.3 同族）；非 premium 卡全部 ≤10。
  异画移植是当前最大的单块 L2 误差源。
- 游戏侧代码路径全部核实（§1）；卡→帧映射已并入 `CARD.m_signatureFrameId`（§1.3）。
- 签名帧不是「普通帧换贴图」：帧体走 **`Uber/UberCardBack` 三层动画 uber shader**
  （图集×mask + 3 层流动特效），类色是**单图集+运行时 tint**（与普通帧逐类烘焙纹理两种口径），
  文字压在画上靠 **TextGradient 乘法压暗层**（§2/§3）。
- 核心 shader `Uber/UberCardBack` 的真实 FS **可得但缓存里是坏的**：exporter 抽取工具按
  `{shader}_{stage}.metal` 落盘、变体互相覆盖，现存文件是无 keyword 的恒等白。62 个变体都在
  游戏包里，已另抽采样 FS 落盘本实验 output（§4）。
- 帧资产未入包（`assets/frames/` 无签名槽位）；`assets/portraits/*-signature.png` 已在包里但
  `plan.ts` 肖像解析不带 premium 后缀，未接线（§5）。

## 1. 游戏侧代码路径（ilspy 缓存逐处核实）

缓存：`exporter/tmp/ilspy/Assembly-Csharp-247416/`（37.0 客户端）。

### 1.1 帧族选择与回退链

`ActorNames.GetNameWithPremiumType`（ActorNames.cs:822-883）：DIAMOND 缺 `s_diamondActorAssets`
→ 落 SIGNATURE；SIGNATURE 查 `GetSignatureActor(cardId, actorName)`，命中则**直接返回签名
prefab，与卡型无关**；查不到才落 GOLDEN → NORMAL。`GetSignatureActor`（:885-923）：hand 卡走
`SignatureHand[frameId]`、play 卡走 `SignaturePlay[frameId]`。

`Initialize`（:948-985）装载：`GameDbf.SignatureFrame` 每条记录的 `record.Cards` 反查 card id
（`GameUtils.TranslateDbIdToCardId`）。

### 1.2 文字状态

`SignatureFrameHasPowersText`（:934-941）：frame id `< 2` 返回 true（即 frame 1 = RLK_706 保留
powers text 切换），frame ≥ 2 默认不保留。注意：该 flag 只管 hover 的 powers text 开关；
**手牌常显描述文字**——TLC_433（frame 10）基准图描述文字可见即证。异画文字另有 PlayMaker
`Text_On/Text_Off/Text_Transition_*` 状态 + `SIGNATURE_TEXT_FADE_{IN,OUT}_DELAY = 4f` +
`Option.SIGNATURE_DISPLAY_PREFERENCE`（exporter premium 文档）；离线链按基准图冻结态=文字常显。

### 1.3 卡→帧映射（DBF 现状，较 §6 记录时有变化）

独立 `SIGNATURE_CARD` 表**已不存在**——映射并入 `CARD` 表字段 `m_signatureFrameId`
（另有 `m_signatureArtistName` / `m_howToGetSignatureCard`）。`SIGNATURE_FRAME` 表 8 条
（frame id → hand/play prefab AssetReference）：

| frame | hand prefab | 用途（fixture 实测值） |
|---|---|---|
| 1 | Card_Hand_Ally_Signature_25 | RLK_706 |
| 2 | Card_Hand_Ally_Signature_26 | WW_373 |
| 9 | Card_Hand_Ally_Signature_Evergreen | GDB_477 |
| 10 | Card_Hand_Ability_Signature_Evergreen | TLC_433（法术，play prefab 为空串） |
| 11 | Card_Hand_Hero_Signature_Evergreen | SC_004（fixture 现为 NORMAL） |
| 12 | Card_Hand_Weapon_Signature_Evergreen | TLC_EVENT_402 |
| 13 | Card_Hand_Ally_Signature_Location | （地标，无 fixture） |
| 14 | Card_Hand_Hero_Signature_Deathwing | CATA_190h（fixture 现为 NORMAL） |

7 卡 `m_signatureFrameId` 实测值与 §6 表一致（探针 2026-10-25 复核）。卡图/材质装载：
`CardTextureLoader.LoadSignature`（CardTextureLoader.cs:235-259）= 签名 material + portrait
texture + `UberShaderAnimation` 三件套，走 `CardDef.GetSignature{Material,Portrait,Animation}Ref`。

## 2. 帧族结构（UnityPy 探针实证）

探针：`explore/2026-10-25-signature-frame/probe_signature_prefabs.py` → `output/<name>.json`
（6 个 prefab 的全层级 walk：节点/激活态/renderer 材质[名+shader+纹理+浮点]）。
三种架构：

### 2.1 Signature_25（frame 1，RLK_706）——旧式，最贴普通帧

- `RootObject/Mesh`：3 submesh = `Genfx_Inhand_Signature25_Mat[Uber/UberCardBack]` +
  卡背 `[DiffuseColor]` + `Card_Signature25_ClassColor_Mat[UnlitDualClassTextureTint]`
- 独立 `DescriptionBox_Mesh`（同图集 uber 材质）、`RacePlate_Mesh`（同图集 Warlock 材质实例）
- **`Transluscent_Mesh`**（`GenFX_Card_Inhand_Signature25_Transluscent_Mat[Hero/Unlit/
  Unlit_Transparent2uvScrollMaskScroll]`，fresnel 2.22/glow 0.2/add 3.42 一堆参数）——第一代
  签名卡的「玻璃半透明」层，名称框两端也来自它（exporter
  `docs/signature-name-banner-investigation.md`）
- `Portrait_Mesh`/`PortraitFrame_Mesh`/`RarityGemFrame_Mesh`+`RarityGem_Mesh`（逐节点，同普通帧布局）
- `ClassColor_Mesh` 存在但 MeshFilter 为空（非可见来源，exporter 同文档已证）

### 2.2 Signature_26 / Evergreen（frame 2/9/10/12）——新式，fixture 主力

以 Ability_Evergreen（TLC_433）为例（Ally/Weapon Evergreen、Signature_26 同构，图集不同）：

- `RootObject/Mesh`：3 submesh = `Genfx_Inhand_Signature_{Evergreen|Weapon|26}_Atlas_Mat[UberCardBack]`
  + 卡背 `[DiffuseColor]` + `Card_Signature_*_ClassColor_Mat[UnlitDualClassTextureTint]`
- `RootObject/Portrait_Mesh`（**独立节点**，`Card_Signature_*_AllyPortrait_Mat[Unlit_Portrait]`，
  `_SecondTex` = Signature_*_Shadow_Atlas、`_BlendIntensity 1.75`——肖像叠阴影图集，uv1 语义待核）
- `RootObject/TextGradient`（`SignatureCardGradientOverlay[Hero/Multiply/Multiply]`，纹理
  `card_signature_text_gradient` 1024²）——文字区乘法压暗（普通帧没有这层，普通帧文字压在
  羊皮纸文本框上）
- `NameBanner_Mesh/Divider`（`SignatureCardDivider[Unlit_TransparentColor]`，同一张
  card_signature_text_gradient 纹理）——名框下的分隔线
- `RarityGem_Frame_Mesh`（签名图集 uber 材质）+ `RarityGem_Common_Mesh` 双材质：
  `Signature_Evergreen_Rarity_Gem_Mat[DiffuseAlphaMaskScroller]`（clouds03 滚动）+
  `Signature_Evergreen_Shadow_Mat[Multiply_AlphaFade]`（底影）
- `Shadow_Mesh`/`ShadowUnique`：`CardShadow_Signature26_Mat[FX_Transparent_ColorAsAlpha]`
  （已移植 shader 族）
- 攻/血/费用宝石：Signature 专属材质但 shader 仍是 DiffuseAlphaMaskScroller（已移植族）
- RuneBanner（DK 符文）/ MulticlassRibbon（含 signature 变体网格）/ EventBanner：与普通帧同构
- **无独立 Description 网格**——描述/名字/费用全部 UberText 浮在画上（对照基准图：全出血
  艺术 + 文字直压卡图 + 分隔线 + 框纹大宝石 + 半透明框体）

### 2.3 排序特例（RLK_706 名称框两端）

官方 `RenderCommandLists.SortRenderCommands()` 先 `sortingOrder` 再 `renderQueue`：
`Transluscent_Mesh`(order 0, queue 2999) 先画、`PortraitFrame_Mesh`(order 1, queue 2000) 后画会
盖掉名称框两端；exporter 导出前把 Translucent 的 order 提到不低于 PortraitFrame（exporter
signature-name-banner-investigation.md）。TS 链自控绘制顺序 → 直接按最终视觉序：
PortraitFrame → Translucent → 文字。

## 3. 类色两种口径（与普通帧的关键差异）

- **普通帧**：逐类烘焙纹理（`Card_Inhand_Ability_Warlock.tif` 等，colorSwitcher 表按类换图），
  shader `Custom/Card/UnlitTextureDualClass`，本仓按纹理切换实现。
- **签名帧**：单一 `Signature_*_Atlas`（1024²，与帧体同一张图集），shader
  `Custom/Card/UnlitDualClassTextureTint`，`_EnableDualClass=0` 序列化、`_Color/_SecondColor`
  运行时由 CardColorSwitcher 注入（plan.ts:1780 一带的 faction color 机制可复用），
  `_MiddleValue/-0.04~0.009`、`_StepValue 0.5`、margin 参数做双色渐变阶梯。
- `tables.json` colorSwitcher 里已有 `"signature"` 角色（阵营图标异画变体：FX3_gradient_vibrate
  _jitter @ alpha 0.525），multiclass 绶带也有 signature 变体网格（plan.ts:1918 已注记）。

## 4. Shader 盘点

### 4.1 已移植（可直接复用）

| shader | 用途（签名帧） | 本仓现状 |
|---|---|---|
| Effects/FX_Transparent_ColorAsAlpha | 卡影 CardShadow_Signature26 | `raster.ts` color_as_alpha |
| Hero/Diffuse/DiffuseAlphaMaskScroller | 费/攻/血宝石、稀有度宝石 | gems 阶段公式 |
| Custom/Card/Unlit_Portrait | 肖像（+阴影 SecondTex） | second_tex_mask 通路 |
| Hero/Multiply/Multiply | TextGradient 压暗、底影 | 乘法混合语义已落 |
| Hero/Unlit/Unlit_Texture | 绶带/符文座等 | 无光纹理默认路径 |
| Hero/Multiply/Multiply_AlphaFade | 稀有度宝石底影 | lettuce coin 底影有先例（plan.ts:579） |
| Hero/Unlit/Unlit_TransparentColor | Divider 分隔线 | 武器帧 DescriptionColorTrim 同款 |

### 4.2 未移植（异画新增）

| shader | 用途 | 备注 |
|---|---|---|
| **Uber/UberCardBack** | 帧体图集+卡背+DescriptionBox+种族板（签名帧主材质） | 三层动画 uber，见 4.3 |
| Custom/Card/UnlitDualClassTextureTint | 类色 submesh | 单图集+运行时 tint，§3 |
| Hero/Unlit/Unlit_Transparent2uvScrollMaskScroll | Signature_25 玻璃层 | fresnel/glow/add 多参数，只影响 RLK_706 |

### 4.3 UberCardBack 变体实况（工具缺口警示）

- exporter 缓存 `tmp/shader/Uber_UberCardBack_FS.metal`（20 行恒等白，Keywords: []）**不可信**：
  `exporter/tools/extract_shaders.py` 落盘名 `{shader}_{stage}.metal` 不带 keyword 后缀，
  62 个变体互相覆盖，最后写入者恰好是无 keyword 变体（VS 209 行那份是好的）。
- 游戏包内实测 62 变体（本实验 `list_shader_variants.py`）：FS 全部采样纹理，219–291 行；
  keyword 轴 = `_LAYER{1,2,3}_FLOWMAP` × `_LAYER3` × `_VERTEX_ROTATION/_VERTEX_WIND` × `_DEBUG`。
  采样 FS 已按 keyword 落盘 `explore/2026-10-25-signature-frame/output/Uber_UberCardBack_FS_*.metal`。
- 数学骨架：FS = `_MainTex`（图集）+ `_MaskTex`（图集 mask，通道控层混合）+ `_Layer{1,2,3}_Tex`
  （clouds03 / VAT_GradientScroll_2 / FX3_FlickerBright35 等）按 VS 算出的流动 UV 混合；VS 每层
  做 rotate/translate/scale + `_Time`（材质 `_ShaderTime=0` → 走 `VGlobals._Time.x + _Seed`）。
  **帧是动画的**——静态渲染要定相位（同金卡反射层相位问题的先例：Angelia
  `lab/2026-10-23-gold-frame-phase`，扫相位找单峰拟合基准图）。
- 移植前需读材质 `m_ShaderKeywords`（探针未dump，下一步补）与 `_Layer*` vector4 参数族
  （Translate/Rotate/Scale/Blend/Mask/Color/Distortion/FlowTranslate/FlowScale）。

## 5. 素材与接线现状

- `assets/frames/` 无签名槽位；起步脚本 `explore/2026-10-03-five-cardtypes/scripts/extract_signature_probe.py`
  （走 extract_frame 机制，输出 /tmp/sigpack 演示用）。
- `assets/portraits/` 已有 15 张 `*-signature.png`（TLC_433/GDB_477/WW_373/RLK_706/TLC_EVENT_402
  全覆盖），但 `plan.ts:246/747` 肖像解析只认 `{cardId}.png`，**premium 后缀未接线**
  （`-golden` 同样未接线，金卡 73 mae 的一部分即此）。
- fixture JSON 无 `signature_frame_id` 字段；`extract_fixture_data.py` 读 CARD 表时顺带取
  `m_signatureFrameId` 即可（§1.3）。

## 6. 移植路径（建议顺序，按 L2 收益；均未排期——**待用户决策**）

1. **抽帧入包**：extract_frame.py 参数化 5 个签名 hand prefab（§1.3 引用表）→
   `frames/hand-{spell,minion,weapon}-sig{frameId}`；材质导出需扩 UberCardBack 的
   keyword + `_Layer*` 参数族；肖像 `_SecondTex` 阴影图集与 mask 图集一并入包。
2. **fixture 数据**：`extract_fixture_data.py` 增 `m_signatureFrameId` → fixture JSON。
3. **shader 数学**（依赖序）：UberCardBack（先静态：Layer 混合 + 定相位 0 起步，再扫相位拟合）
   → UnlitDualClassTextureTint（tint 色 CardColorSwitcher 表）→ 肖像阴影 SecondTex →
   TextGradient/Divider → 稀有度宝石双层 →（最后）Signature_25 玻璃层。
4. **plan.ts 帧族选择**：`preset.premium === 'SIGNATURE'` → 签名槽位 + 肖像 `-signature` 后缀。
5. **绘制顺序**：PortraitFrame → Translucent（frame 1）→ 文字（§2.3）。
6. web 端 `adapter.ts` premium 恒 NORMAL 的限制在帧族落地后解除。

开放问题（需用户裁定）：动画相位口径（拟合 vs 冻结 0）；GOLDEN（TIME_EVENT_999，另有反射层
相位问题）与 DIAMOND（TTN_850，RTT 3D 链路）是否同批排期；`tools/extract_shaders.py` 修不修
keyword 后缀（不修则每次手工用本实验脚本抽）。

## 7. 本实验产物

- `explore/2026-10-25-signature-frame/probe_signature_prefabs.py` → `output/{Ability_Evergreen,
  Weapon_Evergreen, Ally_Signature_25, Ally_Signature_26, Ally_Evergreen, Hero_Evergreen}.json`
- `explore/2026-10-25-signature-frame/list_shader_variants.py` → `output/Uber_UberCardBack_FS_*.metal`
  （30 个采样 FS 变体，keyword 后缀命名）
- L2 数字：`out/l2/summary.json`（2026-10-25 跑）；对照图 `reference/*.png` vs `out/fixtures/*.png`

## 8. T3 落地记录（2026-10-25，GDB_477 静态结构 tracer）

工单 `.scratch/signature-frames/issues/03`。GDB_477 以 hand-minion-sig9 出图，
L2 mae_vis **92.2 → 34.1**（desc 带 68→10、race 57→36、art-low 44→36）；
其余 42 张 fixture 逐位零回归（sha256 全等）。取景/框体/文字/攻血宝石框位并排目检对齐。

### 8.1 实现面

- 帧族选择 `slotForFixture`（plan.ts）：premium=SIGNATURE × signatureFrameId → 已实现
  （FRAME_RULES 有规则 ∧ 包内已抽）槽位；回落普通帧 + 显式 console.warn。GOLDEN 不经此路。
- Evergreen 文本节点命名带下划线（`Attack_UberText`/`Health_UberText`/`RacePlate_UberText`），
  普通帧名（`AttackUberText`…）对不上 → extract_frame ROLE_BY_NODE 扩展 + 重抽（role_paths 补齐）。
  `Multi_RacePlate_UberText` 故意不登记（walk 序在单族节点之前，登记会绑错单族卡）。
- uber 静态主体 = 纯 `_MainTex` 采样走既有默认光栅路径：VS_nokw 反编译 `TEXCOORD0.xy =
  uv×ST`（无动画）、COLOR0 = 1+`_LightingBlend`×环境光（材质序列化 0 → 恒 1）、`_Color` 白。
- 类色注入 = `SetMaterialPremium` 对译（Actor.cs:6577-6599）：m_premiumRibbon=2 槽
  material_override._tint_rgb = CLASS_COLOR_*（Actor.cs:107-129 常量表入 plan.ts）。
  **GDB_477 实为 DEATHKNIGHT（class tag=1）非工单所写「战士」**——数据为准。
  单类时 tint FS 坍缩 out=_Color×tex（FS_nokw 反编译：firstMix≡1/secondMix≡0）；
  多类阶梯参数（_MiddleValue −0.04/_StepValue 0.5/margin 0.02，VS 梯度坐标 = POSITION.x）
  已随 T2 材质入包，实现留待多类异画 fixture。
- 肖像：`-signature` 后缀接线（renderPortraitLayer 公式层零改动，_SecondTex 阴影图集 +
  _BlendIntensity 1.75 走 PS 772B 既有直译）。
- 取景锚：frameCenter premium 门放行签名槽（premium 基准 = 自家帧网格导出，
  ExporterController TryGetActorFrameBounds Mesh 回落支）。
- 卡影：零代码改动走既有通路——sig9 `Shadow_Mesh` 节点名不被 STATIC_HIDDEN（精确匹配
  'Shadow'）命中，markOpaqueEdgeSlots 按 FX_Transparent_ColorAsAlpha shader 自动标
  colorAsAlpha 并取材质序列化参数（_Intensity 0.5 / _AlphaIntensity 1.0，与工单口径一致）。

### 8.2 两个渲染序根因（离线链与引擎的结构性差异，后续 sig 帧通用）

1. **Ghost 节点命名后缀漏网**：STATIC_HIDDEN 收 `FX_Ghost_Quad`（普通帧名），
   Evergreen 名为 `FX_Ghost_Quad_Mesh` → 未命中。Ghost quad 深度 ~0.186 浮在卡体
   （~0.0235）前 0.16，漏网时以平蓝 GhostCard 纹理盖住整卡画区、并把肖像层（0.0287）
   挡在 zbuf 外——症状 = 画区平色 + 肖像消失。修法：表补 `_Mesh` 后缀三名。
2. **肖像公式层擦掉乘法层**：签名帧肖像是全出血网格（y127-616，覆盖文字带），而
   TextGradient（Hero/Multiply）在帧光栅阶段已乘上；肖像层（renderPortraitLayer，
   在全帧光栅后强画）以更近深度整片覆写 → 渐变压暗丢失。引擎语义 = Transparent 队列
   画在不透明肖像之后。修法：sig 帧把 TextGradient/Divider 归入 late_nodes
   （既有晚通道 = 肖像/overlay 之后、独立 zbuf）复刻队列序。04 票（spell/weapon 文字层）
   沿用该口径。

### 8.3 残差归因（后续票）

- z_rarity_gem 58.2：宝石四变体网格 + 云纹滚动 + 底影未画（04/05 票；T3 强制隐 +
  rarity_gem 公式抑制）。
- z_art 30.4 / art-mid 行带：UberCardBack Layer1/2/3 流动混合未画（06 票；参考图
  FlickerBright35 高光使画区更亮，本链偏暗 ~20）。
- z_race 36.1：均值已对齐，细结构 = 邻接宝石框边缘 + FX 层。
- Portrait_Mesh_BG（随机像占位，portrait 后 0.005）保持序列化可见——被前肖像覆盖，
  对基准无观测差异；如后续卡出现边缘透出再裁决。

## 9. GDB_477 外框、稀有度与描述文字复核（2026-10-26）

本节更新 §8.3 的 GDB_477 残差快照：外框绑定与 Legendary gem 已修复；L2 对照产物放在
`/private/tmp/GDB_477-fixed-l2/`，不覆盖旧 fixture 或 `explore/**/output/` 证据。

### 9.1 主框 atlas

`Actor.UpdateCardColor` 的普通 premium 路径 (`Actor.cs:6429-6444, 6577-6599`) 只把类色写入
`m_premiumRibbon` slot 2；`SetMaterialNormal` 的普通图集替换仅在佣兵路径
(`Actor.cs:6263-6427`)。GDB_477 `RootObject/Mesh` slot 0 序列化为
`Genfx_Inhand_Signature_Evergreen_Atlas_Mat` + `Signature_Evergreen_Atlas`
(`assets/frames/hand-minion-sig9/frame_recon.json`)。因此帧规划保留该 atlas，不把普通
CardColorSwitcher atlas 注入 slot 0。此修正后的 L2 `mae_visible=25.313`，外框金属角件、木轨与
雕花边完整恢复。

此外，UberCardBack 主材质不只采 `_MainTex`：GDB_477 `m_ValidKeywords=[]`，所选 no-keyword
FS 还采 `_MaskTex` 与 Layer1/2/3、级联 distortion，并用序列化 blend vectors 混层
(`explore/2026-10-25-signature-frame/output/Uber_UberCardBack_FS_nokw.metal:107-168`)；VS 生成
三组 layer UV (`../exporter/tmp/shader/Uber_UberCardBack_VS.metal:145-161`)。旧离线静态主纹理
路径漏掉这些颜色/遮罩层，签名框轨和角件材质因此不完整。现在 no-keyword 分支在 frozen phase
0 采 mask/layers 并按 FS 直译混合（spec 实现决策 5/6）；截图参考对照见 §9.4。

### 9.2 Legendary rarity gem

plan 已选 `RarityGem_Legendary_Mesh`，其 probe 路径为
`RootObject/Mesh/RarityGem_Frame_Mesh/RarityGem_Legendary_Mesh`；两个材质子网格分别是
`Signature_Evergreen_Rarity_Gem_Mat` 与 `Signature_Evergreen_Shadow_Mat`
(`frame_recon.json`)。Actor 按 rarity 激活对应 mesh (`Actor.cs:4939-4959, 4992-5022`)。
缺失外观的原因是通用帧光栅把第一材质按纹理 alpha 做 alpha-over；原 shader 并非透明 pass：
`Hero/Diffuse/DiffuseAlphaMaskScroller` pass 0 为 Blend One/Zero、ZWrite=1
(`../Angelia/lab/2026-10-07-dxbc-rarity-alignment/evidence/shader_meta.json`)，DXBC 像素公式是
`rgb=(cloud.r×_tint×main.a×1.5×_Intensity+main.rgb)×_Fade×_TintColor`、`alpha=1`
(`../Angelia/lab/2026-10-07-dxbc-rarity-alignment/NOTES.md` §2)。VS 的 cloud UV 使用 raw mesh
UV×`(_ScaleX,_ScaleY)` + `T×(_XSpeed,_YSpeed)`，没有 atlas offset；main UV 独立消费
`_MainTex_ST`（同处 §2）。`frame_recon.json` 中 Evergreen 材质参数为 intensity=.7、scale=(6,6)、
speed=(5,.3)、tint=(.90566,.90566,.90566)，贴图是签名 atlas 和 `GenFX_clouds03`；属性族复核见
`../Angelia/lab/2026-10-22-rarity-gem-props/NOTES.md` 表格 Signature_Evergreen 行。

帧光栅现按该 shader 公式直写 RGB、覆盖 alpha=1 并写深度。单独光栅 probe 已显示 atlas UV
能够生成完整菱形；合入正确的 One/Zero pass 后，参考图中的顶端橙色稀有度钻石恢复。旧 L2
`z_rarity_gem` 区间不覆盖 ally 宝石真实投影，不能把它当作宝石局部验收值（位置裁决见
`../Angelia/lab/2026-10-07-dxbc-rarity-alignment/NOTES.md` §3）；本轮可复核的整体 L2 从
外框修复态 `mae_visible=25.313` 降到 `17.776`。

### 9.3 描述文字高度 fit

目标 `PowersUberText` 序列化盒为 width=1.95、height=.87、fontSize=40、characterSize=5、
lineSpacing=.75、ResizeToFit=1，locale 9 没有 width/height override
(`assets/frames/hand-minion-sig9/prefab_ubertext.json`)。断行不变，旧布局停在 cs=.0475；四行
正文的最大墨迹宽因此比参考宽约 5%。

根因在 fit 高度的取整时点：decompiled `UberText.ReduceText_CharSize` 入口先从
`GetTextMeshBounds()` 减 intra-line height，后续 shrink 迭代直接比较裸 bounds；
`UberTextRendering.GetTextMeshBounds` 返回 TextMeshRenderer bounds。引擎抓帧 `localBounds` 与字体
度量账确认 fit 节点的行盒消费 FreeType `metrics.height`（见
`../Angelia/lab/2026-10-17-text-rdc-align/findings/linegap-promotion.md` §10.1）。
FranklinGothic/BlizzardGlobal@40 的 hhea asc−desc 是 48.046875px，而离线 `lineHeight` 先 round
成 48px (`linegap-promotion.md` §1；`freetype-metrics.ts`)。第一次 shrink 后 k=.00475：旧四行盒
`(3×45+48)×k=.86925`，错误地低于 .87；原生浮点 bounds
`(3×48.046875×.9375+48.046875)×k=.87010`，超过 .87，故引擎再乘 .95。fit 判据改用 float
`lineSpan` 测 TextMesh bounds；wrap、字形 advance 与渲染 pitch 不变。完整出图的 `z_desc` 从
45.226 降到 20.182，正文宽度与参考图对齐。

### 9.4 全量 L2

2026-10-26 对全部 42 张 reference fixture 重渲并跑 L2。与 2026-10-25 T3 验收结果逐键比较：
**仅 GDB_477 一行变化，10 个数值全改善，其余 41 行逐键不变，0 回退**。manifest 中 36 张
`premium=NORMAL` fixture 的 RGBA 像素 buffer 与先前渲染逐张相同（36/36）。当前 GDB_477 指标为
`mae_visible=17.776`、`mae_nontext=15.140`、`z_desc=20.182`；T3 已记录的起点为 `mae_visible=34.1`
（§8）。正文前三行在 reference/candidate 的阈值墨迹包围盒分别为 x=123..394/122..394、
123..396/122..395、122..396/122..395（512×768 原图像素），佐证旧 5% 宽差已消失。
`bun run typecheck` 通过；本轮未新增测试 seam。

### 9.5 种族文字下锚点（2026-10-26）

GDB_477 的「野兽」候选墨迹比 reference 高约 4 px。签名帧探针
`assets/frames/hand-minion-sig9/prefab_ubertext.json` 中 `RacePlate_UberText` 的
`m_Alignment=Center`、`m_Anchor=Lower`、`m_Height=.2`、`m_LineSpacing=.7`；TS 文字层此前
一律围绕节点原点居中排版，未消费这个下锚点。

反编译 `explore/ilspy/UberText.Runtime.full.cs:1931-1991`
（`UberText.SetupTextMeshAlignment`）证实 Center/Lower 会把 TextMesh 对象按
`GetAlignmentOffset(0, -height/2)` 下移，并设置 `TextAnchor.LowerCenter`。相对于离线居中的
行块，净位移为 `(文字框高度 - 行块高度)/2`。`ubertext.ts` 现对签名帧的非中间垂直锚点应用此
补偿；门限只按签名帧槽位与序列化 anchor 触发。

GDB_477 的 `z_race` 从 **15.074** 降至 **13.053**，`mae_visible` 从 **17.776** 降至
**17.623**。修正后的并排图为 `/private/tmp/signature-frames-final-current-l2/GDB_477_side.png`；
`bun run typecheck` 与 `git diff --check` 通过。

## 10. Evergreen 法术/武器帧与文字层（2026-10-26）

工单 `.scratch/signature-frames/issues/04`。此前 `FRAME_RULES` 只有 frame 9，frame 10/12 虽有
抽取资产与 `SIGNATURE_FRAME_TO_SLOT` 映射，但 `slotForFixture` 要求规则和资产同时可用，故
TLC_433 / TLC_EVENT_402 告警后分别回落普通法术/武器帧。回落前 L2 为 **109.384 / 83.008**。
这与游戏的帧选择不符：`ActorNames.GetSignatureActor`（`ActorNames.cs:885-923`）按
`CARD.m_signatureFrameId` 查 `SignatureHand[frameId]`；`CardTextureLoader.LoadSignature`
（`CardTextureLoader.cs:235-259`）加载签名材质和原画。

`plan.ts` 现为 `hand-spell-sig10` 绑定 `RarityGem_Frame_Mesh` 与 cost/name/desc/race 文字角色，
并把 race 角色按 spell 的学派分支取值（`Actor.cs:6143, 6160-6166`）；`hand-weapon-sig12`
绑定签名稀有度框、`Wep_Swords` 攻击图标、`Wep_SheildBroken` 耐久图标及对应文字角色。
具体 prefab 证据在 `assets/frames/hand-spell-sig10/frame_recon.json` 和
`assets/frames/hand-weapon-sig12/frame_recon.json`：前者的主框使用
`Signature_Evergreen_Atlas`，后者使用 `Signature_Weapon_Atlas`；两者均序列化
`TextGradient[SignatureCardGradientOverlay, Hero/Multiply/Multiply]` 和
`NameBanner_Mesh/Divider[SignatureCardDivider, Hero/Unlit/Unlit_TransparentColor]`，两层共用
`card_signature_text_gradient`。其透明排序根因及离线队列差异见 §8.2：肖像层强画全出血原画，
若渐变仍在主帧光栅中就会被覆盖；签名 `late_nodes` 在肖像之后单独合成两节点，复刻游戏透明队列顺序。

### 10.1 全量 L2 与像素回归

用当前代码重渲 manifest 的 43 张 fixture，针对 42 张 reference 基准运行 L2，并与本票前保存的
全量结果逐项比较：无任何卡片/分区指标回退。目标卡结果：

| fixture | `mae_visible`（前 → 后） | 其他结果 |
|---|---:|---|
| TLC_433 | 109.384 → **46.056** | `mae_nontext` 107.657 → 44.590；`z_banner` 131.230 → 47.437；`z_desc` 106.475 → 51.576 |
| TLC_EVENT_402 | 83.008 → **49.913** | 武器框、剑座、耐久宝石位与文字层进入签名帧链 |
| GDB_477 | 17.623 → **17.623** | 全部指标逐项相同 |

43 个渲染 PNG 解码为 RGBA 后比较，只有 TLC_433 与 TLC_EVENT_402 的像素 buffer 变化，其余
41 张逐像素相同。`bun run typecheck` 通过；`plan.ts` 单文件 ESLint 通过。全仓 ESLint 仍有
12 个既有错误（build-worker、resize 与 textbuilder dist），本票没有新增 lint 错误。目标并排图、
L2 summary 与像素对照保存在 `/private/tmp/signature-frame-04-after/`（不覆盖旧实验输出）。

本票通过工具门控；最终视觉验收仍需用户查看并排图。后续残差仍包括异画 rarity gem 双层和
UberCardBack Layer1/2/3 特效，分别归 issue 05/06。

### 10.2 武器攻/耐久图标交叠处被文字渐变压暗（2026-10-26）

用户在 TLC_EVENT_402 目检发现：攻/耐久图标与签名原画相交处出现暗遮罩，残差集中在亮度。
隔离确认它不是攻/耐久宝石或数字字形：`render-card.ts::renderPackToRgba8` 的 p0 已含签名
`late_nodes`，而 p0→p1 仅费用宝石变化，攻/耐久图标像素不变。

根因是晚通道深度隔离过宽。`TextGradient`（`Hero/Multiply/Multiply`）被延到肖像之后是正确的，
但每个晚节点都用空 `nodeZbuf`，使乘法层不再对之前绘制的不透明武器统计网格做 ZTest。原始探针
`assets/frames/hand-weapon-sig12/frame_recon.json` 显示：`TextGradient` 世界 Y=0.0292267；
`Wep_Swords` 与 `Wep_SheildBroken` 的材质为 `Hero/Unlit/Unlit_Texture`，世界深度范围约
0.0139–0.1425 与 0.0612–0.1574。`../Angelia/lab/2026-10-04-badge-trio/findings/badge-trio.md` §2
记录该 shader 的 pass 为 Blend One/Zero、ZWrite On；`../Angelia/docs/notes/bacon-frame-furniture.md`
记 `Hero/Multiply/Multiply` 的乘法 PS。行为链
`../Angelia/scripts/render/engine/raster.py::raster_bucket_zbuf_unified` 把 multiply 延至透明队列，
`draw_transparent_deferred` 在肖像之后仍传入相同 zbuf、以 `zwrite=False` 补画。也就是说透明层仍
需测试前序不透明深度；离线原实现因空 zbuf 漏掉了这一步。

修正只在晚通道 multiply 层与可见 `Wep_Swords`/`Wep_SheildBroken` 同时存在时复用帧+肖像 zbuf。
multiply 分支不写深度，因此前景图标能挡住渐变，渐变仍覆盖其后的原画；其它签名帧与晚通道不改。
同卡 p0 隔离区域 max-RGB MAE：攻区 42.640→40.271，耐久区 59.023→58.263。全量重渲 43 张 fixture，
与修复前文件逐像素比较仅 `TLC_EVENT_402` 改变（3,621 个 RGBA 像素，bbox `[87,384,419,614]`）；
42 张 reference 的 L2 门无任何分区回退，`TLC_EVENT_402 mae_visible` 49.913→49.902。用户已目视确认
攻/耐久与插画交叠处不再有可见异常。完整结果与并排图：
`/private/tmp/signature-frame-04-fix-final/{fixtures,l2/}`，攻/耐久放大对照为
`/private/tmp/signature-frame-04-fix-final/l2/TLC_EVENT_402_stats_zoom.png`。类型检查、该文件 ESLint、
`git diff --check` 均通过；用户已完成视觉验收。

## 11. Signature_26 帧与双层稀有度宝石（WW_373，2026-10-26）

工单 `.scratch/signature-frames/issues/05`。修复前 `slotForFixture` 因 `FRAME_RULES` 缺少
`hand-minion-sig2`，将 `signatureFrameId=2` 的 WW_373 回落到普通 `hand-minion`；L2 为
`mae_visible=102.015`、`mae_nontext=97.166`、`z_rarity_gem=114.095`。游戏路径由
`ActorNames.GetSignatureActor`（`ActorNames.cs:885-923`）按 `CARD.m_signatureFrameId` 直接选
`SignatureHand[2]`；离线链额外要求该槽位具备 `FRAME_RULES` 才会选择签名帧。

`plan.ts` 登记 frame 2 的原生随从类型、稀有度框、攻血宝石与文本角色，并由签名帧既有选择器
激活对应稀有度子网格。UnityPy 探针 `assets/frames/hand-minion-sig2/frame_recon.json` 中，
`RootObject/Mesh/RarityGem_Frame_Mesh` 含 Common/Rare/Epic/Legendary 四个子网格；
WW_373 的 Legendary 子网格有两个材质：云纹主体 `Signature_Evergreen_Rarity_Gem_Mat`
（`Hero/Diffuse/DiffuseAlphaMaskScroller`，`_Intensity=.7`、scale `(6,6)`、速度 `(5,.3)`）和
底影 `Signature_Evergreen_Shadow_Mat`（`Hero/Multiply/Multiply_AlphaFade`）。前者采用 shader
pass 0 的 Blend One/Zero、ZWrite=1、alpha=1 语义，公式证据见 `../Angelia/lab/2026-10-07-dxbc-rarity-alignment/NOTES.md` §2
及其 `evidence/shader_meta.json`；离线链若按通用 alpha-over 绘制会让橙色宝石透出底色。已有
`render.ts` 签名槽位 shader 路径与 `raster.ts` 对应公式承接这两个材质，无需扩大 shader 实现范围。

全量 43 张 fixture 渲染输出到 `explore/2026-10-26-signature26-frame-gem/output/`。WW_373 的
`mae_visible` **102.015 → 41.695**，`mae_nontext` **97.166 → 35.946**，`z_rarity_gem`
**114.095 → 71.241**。42 张 reference 的 L2 对照以 `out/l2/summary.json` 为基线，门控报告
无分区回退。解码 RGBA 后比较全部 43 张候选与既有 `out/fixtures/` 渲染，唯一变化为 WW_373
（289,345 个像素、744,569 个通道值变化）；其余 42 张逐像素相同。`bun run typecheck`、
`bunx eslint packages/renderer/src/plan.ts --quiet` 与 `git diff --check` 通过。WW_373 并排图和热图：
`explore/2026-10-26-signature26-frame-gem/output/l2/WW_373_side.png`、
`explore/2026-10-26-signature26-frame-gem/output/l2/WW_373_heat.png`。

用户目视反馈：画面相对一致；这不代表当前残差可接受，后续可能需要单独立项修正。上面的 L2
数字用于记录本次变化，不构成残差验收阈值。

## 12. UberCardBack 三层特效与相位判定（frame 2/9/10/12，2026-10-26）

工单 `.scratch/signature-frames/issues/06`。本轮确认运行时代码已在 GDB_477 的外框修复中按
no-keyword Metal 变体实现 Layer1/2/3；本票补齐逐层 L2 与相位证据，不再复制一份 shader 路径。
`packages/renderer/src/render.ts` 依据 `mat.keywords.m_ValidKeywords.length === 0` 选择该分支。
四个当前槽位（`hand-minion-sig2/sig9`、`hand-spell-sig10`、`hand-weapon-sig12`）所有
`Uber/UberCardBack` 材质的 `m_ValidKeywords` 都是空数组；因此材质虽序列化了部分
`_Layer*_FlowTex`，这些 frame 当前不启用 `_LAYER*_FLOWMAP` keyword，也不应采 FlowTex。
各槽探针位于对应 `assets/frames/<slot>/frame_recon.json` 的 `RootObject/Mesh` 子网格材质。

选中变体的 Metal 证据：`explore/2026-10-25-signature-frame/output/Uber_UberCardBack_FS_nokw.metal`
107-131 行按 Mask 通道计算层权重并采样 Layer3→2→1→MainTex，132-211 行逐层执行序列化
颜色/Blend 公式，212 行 clamp 输出；`../exporter/tmp/shader/Uber_UberCardBack_VS.metal`
145-161 行展示 Layer1 的旋转、缩放与时间平移，后续块对 Layer2/3 同构。
离线先前的 MainTex-only 路径漏掉这些层，签名框轨与角件少了动画颜色/扰动；当前
`packages/renderer/src/uber-card-back.ts` 对该 no-keyword FS 做逐像素 CPU 直译。源代码中的
`_ShaderTime=0` 回落到 `render.ts` 传入的时间 0，因此基准输出采用 `_Time.x=0`。

为分离每层贡献，在实验 pack 副本中将后续层的 `_LayerN_Mask` 置零，并按 none → +Layer1 →
+Layer2 → +Layer3 各跑四张卡的 L2；没有改动 `assets/` 原 pack。`mae_visible` 逐阶段数字：

| fixture | no layers | +Layer1 | +Layer2 | +Layer3 | `z_art`（同顺序） |
|---|---:|---:|---:|---:|---|
| GDB_477 | 18.092 | 17.863 | 17.752 | 17.623 | 26.666 → 26.544 → 26.544 → 26.464 |
| WW_373 | 41.573 | 41.625 | 41.686 | 41.695 | 34.946 → 35.084 → 35.084 → 35.090 |
| TLC_433 | 45.975 | 45.893 | 45.995 | 46.056 | 49.622 → 49.563 → 49.562 → 49.599 |
| TLC_EVENT_402 | 49.466 | 49.332 | 49.821 | 49.902 | — |

增量较小且不同卡方向不一：Layer1 对 GDB_477/TLC_433/TLC_EVENT_402 有轻微改善，对 WW_373
略差；Layer2 的整卡误差对除 GDB_477 外三卡均增加；Layer3 只给 GDB_477 带来小幅改善，另外
三卡近似持平或略差。保留 shader 层是因为它们是该 prefab 选中材质的真实 FS 行为，而非按
fixture MAE 调参关闭效果。

按 spec 决策 6 对四个基准图做 `_Time.x=0..1.2`、步长 0.1 粗扫，并在 0.4..0.65 步长 0.025
细扫；武器卡另扫 0.8..1.0。效果像素域定义为相位候选与 no-layer 输出不相同的可见像素并集。
细扫局部最佳相位分散：GDB_477=0.500（效果域 MAE 5.502→4.904），WW_373=0.425
（42.650→41.529），TLC_433=0.625（49.269→49.081），TLC_EVENT_402=0.625
（51.734→50.518）。单个共同采样点 0.5 令四卡全卡 MAE 均略降，但各曲线没有共同的单峰；
全卡 MAE 的改善仅 0.022–0.106，最佳共同采样相位对效果域误差的合计改善也只有约 1.3%。因此这组
基准没有给出足以替换默认相位的稳定共同拟合，运行时继续使用 `_Time.x=0`，不按卡写入特例相位。

全量 43 张当前 zero-phase 输出与工单 05 的候选 PNG 解码 RGBA 对比 **43/43 逐像素相同**；
对 42 张 reference fixture 的 L2 与工单 05 基线相比 **无分区回退**。检查点、相位扫描、摘要和
最终 L2 产物保存在 `explore/2026-10-26-signature-uber-layers-phase/output/`。

## 13. Signature_25 玻璃层与绘制顺序（RLK_706，2026-10-26）

工单 `.scratch/signature-frames/issues/07`。此前 frame 1 虽有
`SIGNATURE_FRAME_TO_SLOT`，但缺少 `SLOT_NATIVE_CARD_TYPES` / `FRAME_RULES` 登记，离线选择器会
回退普通随从帧；通用帧 raster 对 `Transluscent_Mesh` 只采 `_MainTex`，随后肖像阶段强画原画，既漏掉
Glass Mask 透明度也覆盖名称框两端。`assets/frames/hand-minion-sig1/frame_recon.json` 的
`RootObject/Mesh/Transluscent_Mesh` 有 323 tris、`m_ValidKeywords=[]`、Signature_25 Atlas + Glass
Mask；同一层级还记录 `DescriptionBox_Mesh`、`RacePlate_Mesh` 以及三枚 `_Mesh` 后缀统计宝石。
其中 `DescriptionBox_Mesh` 的原始 MeshFilter.m_Mesh=0 且 MeshRenderer disabled；
`Actor.cs::UpdateDescriptionMesh`（:5013-5038）只启停该 Renderer/GameObject，没有给随从帧设置替换网格。
故可见描述底板由主 `Mesh` 的 Signature_25 图集几何承载，空 DescriptionBox 占位不单独出图。

主 pass 证据来自游戏 Shader `Hero/Unlit/Unlit_Transparent2uvScrollMaskScroll` 的 no-keyword Metal
变体：`explore/2026-10-26-signature25-glass-ordering/output/shader/Hero_Unlit_Unlit_Transparent2uvScrollMaskScroll_VS_nokw.metal:116-132`
构造 UV0/UV1 插值流；对应 `Hero_Unlit_Unlit_Transparent2uvScrollMaskScroll_FS_nokw.metal:67-75`
读取 MaskTex 的 Z/Y/X 通道求 alpha，并以 MainTex RGB 作为颜色。
材质的 `m_ValidKeywords=[]` 选择 no-keyword 变体。RTT pass 选择由
`../exporter/tmp/ilspy/Assembly-Csharp/RenderCommandLists.cs::AppendRenderCommands`（:49-54、
187-204）限定为 `SRPDefaultUnlit` / `UniversalForward` / `LightweightForward`，故只执行 pass 0；
shader bundle `essential_base_global-shader-0.unity3d` 中该 pass 状态是 SrcAlpha/OneMinusSrcAlpha、
ZTest LEqual、ZWrite Off。后两个 GlowPrePass / Glow 未被 command collector 选中，故本实现不把
`_Fresnel*`、`_Glow*`、`_Add*` 材质属性误当作 pass 0 公式。`Transluscent_Mesh` 原始 mesh 没有 UV1
顶点通道且 COLOR 通道维度为 0；`scripts/extract_frame.py:289-293` 的既有离线包格式将 uv1 回退为
uv0。纹理 bundle
`initial_base_global-8411aad9-texture-5.unity3d` 中 Signature_25 Atlas（1024²）与 Glass Mask（256²）
均为 Bilinear + Repeat。

实现登记 frame 1 原生随从 / 组件规则，将带 `_Mesh` 后缀的攻血费网格导入既有宝石阶段且不在帧阶段
重复绘制；`Transluscent_Mesh` 在肖像之后、文字之前延后，并以共享帧/肖像 z-buffer 执行 LEqual、
保持深度不写。对应游戏和离线差异由 RTT 的 `RenderCommandLists.cs::SortRenderCommands`（:70-76）
按 sortingOrder 排序，以及离线链把肖像作为强制独立合成阶段所致。

全量 43 fixture 重渲至 `explore/2026-10-26-signature25-glass-ordering/output/rendered/`；L2 对
42 张已有 reference 的 fixture 与 `out/l2/summary.json` 比较无逐卡/逐区回退。RLK_706
`mae_visible` **91.865 → 50.765**，`mae_nontext` **87.119 → 44.294**。另四张 SIGNATURE 无变化：
WW_373 41.695、GDB_477 17.623、TLC_433 46.056、TLC_EVENT_402 49.902。43 张 manifest 中
`BG24_Reward_107` 缺少 `reference/` 基准图，因此未纳入这轮 L2。逐位比较候选和工单前
`out/fixtures/` 的解码 RGBA：只有 RLK_706 改变（335,626 像素，bbox `[0,35,511,709]`）；其余
42 张完全相同，含 38 张非 SIGNATURE 输出。并排与热图为
`explore/2026-10-26-signature25-glass-ordering/output/l2/RLK_706_side.png` / `RLK_706_heat.png`。
`bun run typecheck`、改动 renderer 文件 ESLint 与 `git diff --check` 通过。2026-10-26 用户目视通过
RLK_706 的帧体、描述框、种族板、玻璃层与名称框两端；工单 07 已完成。五卡整体验收由工单 08 跟进。

## 14. 阶段 A 收口：五张异画最终 L2 与遗留残差（2026-10-26）

最终值取自工单 07 的全量候选 `explore/2026-10-26-signature25-glass-ordering/output/l2/summary.json`；
批次前值取自 `explore/2026-10-25-image-residual-diagnosis/output/full-fixtures-baseline-l2/summary.json`。
两边使用相同的 frozen reference 图和 L2 口径。改善量为批次前 `mae_visible` 减最终值，仅描述变化，
不构成残差验收阈值。

| fixture | 批次前 `mae_visible` | 阶段 A 最终 | 改善量 | 当前可见分区残差（最终 L2） |
|---|---:|---:|---:|---|
| TLC_433 | 109.384 | 46.056 | 63.328 | `z_rarity_gem` 62.450、`z_desc` 51.576、`z_art` 49.599、`z_banner` 47.437 |
| WW_373 | 102.015 | 41.695 | 60.320 | `z_rarity_gem` 71.241、`z_desc` 51.716、`z_attack` 41.721、`z_health` 41.209 |
| GDB_477 | 92.167 | 17.623 | 74.544 | `z_banner` 32.549、`z_art` 26.464、`z_rarity_gem` 24.622 |
| RLK_706 | 91.865 | 50.765 | 41.100 | `z_cost` 76.316、`z_rarity_gem` 66.888、`z_race` 64.919、`z_desc` 61.646 |
| TLC_EVENT_402 | 83.008 | 49.902 | 33.106 | 当前 L2 summary 未提供该卡分区项，保留整体值，不推断局部根因 |

阶段 A 累计像素回归依据各实现票的 RGBA 对照：03 只改变 GDB_477，04 只改变 TLC_433 / TLC_EVENT_402，
05 只改变 WW_373，06 与 05 候选 43/43 逐像素相同，07 只改变 RLK_706；因此其余 38 张非 SIGNATURE
fixture 在本批次保持逐像素不变。每票对 42 张已有 reference 的 L2 分区门均无回退；manifest 中
`BG24_Reward_107` 没有 reference PNG，不纳入 L2。

### 14.1 遗留残差与可证实的归因边界

| 类别 | 当前证据 | 后续归因口径 |
|---|---|---|
| 结构 / 局部 | 上表中 `z_rarity_gem`、`z_desc`、`z_banner`、`z_race`、`z_art` 仍有较高残差；这些数值只定位区域，不单独证明几何或绘制顺序根因。 | 后续若继续降低 L2，按热区隔离具体网格、文字、宝石或帧层；不能仅凭总体 MAE 做结构性改动。 |
| 相位 | frame 2/9/10/12 的 `_Time.x` 扫描最佳点分散在 GDB_477=0.500、WW_373=0.425、TLC_433/TLC_EVENT_402=0.625；共同采样点没有稳定单峰，整体收益很小。阶段 A 因而保留规范冻结相位 `_Time.x=0`，没有逐卡拟合。 | 动画定格带来的单卡残差仍可能存在；RLK_706 的 Signature_25 玻璃也按 `_Time.x=0` 冻结，尚无单独相位扫描。若新增证据，按各卡本地 reference 重新扫描并做等量平亮对照。 |
| 素材 / 材质 | 四个 UberCardBack 材质的 `m_ValidKeywords=[]`，所以当前 prefab 不选 `_LAYER*_FLOWMAP` 变体；Layer1/2/3 的无 keyword 数学已按 Metal 变体翻译。RLK_706 玻璃仅绘制 RTT 选中的 pass 0；`AppendRenderCommands` 不收 GlowPrePass/Glow。 | 已核实的纹理、mask、keyword 与 pass 边界没有显示遗漏的已选输入。剩余局部差异若怀疑素材/材质，须以新的 UnityPy 探针或 RTT/Metal 证据定位；现阶段不把残差笼统归因于“贴图不对”。 |

本表记录已定位的热点和证据边界。用户于 2026-10-26 确认五张最终对照图整体观感与基准对齐；该确认不代表这些残差已被接受或达到数值阈值，继续优化可另立工单。
