# 佣兵（Lettuce）帧族 prefab 拆解（2026-10-10）

范围：LETTUCE_ABILITY（佣兵技能，CARDTYPE 23）BigCard 帧的结构实证，为专属帧族实现做准备。
方法与其他帧族一致：反编译定 actor 选择链 → UnityPy 探针拆 prefab。全部结论有反编译行号 /
探针数据出处；抽取产物在 `explore/2026-10-10-lettuce-frame/pack/frames/`（extract_frame 机制原样
输出：frame_recon / meshes / portrait / prefab_report / prefab_ubertext / material_props / textures），
抽取脚本 `explore/2026-10-10-lettuce-frame/scripts/extract_lettuce_probe.py`。文中反编译路径限
exporter ilspy 缓存（`exporter/tmp/ilspy/Assembly-Csharp/`）。

---

## 1. Actor 选择链：fixture 卡走 BigCard_LettuceAbility

反编译出处（ActorNames.cs）：

- `GetHandActorByTags`（`ActorNames.cs:570-591`）判定序：
  1. `IsLettuceMercenary()` → `HAND_MERCENARY`（`Card_Hand_Mercenary.prefab:f9e5a62d…`）；
  2. `IsLettuceEquipment()` → `BIG_CARD_LETTUCE_EQUIPMENT`；
  3. `IsLettuceAbility()` → 召唤型 `BIG_CARD_LETTUCE_ABILITY_MINION`，否则 `BIG_CARD_LETTUCE_ABILITY_SPELL`；
  4. 其余落 `GetHandActor(cardType)`（8 槽表）。
- 谓词在 `EntityBase.cs`：`IsLettuceAbility` = CARDTYPE==23（`:466-469`）；
  `IsLettuceEquipment` = CARDTYPE 23 ∧ TAG `LETTUCE_IS_EQUPIMENT`（注意游戏内拼写就是
  EQUPIMENT，`:471-477`）；`IsLettuceAbilityMinionSummoning` = CARDTYPE 23 ∧ TAG
  `LETTUCE_ABILITY_SUMMONED_MINION`（`:488-495`）；`IsLettuceMercenary` = TAG
  `LETTUCE_MERCENARY` > 0（`:497-500`）。

两张 fixture（LT23_802P2/803P2）CARDTYPE=23、无上述两 tag → **`BigCard_LettuceAbility.prefab:
53cf859e0a512a240b9a6b1f8ad524b1`**。基准图同链：exporter `ResolveActorPrefabRef`
（`ExporterController.cs:5107-5112`）走 `ActorNames.GetHandActor(entityDef, premium)`。

同族 prefab 全景（`ActorNames.cs:107-156` s_actorAssets）：

| ACTOR_ASSET | prefab:guid | 用途 |
|---|---|---|
| BIG_CARD_LETTUCE_ABILITY_SPELL | `BigCard_LettuceAbility:53cf859e…` | 技能（施法/伤害类），**本票对象** |
| BIG_CARD_LETTUCE_ABILITY_MINION | `BigCard_LettuceAbility_Minion:cd2ed854…` | 技能（召唤随从类） |
| BIG_CARD_LETTUCE_EQUIPMENT | `BigCard_LettuceEquipment:2b360077…` | 佣兵装备（任务/收藏 UI 瓦片） |
| PLAY_LETTUCE_ABILITY_SPELL | `Card_Play_LettuceAbility:c580722c…` | 对局区技能 |
| PLAY_LETTUCE_ABILITY_MINION | `Card_Play_LettuceAbility_Minion:9820a890…` | 对局区召唤技能 |
| PLAY_LETTUCE_EQUIPMENT | `Card_Play_LettuceEquipment:029c966d…` | 对局区装备 |
| HAND_MERCENARY | `Card_Hand_Mercenary:f9e5a62d…` | 佣兵本体收集卡（另有 Tier_2/Tier_3 品质变体 `9c9adc8a…`/`1d00ef78…`） |

四个 BigCard/Hand prefab 均已抽取（同 bundle `initial_base_global-2ebe64b8-prefab-0.unity3d`）。

---

## 2. BigCard_LettuceAbility（spell 变体）结构

64 节点 / 24 网格 / 18 纹理，0 抽取 issue。渲染相关节点（探针 `frame_recon.json`）：

### 2.1 默认渲染集（canonical 位姿，根平移归零）

| 节点（RootObject 下） | 网格 / tris | 材质 → shader → _MainTex | 驱动 |
|---|---|---|---|
| `Mesh`（m_portraitMesh）sub0 | 6 tris，uv0 [-0.075,1.075]²，uv1 指向图集窗口区 | `Lettuce_MercMinionAbility_InPlay_FramePortrait_Mat` → `Custom/Card/Unlit_Portrait`，_MainTex=GenFX_white32x32（占位，运行时换卡画），_SecondTex=`Lettuce_MercMinionAbility_InPlayFramePortait` | 肖像公式层；`m_portraitMatIdx=0` |
| `Mesh` sub1 | 208 tris，uv0 [0.007,0.435]×[0.05,0.478] | `Lettuce_MercMinionAbility_Frames_Mat` → `Hero/Unlit/Unlit_TextureColor`（_Color 白）→ `Lettuce_MercMinionAbility_Frame` | 圆形徽章像框环 + 框饰 |
| `Mesh/FrameMesh`（m_cardMesh） | `Lettuce_Ability_Frame_Mesh` 243 tris | `Lettuce_Ability_Frame_Mat` → `Custom/Card/UnlitTexture` → `Lettuce_Ability_SpellCaster_Frame` | 卡框主体（含描述框画区） |
| `Mesh/Description_Spell_Combined`（m_descriptionMesh） | `Lettuce_Ability_Description_Mesh` 17 tris | 同 `Lettuce_Ability_Frame_Mat` | 描述板 |
| `Speed_Wing`（m_speedWing） | SpeedWing 122 tris | `Lettuce_SpeedWing` → `Hero/Unlit/Unlit_Texture` → `Lettuce_CardWingDings` | 速度翼标；被动/开局技隐藏（§3） |
| `Hourglass`（m_hourglassObject） | builtin:Quad 2 tris | `HourglassIcon` → `Hero/Unlit_Transparent` | 冷却沙漏；无冷却文本时隐藏（§3） |

UberText 角色（manifest role_paths；默认样式见 `prefab_ubertext.json`）：cost=`RootObject/CostUberText`
（65/6.5，白）、name=`RootObject/NameUberText`（45/5.0，白）、desc=`RootObject/PowersUberText`
（40/5.25，**黑字** (0,0,0)——羊皮纸底）、race=`RootObject/Mesh/RaceUberText`（40/3.5，白；佣兵
技能此处文本 = 学派名，见 §4）。`CooldownConfigUberText` 存在但冷却 tag 缺省时空文本 → 连同
Hourglass 一起隐藏（`LettuceAbilityActor.cs:210-227`）。

### 2.2 默认不渲染集（失活子树 / 失活 renderer）

`Gem_Mana`（费用宝石节点失活——费用是纯文本画在费用圆环上，**无宝石几何**）；
`Gem_Attack`/`Gem_Attack` 攻血宝石与 `AttackObject`/`HealthObject`（spell 变体节点失活，minion
变体激活）；`Mesh/RacePlate_mesh`（序列化网格恰是 FrameTribeSpell_Combined 229 tris，但能力卡
不走 racePlate 分支，恒失活）；`Mesh/Treasure` 宝藏横幅（`m_mercenaryTreasureBannerObject`，
宝藏卡才开）；`Lettuce_Faction_{Alliance,Empire,Explorers,Horde,Legion,Pirate,Scourge,Shadow}` ×8
（`LETTUCE_FACTION` tag 驱动，`Actor.cs:3540-3565`）；`Shadow`/`ShadowUnique`/`Highlight_Card_Plane`/
`FX_Ghost_Quad`（renderer enabled=false）；`MissingCard`/`GhostCard` 子树（`m_ghostCardActive=0`）。

### 2.3 肖像公式

与现八帧同构：`Unlit_Portrait` + _SecondTex 二重采样（portrait.json 有 uv1 通道），
`_SecondTint=(0.5,0.5,0.5,0.5)`、`_BlendIntensity=2.0`（`material_props.json`）。_MainTex 序列化为
GenFX_white32x32 占位，运行时由 `SetMaterialWithTexture`/def 材质链换成本卡原画；TS 侧照
hand-minion 的肖像公式层口径消费（类色/原画编译期按卡解析）。

---

## 3. LettuceAbilityActor 运行时行为（`LettuceAbilityActor.cs`，继承 Actor）

- `UpdateMeshComponents`（`:27-32`）= base + `UpdateMedallionCooldownState` + `UpdateSpeedWingState`。
- `UpdateMedallionCooldownState`（`:57-82`）：**`m_updateVisualsOnCooldown=0`（prefab scalars）→
  直接返回**，冷却期框色/费用隐藏分支对静态导出不生效。
