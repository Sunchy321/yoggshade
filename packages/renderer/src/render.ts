/** P0 渲染主流程：build_render_list_ally + raster_bucket_zbuf + 肖像公式层（dz_render 对译）。 */
import { projectX, projectY, SIZE } from './camera.js';
import { rasterZbuf, type WatermarkLayer } from './raster.js';
import { renderPortraitSubmesh } from './portrait.js';
import { walkWithKey, TextureStore } from './assets.js';
import { renderStatGems, renderRarityGemWrap, type OverlayGemSource } from './gems.js';
import type { AssetPack, FrameMaterial, HierarchyNode, PlanComponent, RenderPlan, SpellOverlayPack } from './types.js';

interface FrameNode {
  name:      string;
  key:       string;
  materials: (FrameMaterial | null)[];
  world:     number[][];
  comp:      PlanComponent;
  /** 每材质槽混合模式（spell overlay 用；帧路径走 slotPlan.blend）。 */
  blends?:   ('multiply' | 'additive' | 'alpha')[];
}

/** build_render_list_ally：计划可见性过滤 + 宝石三兄弟排除（→ shader 公式层，P1）。
 *  exclude/include：晚通道节点（plan.late_nodes）——主光栅排除、晚通道按序单独纳入。 */
export function buildRenderList(
  hierarchy: HierarchyNode,
  plan: RenderPlan,
  exclude?: Set<string>,
  include?: Set<string>,
): FrameNode[] {
  const visible = new Map<string, PlanComponent>();
  for (const c of plan.components) if (c.visible) visible.set(c.path, c);

  const nodes: FrameNode[] = [];
  for (const [n, key, path] of walkWithKey(hierarchy)) {
    if (!n.mesh_stats) continue;
    const rr = n.renderers ?? [];
    const comp = visible.get(path);
    if (!rr.length || !rr[0].materials?.length) continue;
    if (!comp) continue; // 计划隐藏
    if (comp.raster === false) continue; // 文字载体 / 无材质光栅
    // 晚通道按 include 白名单只画单节点；主通道按 exclude 黑名单跳过晚通道节点
    if (include ? !include.has(n.name) : (exclude !== undefined && exclude.has(n.name))) continue;
    if (n.name === 'Gem_Mana' || n.name === 'Gem_Attack' || n.name === 'Gem_Health') continue;
    nodes.push({ name: n.name, key, materials: rr[0].materials, world: n.world!, comp });
  }
  return nodes;
}

interface BucketTri {
  depth:         number;
  seq:           number;
  tri2d:         number[][];
  triUv:         number[][];
  triZ:          number[];
  texKey:        string;
  tint:          number[];
  uvOffset:      [number, number];
  opaque:        boolean;
  multiply:      boolean;
  additive:      boolean;
  wrap:          boolean;
  /** Effects/FX_Transparent_ColorAsAlpha（卡影）：a=亮度×alphaIntensity、rgb=tex×color、×intensity */
  colorAsAlpha?: { color: number[], intensity: number, alpha_intensity: number };
  /** desc 卡集水印（仅 Description_mesh + 材质 _SecondTex 槽；见装配处注释） */
  wm?:           WatermarkLayer;
  triUv1?:       number[][];
}

/** 水印纹理裁决空串占位（引擎不换纹理 → _SecondTex 保持序列化占位、alpha=0；
 *  1×1 全零 → stA=0 → out=main——desc「main 不乘 _Color」的引擎语义仍生效）。 */
const EMPTY_TEX = { w: 1, h: 1, data: new Uint8ClampedArray(4) };

