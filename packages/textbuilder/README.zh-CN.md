# @tcg-cards/hs-text-builder

[English documentation (README.md)](./README.md)

炉石传说（Hearthstone）卡面文本重建库：对游戏客户端 `CardTextBuilder` 家族（47 个类型）的
完整离线对译。输入卡牌静态数据（原文文本 + textBuilderType + GAME_TAG 数值表），
输出游戏内实际显示的文本——含 `@` 备用文本段、`{0}..{5}` 占位符、`$`/`#` 加成 token、
关键词名/职业名/引用卡名的本地化替换。

对译依据：游戏客户端反编译（`CardTextBuilder.cs` / `TextUtils.cs` / 42 个子类）。

## 特性

- **全量 47 类型**：`DEFAULT` 到 `SILVER_HAND_RECRUIT`（枚举顺序即类型数值），
  每个类型对译其静态（EntityDef）与运行时（Entity）两条路径；
- **零运行时依赖**：仅 Node 内置模块；纯函数，永不抛错（异常退回基类静态变换）；
- **内置 14 语言数据**：关键词名（185 项，KEYWORD_TEXT 表）、职业名（11 项）、
  GameStrings 文本（玉莲/加拉隆/预兆/奇利亚斯组合/法术石前缀等 70 键 × 14 语言），
  `keywordName`/`className`/`gameString` 零钩子即可命中；
- **DIY 覆盖**：每个内置数据点都有同名钩子，传入即覆盖（自定义卡名/自定义文本/自定义表）。

## 安装

```sh
npm install @tcg-cards/hs-text-builder
```

## 使用

```ts
import { resolveCardText, resolveEntityText } from '@tcg-cards/hs-text-builder';

// 静态卡面（收藏/展示口径）——与游戏内导出图一致
const r = resolveCardText({
  builderType: 7,          // SCRIPT_DATA_NUM_1（DBF m_cardTextBuilderType）
  cardId: 'BG30_802',
  text: '你的下2次<b>刷新</b>均为有用的刷新！ <i>（还剩@次！）</i>',
  tags: { '2': 2 },        // GAME_TAG 数值键（TAG_SCRIPT_DATA_NUM_1=2）
});
// r.text === '你的下2次<b>刷新</b>均为有用的刷新！ <i>（还剩2次！）</i>'

// 运行时（Entity）口径——法强加成、对局 tag、倒计时余量等动态成分
resolveEntityText({
  builderType: 22,         // SPELL_DAMAGE_ONLY
  cardId: 'CS2_029',
  text: '造成$3点伤害。',
  tags: {},
  bonuses: { damage: 2 },  // 法强 +2 → *5*（游戏同款高亮标记）
});
```

### 从卡牌 JSON 文档直接解析

```ts
import { resolveFixtureText } from '@tcg-cards/hs-text-builder';

const fixture = {
  textBuilderType: 28,     // MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS
  textInHand: { zhCN: '当你拥有{1}枚铸币时…（每局对战限一次）' },
  tags: { '3': 15 },
};
resolveFixtureText(fixture, 'zhCN', 'BG32_MagicItem_350').text;
```

## API

| 函数 | 说明 |
|---|---|
| `resolveCardText(ctx, opts?)` | 静态卡面（EntityDef）路径；`opts.lang` 切换内置数据语言（缺省 `zhCN`） |
| `resolveEntityText(ctx, opts?)` | 运行时（Entity）路径；`ctx.bonuses`/`ctx.runtime` 注入对局成分 |
| `resolveFixtureText(fixture, lang?, cardId?, opts?)` | 便利封装：直接传卡牌 JSON 文档 |
| `builtinLookup(hooks, opts)` | 独立取用内置缺省 hooks（合成自定义查找链） |

### ResolveContext

| 字段 | 说明 |
|---|---|
| `builderType` | DBF `m_cardTextBuilderType` 数值（见 `CARD_TEXT_BUILDER_TYPES` 常量表） |
| `text` | DBF `TextInHand` 原文 |
| `tags` | DBF CARD_TAG（GAME_TAG 数值键 → 值；缺 tag = 0） |
| `cardId` | 卡 ID（GameplayString 前缀族等按卡分派的分支需要） |
| `bonuses?` | 运行时加成：`damage`/`healing`/`attack`/`armor` + 各自翻倍次数 |
| `lookup?` | DIY 覆盖钩子（每个键优先于内置数据） |
| `runtime?` | 对局态：`controllerTag`/`localPlayerTag`/`zone`/`recruitStats` 等 |

### lookup 钩子（DIY 覆盖点）

| 钩子 | 覆盖的内置 | 用途 |
|---|---|---|
| `gameString(key)` | 内置 GameStrings（14 语言） | GALAKROND_ONCE、GAMEPLAY_HERALD_* 等 |
| `keywordName(gameTag)` | 内置关键词表（185 项） | 动态关键词、BGZilliax 模块关键词 |
| `className(classTag)` | 内置职业表（11 项） | 引用职业名 |
| `cardName(dbfId)` / `entityName(dbfId)` | 无（退化为占位名） | 引用卡名/实体名（需卡牌数据库） |
| `card(dbfId)` | 无（退化为空文本） | 模块卡文本递归（奇利亚斯/僵尸兽） |
| `buildCardText(dbfId)` | 无 | 引用卡文本递归（EntityPower 族） |
| `zilliaxModule(dbfId)` | 内置功能模块表（8 项） | 奇利亚斯 3000 组合编号 |
| `bgZilliaxKeyword(dbfId)` | 内置底卡关键词表（6 项） | 酒馆奇利亚斯 |
| `gameplayStringPrefix(cardId)` | 内置前缀表（10 组法术石等） | GameStrings per-card 键 |
| `raceName(raceTag)` / `universalTemplate(cardId)` | 无 | 任务种族名 / v2 模板系统 |

## 覆盖范围

- **静态精确**：凡"卡面静态语义"（文本 + type + tags 三件套可决定的），全部 47 类型
  与游戏一致（exporter 基准图口径，游戏离线导出走同一 EntityDef 路径）；
- **运行时 best-effort**：`resolveEntityText` 对加成/阈值/倒计时/购物阶段等动态成分
  按反编译语义支持，对局现场数据经 `runtime` 注入；
- **已知边界**：引用"别的卡"的名字/文本（奇利亚斯模块、僵尸兽、EntityPower 递归）需要
  调用方经 `lookup` 提供卡牌数据库；不提供时按游戏同款 fallback 退化（如"某张牌"）。

## 数据来源与许可

- **代码**：MIT（见 LICENSE）；
- **内置数据**（`data/gamestrings.json`，提取脚本见仓库 `scripts/extract_textbuilder_strings.py`）：
  来源于《炉石传说》客户端的本地化文本与 DBF 表（KEYWORD_TEXT）。版权归 Blizzard
  Entertainment 所有，按粉丝项目惯例随库分发仅供渲染复现使用；商用分发前请自行评估。
  如需替换/移除内置数据，传 `builtinLookup(hooks, { noBuiltinStrings: true })` 或自带钩子覆盖。

## 开发

```sh
bun install           # 仓库 workspace
bun test              # 本包测试（47 类型语义 + 对抗输入）
npm run build         # tsc → dist/（ESM + d.ts）
npm publish           # prepublishOnly 自动：typecheck + test + build
```

 scoped 包首次发布需 `npm publish --access public`（package.json 已含 publishConfig）。
