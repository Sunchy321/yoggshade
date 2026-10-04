# 英雄技能帧渲染落地与文字管线两笔通用修复（2026-10-03）

范围：`TAG_CARDTYPE.HERO_POWER`(10) 的专属手牌帧（`History_HeroPower`）从「回落随从帧」升级为
专属帧，附带两笔**通用**文字管线修复（`\n` 硬换行、逐 locale `m_PositionOffset`）。
全部结论带游戏反编译 / 资产探针 / 像素实证，逐条出处见下；代码内留有同源注释
（`packages/renderer/src/{plan,render,textlayout,ubertext}.ts`、`scripts/extract_frame.py`）。

---

## 0. 结果速览

| 项 | 结果 |
|---|---|
| 新帧 slot | `hand-heropower`（资产包 `assets/frames/hand-heropower/`，actor=`History_HeroPower.prefab`） |
| 卡型映射 | `CARD_TYPE_TO_SLOT[10] = 'hand-heropower'`（`plan.ts`） |
| 30 张 fixture 回归 | **只有 AV_205p 变化**（原走回落随从帧），其余 29 张逐像素 0 差异 |
| L1（py 链，**非基准**，仅离线冒烟） | 帧与文字修复段 `mae 0 / maxAbs 1 / px>1 = 0`；§7 描边口径修正后 `mae 0.322`（差异只在数字描边，属预期分歧，见 §6.7） |
| 基准层级（用户口径，2026-10-03） | **官方图 > exporter 导出图**；目前以 exporter 导出图为现行基准，官方图待以后专门对齐 |
| vs 游戏内参照 · 同卡（HERO_05bp 本尊） | **帧体区（去文字/去肖像）MAE 0.227 / MSE 0.410 / px>64 = 0**（像素级命中） |
| vs 游戏内参照 · 异卡（AV_205p） | 内容外框 x[68,441] y[63,620] **逐位相同**；帧体区 mae 3.5（左金边 0.85 / 右金边 1.14） |
| 名字毛刺（用户复核，§7） | 两笔修复：字形缓存补齐（`scripts/extract_glyph_cache.py`）+ 直绘描边半径改字体 px 口径；同卡名字区 MAE 13.7 → 11.8、费用数字 MSE 241 → 159（武器帧第二参照 194 → 76） |

---

## 1. actor 选择：HERO_POWER 走的是 History_HeroPower，不是法术帧

**反编译**（exporter ilspy 缓存 `Assembly-Csharp/ActorNames.cs:546-569`，本仓引其离线等价
`data/actor_names.csv`）：

```
case TAG_CARDTYPE.HERO_POWER:
    return GetNameWithPremiumType(ACTOR_ASSET.HISTORY_HERO_POWER, premiumType, cardId);   // :555-556
```

`ACTOR_ASSET.HISTORY_HERO_POWER = "History_HeroPower.prefab:e73edf8ccea2b11429093f7a448eef53"`
（`ActorNames.cs:139-141`）；premium 变体为 `History_HeroPower_Premium.prefab:081da807…`（:263-265）。

两个容易走错的邻居：

- `Card_Hand_Ability` 是 **SPELL(5)** 的 actor（`ActorNames.cs:550-553`），英雄技能**不是**它；
- `Card_Play_HeroPower.prefab` 是对局区（`ZoneHeroPower`）的 actor，只有 `GetPlayActorByTags`
  的 `PLAY_HERO_POWER` 分支才走那条（exporter `docs/decompile-notes.md`「英雄技能显示链路相关事实」）。
  历史面板 / 悬浮大卡与手牌 actor 同源（`ActorNames.GetHistoryActor` 的 HERO_POWER 分支）。

**落地**：`data/actor_names.csv` 增 `normal,HAND_HERO_POWER,History_HeroPower.prefab,e73edf8c…`；
`scripts/extract_frame.py` 的 `SLOT_TO_ACTOR_KEY` 增 `hand-heropower`。

