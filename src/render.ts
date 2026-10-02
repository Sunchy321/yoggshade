/** P0 渲染主流程：build_render_list_ally + raster_bucket_zbuf + 肖像公式层（dz_render 对译）。 */
import { projectX, projectY, SIZE } from "./camera.js";
import { rasterZbuf } from "./raster.js";
import { renderPortraitSubmesh } from "./portrait.js";
import { walkWithKey, TextureStore } from "./assets.js";
import { renderStatGems, renderRarityGemWrap } from "./gems.js";
import type { AssetPack, FrameMaterial, HierarchyNode, PlanComponent } from "./types.js";

interface FrameNode {
  name: string;
  key: string;
  materials: (FrameMaterial | null)[];
  world: number[][];
  comp: PlanComponent;
}

/** build_render_list_ally：计划可见性过滤 + 宝石三兄弟排除（→ shader 公式层，P1）。 */
export function buildRenderList(hierarchy: HierarchyNode, plan: AssetPack["plan"]): FrameNode[] {
  const visible = new Map<string, PlanComponent>();
  for (const c of plan.components) if (c.visible) visible.set(c.path, c);

  const nodes: FrameNode[] = [];
  for (const [n, key, path] of walkWithKey(hierarchy)) {
    if (!n.mesh_stats) continue;
    const rr = n.renderers ?? [];
    const comp = visible.get(path);
    if (!rr.length || !rr[0].materials?.length) continue;
    if (!comp) continue;                       // 计划隐藏
    if (comp.raster === false) continue;       // 文字载体 / 无材质光栅
    if (n.name === "Gem_Mana" || n.name === "Gem_Attack" || n.name === "Gem_Health") continue;
    nodes.push({ name: n.name, key, materials: rr[0].materials, world: n.world!, comp });
  }
  return nodes;
}

interface BucketTri {
  depth: number;
  seq: number;
  tri2d: number[][];
  triUv: number[][];
  triZ: number[];
  texKey: string;
  tint: number[];
  uvOffset: [number, number];
}

/** raster_bucket_zbuf：收集全部三角形 → (mean 世界 Y, DFS 序) 排序 → z-buffer 光栅。 */
export function rasterBucketZbuf(
  bucket: FrameNode[],
  pack: AssetPack,
  textures: TextureStore,
  canvas: Float64Array,
  zbuf: Float64Array,
): number {
  const W = SIZE[0], H = SIZE[1];
  const trisOut: BucketTri[] = [];
  let seq = 0;

  for (const { key, materials: mats, world: M, comp } of bucket) {
    const mesh = pack.meshes[key];
    if (!mesh) continue;
    const R = M;
    const verts = mesh.verts;
    const uv0 = mesh.uv0;
    const n = verts.length;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const depth = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const vx = verts[i][0], vy = verts[i][1], vz = verts[i][2];
      const wx = R[0][0] * vx + R[0][1] * vy + R[0][2] * vz + R[0][3];
      const wy = R[1][0] * vx + R[1][1] * vy + R[1][2] * vz + R[1][3];
      const wz = R[2][0] * vx + R[2][1] * vy + R[2][2] * vz + R[2][3];
      px[i] = projectX(wx);
      py[i] = projectY(wz);
      depth[i] = wy;
    }
    for (let si = 0; si < mesh.subs.length; si++) {
      const mi = Math.min(si, mats.length - 1);
      const mat = mats[mi];
      if (!mat) continue;
      const slotPlan = (comp.material_slots ?? []).find((s) => s.slot === mi) ?? null;
      const texFile = mat.tex?.["_MainTex"]?.texture?.file;
      const rtFile = slotPlan?._MainTex_runtime?.file;
      const texKey = rtFile ?? texFile;
      if (!texKey) continue;
      let tint = mat.colors?.["_Color"] ?? [1, 1, 1, 1];
      let uvOffset: [number, number] = [0.0, 0.0];
      const mo = slotPlan?.material_override;
      if (mo?._tint_rgb) tint = [...mo._tint_rgb, 1.0];
      if (mo?.["_MainTex.offset"]) uvOffset = [mo["_MainTex.offset"][0], mo["_MainTex.offset"][1]];

      const tris = mesh.subs[si];
      for (const t of tris) {
        const a = t[0], b = t[1], c = t[2];
        trisOut.push({
          depth: (depth[a] + depth[b] + depth[c]) / 3,
          seq: seq++,
          tri2d: [[px[a], py[a]], [px[b], py[b]], [px[c], py[c]]],
          triUv: [uv0[a], uv0[b], uv0[c]],
          triZ: [depth[a], depth[b], depth[c]],
          texKey, tint, uvOffset,
        });
      }
    }
  }

  trisOut.sort((e1, e2) => e1.depth - e2.depth || e1.seq - e2.seq);
  for (const e of trisOut) {
    rasterZbuf(canvas, zbuf, W, H, e.tri2d, e.triZ, e.triUv,
      textures.get(e.texKey), e.tint, e.uvOffset);
  }
  return trisOut.length;
}

