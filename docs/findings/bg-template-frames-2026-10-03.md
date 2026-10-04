# 战棋系卡型帧与模板渲染落地（2026-10-03）

范围：酒馆战棋随从 / 酒馆法术 / 普通法术(BG 模板) / 饰品 / 畸变 / 任务奖励 的手牌渲染。
此前这些卡型全部回落随从帧；本批按反编译 + exporter 行为 + 资产探针落到正确的帧与战棋模板视觉。
**视觉验收由用户执行**（HSJSON 官方渲染图对 BG33_828/BG30_802/BG32 缺失，仅有 BG27_Anomaly_580）。

## 1. actor 选择（ActorNames.GetHandActor，ActorNames.cs:546-569）

| 卡型 | actor | 本仓 slot |
|---|---|---|
| BATTLEGROUND_QUEST_REWARD(40) | HAND_SPELL（与 SPELL 同分支 :550-553） | hand-spell（复用） |
| BATTLEGROUND_SPELL(42) | HAND_SPELL | hand-spell（复用） |
| BATTLEGROUND_ANOMALY(43) | BIG_CARD_BG_ANOMALY = Card_Hand_BG_Anomaly.prefab:7f3f43fd…（:158-161） | hand-bg-anomaly（新抽） |
| BATTLEGROUND_TRINKET(44) | BIG_CARD_BG_TRINKET = Card_Hand_BG_Trinket.prefab:3c79ff39…（:162-165） | hand-bg-trinket（新抽） |
| MINION(4)/BUDDY(47)（战棋模板） | HAND_MINION（不变） | hand-minion |

**PLAY actor 不参与**：exporter `ResolveActorPrefabRef`（ExporterController.cs:5022-5045）只在
Battlefield zone 用 PLAY actor；Hand zone 恒走 HAND actor（战棋模板也一样），差异全在模板视觉。

## 2. 战棋模板视觉（exporter ApplyBattlegroundsHandVisualSetup :5056-5620 逐分支对译）

引擎语义：`Actor.UpdateManaGemComponent`（Actor.cs:5150-5206）在 tier/coin 成立时隐藏
m_manaObject → **费用宝石被 spell 视觉替换**。spell 实例来自 actor 的 SpellTable
（`m_Table[] = {m_Type, m_SpellPrefabName}`，SpellTable.cs；探针
`explore/2026-10-03-bg-template/output/spell_tables.json`）：

| SpellType | prefab（已提取到 pack spells/{key}/） |
|---|---|
| TECH_LEVEL_MANA_GEM(156) | Card_Hand_Ally_TechLevelManaGem（key `tech-level-gem`） |
| TIME_TAVERN_TIER_ICON(308)（BACON_TIMEWARPED，Actor.cs:7474-7484） | Card_Hand_Ally_TierIcon_Timewarped_Tavern（`tier-icon-timewarp`） |
| COIN_MANA_GEM(145)（法术帧变体） | Card_Hand_Ability_CoinManaGem（`coin-ability`） |
| COIN_MANA_GEM_BACON_SPELL(267) | Card_Hand_Ability_CoinManaGem_BaconSpell（`coin-bacon-spell`） |

逐卡型规则（plan.ts compileFramePlan，模板 = pivot.preset.template === 'Battlegrounds'）：

- **随从(4/47) tech>0**：tier 盾+星替换宝石 + 费用数字隐藏（`ApplyBattlegroundsHandMinionVisualSetup`
  → ShowTavernTierSpell + HideCoinManaGem + HideBattlegroundsHandCostTextNumber）。
- **酒馆法术(42)**：tech>0 → tier 徽章 + Bacon 专用铸币；否则普通铸币（:5506-5546）。
- **普通法术(5) BG 模板**：tech>0 → 仅 tier 徽章且费用清空（exporter 注释引 ShouldHideCost）；
  否则铸币。