## 2. 帧结构（探针实证，`assets/frames/hand-heropower/prefab_report.json`）

- **渲染面只有三处**：`RootObject/Mesh`（`HeroPowerV2`，3 子网格：框 367 tri / 肖像圆窗 6 tri /
  `HeroClass` 垫板 187 tri）、`RootObject/Mesh/FrameMesh`（`History_HeroPower` 材质，92 tri = 名字横幅
  + 描述板 + 底带，**不在** `Description_mesh` 上）、`RootObject/Gem_Mana`（`ManaGem` 24 tri）。
  Angelia 帧首验（`Angelia/lab/2026-10-02-heropower-frame/findings/heropower-frame.md`）同结论。
- **写点标量**：`m_portraitMatIdx = 1`（肖像子网格 = sub1）、`m_cardFrontMatIdx = -1`、
  `m_portraitFrameMatIdx = -1`、`m_cardMesh` 未绑定。
- **附件层整个不存在**（不是隐藏）：无 `RarityGem/RarityGemFrame`、`Gem_Attack/Gem_Health`、
  `RacePlate`、`Unique_*`（精英龙）、`RuneBanner`、`MulticlassRibbon`。RARITY=FREE 与结构互证。
- **唯一无类色写点的手牌帧**：`Actor.SetMaterialNormal`（`Actor.cs:6709-6725`）的
  `HERO_POWER/GAME_MODE_BUTTON/PET` 分支直接 `break`，不调 `SetMaterialWithTexture` →
  帧保持 prefab 序列化材质，无 CardColorSwitcher 写点。本仓 `textureFamily(10)` 返回 `''` 即此语义
  （不写类色图集）；九职业英雄技能参照框色逐位相同（Angelia 实证 (71,74,115)）为其证。
- **序列化材质反证「无类色」**：`Card_HeroPower_HeroClass` 的 `_MainTex` 是 `Hero_Power_D`
  （与肖像 `_SecondTex` 同族），不是职业图集；三张帧纹理 alpha 全 = 1（`Hero_Power_Frame`、
  `History_HeroPower`、`Hero_Power_D` 实测 `frac<1 = 0`）→ 本帧**不触发** opaque-edge 修复名单
  （`Card_Location_*`/`Rune_*` 那套），alpha-over 与不透明绘制等价。
- 静态失活/默认隐藏：`EvolutionVFX` 子树序列化失活（活动性已兜底）、`CardStateMgr/Highlight/Highlight_Card_Plane`
  与 `GhostCard/FX_Ghost_Quad` 走 `STATIC_HIDDEN`（同随从帧口径）。

## 3. 代码改动

1. `data/actor_names.csv` + `scripts/extract_frame.py`：新帧 actor 行 / slot（§1）。
2. `plan.ts`：`CARD_TYPE_TO_SLOT[10]`、`SLOT_NATIVE_CARD_TYPES['hand-heropower'] = [10]`、
   `FRAME_RULES['hand-heropower']`（elite/rarity 空、roles = `cost/name/desc`，无攻血甲/种族）。
3. `render.ts` `renderPortraitLayer`：**肖像取件节点改为 m_portraitMesh 节点本身**，不再按
   `path.endsWith('PortraitFrame_mesh')` 找。英雄技能帧的肖像节点就叫 `Mesh`
   （`m_portraitMesh → RootObject/Mesh`），按名字找会取不到槽 → 肖像整个不画。随从/法术/英雄/武器/地标
   帧该节点恰好都叫 `PortraitFrame_mesh`，所以此前没暴露。

## 4. 文字管线两笔通用修复（非英雄技能专属）