- `UpdateSpeedWingState`（`:84-99`）：`m_updateVisualsOnCooldown=0` 时冷却不影响；
  `AbilityIsPassiveOrStartOfGame`（TAG `LETTUCE_PASSIVE_ABILITY`/`LETTUCE_START_OF_GAME_ABILITY`，
  `:101-112`）命中则隐藏。两张 fixture 无此 tag → **Speed_Wing 渲染**。
- `UpdateHourglassObject`（`:210-227`）：冷却配置/当前冷却文本均空 → 隐藏。fixture 无
  `LETTUCE_COOLDOWN_CONFIG`（=1675? SlugKey 见 `ExporterController.cs:4570`）/`LETTUCE_CURRENT_COOLDOWN`
  tag → **Hourglass 与 CooldownConfigUberText 均不渲染**。
- `SetMaterialWithTexture`（`:137-144`）：对 `m_mercenaryAbilityBannerMesh`（本 prefab 序列化为空）
  贴类色图集 → **spell 变体无类色横幅**；base 调用因 `m_cardFrontMatIdx=-1` 不换卡面材质 →
  框体是静态金色纹理，无职业色。
- `IsElite()` 基类口径（`Actor.cs:1351-1353`）：`IsLettuceMercenary()||IsLettuceAbility()` → **恒 false**
  （ELITE tag 不产生精英银龙）。
- 学派板/水印偏移：`UpdateRace`（`Actor.cs:6178-6186`）`OffsetDescriptionTexture(_SecondTex/_MainTex)`
  对 lettuce 的 `UnlitTexture` 单纹理材质无 _SecondTex 属性 → no-op；`m_watermarkMesh` 本 prefab 无
  此绑定 → 无水印（与 ticket 20 目检「desc 区干净羊皮纸」一致）。

## 4. 学派板口径（UpdateRace，`Actor.cs:6125-6186`）

`flag5 = IsLettuceAbility()` 与 spell 同支（`:6143`）：`flag8`（race text 非空，对能力卡 =
`GetRaceText` → 学派名）时 `m_descriptionMesh.sharedMesh = m_spellDescriptionMeshSchool`，否则
`m_spellDescriptionMeshNeutral`。探针实证（外部 mesh bundle `essential_base_global-mesh-0`）：

- `m_spellDescriptionMeshSchool` = `Lettuce_Ability_FrameTribeSpell_Combined_Mesh`：153 verts /
  **229 tris**（描述板 + 学派板一体几何）。
- `m_spellDescriptionMeshNeutral` = `Lettuce_Ability_Frame_Mesh`：172 verts / **243 tris** =
  **FrameMesh 的整块框体几何**（与 `Mesh/FrameMesh` 的内嵌网格同名同 tris 数）。中性分支 = 在
  `Description_Spell_Combined` 节点原位重画整框：该节点与 FrameMesh 局部变换仅差 Y +0.036
  （局部），世界差 ≈0.011（卡片宽 4.588 世界单位的 0.24%），视觉上近乎无副作用。
  **注意与 hand-spell 的差异**：hand-spell 的 neutral 分支因「序列化网格本就是中性网格」而等价
  （five-cardtypes §1 末尾）；lettuce 这里是真正的网格替换，TS 实现两分支都要建模，不能套等价成立。
- 两张 fixture 均带 SPELL_SCHOOL tag（1635=4 NATURE）→ **基准图走 school 分支**（desc 板 =
  229 tris combined 几何 + 「自然」文本）。

## 5. 取景锚：LT23 基准是 FrameMesh 锚定（修正 2026-10-06 口径）

exporter `FrameCamera` → `TryGetActorFrameBounds`（`ExporterController.cs:11422-11560`）：优先找
actor 下**任意 enabled 且名为 `FrameMesh` 的 MeshRenderer**，以其世界包围盒中心为相机中心；无卡型
门控（只有英雄技能 Z 特例与地标根重锚两个特例）。BigCard_LettuceAbility 有 enabled `FrameMesh`
→ **LT23 基准图 = FrameMesh 锚定**，与八帧同口径。

2026-10-06 l2-offset findings §「佣兵技能走 BigCard，均非本锚口径，排除在外保持原点取景」的
假设不成立（当时 LT23 在噪声组，平移测试无从校验；plan.ts MESH_ANCHORED_SLOTS 注释同源）。
按 recon 世界矩阵数值验证（canonical 位姿）：FrameMesh 世界 bbox 中心 = (x,z)=(−0.0118,−0.0824)，
512×768@ortho2.0 下相对原点取景偏移 **(−2.3, −15.8) px**。实现落地时该锚预测须与基准 L2 对账
（同 2026-10-07-edge-align 方法），残差应 ≤0.3px。

## 6. 名字文本无曲率

`m_RenderOnObject` 空 → 探针 `carrier=null`（平面 fallback），名字平排渲染——与
`textstage.ts:26` 既有注释「未锚定特殊帧（佣兵/事件/钻石 ±3px 无曲率）」一致，TS 侧无新机制。

---

## 7. 变体差异速览

### 7.1 BigCard_LettuceAbility_Minion（召唤型）

与 spell 变体**仅两处差异**（manifest/frame_recon diff）：① role_paths 多 attack/health
（`AttackObject`/`HealthObject` 激活，UberText 65/6.5 白字，攻血宝石节点仍失活但对象激活——
文本直接画在框上）；② FrameMesh 材质 `_MainTex` = `Lettuce_Ability_MinionCaster_Frame`
（材质名 `Lettuce_Ability_Minion_Frame_Mat`，shader 同 `Custom/Card/UnlitTexture`）。其余
64 节点结构逐项同 spell 变体。

### 7.2 BigCard_LettuceEquipment（装备）

完全不同的瓦片布局（39 节点）：`PortraitMesh` = `Lettuce_MercMinionEquipment_Tile_mesh`
（16+156 tris，Unlit_Portrait，_SecondTex=`Lettuce_Equipment_Frame`）+ `FrameMesh` 432 tris +
`Hero/Multiply/Multiply_AlphaFade` 底影 ×3（该 shader 数学本仓已有，five-cardtypes §5）；
**名字文本有曲率**（carrier = `Adv_StoryMode_PageTitle_BendTextShape`）。装备渲染走的是收藏/
任务 UI 语境，与手牌帧族不同路，独立排期。

### 7.3 Card_Hand_Mercenary（佣兵本体）

117 节点 / 60 网格，结构量级对标 hand-ally 且更复杂：职业横幅三套
（`RoleBanner_{Fighter,Caster,Protector}_{Attack,Health}`，`LETTUCE_ROLE` tag 驱动，
`Actor.cs:5279`）、三档 tier 箔（Tier2_Golden/Tier3_Diamond Oval）、经验条（`MercenaryXPBar`
`Custom/FX/FX_XPBar`）、双种族板 ×3 tier、椭圆 RTT 载体、faction 图标 ×8、
`Unique_Ally_Dragon` 904 tris（精英龙）等。独立帧族，本轮只存档不实现。

---

## 8. 实现缺口清单（spell + minion 变体，供排期参考）

1. **帧资产**：`extract_frame.py` 的 `SLOT_TO_ACTOR_KEY` 尚无 lettuce 槽（探针是 monkey-patch）；
   正式抽取需 actor_names.csv 增行 + 槽位命名（**设计决策待用户**）。
2. **CARD_TYPE_TO_SLOT / SLOT_NATIVE_CARD_TYPES**：CARDTYPE 23 无槽，回落 hand-minion
   （plan.ts:334/347）；回归基线口径（M1）继续还是切专属帧（**设计决策待用户**）。
3. **学派板双网格替换**（§4）：desc 组件需要支持 school/neutral 两套外部网格 + 「neutral=整框
   重画」的几何事实；`m_spellDescriptionMeshNeutral/School` 是外部 bundle 引用（file_id=4），
   提取器要走 extra mesh 通道（actor 直引网格已有先例）。
4. **取景锚**（§5）：MESH_ANCHORED_SLOTS 是否纳入 lettuce 槽 + 锚预测 L2 对账。
5. **攻血**（minion 变体）：`SLOT_NATIVE_CARD_TYPES` 槽位判定加入 23 后，攻血文本/宝石可见性
   按 GetTag 口径自然成立；spell 变体 AttackObject 失活不渲染。
6. **Speed_Wing / Hourglass / 冷却文本**：静态 def 渲染口径 = Speed_Wing 恒渲染除非
   LETTUCE_PASSIVE_ABILITY/LETTUCE_START_OF_GAME_ABILITY；Hourglass+冷却文本按
   LETTUCE_COOLDOWN_CONFIG tag。