- **饰品(44)**：铸币（coin 分支含 trinket :5459-5464），费用数字保留。
- **任务奖励(40)**：隐宝石 + 费用清空 + 铸币（:5590-5620）。
- **畸变(43)**：无分支命中 → 纯帧（prefab 里 Gem_Mana 序列化失活、无 cost 角色 = 无费用显示）。

## 3. 新帧结构（探针实证）

- **hand-bg-anomaly**：ability 帧家族（Mesh[139,18] + `Card_Inhand_Ability_Anomaly` 框材质；
  肖像 PortraitFrame_mesh sub1 matIdx=1）；无 cost 角色；RarityFrame/RarityGem/精英龙同法术帧
  （BG27_Anomaly_580 无 RARITY tag → 稀有度规则自动隐藏）。
- **hand-bg-trinket**：`m_cardMesh` 与 `m_portraitMesh` 同指 `NonQuestObjects/Mesh/FrameMesh`
  （单子网格 249 tri，slot0 'Trinket_Hand_BigCard_Player'，**slot1 序列化为空**）。
  - **原画窗**在兄弟节点 `NonQuestObjects/Mesh` 的 slot0（`BG_Trinket_BigCard_FramePortrait_Mat`，
    6 三角窗 quad）——FrameMesh slot1 无几何，运行时 SetPortraitMaterial(m_portraitMatIdx=1)
    无处可写；本仓 plan 直接把 pivot 原画写进该槽（此前渲染为占位白）。
  - **等级徽章**：`TrinketLevelIndicatorRing` 子树（`UpdateBaconTrinketComponents`，Actor.cs:5404-5420）
    仅 SPELL_SCHOOL ∈ {LESSER_TRINKET=11, GREATER_TRINKET=12}（TAG_SPELL_SCHOOL.cs:14-15）时显示；
    `Trinket_Medallion_Portrait_Mesh` materials[0] 运行时换 m_lesser/greaterTrinketMaterial
    （`Hero/Unlit/Unlit_Texture`，_MainTex = TrinketIconHeroSelect_lesser/greater，
    材质内容已入 frame_recon.material_refs）。本帧肖像第二通道缺失 → 肖像层按纯 main 纹理降级
    （second 全零 → w=0；登记残差）。
  - "Mesh Old (From Card_Hand_Ability)" 整树序列化失活（活动性兜底）。

## 4. spell 预制的渲染语义

- **摆位**：spell 实例挂 actor 根、用预制序列化位姿（exporter 不重排；根平移归零纪律同帧）。
  coin 的 Gem_Health 落点 = 帧宝石位（实测铸币屏幕 bbox x[65,156] 与 Gem_Mana 同位）；
  tier 盾/星亦然。**例外**：tier 预制的 Stars/Shield 节点序列化坐标是"泊位"（x≈−4.3/−6.7），
  运行时由 PlayMaker FSM 搬运——离线链无法读 FSM，**实测盾/星的 world 平移（−0.78/−1.13）
  与帧宝石位一致**，即 FSM 最终就位坐标恰好等于……（注：本仓按预制里 world 矩阵渲染的落点
  与宝石位吻合，泊位只出现在 local，整链 world 组合后正确——登记为"FSM 语义未显式复刻，
  靠序列化 world 成立"，若后续帧出现偏差需回填 FSM 搬运规则）。
- **星数**：`Stars/Lv1..Lv7` 分组（Lv_n 含 n 颗星），ShowTavernTierSpell 写 FSM 变量 TechLevel
  后激活（Actor.cs:7497-7505）→ 本仓按 Lv{techLevel} 点亮（Lv 子树不受序列化失活约束）。
- **混合**：coin Gem_Health 是 `Hero/Diffuse/DiffuseAlphaMaskScroller`（宝石 shader 族）→
  走 gems 阶段公式（`_tint=(0.081,0.074,0.039)`、`_Intensity=0.05`、speed(5,0)）；
  普通 unlit 光栅会丢 clouds×_tint 项（实测铸币被 `_Color` 染绿）。星芒/辉光
  （`Hero/Additive/*`）新增 additive 混合（SrcAlpha·One，不写深度）。`Health_Burst`
  （Birth 态瞬闪）与 `Health_Persistant`（常驻辉光）**均不渲染**——它们的锚在铸币上方
  （FSM 摆位），随 overlay 平移会让"铸币+辉光"整体比基准圆心偏上；§8 原登记的
  "Persistant 是否显示"待决项就此了结（铸币位多轮用户目验均基于不渲染口径）。