1. **`\n` 硬换行**（`textlayout.ts`）：`UberTextRendering.SetText` 把字符串直赋
   `m_textMesh.text`（`explore/ilspy/UberText.Runtime.full.cs:6397`），Unity TextMesh 原生把 `\n`
   当**硬换行**——word wrap 只在硬行内生效、空段占一个空行槽。此前整串丢给 `wrapLines`，`\n`
   既不断行又被算进 advance。英雄技能描述首证触发（多数英雄技能 DBF 文本形如
   `<b>英雄技能</b>\n…`）。实现：先按 `\n` 切段，再对每段做原有 word wrap，并同步维护逐字符 bold 表。
2. **逐 locale `m_PositionOffset`**（`ubertext.ts`）：`SetupTextMeshAlignment`
   （`UberText.Runtime.full.cs:1936-1937`）在设置文本 GO 局部位置后
   `SetTextMeshGameObjectLocalPositionOffset(UberTextLocalization.GetPositionOffset(...))`，
   偏移是**文本节点局部空间**的量（`GetTextCenter()` 非 widget 恒 0，:2534-2542）。
   英雄技能 `PowersUberText` 的 zhCN(9) 条目 `(0,-0.05,0)`（`prefab_ubertext.json` 的
   `m_LocalizedSettings` 实测），经节点 0.8 缩放 / -90°X 旋转 → 世界 z −0.04 = **7.1px 下移**。
   实现：在 `loadNodeSettingsAlly` 里把该局部量经节点世界矩阵变换后加到 `worldPos`。

**回归面**：两笔都是按反编译语义的通用修复；ally/spell/weapon/hero/location 帧 zhCN 的
`m_LocaleAdjustments` 为空、文本无 `\n` → 数学上恒等。实测 30 张 fixture 中 29 张逐像素 0 差异、
L1 黄金 mae 0 变化为零。

**端到端验证**：§5 的同卡对照（HERO_05bp，其 DBF 描述正是 `<b>英雄技能</b>\n…` 且 zhCN 有
`m_PositionOffset`）同时覆盖这两笔——硬换行后「英雄技能」独立成行、整块按 (0,-0.05,0) 下移，
行带与引擎快照 ±1px。

## 5. 验证记录

- **L1**：`bun run render` vs `explore/hs-render/lab/2026-10-01-dragon-zorder/output/render_dbf9_zfix.png`
  → 帧与文字修复段为 `mae 0 / maxAbs 1 / px>1 = 0`；**§7 的描边单位修复后变为
  `mae 0.322 / px>4 = 4090`，差异全部落在数字（费/攻/血）描边上**（见 §7 第 3 条：
  py 链与本仓旧口径同源，属「参照不是同步目标」的口径分歧，需用户裁决）。
- **30 张 fixture 回归**：修复前快照 `explore/2026-10-03-heropower/output/pivots_before/`，
  修复后逐张比较 → 仅 `AV_205p` 变化（189,345 px），其余 29 张 `maxdiff = 0`。
- **vs 游戏内参照**（Angelia 引擎快照，dbf 229 稳固射击；同帧不同卡，帧体应逐位一致）：
  非空内容外框 ref `x[68,441] y[63,620]` vs ours `x[68,441] y[63,620]`（逐位相同，且逐行占用零分歧）。
  分区（排除肖像圆窗 / 名字 / 描述文字）：左金边 mae 0.85、右金边 1.14、圆窗环带（圆心出发
  半径 88–108、每 45° 采样）逐点差 0–3 —— 唯一例外是正上方（90°，被费用数字与宝石覆盖，
  差 83/113 vs 30，属字形边缘 + gem 相位）。
- **描述块定位**：ours 三行行带 y `[430,457][463,491][498,525]`；Angelia 链在同帧验证过的行带
  为 `[429,458][464,491][498,525]`（±1px，同字形微结构域）。行块中心 477.5 ≈ 期望值
  （带 locale 偏移 477.9 / 不带 470.9）→ 偏移量按反编译值生效。
- **费用数字**：ours bbox `x[235,290] y[79,131]` vs ref `x[237,290] y[79,130]`（±2px，与武器
  攻/耐久数字同型残差）。