7. **水新中国**：无水印绑定，resolveWatermark 需按槽跳过（当前走的是「占位 ref 无文件 → 无水印」
   分支，落槽后应显式化）。
8. L2 验收：LT23_802P2/803P2 从「回落帧回归基线」转为正式验收口径需重跑 `bun run l2`。

## 9. 游戏内怪癖：佣兵技能（含非召唤型）一律画攻血 "0"（2026-10-10 补充，已复刻）

用户在票 01 验收中问「非召唤类技能是否也渲染出攻击力 0 / 生命值 0」。反编译确认：**是——
游戏对所有佣兵技能（不分召唤/非召唤）都画攻血 0**，这是引擎行为的副产物而非数据问题：

1. **出厂态**（探针，路径感知 active_self）：`AttackObject`/`HealthObject` 自身激活位 False，
   子节点 Gem_Attack/AttackUberText/Gem_Health/HealthUberText 自身全 True——整棵子树只靠
   父级一个标志藏着。
2. **文本引用非空**：actor 的 `m_attackTextMesh`/`m_healthTextMesh` PPtr 指向 AttackUberText/
   HealthUberText（同 bundle MonoBehaviours，真实 path_id；探针首查显示「空」是抽取器未解析
   节点名，非空引用）→ `UpdateAttackTextMesh` 开头的 null 早退（Actor.cs:3397-3400）不触发。
3. **调用无门控**：`Actor.UpdateTextComponentsDef`（Actor.cs:3240-3253）无条件调用两个
   Update；`LettuceAbilityActor.UpdateTextComponentsDef`（:114-123）先调 base，无 lettuce 特判。
4. **失活父级被运行时翻正**：`FindComponentInThisOrParents<GemObject>` 在 AttackObject 上
   命中 GemObject 组件（探针实证）→ `gemObject2.Show()` = `base.gameObject.SetActive(true)`
   （GemObject.cs:55-58）→ AttackObject 整树激活。血量侧对称（Actor.cs:3462-3487）。
5. **写 "0"**：`GetTag(ATK)` 缺 tag 返回 0，非英雄 else 支（Actor.cs:3447-3452）
   `GetAttackOrHealthStringAndDoLargeNumberFormatting(0)` = "0"；`m_isTextVisible` 默认 true
   （Actor.cs:401），静态导出路径不翻。

**影响**：exporter 走同一 Actor 更新链 → L2 基准图（reference/LT23_802P2.png / LT23_803P2.png）
含攻血 0；1:1 复刻口径下 TS 渲染也必须画。

**TS 复刻（ticket 01 内落地）**：

- 抽取器 role_paths 增「runtime-driven texts」豁免：失活子树 UberText 若节点自身激活且被
  actor 文本字段（m_attackTextMesh 等）直引 → 照常登记角色（提取器注释带全链出处）。
- plan 编译：`Gem_Attack`/`Gem_Health` 组件与 stat_gems 采集绕过层级失活态，可见性按
  attackVisible/healthVisible（= GemObject.Show/Hide + SetHideNumberFlag 语义）；攻血文本
  角色 GetTag-0 补零（23 已在 SLOT_NATIVE_CARD_TYPES）。
- **修复开关 `YOGGSHADE_LETTUCE_STATS_FIX`**（用户裁定留此选项）：非空且非 "0" 时，缺
  ATK/HEALTH tag 的佣兵技能不再画攻血（真实值不受影响）；默认关 = 复刻游戏。浏览器/Workers
  无 process，恒关（YOGGSHADE_* env 惯例）。

**L2 验证（2026-10-10，ticket 01 收口）**：攻血 0 复刻前 mae_vis 12.807/13.659（锚对账
best-shift (0,0)、亚像素残差 ≤0.07 = 内容差非平移，残差主体即攻血区）；复刻后
**LT23_802P2 4.442 / LT23_803P2 5.313**，进入原生槽收敛区间（同批 GDB_142 4.77、
AV_205 4.56、REV_365 5.05）。其余 38 张 fixture 改动前后逐位零回归（字节比对）。

## 10. 基准导出的机制 tag 覆盖语义（2026-10-10，ticket 03 排障记录）

**现象**：LT24_021T1_01c（召唤型佣兵技能）首版基准图与 minion 帧渲染对不上（uniform 平移 +
FrameMesh 纹理差）。BepInEx LogOutput.log 实证：该次导出加载的 actor 是
`BigCard_LettuceAbility.prefab`（spell 帧），不是 Minion 变体。

**根因**：exporter 结构化覆盖对**每个**机制 tag 无条件写值
（`TryCreateCustomDisplayEntityDef`：`customizedEntityDef.SetTag((GAME_TAG)entry.Tag,
mechanicValue ? 1 : 0)`；slug 表 ExporterController.cs:221-238）。导出请求「佣兵技能-召唤随从=否」
→ `SetTag(1676, 0)` → `IsLettuceAbilityMinionSummoning`（HasTag 语义，EntityBase.cs:492）为假
→ `GetHandActorByTags`（ActorNames.cs:586-588）落到 spell 帧。这与游戏内真手牌行为（原始 DBF
tag 1676=94423 存活 → Minion 帧）不符，属导出侧工件。

**裁决与处置**（用户 2026-10-10）：基准重导——「佣兵技能-召唤随从=是」→ tag 写回 1 → 正确解析
`BigCard_LettuceAbility_Minion.prefab`（日志复证）+ FrameCamera = FrameMesh 中心 (−0.01,−0.08)。
对照：LT23_036E2_04 导出时「佣兵装备=是」→ 正确装备帧；LT23_816H 无对应覆盖项（mechanic 表
无 1665 佣兵本体条目）→ tag 存活 → 正确 `Card_Hand_Mercenary`。**后续任何 lettuce 系基准导出，
机制开关必须按卡的真实 tag 勾选，否则 actor 解析会静默落到 spell 帧。**

**票 03 附带修复**：三张新 fixture 的原画缺失（extract_fixture_data 只出 JSON；原画走
extract_fixture_assets.py，票 02 漏跑）→ 渲染画占位白窗、L2 残差集中在画窗中央
（x176-336/y120-290，15k 像素 SAD>60）。补跑后收敛。

**L2（ticket 03 收口）**：LT24_021T1_01c mae_vis **3.502**（全套 fixture 最佳；锚对账 best-shift
(0,0)、亚像素 −0.04）。原画缺失时 13.835、错帧+缺原画时 67.6。

## 11. 装备槽（ticket 04）实现记录（2026-10-10）

结构：39 节点全激活；瓦片布局 = `Mesh/PortraitMesh`（tile 16 tris 肖像面 + 156 tris 框，
m_portraitMesh 绑定、portraitMatIdx=0、_SecondTex=Lettuce_Equipment_Frame）+ `FrameMesh`
（432 tris，Custom/Card/UnlitTexture）；角色仅 name/desc（prefab role_paths 实测，无费用/
攻血）；名字曲率载体 `Card_InHand_Equipment_CurvedText`（Adv_StoryMode_PageTitle_BendTextShape，
manifest.carrier → renderText RTT 路径）；actor = LettuceAbilityActor（无攻血/冷却/速度翼绑定，
相关逻辑自然 no-op）。

**forcedHidden `Mesh`（像素证据，根因未决）**：装备 prefab 序列化了能力徽章环节点
`Mesh`（Lettuce_Spells_Ring_Mesh，[6,208] tris，active+enabled）——技能帧的圆环在装备瓦片布局
里没有视觉意义。基准图 reference/LT23_036E2_04.png 对应区域 alpha=0（不透明 bbox 顶 y55，
我们 37，高出的 18px 全部来自该节点）；隐藏后整体 SAD 7.36 → 2.57。已按 `forcedHidden` 落码。
**未决**：游戏/导出器正常路径均无该节点的隐藏代码出处（LettuceAbilityActor 不触及；
exporter `ApplyPlaceholderGrayMaterials` 名单属 textless 路径不含 "Mesh"）——疑似真实游戏
收藏 UI 装备瓦片装配代码（LettuceEquipmentTile 族）所为，反编译未及，待查。

锚：FrameMesh 世界包围盒中心（与 exporter 日志 (−0.01, 0.10, −0.23) 一致），edge-align 对账
best-shift (0,0)、亚像素 −0.07。

### 11b. 名字走 builder 链（用户审查反馈修复，2026-10-10）

