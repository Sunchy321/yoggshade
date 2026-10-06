# findings — UberText 文本渲染深入调查：对齐与特殊样式（粗体/斜体）

日期：2026-10-06。上游：Angelia `lab/2026-09-30-text-pipeline`（布局规格两棒）、
`lab/2026-10-02-font-pipeline`（图集直采）、`hearthstone-text-formatting.md`（文本 resolve 链）。
本调查目标：与基准图文字完美对齐 + 正确渲染粗体/斜体。

缩写：**UB** = `explore/ilspy/UberText.Runtime.full.cs`（Blizzard.T5.UberText.Runtime 反编译，
6735 行）；**SH** = `exporter/tmp/shader/Hidden_*.metal`（游戏 shader Metal 反汇编）。

---

## 0. 一句话结论

布局链（字号/排布/换行/垂直锚定/弧形/描边）已与引擎对齐——L2 实证 7 张卡 desc 换行断点
逐字一致、文本块位置吻合。当前文字残差的**主因是两个特殊样式缺口**：

1. **粗体 = TS 侧无操作**：`glyphOutlineShader` 收了 `boldPx` 参数但函数体从未使用
   （packages/renderer/src/glyph.ts:63-112）——28 张含 `<b>` 的 zhCN 卡关键词未加粗；
2. **斜体 = 被 `splitRich` 剥除**（textlayout.ts:59-64 把 `<i>` 当普通 tag 丢掉）——
   7 张含 `<i>` 的 zhCN 卡整行字形错误（应为剪切斜体）。

次因：fixture zhCN 文本里的 `@`/`{0}` 占位符未走 resolve 链，而基准图是游戏内已解析文本
（BG30_802 基准图实拍「还剩**2**次！」vs fixture 原文「还剩@次！」）。

---

## 1. 主流程与对齐语义（反编译事实，已全部核对）

**RenderText**（UB:1752-1804）顺序：
`SetWorldWidthAndHeight → CreateTextMesh → UpdateTextPosition → SetFont → SetFontSize
→ SetLineSpacing → SetupTextMeshAlignment① → SetLocale → SetupTextAndCharacterSize
→ SetupTextMeshAlignment② → UpdateOutlineProperties → UpdateTexelSize → UpdateLayers
→ UpdateRenderQueue → UpdateColor → SetBoldEnabled/SetOutlineEnabled → ApplyMaterials
→ [RTT: SetupRenderToTexture + DoRenderToTexture + ApplyAntialiasing]`

**对齐**（SetupTextMeshAlignment UB:1931-1991）：

- `SetTextMeshGameObjectLocalPosition(GetTextCenter())` 先重置（非 widget 恒 0，UB:2534-2542）；
- `localPosition += locale m_PositionOffset`——**加法语义**（UB:6488-6491 `+= offset`）；
- 再按 Alignment×Anchor 加几何偏移 ±(w/2, h/2)（widget 时 z/y 轴互换，UB:1993-2000）；
  Center/Middle 无几何偏移 → 四区全部 MiddleCenter = 节点原点即文本框中心；
- 每次调用先重置再加，RenderText 调两次（UB:1769/1772）无累积效应。

**字号/charSize/resize-to-fit**：与 Angelia 规格（text-pipeline-spec.md §2a）一致，另在
反编译里直接实证了 resizeToFit 高度判据的来历——`Measure_IntraLine_Height()`（UB:2389-2398）
= bounds("|\\n|") − 2×bounds("|") = pitch − LH，`y -= 该值`（UB:2417）后即
**(n−2)×pitch + 2×LH**；每轮 charSize×0.95、上限 40 轮、下限 m_MinCharacterSize×0.01
（UB:2427-2444），**仅缩 charSize 不缩字号**；行数==1 时逐轮 SetLineSpacing(0)（UB:2450-2457），
收尾恢复（UB:2462）。ResizeTextToFit 在测量期间把 TextMesh 摘出父节点、scale=1、rotation=identity
（UB:2303-2306）——世界轴对齐测量。

