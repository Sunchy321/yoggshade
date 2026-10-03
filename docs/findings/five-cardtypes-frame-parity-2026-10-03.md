# 五卡型帧渲染口径修复与异画帧排查（2026-10-03）

范围：手牌五帧（随从/法术/武器/英雄/地标）的口径修正 + 异画帧排查记录。全部结论都有游戏反编译 /
导出器行为 / 资产实证，逐条出处见下；代码内也留有同源注释（`packages/renderer/src/render.ts`、
`plan.ts`、`raster.ts`）。文中路径一律限本仓与游戏安装目录。

---

## 1. 法术学派板不渲染（comp.mesh 覆写未消费）

**现象**：派系法术（REV_365 万灵之召）学派文本「冰霜」渲染出来了，但文本底下的学派板
（描述框下缘延伸出来的宽板）没有。

**根因**：`Actor.UpdateRace()`（反编译 `Actor.cs:6174-6185`）在学派文本非空时把 `m_descriptionMesh`
的 `MeshFilter.sharedMesh` 换成 `m_spellDescriptionMeshSchool`（否则换回 `m_spellDescriptionMeshNeutral`）。
plan 编译器已按此写入 `comp.mesh = 'extra/m_spellDescriptionMeshSchool'`，但光栅器只按层级
`npz_key` 取网格，覆写从未被消费 → 一直画中性网格（描述框本体，没有学派板几何）。

**实证**：资产包 `frames/hand-spell/meshes.json` 中
`extra/m_spellDescriptionMeshNeutral` = 16/110 tris，
`extra/m_spellDescriptionMeshSchool` = 28/124 tris，多出的三角形落在 u∈[0.028,0.106] 的学派板
UV 区（金边宽板 + 两侧斜肩），与渲染图上的板形一致。

**修复**：`render.ts rasterBucketZbuf` 取网格改为 `pack.meshes[comp.mesh ?? key]`。

---

## 2. 武器框颜色不对（偏深）：TAG_CLASS 表整体错位

**现象**：LOOT_392（世界之树的嫩枝，德鲁伊武器）框体渲染成恶魔猎手的深绿框；实测德鲁伊/猎人/
法师/圣骑士/恶魔猎手五个职业全用错图集。

**根因**：`data/tables.json` 的 `class` 表此前由 `tag_enum.csv` 的 `TAG_CLASS/s_classNames` 行生成，
但该 CSV 的 `value` 列是 **GameStrings 名称表下标**（Neutral 起头、无 Paladin），不是 TAG_CLASS
枚举值。真枚举（`explore/ilspy/TAG_CLASS.cs`）：

```
INVALID=0 DEATHKNIGHT=1 DRUID=2 HUNTER=3 MAGE=4 PALADIN=5 PRIEST=6
ROGUE=7 SHAMAN=8 WARLOCK=9 WARRIOR=10 DREAM=11 NEUTRAL=12 WHIZBANG=13 DEMONHUNTER=14
```

错位后 `tables.class` 把 2→"Demon Hunter"、3→"Druid"、4→"Hunter"、5→"Mage"，
14→查不到（回落 Neutral）。索引 6-10 恰好与真枚举同名，所以牧师/潜行者/萨满/术士/战士
**碰巧正确**，掩盖了问题；中立(12)走 `?? ''` 兜底也正确。

职业→框体图集的权威映射是 `CardColorSwitcher.GetColorTypeForClass`
（反编译 `CardColorSwitcher.cs:171-189` 的 switch），本仓 `plan.ts` 的
`COLOR_TYPE_FOR_CLASS` 与该 switch 逐项同源，键改为 TAG_CLASS 枚举名。

**修复**：`scripts/extract_static_tables.py` 改为解析 `explore/ilspy/TAG_CLASS.cs` 枚举序；
`data/tables.json` 重新生成（`raceZh`/`schoolZh`/`colorSwitcher`/`hideTags` 逐字节不变）。

### 2b. 同一张表的门派（学派）列也错位；插画周围一圈是肖像槽位写死 0 造成的

