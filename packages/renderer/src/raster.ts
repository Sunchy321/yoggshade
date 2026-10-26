/** z-buffer 三角光栅化（dz_render.raster_zbuf 逐行对译）。 */
import type { RGBAImage } from './types.js';
import { sampleBilinearClamp } from './image.js';

const scratch = new Float64Array(4);
const scratchW = new Float64Array(4);
const scratchMain = new Float64Array(4);

/** desc 卡集水印第二纹理参数（Unlit_2Texture2uv；plan.WatermarkSpec + 材质序列化合成，
 *  见 render.ts rasterBucketZbuf 的 wm 装配）。UV1 几何随 triUv1 传参。 */
export interface WatermarkLayer {
  tex:   RGBAImage;
  /** _SecondTex_ST：(scale.x, scale.y, 运行时 offset.x, 运行时 offset.y)。
   *  VS：o1.zw = UV1×_SecondTex_ST（插值仿射 → 逐像素施加等价）。 */
  st:    [number, number, number, number];
  /** _SecondTint.rgb（材质序列化；.a 由运行时写点替代 → alpha 字段） */
  tint:  number[];
  /** 运行时 _SecondTint.a（99/128 或 0） */
  alpha: number;
  /** _BlendIntensity（材质序列化，2.0） */
  blend: number;
}

/** Hero/Diffuse/DiffuseAlphaMaskScroller front pass (gem material properties + plan time). */
export interface DiffuseAlphaMaskScrollerLayer {
  clouds:    RGBAImage;
  tint:      number[];
  intensity: number;
  fade:      number[];
  tintColor: number[];
  scale:     [number, number];
  speed:     [number, number];
  time:      number;
}

/** Selected Signature_25 Hero/Unlit/Unlit_Transparent2uvScrollMaskScroll forward pass. */
export interface Signature25GlassLayer {
  main:      RGBAImage;
  mask:      RGBAImage;
  mainSt:    [number, number, number, number];
  color:     number[];
  intensity: number;
  uniforms:  Record<string, number>;
}

/** Custom/Card/UnlitTextureReflection pass (golden premium frame). The VS-produced reflection UV
 *  is interpolated per triangle; the FS samples SpecTex and ReflTex with repeat/bilinear samplers. */
export interface TextureReflectionLayer {
  spec: RGBAImage;
  reflection: RGBAImage;
  intensity: number;
}

const scratchCloud = new Float64Array(4);

