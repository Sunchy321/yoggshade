/** UberText 渲染主流程（uber_text.render_text / _render_rtt + ally 版装载器对译）。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PX_PER_UNIT, HALF_W, HALF_H, SIZE } from './camera.js';
import { FontMetrics, PackFontMetrics, type FontMetricsLike } from './font.js';
import { glyphRgba, composite, pyRound } from './glyph.js';
import { resampleImage } from './resize.js';
import { layoutText, BOLD_SIZE_CAP, type Layout } from './textlayout.js';
import { walkWithKey } from './assets.js';
import type { AssetPack, HierarchyNode } from './types.js';

export interface Scene {
  s: number; wx0: number; wz1: number; ox: number; oy: number;
}

export function makeScene(): Scene {
  // dz_render：自然映射相机（scene 常量直接取 sc.*，零偏移）
  return { s: PX_PER_UNIT, wx0: -HALF_W, wz1: HALF_H, ox: 0.0, oy: 0.0 };
}

function project(scene: Scene, wx: number, wz: number): [number, number] {
  return [(wx - scene.wx0) * scene.s + scene.ox, (scene.wz1 - wz) * scene.s + scene.oy];
}

export interface NodeSettings {
  fields:      Record<string, unknown>;
  worldPos:    [number, number, number];
  localScale:  number;
  fontdefName: string;
}

export interface FontDef {
  fields:  Record<string, number>;
  ttfPath: string;
}

interface UberTextNode { path: string, fields?: Record<string, unknown>, font_name?: string }

function loadUberTextNodes(pack: AssetPack): UberTextNode[] {
  const p = join(pack.dir, 'prefab_ubertext_ally.json');
  const data = JSON.parse(readFileSync(p, 'utf-8')) as { nodes: UberTextNode[] };
  return data.nodes;
}

export function loadFontdef(pack: AssetPack, name: string): FontDef {
  const data = JSON.parse(readFileSync(join(pack.dir, 'fontdefs.json'), 'utf-8'));
  const side = data['fontdefs'][name]['zhcn'];
  return { fields: side['fontdef'], ttfPath: join(pack.dir, side['font_object']['saved_to']) };
}

/** Ally 版节点装载：Underwear Flip=0 且 Left/RightBounds 未序列化 → 置 0（UB:2589-2602 推导）。 */
export function loadNodeSettingsAlly(pack: AssetPack): Record<string, NodeSettings> {
  const nodes = loadUberTextNodes(pack);
  const worldByPath = new Map<string, number[][]>();
  const rec = function* (n: HierarchyNode, key: string, path: string): Generator<[string, number[][]]> {
    const p = path ? `${path}/${n.name}` : n.name;
    const w = n.world;
    if (w) yield [p, w];
    let i = 0;
    for (const c of n.children ?? []) {
      yield* rec(c, `${key}.${i}`, p);
      i++;
    }
  };
  for (const [p, w] of rec(pack.frameRecon.hierarchy, 'root', '')) worldByPath.set(p, w);

  const out: Record<string, NodeSettings> = {};
  const rolePaths = pack.manifest.role_paths!;
  const frameRoot = pack.manifest.frame_root as string;
  for (const [role, suffix] of Object.entries(rolePaths)) {
    const node = nodes.find(n => n.path.endsWith(suffix))!;
    const w = worldByPath.get(`${frameRoot}/${suffix}`)!;
    const colNorm = (j: number) =>
      Math.hypot(w[0][j], w[1][j], w[2][j]);
    const scale = (colNorm(0) + colNorm(1) + colNorm(2)) / 3;
    const fields: Record<string, unknown> = { ...node.fields };
    if (fields['m_Underwear'] && !fields['m_UnderwearFlip']
      && !('m_UnderwearLeftBounds' in fields)) {
      fields['m_Underwear'] = 0;
    }
    out[role] = {
      fields,
      worldPos:    [w[0][3], w[1][3], w[2][3]],
      localScale:  scale,
      fontdefName: node.font_name!,
    };
  }
  return out;
}

