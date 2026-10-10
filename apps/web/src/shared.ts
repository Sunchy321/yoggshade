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

/** 表单可编辑字段（= 预设卡的当前值，供「加载预设再改」） */
export interface CardFields {
  cardType: number;
  classTag: number;
  rarity:   number;
  cost:     number;
  attack:   number;
  health:   number;
  armor:    number;
  elite:    boolean;
  race:     number;
  /** 法术学派（TAG_SPELL_SCHOOL=1635）；只对法术类卡型有意义 */
  school:   number;
}

export interface PresetInfo {
  cardId:      string;
  label:       string;
  name:        string;
  text:        string;
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
