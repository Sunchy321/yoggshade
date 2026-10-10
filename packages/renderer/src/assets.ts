/** 资产包装载（AssetSource 接口；键 = 包内相对路径）。
 * 双形态：根目录单帧（历史，py export_asset_pack 产出）与 frames/{slot}/ 多帧
 * （scripts/extract_frame.py 产出；slot 与数据目录彼此独立，共享根级 portraits/fonts/glyphs）。 */
import { decodePngBytes } from './image.js';
import { type AssetSource } from './source.js';
import type { AssetPack, HierarchyNode, MeshEntry, RGBAImage, SpellOverlayPack } from './types.js';

function readJson<T>(src: AssetSource, key: string): T {
  return JSON.parse(src.text(key)) as T;
}

/** Actor.m_portraitMatIdx（肖像材质槽 = 肖像子网格下标）；缺省 0（随从/地标口径）。 */
function portrait_mat_idx(prefabReport: AssetPack['prefabReport']): number {
  const v = prefabReport?.actor_components?.[0]?.scalars?.['m_portraitMatIdx'];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class TextureStore {
  private cache = new Map<string, RGBAImage>();

  /** seeds：内存注入图（键同 get 的归一化键）。站点上传原画走这条，不落盘、
   *  也不污染资产包（assets/ 是拆包脚本的可复现产物）。 */
  constructor(private src: AssetSource, seeds?: Map<string, RGBAImage>) {
    if (seeds) for (const [k, v] of seeds) this.cache.set(k, v);
  }

  private static key(ref: string): string {
    return ref.includes('/') ? ref : `textures/${ref}`;
  }

  /** 内存写入（覆盖同键的磁盘读取）。 */
  set(ref: string, img: RGBAImage): void {
    this.cache.set(TextureStore.key(ref), img);
  }

  /** ref 兼容两种形态：包内相对 "textures/xxx.png" 或裸文件名。 */
  get(ref: string): RGBAImage {
    const key = TextureStore.key(ref);
    let tex = this.cache.get(key);
    if (!tex) {
      tex = decodePngBytes(this.src.bytes(key));
      this.cache.set(key, tex);
    }
    return tex;
  }
}

export function loadPack(src: AssetSource, slot?: string): AssetPack {
  if (slot) {
    const fdir = `frames/${slot}`;
    const frameManifest = readJson<AssetPack['frameManifest']>(src, `${fdir}/manifest.json`)!;
    const frameRecon = readJson<AssetPack['frameRecon']>(src, `${fdir}/frame_recon.json`);
    const meshes = readJson<AssetPack['meshes']>(src, `${fdir}/meshes.json`);
    const portrait = readJson<AssetPack['portrait']>(src, `${fdir}/portrait.json`);
    const materialProps = readJson<AssetPack['materialProps']>(src, `${fdir}/material_props.json`);
    const curved = frameManifest.carrier
      ? readJson<NonNullable<AssetPack['curved']>>(src, `${fdir}/curved.json`)
      : undefined;
    const prefabReport = readJson<AssetPack['prefabReport']>(src, `${fdir}/prefab_report.json`);
    const ubertext = readJson<AssetPack['ubertext']>(src, `${fdir}/prefab_ubertext.json`);

    // NpzBlank 语义：肖像节点「肖像子网格」清空（肖像走公式模块，不参与帧光栅）。
    // 子网格下标 = Actor.m_portraitMatIdx（肖像材质槽，子网格与材质槽一一对应）：随从/地标=0，
    // 法术/英雄/武器=1 —— 写死 0 会清错网格（法术/英雄/武器的 sub1 才是肖像，sub0 是肖像框）。
    const portraitMatIdx = portrait_mat_idx(prefabReport);
    const pk = frameManifest.portrait_node_key;
    if (pk && meshes[pk]?.subs?.[portraitMatIdx]) meshes[pk].subs[portraitMatIdx] = [];

    const manifest = {
      size:              [512, 768] as [number, number],
      portrait_node_key: frameManifest.portrait_node_key,
      portrait_mat_idx:  portraitMatIdx,
      second_tex:        frameManifest.second_tex,
      role_paths:        frameManifest.role_paths,
      frame_root:        frameManifest.frame_root,
    };
    return { src, slot, manifest, frameManifest, prefabReport, frameRecon, meshes,
      portrait, materialProps, curved, ubertext };
  }
  const manifest = readJson<AssetPack['manifest']>(src, 'manifest.json');
  const plan = readJson<NonNullable<AssetPack['plan']>>(src, 'plan.json');
  const frameRecon = readJson<AssetPack['frameRecon']>(src, 'frame_recon.json');
  const meshes = readJson<AssetPack['meshes']>(src, 'meshes.json');
  const portrait = readJson<AssetPack['portrait']>(src, 'portrait.json');
  const materialProps = readJson<AssetPack['materialProps']>(src, 'material_props.json');
  const curved = readJson<NonNullable<AssetPack['curved']>>(src, 'curved.json');

  // NpzBlank 语义：肖像节点「肖像子网格」清空（肖像走公式模块，不参与帧光栅）。
  // 根目录单帧包（历史 py 产物）均为随从帧，肖像子网格 = sub0。
  const pk = manifest.portrait_node_key;
  if (pk && meshes[pk]?.subs?.[0]) meshes[pk].subs[0] = [];

  return { src, manifest, plan, frameRecon, meshes, portrait, materialProps, curved };
}

/** spells/{key}/（extract_spell.py 产物）装载：层级 + 网格。 */
export function loadSpellOverlay(src: AssetSource, key: string): SpellOverlayPack {
  const d = `spells/${key}`;
  const recon = readJson<{ hierarchy: HierarchyNode }>(src, `${d}/frame_recon.json`)!;
  const meshes = readJson<Record<string, MeshEntry>>(src, `${d}/meshes.json`)!;
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
