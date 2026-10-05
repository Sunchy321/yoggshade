# banner-recon 调研：可交易 / 锻造 / 阵营 / 多职业横幅（2026-10-05）

任务：为「添加 banner 渲染」做前期调研——概念、反编译对应、exporter 处理、基准卡。
探针脚本（自包含、只读游戏包）：
- `probe_nested_prefab.py` — Card_Hand_Ally Actor 上四个 NestedPrefab 字段的 m_Prefab 引用
- `probe_banner_prefabs.py` — 四个嵌套横幅 prefab 的层级/材质/纹理/ST 全量 dump（→ `banner_prefabs_dump.txt`）
- `probe_bench_candidates.py` — 全量 DBF 筛候选基准卡

## 1. 概念与 GameTag（GAME_TAG.cs，exporter ilspy 缓存 Assembly-Csharp）

| 机制 | tag | 值 | 横幅载体 |
|---|---|---|---|
| 可交易 TRADEABLE | 1720 | :826 | DeckActionBanner（NestedPrefab `Tradeable_Banner.prefab:2b8ee190…`） |
| 锻造 FORGE | 2785 | :827 | 同上（`Forgeable_Banner.prefab:fca896d8…`） |
| 锻造为 FORGES_INTO | 3074 | :829 | （YOG_502=100876 指向锻造目标卡） |
| 准备 PREPARE | 4354 | :830 | 同上（`Prepareable_Banner.prefab:fccd1c9e…`） |
| 阵营（星际）TERRAN/ZERG/PROTOSS | 3458/3457/3469 | :764-766 | HearthstoneFactionBanner（NestedPrefab `Faction_Banner.prefab:0a0897af…`） |
| 帮派（加基帮）GRIMY_GOONS/KABAL/JADE_LOTUS | 482/484/483 | :673-675 | 同上（FactionColorType 1/2/3） |
| 多职业 MULTIPLE_CLASSES | 476 | :669 | m_multiclassRibbon（帧内网格，非嵌套 prefab） |

- MULTIPLE_CLASSES 是位掩码：EntityBase.GetClasses（EntityBase.cs:1087-1110）从 bit1 起逐位展开为
  TAG_CLASS（本版本枚举：1=DK,2=德,3=猎,4=法,5=骑,6=牧,7=贼,8=萨,9=术,10=战,11=梦,12=中立,13=Whizbang,14=DH）。
  实测：WON_332=194→德/贼/萨 ✓；泰伦随从=656→骑/萨/战；星灵=106→德/法/牧/贼(4类)；虫族=8453→DK/猎/术/DH。
  星际卡的掩码是「可编入哪些职业」的组卡限制，同时驱动绶带显隐（classes.Count>2）。
- 注意 3457 不是 TRADEABLE（旧印象有误），TRADEABLE=1720；exporter AllRenderMechanics 表同值
  （ExporterController.cs:207-260：tradeable 1720 / forge 2785 / prepare 4354）。

## 2. 反编译运行时链（Assembly-Csharp）

- 刷新链：`Actor.UpdateAllComponents()`（Actor.cs:1993）→ `UpdateMeshComponents()`
  （4877-4889：UpdateCardColor 4883 → UpdateCardRuneBannerComponent 4887 → UpdateMulticlassRibbon 4888）。
- **UpdateCardColor（Actor.cs:6304-6452）**，6418-6445：
  `flag5=HasHearthstoneFaction()`（VALID_FACTIONS=GRIMY_GOONS/KABAL/JADE_LOTUS/ZERG/TERRAN/PROTOSS，
  Actor.cs:205-213, GetHearthstoneFaction 1423-1446）；`flag6/7/8=IsTradeable/IsForgeable/IsPrepareable()`
  （→ EntityBase.cs:1282-1300 HasTag(TRADEABLE/FORGE/PREPARE)）。
  - `m_hearthstoneFactionBannerContainer?.gameObject.SetActive(flag5)`（6422）+ 实例化后
    `SetFactionType(m_premiumType, CardColorSwitcher.GetFactionColorTypeForTag(...))`（6426-6430）。
  - deck-action 三容器 SetActive 后 **else-if 链**（6431-6445）：tradeable / forge / prepare 互斥，同一锚位。
- **UpdateMulticlassRibbon（Actor.cs:6068-6075）**：`m_multiclassRibbon.SetActive(GetClasses().Count > 2)`
  ——只对 ≥3 职业显示；双职业（2 类）只有框体双色（CardColorSwitcher.ColorType 的 11 个 *_DUALCLASS 槽，
  GetCardColorTypeForClasses 121-149，经 _EnableDualClass 材质上框，与绶带无关）。