**学派名错**：`schoolZh` 同样来自 tag_enum.csv 的 `s_spellSchoolNames` 行，那列 value 还是名称表
下标（冰霜=4、自然=11…），真枚举 `explore/ilspy/TAG_SPELL_SCHOOL.cs` 是
`NONE=0 ARCANE=1 FIRE=2 FROST=3 NATURE=4 HOLY=5 SHADOW=6 FEL=7 …`。于是 REV_365（学派 tag=4=NATURE）
渲染成「冰霜」，官方卡面是「自然」。修复：枚举序 + CSV 的 label_enUS/label_zhCN 按名对齐。

**插画周围一圈（肖像框）过暗**：手牌帧的肖像节点（`m_portraitMesh`）子网格是 **两段**：
肖像框（环 + 尖刺）与肖像面片。哪一段是肖像不是固定的，要看 `Actor.m_portraitMatIdx`
（材质槽与子网格一一对应）：

| 帧 | 子网格 tris | m_portraitMatIdx | 肖像材质槽 |
|---|---|---|---|
| 随从 | [19, 389] | 0 | `Card_InHand_Ally-Card_InPlay_AllyPortrait` |
| 地标 | [11, 912] | 0 | `Card_Location_InHand_Portrait_Mat` |
| 法术 | [132, 10] | 1 | `Card_InHand_Ability-portrait` |
| 英雄 | [174, 29] | 1 | `Card_InHand_Ally-Card_InPlay_HeroPortrait` |
| 武器 | [312, 22] | 1 | `Card_HeroWeapon_InHand-mat_portrait_weapon` |

旧代码在 `assets.ts` 清空子网格、`render.ts` 取肖像贴图/子网格三处都写死 0：随从/地标（=0）因此
正确，**法术/英雄/武器（=1）全错**——清掉的是肖像框（环），然后把肖像框当肖像画、用肖像框的贴图
（类色图集）当原画顶上去，于是插画外圈变成图集里那圈近黑的金属环，且原画被二次覆盖。武器最明显
（框占比大）。修复：`m_portraitMatIdx` 统一驱动三处（存进 manifest 的 `portrait_mat_idx`）。

对照官方导出图（`https://art.hearthstonejson.com/v1/render/latest/zhCN/512x/<ID>.png`）：
修复后 LOOT_392 的金属环/尖刺、REV_365 的「自然」板、AV_205 的英雄框与官方图一致。

---

## 3. 地标左半边渲染错误：opaque-edge alpha

**现象**：地标（TTN_090 尤格-萨隆的监狱）左内侧一条竖直带露出**卡背平面**（蓝灰），左缘还有
灰色斑块与「爪形」暗块。

**根因**：地标框体纹理 `Card_InHand_Location_*` 的 DXT5 **alpha 是形状蒙版而不是透明度**
（导出器探针笔记《地标卡透明区域问题分析》《左侧挂件/地标边缘半透明问题研究》）。
游戏渲染到不透明屏幕帧缓冲，所以屏幕上看不到这些洞；官方离屏透明路径另有 alpha pass
（`Custom/AlphaFillOpaque` 的 FS 恒输出 `float4(1,1,1,1)`，即 opaque 几何 alpha 记 1）。
离线链直接按纹理 alpha 混合 → 帧网格被抠出透明洞 → 同节点 sub1（`GenFX_Card_Back_Default_D`
整卡平面）从洞里透出来。

**实证**（`pixel_stack`，TTN_090 像素 (150,500)）：

```
sub0 tri z=0.0136  uv=(0.051,0.215) → 图集 alpha=0.00（不写色）
sub1 tri z=-0.0174 卡背平面 alpha=1.00（透出）
```

把该材质纹理 alpha 强制为 1 后，左半立刻恢复布料 + 金边（A/B 渲染对比）。

**修复**：按导出器的定向名单（`IsOpaqueEdgeAlphaRepairName` / `IsSoftEffectAlphaRepairName`）在 **plan 编译期**给材质槽
打 `opaque`，光栅期 `sa=1`（忽略纹理 alpha，仍写深度）：