/** raster_bucket_zbuf：收集全部三角形 → (mean 世界 Y, DFS 序) 排序 → z-buffer 光栅。 */
export function rasterBucketZbuf(
  bucket: FrameNode[],
  pack: AssetPack,
  textures: TextureStore,
  canvas: Float64Array,
  zbuf: Float64Array,
  meshes: AssetPack['meshes'] = pack.meshes,
): number {
  const W = SIZE[0], H = SIZE[1];
  const trisOut: BucketTri[] = [];
  let seq = 0;

  for (const { key, materials: mats, world: M, comp } of bucket) {
    // 网格覆写：Actor 运行期 MeshFilter.sharedMesh 替换（法术学派板 Actor.cs:6174-6185；
    // plan 编译器写入 comp.mesh，键为资产包 meshes 表的 extra/{actor字段}）。
    const mesh = meshes[comp.mesh ?? key];
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
      const slotPlan = (comp.material_slots ?? []).find(s => s.slot === mi) ?? null;
      const texFile = mat.tex?.['_MainTex']?.texture?.file;
      const rtFile = slotPlan?._MainTex_runtime?.file;
      const texKey = rtFile ?? texFile;
      if (!texKey) continue;
      let tint = mat.colors?.['_Color'] ?? [1, 1, 1, 1];
      let uvOffset: [number, number] = [0.0, 0.0];
      const mo = slotPlan?.material_override;
      if (mo?._tint_rgb) tint = [...mo._tint_rgb, 1.0];
      // _MainTex ST：材质序列化值为基础，material_override = 运行时 SetTextureScale/
      // SetTextureOffset 改写同一属性（Faction_Icon 阵营象限、Rune_*_sm 符文象限都走
      // override 整体替换），override 优先、缺省回落序列化值。此前帧路径只施加
      // override，序列化 ST 从未被消费——Multiclass_Ribbon_Shadow（材质 ST
      // (0.53,0.48)/(−0.53,−0.048) 越界采样）曾按 [0,1]² 采整张图集，乘法混合把整块
      // quad 压暗成矩形暗幕（2026-10-07 CFM_621 实测；VS 语义 final_uv = uv×scale+
      // offset 在本文件 spell overlay 路径已有同式先例）。
      const mTex = mat.tex?.['_MainTex'];
      const offSrc = mo?.['_MainTex.offset'] ?? mTex?.offset;
      if (offSrc && (offSrc[0] !== 0 || offSrc[1] !== 0)) uvOffset = [offSrc[0], offSrc[1]];
      // override _MainTex.scale 有值用之（符文图标 Rune_*_sm scale (0.5,0.5)）；逐顶点
      // uv×scale 预变换（Angelia dk 链 raster_bucket_zbuf_uvscale 同语义；lerp(uv·s) ≡
      // lerp(uv)·s 仿射恒等——offset 走 rasterZbuf 既有逐像素通道，不在此重复施加）。
      const stS = mo?.['_MainTex.scale'] ?? mTex?.scale;
      const uvArr = stS && (stS[0] !== 1 || stS[1] !== 1)
        ? uv0.map(([u, v]) => [u * stS[0], v * stS[1]])
        : uv0;

      const tris = mesh.subs[si];
      // desc 卡集水印装配（plan.WatermarkSpec + 材质序列化；Actor.cs:5075-5135 写点对译）：
      // gate = comp.watermark（Description_mesh 组件）× 材质 _SecondTex 槽（BG trinket 的
      // Description_Spell_Combined 无此槽，不命中）。序列化 ST 从材质 _SecondTex 读，
      // 运行时 y（withRace 规则 / hero 保留序列化）由 plan 写点携带（offset_y）。
      let wm: WatermarkLayer | undefined;
      let uv1Arr: number[][] | null = null;
      const secTex = mat.tex?.['_SecondTex'];
      if (comp.watermark && secTex) {
        const scale = secTex.scale ?? [1, 1];
        const serOff = secTex.offset ?? [0, 0];
        wm = {
          tex: comp.watermark.tex_file ? textures.get(comp.watermark.tex_file) : EMPTY_TEX,
          st:  [scale[0] ?? 1, scale[1] ?? 1, serOff[0] ?? 0,
            comp.watermark.offset_y ?? serOff[1] ?? 0],
          tint:  (mat.colors?.['_SecondTint'] ?? [1, 1, 1]).slice(0, 3),
          alpha: comp.watermark.alpha,
          blend: mat.floats?.['_BlendIntensity'] ?? 2.0,
        };
        // mesh 无 UV1 通道 → 回退 uv0（引擎语义：hero desc mesh 无 UV1，采样 =
        // uv0×ST(5,5,−2.01,−0.54)，水印 5× 放大窗可见——参照 AV_205 实证，2026-10-07）
        uv1Arr = mesh.uv1 ?? mesh.uv0;
      } else if (slotPlan?.second_tex_mask && secTex?.texture?.file && mesh.uv1) {
        // Unlit_Portrait 双纹理画窗（plan.second_tex_mask 逐槽显式标记）：_MainTex@UV0 =
        // 画像，_SecondTex@UV1 = 窗内蒙版（白=透、暗环=内圈阴影）。合成 = main×second：
        // second 全不透明（alpha 恒 1）、白处 rgb=1 → 透，等价 alpha=1/blend=1 的水印
        // 合成式 out = a×(main×secondT − main) + main。此前帧光栅忽略 _SecondTex（仅
        // desc 水印走 comp.watermark 门），饰画画窗内圈阴影整环丢失（2026-10-08 BG32
        // 基准对比实证）。其余帧型的 _SecondTex 材质（PortraitFrame_mesh 族）未经基准
        // 验证，不启用。
        wm = {
          tex: textures.get(secTex.texture.file),
          st:  [secTex.scale?.[0] ?? 1, secTex.scale?.[1] ?? 1,
            secTex.offset?.[0] ?? 0, secTex.offset?.[1] ?? 0],
          tint:  [1, 1, 1],
          alpha: 1,
          blend: 1,
        };
        uv1Arr = mesh.uv1;
      }
      for (const t of tris) {
        const a = t[0], b = t[1], c = t[2];
        trisOut.push({
          depth:        (depth[a] + depth[b] + depth[c]) / 3,
          seq:          seq++,
          tri2d:        [[px[a], py[a]], [px[b], py[b]], [px[c], py[c]]],
          triUv:        [uvArr[a], uvArr[b], uvArr[c]],
          triZ:         [depth[a], depth[b], depth[c]],
          texKey, tint, uvOffset,
          opaque:       slotPlan?.opaque ?? false,
          multiply:     slotPlan?.blend === 'multiply',
          additive:     slotPlan?.blend === 'additive',
          wrap:         slotPlan?.wrap_repeat ?? false,
          colorAsAlpha: slotPlan?.blend === 'colorAsAlpha' ? slotPlan.color_as_alpha : undefined,
          wm, triUv1:       uv1Arr ? [uv1Arr[a], uv1Arr[b], uv1Arr[c]] : undefined,
        });
      }
    }
  }

  trisOut.sort((e1, e2) => e1.depth - e2.depth || e1.seq - e2.seq);
  for (const e of trisOut) {
    rasterZbuf(canvas, zbuf, W, H, e.tri2d, e.triZ, e.triUv,
      textures.get(e.texKey), e.tint, e.uvOffset, e.opaque, e.multiply, e.additive, e.wrap,
      e.wm, e.triUv1, e.colorAsAlpha);
  }
  return trisOut.length;
}