- **DeckActionBanner.cs**（15 行）：只有 `m_deckActionHighlight_Green/Blue` + SetHighlightState；
  图标横幅本体全在嵌套 prefab。**ForgeBanner.cs** 全缓存零引用（遗留类，可忽略）。
- **HearthstoneFactionBanner.cs**（15-29）：SetFactionType(premium, factionColorType) →
  icon 材质 = `CardColorSwitcher.GetMaterialIcon(premium, type)`（premium==SIGNATURE 时用
  `factionIconMaterialsSignature`，否则 `factionIconMaterials`）、banner 材质 = `GetMaterialBanner(type)`；
  三者都是 CardColorSwitcher 上 `List<string>`（材质 AssetReference，name:guid），按 FactionColorType
  索引（CardColorSwitcher.cs:56-65 枚举 GENERIC/GOONS/KABAL/LOTUS/ZERG/TERRAN/PROTOSS；81-88 字段；
  199-212 tag→枚举）。列表值尚未探测进 tables.json（extract_static_tables.py 只导了 frame 颜色贴图）。
- **NestedPrefabBase.LoadPrefab（NestedPrefabBase.cs:86-96）**：实例化后 `localPosition=Vector3.zero`
  挂到容器节点、保留 prefab 根的 localRotation/localScale → 离线复算 = 容器世界矩阵 × prefab 根
  （pos 置零，rot 恒等，scale y=0.48029）× Banner_Root(-0.009,0.2,0.165, rotY 180°) × mesh 节点。
  prefab 根序列化 pos(-15.9,1.6,-9.9) 是场景残留，被置零丢弃。
- HideImpl（Actor.cs:1792-1794）收卡时强制关 tradeable 容器；悬停高亮走 Spell 层
  （Card.cs:4977-5000 UpdateDeckActionHover / ShowTradeableHover 10058 等），默认态不涉及。

## 3. 嵌套 prefab 资产结构（probe_banner_prefabs.py dump）

四个 prefab 同构（探针输出 `banner_prefabs_dump.txt`）：
- **DeckAction 三兄弟**：`Banner_Root` → `{Tradeable|Forgeable|Prepareable}_Banner_mesh`
  （网格共用 `Tradeable_Banner_mesh` @ initial_base_global-910a3655-mesh-0，材质各异：
  Tradeable_Banner / Forgeable_Banner / Prepare_Banner，_MainTex =
  `Card_Inhand_Tradeable_Banner` / `Card_Inhand_Forgeable_Banner` / `Card_Inhand_Prepare_Banner`）
  + `ShadowQuad`（共用 `Tradeable_banner_shadow` 网格，*_shadow 材质，同贴图）
  + Glow_Green/Blue（enabled=False，悬停态，默认不渲染）。根 scale y=0.48029。
- **Faction_Banner**：`Faction_Banner`（激活；= m_factionBannerRef；网格同 Tradeable_Banner_mesh，
  材质 Faction_Banner，_MainTex=`Card_Inhand_Faction_Banner`）+ `Faction_Icon`（激活；= m_factionIconRef；
  内建 quad，rot z-90°/y90°，scale 0.36361，pos(0.842,0,-0.634)；序列化材质 Faction_Icon_Terran，
  _MainTex=`Faction_Icons`，ST scale 0.25（4×4 图集）、offset(0.5,0.75)——运行时按阵营整体换材质）
  + `ShadowQuad`（m_shadowRef，借 TradeableBanner_shadow）+ `Faction_Banner_mesh`（**失活遗留槽**）。
- **多职业绶带（帧内，非嵌套）**：节点 `Multiclass_Ribbon`（minion 帧）/`MulticlassRibbon`（spell/hero/location），
  子树 `Ribbon_Root/Multiclass_Ribbon_mesh`（+Shadow_mesh，Hero/Multiply/Multiply）与
  `Multiclass_Ribbon_Signature_mesh`（+Shadow）。三个通用帧预制均 **normal 网格 self_active=True、
  signature self_active=False**（probe 实测）→ 通用帧只有平面棕版；CATA_190h 参考图的金色透视版
  来自 `Card_Hand_Hero_Signature_Deathwing` 帧（signature 网格激活），属未移植 premium 帧族。
  材质 Multiclass_Ribbon = Hero/Unlit/Unlit_Texture，_MainTex=`Card_Inhand_Multiclass_Ribbon`
  （已入包 frames/hand-minion/textures/；UV offset -0.53,-0.048 序列化在帧 recon）。
