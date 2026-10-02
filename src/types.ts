/** 资产与渲染计划的类型（对应 py 侧 JSON 产物；P0 范围：帧 + 肖像）。 */

/** RGBA 浮点图像（0..1，行主序 h×w×4）。 */
export interface RGBAImage {
  w: number;
  h: number;
  data: Float64Array;
}

/** mesh_data.npz 的单键：顶点 / uv0 / 各 submesh 三角形索引。 */
export interface MeshEntry {
  verts: number[][];
  uv0: number[][];
  subs: number[][][];
}

/** frame_recon 材质（renderers[].materials[] 元素；null = 空槽）。 */
export interface FrameMaterial {
  name?: string | null;
  tex?: Record<string, {
    scale?: number[];
    offset?: number[];
    texture?: { name?: string; bundle?: string; file?: string } | null;
    error?: string;
  }>;
  colors?: Record<string, number[]>;
  floats?: Record<string, number>;
}

export interface PlanSlot {
  slot: number;
  empty?: boolean;
  _MainTex_runtime?: { file: string };
  material_override?: {
    _tint_rgb?: number[];
    "_MainTex.offset"?: number[];
  };
}

export interface PlanComponent {
  path: string;
  visible?: boolean;
  raster?: boolean;
  material_slots?: PlanSlot[];
}

export interface RenderPlan {
  components: PlanComponent[];
  input?: { dbf_id?: string; card_id?: string };
}

export interface HierarchyNode {
  name: string;
  path?: string;
  npz_key: string;
  go_path_id?: number;
  local?: { pos: number[]; rot: number[]; scale: number[] } | null;
  world?: number[][] | null;
  mesh_stats?: {
    name: string;
    verts: number;
    submesh_tris: number[];
  } | null;
  renderers?: { enabled?: number; materials: (FrameMaterial | null)[] }[];
  children?: HierarchyNode[];
}

/** 肖像网格通道（portrait_mesh_channels.npz）。 */
export interface PortraitChannels {
  verts: number[][];
  uv0: number[][];
  uv1: number[][];
  sub0: number[][];
  sub1: number[][];
}

export interface AssetPack {
  dir: string;
  manifest: {
    size: [number, number];
    portrait_node_key: string;
    second_tex: string;
    [k: string]: unknown;
  };
  plan: RenderPlan;
  frameRecon: { hierarchy: HierarchyNode; [k: string]: unknown };
  meshes: Record<string, MeshEntry>;
  portrait: PortraitChannels;
  materialProps: {
    m_Colors: Record<string, { r: number; g: number; b: number; a: number }>;
    m_Floats: Record<string, number>;
  };
}