function localeAdjustment(fields: Record<string, unknown>): Record<string, number> {
  const ls = fields['m_LocalizedSettings'] as { m_LocaleAdjustments?: { m_Locale?: number }[] } | undefined;
  for (const adj of ls?.m_LocaleAdjustments ?? []) {
    if (adj?.m_Locale === 9) return adj as Record<string, number>;
  }
  return {};
}

const fmCache = new Map<string, FontMetricsLike>();
/** 字形后端注入点（实验用）：explore/ 驱动脚本可设 globalThis.__fontBackendFactory
 * 覆盖光栅化实现（如 text-shaper / freetype-wasm），返回 null 走默认链（缓存→自研）。 */
type FontBackendFactory = (ttfPath: string, fs: number, fallback: FontMetricsLike) => FontMetricsLike | null;
function getFontMetrics(pack: AssetPack, ttfPath: string, fs: number): FontMetricsLike {
  const key = `${ttfPath}:${fs}`;
  let fm = fmCache.get(key);
  if (!fm) {
    const raster = new FontMetrics(ttfPath, fs);
    const injected = (globalThis as { __fontBackendFactory?: FontBackendFactory }).__fontBackendFactory
      ?.(ttfPath, fs, raster) ?? null;
    if (injected) {
      fm = injected;
    } else {
      const stem = ttfPath.split('/').pop()!.replace(/\.(ttf|otf)$/i, '');
      const glyphDir = join(pack.dir, 'glyphs', `${stem}-${fs}`);
      const hasMeta = existsSync(join(glyphDir, 'meta.json'));
      fm = hasMeta ? new PackFontMetrics(glyphDir, stem, fs, raster) : raster;
    }
    fmCache.set(key, fm);
  }
  return fm;
}

function quantTruncBuf(buf: Float64Array): void {
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.trunc(Math.min(Math.max(buf[i], 0), 1) * 255) / 255;
  }
}

interface RGBAImage { w: number, h: number, data: Float64Array }
type Fill = [number, number, number];
type Outline = { r: number, color: Fill } | null;

function color3(c: unknown): Fill {
  const o = c as { r: number, g: number, b: number };
  return [o.r, o.g, o.b];
}

/** 渲染一个 UberText 节点文字层（canvas 尺寸 RGBA，uint8 级量化）。 */
export function renderText(
  pack: AssetPack,
  text: string,
  ns: NodeSettings,
  scene: Scene,
  offset: [number, number],
  curved: AssetPack['curved'],
  supersample = 4,
): RGBAImage {
  const f = (key: string, d: number | null = null): number | null =>
    typeof ns.fields[key] === 'number' ? (ns.fields[key] as number) : d;
  const locale = localeAdjustment(ns.fields);
  const fd = loadFontdef(pack, ns.fontdefName);
  const fs = Math.trunc((fd.fields['m_FontSizeModifier'] ?? 1)
    * (locale['m_FontSizeModifier'] ?? 1) * (f('m_FontSize') ?? 0));
  const fm = getFontMetrics(pack, fd.ttfPath, fs);
  const layout: Layout = layoutText({ fields: ns.fields, locale, fontdef: fd.fields, fm, text });

  const fill = color3(ns.fields['m_TextColor']);
  let outline: Outline = null;
  if (f('m_Outline')) {
    const r = (f('m_OutlineSize') ?? 0) * (fd.fields['m_OutlineModifier'] ?? 1)
      * (locale['m_OutlineModifier'] ?? 1);
    outline = { r, color: color3(ns.fields['m_OutlineColor']) };
  }
  const hasBold = layout.lines.some(row => row.some(g => g.bold));
  const boldPx = hasBold ? Math.min(f('m_BoldSize') ?? 0, BOLD_SIZE_CAP) : 0;

  if (f('m_RenderToTexture')) {
    if (!curved) throw new Error('m_RenderToTexture=1 需要 curved mesh');
    return renderRtt(layout, fm, ns, scene, fill, outline, boldPx, curved, offset);
  }

  const W = SIZE[0], H = SIZE[1];
  const ss = supersample;
  const buf = new Float64Array(H * ss * W * ss * 4);
  const kPx = layout.k * ns.localScale * scene.s * ss;
  const [cx0, cy0] = project(scene, ns.worldPos[0], ns.worldPos[2]);
  const cx = (cx0 + offset[0]) * ss;
  const cy = (cy0 + offset[1]) * ss;
  const nsScaleS = ns.localScale * scene.s * ss;
  const pitchC = layout.pitch * nsScaleS;
  const boxHC = layout.boxH * nsScaleS;
  const descentC = fm.descent * kPx;
  for (let li = 0; li < layout.lines.length; li++) {
    const pen0 = cx - (layout.lineWidths[li] * nsScaleS) / 2.0;
    const baseline = cy - boxHC / 2.0 + (li + 1) * pitchC + descentC;
    for (const g of layout.lines[li]) {
      const { info, mask } = fm.charInfo(g.ch);
      const g4 = glyphRgba(mask, info, kPx, fill, outline, g.bold ? boldPx : 0,
        outline ? outline.r * ss : 0.0);
      const px = pyRound(pen0 + g.penX * nsScaleS - g4.ox);
      const py = pyRound(baseline - g4.oy);
      composite(buf, W * ss, H * ss, g4.data, g4.w, g4.h, px, py);
    }
  }
  quantTruncBuf(buf);
  const out = resampleImage(buf, W * ss, H * ss, 4, W, H, 'lanczos', true);
  return { w: W, h: H, data: out };
}