- **同卡对照**（最强口径；脚本 `explore/2026-10-03-heropower/scripts/build_probe_pivot.py`）：
  参照图是引擎快照 dbf 229 = `HERO_05bp`，本仓 fixture 集里没有这张卡，故临时造 fixture JSON + 原画
  （脚本调 DBF 取 name/text/InHand/tags + 复用 `scripts/extract_fixture_assets.py` 取原画；
  文本里的 `@` 备用文本与 `$2` 伤害令牌按实验预处理展开——二者属 Phase 2 文字重建范围，
  只为让帧对照不被未实现令牌干扰，AV_205p 本身无令牌）。落图
  `output/{HERO_05bp.json,HERO_05bp_ours.png}`，逐区统计（参照图左下角 `REF HERO_05bp`
  水印与参照图 alpha=0 的 RGB 垃圾块（Angelia findings §7：`x[326,511] y[549,607]`）已排除）：

  | 区域 | n | MAE | MSE | px>16 | px>64 |
  |---|---|---|---|---|---|
  | 帧体区（去文字 / 去肖像圆窗） | 246,138 | **0.227** | **0.410** | 2 | **0** |
  | 帧体区（去文字，含肖像 rim） | 276,084 | 0.489 | 4.341 | 1,702 | 36 |
  | 肖像圆窗内 | 39,415 | 3.002 | 77.47 | 2,436 | 201 |
  | 文字区（费用数字/名字/描述） | 69,466 | 10.99 | 1,023.7 | 10,271 | 5,395 |

  解读：**帧几何与材质逐像素命中**（其余差 = 文字字形微结构 + 肖像艺术边缘 AA，
  即既有「未决 8」与肖像双线性/mip 域）。Angelia 同链报告「net 口径 MSE 3.5 / MAE 0.49」
  与本表「去文字（含 rim）」的 MSE 4.34 / MAE 0.489 同档（掩码口径不同）。
  差异图 `output/diff_HERO_05bp_samecard.png`、并排 `output/cmp_HERO_05bp_samecard.png`。
- **对照官方导出图**（Blizzard 自家渲染 `art.hearthstonejson.com/v1/render/latest/zhCN/512x/AV_205p.png`）：
  按内容外框对齐（官方图内容 = 本仓 ×1.176）后，圆窗/金环/宝石/名字横幅逐项一致；
  修复图 `explore/2026-10-03-heropower/output/cmp_official_vs_ours_AV_205p.png`、
  对齐放大 `zoom_window_official_vs_ours.png`。

## 6. 已知边界与残差（含两条跨仓差异，非本帧缺陷）

1. **AV_205p 的描述文本没有「英雄技能」前缀 —— 数据如此，不是渲染缺失**。
   本机 DBF（`dbf.unity3d` 的 `CARD.m_textInHand`）逐 locale 实测：AV_205p 全部 14 个 locale
   都**没有**前缀（zhCN=「<b>抉择：</b>抽一张牌；…」），而同表其它英雄技能都有
   （`HERO_02bp`「<b>英雄技能</b>\n随机召唤一个基础图腾。」、`HERO_01bp`/`HERO_05bp`/`HERO_08bp` 同）。
   游戏文本链路无任何按卡型加前缀的代码：`Actor.GetPowersText`（`Actor.cs:4266-4320`）→
   `EntityDef.GetCardTextInHand` → `CardTextBuilder.BuildCardTextInHand`
   （`CardTextBuilder.cs:102-105`）= `TextUtils.TransformCardText(cardRecord.TextInHand)`，
   47 个 builder 里没有 HERO_POWER 特例。**故官方 art API 图上的那一行是数据版本差异
   （其卡数据快照里该卡带前缀），本仓对齐的是本机游戏版本的数据。**
   残留影响：与官方图的描述区不可逐像素比（行数就不同：4 行 vs 3 行）。