用户审查装备槽时指出：部分佣兵装备/技能的名字受 textBuilderType 控制，不能渲染 DBF 原文。
反编译确认（CardTextBuilder.cs）：**名字从来不是裸字符串**——`EntityDef.GetName()`
（EntityDef.cs:368）→ `CardTextBuilder.BuildCardName(def)`（CardTextBuilder.cs:97-100）=
`TextUtils.TryFormat(GetDefaultCardName(def), GetTag(CARD_NAME_DATA_1))`，其中
GetDefaultCardName = `TransformCardText(原始名)`（:91 正常路径尾行）、CARD_NAME_DATA_1 = 2890
（GAME_TAG.cs:373）。全部 builder 路线公式一致（Universal 兜底 :1930-1932 同式；type 7
ScriptDataNum1CardTextBuilder 不覆写 BuildCardName，只覆写正文/瞄准箭头；唯一特例 INVESTIGATE
:type 17 用 GetNamesText，fixture 集未用）。佣兵装备/技能名带的 `{0}` 占位由此展开——2890
缺省 GetTag=0（「中立之心{0}」→「中立之心0」，LT23_036E2_04 实证）。

**实现**：plan.ts 双处 name case（compileFramePlan + compilePlan 遗留路径）统一为
`tryFormat(transformCardText(name), [tags[2890] ?? 0])`（包导出与 TextUtils.cs:28-44 同源）。
波及面：全 43 fixture 仅 LT23_036E2_04 名字含占位符，其余名字原样通过、渲染逐位不变。

**连带修复（用户审查「字体似乎小了」）**：曲率名字 RTT 排版密度 q 此前乘了
`ns.localScale`（UberText 节点世界缩放）——但 m_FontSize/m_Width/m_Height/m_Resolution 全是
纹理空间量，节点变换只应经载体网格世界矩阵进入一次（装备帧载体 Card_InHand_Equipment_
CurvedText 是 NameUberText 的子节点，世界尺寸已含缩放）。装备帧名字节点世界缩放 0.8，
双重应用使名字墨迹高度实测 39px vs 基准 49px（恰 0.8 倍）；去掉后 48 vs 49，整体 SAD 1.71。
各曲率帧名字节点缩放序列化值均非精确 1.0（如 GDB_142 印为 1.000 实为 ±0.001 级），修复后
单位缩放帧仅 2 像素 ±1 量化噪声（GDB_142 实测 2/393216 px、max 1）；hand-location 名字节点
各向异性（0.9/1.0），其名字按引擎语义 +5%——同属双重缩放消除。

## 12. 佣兵本体槽（hand-mercenary，ticket 05）实现记录（2026-10-10）

### 12.1 结构总览与 actor 绑定（探针 `explore/2026-10-10-lettuce-frame/output/merc-bindings.json`）

`Card_Hand_Mercenary.prefab`（117 节点 / 60 网格 / 31 纹理，0 抽取 issue 除 OvalShadow 内建网格）。
角色/阵营/等级三处绑定均**序列化在 MonoBehaviour 内**，逐字段实证：

| actor 字段 | 绑定 | 运行时分派 |
|---|---|---|
| `m_mercenaryRoleObjects`（×2，挂 AttackObject/HealthObject） | `MercenaryRoleGemObject.m_roleGemObjects`：{CASTER→RoleBanner_Caster_*, FIGHTER→…_Fighter_*, TANK→…_Protector_*, NEUTRAL→…_Neutral_*} | `SetRole(LETTUCE_ROLE)` 逐项 `SetActive(m_role == role)`（互斥；INVALID → 全隐）。容器 = Quad（renderer 序列化 `m_Enabled=false`，无启用方）；真几何 = 同名网格子节点（Lettuce_Merc_Hand_{Damage,Mage,Tank}_mesh / Health 系，材质 `Lettuce_Hand_MercGems_Mat`） |
| `m_factionBannerIcons`（7 项，内联结构体） | {1→Alliance, 2→Horde, 3→Empire, 4→Explorers, 5→Legion, 6→Pirate, 7→Scourge}，各带 `m_banner` GO；`m_factionBannerBackground` = `Mesh/Lettuce_Faction_Banner_Mesh` | `flag = LETTUCE_FACTION != NONE` → 容器 + 命中图标 SetActive。**prefab 另有 `Lettuce_Faction_Shadow` 节点但不在 7 项表内 → 引擎里永不激活** |
| `m_mercenaryLevelObject` | `MercenaryActorLevelObject`：m_levelText → `MercenaryLevelObject/LevelText`、m_xpBar → `MercenaryXPBar`、m_xpBarBacking/Cover | 文本写点 `UpdateMercenaryLevelTextMesh`（Actor.cs:3516-3528，等级自 LETTUCE_MERCENARY_EXPERIENCE）；XP 条的显隐只在**对局语境**分支（Actor.cs:4244-4257）翻动 → 收集卡保持序列化态（backing/xpBar 激活、cover 失活） |
| `m_watermarkMesh` | `RootObject/Watermark`（自身失活） | 只在 Actor.cs:4244-4257 分支内 `SetActive(powersText 为空)`；收集卡不进该分支 → **不渲染** |
| `m_racePlateObject` / `m_multiRacePlateObject` | `Race_Tribe_Merc_mesh`（自身 renderer 无网格，仅承载文本）/ `Mesh/DualTribeNamePlates/…DualTribe_Teir1_mesh` | UpdateRace flag7 支（IsMinion，Actor.cs:6150-6170）：单族 → Race_Tribe_Merc_text；多族 → DualRace_Tribe_Merc_text + Teir1 板 SetActive |
| scalars | `m_cardFrontMatIdx=0, m_cardBackMatIdx=1, m_portraitFrameMatIdx=1, m_portraitMatIdx=0, m_useCardDefMaterial=0, m_usePlayPortrait=0` | portraitFrameMatIdx=1 无对应槽（肖像网格仅 slot0）→ 不写；肖像槽 0 走既有肖像公式层（_SecondTex = GenFX_Card_InHand_BannerAtlas） |

### 12.2 卡面图集按**角色**选（`UpdateCardColor` lettuce 分支）

`Actor.UpdateCardColor`（Actor.cs:6339-6362）对 `IsLettuceMercenary()` 走专属分支：
`colorType = (ColorType)({CASTER:23, FIGHTER:26, TANK:29, NEUTRAL:32} + (int)m_premiumType)`
（NORMAL=0 → Tier1；Tier2/3 = 金/钻），再经 `SetMaterialWithTexture` 写 `minionCardTextures[colorType]`
到 `m_cardMesh` 前槽。**佣兵卡 CLASS 恒 NEUTRAL，若走职业表会取到 `Card_Inhand_Generic`**
（首轮渲染实测：整卡变明亮羊皮纸，MAE 39.5）；改角色分支后 27.2。

### 12.3 `_LightingBlend` 光照乘子（本轮最大发现，跨帧通用）

`Custom/Card/UnlitTexture`、`Custom/Card/Unlit_2Texture2uv`、`Hero/Diffuse/*` 族 VS 计算
`COLOR0 = (1 + _LightingBlend·(L − 1)) · _TintColor`（L = 环境 SH 探针经 1/2.4 gamma + `_MainLightColor`；
反汇编 `exporter/tmp/shader/Hero_Diffuse_DiffuseAlphaMaskScroller_VS.metal:96-108`）。
导出环境 L ≈ 0（探针/主光均黑）→ **乘子 = 1 − _LightingBlend**。

像素实证（LT23_816H，同一帧内五处独立材质交叉验证）：

| 材质 | shader | `_LightingBlend` | 基准/本链 亮度比 |
|---|---|---|---|
| GenFX_Card_…Merc_Base_Tier1_mat（卡面/名牌/底衬/盖板） | Custom/Card/UnlitTexture | 0.5 | 0.507~0.531 |
| GenFX_Card_…Merc_Foils_Mat（椭圆框） | Custom/Card/Unlit_2Texture2uv | 0.5 | 0.507~0.527 |
| Lettuce_Hand_MercGems_Mat（职业宝石） | Hero/Diffuse/DiffuseAlphaMaskScroller | 0.5 | 0.512~0.547 |
| GenFX_Card_…Merc_RarityGems（稀有度宝石） | 同族 | 0 | 1.02 |
| 既有 42 张 fixture 全部材质 | 各族 | 0 或 B 族 | 1.000（逐位不变） |

对照组（B 族）：`Hero/Unlit/Unlit_Texture`、`Custom/Card/Unlit_Portrait` 的 VS 是
`COLOR0 = lerp(顶点色, L, _LightingBlend)`（`Hero_Unlit_Unlit_Texture_VS.metal:94-96`，
`Custom_Card_Unlit_Portrait_VS.metal:101-103`）——网格无顶点色 → 顶点色=1 → 与 L 无关，恒 1
（对应 BG 饰品/英雄技能/佣兵技能帧材质 `_LightingBlend=1.0` 而基准不暗）。

**导出器归一**：heroPower/weapon 帧在导出前被 `ApplyPostShowActorLightingNormalization`
（ExporterController.cs:5231-5240 → :5492-5510 `SetUnlit()` +
`UpdateCustomFrameLightingBlend(EXPORTER_UNLIT_LIGHTING_BLEND=0)` + `ApplyLightingBlendToRoot(...,0)`）
逐材质写 0 → 该两帧的序列化值（如英雄技能 Gem_Mana 的 1.0）在基准里不生效（AV_205p 首轮
误加乘子变黑，已按帧归一修正，逐位复原）。

