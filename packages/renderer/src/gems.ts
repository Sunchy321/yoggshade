/** 宝石族 shader 公式层（_render_stat_gems / _composite_rarity_gem_wrap 对译）。
 * rgb = clouds(uv+t·speed).r · tint.rgb · main.a · 1.5 · intensity + main.rgb，不透明覆盖。 */
import { projectX, projectY, SIZE } from './camera.js';
import { walkWithKey, TextureStore } from './assets.js';
import { sampleBilinearClamp } from './image.js';
import type { AssetPack, MeshEntry, RGBAImage, SpellOverlayPack, StatGem } from './types.js';

const mainS = new Float64Array(4);
const cloudS = new Float64Array(4);
const SPEED_XY: [number, number] = [5.0, 0.2];

function posmod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

function sampleWrap(tex: RGBAImage, u: number, v: number, out: Float64Array): void {
  const { w, h, data } = tex;
  const x = posmod(u * w - 0.5, w);
  const y = posmod((1.0 - v) * h - 0.5, h);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % w;
  const y1 = (y0 + 1) % h;
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
    const b = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/** rgb 缓冲（W*H*3，0..1）上不透明写色。 */
function writeRgb(rgb: Float64Array, x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * SIZE[0] + x) * 3;
  rgb[i] = r;
  rgb[i + 1] = g;
  rgb[i + 2] = b;
}

function projectNode(pack: AssetPack, key: string, world: number[][]) {
  const mesh = pack.meshes[key];
  const M = world;
  const n = mesh.verts.length;
  const px = new Float64Array(n), py = new Float64Array(n), wy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [vx, vy, vz] = mesh.verts[i];
    px[i] = projectX(M[0][0] * vx + M[0][1] * vy + M[0][2] * vz + M[0][3]);
    py[i] = projectY(M[2][0] * vx + M[2][1] * vy + M[2][2] * vz + M[2][3]);
    wy[i] = M[1][0] * vx + M[1][1] * vy + M[1][2] * vz + M[1][3];
  }
  return { mesh, px, py, wy };
}

function nodeByKeyPath(pack: AssetPack, path: string) {
  for (const [n, key, p] of walkWithKey(pack.frameRecon.hierarchy)) {
    if (n.mesh_stats && p === path) return { n, key };
  }
  return null;
}

/** 战棋铸币等 SpellTable 预制里的宝石（StatGem.overlay 非空）：从 overlay 包解析几何。 */
export interface OverlayGemSource {
  packs: SpellOverlayPack[];
  gems:  StatGem[];
}

/** 攻/血/费用三晶体：main clamp 采样，clouds wrap；桶内世界 Y 均值画家序。 */
export function renderStatGems(
  rgb: Float64Array, pack: AssetPack, textures: TextureStore,
  overlay?: OverlayGemSource,
): void {
  const plan = pack.plan!;
  const gems = [...(plan.stat_gems ?? []), ...(overlay?.gems ?? [])];
  if (!plan.gem?.enabled || !gems.length) return;
  const t = plan.gem.t!;
  const clouds = textures.get('GenFX_clouds03.png');
  for (const g of gems) {
    const main = textures.get(g.main_tex_file);
    const [tR, tG, tB] = g.tint_rgb;
    const du = posmod(t * g.speed_xy[0], 1.0);
    const dv = posmod(t * g.speed_xy[1], 1.0);
    let mesh: MeshEntry | undefined;
    let world: number[][] | null | undefined;
    if (g.overlay) {
      const ov = overlay?.packs.find(o => o.key === g.overlay);
      if (!ov) continue;
      for (const [n, key, p] of walkWithKey(ov.hierarchy)) {
        if (n.mesh_stats && p === g.path) {
          mesh = ov.meshes[key];
          world = n.world ?? undefined;
          break;
        }
      }
      if (!mesh || !world) continue;
    } else {
      const hit = nodeByKeyPath(pack, g.path);
      if (!hit) continue;
      mesh = pack.meshes[hit.key];
      world = hit.n.world!;
    }
    const M = world;
    const n = mesh.verts.length;
    const px = new Float64Array(n), py = new Float64Array(n), wy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const [vx, vy, vz] = mesh.verts[i];
      px[i] = projectX(M[0][0] * vx + M[0][1] * vy + M[0][2] * vz + M[0][3]);
      py[i] = projectY(M[2][0] * vx + M[2][1] * vy + M[2][2] * vz + M[2][3]);
      wy[i] = M[1][0] * vx + M[1][1] * vy + M[1][2] * vz + M[1][3];
    }
    const tris = mesh.subs[0];
    const order = tris.map((tri, i) => [tri, i] as const)
      .sort((a, b) =>
        ((wy[a[0][0]] + wy[a[0][1]] + wy[a[0][2]]) - (wy[b[0][0]] + wy[b[0][1]] + wy[b[0][2]])) / 3)
      .map(([tri]) => tri);
    // （几何解析完成后与帧内宝石同公式；见文件头公式注释）
    for (const tri of order) {
      const ia = tri[0], ib = tri[1], ic = tri[2];
      const xs = [px[ia], px[ib], px[ic]];
      const ys = [py[ia], py[ib], py[ic]];
      rasterGemTri(xs, ys, mesh.uv0[ia], mesh.uv0[ib], mesh.uv0[ic], (u, v, x, y) => {
        sampleBilinearClamp(main, u * main.w - 0.5, (1 - v) * main.h - 0.5, mainS);
        sampleWrap(clouds, u * g.scale_xy[0] + du, v * g.scale_xy[1] + dv, cloudS);
        const aMain = mainS[3] * 1.5 * g.intensity;
        const cr = Math.min(Math.max(cloudS[0] * tR * aMain + mainS[0], 0), 1);
        const cg = Math.min(Math.max(cloudS[0] * tG * aMain + mainS[1], 0), 1);
        const cb = Math.min(Math.max(cloudS[0] * tB * aMain + mainS[2], 0), 1);
        writeRgb(rgb, x, y, cr, cg, cb);
      });
    }
  }
}