/** RenderToTexture：文字排进 RT（ss=2 + LANCZOS 降采样），弯文本网格 UV 采样贴回卡面。 */
function renderRtt(
  layout: Layout, fm: FontMetricsLike, ns: NodeSettings, scene: Scene,
  fill: Fill, outline: Outline, boldPx: number,
  mesh: NonNullable<AssetPack['curved']>, off: [number, number],
): RGBAImage {
  const f = (key: string, d: number | null = null): number | null =>
    typeof ns.fields[key] === 'number' ? (ns.fields[key] as number) : d;
  const res = f('m_Resolution') ?? 0;
  const wBox = f('m_Width') ?? 0, hBox = f('m_Height') ?? 0;
  let rtW: number, rtH: number;
  if (wBox > hBox) {
    rtW = Math.trunc(res);
    rtH = Math.trunc(res * (hBox / wBox));
  } else {
    rtW = Math.trunc(res * (wBox / hBox));
    rtH = Math.trunc(res);
  }
  const rtSs = 2;
  const q = (rtW / wBox) * ns.localScale * rtSs;
  const kRt = q * layout.k;
  const rtw = rtW * rtSs, rth = rtH * rtSs;
  // 描边半径单位换算：m_OutlineSize = 最终画布 texel；网格画布宽 / (rtW×rtSs) = 画布 px/缓冲 px
  const Mw = mesh.world;
  let wxMin = Infinity, wxMax = -Infinity;
  for (const v of mesh.verts) {
    const wx = Mw[0][0] * v[0] + Mw[0][1] * v[1] + Mw[0][2] * v[2] + Mw[0][3];
    if (wx < wxMin) wxMin = wx;
    if (wx > wxMax) wxMax = wx;
  }
  const meshCanvasW = (wxMax - wxMin) * scene.s;
  const radiusOut = outline ? outline.r * rtW * rtSs / meshCanvasW : 0.0;
  const rt = new Float64Array(rth * rtw * 4);
  const cx = rtw / 2.0, cy = rth / 2.0;
  const pitchC = layout.pitch * q;
  const boxHC = layout.boxH * q;
  const descentC = fm.descent * kRt;
  for (let li = 0; li < layout.lines.length; li++) {
    const pen0 = cx - (layout.lineWidths[li] * q) / 2.0;
    const baseline = cy - boxHC / 2.0 + (li + 1) * pitchC + descentC;
    for (const g of layout.lines[li]) {
      const { info, mask } = fm.charInfo(g.ch);
      const g4 = glyphRgba(mask, info, kRt, fill, outline, g.bold ? boldPx : 0, radiusOut);
      composite(rt, rtw, rth, g4.data, g4.w, g4.h,
        pyRound(pen0 + g.penX * q - g4.ox), pyRound(baseline - g4.oy));
    }
  }
  quantTruncBuf(rt);
  const rtArr = resampleImage(rt, rtw, rth, 4, rtW, rtH, 'lanczos', true);

  const W = SIZE[0], H = SIZE[1];
  const layer = new Float64Array(H * W * 4);
  const M = mesh.world;
  const n = mesh.verts.length;
  const pxs = new Float64Array(n), pys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [vx, vy, vz] = mesh.verts[i];
    const wx = M[0][0] * vx + M[0][1] * vy + M[0][2] * vz + M[0][3];
    const wz = M[2][0] * vx + M[2][1] * vy + M[2][2] * vz + M[2][3];
    pxs[i] = (wx - scene.wx0) * scene.s + scene.ox + off[0];
    pys[i] = (scene.wz1 - wz) * scene.s + scene.oy + off[1];
  }
  const uv = mesh.uv0;
  for (const tri of mesh.tris) {
    const ia = tri[0], ib = tri[1], ic = tri[2];
    const xs = [pxs[ia], pxs[ib], pxs[ic]];
    const ys = [pys[ia], pys[ib], pys[ic]];
    const xmin = Math.max(Math.floor(Math.min(...xs)), 0);
    const xmax = Math.min(Math.ceil(Math.max(...xs)), W - 1);
    const ymin = Math.max(Math.floor(Math.min(...ys)), 0);
    const ymax = Math.min(Math.ceil(Math.max(...ys)), H - 1);
    if (xmin > xmax || ymin > ymax) continue;
    const d = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
    if (Math.abs(d) < 1e-12) continue;
    for (let y = ymin; y <= ymax; y++) {
      const gy = y + 0.5;
      for (let x = xmin; x <= xmax; x++) {
        const gx = x + 0.5;
        const l1 = ((gx - xs[0]) * (ys[2] - ys[0]) - (gy - ys[0]) * (xs[2] - xs[0])) / d;
        const l2 = ((xs[1] - xs[0]) * (gy - ys[0]) - (ys[1] - ys[0]) * (gx - xs[0])) / d;
        const l0 = 1.0 - l1 - l2;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const u = l0 * uv[ia][0] + l1 * uv[ib][0] + l2 * uv[ic][0];
        const v = l0 * uv[ia][1] + l1 * uv[ib][1] + l2 * uv[ic][1];
        const col = Math.min(Math.max(u * rtW - 0.5, 0), rtW - 1);
        const rw = Math.min(Math.max((1.0 - v) * rtH - 0.5, 0), rtH - 1);
        const x0 = Math.floor(col), y0 = Math.floor(rw);
        const x1 = Math.min(x0 + 1, rtW - 1), y1 = Math.min(y0 + 1, rtH - 1);
        const fx = col - x0, fy = rw - y0;
        const di = (y * W + x) * 4;
        const src: number[] = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) {
          const c00 = rtArr[(y0 * rtW + x0) * 4 + c], c10 = rtArr[(y0 * rtW + x1) * 4 + c];
          const c01 = rtArr[(y1 * rtW + x0) * 4 + c], c11 = rtArr[(y1 * rtW + x1) * 4 + c];
          src[c] = c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy)
            + c01 * (1 - fx) * fy + c11 * fx * fy;
        }
        const sa = src[3], da = layer[di + 3];
        const outA = sa + da * (1 - sa);
        const safe = outA > 1e-6 ? outA : 1.0;
        for (let c = 0; c < 3; c++) {
          layer[di + c] = (src[c] * sa + layer[di + c] * da * (1 - sa)) / safe;
        }
        layer[di + 3] = outA;
      }
    }
  }
  quantTruncBuf(layer);
  return { w: W, h: H, data: layer };
}

/** 只导出 walkWithKey 供外部复用（frame hierarchy 上按 npz_key 查节点）。 */
export { walkWithKey };