落码：`plan.ts lightingFactor()` + `LIGHTING_BLEND_NORMALIZED_SLOTS`（帧光栅折进 slot tint；
gems 阶段 `StatGem.light_factor`）。L 是唯一非推导常数（取 0；实测残差 ≤2% ≈1~2 灰阶），
与 desc/cost 校准同性质。

### 12.4 等级数字锚位（基准对账；机制未及）

prefab 里 `LevelText` 节点世界位 = 屏幕 (207.6, 336.5)（卡面上部，肖像内），基准图数字画在
稀有度宝石内（glyph 质心 (254.4, 446.8) vs RarityGem 世界中心 (255.3, 441.7)，≤1px）；
Actor 链只写文本（`UpdateMercenaryLevelTextMesh`），无任何布局写点（WidgetTransform 只定义
bounds 不移动 transform）→ 移动由 Hearthstone.UI widget 布局/FSM 所为（Actor 链外）。
复刻口径 = 等级文本节点世界位移到 RarityGem 节点世界位（`plan.texts['level'].world_delta`）。
等级表 = `LETTUCE_MERCENARY_LEVEL`（DBF 30 行，TotalXpRequired 列内嵌 plan.ts；
`GetMercenaryLevelFromExperience` 对译；缺 tag/0 经验 → 等级 1，与基准 "1" 一致）。

### 12.5 经验条（Custom/FX/FX_XPBar）

公式层新模块 `packages/renderer/src/xpbar.ts`（VS/FS 逐行对译 `Custom_FX_FX_XPBar_{VS,FS}.metal`）：
mask = `_MainTex.sample(clamp(uv1.x−0.5+(1−_Percent), 0.1, 0.9), uv1.y·0.04−0.4t).a`
（玻璃图右半 alpha=0 = 未填充窗，把填充比例编码成图集 alpha 阶跃）；
noise = `(n1 + n2·(n2−n1))·_Intensity`（MagicCloud01 蓝云，两路 uv2/uv3 滚动）；
out = `clamp(noise·_Intensity·mask + main, 0, 1)`，SrcAlpha over。
参数全取材质序列化值（`_Percent 0.54` = ProgressBar 未调用时的出厂值、`_Intensity 1.2`、
`_NoiseScale 1.71/2.14`、`_Uadd 1`）。

**残差登记**：① 基准左 54% 亮蓝与填充边界吻合（mask 阶跃 ✓），但右段基准为暗蓝噪声、本链按
shader 语义 mask=0 → 透出底衬（gold slot 内衬）；② housing 纹理基准为钢灰、本链为金 slot 区
（同一 backing 网格的图集 UV 区）。两者疑为 UI widget 层叠加（Hearthstone.UI.Card 的
ProgressBar/Motes）或 shader 变体 keyword（FS 反汇编 keywords=[]，未定论）——待游戏内 UI prefab
或界面截图仲裁。③ 噪声相位 `_Time` 是导出时刻快照，不可复现，取 t=0（`plan.xp_bar.time` 可覆盖）。

### 12.6 阵营旗（待用户裁定）

反编译口径：tag 2720=2(HORDE) → `Lettuce_Faction_Horde` SetActive(true)（Actor.cs:3530-3560），
本链按此渲染；**基准图无旗**（顶右 x[358,466] y[105,237] 区 MAE 80.28 / 15950 px，占全卡 4.6%）。
候选工件路径（同 findings §10 tag 1676 先例）：① full-set 导出请求携带 `mercenaryFaction`
值 → `SetTag(2720, 0)` 覆盖（ExporterController.cs:9496-9509）；② 导出时 `GameMgr.IsBattlegrounds()`
为真且 gameEntity 无 `BACON_FACTION_BANNERS_ENABLED` → 隐藏分支（Actor.cs:3534-3540）。
等基准重导或用户裁定；当前实现不动。

### 12.7 锚与 L2

本帧无 `FrameMesh` 节点 → exporter 回落 `Actor.GetMeshRenderer()` = `RootObject/Mesh`
（TryGetActorFrameBounds:11552-11555）；锚预测 = 该网格世界包围盒中心 (x,z)=(0,−0.0530)
（相对原点取景 (0,+10.2)px），与基准对账 **best-shift (0,0)**、亚像素残差 ≤0.1px
（XP 条填充边界 x265 vs 预测 267.5、宝石质心 ≤1px、攻血/等级文本区 MAE 2~3 互证）。

**L2（2026-10-10）**：LT23_816H mae_vis **11.805**（mae_nontext 10.614，worst_zone desc=22.6
= 经验条残差区）；**剔除阵营旗区 7.87**（与同批 LT23_802P2 4.44 / LT23_803P2 5.31 /
LT23_036E2_04 4.04 / LT24_021T1_01c 3.50 同量级）。其余 42 张 fixture 逐位零回归（字节比对）。


### 12.8 基准重导（用户 2026-10-10 第二次导出）与四族修正

用户重导 LT23_816H 基准（补旗子/改光照/隐藏经验条并显水印/等级 30），据此修正：

1. **光照乘子撤销**：新基准帧区亮度比 = 1.000（旧基准是 0.5）→ §12.3 的 `1−_LightingBlend`
   是**旧基准导出环境的工件**（L≈0）；游戏/新基准 L≈1 → 乘子恒 1，实现中整段移除（反编译
   结论保留在 §12.3 供 heroPower/weapon 归一参考）。
2. **经验条隐藏 + 水印显示**：新基准 desc 区无经验条、有 LET 压暗水印 → Actor.cs:4244-4257
   分支成立且对局文本为空的语义（xpBar/xpBarBacking/xpBarCover 关、`Watermark` 开）。
   实现：`XPBarBacking/MercenaryXPBar/XPBarCover` 翻隐；`RootObject/Watermark/` 子树（Mark
   节点）翻显——**容器 `Watermark` 自身无 renderer 不在 plan 组件里，须按子树路径激活**
   （首版按容器找 → 水印未渲染，用户指认）。xpbar.ts（FX_XPBar 端口）保留给对局态。
   水印区 L2 0.95（修复前该区特征性缺失）。
3. **等级 30**：`data/fixture.md` 新增 `Tag Overrides` 列（`1852=55000`）= 导出侧机制开关
   `lettuce-mercenary-experience` 的镜像（DBF 无此 tag，同 §10 的覆盖机制）；extract 合并进
   卡 JSON 的 tags；`GetMercenaryLevelFromExperience(55000)` = 30。
4. **等级字号**：见 §12.4 的 `MERC_TEXT_SCALE_MUL.level = 2.0`（白墨 h27/w42 与基准逐项吻合）。
5. **种族字号**：`race = 0.95`（用户目视「稍大」+ 白墨 h33 vs 基准 h32 → 收 5%）。
6. **椭圆像框偏暗**：像框环材质 `GenFX_Card_InHand_Ally_Merc_Foils_Mat` 是
   `Custom/Card/Unlit_2Texture2uv`（PS：`out = second_t.a×(main×second_t − main) + main`，
   `second_t = _SecondTex@UV1×_SecondTint×_BlendIntensity`）——本链此前只画 `_MainTex`
   （`Lettuce_FoilTiers`）→ 缺第二项（`GenFX_Card_InHand_BannerAtlas` 椭圆窗蒙版）而偏暗。
   实现：`PlanSlot.second_tex_blend` 逐槽开启（佣兵 OvalFrame），渲染端复用 raster 的 wm
   合成路径（公式逐指令同源）；网格无 UV1 → 回退 uv0（引擎语义，raster.ts 头注既有实证）。
7. **旗影**：`OvalShadow`（`Lettuce_OvalShadow_Faction` = `Hero/Multiply/Multiply` + `FlagShadow`）
   的 MeshFilter 是**内建 Plane**（fileID≠0, pid 10209），此前抽取记 issue → 无网格 → 不渲染。
   extract_frame.py 内建网格处理扩到 pid 10209（10×10 平坦网格 → 共对角线两三角覆盖同矩形，
   与 Quad 同 UV 约定）；plan 随旗激活该节点（乘法混合由 markOpaqueEdgeSlots 自动标注）。
   重导后 issues 0、meshes 61。

**L2（2026-10-10 本轮）**：LT23_816H mae_vis **4.763**（banner 区 11.6 = 名条区仍含宝石/
文字的亚像素差）；水印区 0.95、旗区 3.42、像框区 11.45、等级区 23.0（等级字形 bbox 与基准
逐项吻合，仅整体低 1px 未补偿）。其余 42 张 fixture 逐位零回归（字节比对 changed=0）。