/** 带 UV 插值 + 像素回调的三角形遍历（宝石/RTT 共用骨架）。 */
function rasterGemTri(
  xs: number[], ys: number[],
  uvA: number[], uvB: number[], uvC: number[],
  cb: (u: number, v: number, x: number, y: number) => void,
): void {
  const W = SIZE[0], H = SIZE[1];
  const xmin = Math.max(Math.floor(Math.min(...xs)), 0);
  const xmax = Math.min(Math.ceil(Math.max(...xs)), W - 1);
  const ymin = Math.max(Math.floor(Math.min(...ys)), 0);
  const ymax = Math.min(Math.ceil(Math.max(...ys)), H - 1);
  if (xmin > xmax || ymin > ymax) return;
  const d = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
  if (Math.abs(d) < 1e-12) return;
  for (let y = ymin; y <= ymax; y++) {
    const gy = y + 0.5;
    for (let x = xmin; x <= xmax; x++) {
      const gx = x + 0.5;
      const l1 = ((gx - xs[0]) * (ys[2] - ys[0]) - (gy - ys[0]) * (xs[2] - xs[0])) / d;
      const l2 = ((xs[1] - xs[0]) * (gy - ys[0]) - (ys[1] - ys[0]) * (gx - xs[0])) / d;
      const l0 = 1.0 - l1 - l2;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const u = l0 * uvA[0] + l1 * uvB[0] + l2 * uvC[0];
      const v = l0 * uvA[1] + l1 * uvB[1] + l2 * uvC[1];
      cb(u, v, x, y);
    }
  }
}

/** 稀有度宝石（wrap 版）：main/clouds 都 Repeat；UV + 图集偏移；三角原序。 */
export function renderRarityGemWrap(
  rgb: Float64Array, pack: AssetPack, textures: TextureStore,
): void {
  const plan = pack.plan!;
  const main = textures.get('GenFX_RarityGems.png');
  const clouds = textures.get('GenFX_clouds03.png');
  const tint = plan.rarity_gem!.tint_rgb!;
  const [offU, offV] = plan.rarity_gem!.atlas_offset!;
  const t = plan.gem!.t!;
  const du = posmod(t * SPEED_XY[0], 1.0);
  const dv = posmod(t * SPEED_XY[1], 1.0);

  const comp = plan.components.find(c => c.node === 'RarityGem' && c.visible);
  if (!comp) return;
  const hit = nodeByKeyPath(pack, comp.path);
  if (!hit) return;
  const { mesh, px, py } = projectNode(pack, hit.key, hit.n.world!);
  for (const tri of mesh.subs[0]) {
    const ia = tri[0], ib = tri[1], ic = tri[2];
    const xs = [px[ia], px[ib], px[ic]];
    const ys = [py[ia], py[ib], py[ic]];
    rasterGemTri(xs, ys, mesh.uv0[ia], mesh.uv0[ib], mesh.uv0[ic], (u, v, x, y) => {
      const uu = u + offU, vv = v + offV;
      sampleWrap(main, uu, vv, mainS);
      sampleWrap(clouds, uu + du, vv + dv, cloudS);
      const aMain = mainS[3] * 1.5;
      const cr = Math.min(Math.max(cloudS[0] * tint[0] * aMain + mainS[0], 0), 1);
      const cg = Math.min(Math.max(cloudS[0] * tint[1] * aMain + mainS[1], 0), 1);
      const cb = Math.min(Math.max(cloudS[0] * tint[2] * aMain + mainS[2], 0), 1);
      writeRgb(rgb, x, y, cr, cg, cb);
    });
  }
}