## 5. 其它

- **schoolZh 补 TAVERN**：`tables.schoolZh` 此前只有七大学派（tag_enum.csv 未收录 2023 后新增
  学派行；GameStrings.cs:1168-1200 有键）。TAVERN →「酒馆」（GLOBAL_SPELL_SCHOOL_TAVERN 通用译名；
  **用户视觉复核项**）。重生成后 class/raceZh/colorSwitcher/hideTags 逐字节不变。
- **任务奖励无 pivot 卡**：规则已实现（40 → hand-spell + coin + 隐宝石/费用），探针卡
  BG24_Reward_107（dbf 89449，`explore/2026-10-03-heropower/scripts/build_probe_pivot.py`
  PROBE_DBF=89449 生成，模板手工切 Battlegrounds）渲染通过。铸币变体 = 表 145 条目
  **coin-ability**（exporter 任务奖励分支 ActivateSpellBirthState(COIN_MANA_GEM)，
  ExporterController.cs:5589-5604——非 Chronum；早期笔记"Chronum 铸币"系笔误，已更正）。
  exporter 笔记里的 quest tray（Card.UseBattlegroundQuestComponent 关 Description_mesh/开
  Card_Hand_BG_Quest_Text_Tray_Mesh）**未实现**——exporter 自己的手牌路径实际是
  Description_mesh=true/tray=false + SetUseBGQuestSiloutte（:5089-5093），与我们的普通帧渲染一致。
  另入基线集：BG24_Reward_310（任务奖励基线 2，`data/pivots/BG24_Reward_310.json`）。
- 字形缓存：探针卡新增 8 字形（含 BG24_Reward_107 描述字符）。

## 6. 验证记录

- **L1 冒烟**：`px>4 = 4090`（2026-10-04 review 修复后复测，与既有已知签名逐位相同——
  数字描边口径分歧见 hero-power findings §6.7；非基准，仅确认无意外漂移）。
- **pivot 全集回归**：`bun run pivots` 32 preset 全部渲染通过（含 BG24_Reward_107/310 两个
  任务奖励基线）。首批 30 张回归时只有 6 张战棋系变化（BG33_828/BG30_802/BG27_Anomaly_580/
  BG32_MagicItem_350/BG34_Giant_072/BG34_Treasure_917——后两张是时空扭曲战棋卡）；
  LT23 佣兵/PET 等非战棋卡逐像素 0 差异。
- **七卡渲染图**：`explore/2026-10-03-bg-template/output/bg7_grid.png`（+ trinket/quest reward
  大图 `trinket_quest_grid.png`）。typecheck/lint 干净（lint 30 条既有 warning，0 error）。
- **官方基准图**：`explore/fixtures/*-hand-*.png`（HSJSON 官方渲染，512×768）已入库，
  覆盖 BG30_802/BG33_828/BG34_Giant_072/BG34_Treasure_917 等——L2 比对通道恢复。

## 7. 用户复核修正（2026-10-03 第二/三轮）

1. **铸币变体按帧选 + 英雄技能(10) BG 规则**：逐表探针（`probe_table_refs.py`，沿表 prefab
   根 GO 组件走）给出各帧自己的 145 条目——hand-spell → `Card_Hand_Ability_CoinManaGem`；
   hand-heropower → **`History_HeroPower_CoinManaGem`**（宝石位顶中，Gem_Health local
   (0,0,1.398)）；hand-bg-trinket → 表条目 "…CoinManaGem 1"（名字串陈旧，实际
   `Card_Hand_Trinket_CoinManaGem`，GUID 权威、registration 通过即采）。plan `coinKey`
   按 slot 选；英雄技能 BG = 铸币替换顶中宝石（用户口证"英雄技能的铸币不在左上角"）。
