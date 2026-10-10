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

## 证据文件索引

- 探针输出：`explore/2026-10-10-lettuce-frame/pack/frames/{lettuce-ability-spell,
  lettuce-ability-minion,lettuce-equipment,lettuce-mercenary-hand}/`
- 抽取脚本：`explore/2026-10-10-lettuce-frame/scripts/extract_lettuce_probe.py`
- 反编译：`ActorNames.cs:107-156,570-591`；`EntityBase.cs:466-500`；
  `LettuceAbilityActor.cs:27-32,57-112,137-144,210-227`；`Actor.cs:1351-1353,3540-3565,6125-6186`；
  `ExporterController.cs:5107-5112,7452,11422-11560`
- 关联：ticket 20（水印占位修复 + 残余差异登记）、five-cardtypes findings §1（学派板机制）、
  2026-10-06-l2-offset findings（锚口径，本票修正其佣兵假设）、2026-10-07-edge-align findings
  （基准重导批次 1c20554 携带 4d45b89）