- 名单（节点名/材质名/有效纹理名任一子串命中）：`Rune_`、`CardRunes`、`CardRune`、`Forge(Banner)`、
  `Prepare(Banner)`、`Tradeable(Banner)`、`Multiclass_Ribbon`、`MulticlassRibbon`、
  `Card_Location_InHand_Mat`、`Card_Location_InHand_BannerAtlas`、`Card_InHand_Location`
- soft effect 排除：`Shadow`、`Glow`、`Highlight`、`Spark`、`Mote`、`Smoke`、`Fog`、`Burst`、
  `Particle`、`Trail`
- 导出器里的 shader 白名单（`Hero/Unlit[_Transparent]`、`Custom/Card/Unlit_2Texture2uv`）只与
  同名条件**合取**，故本处只看名字条件。

**为什么不做「不透明队列 ⇒ alpha=1」的全局规则**：实测随从帧全局强制后会盖掉原画窗口与宝石
（12.5 万像素差异，diff 图正是椭圆窗+宝石），因为离线链的原画/宝石靠纹理 alpha 让位。定向名单
与导出器行为一致，且不触碰随从/法术帧。

---

## 4. 攻/血图标与数字：英雄 ATK=0 要整块隐藏，普通卡缺 tag 要显示 0

**现象**：英雄卡（AV_205）左下渲染出金色剑形攻击宝石——官方卡面那里是空的；随从卡（DMF_709，
DBF 无 ATK tag）攻击宝石里没有数字，官方卡面是 "0"。

**根因**：手牌帧规则里英雄的攻/血被写死为「全隐」（`slot === 'hand-hero' ? false : attackVisible`），
而攻/血文本用了 `tags[ATK] !== undefined ? … : ''`（缺 tag = 空串）。游戏侧口径不是这样：
`Actor.UpdateAttackTextMesh`（反编译 `Actor.cs:3396-3453`）里

- 文本一律取 `entityDef.GetTag(GAME_TAG.ATK)` —— **GetTag 缺 tag 返回 0**，所以无攻随从显示 "0"；
  `UpdateHealthTextMesh`（反编译 `Actor.cs:3456-3493`）对 HEALTH 同理。
- **只有英雄**有特例：`IsHero() && num == 0` → `m_attackObject.SetActive(false)` + 文本清空（图标与
  数字一起消失），`num > 0` 才 `SetActive(true)` 并显示数字。
- 装甲另有自己的口径：`UpdateArmorTextMesh`（3497-3518）`num == 0` → 隐藏装甲对象（本仓已按
  `armorVal > 0` 对齐）。

**修复**（`plan.ts compileFramePlan`）：`attackVisible` 对英雄加 `ATK > 0` 条件（`Gem_Attack` 不可见 →
plan 的 `stat_gems` 不收集 → 宝石层不画）；英雄 ATK=0 时攻击文本置空；其余卡型缺 tag 按 0 显示。
`hand-hero` 规则补上 `attack: ['Gem_Attack']` 与 attack 角色（ATK>0 的英雄要能显示数字，实测人造
ATK=3 变体渲染出剑形宝石 + "3"）。

**为什么加 `SLOT_NATIVE_CARD_TYPES` 限定**：GetTag→0 的补零只对「原生卡型」成立。本仓对尚无专属帧的
卡型（佣兵技能 LT23_*、战棋法术/饰品/畸变/时空、宠物 PET_*、英雄技能 AV_205p）用回落帧渲染，那些
卡在游戏里用别的 actor、根本没有攻血图标；不限定的话这些基线图会平白多出 "0"（实测 8 张 pivot 变化），
限定后只动真正该动的 3 张英雄 + 1 张随从。

---

## 5. 精英银龙影啃掉卡角：乘法混合被当成了 alpha-over

**现象**：TLC_433（恐怖再起，精英法术）右上角缺一块——卡框右上角被一片**不透明黑**覆盖；ETC_210 同帧同病。

**根因**：精英银龙的影子网格（`InHand_Ability_Unique_Dragon_shadow`，材质 `Card_Inhand_Ability_Warlock_Shadow`）
用的是 **`Hero/Multiply/Multiply`**（乘法阴影），离线链按普通 alpha-over 画：