2. **exporter 导出构图与本仓不同源**：exporter 的 `FrameCamera` 对英雄技能按 `FrameMesh` bounds
   居中（`bepinex/plugin/ExporterController.cs:11025-11050`，其修复理由「英雄技能导出高度偏低」，
   见 `docs/decompile-notes.md` 2026-04-21 节）。实测本帧世界包围盒：
   `Mesh` 中心 (−0.0035, 0.7777)（≈ 原点，故随从帧两种构图等价，这正是 L1 能与 exporter 逐位对齐的原因），
   `FrameMesh` 中心 (−0.0071, **−0.1035**) → exporter 的取景窗比本仓（原点居中）**低 0.1035 世界单位**
   （≈ 18.3px 本仓密度 / 19.9px exporter 密度；取景窗下移 ⇒ 卡面内容在 exporter 图里偏**上**同值）。
   注：Mesh∪FrameMesh 的联合包围盒 z −1.514..+1.521 中心 ≈ **+0.003 ≈ 原点**——整卡视觉是原点居中的
   （与游戏内快照一致），exporter 只锚 FrameMesh 所以多出这半段偏移。
   随从帧不踩这坑：`Card_Hand_Ally` 层级里**没有叫 FrameMesh 的节点**（主体就叫 Mesh，中心 ≈ 原点），
   exporter 的 FrameMesh 分支落空回退主 Mesh，故随从的 exporter 图与本仓取景一致。
   **exporter 导出图现为现行基准（用户口径，2026-10-03），故本项直接决定 L2 能否逐像素比**：
   exporter 出图是 512×768、orthoSize=2（192 px/单位），本仓是 512×707（176.75 px/单位）——
   同世界取景、不同像素密度，且居中规则多一处 FrameMesh 偏移。两条路（待定夺）：
   (a) 比对时按内容外框做已知缩放/平移对齐（本仓出图口径不动，容差比对）；
   (b) 增加一个「exporter 口径」出图模式（512×768 + 同居中规则）使其可逐像素比。
3. **肖像 rim 的 Repeat wrap 未实现（可见差 ≈ 0）**：本帧圆窗 `uv0` 越界 `u[-0.075,1.075]`
   （`portrait.json` 实测），游戏侧纹理 `wrapU/V=0=Repeat`；本仓按 clamp 采样。实测圆窗半径
   88–108 的八方向采样点 ours vs 游戏内参照逐点差 0–3 —— 该 rim 被金环覆盖，与 Angelia
   的量化结论（clamp 86.9 vs Repeat 86.9）一致，登记为序列化真值未实现项。
4. **字形微结构与 gem 云相位**：费用数字边缘、名字字形（ResizeToFit 域）残差属既有「未决 8」
   与 gem 相位平台（t=0.07），非本帧引入。
5. **名字平面 fallback**：本帧 `NameUberText.m_RenderOnObject` 为空（提取日志实测），引擎走
   `SetupRenderOnPlane`（`UberText.Runtime.full.cs:2265-2277`），本仓以「轴对齐平面直绘」近似
   ——与武器帧同型先例，登记残差。
6. **`_LightingBlend` 归一**：exporter 对普通英雄技能 actor 在 `Show()` 后调 `Actor.SetUnlit()`
   （`_LightingBlend = 0`，`docs/tavern-tier-lighting-decompile.md` 2026-04-21/22 两节），
   本仓无光照模型（离线链按 unlit 采样），语义一致、无需动作。
7. **描边半径口径（已定，2026-10-03 用户拍板）**：保留字体 px 口径，**不追 py 链**。
   基准层级（用户明确）：**官方图 > exporter 导出图**；py 链只是旧参考实现、**不作为基准**。
   因此 §7 第 2 条的 L1 `mae 0.322`（差异只在数字描边）是**预期分歧**：
   `explore/hs-render/.../uber_text.py:668` 仍是旧口径（`outline["r"] * ss`），本仓按反编译
   `UpdateOutlineProperties` 改成字体 texel 口径后与 py 自然分叉，且与两个独立游戏内参照一致。
   L1 自此降级为「非基准的离线一致性冒烟」：数字描边处有已知固定差签名，不再当零容忍门。