/** 肖像层：portrait_mesh_channels + frame_recon 肖像节点世界矩阵 + 引擎公式。
 * 取件口径与 Actor 写点一致：肖像材质/子网格下标 = m_portraitMatIdx（随从/地标=0，法术/英雄/武器=1）。
 * 写死 0 会把肖像框（环，sub0）当肖像画，并用肖像框的贴图顶掉肖像。 */
export function renderPortraitLayer(
  pack: AssetPack,
  textures: TextureStore,
  canvas: Float64Array,
  zbuf: Float64Array,
): void {
  const W = SIZE[0], H = SIZE[1];
  const ch = pack.portrait;
  const portraitMatIdx = pack.manifest.portrait_mat_idx ?? 0;
  const portraitSub = portraitMatIdx === 1 ? ch.sub1 : ch.sub0;
  const portraitNode = [...walkWithKey(pack.frameRecon.hierarchy)]
    .find(([n]) => n.mesh_stats && n.npz_key === pack.manifest.portrait_node_key);
  if (!portraitNode) throw new Error('frame_recon 无肖像节点');
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

  // 肖像材质槽所在节点 = m_portraitMesh 节点本身（上面按 portrait_node_key 已定位），不是节点的名字：
  // 随从/法术/英雄/武器帧叫 PortraitFrame_mesh、地标叫别的名字、英雄技能帧就叫 Mesh
  // （History_HeroPower 的 m_portraitMesh → RootObject/Mesh，三子网格一体）。按名字找会取不到槽。
  const portraitFile = pack.plan!.components
    .find(c => c.path === portraitNode[2])
    ?.material_slots?.find(s => s.slot === portraitMatIdx)?._MainTex_runtime?.file;
  if (!portraitFile) return; // PET 类无原画（引擎 PET 卡型 SetMaterialNormal no-op 同语义）
  const mainRgba = textures.get(portraitFile);
  // 肖像第二通道缺失（饰品帧：肖像槽序列化为空，运行时 CardDef 材质，离线链未取到其
  // _SecondTex/_SecondTint）→ second 全零：w = secS.a·tA = 0 → out = main（纯原画贴窗）。
  // 登记残差：饰品的肖像与窗的二混合未复刻。
  const secondRgba = pack.manifest.second_tex
    ? textures.get(pack.manifest.second_tex)
    : { w: 1, h: 1, data: new Uint8ClampedArray(4) };
  const st = pack.materialProps?.m_Colors._SecondTint;
  renderPortraitSubmesh(
    canvas, zbuf, W, H,
    Array.from(depth), Array.from(px), Array.from(py),
    ch.uv0, ch.uv1, portraitSub,
    mainRgba, secondRgba,
    st ? [st.r, st.g, st.b, st.a] : [0, 0, 0, 0],
    pack.materialProps?.m_Floats._BlendIntensity ?? 0,
  );
}