2. **酒馆法术(42) tech>0 的铸币/费用位**（用户两轮口径合并）：等级徽章在宝石位，**金铸币 +
   费用数字在徽章正下方** = alternate-cost 文本位（`m_alternateCostTextLocalPos`，Actor.cs:562
   默认 (-0.01,0.003,-0.58)，hand-spell 帧实测屏幕 (107,242)，徽章位 (110,127) 正下方）。
   铸币（FSM 搬运）与费用文本（`EnableAlternateCostTextPosition` → `UpdateManaGemOffset`，
   Actor.cs:1178/6454）同点。实现：overlay `world_target` 锚定（渲染期整体平移，含 gems 阶段的
   铸币正面——收集须在锚定后）+ texts.cost `world_delta`。实施 bug 登记备查：`Object.keys(Map)`
   恒 `[]` 曾致路径匹配静默失效（world_target 落到恰好正确的兜底值而未暴露）。
3. **时空扭曲(42+4503)**：**无铸币**；数字位不变；其基座 = **Timewarp 皇冠盾**
   （`Bacon_AllTierGuide_TimewarpTavernTier` 图集 crown 区，贴图/渲染色已核对一致），
   tier-icon-timewarp overlay 锚到费用文本位（用户裁定；exporter 的 COST_ALT_TAVERN_COIN
   分支与用户口径不符——登记差异，alt-tavern-coin 资产已提取备用）。
4. **饰品铸币位**：饰品帧自己的 Gem_Mana 在**顶中 (256,97)**（费用文本 (257,85) 同位）——
   铸币锚定原则统一为"各帧自己的 Gem_Mana 世界位"（UpdateManaGemComponent 原位替换语义）。
5. **全透明纹素不写深度**（raster.ts）：引擎透明队列 ZWrite Off / alpha-test discard，
   sa=0 纹素从不遮挡；离线链此前无条件写深度。L1 签名不变（0.322）。
6. **饰品徽章（大型/小型）渲染**（用户："大型、小型没渲染上"）——两个叠加根因：
   a. Ring 节点 slot0 = 6-tri 白色占位底板（`BG_Trinket_BigCard_FramePortrait_Mat`，
      _MainTex=GenFX_white32x32），序列化深度比纹章近，整个盖住纹章 → 徽章激活时该 quad
      不参与光栅（占位语义；真实底板材质的运行时来源待 exporter 基准确认）；
   b. 纹章（Trinket_Medallion_Portrait_Mesh）序列化材质 `_Color=(0,0,0,1)` 纯黑——
      运行时整材质替换为 lesser/greater 材质（_Color 白），离线链只换贴图不换 tint → 纹章
      被染黑。修复：swap 时同步 `material_override._tint_rgb`（取 material_refs 实测）。
   另：徽章子树深度互相穿插（Ring face ±0.1 穿过纹章 0.0714-0.0755），全局 z 排序无法还原
   游戏观感 → 徽章子树走**晚通道**（主帧后按激活序 [shadow → ring → 纹章] 合成，每节点独立
   深度缓冲，`plan.late_nodes` + buildRenderList exclude/include）。
7. **酒馆法术铸币尺寸/位置校准 + 时空布局终版**（用户参考裁剪比对，第四轮）：
   - 非时空：铸币直径/数字高 参考比 **1.40** vs 本仓初版 1.78（铸币偏大 27% 且偏高）→
     overlay `scale: 0.785`、圆心校准到 **(108, 236)**（数字 (110,253) 左上方；参考裁剪同比例
     关系 digit−coin = (+0.043,+0.243)×数字高）。数字位置不变（alternate-cost 位）。
   - 时空扭曲：等级盾用 AllTierGuide 图集**下面那格**（plain 紫盾，非 crown 格）——
     overlay `uv_offset: [0,-0.5]`（渲染期仅作用于采样 AllTierGuide 图集的 submesh）；
     **保留 Chronum 铸币**（Alt coin 的宝石节点名是 **Gem_Coin** 非 Gem_Health——收集/跳过
     规则按节点名两者皆查；此前走普通 unlit 光栅被 _Color 染绿，改走 gems 公式后色泽正确），
     锚到费用文本位。exporter 的 COST_ALT_TAVERN_COIN 分支差异继续登记。
