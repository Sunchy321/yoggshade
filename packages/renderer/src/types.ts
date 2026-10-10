/** 资产与渲染计划的类型（对应 py 侧 JSON 产物；P0 范围：帧 + 肖像）。 */

/** RGBA 图像（uint8 0..255，行主序 h×w×4）。
 *  内存口径：PNG 源本就是 8bit，历史上曾展开成 float64（0..1）缓存——单卡纹理常驻
 *  118.5 MiB（explore/2026-10-08-diy-workers-port/findings.md §3.3），是 128 MB isolate
 *  预算的第二个大头；改 uint8 后 ~15 MiB。采样点（image.ts / gems.ts）读值时 `/255`，
 *  与预展开的 float64 是同一个 IEEE 除法，逐位相同（ticket 18 位级等价实证，fixtures
 *  全集字节一致）。注意 ubertext.ts 另有同名局部接口（文字层 float64），二者无关。 */
export interface RGBAImage {
  w:    number;
  h:    number;
  data: Uint8ClampedArray;
}

/** mesh_data.npz 的单键：顶点 / uv0 / uv1 / 各 submesh 三角形索引。
 *  uv1 = desc 水印采样通道（Unlit_2Texture2uv 第二纹理）；mesh 无 UV1 通道时回退 uv0
 *  （引擎语义——hero desc mesh 无 UV1，采样 = uv0×ST(5,5,−2.01,−0.54)，水印 5× 放大窗
 *  可见，参照 AV_205 实证）。 */
export interface MeshEntry {
  verts: number[][];
  uv0:   number[][];
  uv1?:  number[][];
  subs:  number[][][];
}

/** frame_recon 材质（renderers[].materials[] 元素；null = 空槽）。 */
export interface FrameMaterial {
  name?:   string | null;
  /** 材质 shader 名（如 Hero/Multiply/Multiply = 乘法阴影）。 */
  shader?: string | null;
  tex?: Record<string, {
    scale?:   number[];
    offset?:  number[];
    texture?: { name?: string, bundle?: string, file?: string } | null;
    error?:   string;
  }>;
  colors?: Record<string, number[]>;
  floats?: Record<string, number>;
}

export interface PlanSlot {
  slot:               number;
  empty?:             boolean;
  _MainTex_runtime?:  { file: string };
  material_override?: {
    '_tint_rgb'?:       number[];
    '_MainTex.offset'?: number[];
    '_MainTex.scale'?:  number[];
  };
  /** opaque-edge alpha 修复：按不透明绘制（忽略纹理 alpha）；见 plan.ts needsOpaqueEdgeRepair。 */
  opaque?:          boolean;
  /** _MainTex 采样 wrap=repeat（引擎材质默认；缺省 clamp）。多职业绶带阴影 ST offset 越界。 */
  wrap_repeat?:     boolean;
  /** 双纹理画窗：_SecondTex@UV1 为窗内蒙版（白=透、暗=压暗），合成 = main×second。
   *  Custom/Card/Unlit_Portrait（战棋饰画画窗）逐帧显式标记；其他帧的 _SecondTex
   *  材质未经基准验证不启用。 */
  second_tex_mask?: boolean;
  /** 非默认混合：multiply = Hero/Multiply/*（dst.rgb *= 纹理色+_Color，只压暗）；
   *  additive = Hero/Additive/*（dst.rgb += src·tint·src.a，星芒/辉光）；
   *  colorAsAlpha = Effects/FX_Transparent_ColorAsAlpha（黑影、亮度即透明度，见
   *  color_as_alpha 参数）。 */
  blend?:           'multiply' | 'additive' | 'colorAsAlpha';
  /** colorAsAlpha 参数（shader FS 反编译：a = dot((.3,.59,.11),tex.rgb)×alpha_intensity、
   *  rgb = tex.rgb×color、整体 ×intensity）。 */
  color_as_alpha?:  { color: number[], intensity: number, alpha_intensity: number };
  /** 该材质槽不参与光栅（运行时占位/被 spell 视觉替换的底板）。 */
  skip?:            boolean;
}

/** desc 卡集水印运行时写点（Actor.UpdateWatermark，Actor.cs:5075-5135 对译）；
 *  编译期由 plan.ts resolveWatermark 产出，渲染期由 rasterZbuf wm 参数消费。 */