/** 战棋模板 spell 视觉（SpellTable 实例）渲染：与帧同一 z-buffer/画家序管线。
 *  结构可见性：
 *  - tier 图标（tech-level-gem / tier-icon-timewarp）：Stars/Lv{n} 子树按 tech_level 点亮——
 *    ShowTavernTierSpell 写 FSM 变量 TechLevel 后激活 BIRTH（Actor.cs:7497-7505）；prefab 里
 *    Lv1..Lv7 分组序列化失活（运行时由 FSM SetActive），故 Lv 子树**不受**序列化 active 约束。
 *  - coin（coin-*）：Health_Burst 是 Birth 态瞬闪（静态快照不含）；Gem_Health 本体走宝石公式
 *    （Hero/Diffuse/DiffuseAlphaMaskScroller，与 stat gem 同族）——由 main.ts 收集进 gems 阶段，
 *    此处跳过。Health_Persistant 常驻辉光保留（残差：瞬态/常驻的精确分界待基准对照）。
 *  材质混合：Hero/Multiply/* → multiply；Hero/Additive/* → additive（星芒/辉光）。 */
export function renderSpellOverlays(
  overlays: SpellOverlayPack[],
  plan: RenderPlan,
  textures: TextureStore,
  canvas: Float64Array,
  zbuf: Float64Array,
): void {
  if (!plan.spell_overlays?.length) return;
  for (const spec of plan.spell_overlays) {
    const ov = overlays.find(o => o.key === spec.key);
    if (!ov) throw new Error(`资产包缺 spell overlay: ${spec.key}`);
    const nodes: FrameNode[] = [];
    // 递归携带 Lv 匹配状态（Lv 子树内不受序列化 active 约束）
    const walk = (n: HierarchyNode, key: string, path: string, lvActive: boolean | null): void => {
      const p = path ? `${path}/${n.name}` : n.name;
      const lv = /^Lv(\d+)$/.exec(n.name);
      const selfLv = lv ? Number(lv[1]) === (spec.tech_level ?? 0) : null;
      const active = selfLv !== null ? selfLv : (lvActive ?? n.active_in_hierarchy !== false);
      for (const c of n.children ?? []) walk(c, `${key}.${lv ? 0 : (n.children ?? []).indexOf(c)}`, p, active);
      if (!active || !n.mesh_stats) return;
      // 铸币正面（宝石 shader 族）走 gems 阶段公式；瞬闪（Birth 态）与常驻辉光 quad 不渲染——
      // 它们的锚在铸币上方（FSM 摆位），随锚定平移会让"铸币+辉光"整体比基准圆心偏上。
      if (n.name === 'Health_Burst' || n.name === 'Health_Persistant'
        || n.name === 'Gem_Health' || n.name === 'Gem_Coin') return;
      const rr = n.renderers ?? [];
      if (!rr.length || !rr[0].materials?.length) return;
      nodes.push({ name: n.name, key, materials: rr[0].materials, world: n.world!, comp: { path: p } });
    };
    walk(ov.hierarchy, 'root', '', null);
    // anchor='world-target'：把整个 overlay（含层级本体——铸币正面走 gems 公式，从同一层级取位）
    // 平移到 world_target。参考位 = 层级里 Gem_Health/Gem_Coin 的当前世界平移。
    if (spec.anchor === 'world-target' && spec.world_target) {
      let gemWorld: number[][] | null = null;
      for (const [n] of walkWithKey(ov.hierarchy)) {
        if ((n.name === 'Gem_Health' || n.name === 'Gem_Coin') && n.world) {
          gemWorld = n.world;
          break;
        }
      }
      if (gemWorld) {
        const dx = spec.world_target[0] - gemWorld[0][3];
        const dy = spec.world_target[1] - gemWorld[1][3];
        const dz = spec.world_target[2] - gemWorld[2][3];
        for (const [n] of walkWithKey(ov.hierarchy)) {
          if (!n.world) continue;
          n.world[0][3] += dx;
          n.world[1][3] += dy;
          n.world[2][3] += dz;
        }
      }
    }
    // 材质槽 blend 标记（按 shader 名；见函数头注释）
    for (const nd of nodes) {
      nd.blends = nd.materials.map(mm => {
        if (mm?.shader?.startsWith('Hero/Multiply/')) return 'multiply' as const;
        if (mm?.shader?.startsWith('Hero/Additive/')) return 'additive' as const;
        return 'alpha' as const;
      });
    }
    const meshes = ov.meshes;
    const W = SIZE[0], H = SIZE[1];
    const trisOut: BucketTri[] = [];
    let seq = 0;
    for (const nd of nodes) {
      const mesh = meshes[nd.key];
      if (!mesh) continue;
      const M = nd.world;
      const verts = mesh.verts;
      const n = verts.length;
      const px = new Float64Array(n), py = new Float64Array(n), depth = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const vx = verts[i][0], vy = verts[i][1], vz = verts[i][2];
        const wx = M[0][0] * vx + M[0][1] * vy + M[0][2] * vz + M[0][3];
        const wy = M[1][0] * vx + M[1][1] * vy + M[1][2] * vz + M[1][3];
        const wz = M[2][0] * vx + M[2][1] * vy + M[2][2] * vz + M[2][3];
        px[i] = projectX(wx);
        py[i] = projectY(wz);
        depth[i] = wy;
      }
      const blends = nd.blends ?? [];
      for (let si = 0; si < mesh.subs.length; si++) {
        const mi = Math.min(si, nd.materials.length - 1);
        const mat = nd.materials[mi];
        if (!mat) continue;
        const texFile = mat.tex?.['_MainTex']?.texture?.file;
        if (!texFile) continue;
        const tint = mat.colors?.['_Color'] ?? [1, 1, 1, 1];
        const blend = blends[mi] ?? 'alpha';
        // 材质 _MainTex ST（Unity: final_uv = uv*scale + offset，采样 repeat wrap）。
        // Timewarp 盾 offset=(0,0.475)：mesh v[0.537,0.971] wrap 后 [0.012,0.446] = 图集左下格；
        // 提取侧本就采集 ST（extract_frame walk_material），此前渲染端从未应用。整网格变换后
        // UV 落在同一整数周期内（span<1），逐顶点 fract 不产生接缝。
        const tenv = mat.tex?.['_MainTex'];
        const stS = tenv?.scale, stO = tenv?.offset;
        let uvArr = mesh.uv0;
        if (stS && stO && (stS[0] !== 1 || stS[1] !== 1 || stO[0] !== 0 || stO[1] !== 0)) {
          uvArr = mesh.uv0.map(([u, v]) => {
            const tu = u * stS[0] + stO[0], tv = v * stS[1] + stO[1];
            return [tu - Math.floor(tu), tv - Math.floor(tv)];
          });
        }
        for (const t of mesh.subs[si]) {
          const a = t[0], b = t[1], c = t[2];
          trisOut.push({
            depth:    (depth[a] + depth[b] + depth[c]) / 3,
            seq:      seq++,
            tri2d:    [[px[a], py[a]], [px[b], py[b]], [px[c], py[c]]],
            triUv:    [uvArr[a], uvArr[b], uvArr[c]],
            triZ:     [depth[a], depth[b], depth[c]],
            texKey:   texFile, tint, uvOffset: [0.0, 0.0],
            opaque:   false,
            multiply: blend === 'multiply',
            additive: blend === 'additive',
            wrap:     false,
          });
        }
      }
    }
    trisOut.sort((e1, e2) => e1.depth - e2.depth || e1.seq - e2.seq);
    for (const e of trisOut) {
      rasterZbuf(canvas, zbuf, W, H, e.tri2d, e.triZ, e.triUv,
        textures.get(e.texKey), e.tint, e.uvOffset, e.opaque, e.multiply, e.additive);
    }
  }
}