8. **任务奖励入基准集**（用户裁定）：BG24_Reward_107（dbf 89449 尖啸零食）加进
   `data/pivot.md` presets（NORMAL/Battlegrounds/Hand），`extract_pivot_data.py` 重导
   31 张 + 原画。渲染路径 = 任务奖励规则（40 → hand-spell、隐宝石/费用清空、铸币 =
   coin-ability，见 §5 更正）。后补 BG24_Reward_310（任务奖励基线 2），共 32 preset。

7. **徽章/铸币位置按基准逐轮校准**（exporter fixtures 入库后，`l2_diff.py`/星徽金心
   量测迭代）：三卡（BG30/BGT/BGG）的 tier 盾与铸币 overlay 各自锚定到基准实测位。
   方法：紧内容-bbox 对齐后，量「紫色质心」「星徽金心」在基准/本仓两图的差 → 直接
   修正 overlay `world_target`。最终一轮三卡徽章紫质心/金心与基准均 ≤3px。
   中途一次 `git checkout plan.ts` 误回退未提交改动，已按对话补丁完整重放恢复
   （typecheck/lint/全量渲染验证过）；所有手工 target 曾全部作废重推——位置量测以
   「金/紫像素质心」为准（原画紫色干扰用窗口限制排除）。

## 8. 待用户视觉复核 / 已知边界

1. 「酒馆」学派板译名。
2. tier 预制 FSM 搬运语义未显式复刻（靠序列化 world 成立，见 §4；时空扭曲盾经用户确认
   序列化位姿即正确，见 §9 第四轮）。
3. 饰品徽章底板（Ring slot0 白 quad）的真实运行时材质待 exporter 基准确认。
4. 时空扭曲随从费用数字对齐 hand-spell 帧位（`ALT_COST_WORLD_HAND_SPELL`）是**偏离引擎
   数学**的用户裁定（随从帧 CostObject 原生偏左 ~2.9px，见 §9 第五轮）——若后续发现
   官方实际保留该偏左，需回退。
5. 时空扭曲法术的 Chronum 铸币：游戏内该图标无法正确渲染（用户注），预制位姿即权威；
   官方 fixture 若与预制位姿不符，以预制为准。

## 9. 铸币/等级徽章位姿以预制序列化根 TRS 为准（2026-10-04 修正，用户目验通过）

**现象**：官方渲染图入库后（`explore/fixtures/BG30_802-hand-battlegrounds-normal.png`），
非时空酒馆法术（BG30_802，cardType 42，TECH_LEVEL=6）的铸币画在帧宝石位、叠上等级徽章；
官方图中铸币在徽章正下方。

**排除法证据链（引擎里"谁在搬铸币"逐一排除）**：

1. `UpdateManaGemComponent`（Actor.cs:5150-5206）激活的 `m_baconCoinObject` 在 hand-spell
   帧预制（Card_Hand_Ability）Actor 组件 object_refs 里**无此字段**（prefab_report 探针）→ null，分支跳过。
2. `UpdateManaGemOffset`（Actor.cs:6451-6457）**只挪 `m_costTextMesh`** 到
   `m_alternateCostTextLocalPos`，不挪铸币。
3. `ShowCoinManaGem`/`ShowTavernTierSpell`（Actor.cs:7489-7506）只实例化 + 激活 BIRTH，
   不改位置；SpellTable.GetSpell 亦不重排。
4. coin 预制根 GO 的 PlayMakerFSM 是空转的（单状态无动作，typetree `fsm` 字段内联，探针
   `explore/2026-10-04-bg-spell-coin` 前身 `/tmp/dbg_fsm*`）。
