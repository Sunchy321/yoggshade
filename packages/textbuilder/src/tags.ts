/** GAME_TAG 常量（CardTextBuilder 家族消费的静态 EntityDef / 运行时 tag）。
 *  枚举值出处：反编译 GAME_TAG.cs（exporter/tmp/ilspy/Assembly-Csharp/GAME_TAG.cs），
 *  与 exporter 协议 renderMechanics 表（protocol/hearthstone-image-renderer-protocol.md）
 *  及 ExporterController.cs:207 AllRenderMechanics 三方一致。 */
export const TAG = {
  SCRIPT_DATA_NUM_1:                   2, // {0} 替换（GAME_TAG.cs:6）
  SCRIPT_DATA_NUM_2:                   3, // {1} 替换（GAME_TAG.cs:7）
  SCRIPT_DATA_ENT_1:                   4, // SpellAbsorb 引用实体（GAME_TAG.cs:4）
  DATA_NUM_3:                          2889, // {2} 替换
  DATA_NUM_4:                          2919, // {3} 替换
  DATA_NUM_5:                          2920, // {4} 替换
  DATA_NUM_6:                          2921, // {5} 替换
  CARD_NAME_DATA_1:                    2890, // 名称 {0} 替换
  SCORE_VALUE_1:                       451, // 倒计时 @ 替换（ScoreValueCountDown）
  SCORE_VALUE_2:                       453, // 倒计时已计数（减量）
  HIDDEN_CHOICE:                       813,
  HIDDEN_CHOICE_OVERRIDE:              2946,
  USE_ALTERNATE_CARD_TEXT:             955, // @ 备用文本段选择（GAME_TAG.cs:352）
  SUPPRESS_ALT_CARD_TEXT_FOR_OPPONENT: 4300,
  MODULAR_ENTITY_PART_1:               471,
  MODULAR_ENTITY_PART_2:               472,
  QUEST_PROGRESS_TOTAL:                535,
  QUEST_REWARD_DATABASE_ID:            1089,
  HIDE_WATERMARK:                      1107,
  CUSTOMTEXT1:                         1093,
  CUSTOMTEXT2:                         1094,
  CUSTOMTEXT3:                         1095,
  CREATOR:                             313,
  JADE_GOLEM:                          441, // 玉莲像当前体型（Entity 运行时）
  PLAYER_TAG_THRESHOLD_TAG_ID:         1115,
  PLAYER_TAG_THRESHOLD_VALUE:          1116,
  ENTITY_TAG_THRESHOLD_TAG_ID:         2459,
  ENTITY_TAG_THRESHOLD_VALUE:          2460,
  DYNAMIC_KEYWORD_1:                   4161,
  DYNAMIC_KEYWORD_2:                   4162,
  BACON_DEEP_BLUE:                     2850,
  BACON_ALT_TAVERN_SYSTEM_ACTIVE:      4519,
  HAS_TIMEWARPED_TAVERN_ALT_TEXT:      4579,
  TAVERN_SPELL_ATTACK_INCREASE:        3989,
  TAVERN_SPELL_HEALTH_INCREASE:        3990,
  BACON_TRIPLED_BASE_MINION_ID:        1471,
  BACON_TRIPLED_BASE_MINION_ID2:       3499,
  BACON_TRIPLED_BASE_MINION_ID3:       3500,
  HERALD_COLOSSAL_CLASS:               4534,
  USED_REWIND:                         3945,
  CARDTEXT_ENTITY_0:                   2655,
  CARDTEXT_ENTITY_1:                   2656,
  CARDTEXT_ENTITY_2:                   2657,
  CARDTEXT_ENTITY_3:                   2658,
  CARDTEXT_ENTITY_4:                   2659,
  CARDTEXT_ENTITY_5:                   2660,
  CARDTEXT_ENTITY_6:                   2661,
  CARDTEXT_ENTITY_7:                   2662,
  CARDTEXT_ENTITY_8:                   2663,
  CARDTEXT_ENTITY_9:                   2664,
  // BGZilliax 关键词（builtin.ts 表值；GAME_TAG.cs 同名枚举）
  TAUNT:                               190,
  WINDFURY:                            189,
  DIVINE_SHIELD:                       194,
  STEALTH:                             191,
  MAGNETIC:                            849,
  REBORN:                              1085,
} as const;