- 顶点着色器（提取的 Metal 源码，shader 名 `Hero/Multiply/Multiply`）：`COLOR0 = 顶点色 × _Color` → 本仓网格无顶点色 →
  `COLOR0 = _Color = (0,0,0,1)`；
- 片元着色器：`rgb = _MainTex.rgb + COLOR0.rgb`、`a = 0`，配 multiply 混合 →
  屏幕上是 `dst.rgb *= 遮罩色`（遮罩 = 图集里「白底 + 银龙剪影渐变」那张：白处不变、暗处压暗）。

本仓 alpha-over 把 `_Color` 当乘法 tint（texel × 0 = 黑）且 alpha=1 覆盖 → 整块涂成不透明黑。

**实证**：`pixel_provenance` 在缺角像素 (400,180) 命中该影节点、单层渲染 `a=1.00` 纯黑；跳过该节点的
A/B 渲染里卡角完好；DK 图集 `Card_Inhand_Ability_DeathKnight` 的遮罩区采样 RGB 0.14~1.0、alpha 恒 1。

**修复**：提取器记录材质 `shader`（`walk_material` 解 `m_Shader` PPtr → `m_ParsedForm.m_Name`，
prefab_report 槽位一并带出）；plan 编译期把 `Hero/Multiply/*` 的槽标 `blend: 'multiply'`；光栅期
`dst.rgb *= min(纹理色 + _Color, 1)`，**alpha 不变**（乘法阴影只压暗、不产生遮盖；游戏在不透明屏幕
帧缓冲里 a=0 无副作用，离线链若让它清 alpha 会把卡角抠空）。

**影响面**：同族还有符文底影、多职业绶带影（失活子树）、地标费用宝石投影（STATIC_HIDDEN）；武器帧的
`Card_Inhand_Weapon_Drake_shadow` 挂在 submesh 数为 1 的节点的第 1 槽，游戏同样不绘制（子网格↔材质槽
一一对应），本仓行为一致、未改。

### 5b. 续：乘法阴影**写深度**把卡图挡在 zbuf 外（用户复核「还是没修好」的真根因）

**现象**：改完乘法混合后，ETC_210（**非异画**，用户指定以此为准）与 TLC_433 的画窗上缘仍是框体底色，
官方卡面那里是**卡图**（用户：「只是填入了一块灰色背景 + 一部分银龙，没有正确渲染卡图」）。

**定位**：把「肖像公式层」单独渲染，它在那片区域画出的像素与官方**逐值吻合**（(250,150) 官方
(97,95,64) vs 肖像层 (95,95,66)）——说明卡图本身画对了，是被别的层挡住。查 zbuf：`Hero/Multiply/*`
的 subshader tag 是 `QUEUE=Transparent`（即 ZWrite Off），而银龙影面片比肖像面片更靠前（世界 Y 更大）；
我第一版乘法实现沿用了「写色也写深度」，于是影面片把随后绘制的肖像层挡在 zbuf 之外。

**修复**：乘法分支**不写深度**（只按 zbuf 测试、只压暗 RGB）——对齐该 shader 的 Transparent 队列语义。
修复后 ETC_210 列采样与官方逐行吻合（140/145/150/155/160 行：官方 42,51,36 / 82,83,58 / 97,95,64 /
82,85,66 / 115,101,74，本仓 46,55,39 / 89,90,65 / 94,94,66 / **82,85,66** / 119,103,74）。

**影响面**：30 张 pivot 里只有 ETC_210 与 TLC_433（两张带银龙的精英法术）变化，其余逐像素不变。

---

## 6. 异画（signature）卡仍按普通帧渲染：帧族选错（★本次仅记录，未实现）

**缘起**：复核 TLC_433「卡图没渲染」时（该症状的真因是 §5b 的深度写，已修），顺带查出本节这个
**独立事实**：异画卡在游戏里走专属帧族，本仓没实现。

**证据链**：