5. 只剩挂载语义：`Actor.LoadSpell`（Actor.cs:6949-6951）`TransformUtil.
   AttachAndPreserveLocalTransform`（TransformUtil.cs:920-925）把 spell 预制按**预制本地 TRS
   原样**挂到 `GetSpellParent()`——actor 根下恒等 "Spells" 节点（Actor.cs:7814-7825，
   m_spellsParent 非序列化、恒走新建分支）；随后 `localScale.Scale(m_sharedSpellTable 根缩放)`，
   实测 Card_Hand_Ability_SpellTable 根 scale=(1,1,1)（/tmp/probe_table_root.py），乘法无操作。
   → **spell 预制根序列化 localPosition 就是运行时摆位的一部分。**

**根因**：`scripts/extract_spell.py` 照搬帧提取的"根平移归零"纪律（帧根因 zone 摆位归零），
抹掉了 spell 预制根的 authored 偏移。实测各预制根位（raw_root_pos 存档与探针一致）：

| key | 根 pos | 说明 |
|---|---|---|
| coin-bacon-spell | (-0.007, 0.062, **-0.643**) | z 折合屏幕下移 ≈113.7px = 徽章正下方 |
| coin-ability | (-0.007, 0.062, +0.007) | ≈0，故 tech=0 铸币此前未露破绽 |
| coin-trinket | (**0.82**, 0.062, 0.25) | 被 world_target 锚定吸收（见下） |
| coin-heropower / alt-tavern-coin / tech-level-gem / tier-icon-timewarp | (0,0,0) | 不受影响 |

**修复**：extract_spell.py 不再归零 spell 预制根 TRS（帧仍归零；元数据字段改
`root_translation_preserved`），`--all` 重提 7 包 → coin-bacon-spell Gem_Health world
(-0.829, -0.018, 0.597) ≈ 屏幕 (109.5, 248)（按 meshes.json 面片×world 推投影：
圆盘直径 91.6px，纯预制推导无像素参与）。plan.ts 非时空分支铸币本就是
`{ key: 'coin-bacon-spell' }` 纯预制位姿、无手调参数，数据修正后自动落位；
等级徽章（tech-level-gem，根 TRS=0）同轮撤销基准实测 `world_target` 锚定、复原纯预制位姿。
**铸币原尺寸（无 scale）即为正确尺寸**——§7-7 的 scale 0.785 / 圆心 (108,236) 校准（在位姿
错误期间量得）随之作废，用户目验确认。

**影响面**：coin-ability / coin-trinket / alt-tavern-coin 的非零根位被 `world_target` 锚定
精确吸收——根平移是全子树刚体位移，锚定把参考节点（Gem_Health/Gem_Coin）对齐到目标后其余
节点相对关系不变，故已验收卡逐像素不变。

**对前文的更正**：§4 摆位条目"根平移归零纪律同帧"作废（spell 与帧挂载语义不同）；
§7-2 "铸币（FSM 搬运）与费用文本同点"中铸币部分作废（UpdateManaGemOffset 只挪文本）；
§7-7 铸币尺寸/圆心校准作废；上条未编号 7 的 tier 盾基准实测锚定对**非时空**分支撤销
（时空扭曲分支的盾/Chronum 铸币锚定仍为用户裁定值，未按本原则复查）。

**时空扭曲 tier 图标（2026-10-04 第四轮，多轮迭代后定稿）**：两个时空扭曲卡（BG34_Giant_072
随从 / BG34_Treasure_917 法术）等级盾最终实现 = **预制纯序列化 + 材质 _MainTex ST 渲染端
应用**：盾网格 Bacon_TechLevel_Shield_Timewarped × 序列化材质 Bacon_TechLevelBanner_Timewarp_Unlit
× 贴图 Bacon_AllTierGuide_TimewarpTavernTier.png，材质 **_MainTex ST offset=(0, 0.475)**
（scale 恒等，extract_frame.walk_material 本就采集；原始材质探针
MeshRenderer→resolve_pptr 实证）→ mesh v[0.537,0.971] +0.475 wrap 后 [0.012,0.446] =
**图集左下格**（用户指认："确实是这个素材里的，但是左下格子"）。
- 各轮误诊复盘：旧 `uv_offset[0,-0.5]` 是 ST 的粗糙近似，比引擎 0.475 低 0.025v ≈ 5px
  = 用户"微微下移"；中间一轮按 FSM 'Default' 态 SetMaterial 分析换成普通盾贴图
  （Bacon_TechLevelBanner，ST 恒等、贴图 Bacon_TechLevel_Banner）被用户否决——游戏内
  背景就是 TimewarpTavernTier 素材本身；FSM 为何不走 Default（IsTimewarp 反编译零引用）
  仍是无解项，以目验为准。