- 帧覆盖面：minion/spell/weapon/location 通用帧有全部容器字段 + 绶带网格；**hand-hero 通用帧
  没有 tradeable/forge/prepare 容器字段**（不可能显示），faction 容器字段有（无 fixture 验证过）；
  hand-heropower 什么都没有；bg-anomaly/bg-trinket 有容器但另有 MulticlassBannerContainer（战棋无职业，未激活）。
- 需新提取的资产：3 张 deck-action 贴图 + Faction_Banner 贴图 + Faction_Icons 图集 +
  Tradeable_Banner_mesh / Tradeable_banner_shadow 网格（可并成一个 extract 脚本， bundle
  initial_base_global-7d7ed54d-prefab-{0,1} / 910a3655-mesh-0 / 8411aad9-texture-*）；
  另需探测 CardColorSwitcher 的 faction 三材质列表（essential_base_global-prefab-0.unity3d，
  与 tables.json colorSwitcher 同源）。

## 4. exporter（L2 基准方）的处理

- 协议：renderMechanics 一等公民 tradeable(1720)/forge(2785)/prepare(4354)（protocol md L317/365/382/393）；
  插件把它 SetTag 进克隆 EntityDef（ExporterController.cs:4505-4517）→ **游戏原生 prefab 自己亮横幅**，
  插件不做节点操作。多职业走 `renderModel.classes` → ApplyClassOverride（4698-4737，MULTIPLE_CLASSES
  位掩码 + CLASS=0）。阵营无协议字段（卡自身 tag 原生驱动）。
- 正常导出路径**不隐藏**任何这些横幅；占位灰卡模式才 DisableFactionBannerRenderer（7017-7033）。
- 佣兵阵营横幅 Harmony 跳过（StartupPatches.cs:260-276，无关）。
- 横幅节点进 opaque-edge alpha 修复白名单（IsOpaqueEdgeAlphaRepairName 7925-7947：Forge/Prepare/
  Tradeable(Banner)、Multiclass_Ribbon(MulticlassRibbon)、Rune_*、Card_Location_InHand_BannerAtlas…）
  ——本仓 plan.ts OPAQUE_EDGE_PATTERNS（plan.ts:87-92）已逐字同源移植，无需改。

## 5. L2 现状与基准卡

现有 32 张 fixture 已覆盖（基准图已在 reference/，无需重导）：
- **WON_332**（玉莲帮密探）：JADE_LOTUS 阵营横幅（费用宝石下左侧铭牌）+ 3 职业绶带（右缘三点铭牌）。
  当前 TS 渲染缺两者（render 对比确认 delta 仅这两处）。
- **YOG_502**（清理污染）：FORGE 锻造横幅（同位铁砧铭牌）。delta 仅此一处。
- **CATA_190h**（灭世者死亡之翼）：6 职业 → 绶带（金色透视变体，Deathwing 签名帧序列化）。
  delta 仅绶带；变体受 premium 帧族缺口限制（见残差）。
- **SC_004**（刀锋女王凯瑞甘）：ZERG tag 在身但 L2 **无任何横幅**（Evergreen 签名英雄帧；英雄帧无
  deck-action 容器字段；该帧族整体未移植，当前渲染帧与 L2 帧不同属既有缺口）。

缺口（现有 fixture 无）→ 建议新增 preset 行（CardPresets.md → 游戏内导出 → data/fixture.md 加行 →
extract_fixture_data）：
- 可交易随从：**WW_331 奇迹推销员**（dbf 100101，1 费稀有）。
- 星灵随从：**SC_764**（dbf 113738，2 费稀有，multi=0 → 纯阵营横幅无绶带）。
- 泰伦随从：**SC_408**（dbf 112912，4 费稀有，multi=656 → 阵营横幅+绶带同显）。
- 虫族随从：**SC_018**（dbf 113663，4 费史诗，multi=0）——钉死 Zerg 图标图集象限。
（DBF 实测：可交易随从 32 / 法术 35 张；泰伦 17 / 星灵 15 / 虫族 16 张随从可替换。）
PREPARE(4354) 不在本次范围（用户未点名；资产同源，后补 +10 行）。

## 6. 已知残差（实现时登记）

1. CATA_190h 绶带变体：L2=金色透视（signature 网格，Deathwing 签名帧序列化），本链通用 hero 帧
   只有平面棕版 → premium 帧族（five-cardtypes §6）落地前的家族性残差，与符文横幅 ~10px 偏移同族。
2. SC_004：帧族未移植，L2 全帧不可对齐；实现按统一反编译逻辑（4 类→绶带应显）而不做逐卡抑制，
   SC_004 挂在既有「premium 帧族未移植」失败项下。