8. ~~**字形缓存历史脏值**~~ **已清（2026-10-03）**：`Belwe_Outline-45` 的 `1 < > b /` 五个 ASCII
   条目 `advance=45`（CJK 全宽）与其 mask 不符（按 hmtx 应为 24/29/29/27/24），
   现由 `scripts/extract_glyph_cache.py --fix-stale` 改写（mask 逐字节校验一致才改）；
   改写前后 30 张 fixture **逐像素零变化**（该路径当前无文本可达），
   之后 `--verify-all` = **467 复算一致 / 0 不一致**（缓存与 py 链光栅化全量等价的自证）。
9. **未验**：`Card_Play_HeroPower`（对局区）/`History_HeroPower_Opponent`（敌方）/premium
   变体帧；战棋模板下的英雄技能（`ActorTemplateMode.Battlegrounds`，exporter 另有
   actor root 光照与 glow 特调）；`History_HeroPower_SpellTable.prefab`（技能详情附表）。

## 7. 名字毛刺的二次修复（用户复核：随从名字的同类伪影）

**现象（用户报告）**：英雄技能帧的名字出现「和之前随从名字一样的毛刺」——笔画边缘锯齿、
白色笔画被啃、描边呈毛刺状（对照见 `output/zoom_av205p_name_official_vs_ours.png`、
`zoom_name_8x_ref_vs_unitfix.png`、`name_quality_4way.png`）。

**两个独立根因（A/B 与逐区实测）**：

1. **字形缓存未命中 → TS 无 hinting 兜底光栅**。
   资产包 `glyphs/{font}-{fs}/` 此前只覆盖 L1 基准卡的文字（`Belwe_Outline-45` 55 字、
   `FranklinGothic-40` 28 字、`Belwe_Outline-74` 1 字），fixture 集里**几乎每张卡的名字/描述字符都缺**
   （实测：GDB_142「无界空宇」0 缺 → 平滑；TTN_090「尤格-萨隆的监狱」7 缺 → 锯齿；
   AV_205p「培育」2 缺 → 锯齿），且**地标帧名字的 fs=36 目录整个不存在**（zhCN locale
   FontSizeModifier=0.8）→ 该帧全部字形走兜底。
   **修复**：新增长期工具 `scripts/extract_glyph_cache.py`（uv + PEP 723），按「本仓渲染计划真正会画的
   字符」补齐缓存：fixture 集各卡的 name/textInHand（去标签）+ 种族/学派文本 + 数字角色用的
   `0-9 -`，字体/字号逐帧取自 `manifest.role_paths` + `prefab_ubertext.json`
   （fs = trunc(fontdef.m_FontSizeModifier × locale9.m_FontSizeModifier × m_FontSize)；
   实测需要四组：`Belwe_Outline-45`（名字/种族）、`-74`（费/攻/血/护甲）、
   `-36`（地标名字）、`FranklinGothic-40`（描述））。栅格化语义与 py 链
   `uber_text.FontMetrics` 同构（getmask2 / bitmap_left / bitmap_top / hmtx advance）。
   **等价性自证**：`--verify-all` 复算资产包内**全部**既有字形并与盘上字节比对 → 450 一致 / 5 不一致；
   5 处仅 `advance` 字段不符（`/ 1 < > b` 五个 ASCII 字形盘上是 45 = CJK 全宽，本脚本按 hmtx 算
   24/29/29/27，像素 mask 逐位相同）——盘上这 5 条是历史遗留脏值，当前任何 fixture 文本都不走它们
   （名字/种族无 ASCII；`\`<b>\`` 标签在排版前已被剥离），本脚本不改写既有条目，登记待清。
   共新增 371 + 3(同卡对照卡) + 9(武器对照卡) 字形。