- 实现：render.ts overlay 光栅按材质 `_MainTex` scale/offset 变换 UV（Unity final_uv =
  uv*scale+offset + repeat wrap；整网格 span<1 同周期，逐顶点 fract 无接缝）。spec 级
  uv_offset 机制移除；§7-3 "下面那格 plain 紫盾"裁定作废。
- 标签门槛确认：BACON_TIMEWARPED(4503) → GetTechLevelSpellType（Actor.cs:7474-7484）→
  TIME_TAVERN_TIER_ICON；exporter 侧 ApplyBattlegroundsHandMinionVisualSetup
  （ExporterController.cs:5432-5459）直接调游戏 ShowTavernTierSpell + 灯光混合。
- 残留：帧光栅路径（rasterBucketZbuf）尚未应用材质 ST——手牌帧材质 ST 若出现非恒等需回填。

**第五轮（时空扭曲随从显示，2026-10-04，用户逐项目验通过）**：
- 盾下 Chronum 费用铸币（alt-tavern-coin）恢复：exporter 对 timewarped 随从
  ActivateSpellBirthState(COST_ALT_TAVERN_COIN)（ExporterController.cs:5443-5450）无重排
  → 纯预制位姿（Gem_Coin ≈ 屏幕 (108,250)）；法术分支同轮从 altCost 锚定改为纯预制位姿
  （此前"稍微偏上"~8px，用户目验通过）。预制无 FSM、根 TRS=(0,0,0)；游戏内该图标本无法
  正确渲染（用户注），预制语义即权威。
- 费用数字按法术同法挪 alternate-cost 位（exporter 对 timewarped 随从不调
  HideBattlegroundsHandCostTextNumber）。目标 = **`ALT_COST_WORLD_HAND_SPELL`
  常量**（hand-spell 帧的 altCost 世界位 (-0.8419,0.153,0.6306)）：随从帧 CostObject
  序列化位偏左 0.0163（两帧均未覆盖 ALT 默认值，40 处序列化副本逐位一致——探针实证），
  引擎原样会令随从数字比法术偏左 ~2.9px；**用户裁定消除**（偏离引擎数学的显式例外，
  见 §8-4）。反编译版本对比：Assembly-Csharp（8/6）与 -6b789278（10/3）九个相关函数
  逐字一致，逻辑无漂移。

**第六轮（code-review 修复，2026-10-04）**：清掉 extract_spell.py 死脚手架
（assign_world/rec_mat/`if False else`）；`dbg_stargold.ts` 移出包根进
explore/2026-10-04-bg-spell-coin/scripts/；overlay spec 移除死字段 `scale`/`anchor_node`
（渲染端整体缩放块随之删除）；render.ts blends 映射每节点算一次；plan.ts 抽
`findFrameNodeWorld` 助手收敛三处"后缀找路径→world"重复；textstage.ts 用
`PlanTextEntry.world_delta` 类型替代强转；pivot JSON 补尾换行（生成器同步）。
修复后 L1 冒烟 px>4=4090 逐位不变、32 pivot 全渲染、typecheck/lint 干净。

**用户目验**：第一轮（铸币纯预制位姿含根 TRS）"铸币位置对了"；第二轮（等级徽章复原纯
预制位姿）"这次对了"；第四轮（时空扭曲盾 ST 左下格）正确；第五轮（随从铸币/数字、
法术铸币预制位姿）逐项正确。