export interface WatermarkSpec {
  /** 水印纹理（资产包相对路径 watermarks/{stem}_{guid8}.png）；
   *  null = 纹理裁决空串（引擎不换纹理、alpha 恒 0） */
  tex_file: string | null;
  /** 运行时 `_SecondTint.a`：WATERMARK_ALPHA_VALUE=99/128（Actor.cs:183）；
   *  HIDE_WATERMARK(1107) 或裁决空 → 0（:5106/:5113-5118） */
  alpha:    number;
  /** OffsetDescriptionTexture（Actor.cs:6188 + 常量 :599-601）的运行时 y：
   *  withRace ? 0 : 0.07；null = IsHero 早退（:6217，x/y 保留序列化值）。
   *  x 恒保留序列化值，由渲染端从材质 _SecondTex.offset 读取。 */
  offset_y: number | null;
}

export interface PlanComponent {
  path:            string;
  node?:           string;
  visible?:        boolean;
  raster?:         boolean;
  /** 网格键覆盖（如法术学派板：neutral → extra/m_spellDescriptionMeshSchool）。 */
  mesh?:           string;
  material_slots?: PlanSlot[];
  /** desc 水印写点（仅 Description_mesh 组件携带；渲染端再按材质 _SecondTex 槽判 gate）。 */
  watermark?:      WatermarkSpec;
}

export interface StatGem {
  node:          string;
  path:          string;
  npz_key:       string;
  /** 非空 = 节点在 spells/{overlay}/ 的 SpellTable 预制里（战棋铸币；renderStatGems 从
   *  overlayPacks 取节点/网格，见 main.ts collectOverlayGems）。 */
  overlay?:      string;
  main_tex_file: string;
  tint_rgb:      number[];
  intensity:     number;
  speed_xy:      number[];
  scale_xy:      number[];
}

export interface PlanTextEntry {
  role:         string;
  render?:      boolean;
  text?:        string;
  /** alt-cost 等场景：渲染期把文本节点世界平移整体平移该 delta（UpdateManaGemOffset 语义）。 */
  world_delta?: number[];
  /** 换节点渲染（如 UpdateRace 多族：文本落 Multi_RaceUberText）——渲染期按该帧层级路径
   *  重新取 NodeSettings，替代 role_paths 的默认节点。 */
  node_path?:   string;
  [k: string]:  unknown;
}

export interface RenderPlan {
  components:      PlanComponent[];
  input?:          { dbf_id?: string, card_id?: string };
  rarity_gem?:     { visible?: boolean, atlas_offset?: number[], tint_rgb?: number[] };
  gem?:            { enabled?: boolean, t?: number };
  stat_gems?:      StatGem[];
  texts?:          PlanTextEntry[];
  /** 战棋模板 spell 视觉（SpellTable 实例；scripts/extract_spell.py 提取到 pack spells/{key}/）。
   *  gem 被替换时 stat_gems 置空（Actor.UpdateManaGemComponent 隐藏 m_manaObject，Actor.cs:5184-5201）。
   *  anchor='world-target'：预制序列化位姿≠本帧宝石位（各帧布局不同/FSM 搬运），渲染期把
   *  整个 overlay 平移到 world_target（plan 计算：一般= 本帧 Gem_Mana 世界位
   *  [UpdateManaGemComponent 原位替换语义]；酒馆法术 tech>0 = 商店 actor 作者化费用位）。 */
  spell_overlays?: { key: string, tech_level?: number, anchor?: 'world-target', world_target?: number[] }[];
  /** 晚通道绘制的节点名（运行时激活的覆盖层，如饰品徽章子树）——主帧光栅后按序合成，
   *  每节点独立深度缓冲（激活序 = 合成序，Unity SetActive 语义）。 */
  late_nodes?:     string[];
  /** 取景锚（世界 xz，世界单位）：非 undefined 时渲染端全部世界→像素投影以此为画布中心。
   *  exporter FrameCamera 不对原点取景——TryGetActorFrameBounds（ExporterController.cs:11259、
   *  :11329+）以主体网格（RootObject[/NonQuestObjects]/Mesh）世界包围盒中心为相机中心，
   *  基准图（reference/）全按该口径导出；TS 原点取景因此与基准图差每帧型一个常数平移
   *  （量化与对账：explore/2026-10-06-l2-offset/findings.md）。plan 编译期按主体网格顶点
   *  包围盒算好写入；scope 外帧族缺省 undefined = 原点锚（行为不变）。 */
  frame_center?:   [number, number];
}