/** 肖像层：portrait_mesh_channels + frame_recon 肖像节点世界矩阵 + 引擎公式。 */
export function renderPortraitLayer(
  pack: AssetPack,
  textures: TextureStore,
  canvas: Float64Array,
  zbuf: Float64Array,
): void {
  const W = SIZE[0], H = SIZE[1];
  const ch = pack.portrait;
  const portraitNode = [...walkWithKey(pack.frameRecon.hierarchy)]
    .find(([n]) => n.mesh_stats && n.npz_key === pack.manifest.portrait_node_key);
  if (!portraitNode) throw new Error("frame_recon 无肖像节点");
  const M = portraitNode[0].world!;

  const n = ch.verts.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const depth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const vx = ch.verts[i][0], vy = ch.verts[i][1], vz = ch.verts[i][2];
    const wx = M[0][0] * vx + M[0][1] * vy + M[0][2] * vz + M[0][3];
    const wy = M[1][0] * vx + M[1][1] * vy + M[1][2] * vz + M[1][3];
    const wz = M[2][0] * vx + M[2][1] * vy + M[2][2] * vz + M[2][3];
    px[i] = projectX(wx);
    py[i] = projectY(wz);
    depth[i] = wy;
  }

  const portraitFile = pack.plan.components
    .find((c) => c.path.endsWith("PortraitFrame_mesh"))!
    .material_slots![0]._MainTex_runtime!.file;
  const mainRgba = textures.get(portraitFile);
  const secondRgba = textures.get(pack.manifest.second_tex as string);
  const st = pack.materialProps.m_Colors._SecondTint;
  renderPortraitSubmesh(
    canvas, zbuf, W, H,
    Array.from(depth), Array.from(px), Array.from(py),
    ch.uv0, ch.uv1, ch.sub0,
    mainRgba, secondRgba,
    [st.r, st.g, st.b, st.a],
    pack.materialProps.m_Floats._BlendIntensity,
  );
}

/** 直感 alpha 合成到不透明黑底 → uint8 RGBA（np.clip→astype 截断口径 + PIL 量化近邻）。 */
export function composeToRgba8(canvas: Float64Array): Uint8Array {
  const W = SIZE[0], H = SIZE[1];
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const ci = i * 4;
    const a = Math.min(Math.max(canvas[ci + 3], 0), 1);
    for (let c = 0; c < 3; c++) {
      const rgb = Math.min(Math.max(canvas[ci + c], 0), 1);
      out[ci + c] = Math.round(rgb * a * 255);
    }
    out[ci + 3] = 255;
  }
  return out;
}

/** canvas RGBA → 直感 RGB（丢 alpha，PIL convert("RGB") 口径）+ uint8 截断量化。 */
export function canvasToQuantRgb(canvas: Float64Array): Float64Array {
  const W = SIZE[0], H = SIZE[1];
  const rgb = new Float64Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(Math.max(canvas[i * 4 + c], 0), 1);
      rgb[i * 3 + c] = Math.trunc(v * 255) / 255;
    }
  }
  return rgb;
}

/** Image 往返等价的截断量化（np.clip*255 → astype(uint8) → /255）。 */
export function quantTrunc(buf: Float64Array): Float64Array {
  for (let i = 0; i < buf.length; i++) {
    const v = Math.min(Math.max(buf[i], 0), 1);
    buf[i] = Math.trunc(v * 255) / 255;
  }
  return buf;
}

/** P1：宝石两段（含段间 uint8 量化口径），返回直感 RGB buffer。 */
export function renderGemsStage(
  canvas: Float64Array, pack: AssetPack, textures: TextureStore,
): Float64Array {
  const rgb = canvasToQuantRgb(canvas);
  renderStatGems(rgb, pack, textures);
  quantTrunc(rgb);
  if (pack.plan.rarity_gem?.visible) {
    renderRarityGemWrap(rgb, pack, textures);
    quantTrunc(rgb);
  }
  return rgb;
}

/** RGB float buffer → uint8 RGBA（trunc，对齐 py astype(uint8)）。 */
export function rgbToRgba8(rgb: Float64Array): Uint8Array {
  const W = SIZE[0], H = SIZE[1];
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.trunc(Math.min(Math.max(rgb[i * 3 + c], 0), 1) * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