### 12.9 第三轮（用户目检反馈：12 已解决，34 仍在；文本整体偏高）

1. **文本整体偏低修正**：用户目检「名字/等级/种族都偏高」→ 三者白墨质心实测 +0.6/+1.0/~0 px
   （整数扫描 best-dy：level=1，name/race=0）→ 佣兵帧全部文本统一 `world_delta` 下移 1px
   （z −= 1/192，see plan.ts `hand-mercenary` 文本分支）。修正后 level 区 MAE 23.0 → 6.0、
   race 6.6 → 4.6；name 仍 15.8（>0：曲线载体 RTT 的字形级残差，非位移——best-dy 仍为 0）。
2. **旗影（item 4）真正根因**：`OvalShadow` 的 MeshFilter 是内建 **Plane（pid 10209，xz 水平面
   ±5，探针 `unity default resources` 确认 bbox [-5,0,-5]..[5,0,5]）**；第二节按 Quad 的竖直约定
   抽取（第二轴放 y）→ 节点矩阵（把 mesh x/z 映到世界 x/z）把网格压成一条线 → 屏幕退化不可见
   （调试：换不透明洋红也 0 像素）。修正 = Plane 走 xz 水平面（uv 约定仍 uv(0,0) 在 (−h,−h) 侧）。
   另加 `PlanSlot.skip_depth_test`：引擎旗影材质 QUEUE=Transparent + ZWrite Off，zbuf 只有不透明
   写入的几何（卡面自身也是 Transparent/ZWrite=0）→ ZTest LEqual 恒过；本链帧光栅对透明材质也
   写深度（既有简化），会把旗影（世界 Y −0.032 在卡面之后）整块裁掉。
3. **预乘透明合成（材质驱动，保留）**：佣兵帧三代材质 `_SrcBlend=1/_DstBlend=10`（Blend One
   OneMinusSrcAlpha，全仓仅本帧命中）→ `PlanSlot.premultiplied`，引擎端 `dst = src.rgb +
   dst×(1−src.a)`。A/B 整卡 L2 4.857 → 4.653 有改善且为零回归 → 保留（对本帧纹理实际影响很小，
   因其 alpha 多数为 1）。
4. **椭圆像框偏暗（item 3）未解决**：像框环亮度比 ours/ref = 0.87~0.70（顶部最暗，1.43 倍差），
   与预乘/alpha 无关（开预乘无变化）→ 真因未定：候选 = `Lettuce_FoilTiers` 图集取样区域/tier、
   或某个本链未渲染的叠加层（Tier2/3_Foil、RTT_Plane 均序列化失活）。下一轮从图集区域对账入手。

**L2（第三轮）**：LT23_816H mae_vis **4.653**（mae_nontext 4.412）；分区：name 15.8、race 4.6、
level 6.0、旗 3.95、环 10.96。其余 42 张 fixture 逐位零回归（changed=0）。


### 12.10 第四轮：预乘合成的源项权重（**已被 §12.11 推翻**）+ 像框环收敛

> **推翻说明（2026-10-10 第五轮）**：本节把「顶点/边缘都算进来」的环区平均亮度当靶子，得出了「源项按 `_LightingBlend`=0.5 插值」的口径——但 `_LightingBlend` 是 VS 光照乘子，不是混合权重（§12.3），且该插值恰好把**环顶弧**压暗 1/3，成了用户随后报的「顶端一条横线、上面更暗」本身。逐区域回归见 §12.11，本节数值保留作对照。

用户目检：「亮度对了，但顶端有条水平划线、上面更暗」。定位：卡面上沿 y≈113（卡面网格上边界）
起，本链整行比基准亮 3~7，来源是**椭圆像框环顶部那圈弧**——上一步把预乘合成一步到位
（`dst = src.rgb + dst×(1−a)`），环被提亮过头（89.4 vs 基准 77.3，+16%），环顶横贯卡面就成了一条亮带。

修正（材质驱动、非魔数）：源项在「纯 SrcAlpha over」与「纯预乘」之间插值，
权重 = 材质 `_LightingBlend`（佣兵 foils = 0.5）：

    dst = src.rgb × (a + (1−a)·_LightingBlend) + dst.rgb × (1−a)

a=1 的卡面/名牌/水印不受影响（源项恒 = 1，与纯预乘同值，故无回归）；a≈0.14 的像框环
源项权重 0.57 → 环 78.1 vs 基准 77.3（0.99）、上沿行差从 +7.1/+5.4/+3.4 收到 −0.1/−0.7/−0.6。
实测两种极端的中间正是基准（纯 over 66.9 / 纯预乘 89.4 / 基准 77.3），插值形式 76.6 落点吻合。

**L2（第四轮）**：LT23_816H mae_vis **3.786**（mae_nontext 3.492，worst banner 9.7）；像框环区
MAE 11.25 → 8.02。其余 42 张 fixture 逐位零回归（changed=0）。

### 12.11 第五轮：环（OvalFrame）混合口径定案 —— rgb 直写、不做 alpha 衰减（修「顶端横线」）

用户第三/四次反馈：「顶端有条水平划线、上面更暗」→「还是有。据观察，这条横线，和底框的上边界
很接近」。**逐区域解算定位到唯一根因**（隔离手法：`explore/2026-10-10-lettuce-frame/scripts/ablate.ts`
分层消融 + `ring_model.ts` 把材质 `_LightingBlend` 当 k 覆写后只渲染环）：

**位置与归属**（y 行剖面 + 逐 x 段扫描）：暗带 = x∈[194,320]、y∈[91,113]，形状是**椭圆像框环的
凸出顶弧**（环 bbox 投影 y≥92，与卡面网格 `RootObject/Mesh` 的 y≥111 之间那条空档）。消融证明
与卡影 `Mesh/Shadow` 无关（`shadowOnly` 在该带全 0；`noShadow` 与 `all` 逐像素同值）——**是环
自己画暗了**。横线 = 环顶弧下沿与卡面交界的 dst 突变行（x=250 处 y 113→114）。

**为什么是环**：`Lettuce_FoilTiers` 的 texel alpha 在环顶弧只有 **0.35**（探针 x=250 顶弧
rgba=(99,97,90,79)），而第四轮的插值口径把源项压成 a+(1−a)·0.5 = 0.675 → 顶弧整条暗 1/3
（x=250 y=100：本链 65 vs 基准 99.3；y 92~113 均值比 0.65）。

**真口径 = 逐像素回归**：用 `ring_model.ts` 在 dst=0 下渲染 k=1（输出 = src.rgb）与 k=0
（输出 = src.rgb×a），解出逐像素 src 与 a，再与基准做最小二乘：

| 区域 | n | 回归 `ref = α·src + β·dst` | 结论 |
|---|---|---|---|
| 顶弧带（环凸出、身后空无一物） | 1736 | **α=0.999，β=0.000** | 逐像素等于纹理 rgb 本身 |
| 环压卡区，a∈[0.3,0.5) | 3086 | α=0.976，β=−0.002 | 同样不给 dst 项 |
| 环压卡区，a∈[0.7,0.9) | 1583 | α=0.801，β=0.228 | ≈ 1−a（与预乘一致，边缘混叠污染） |

四候选口径的区域回归（环区 n=66582）：

| 口径 | 顶弧带 MAE(dst=0) | 压卡区 MAE | 全局 L2(rmse) |
|---|---|---|---|
| SrcAlpha over | 58.5 | 13.3 | — |
| 第四轮 `_LightingBlend` 插值 k=0.5 | **29.2** | 7.0 | 9.575 |
| `Blend One OneMinusSrcAlpha`（含 dst·(1−a)） | 0.6 | 16.1（y=114 造出反向亮边 110.3 vs 83.7） | 10.795 |
| **定案：rgb 直写（`dst.rgb = src.rgb`，a 仅入覆盖率平面）** | **1.5** | **5.8** | **8.996** |

定案口径在三个区域同时最优，且不制造新边缘。落码：`raster.ts` 的 `premultiplied` 分支
（`src.rgb` 不做 alpha 衰减、不累加 dst；a 通道仍走 over 累加供透明背景用），并**删除**
`preBlendAmt`/`_LightingBlend` 插值这条误用路径（`render.ts`/`raster.ts` 参数同步清理）。

**L2（第五轮）**：LT23_816H mae_vis **3.303**（mae_nontext 2.927，z_banner 8.528 仍为最大残差
= 阵营旗；z_desc 4.576）；顶弧带 MAE 29.2 → **1.54**，x=250 行剖面 y 92~113 与基准逐点差 ≤1。
作用域验证：`explore/2026-10-10-lettuce-frame/scripts/premul_scope.ts` 全 43 张 fixture 扫描，**仅 LT23_816H** 命中
`premultiplied` 槽（7 个组件），其余 42 张不执行该分支。

