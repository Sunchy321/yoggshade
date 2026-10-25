# 异画（SIGNATURE）渲染研究

日期：2026-10-25。性质：**研究记录，未做任何渲染实现**（用户口径的「异画」= `TAG_PREMIUM.SIGNATURE`）。
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