/** canvas → uint8 RGBA，**直通 alpha 输出**（2026-10-04 用户裁定）：
 *  rgb = 直感色（非预乘）、a = 覆盖率；卡框圆角外等未覆盖像素 = (0,0,0,0) 透明背景。
 *  与游戏内渲染的差异：引擎画到不透明屏幕帧缓冲（无 alpha 概念），exporter 导出 PNG
 *  时对 opaque 几何 alpha-fill、背景清透明——本链对齐的是 exporter 语义，背景透明后
 *  卡片可合成到任意底色；对黑底合成结果与旧「合成到不透明黑底」口径逐位一致
 *  （黑底 out = 直感色×覆盖率）。 */
export function composeToRgba8(canvas: Float64Array): Uint8Array {
  const W = SIZE[0], H = SIZE[1];
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const ci = i * 4;
    for (let c = 0; c < 3; c++) {
      const rgb = Math.min(Math.max(canvas[ci + c], 0), 1);
      out[ci + c] = Math.round(rgb * 255);
    }
    out[ci + 3] = Math.round(Math.min(Math.max(canvas[ci + 3], 0), 1) * 255);
  }
  return out;
}

/** canvas 覆盖率 → float alpha 平面（0..1）。P1/P2 的宝石/文字阶段只消费直感 RGB（丢 alpha），
 *  但宝石是「不透明覆盖」、文字是 over 合成——两者都在卡框轮廓外有投影（凸出卡角的费用/
 *  攻/血宝石、宝石上的费用数字），覆盖率必须随绘制同步累加，最终与 RGB 拼合输出透明背景。 */
