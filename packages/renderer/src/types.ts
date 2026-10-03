/** 资产与渲染计划的类型（对应 py 侧 JSON 产物；P0 范围：帧 + 肖像）。 */

/** RGBA 浮点图像（0..1，行主序 h×w×4）。 */
export interface RGBAImage {
  w:    number;
  h:    number;
  data: Float64Array;
}

/** mesh_data.npz 的单键：顶点 / uv0 / 各 submesh 三角形索引。 */
export interface MeshEntry {
  verts: number[][];
  uv0:   number[][];
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
  };
  /** opaque-edge alpha 修复：按不透明绘制（忽略纹理 alpha）；见 plan.ts needsOpaqueEdgeRepair。 */
  opaque?: boolean;
  /** 乘法混合（Hero/Multiply/* 材质）：dst.rgb *= 纹理色 + _Color，只压暗不遮盖。 */
  blend?:  'multiply';
}

export interface PlanComponent {
  path:            string;
  node?:           string;
  visible?:        boolean;
  raster?:         boolean;
  /** 网格键覆盖（如法术学派板：neutral → extra/m_spellDescriptionMeshSchool）。 */
  mesh?:           string;
  material_slots?: PlanSlot[];
}

export interface StatGem {
  node:          string;
  path:          string;
  npz_key:       string;
  main_tex_file: string;
  tint_rgb:      number[];
  intensity:     number;
  speed_xy:      number[];
  scale_xy:      number[];
}

export interface PlanTextEntry {
  role:        string;
  render?:     boolean;
  text?:       string;
  [k: string]: unknown;
}

export interface RenderPlan {
  components:  PlanComponent[];
  input?:      { dbf_id?: string, card_id?: string };
  rarity_gem?: { visible?: boolean, atlas_offset?: number[], tint_rgb?: number[] };
  gem?:        { enabled?: boolean, t?: number };
  stat_gems?:  StatGem[];
  texts?:      PlanTextEntry[];
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
  renderers?: { enabled?: number, materials: (FrameMaterial | null)[] }[];
  children?:  HierarchyNode[];
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
  ubertext?: { nodes: { path: string, fields?: Record<string, unknown>, font_name?: string }[] };
  curved?:   { verts: number[][], uv0: number[][], tris: number[][], world: number[][] };
  fontdefs?: unknown;
}