- 官方参考图 `official_TLC_433.png`（Blizzard 自家渲染，
  `https://art.hearthstonejson.com/v1/render/latest/zhCN/512x/<ID>.png`）；对照图
  `cmp_official_vs_ours_TLC_433_top.png`（上=官方，下=我们）。
- 反编译 `ActorNames.GetSignatureActor`（反编译 `ActorNames.cs:905-943`）：异画按
  `SIGNATURE_FRAME` 表的 frame id 取**专属手牌 prefab**（`SignatureHand`），与卡型无关。
- 本地 DBF（`dbf.unity3d` 的 `SIGNATURE_FRAME`/`SIGNATURE_CARD` 两张表，MonoBehaviour）实测映射：

  | 卡 | frame id | 手牌 prefab |
  |---|---|---|
  | TLC_433 | 10 | `Card_Hand_Ability_Signature_Evergreen.prefab` |
  | SC_004 | 11 | `Card_Hand_Hero_Signature_Evergreen.prefab` |
  | TLC_EVENT_402 | 12 | `Card_Hand_Weapon_Signature_Evergreen.prefab` |
  | RLK_706 / WW_373 / GDB_477 | 1 / 2 / 9 | `Card_Hand_Ally_Signature_25 / 26 / Evergreen.prefab` |
  | CATA_190h | 14 | `Card_Hand_Hero_Signature_Deathwing.prefab` |

- 探针 `Card_Hand_Ability_Signature_Evergreen.prefab` 结构（`probe_material_shader.py` 同款遍历）：
  `RootObject/Mesh` = **3 submesh**（签名图集 `Genfx_Inhand_Signature_Evergreen_Atlas_Mat[Uber/UberCardBack]`
  + 卡背 + `Card_Signature_Evergreen_ClassColor_Mat[Custom/Card/UnlitDualClassTextureTint]`）；
  卡图是**独立节点** `RootObject/Portrait_Mesh[Custom/Card/Unlit_Portrait]`；另有
  `TextGradient[SignatureCardGradientOverlay, Hero/Multiply/Multiply]`、`NameBanner_Mesh/Divider`、
  签名版稀有度宝石（`Signature_Evergreen_Rarity_Gem_Mat` + `Hero/Multiply/Multiply_AlphaFade` 底影）等。

**结论**：异画卡在游戏里确实有专属帧族（上面的事实成立），当前 `plan.ts` 只按 `TAG_CARDTYPE` 选帧
（`CARD_TYPE_TO_SLOT`），premium 完全没进渲染口径。

**重要更正**：`TLC_433` 这次报的「没渲染卡图」**不是**这个原因——真根因是 §5b 的乘法阴影写深度。
修掉写深度后，用普通帧渲染的 TLC_433 与官方图在画窗区域已经吻合（对照图
`cmp_official_vs_ours_TLC_433_top2.png`）。异画帧族是否还要单独实现，取决于后续 premium 口径需求
（官方 art API 出的图也看不出签名帧的差异），本次按用户决定**暂不实现、只留记录**。

**实现路径（待排期；路线图 Phase 4 signature 项）**：

1. `scripts/extract_pivot_data.py` 增补 `SIGNATURE_FRAME`/`SIGNATURE_CARD` → pivot JSON 带
   `signature_frame_id` 与 `signature_hand_prefab`；
2. 抽取签名手牌 prefab（slot 建议 `hand-spell-sig10` 一类）；起步脚本：
   `explore/2026-10-03-five-cardtypes/scripts/extract_signature_probe.py`（复用 `extract_frame.py` 机制，
   演员引用换成 DBF 给的签名 prefab）；
3. `main.ts`/`plan.ts` 按 `preset.premium === 'SIGNATURE'` 选帧族；
4. 新 shader 需要落数学：`Uber/UberCardBack`（签名框图集 + 卡背）、`Custom/Card/UnlitDualClassTextureTint`
   （类色）、`Hero/Unlit/Unlit_TransparentColor`（分隔线）、`Hero/Multiply/Multiply_AlphaFade`（宝石底影）；
   卡图 `Custom/Card/Unlit_Portrait` 与 `Hero/Multiply/*` 本仓已有；