**RTT**：SetupMatrices（UB:5915-5940）正交视口恰好框住 (m_Width,m_Height)；CalcTextureSize
（UB:2825-2846）= m_Resolution 按宽高比分配，**GraphicsQuality.Low 时 ×0.75**（离线链按高画质，
不缩）。

---

## 2. 粗体（全链闭合：标记 → submesh → shader）

### 2.1 标记处理

- ProcessText（UB:2613-2647）：m_RichText 时给文本加前缀 `<material=1></material>`，
  遇 `<b>`（且非空标签 `<b></b>`，UB:2632 条件排除）→ Bold() 一次 + 把**全串**
  `<b>`→`<material=1>`、`</b>`→`</material>`。即粗体 = Unity TextMesh 富文本
  `<material=1>` submesh 切换，**非字体字重**。
- Bold()（UB:2687-2699）：m_HasBoldText 置位（一次），m_BoldSize 上限 10，
  `SetBoldOffset(TexelSize(fontTexture) × m_BoldSize)`。
- UpdateOutlineProperties（UB:2672-2685）：描边节点另设
  `SetOutlineBoldOffset(texel × (outlineSize + m_BoldSize×0.75))`。

### 2.2 材质与 shader（Metal 反汇编 SH）

ApplyMaterials（UB:6324-6349）：submesh0 = TEXT（`Hero/Text_Unlit`）或 OUTLINE
（`Hidden/TextOutline_Unlit`）；submesh1 = BOLD（`Hidden/Text_Bold`）或 OUTLINE_BOLD
（`Hidden/TextBoldOutline_Unlit`）。偏移写入点：SetBoldOffset 同时写 BOLD 与 OUTLINE_BOLD
两查询的 `_BoldOffsetX/Y`（UB:6589-6595）；SetOutlineBoldOffset 只写 OUTLINE_BOLD 的
`_OutlineOffsetX/Y`（UB:6597-6601）。

| shader | tap 集（VS UV 偏移） | FS alpha | FS rgb |
|---|---|---|---|
| Text_Bold FS/VS | 8 tap：轴向 ±`_BoldOffset`、对角 ±0.6×`_BoldOffset`；**无中心 tap** | `Σ8 × COLOR0.a × 0.23`，**无 clamp** | `COLOR0`（填充色） |
| TextBoldOutline | 4 对角(0.6×`_OutlineOffset`) + 上/下/右 + **中心**，**缺左 tap** | `Σ8 × COLOR0.a × 0.23` | `COLOR0`（**无描边色混合**） |
| TextOutline | 8 方向 + 中心（共 9 tap） | `clamp(Σ9,0,1) × COLOR0.a` | `lerp(OutlineColor, COLOR0, center)` |

即：**粗体字形是"仅光晕"pass**——字形内部 alpha 由 8 tap 饱和（8×0.23=1.84，混合时按 1 处理），
边缘是 8 个 ±1.25 texel（desc m_BoldSize=1.25）双线性 tap 的软坡。0.23 为 shader 常数
（SH Hidden_Text_Bold_FS.metal:53）。

### 2.3 首帧 (0,0) 陷阱（引擎怪癖，影响离线取值）

CreateTextMesh（UB:2075-2086）在 **SetFont 之前**就对含 `<b>` 文本调 Bold()；此时
`m_fontTexture` 尚为 null（UB:6204 声明、仅 SetFont UB:6444 赋值），TexelSize(null) 返回
**(0,0)**（UB:3146-3151），且 m_HasBoldText 已置位、挡掉 ProcessText 里的后续调用——
首次 RenderText 粗体偏移为零（视觉上粗体不可见），第二次 RenderText 起才有真值。
基准图 = settled 态，故离线链直接取 `texel × m_BoldSize`（图集 1:1 时 texel=1/atlasSize，
动态图集字形按请求字号光栅 → **1 atlas texel = 1 字体像素**）。

zhCN 实值（assets/prefab_ubertext_ally.json）：desc(PowersUberText) m_BoldSize=1.25 无描边；
cost/plate 1.08；name 0（名字无 `<b>`，name 文本也不走 desc 粗体路径）。