3. Faction_Icons 图集象限→阵营映射已由 CardColorSwitcher factionIconMaterials 序列化 ST 全量钉死
   （probe_faction_table.py：GOONS(0.255,0.5)/KABAL(0,0.5)/LOTUS(0.75,0.75)/ZERG(0.25,0.75)/
   TERRAN(0.5,0.75)/PROTOSS(0,0.75)，全部 scale 0.25）。
4. Faction_Banner/Faction_Icon 材质 shader：Faction_Icon*=Hero/Unlit_Transparent、
   Faction_Banner(_Starcraft)=Hero/Unlit/Unlit_Texture、deck-action 主 quad 同、阴影=Hero/Multiply/Multiply
   （deckshader 探针）。SIGNATURE 图标材质=Unlit_TransparentTexAlpha2uvScroll（FX 滚动，无图标象限）。

## 7. 实现落地（2026-10-05）

- `scripts/extract_banner_assets.py`（长期工具，幂等）：嵌套 prefab 合并进 5 个通用帧的
  frame_recon/meshes/prefab_report + CardColorSwitcher faction 材质摘要 → `data/tables.json
  factionIconSt`（含 row.banner 绶带底板贴图）。纹理入 `assets/textures/`（Card_Inhand_*_Banner×3、
  Card_Inhand_Faction_Banner(_Starcraft)、Faction_Icons、FX3_gradient…）。
- `packages/renderer`：types（PlanSlot.wrap_repeat、FactionMaterialSt）、raster（wrap_repeat 逐像素
  fract）、render（flag 穿透）、plan（`compileBanners`：deck-action else-if 互斥 / 阵营
  FactionColorType / 绶带 classes>2；主 quad `_tint_rgb` 白中和、阴影保序列化 _Color）。
- 关键材质事实：Hero/Unlit/Unlit_Texture 主 quad 序列化 _Color=(1,0,0,1) 不进基色（游戏内棕褐），
  离线 alpha 分支须白中和；阴影 _Color≈0.1038 进 dst*(tex+_Color)（multiply 分支既有语义）。
- 绶带普通阴影 ST（0.53,0.48)/(−0.53,−0.048) 采样越界 → wrap_repeat（引擎 repeat 语义）。
- SIGNATURE premium 跳过阵营横幅（签名图标材质=FX 滚动无象限；SC_004 L2 无横幅实证）。
- 程序核对（/tmp/plancheck.ts 口径）：WON_332=阵营横幅+图标+绶带；YOG_502=锻造横幅；
  CATA_190h=绶带；SC_004=仅绶带。全量 32 fixture 渲染无新增失败
  （BG24_Reward_310 为既有字体 glyph 缺口 FranklinGothic-40/20249.png，未改动树上同现）。

## 8. 用户验收修复（2026-10-05 第二轮）

- **横幅渲染成阴影的根因**：extract_banner_assets.py 把容器自身的 npz_key 赋给了嵌套 prefab
  根节点，整棵子树键错位一级；渲染端 walkWithKey 按树结构重算键 → 主 quad 命中 Glow 网格、
  阴影 quad miss、横幅网格被阴影占用——横幅被以阴影网格的 UV 采样（灰色象限）。修复：子树
  根键 = 容器键 + ".0"（container.children=[subtree] 后 prefab 根是第 0 子节点）。符文/绶带
  未受影响（其网格来自帧提取，键一致）——这也是"多职业绶带没问题"而嵌套 prefab 三兄弟全错的原因。
- **凯瑞甘（SC_004）无横幅**：首版按 L2 证据对 SIGNATURE 跳过了阵营横幅；用户裁定照常渲染
  （2026-10-05）。材质取 factionIconSt.normal（真实图标象限）——引擎签名卡用 FX 滚动材质
  （Unlit_TransparentTexAlpha2uvScroll，无静态象限），静态近似登记残差。
- **fixture 扩充**（用户要求每机制/每阵营独立基准，不与既有重复；data/fixture.md presets 表 +
  extract_fixture_data 重跑，41 卡缺 0）：
  WW_331 可交易 / TTN_039 锻造（随从帧）/ JAIL_998 预备 /
  CFM_853 污手党 / CFM_619 暗金教 / CFM_715 玉莲帮2 / SC_018 虫族 / SC_408 泰伦 / SC_764 星灵。
  全部 NORMAL × Normal × Hand；程序核对九卡横幅节点/图标象限激活正确，渲染无失败。
  L2 参考图（reference/{id}.png）待用户游戏内导出。