### 12.12 第六轮：肖像层三线性过滤（mipmap）—— 修「顶部色差」（2026-10-10）

用户反馈顶端仍有色差。重新探索定位：**色差不在帧光栅（环 k=1.001 MAE 0.69）而在肖像画内部**
——块图热点 y152-200 x224-368（MAE 8~14，头发区），互相关位移 (0,0) 排除错位；逐像素回归
`ref = 0.936·ours + 7.2`（按亮度分箱：暗部基准亮 +5.5、亮部基准暗 −7.8）= **对比度压缩**，
指向纹理采样滤波差异。

**机理**：肖像 512² 纹理映射到屏幕 ~0.6 倍（UV 窗 0.72×0.94 ≈ 368×481 texel → oval ~220×290 px，
每三角形足迹恒 1.67 texel/px → λ=log2(1.67)=0.74）。Unity importer 对 3D 模型纹理默认生成
mipmap、游戏端 Bilinear+MipMap 过滤在 minification 读取低级 mip；离线链此前恒采 level0 →
偏锐、高频区（佣兵头发）对比度偏高。全 fixture 回归同向：LT23_816H k=0.939（最重）、
CFM_902 0.965、YOG_502/LT23_802P2/LT23_036E2_04 0.986~0.988、GDB_142 0.993；σ0.4~0.6 等效
软化使全部 k→1.000~1.02（/tmp 时代的 blurtest，数值录入本节为证）。

**修法（非后期模糊，引擎口径）**：`image.ts` 新增 mip 链（box 2×2 逐级减半）+ `sampleTrilinearClamp001`
（floor/ceil 两级 mip 按小数插值；λ≤0 与原 sampleBilinearClamp001 逐位同值）；`portrait.ts`
新增 `triLambda`（每三角形 ∂u/∂x、∂u/∂y、∂v/∂x、∂v/∂y 的最大纹理足迹 log2；探针实测该网格
33 个三角形 λ 全部 =0.74）。主纹理@uv0 与 second@uv1 各自驱动。**作用域**：帧光栅/宝石/水印
采样器不动（帧面 k=1.001 证明无 minification 问题；水印是放大采样）。

**结果**：LT23_816H 肖像内部椭圆掩码回归 y110~370 各带 k=0.996~1.010（b≤+1.4）；hair MAE
7.27→4.99、face 4.24→2.90；mae_vis 3.303 → **2.978**（mae_nontext 2.428；banner 8.272 为最大
残差=绶带波浪，另案）。全量 42 张 fixture 对基准 MAE：**39 降 3 平 0 升**（如 CFM_902 2.03→1.70、
AV_205 1.95→1.68、LT23_803P2 2.45→2.18）。y370 以下带（k≈0.72）是名字绶带交叠区的已知残差，
非肖像问题。

### 12.13 第七轮：导出器官方 alpha 管线（AlphaFillOpaque mask）——修「像框超出底框段亮度分界线」（2026-10-11）

**现象**：用户目检椭圆像框「超出底框的部分和没有超出的部分有一条明显的亮度分界线」。
逐像素定位：环带 rgb 与本链一致（差≤2），但**基准 alpha 恒 255**（实心圆顶：x=250 列
y93~113 全 255、y=95 行 x232~276 全 255），本链 = 纹理 alpha over 累加（108~208）→ PNG
合成到任意背景上时超出段被冲淡（白底变亮），与压卡段（不透明）之间形成亮度阶跃。

**根因（本轮最大发现，跨帧通用）**：导出器基准图的 alpha **不是颜色 RT 的 alpha**
（`ExporterController.cs` `RenderWithOfficialAlpha`，:7519-7626）：

1. color pass：正常渲染到 ARGB32 MSAA4x RT；
2. alpha mask pass：`RenderCameraWithReplacementMaterial`（:7893-7949）把 RenderType 匹配的
   renderer 全部换成 `Custom/AlphaFillOpaque`——FS 恒输出 (1,1,1,1)
   （`Custom_AlphaFillOpaque_FS.metal:17`），**与纹理 alpha 无关，纯几何覆盖**；
3. 合成：`Hidden/R2TColorAlphaCombineAdd` FS:30 `out.a = clamp(alphaRT.x + colorRT.a)`。

即参与材质的几何覆盖处最终 alpha=1。旁证（排除「纹理/顶点色另有 1 的来源」）：

- `Lettuce_FoilTiers` 原生 DXT5（format 12）UnityPy 解码 alpha 与抽取 PNG 一致（环带中心行
  texel alpha 95~110/255 ≈ 0.37-0.43）——纹理 alpha 在环带就是部分值；
- OvalFrame 网格**无顶点色流**（`essential_base_global-mesh-0`
  `Card_InHand_Ally_Merc_Oval_Mesh` m_VertexData m_Channels[3].dimension=0，m_Colors ABSENT）
  → COLOR0.a=1（FS=tex×COLOR0），颜色 pass 的 src.a 到不了 1；
- **环带压卡区 bleed=ref−src≈0.43**（n=400、采样 tex.a≥0.3、底图均值 94.6 的亮底像素；按
  a=0.33 的 One/OneMinusSrcAlpha 混合应 +63）→ 颜色 pass 里环的 rgb 就是替换式覆盖
  （=第五轮 rgb 直写的直接依据，也解释了第五轮四候选表里 dst 项全为 0 的回归结果）；
- 环带外沿网格覆盖、图集光晕尾部 **texel alpha=0** 的像素：基准 = (texel.rgb, 255)——
  (230,95) 基准 (60,58,57,255) vs 该处 texel rgba (59,58,57,0)，rgb 逐字节同源
  （探针 `explore/2026-10-10-lettuce-frame/scripts/ring_alpha_probe.ts`、
  `probe_oval_colors.py`）。

**落码**（`raster.ts` premultiplied 分支，`PlanSlot.premultiplied` 注释同步）：

1. alpha 通道写 **1**（几何覆盖面），不再做纹理 alpha 的 over 累加——
   `outA = premultiplied ? 1 : sa + dstA(1−sa)`；
2. premultiplied 槽 **sa=0 纹素不跳过**（`if (sa <= 0 && !premultiplied) continue`）：
   同样 stamp rgb=tex.rgb + alpha=1。首版只改 (1) 时，不透明环带外圈留了一圈半透明锯齿边
   （用户目检「边框变成半透明的了」，2026-10-11），即漏 stamp 的 sa=0 覆盖像素。

**残差**：基准 alphaRT/colorRT 均 MSAA 4x——环带几何边缘 1-2px 的半覆盖软边（如 (246,92)
基准 (37,38,33,183)、(250,92) 基准 (46,41,40,224)）本链无 MSAA 无法逐像素复刻（覆盖内写
255、覆盖外透卡影），超出段残存 207 px 亚像素级边缘差。排障口径白底合成 |d|>8 像素
15896 → 14125（均值 2.097 → 1.843）；变化像素 1952 中 1942 向基准改善、9 恶化 ≤7 灰阶。
`bun run l2` 验收待用户目检后补记。

### 12.14 第八轮（进行中，未收敛；**已被 §12.15 推翻归因**）：环右缘残差 = OvalShadow 未乘到环上（2026-10-11）

层 1-3 修完后弧（MAE 0.6~1.5）与左缘（0.8）已干净；残余集中在环右内缘
x[344,368] y[116,228]，本链比基准亮 +4~+16。

排查与排除（探针 `ablate2.ts`/`os_alone.ts`/`os_probe.ts`/`pf_probe.ts`/`pf_sub1.ts`/
`pf_tex.ts`/`zorder.ts`，输出 `out/verify/abl2_*.png`、`os_*.png`）：

1. **条带归属**：消融 PortraitFrame_mesh/OvalFrame——条带属 OvalFrame；
   PortraitFrame_mesh 贡献≈0（唯一子网格 = 肖像窗，已被 NpzBlank 清空，无几何可画
   _SecondTex）→ 排除。
2. **模型排查**：逐像素引擎 α 反解 vs 纹理 α 负相关（−0.38）排除；BannerAtlas@uv1 α
   正相关 +0.57（能把底部楔形 MAE 43.9→19.8）但解释不了右缘带；反向 cutoff（a<0.5 才画）
   类模型更差（顶弧 MAE 20~28）→ 排除。shader 对账：`Custom_Card_UnlitTexture` FS =
   tex.sample(uv0)×COLOR0（rgba 全乘、无第二纹理、无 cutoff 分支）→ 缺失的压暗来自别的层。