5. 排序特例（导出器笔记《异画名称框排查记录》）：`Transluscent_Mesh`
   (sortingOrder=0, queue=2999) 与 `PortraitFrame_Mesh`(sortingOrder=1, queue=2000) 的官方排序是
   **先 sortingOrder 再 renderQueue**，直接按 queue 排会盖错名称框两端。

---

## 验证记录

- **L1**：`bun run render` vs py 黄金 `explore/hs-render/lab/2026-10-01-dragon-zorder/output/render_dbf9_zfix.png`
  → `mae 0 / maxAbs 1 / px>1 = 0`（各轮修复前后同值）。
- **30 张 pivot 回归（分三轮测）**：类色表 + 学派板一轮 → 仅 REV_365/LOOT_392/AV_205/TTN_090 变化；
  肖像槽位 + 学派名一轮 → 再叠加 11 张（全部是法术/英雄/武器帧，即 portraitMatIdx=1 的卡型）；
  攻血口径一轮 → 仅 AV_205/CATA_190h/SC_004（英雄）+ DMF_709（无攻随从）变化；
  乘法混合一轮 → 仅 TLC_433/ETC_210（精英银龙影）变化；乘法阴影「不写深度」一轮 → 同样只再动这两张
  （画窗上缘卡图恢复），其余逐像素 0 差异。
- **对照官方导出图**（Blizzard 自家渲染，`art.hearthstonejson.com/v1/render/latest/zhCN/512x/`）：
  LOOT_392 武器金属环/尖刺、REV_365 学派板（自然）、AV_205 英雄框、DMF_709 随从、TTN_090 地标
  逐张目视一致；差异集中在官方图缩放导致的边缘软硬差。
- **附加**：TTN_090 人造无宝石变体（RARITY=FREE）验证 `No_Gem_Mesh` 不透支；typecheck + lint 通过。
- 攻血对照：AV_205 官方图左下为空（英雄 ATK=0）、DMF_709 官方图攻击宝石为 "0"，修复后一致；
  人造 AV_205(ATK=3) 变体验证英雄有攻时宝石 + 数字正常显示。
- 修复图：`explore/2026-10-03-five-cardtypes/output/{REV_365_fixed3,LOOT_392_fixed2,TTN_090_fixed}.png`
  与官方对照 `cmp_official_*.png`、攻血对照 `cmp_attack_*.png`、银龙影对照 `cmp_dragon_*.png`。

## 待办 / 已知边界

- **异画帧族（§6）**：事实成立但目前**不影响已发现的问题**（§5b 修完后 TLC_433 已与官方图吻合）；
  7 张异画 pivot 仍走普通帧、premium 未进渲染口径。若后续要 premium 口径（签名框的半透明观感），
  实现路径与 DBF 映射见 §6，起步脚本 `explore/2026-10-03-five-cardtypes/scripts/extract_signature_probe.py`。

- 学派板的 `m_spellDescriptionMeshNeutral` 分支未显式实现：手牌法术预制的序列化网格本就是中性网格，
  等价成立；若未来出现别的 actor 预描写法需要回填。
- 名单里 `Rune_*`/`Multiclass_Ribbon` 等在手牌帧处于失活子树，本次未见渲染变化；play zone / 战棋帧
  落地后需要重测其 opaque 口径。
- 乘法阴影的**柔和度**未与官方逐像素校：TLC_433 官方图渲染的是异画帧（见 §6），只能确认卡角恢复、
  阴影按乘法压暗。TLC_433 的剩余差异（画窗区域）根因是异画帧族未实现，**不是**阴影或画本身的问题。
- `m_portraitFrameMatIdx` 与卡面材质同名判定（`plan.ts` 的 `pfName === cardFrontMatName`）沿用旧逻辑：
  武器/法术命中、英雄把类色图集写进了肖像槽又被肖像贴图覆盖（无害但不精确）；后续按
  `SetMaterialWithTexture`（Actor.cs:6662-6720）的 DK-武器特例逐帧复核。