export function alphaPlane(canvas: Float64Array): Float64Array {
  const out = new Float64Array(SIZE[0] * SIZE[1]);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(Math.max(canvas[i * 4 + 3], 0), 1);
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

/** P1：宝石两段（含段间 uint8 量化口径），返回直感 RGB buffer。
 *  alpha：覆盖率平面（alphaPlane 产出），宝石覆盖处按「不透明覆盖」语义置 1。 */
export function renderGemsStage(
  canvas: Float64Array, pack: AssetPack, textures: TextureStore,
  overlayGems?: OverlayGemSource,
  alpha?: Float64Array,
): Float64Array {
  const rgb = canvasToQuantRgb(canvas);
  renderStatGems(rgb, alpha, pack, textures, overlayGems);
  quantTrunc(rgb);
  if (pack.plan!.rarity_gem?.visible) {
    renderRarityGemWrap(rgb, alpha, pack, textures);
    quantTrunc(rgb);
  }
  return rgb;
}

/** RGB float buffer → uint8 RGBA（trunc，对齐 py astype(uint8)）。
 *  alpha：覆盖率平面（0..1，round 量化输出）则直通（透明背景），缺省 = 全不透明（旧口径）。 */
export function rgbToRgba8(rgb: Float64Array, alpha?: Float64Array): Uint8Array {
  const W = SIZE[0], H = SIZE[1];
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.trunc(Math.min(Math.max(rgb[i * 3 + c], 0), 1) * 255);
    }
    out[i * 4 + 3] = alpha
      ? Math.round(Math.min(Math.max(alpha[i], 0), 1) * 255)
      : 255;
  }
  return out;
}