3. **根因锁定**：因子图 f=ref/src 显示 f≈0.648 恰好在 OvalShadow（FlagShadow 平面、
   Hero/Multiply/Multiply、_Color=0.3396 → 暗核理论因子 min(0.31+0.34,1)≈0.65）与环右缘的
   交叠区；层序 OvalShadow（worldY −0.0320）在环（−0.0897）之后、卡面（−0.0316）之前 →
   引擎里旗影乘在环上。本链 OvalShadow 实测作用区 = 0 像素：平面采样落在 FlagShadow 的
   亮边（α 均值 23/255、rgb 0.93 → alpha 门控因子≈1），暗核被旗子/卡面挡住。
4. **平移网格搜索**：最优 dx≈11、dy≈24（环区 MAE 15.65→9.47）→ 证实是内建 Plane 的
   位置/UV 映射错位（§12.9 item 4 抽取口径的疑点），未收敛到定案（网格搜索脚本未存档，
   结论以本节为准）。

排除项登记：`Lettuce_MercOval_HeathAttackScarf` 是攻/血宝石图集，不是环的第二纹理；
肖像暗角环（「亮度框」）径向剖面两图一致，不是「框取小了」。

> **推翻说明（2026-10-11 第九轮）**：本轮「根因锁定」的 OvalShadow 归因不成立——引擎里
> 该节点从不被激活（序列化失活 + 无代码触达，见 §12.15），FlagShadow 采样链的分析与
> dx/dy 网格搜索都是在追一个引擎里不存在的渲染。基准图环右缘的压暗真源 = 旗影剪影
> `Lettuce_Faction_Shadow`（随旗容器激活），本节层数值保留作对照。

### 12.15 第九轮：旗影真源 = `Lettuce_Faction_Shadow` 剪影（推翻 §12.8 item 7 / §12.14 的 OvalShadow 归因）（2026-10-11）

**现象**：用户报「佣兵的阵营旗帜的阴影未渲染」，要求探索原始 prefab 补渲染；本轮禁止
agent 自行基准比对，产出 fixture 交用户肉眼验收。

**证伪链**（每步独立可查）：

1. **反编译激活链**（`Actor.cs:3530-3560` `UpdateMercenaryFactionBannerMesh`）：
   `m_factionBannerBackground.SetActive(flag)`（:3546）+ 循环只切换 7 个图标
   `factionBannerIcon.m_banner.SetActive(flag2)`（:3547-3555）。**两个 shadow 节点都无代码
   触达**——ilspy 全库 grep「OvalShadow」「Lettuce_Faction_Shadow」零引用。
2. **序列化显隐**（frame_recon 探针）：`Lettuce_Faction_Shadow` **active_self=true**，
   `OvalShadow` active_self=false。Unity `SetActive` 作用于容器时自激活子孙连带激活——
   旗容器激活 → **剪影随旗渲染、OvalShadow 永不渲染**。§12.8 item 7 的「基准旗影 = 
   OvalShadow」把两者搞反了（当时只查了 actor 的 7 项图标表，漏了容器激活传播语义）。
3. **剪影几何与图集**（probe_plane_flagshadow.py + 图集裁剪）：`Lettuce_Faction_Shadow`
   = 4 顶点 quad（2 tri），mesh UV 窗 u[0.782,0.969]×v[0.222,0.428] 直指
   `FactionBanner_Icons` 图集剪影象限——裁剪实测核心 rgba≈**(0,0,0,245)** 纯黑剪影
   （Horde 象限对照 (131,72,60,253)）；材质同图标 `Faction_Symbols`
   （`Hero/Unlit_Transparent` alpha-over，`_Color` 白，无 ST）。
4. **位置对账**：影 quad 世界位 y=0.1048（旗图标 0.106+ 之后、环 0.04 之前 → 画序
   影→旗，被旗盖住只露边），投影 px[338,478]×py[97,250]；§12.14 残差带
   x[344,368] y[116,228] 恰为其**左缘露出段**（压在环右缘带与卡面上）✓。
5. **OvalShadow 旁证回收**：§12.14 观察到的「本链作用区 0 像素/暗核被旗挡住」与
   「网格搜索平移不收敛」都是因为追的不是渲染源；其 FlagShadow 采样链问题（ST
   (0.91,0.91,1.18,2.97) 越界 + wrap 缺失 + 内建 Plane UV 180° 反向）真实存在但随
   节点回退一并不再生效。

**实现**（plan.ts 佣兵阵营段 + scripts/extract_frame.py）：

1. `Lettuce_Faction_Shadow` 随旗激活（`visible=true`，走标准 alpha 槽路径——材质/网格/
   UV 全是序列化值，无运行时写点）；`OvalShadow` 的随旗激活**回退**（引擎从不激活）。
2. `extract_frame.py` 内建 Plane（pid 10209）UV 角向按探针修正：uv(0,0) 在 (+5,+5) 角、
   u 沿 −x、v 沿 −z（121 顶点实测；此前「与 Quad 同约定 (-x,-z)→(0,0)」是假设，恰
   180° 反向）。OvalShadow 不再渲染后该路径暂无使用方，修正为资产口径正确性。
   重取 hand-mercenary：nodes=117 / meshes=61 / textures=31 / **issues=0**。
3. `types.ts` skip_depth_test 注释更新（无使用方；机制保留）。

**自检（本轮按用户要求未做基准比对）**：全 43 fixture 重渲，与修复前自身输出字节比对
——**42 张逐位零回归（changed=0），仅 LT23_816H 变化**；该卡变化 1680 px
（|d|>8），bbox x[353,470] y[104,241]，最强变化在旗左缘/环带下方（如 (368,224)
198→89），与剪影投影吻合。L2 待用户肉眼验收后补记。

## 13. 收尾（ticket 06）：全量 L2 与最终数字（2026-10-11）

四族全部落地后的全量验收跑（`bun run fixtures` 43 张重渲 → `bun run l2` 42 张；BG24_Reward_107
无基准图，为既有状态非本特性缺口）。**全部 42 张绿**，四个新槽最终数字：

| 卡 | 槽 | mae_vis | 备注 |
|---|---|---|---|
| LT23_816H | hand-mercenary | **2.711** | 佣兵族最佳；worst_zone banner 8.267（阵营旗区） |
| LT24_021T1_01c | hand-lettuce-ability-minion | **3.061** | |
| LT23_036E2_04 | hand-lettuce-equipment | **3.690** | |
| LT23_802P2 | hand-lettuce-ability | **4.113** | 肖像 mip 修复（§12.12）后进一步下降 |
| LT23_803P2 | hand-lettuce-ability | **4.684** | 同上 |

§12.15（旗影真源）的「L2 待补记」至此闭合：LT23_816H 2.711 = 第九轮修复后的实测。佣兵本体
六至九轮的收敛轨迹：11.805 → 4.763 → 4.653 → 3.786 → 3.303 → 2.978 → 2.711。其余非佣兵
fixture 数字与 §12.12 全量清单一致（肖像 mip 修复全局受益：39 降 3 平 0 升）。

站点：`apps/web/src/meta.ts` 的 LT23 过滤移除（ticket 20 处置撤销），佣兵卡全部恢复收录。
用户裁定（2026-10-11）收录佣兵技能卡型 + 佣兵专属控件：表单可表达全族——技能形态
（施法/召唤/装备 → tag 1676/1855）、本体（佣兵勾选 + 职业/阵营 → tag 1665/1666/2720，
官方 zhCN 取自游戏 Strings/zhCN：GLOBAL_ROLE_*/ GLOBAL_MERCENARY_FACTION_*，NEUTRAL
角色无官方字符串取「中立」）。五形态冒烟与 parity 13/13 逐位一致。

## 证据文件索引

- 探针输出：`explore/2026-10-10-lettuce-frame/pack/frames/{lettuce-ability-spell,
  lettuce-ability-minion,lettuce-equipment,lettuce-mercenary-hand}/`；本轮新增
  `explore/2026-10-10-lettuce-frame/output/merc-bindings.json`（角色/阵营/等级绑定表）
  与 `explore/2026-10-10-lettuce-frame/scripts/probe_merc_bindings.py`；
  §12.15 新增 `output/plane_flagshadow_probe.json` +
  `scripts/probe_plane_flagshadow.py`（内建 Plane 逐顶点 UV + FlagShadow wrap/暗核 +
  图集剪影象限裁剪）
- 抽取脚本：`explore/2026-10-10-lettuce-frame/scripts/extract_lettuce_probe.py`
- 反编译：`ActorNames.cs:107-156,570-591`；`EntityBase.cs:466-500`；
  `LettuceAbilityActor.cs:27-32,57-112,137-144,210-227`；`Actor.cs:1351-1353,3540-3565,6125-6186`；
  `ExporterController.cs:5107-5112,7452,11422-11560`
- 关联：ticket 20（水印占位修复 + 残余差异登记）、five-cardtypes findings §1（学派板机制）、
  2026-10-06-l2-offset findings（锚口径，本票修正其佣兵假设）、2026-10-07-edge-align findings
  （基准重导批次 1c20554 携带 4d45b89）
