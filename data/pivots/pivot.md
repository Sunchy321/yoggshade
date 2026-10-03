# Pivot 卡集合（ADR-0001 双固化的定义源头）

本文件是 pivot 集合的**唯一编辑入口**：`scripts/extract_pivot_data.py` 读此表提取数据，
产出的 `manifest.json` 与各卡 JSON 是它的投影。增删 pivot 只改本表，不动脚本。

来源与同步关系：presets 表逐行同步自 `../exporter/bepinex/plugin/CardPresets.md`；
glow-bench 表同步自 `../exporter/docs/custom-glow-benchmark-plan.md`（12 卡型 token）。
exporter 侧新增基准卡时，在此表追加一行再重跑提取。

## presets

| Card ID | Label | Premium | Template | Zone | Reason |
|---|---|---|---|---|---|
| GDB_142 | 默认烟测卡 | NORMAL | Normal | Hand | 当前导出器默认卡，用于验证普通手牌渲染基线。 |
| TOY_519 | 法术基线 | NORMAL | Normal | Hand | 普通法术基线（有稀有度），用于验证法术版式、稀有度与战棋模板铸币光效。 |
| REV_365 | 派系法术 | NORMAL | Normal | Hand | 派系法术基线，用于验证派系法术版式与 spell-school 光效。 |
| WON_332 | 带阵营样例 | NORMAL | Normal | Hand | 带阵营标识样例，用于验证阵营相关卡面元素渲染。 |
| YOG_502 | 锻造样例 | NORMAL | Normal | Hand | 锻造机制样例，用于验证锻造相关文本与卡面版式。 |
| LOOT_392 | 武器基线 | NORMAL | Normal | Hand | 武器框体基线，用于检查攻击、耐久与稀有度渲染。 |
| AV_205 | 英雄基线 | NORMAL | Normal | Hand | 英雄样例，用于验证英雄手牌框体、护甲和头像区域渲染。 |
| CATA_190h | 多职业英雄基线 | NORMAL | Normal | Hand | 多职业英雄样例，用于验证多职业英雄手牌框体渲染。 |
| TTN_090 | 地标基线 | NORMAL | Normal | Hand | 地标样例，用于验证地标手牌框体与耐久区域渲染。 |
| DMF_709 | 单种族随从 | NORMAL | Normal | Hand | 单种族随从样例，用于验证单行种族栏布局。 |
| CFM_637 | 双种族随从 | NORMAL | Normal | Hand | 双种族随从样例，用于验证多种族文本布局与换行。 |
| AV_205p | 英雄技能基线 | NORMAL | Normal | Hand | 英雄技能样例，用于验证英雄技能导出。 |
| ETC_210 | 多符文基线 | NORMAL | Normal | Hand | 多符文死亡骑士样例，用于验证多符文导出。 |
| TIME_EVENT_999 | 金卡测试 | GOLDEN | Normal | Hand | 金卡样例，用于验证金卡导出。 |
| TTN_850 | 钻石基线 | DIAMOND | Normal | Hand | 钻石卡样例，用于验证钻石导出。 |
| RLK_706 | 异画1基线 | SIGNATURE | Normal | Hand | 异画样例 1，用于验证异画导出。 |
| WW_373 | 异画2基线 | SIGNATURE | Normal | Hand | 异画样例 2，用于验证异画导出。 |
| GDB_477 | 异画3基线 | SIGNATURE | Normal | Hand | 异画样例 3，用于验证异画导出。 |
| TLC_433 | 异画4基线 | SIGNATURE | Normal | Hand | 异画样例 4，用于验证异画导出。 |
| SC_004 | 异画5基线 | SIGNATURE | Normal | Hand | 异画样例 5，用于验证异画导出。 |
| TLC_EVENT_402 | 异画6基线 | SIGNATURE | Normal | Hand | 异画样例 6，用于验证异画导出。 |
| BG33_828 | 战棋等级随从 | NORMAL | Battlegrounds | Hand | 六星酒馆战棋随从，用于验证酒馆等级图标和战棋手牌样式。 |
| BG30_802 | 酒馆法术基线 | NORMAL | Battlegrounds | Hand | 酒馆法术样例，用于验证 BaconSpell 手牌样式和法术框体。 |
| BG27_Anomaly_580 | 畸变基线 | NORMAL | Battlegrounds | Hand | 战棋畸变样例，用于验证畸变导出。 |
| BG32_MagicItem_350 | 饰品基线 | NORMAL | Battlegrounds | Hand | 战棋饰品样例，用于验证饰品导出。 |
| BG34_Giant_072 | 时空扭曲随从 | NORMAL | Battlegrounds | Hand | 时空扭曲随从基线，用于验证时间酒馆随从的 TIME_TAVERN_TIER_ICON 图标渲染。 |
| BG34_Treasure_917 | 时空扭曲法术 | NORMAL | Battlegrounds | Hand | 时空扭曲法术基线，用于验证时间酒馆法术的 TIME_TAVERN_TIER_ICON 图标渲染。 |
| PET_3_1 | 宠物测试 | NORMAL | Normal | Hand | 宠物样例，用于验证宠物预览导出。 |
| LT23_802P2 | 佣兵技能基线 | NORMAL | Normal | Hand | 佣兵技能样例，用于验证 LETTUCE_ABILITY 法术类技能 BigCard 渲染。 |
| LT23_803P2 | 佣兵技能2 | NORMAL | Normal | Hand | 佣兵技能样例 2，用于验证另一张 LETTUCE_ABILITY 渲染。 |

## glow-bench

Parts 逗号分隔；`runeOverride` = 为测 `runes` 光效给该卡加的额外血符文数（空 = 不加）。
处理分配（exporter 基准口径）：`art`=neutral，`race`/`spell-school`=rework，其余 buff/nerf 各导一张。

| Token | Card ID | Template | Parts | Rune override |
|---|---|---|---|---|
| minion-single-race | DMF_709 | Normal | cost, attack, health, rarity, text, name, art, race, runes | 1 |
| minion-dual-race | CFM_637 | Normal | cost, attack, health, rarity, text, name, art, race, runes | 1 |
| spell-school | REV_365 | Normal | cost, rarity, text, name, art, spell-school, runes | 1 |
| weapon | LOOT_392 | Normal | cost, attack, durability, rarity, text, name, art, runes | 1 |
| hero | AV_205 | Normal | cost, armor, rarity, text, name, art, runes | 1 |
| location | TTN_090 | Normal | cost, durability, rarity, text, name, art, runes | 1 |
| bg-minion | BG33_828 | Battlegrounds | cost, attack, health, text, name, art, tech-level | |
| tavern-spell | BG30_802 | Battlegrounds | cost-coin, text, name, art, tech-level, spell-school | |
| hero-power | AV_205p | Normal | cost-relocated, text-shape | |
| trinket | BG32_MagicItem_350 | Battlegrounds | cost-coin, text-shape, trinket-size | |
| spell-bg | TOY_519 | Battlegrounds | cost-coin, rarity, text, name, art | |
| hero-power-bg | AV_205p | Battlegrounds | cost-coin, text-shape | |
