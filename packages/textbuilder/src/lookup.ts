/** GameStrings / GameDbf / GameState 依赖的外置钩子。
 *  游戏内这些是全局服务；离线渲染方按数据源注入（DBF 表、cards_json、本地化表）。
 *  未提供钩子时相关 builder 分支按缺省值退化（UNKNOWN 名、空串、0），并在结果里
 *  保持可观察（fallback 返回 key 本身，调试可见）。 */
/** 游戏内 Locale 枚举名（Localization/，14 语言；复数规则 GetPluralIndex 按此分派） */
export type HsLocale
  = | 'enUS' | 'deDE' | 'esES' | 'esMX' | 'frFR' | 'itIT' | 'jaJP' | 'koKR'
    | 'plPL' | 'ptBR' | 'ruRU' | 'thTH' | 'zhCN' | 'zhTW';

export interface TextLookupHooks {
  /** GameStrings.Get：GALAKROND_ONCE/TWICE、GAMEPLAY_UNKNOWN_CREATED_BY、
   *  GAMEPLAY_UNDATAKAH1-3、GAMEPLAY_HERALD_*、ZILLIAX_DELUXE_COMBINED_MODULE_a_b、
   *  GAMEPLAY_DIAMOND_SPELLSTONE_* 等 */
  gameString?(key: string): string | undefined;
  /** GameStrings.GetKeywordName（动态关键词 / BGZilliax 模块关键词） */
  keywordName?(gameTag: number): string | undefined;
  /** GameStrings.GetClassName((TAG_CLASS)classIndex) */
  className?(classTag: number): string | undefined;
  /** GameDbf.Card.GetRecord(dbfId).Name（引用卡名） */
  cardName?(dbfId: number): string | undefined;
  /** DefLoader/GameState 实体显示名（CARDTEXT_ENTITY_0-9 / CREATOR / CUSTOMTEXT / HIDDEN_CHOICE 引用） */
  entityName?(dbfId: number): string | undefined;
  /** 实体/卡静态数据（模块卡文本递归：Zombeast/ModularEntity/SpellAbsorb） */
  card?(dbfId: number): { cardId?: string, name?: string, textInHand?: string, tags?: Record<string, number> } | undefined;
  /** BattlegroundsZilliax：三倍化底卡 dbfId → 关键词 GAME_TAG（builder 内硬编码表外置） */
  bgZilliaxKeyword?(baseMinionDbfId: number): number | undefined;
  /** GameplayString：per-card GameStrings key 前缀（LOOT_507→GAMEPLAY_DIAMOND_SPELLSTONE_ 等） */
  gameplayStringPrefix?(cardId: string): string | undefined;
  /** UniversalCardTextBuilder 的 v2 文本模板（m_template.Body.BuildText 数据驱动，模板
   *  数据不在程序集内——由渲染方按 templateId 提供） */
  universalTemplate?(cardId: string): ((entity: TextEntityInput) => string) | undefined;
  /** ZilliaxDeluxe3000 功能模块表：模块 dbfId → 组合编号（反编译内硬编码 104944→8 等） */
  zilliaxModule?(moduleDbfId: number): number | undefined;
  /** GetRaceName（GameStrings.cs:1719）：(TAG_RACE) → 本地化种族名（内置表兜底） */
  raceName?(raceTag: number): string | undefined;
  /** GetRaceNameBattlegrounds（GameStrings.cs:1744）：酒馆种族名（count>1 时用） */
  raceBattlegroundsName?(raceTag: number): string | undefined;
  /** 递归文本重建（EntityPower 类引用别卡 BuildCardTextInHand；行号 builders.ts 29/35/38） */
  buildCardText?(dbfId: number): string | undefined;
}

/** 运行时 Entity 态（BuildCardTextInHand(Entity) 路径）；静态渲染不提供。 */
export interface RuntimeState {
  /** Player tag（PlayerTagThreshold 的 controller、Herald 的 COLOSSAL_CLASS、
   *  BGDeepBlues/TavernSpell 的 BACON_DEEP_BLUE/TAVERN_SPELL_* 加成） */
  controllerTag?(gameTag: number): number | undefined;
  /** BG 购物阶段本地玩家 tag（ZoneMgr.IsBattlegroundShoppingPhase 分支） */
  localPlayerTag?(gameTag: number): number | undefined;
  shoppingPhase?:        boolean;
  baconAltTavernActive?: boolean;
  /** 实体所在区域（JadeGolem：zone!=PLAY 时取 @ 前段） */
  zone?:                 'hand' | 'play' | 'graveyard' | 'setaside';
  /** 对手可见性（GetAltTextIndex 的 SUPPRESS 分支；mulligan/对手侧 → 段 0） */
  suppressAltForViewer?: boolean;
  /** SilverHand：recruits 当前 (atk, hp)（GetRecruitStats） */
  recruitStats?:         { atk: number, hp: number };
}

export interface TextEntityInput {
  tags:    Record<string, number>;
  cardId?: string;
}