export interface HierarchyNode {
  name:        string;
  path?:       string;
  npz_key:     string;
  go_path_id?: number;
  local?:      { pos: number[], rot: number[], scale: number[] } | null;
  world?:      number[][] | null;
  mesh_stats?: {
    name:         string;
    verts:        number;
    submesh_tris: number[];
  } | null;
  renderers?:           { enabled?: number, materials: (FrameMaterial | null)[] }[];
  /** 序列化激活状态（含祖先链；prefab walk 产物）。 */
  active_in_hierarchy?: boolean;
  children?:            HierarchyNode[];
}

/** 肖像网格通道（portrait_mesh_channels.npz）。 */
export interface PortraitChannels {
  verts: number[][];
  uv0:   number[][];
  uv1:   number[][];
  sub0:  number[][];
  sub1:  number[][];
}

/** frames/{slot}/manifest.json（scripts/extract_frame.py 产物）。 */
export interface FrameManifest {
  slot:              string;
  frame_root:        string;
  prefab_ref:        string;
  role_paths:        Record<string, string>;
  portrait_node_key: string | null;
  second_tex:        string | null;
  carrier:           { node: string, npz_key: string, mesh_name: string, world: number[][] } | null;
  nodes:             number;
  mesh_keys:         number;
  textures:          string[];
}

/** frames/{slot}/prefab_report.json：节点表 + Actor 绑定（plan 编译器输入）。 */
export interface PrefabReport {
  prefab: { name: string, ref: string, guid: string, bundle: string };
  nodes: {
    path:       string;
    go_path_id: number;
    components: {
      renderer?:      { material_slots: { slot: number, empty?: boolean, name?: string, shader?: string | null, textures?: Record<string, { name?: string, bundle?: string }> }[] };
      TextComponent?: { path_id: number, font_name?: string };
    };
  }[];
  actor_components: [{
    object_refs: Record<string, { node?: string, name?: string, type?: string, bundle?: string, error?: string }>;
    scalars:     Record<string, number | string | boolean | null>;
  }];
  issues: string[];
}

/** spells/{key}/（scripts/extract_spell.py 产物）：coin / tavern-tier 等 SpellTable spell 预制。 */
export interface SpellOverlayPack {
  key:       string;
  hierarchy: HierarchyNode;
  meshes:    Record<string, MeshEntry>;
}

/** tables.json factionIconSt 行（CardColorSwitcher faction* 材质序列化摘要，
 *  scripts/extract_banner_assets.py 产出）：图标/绶带底板的运行时换材质编译期输入。 */
export interface FactionMaterialSt {
  mat?:    string;
  tex?:    string;
  file?:   string;
  scale?:  number[];
  offset?: number[];
  color?:  number[];
  /** factionBannerMaterials[i] 绶带底板材质（帮派=Faction_Banner，星际=Faction_Banner_Starcraft）。 */
  banner?: FactionMaterialSt | null;
  error?:  string;
}

export interface AssetPack {
  dir:      string;
  slot?:    string;
  manifest: {
    size:              [number, number];
    portrait_node_key: string | null;
    /** Actor.m_portraitMatIdx：肖像材质槽 = 肖像子网格下标（随从/地标=0，法术/英雄/武器=1）。 */
    portrait_mat_idx?: number;
    second_tex:        string | null;
    role_paths?:       Record<string, string>;
    frame_root?:       string;
    [k: string]:       unknown;
  };
  frameManifest?: FrameManifest;
  prefabReport?:  PrefabReport;
  plan?:          RenderPlan;
  frameRecon:     { hierarchy: HierarchyNode, [k: string]: unknown };
  meshes:         Record<string, MeshEntry>;
  portrait:       PortraitChannels;
  materialProps: {
    m_Colors: Record<string, { r: number, g: number, b: number, a: number }>;
    m_Floats: Record<string, number>;
  };
  ubertext?: { nodes: {
    path:           string;
    fields?:        Record<string, unknown>;
    font_name?:     string;
    localPosition?: number[];
    localRotation?: number[];
    localScale?:    number[];
  }[]; };
  curved?:   { verts: number[][], uv0: number[][], tris: number[][], world: number[][] };
  fontdefs?: unknown;
}
