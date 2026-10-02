/** 资产包装载（assets/card-render-v1，由 py 侧 export_asset_pack.py 产出）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "./image.js";
import type { AssetPack, HierarchyNode, RGBAImage } from "./types.js";

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

export class TextureStore {
  private cache = new Map<string, RGBAImage>();

  constructor(private packDir: string) {}

  /** ref 兼容两种形态：包内相对 "textures/xxx.png" 或裸文件名。 */
  get(ref: string): RGBAImage {
    const key = ref.includes("/") ? ref : `textures/${ref}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = decodePng(join(this.packDir, key));
      this.cache.set(key, tex);
    }
    return tex;
  }
}

export function loadPack(dir: string): AssetPack {
  const manifest = readJson<AssetPack["manifest"]>(join(dir, "manifest.json"));
  const plan = readJson<AssetPack["plan"]>(join(dir, "plan.json"));
  const frameRecon = readJson<AssetPack["frameRecon"]>(join(dir, "frame_recon.json"));
  const meshes = readJson<AssetPack["meshes"]>(join(dir, "meshes.json"));
  const portrait = readJson<AssetPack["portrait"]>(join(dir, "portrait.json"));
  const materialProps = readJson<AssetPack["materialProps"]>(join(dir, "material_props.json"));
  const curved = readJson<AssetPack["curved"]>(join(dir, "curved.json"));

  // NpzBlankSub0 语义：肖像节点 sub0 清空（肖像走公式模块，不参与帧光栅）
  const pk = manifest.portrait_node_key;
  if (meshes[pk]?.subs?.[0]) meshes[pk].subs[0] = [];

  return { dir, manifest, plan, frameRecon, meshes, portrait, materialProps, curved };
}

/** sc._walk_with_key：yield (node, npz_key, prefab_path)。 */
export function* walkWithKey(
  node: HierarchyNode,
  key = "root",
  path = "",
): Generator<[HierarchyNode, string, string]> {
  const p = path ? `${path}/${node.name}` : node.name;
  yield [node, key, p];
  let i = 0;
  for (const child of node.children ?? []) {
    yield* walkWithKey(child, `${key}.${i}`, p);
    i++;
  }
}