2. **直绘路径的描边半径单位错**：`m_OutlineSize` 的单位按反编译是**字体/图集 texel**
   （`UberText.UpdateOutlineProperties` 2065-2068：`vector = TexelSize(GetFontTexture())`，
   `SetOutlineOffset(vector * num)`，`num = m_OutlineSize × m_OutlineModifier × localeMod`；
   即偏移在图集 texel 空间），而直绘路径沿用了 py 链的「画布 texel × 超采样」口径
   （`r × ss`）→ 描边比引擎厚 1.4× 左右（英雄技能名字 4.5 → 等效 6.4 字体 px）。
   RTT 路径（有载体网格的名字）走的是画布口径换算 `r × rtW × rtSs / meshCanvasW`，
   与正确值只差 ~6%，且被 L1 冻结，本次**未动**。
   **修复**：直绘路径改为 `radiusOut = outline.r × kPx`（= r 个字体 px）。

**实测（同卡对照卡 HERO_05bp，vs 引擎快照；名字区 y[300,370] x[135,375]）**：

| 版本 | 名字区 MAE | 名字区 MSE | 费用数字 MAE | 费用数字 MSE |
|---|---|---|---|---|
| 旧（缓存缺 + 画布描边） | 13.725 | 1,621.96 | 4.823 | 240.98 |
| 补缓存 + 字体 px 描边 | **11.795** | **1,393.14** | **4.117** | **159.09** |

独立第二参照（武器帧 dbf 1662 鹰角弓，`Angelia/lab/2026-10-01-weapon-frame/evidence/render_1662_side.png`
第 1 面板 = 引擎快照）：费用数字 MAE 3.014 → **2.191**、MSE 193.9 → **75.6**（名字区打平
8.20 vs 8.24；描述 `m_Outline=0` 不受影响，两版逐位相同）。两个独立引擎参照都指向「字体 px」口径。

**回归面**：
- 只补缓存（未动描边口径）时：L1 `mae 0 / maxAbs 1 / px>1 = 0` 不变；30 张 fixture 全部变化但
  **差异全部落在文字区**（名字/描述/数字），帧体零变化。
- 叠加描边口径修复后：**L1 变为 `mae 0.322 / px>4 = 4090`，差异只在费/攻/血/杜拉数字的描边上**
  （分块实测：cost 650px、attack 270px、health 340px、名字 0px）。py 链用的是旧口径，
  故这是「参照不是同步目标」的分歧——**属需要用户裁决的口径分歧**（见 §6 待决项）。

**残留（本案未解，与 Angelia「未决 8」同域）**：补缓存 + 换口径后，英雄技能名字仍比引擎快照
「毛」一些：白色笔画更细、描边外缘发毛。逐项排除：`m_OutlineModifier=1.0`（fontdef 实测）、
`m_BoldSize` 未启用（`CreateTextMesh` 只在 `m_RichText && m_Text.Contains("<b>")` 时 `Bold()`；
名字文本无 `<b>`）、`m_CharacterSize` 未走 ResizeToFit 收缩（cs=0.05、k=0.005 干净）、
描述 `m_Outline=0` 与本案无关。剩余差异归因于「字形位图在 fs=45 光栅后缩放到 ~32px 显示」
（引擎按显示尺寸光栅动态图集）这一既有架构差异。参考图与产物：
`output/zoom_name_8x_ref_vs_unitfix.png`、`output/zoom_outline_ab.png`。

## 关联

- Angelia 帧首验（帧型结构、剔除表、两笔文字增量）：`Angelia/lab/2026-10-02-heropower-frame/`
- exporter 反编译笔记：`../exporter/docs/decompile-notes.md`（英雄技能显示链路）、
  `../exporter/docs/tavern-tier-lighting-decompile.md`（英雄技能光照归一）
- 上一条同链修复记录：`docs/findings/five-cardtypes-frame-parity-2026-10-03.md`
