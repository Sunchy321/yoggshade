/** 站点前后端共享的形态定义（无 node 依赖，浏览器侧可直接 import）。
 *
 * 字段名对齐 exporter 协议 v1 的 renderModel 口径（cardType/class/rarity/cost/…），
 * 去掉协议里不参与像素生成的任务元数据。到渲染器 `FixtureCard` 的映射见 adapter.ts。 */

export interface CardTypeOption {
  tag:   number;
  slot:  string;
  label: string;
}

export interface LabelOption {
  tag:   number;
  label: string;
}

export type CardPremium = 'NORMAL' | 'GOLDEN' | 'SIGNATURE' | 'DIAMOND';

/** 表单可编辑字段（= 预设卡的当前值，供「加载预设再改」） */
export interface CardFields {
  premium:  CardPremium;
  cardType: number;
  classTag: number;
  rarity:   number;
  cost:     number;
  attack:   number;
  health:   number;
  armor:    number;
  elite:    boolean;
  race:     number;
  /** 法术学派（TAG_SPELL_SCHOOL=1635）；只对法术类卡型（含佣兵技能）有意义 */
  school:   number;
  /** 佣兵本体（TAG_LETTUCE_MERCENARY=1665 标识 >0）：仅随从卡型；勾选后卡面走佣兵收集卡帧 */
  mercenary:   boolean;
  /** 佣兵职业（TAG_LETTUCE_ROLE=1666）：1=施法者 2=斗士 3=护卫 4=中立（0=无） */
  mercRole:    number;
  /** 佣兵阵营（TAG_LETTUCE_FACTION=2720）：1=联盟 2=部落 3=黑暗帝国 4=探险者 5=燃烧军团 6=海盗 7=天灾（0=无） */
  mercFaction: number;
  /** 佣兵技能形态（仅卡型 23）：0=施法 1=召唤随从(TAG 1676) 2=装备(TAG 1855) */
  lettuceForm: number;
}

export interface PresetInfo {
  cardId:      string;
  label:       string;
  name:        string;
  text:        string;
  /** 原始 fixture 的品质，只用于预设列表标识；DIAMOND 预设载入时按普通品质编辑。 */
  premium:     CardPremium;
  /** 原始卡的 SIGNATURE_FRAME id；未移植的帧仍可看作普通预设，但不可选异画。 */
  signatureFrameId?: number;
  /** 该预设的签名帧已移植、且与当前原生卡型匹配时为 true。 */
  signatureAvailable: boolean;
  /** 预设是否自带原画（界面据此提示"不传原画就用它"） */
  hasPortrait: boolean;
  fields:      CardFields;
}

export interface MetaResponse {
  cardTypes: CardTypeOption[];
  classes:   LabelOption[];
  rarities:  LabelOption[];
  races:     LabelOption[];
  schools:   LabelOption[];
  presets:   PresetInfo[];
}

export interface RenderRequest extends CardFields {
  /** 预设起点（fixture 卡 id）。提供时其标签/原画/水印作为底：未显式改动的字段沿用预设，
   *  原画默认用预设的（除非上传覆盖），水印按预设卡的系列。空卡则无原画无水印。 */
  presetId?: string;
  name:      string;
  text:      string;
  /** 原画 dataURL（image/png）。前端已按规格裁成方形并压成不透明底。 */
  portrait?: string;
}