---

## 3. 斜体（UberText 不参与，TextMesh 原生）

- **UB 全文无 italic/FontStyle 代码**（检索证实）。`<i>`/`</i>` 不被 ProcessText 处理，
  原样留在文本里交给 Unity TextMesh（richText=1，UB:2080、6413-6420）→ 由 TextGenerator
  按 FontStyle.Italic 请求字形，动态字体由 FreeType shear 合成斜体字形进图集。
- 游戏侧证据：`UberTextMgr.cs:73-74`（exporter/tmp/ilspy/Assembly-Csharp）启动即
  `m_FranklinGothicFont.RequestCharactersInTexture(m_AtlasCharacters, 40, FontStyle.Normal)`
  + `(..., FontStyle.Italic)` ——运行时图集确实备有 FranklinGothic(→BlizzardGlobal)@40
  **斜体**字形；desc 恰为 BlizzardGlobal@40。
- 需求量：fixture 集 `<i>` 111 处（zhCN 7 张：TIME_EVENT_999、BG30_802、CATA_190h、
  ETC_210、REV_365、TTN_090、BG32_MagicItem_350），基准图实拍整行斜体
  （括号备注惯例「（还剩X次！）」「(Once per game.)」）。
- **wrap 不受影响**：`<i>` 是尖括号 tag，BreakStringIntoWords 跳过不计量宽（UB:3849-3865）；
  合成斜体不改 advance（只剪字形、minX/maxX 位移）。`<i><b>` 可嵌套（CATA_190h）：
  斜体字形 × material=1 粗体 pass，两者正交。

### 实现路径（按证据强度排序）

1. **图集直采（推荐）**：注入器按 UberTextMgr 同式 `RequestCharactersInTexture(chars, 40,
   FontStyle.Italic)` 后快照图集 → 精确字形像素 + CharacterInfo（minX/maxX 已含剪切位移），
   无需知道 shear 常数。与 Angelia font-pipeline 的 `-dumpfonts` 同法扩展。
2. **合成 shear 定标**：斜体 = 同 advance、字形按 `x' = x + s·y` 剪切。s 需从直采图集反测
   （基准图 512px 下 CJK 字高 ~35px，逐行互相关噪声过大，已试不可靠；直采图集是 1:1 字形，
   可精确测）。

---

## 4. 其余标记族（zhCN 现状不触发，备案）

- 方括号 tag `[b]`/`[d]`/`[x]`（IsValidSquareBracketTag UB:3002-3009）：测量时剥除
  （RemoveTagsFromWord UB:2848-2916）；`[b]`/`[d]` 在分词时强制断词（UB:3826-3837），
  `[x]` 粘连当前词（UB:3839-3847）。zhCN fixture 零出现（jaJP 有 `[x]`、thTH 有 `[b]`）。
- `_`→空格：仅在 **!m_WordWrap** 路径的 RemoveLineBreakTagsHardSpace（UB:2918-2951，
  ProcessText UB:2623-2626 调用）；wordWrap 节点里 `_` 作为空白参与 IsWhitespaceOrUnderscore
  塌缩（UB:3011-3024）。zhCN fixture 零出现。
- `<b></b>` 空标签短路：不触发 Bold()、不 Replace（UB:2632 条件），标签留在文本里由
  TextMesh 原生解析（无视觉效果）。

---

## 5. TS 现状差距清单（对照反编译语义）

