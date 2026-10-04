/** 资产包装载（assets/ 根目录）。
 * 双形态：根目录单帧（历史，py export_asset_pack 产出）与 frames/{slot}/ 多帧
 * （scripts/extract_frame.py 产出；slot 与数据目录彼此独立，共享根级 portraits/fonts/glyphs）。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './image.js';
import type { AssetPack, HierarchyNode, MeshEntry, RGBAImage, SpellOverlayPack } from './types.js';

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

/** Actor.m_portraitMatIdx（肖像材质槽 = 肖像子网格下标）；缺省 0（随从/地标口径）。 */
function portrait_mat_idx(prefabReport: AssetPack['prefabReport']): number {
  const v = prefabReport?.actor_components?.[0]?.scalars?.['m_portraitMatIdx'];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class TextureStore {
  private cache = new Map<string, RGBAImage>();

  constructor(private packDir: string) {}

  /** ref 兼容两种形态：包内相对 "textures/xxx.png" 或裸文件名。 */
  get(ref: string): RGBAImage {
    const key = ref.includes('/') ? ref : `textures/${ref}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = decodePng(join(this.packDir, key));
      this.cache.set(key, tex);
    }
    return tex;
  }
}

export function loadPack(dir: string, slot?: string): AssetPack {
  if (slot) {
    const fdir = join(dir, 'frames', slot);
    const frameManifest = readJson<AssetPack['frameManifest']>(join(fdir, 'manifest.json'))!;
    const frameRecon = readJson<AssetPack['frameRecon']>(join(fdir, 'frame_recon.json'));
    const meshes = readJson<AssetPack['meshes']>(join(fdir, 'meshes.json'));
    const portrait = readJson<AssetPack['portrait']>(join(fdir, 'portrait.json'));
    const materialProps = readJson<AssetPack['materialProps']>(join(fdir, 'material_props.json'));
    const curved = frameManifest.carrier
      ? readJson<NonNullable<AssetPack['curved']>>(join(fdir, 'curved.json'))
      : undefined;
    const prefabReport = readJson<AssetPack['prefabReport']>(join(fdir, 'prefab_report.json'));
    const ubertext = readJson<AssetPack['ubertext']>(join(fdir, 'prefab_ubertext.json'));

    // NpzBlank 语义：肖像节点「肖像子网格」清空（肖像走公式模块，不参与帧光栅）。
    // 子网格下标 = Actor.m_portraitMatIdx（肖像材质槽，子网格与材质槽一一对应）：随从/地标=0，
    // 法术/英雄/武器=1 —— 写死 0 会清错网格（法术/英雄/武器的 sub1 才是肖像，sub0 是肖像框）。
    const portraitMatIdx = portrait_mat_idx(prefabReport);
    const pk = frameManifest.portrait_node_key;
    if (pk && meshes[pk]?.subs?.[portraitMatIdx]) meshes[pk].subs[portraitMatIdx] = [];

    const manifest = {
      size:              [512, 707] as [number, number],
      portrait_node_key: frameManifest.portrait_node_key,
      portrait_mat_idx:  portraitMatIdx,
      second_tex:        frameManifest.second_tex,
      role_paths:        frameManifest.role_paths,
      frame_root:        frameManifest.frame_root,
    };
    return { dir, slot, manifest, frameManifest, prefabReport, frameRecon, meshes,
      portrait, materialProps, curved, ubertext };
  }
  const manifest = readJson<AssetPack['manifest']>(join(dir, 'manifest.json'));
  const plan = readJson<NonNullable<AssetPack['plan']>>(join(dir, 'plan.json'));
  const frameRecon = readJson<AssetPack['frameRecon']>(join(dir, 'frame_recon.json'));
  const meshes = readJson<AssetPack['meshes']>(join(dir, 'meshes.json'));
  const portrait = readJson<AssetPack['portrait']>(join(dir, 'portrait.json'));
  const materialProps = readJson<AssetPack['materialProps']>(join(dir, 'material_props.json'));
  const curved = readJson<NonNullable<AssetPack['curved']>>(join(dir, 'curved.json'));

  // NpzBlank 语义：肖像节点「肖像子网格」清空（肖像走公式模块，不参与帧光栅）。
  // 根目录单帧包（历史 py 产物）均为随从帧，肖像子网格 = sub0。
  const pk = manifest.portrait_node_key;
  if (pk && meshes[pk]?.subs?.[0]) meshes[pk].subs[0] = [];

  return { dir, manifest, plan, frameRecon, meshes, portrait, materialProps, curved };
}

/** spells/{key}/（extract_spell.py 产物）装载：层级 + 网格。 */
export function loadSpellOverlay(packDir: string, key: string): SpellOverlayPack {
  const d = join(packDir, 'spells', key);
  const recon = readJson<{ hierarchy: HierarchyNode }>(join(d, 'frame_recon.json'))!;
  const meshes = readJson<Record<string, MeshEntry>>(join(d, 'meshes.json'))!;
  return { key, hierarchy: recon.hierarchy, meshes };
}

/** sc._walk_with_key：yield (node, npz_key, prefab_path)。 */
export function* walkWithKey(
  node: HierarchyNode,
  key = 'root',
  path = '',
): Generator<[HierarchyNode, string, string]> {
  const p = path ? `${path}/${node.name}` : node.name;
  yield [node, key, p];
  let i = 0;
  for (const child of node.children ?? []) {
    yield* walkWithKey(child, `${key}.${i}`, p);
    i++;
  }
}