/** Unity sampler Repeat with bilinear texel-center coordinates. */
function sampleBilinearRepeat(tex: RGBAImage, u: number, v: number, out: Float64Array): void {
  const x = ((u * tex.w - 0.5) % tex.w + tex.w) % tex.w;
  const y = (((1 - v) * tex.h - 0.5) % tex.h + tex.h) % tex.h;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % tex.w, y1 = (y0 + 1) % tex.h;
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = tex.data[(y0 * tex.w + x0) * 4 + c]! / 255 * (1 - fx)
      + tex.data[(y0 * tex.w + x1) * 4 + c]! / 255 * fx;
    const b = tex.data[(y1 * tex.w + x0) * 4 + c]! / 255 * (1 - fx)
      + tex.data[(y1 * tex.w + x1) * 4 + c]! / 255 * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/**
 * 单三角形：barycentric 覆盖（eps -1e-6）→ 世界 Y 深度插值 → LEqual(>=) z-test →
 * 双线性采样（uv + uvOffset）→ tint → 直感 alpha 合成（premultiplied 口径）→ 写色写深。
 * canvas: H*W*4 float64；zbuf: H*W float64（-Inf = 未覆盖）。
 *
 * opaque=true：按不透明绘制（忽略纹理 alpha，写入 alpha=1）。用于官方 opaque-edge 名单材质
 * （地标框体/描述框、符文、铸造/备战/可交易横幅、多职业绶带）——游戏渲染到不透明屏幕帧缓冲，
 * 这些材质的 DXT5 alpha 是形状蒙版而非透明度（见 exporter docs/opaque-edge-alpha-repair-decompile.md）；
 * 离线链若照纹理 alpha 混合，会抠出透明洞让卡背平面透出来。
 *
 * multiply=true：乘法混合（Hero/Multiply/*，见 types.PlanSlot.blend）。FS 输出 rgb=_MainTex.rgb+COLOR0.rgb、
 * a=0；VS 的 COLOR0=顶点色×_Color（本仓网格无顶点色 → 白 → COLOR0=_Color）。
 *
 * colorAsAlpha 存在：卡影（Effects/FX_Transparent_ColorAsAlpha，types.PlanSlot.color_as_alpha）。
 * FS 反编译（Effects_FX_Transparent_ColorAsAlpha_FS.metal 逐指令）：
 *   a  = dot((0.3, 0.59, 0.11), tex.rgb) × _AlphaIntensity；
 *   rgb = tex.rgb × _Color.rgb；整体再 ×_Intensity。黑影、亮度即透明度（alpha-over 合成）。
 *
 * wm 存在：desc 卡集水印 pass（Unlit_2Texture2uv PS 逐指令；textless-align findings §1）：
 *   second_t = _SecondTex@UV1 × _SecondTint × _BlendIntensity；
 *   out = second_t.a×(main×second_t − main) + main（rgb/a 同式）；
 *   尾 min(out,(out+0.15)×COLOR0) 恒 no-op（color0 全白 + _Color≤1 → 阈值 ≥1.446 > 1，
 *   逐指令证明）。**main 不乘 _Color**（PS 从不乘；location 0.906 灰 tint 是旧离线偏差）。
 *   合成寄生于 desc 三角形自身光栅（同一 tri2d/triZ/zbuf）——desc 可见域即水印写域，
 *   引擎 pass One/Zero 纯替换语义由「写合成后 src」达成，混合路径与 alpha/zbuf 行为不变。
 */
export function rasterZbuf(
  canvas: Float64Array,
  zbuf: Float64Array,
  W: number,
  H: number,
  tri2d: number[][], // [3][2] 屏幕坐标
  triZ: number[], // [3] 世界 Y 深度
  triUv: number[][], // [3][2] UV
  tex: RGBAImage,
  tint: number[], // [4]
  uvOffset: [number, number],
  opaque = false,
  multiply = false,
  additive = false,
  wrapRepeat = false, // _MainTex wrap=repeat（引擎材质默认；缺省 clamp，见 PlanSlot.wrap_repeat）
  wm?: WatermarkLayer, // desc 水印第二纹理（见函数头注释）
  triUv1?: number[][], // [3][2] UV1（水印采样通道；与 triUv 同层级几何）
  colorAsAlpha?: { color: number[], intensity: number, alpha_intensity: number }, // 卡影（见函数头注释）
  premultiplied = false, // 预乘透明（Blend One OneMinusSrcAlpha，见 types.PlanSlot.premultiplied）
  skipDepthTest = false, // 跳过深度测试（见 types.PlanSlot.skip_depth_test）
  diffuseAlphaMaskScroller?: DiffuseAlphaMaskScrollerLayer,
  triCloudUv?: number[][],
  signature25Glass?: Signature25GlassLayer,
  writeDepth = true,
  textureReflection?: TextureReflectionLayer,
  triReflectionUv?: number[][],
): void {
  const x0s = tri2d[0][0], y0s = tri2d[0][1];
  const x1s = tri2d[1][0], y1s = tri2d[1][1];
  const x2s = tri2d[2][0], y2s = tri2d[2][1];
  const xmin = Math.max(Math.floor(Math.min(x0s, x1s, x2s)), 0);
  const xmax = Math.min(Math.ceil(Math.max(x0s, x1s, x2s)), W - 1);
  const ymin = Math.max(Math.floor(Math.min(y0s, y1s, y2s)), 0);
  const ymax = Math.min(Math.ceil(Math.max(y0s, y1s, y2s)), H - 1);
  if (xmin > xmax || ymin > ymax) return;

  const d = (x1s - x0s) * (y2s - y0s) - (x2s - x0s) * (y1s - y0s);
  if (Math.abs(d) < 1e-12) return;

  const tw = tex.w, th = tex.h;
  const u0 = triUv[0][0], v0 = triUv[0][1];
  const u1 = triUv[1][0], v1 = triUv[1][1];
  const u2 = triUv[2][0], v2 = triUv[2][1];
  const cu0 = triCloudUv?.[0][0] ?? u0, cv0 = triCloudUv?.[0][1] ?? v0;
  const cu1 = triCloudUv?.[1][0] ?? u1, cv1 = triCloudUv?.[1][1] ?? v1;
  const cu2 = triCloudUv?.[2][0] ?? u2, cv2 = triCloudUv?.[2][1] ?? v2;
  const tr = tint[0], tg = tint[1], tb = tint[2], ta = tint[3];
  // wm 每三角形固定项（UV1 三顶点 / ST）；见函数头注释的水印 pass 语义
  const wu0 = triUv1?.[0][0] ?? 0, wv0 = triUv1?.[0][1] ?? 0;
  const wu1 = triUv1?.[1][0] ?? 0, wv1 = triUv1?.[1][1] ?? 0;
  const wu2 = triUv1?.[2][0] ?? 0, wv2 = triUv1?.[2][1] ?? 0;
  const wsx = wm?.st[0] ?? 1, wsy = wm?.st[1] ?? 1, wox = wm?.st[2] ?? 0, woy = wm?.st[3] ?? 0;

  for (let y = ymin; y <= ymax; y++) {
    const gy = y + 0.5;
    for (let x = xmin; x <= xmax; x++) {
      const gx = x + 0.5;
      const l1 = ((gx - x0s) * (y2s - y0s) - (gy - y0s) * (x2s - x0s)) / d;
      const l2 = ((x1s - x0s) * (gy - y0s) - (y1s - y0s) * (gx - x0s)) / d;
      const l0 = 1.0 - l1 - l2;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const z = l0 * triZ[0] + l1 * triZ[1] + l2 * triZ[2];
      const pi = y * W + x;
      // skipDepthTest：引擎 zbuf 只含不透明写入的几何（Transparent 材质 ZWrite Off），本链帧光栅
      // 对透明材质也写深度（既有简化）→ 该类槽需显式跳过（例：佣兵旗影，见 PlanSlot 注释）。
      if (!skipDepthTest && !(z >= zbuf[pi])) continue;

      const u = l0 * u0 + l1 * u1 + l2 * u2 + uvOffset[0];
      const v = l0 * v0 + l1 * v1 + l2 * v2 + uvOffset[1];
      const ci = pi * 4;
      // wrap=repeat（Unity _MainTex 默认）：ST 后逐像素取分数部分。多职业绶带阴影的材质
      // ST（scale 0.53/0.48, offset −0.53/−0.048）使采样越过 0 边界，clamp 会拉出边缘条纹；
      // 引擎 repeat 语义 = fract。逐顶点预 fract 不可行（三角形跨缝插值会横穿整张图）。
      if (textureReflection && triReflectionUv) {
        // Golden premium shader pass 0 is Blend One/Zero, ZWrite On, ZTest LEqual (UnityPy
        // probe: Angelia lab/2026-10-23-gold-frame-phase/NOTES.md §1). Its decompiled Metal FS
        // samples SpecTex@UV0 and ReflTex@VS reflection UV, then writes
        // sat(MainTex + 0.5 * SpecTex * ReflTex * _ReflectionIntensity) * COLOR0. The VS
        // COLOR0 is exactly white for this prefab's serialized _LightingBlend=0. Sources:
        // explore/2026-10-26-golden-stage-b/output/shader/Custom_Card_UnlitTextureReflection_
        // {VS,FS}_nokw.metal:91-102 / 46-52; frame_recon material settings record Repeat+Bilinear.
        sampleBilinearRepeat(tex, u, v, scratch);
        const ru = l0 * triReflectionUv[0]![0]! + l1 * triReflectionUv[1]![0]!
          + l2 * triReflectionUv[2]![0]!;
        const rv = l0 * triReflectionUv[0]![1]! + l1 * triReflectionUv[1]![1]!
          + l2 * triReflectionUv[2]![1]!;
        sampleBilinearRepeat(textureReflection.spec, u, v, scratchW);
        sampleBilinearRepeat(textureReflection.reflection, ru, rv, scratchCloud);
        for (let c = 0; c < 3; c++) {
          canvas[ci + c] = Math.min(Math.max(scratch[c]!
            + 0.5 * scratchW[c]! * scratchCloud[c]! * textureReflection.intensity, 0), 1);
        }
        const reflectedAlpha = Math.min(Math.max(scratch[3]!
          + 0.5 * scratchW[3]! * scratchCloud[3]! * textureReflection.intensity, 0), 1);
        // The reflection pass returns early, so it must carry the plan's opaque-edge repair itself.
        // For JAIL_887, Mesh submesh 0 uses Card_InHand_Location_Class_Premium.png and is marked
        // opaque by markOpaqueEdgeSlots; otherwise its atlas mask alpha (191 at output pixel 85,500)
        // leaks through the transparent PNG, darkening the left outer frame against black. The
        // exporter selects opaque-edge geometry by renderer/material/texture name and runs its
        // Custom/AlphaFillOpaque pass (ExporterController.cs:7578, 8225-8227, 8303-8308; see also
        // docs/findings/five-cardtypes-frame-parity-2026-10-03.md §3). Preserve reflected RGB while
        // emitting alpha=1 for slots already proven opaque by that game-side rule.
        canvas[ci + 3] = opaque ? 1 : reflectedAlpha;
        if (writeDepth) zbuf[pi] = z;
        continue;
      }
      const uu = wrapRepeat ? u - Math.floor(u) : u;
      const vv = wrapRepeat ? v - Math.floor(v) : v;
      sampleBilinearClamp(tex, uu * tw - 0.5, (1.0 - vv) * th - 0.5, scratch);
      if (signature25Glass) {
        // RLK_706 previously sampled only MainTex@UV0 with generic texture alpha, losing the
        // glass mask and the name-banner end caps. Replay the selected shader pass from
        // Hero_Unlit_Unlit_Transparent2uvScrollMaskScroll_{VS,FS}_nokw.metal: VS lines 116-132
        // builds the UV0/UV1 streams; FS lines 67-75 computes mask alpha and MainTex RGB.
        // RenderCommandLists.cs::AppendRenderCommands (49-54, 187-204) selects SRPDefaultUnlit;
        // the actual pass 0 in essential_base_global-shader-0.unity3d is SrcAlpha/OneMinusSrcAlpha,
        // ZTest LEqual, ZWrite Off (GlowPrePass/Glow are not part of this RTT). Offline pixels are
        // rasterized as straight RGBA, so apply the pass's factors to all four framebuffer channels.
        // Asset probe `assets/frames/hand-minion-sig1/frame_recon.json`, Transluscent_Mesh records
        // `_Intensity=1.1`, `_Color=(1,1,1,1)`, `_LightingBlend=0`, the other uniforms, and both
        // textures; texture settings are Bilinear + Repeat. Its source mesh has no COLOR stream.
        const p = signature25Glass.uniforms;
        const val = (name: string, fallback: number): number => p[name] ?? fallback;
        const t = 0; // approved signature-frames spec freezes VGlobals._Time.x at zero
        const baseU = u, baseV = v; // triUv is UV0 transformed by _MainTex_ST
        const uv1U = l0 * wu0 + l1 * wu1 + l2 * wu2;
        const uv1V = l0 * wv0 + l1 * wv1 + l2 * wv2;
        const [stX, stY, stU, stV] = signature25Glass.mainSt;
        const gU = uv1U * stX + stU + t * val('_ScrollGMaskX', 0);
        const gV = uv1V * stY + stV + t * val('_ScrollGMaskY', 0);
        const modU = baseU * val('_ScaleModX', 1) + t * val('_ScrollModX', 0) + val('_Seed', 0);
        const modV = baseV * val('_ScaleModY', 1) + t * val('_ScrollModY', 0) + val('_Seed', 0);
        const maskU = (baseU + val('_UVOffsetModMaskU', 0)) * val('_ScaleMaskX', 1)
          + t * val('_ScrollMaskX', 0) + val('_Seed', 0);
        const maskV = (baseV + val('_UVOffsetModMaskV', 0)) * val('_ScaleMaskY', 1)
          + t * val('_ScrollMaskY', 0) + val('_Seed', 0);
        const mainU = baseU * val('_ScaleMainX', 1) + t * val('_ScrollMainX', 0)
          + val('_UVOffsetMainU', 0);
        const mainV = baseV * val('_ScaleMainX', 1) + t * val('_ScrollMainY', 0)
          + val('_UVOffsetMainV', 0);
        sampleBilinearRepeat(signature25Glass.mask, maskU, maskV, scratchW);
        const maskZ = scratchW[2];
        sampleBilinearRepeat(signature25Glass.mask, gU, gV, scratchCloud);
        const maskY = scratchCloud[1];
        sampleBilinearRepeat(signature25Glass.mask, modU, modV, scratchMain);
        const maskX = scratchMain[0];
        sampleBilinearRepeat(signature25Glass.main, mainU, mainV, scratch);
        const maskAlpha = maskZ * val('_MaskModIntensity', 1) * maskY
          * maskX * val('_ModIntensity', 1);
        const sourceAlpha = Math.min(Math.max(
          maskAlpha * signature25Glass.intensity * (signature25Glass.color[3] ?? 1), 0), 1);
        const inv = 1 - sourceAlpha;
        canvas[ci] = Math.min(Math.max(scratch[0] * signature25Glass.intensity
          * signature25Glass.color[0]! * sourceAlpha + canvas[ci]! * inv, 0), 1);
        canvas[ci + 1] = Math.min(Math.max(scratch[1] * signature25Glass.intensity
          * signature25Glass.color[1]! * sourceAlpha + canvas[ci + 1]! * inv, 0), 1);
        canvas[ci + 2] = Math.min(Math.max(scratch[2] * signature25Glass.intensity
          * signature25Glass.color[2]! * sourceAlpha + canvas[ci + 2]! * inv, 0), 1);
        canvas[ci + 3] = Math.min(Math.max(sourceAlpha * sourceAlpha + canvas[ci + 3]! * inv, 0), 1);
        // Shader pass ZWrite Off: layer contributes color after the portrait but cannot occlude
        // later transparent layers; retain the shared frame/portrait z-buffer unchanged.
        continue;
      }
      if (diffuseAlphaMaskScroller) {
        // GDB_477's selected rarity child uses this exact game shader. Its pass state is
        // Blend One/Zero + ZWrite On (shader_meta.json: pass 0), and the DXBC PS writes
        // alpha=1 with rgb=(cloud.r*_tint*main.a*1.5*_Intensity+main.rgb)*_Fade*_TintColor
        // (2026-10-07-dxbc-rarity-alignment/NOTES.md §2). Generic alpha-over was making the
        // orange atlas diamond translucent against the frame. Main UV has material _MainTex_ST;
        // cloud UV uses raw mesh UV × scale + T×speed with no atlas offset (DXBC VS same note).
        // The signature mesh/material evidence is frame_recon.json at
        // RootObject/Mesh/RarityGem_Frame_Mesh/RarityGem_Legendary_Mesh and
        // 2026-10-22-rarity-gem-props/NOTES.md row Signature_Evergreen_Rarity_Gem_Mat.
        const cu = l0 * cu0 + l1 * cu1 + l2 * cu2;
        const cv = l0 * cv0 + l1 * cv1 + l2 * cv2;
        const cloudU = cu * diffuseAlphaMaskScroller.scale[0]
          + diffuseAlphaMaskScroller.time * diffuseAlphaMaskScroller.speed[0];
        const cloudV = cv * diffuseAlphaMaskScroller.scale[1]
          + diffuseAlphaMaskScroller.time * diffuseAlphaMaskScroller.speed[1];
        sampleBilinearRepeat(diffuseAlphaMaskScroller.clouds, cloudU, cloudV, scratchCloud);
        const cloudGain = scratchCloud[0] * 1.5 * diffuseAlphaMaskScroller.intensity * scratch[3];
        canvas[ci] = Math.min(Math.max((cloudGain * diffuseAlphaMaskScroller.tint[0] + scratch[0])
          * diffuseAlphaMaskScroller.fade[0] * diffuseAlphaMaskScroller.tintColor[0], 0), 1);
        canvas[ci + 1] = Math.min(Math.max((cloudGain * diffuseAlphaMaskScroller.tint[1] + scratch[1])
          * diffuseAlphaMaskScroller.fade[1] * diffuseAlphaMaskScroller.tintColor[1], 0), 1);
        canvas[ci + 2] = Math.min(Math.max((cloudGain * diffuseAlphaMaskScroller.tint[2] + scratch[2])
          * diffuseAlphaMaskScroller.fade[2] * diffuseAlphaMaskScroller.tintColor[2], 0), 1);
        canvas[ci + 3] = 1;
        if (writeDepth) zbuf[pi] = z;
        continue;
      }
      if (colorAsAlpha) {
        // 卡影（FS 反编译语义，见函数头注释）：a = 亮度×alphaIntensity×intensity，
        // rgb = tex.rgb×color（_Color=(0,0,0) → 纯黑影）。alpha-over 合成、写深——
        // 影面片在卡体后方（世界 Y 更低），zbuf 让卡体像素覆盖其上，影只在卡轮廓外存活，
        // 与基准半透明外圈一致（BG32 94k 半透明像素，2026-10-08）。
        const sa = Math.min(Math.max(
          (0.3 * scratch[0] + 0.59 * scratch[1] + 0.11 * scratch[2])
          * colorAsAlpha.alpha_intensity * colorAsAlpha.intensity, 0), 1);
        if (sa <= 0) continue;
        const sr = scratch[0] * colorAsAlpha.color[0];
        const sg = scratch[1] * colorAsAlpha.color[1];
        const sb = scratch[2] * colorAsAlpha.color[2];
        const dstA = canvas[ci + 3];
        const outA = sa + dstA * (1 - sa);
        const safe = outA > 1e-6 ? outA : 1.0;
        canvas[ci] = (sr * sa + canvas[ci] * dstA * (1 - sa)) / safe;
        canvas[ci + 1] = (sg * sa + canvas[ci + 1] * dstA * (1 - sa)) / safe;
        canvas[ci + 2] = (sb * sa + canvas[ci + 2] * dstA * (1 - sa)) / safe;
        canvas[ci + 3] = outA;
        if (writeDepth) zbuf[pi] = z;
        continue;
      }
      if (multiply) {
        // 乘法混合（Hero/Multiply/*）：dst.rgb *= 纹理色 + _Color。alpha 保持不变——乘法阴影只压暗，
        // 不产生遮盖（游戏在屏幕帧缓冲里 a=0 无副作用；离线链若让它清 alpha 会把卡角抠空）。
        // **不写深度**：该 shader 的 subshader tag 是 QUEUE=Transparent（ZWrite Off），阴影面片
        // 又比肖像面片更靠前（世界 Y 更大）；写深度会把随后绘制的肖像层挡在 zbuf 之外——游戏里
        // 异画/精英卡的卡图能透过银龙影显示（ETC_210/TLC_433 的画窗上缘），靠的就是这一点。
        // alpha 门控（**必需的复刻修正**）：阴影贴图里**透明像素的 rgb 是脏值**——FlagShadow
        // 的透明区 rgb≈0.5，无门控时 min(0.5+0.34,1)=0.84 会把整个 quad 压暗一档，横跨卡面
        // 就是一条矩形水平线（用户 2026-10-10 目检「顶端有水平划线、上面更暗」；OvalShadow
        // 的 quad 正是内建 Plane 矩形）。引擎语义 = 阴影强度随贴图 alpha 淡出：
        //   dst × lerp(1, min(tex+tint,1), tex.a)
        // 不透明阴影贴图（银龙影/符文影等 alpha=1）下 lerp 退化为原式 → 逐位不变。
        const ma = scratch[3];
        const fR = 1 + ma * (Math.min(scratch[0] + tr, 1) - 1);
        const fG = 1 + ma * (Math.min(scratch[1] + tg, 1) - 1);
        const fB = 1 + ma * (Math.min(scratch[2] + tb, 1) - 1);
        canvas[ci] = Math.max(Math.min(canvas[ci] * fR, 1), 0);
        canvas[ci + 1] = Math.max(Math.min(canvas[ci + 1] * fG, 1), 0);
        canvas[ci + 2] = Math.max(Math.min(canvas[ci + 2] * fB, 1), 0);
        continue;
      }
      if (additive) {
        // 加法混合（Hero/Additive/*，SrcAlpha·One）：dst.rgb += src.rgb × tint × src.a；不动 alpha、
        // 不写深度（Transparent 队列语义；星芒/辉光类 FX 只增亮）。
        const sa = scratch[3] * ta;
        canvas[ci] = Math.min(canvas[ci] + scratch[0] * tr * sa, 1);
        canvas[ci + 1] = Math.min(canvas[ci + 1] + scratch[1] * tg * sa, 1);
        canvas[ci + 2] = Math.min(canvas[ci + 2] + scratch[2] * tb * sa, 1);
        continue;
      }
      // desc 水印合成（Unlit_2Texture2uv PS 逐指令；wm 缺省时三值恒等主采样，路径不变）：
      // main = 主纹理采样**不乘 _Color**；second_t = 水印 × _SecondTint × _BlendIntensity；
      // out = second_t.a×(main×second_t − main) + main（rgb 逐信道；a 通道走下方既有写路径）。
      let srcR = scratch[0], srcG = scratch[1], srcB = scratch[2];
      let wtr = tr, wtg = tg, wtb = tb;
      if (wm) {
        const su = (l0 * wu0 + l1 * wu1 + l2 * wu2) * wsx + wox;
        const sv = (l0 * wv0 + l1 * wv1 + l2 * wv2) * wsy + woy;
        sampleBilinearClamp(wm.tex, su * wm.tex.w - 0.5, (1.0 - sv) * wm.tex.h - 0.5, scratchW);
        const stR = scratchW[0] * wm.tint[0] * wm.blend;
        const stG = scratchW[1] * wm.tint[1] * wm.blend;
        const stB = scratchW[2] * wm.tint[2] * wm.blend;
        const stA = scratchW[3] * wm.alpha * wm.blend;
        srcR = stA * (scratch[0] * stR - scratch[0]) + scratch[0];
        srcG = stA * (scratch[1] * stG - scratch[1]) + scratch[1];
        srcB = stA * (scratch[2] * stB - scratch[2]) + scratch[2];
        // main 不乘 _Color（尾 min 恒 no-op 证明，见函数头注释）
        wtr = 1;
        wtg = 1;
        wtb = 1;
      }
      const sa = opaque ? 1.0 : scratch[3] * ta;
      // 全透明纹素（sa=0）：引擎里要么 ZWrite Off 要么 alpha-test discard，**绝不产生遮挡**。
      // 离线链此前无条件写深度，饰品格子纹章（Trinket_Medallion）被 TrinketLevelIndicatorRing
      // 内圈的透明纹素挡在 zbuf 外（用户报告"大型/小型没渲染上"，2026-10-03）。
      // premultiplied 例外：几何覆盖即 stamp（alpha=1 覆盖面 + rgb=tex.rgb，与纹理 alpha 无关
      // ——基准 (230,95)=(60,58,57,255) 与该处 texel rgba (59,58,57,0) 的 rgb 逐字节同源，
      // 见下方 premultiplied 分支注释），故 sa=0 纹素不跳过。
      if (sa <= 0 && !premultiplied) continue;
      const dstA = canvas[ci + 3];
      // premultiplied：alpha 写 1（几何覆盖面），不是纹理 alpha 的 over 累加——见下方分支注释
      // 「alpha=1」节（导出器 AlphaFillOpaque mask + R2TColorAlphaCombineAdd 语义）。
      const outA = premultiplied ? 1.0 : sa + dstA * (1 - sa);
      const safe = outA > 1e-6 ? outA : 1.0;
      if (premultiplied) {
        // 佣兵 foils 族混合口径（材质 `_SrcBlend=1`/`_DstBlend=10`）——**rgb 直写、alpha 覆盖面=1**：
        // `dst.rgb = src.rgb`（不做 alpha 衰减、不累加 dst）；alpha 通道写 1 而非纹理 alpha 的
        // over 累加。
        //
        // —— rgb 直写（2026-10-10 第五轮定案）。三候选逐区域回归（LT23_816H 基准；环区 n=66582）：
        //
        //   | 口径 | 顶弧带 MAE(dst=0) | 压卡区 MAE | 全局 L2 |
        //   |---|---|---|---|
        //   | SrcAlpha over（旧旧） | 58.5 | 13.3 | — |
        //   | `_LightingBlend` 插值 k=0.5（旧） | 29.2 | 7.0 | 9.575 |
        //   | Blend One OneMinusSrcAlpha（+dst·(1−a)） | 0.6 | 16.1 | 10.795 |
        //   | **本口径（rgb 直写）** | **1.5** | **5.8** | **8.996** |
        //
        // 决定性证据是顶弧带（环凸出卡体、身后空无一物的那一条）：基准逐像素 = 纹理 rgb 本身
        // （回归 `ref = 0.999·src.rgb + 0.000·dst`，MAE 0.6），而那里 `Lettuce_FoilTiers` 的
        // texel alpha 中位数仅 0.35 → 任何按 alpha 衰减的口径都会把顶弧压掉 ~1/3 亮度 = 用户
        // 目检的「顶端一条横线、上面更暗」。压卡区同样不给 dst 项（2026-10-11 复测：环带压卡
        // 区 bleed=ref−src 均值 0.43，n=400、底图均值 94.6；按 a=0.33 混合应 +63）。旧实现在此
        // 按 `_LightingBlend`(0.5) 做源项插值属误用——`_LightingBlend` 是 VS 光照乘子
        // COLOR0=(1+_LightingBlend·(L−1))·_TintColor（findings §12.3），不是混合权重。
        //
        // —— alpha=1（2026-10-11 第七轮，修「像框超出底框的部分与未超出部分之间有亮度分界线」）。
        // 逐像素定位：基准环带 rgb 与本链一致（差≤2），但 **alpha 恒 255**（实心圆顶，x=250 列
        // y93~113 全 255；y=95 行 x232~276 全 255），本链 = 纹理 alpha over 累加（108~208）→
        // PNG 合成到任意背景上时超出底框的环带被冲淡（白底变亮/黑底变暗），与压卡段（不透明）
        // 之间形成亮度阶跃 = 用户目检的分界线。根因：导出器基准图的 alpha 不是颜色 RT 的 alpha
        // （ExporterController.cs RenderWithOfficialAlpha，:7519-7626）：
        //   1) color pass 渲到 ARGB32 MSAA4x RT；
        //   2) alpha mask pass：RenderCameraWithReplacementMaterial（:7893-7949）把 RenderType
        //      匹配的 renderer 全部换成 Custom/AlphaFillOpaque——FS 恒输出 (1,1,1,1)
        //      （Custom_AlphaFillOpaque_FS.metal:17），**与纹理 alpha 无关，纯几何覆盖**；
        //   3) 合成 Hidden/R2TColorAlphaCombineAdd FS:30 `out.a = clamp(alphaRT.x + colorRT.a)`。
        // 即参与材质的几何覆盖处最终 alpha=1。旁证排除「纹理/顶点色另有 1 的来源」：
        // Lettuce_FoilTiers 原生 DXT5（format 12）UnityPy 解码 alpha 与抽取 PNG 一致（环带中心
        // 行 95~110/255）；OvalFrame 网格无顶点色流（essential_base_global-mesh-0
        // Card_InHand_Ally_Merc_Oval_Mesh m_VertexData m_Channels[3].dimension=0）→ COLOR0.a=1，
        // 颜色 pass 的 src.a 不可能到 1。环带压卡区 bleed≈0（上表）进一步证明颜色 pass 里环的
        // rgb 就是替换式覆盖，纹理 alpha 只在 MSAA 几何边缘行有残余贡献（基准顶行 224 = mask
        // MSAA 覆盖 ~0.5 + colorRT.a≈0.38；本链无 MSAA，边缘行写 255，1px 残差）。
        // 作用域：explore/2026-10-10-lettuce-frame/scripts/premul_scope.ts 全 43 fixture 仅
        // LT23_816H 命中本分支（7 组件），
        // 其余 42 张逐位不变。sa=0 纹素同样 stamp（本分支上方 skip 注释）：环带外沿网格覆盖、
        // 图集光晕尾部 alpha=0 的像素，基准 = (texel.rgb, 255)——(230,95) 基准 (60,58,57,255)
        // vs texel (59,58,57,0)；漏 stamp 会在不透明环带外圈留一圈半透明锯齿边（用户目检
        // 「边框变成半透明」，2026-10-11）。
        canvas[ci] = Math.min(Math.max(srcR * wtr, 0), 1);
        canvas[ci + 1] = Math.min(Math.max(srcG * wtg, 0), 1);
        canvas[ci + 2] = Math.min(Math.max(srcB * wtb, 0), 1);
      } else {
        canvas[ci] = (srcR * wtr * sa + canvas[ci] * dstA * (1 - sa)) / safe;
        canvas[ci + 1] = (srcG * wtg * sa + canvas[ci + 1] * dstA * (1 - sa)) / safe;
        canvas[ci + 2] = (srcB * wtb * sa + canvas[ci + 2] * dstA * (1 - sa)) / safe;
      }
      canvas[ci + 3] = outA;
      if (writeDepth) zbuf[pi] = z;
    }
  }
}