| 项 | TS 现状 | 引擎语义 | L2 影响 |
|---|---|---|---|
| 粗体 | `glyphOutlineShader(mask, info, kPx, fill, outline, boldPx, r)` 收 `boldPx` 但**函数体未用**（glyph.ts:63-112；ubertext.ts:185 已算好 boldPx） | submesh1 仅 halo：α=0.23×Σ8(±bold, ±0.6bold) tap、无中心、rgb=填充色；quad 外扩 bold texel | 28 张 `<b>` 卡关键词粗细错 |
| 斜体 | `splitRich` 把 `<i>` 当普通 tag 剥除（textlayout.ts:59-64） | TextMesh 原生 FontStyle.Italic 字形（合成 shear，advance 不变） | 7 张 `<i>` 卡整行字形错 |
| `@`/`{0}`/`$` | plan.ts 直用 `fixture.textInHand.zhCN` 原文（plan.ts:211/707） | 基准图 = 游戏内 resolve 后文本（BG30_802 实拍「还剩2次」vs fixture「还剩@次」） | 含占位卡文本内容错 |
| 对齐/换行/垂直锚定/描边 | 已对齐（breakIntoWords/wrapLines/行框公式/TextOutline 8+1 tap） | 同左 | 断点逐字一致（TIME_EVENT_999/WW_373/CATA_190h 实拍） |

注：WW_373 等 6 卡 z_desc 86–110 被**非文字全局残差**污染（热图整卡发热，金卡/原画层问题），
文字侧真信号是粗体词处的白斑；L2 分区数字不能单独作文字回归证据（与 Angelia 守则一致：
net 掩码对文字结构性失明，须并排图+分区逐项）。

---

## 6. 落地路线（建议顺序）

1. **粗体**（零新数据依赖，纯 shader 仿真补全）：
   - glyph.ts 增加 bold halo 路径：对 bold 字形 α = min(1, 0.23×Σ8 tap)（轴向 ±boldPx、
     对角 ±0.6×boldPx，双线性采样字形 mask），rgb=填充色；quad 外扩 boldPx；
   - 与描边叠加时（cost/plate 理论可出现 `<b>`）：半径改 (outline + 0.75×bold)、缺左 tap、
     rgb=填充色（TextBoldOutline 语义）；desc（无描边）走纯 Text_Bold 语义；
   - RTT（name 弧形）路径同语义（name m_BoldSize=0，实际不触发）。
2. **斜体**（需一次图集直采）：
   - 注入器扩展 `RequestCharactersInTexture(chars, 40, FontStyle.Italic)` → BlizzardGlobal@40
     斜体字形 + CharacterInfo 入 `assets/glyphs/BlizzardGlobal-40-italic/`；
   - splitRich 增加 italic 状态位（与 bold 并列逐字符标志）；FontMetricsLike 按 style 取
     metrics+mask；其余管线零改动（advance/换行/垂直全部不变）；
   - 顺手从直采图集反测 shear 常数备案（供无图集字号复用：斜体字号 ≠40 的节点）。
3. **文本 resolve**（textstage 上游）：`{0}`(TryFormat/SCRIPT_DATA)、`@`(alternate/script)、
   `$`/`#` 加成在 plan 层接 exporter 等价链——hearthstone-text-formatting.md 已有完整规格与
   反编译行号；fixture 冻结文本是未解析态，基准图是已解析态，二者必须过同一 resolve 链。

## 7. 证据索引

- 反编译：`explore/ilspy/UberText.Runtime.full.cs`（UB 行号见文内）；UberTextMgr.cs：
  `exporter/tmp/ilspy/Assembly-Csharp/UberTextMgr.cs:73-74`
- Shader：`exporter/tmp/shader/Hidden_Text_Bold_{VS,FS}.metal`、
  `Hidden_TextBoldOutline_Unlit_{VS,FS}.metal`、`Hidden_TextOutline_Unlit_FS.metal`
- 序列化值：`assets/prefab_ubertext_ally.json`（四区 m_BoldSize/m_RichText/m_Outline*）
- 基准图实拍：`reference/TIME_EVENT_999.png`、`reference/BG30_802.png`、
  `reference/CATA_190h.png`（粗体+斜体+占位符解析三重证据）；对照
  `out/l2/TIME_EVENT_999_side.png`
- Angelia 前置：`Angelia/docs/notes/text-rendering-pipeline.md`、
  `Angelia/lab/2026-09-30-text-pipeline/findings/{text-pipeline-spec,text-pipeline-impl}.md`、
  `Angelia/lab/2026-10-02-font-pipeline/`（图集直采方法）
- 文本 resolve 规格：`../hearthstone-text-formatting.md`（工作区根部，2026-06-29）
