/** Frozen-frame CPU path for the no-keyword Uber/UberCardBack material variant.
 * GDB_477's original offline path sampled only MainTex, leaving the signature frame rails without
 * the serialized mask/layer color and distortion that Unity's selected UberCardBack shader draws.
 * The CPU rasterizer translates that selected no-keyword GPU variant because it cannot execute the
 * game's Unity material directly. Probes: assets/frames/hand-minion-sig9/frame_recon.json and the
 * equivalent frame_recon.json files for sig2/sig10/sig12 (all m_ValidKeywords=[]).
 * VS: ../exporter/tmp/shader/Uber_UberCardBack_VS.metal:145-161 (UV animation);
 * FS: explore/2026-10-25-signature-frame/output/Uber_UberCardBack_FS_nokw.metal:107-211.
 * The vertex shader supplies three affine UV sets; the fragment shader samples the atlas mask,
 * layers 1–3, cascades their distortion, applies the serialized blend vectors, and adds specular.
 * In the no-keyword variant TEXCOORD2.y is zero, so the specular term is identically zero.
 */
import type { FrameMaterial, RGBAImage } from './types.js';

export interface UberCardBackTextures {
  main:   RGBAImage;
  mask:   RGBAImage;
  layer1: RGBAImage;
  layer2: RGBAImage;
  layer3: RGBAImage;
}

const sampMask = new Float64Array(4);
const samp1 = new Float64Array(4);
const samp2 = new Float64Array(4);
const samp3 = new Float64Array(4);
const sampMain = new Float64Array(4);
const blendBase = new Float64Array(4);
const blendNext = new Float64Array(4);

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/** Unity TextureWrapMode.Repeat (serialized m_WrapU/V=0) with bilinear texel-center sampling. */
function sampleRepeat(tex: RGBAImage, u: number, v: number, out: Float64Array): void {
  const { w, h, data } = tex;
  const x = ((u * w - 0.5) % w + w) % w;
  const y = (((1 - v) * h - 0.5) % h + h) % h;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % w, y1 = (y0 + 1) % h;
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 4; c++) {
    const a = data[(y0 * w + x0) * 4 + c]! / 255 * (1 - fx)
      + data[(y0 * w + x1) * 4 + c]! / 255 * fx;
    const b = data[(y1 * w + x0) * 4 + c]! / 255 * (1 - fx)
      + data[(y1 * w + x1) * 4 + c]! / 255 * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

/** Port of the no-keyword vertex shader's rotate/scale/translate UV transform. */
function layerUv(uv: number[], colors: Record<string, number[]>, layer: 1 | 2 | 3, time: number): [number, number] {
  const translate = colors[`_Layer${layer}_Translate`] ?? [0, 0, 0, 0];
  const rotate = colors[`_Layer${layer}_Rotate`] ?? [0, 0, 0.5, 0.5];
  const scale = colors[`_Layer${layer}_Scale`] ?? [1, 1, 0.5, 0.5];
  const centerU = rotate[2]! - translate[0]!;
  const centerV = rotate[3]! - translate[1]!;
  const angle = rotate[0]! + time * rotate[1]!;
  const cs = Math.cos(angle), sn = Math.sin(angle);
  const du = uv[0]! - centerU, dv = uv[1]! - centerV;
  // Metal VS rotates with the row-vector convention visible in the two dot products
  // (Uber_UberCardBack_VS_nokw.metal:158-161): U = cos*du + sin*dv,
  // V = -sin*du + cos*dv.
  let u = centerU + du * cs + dv * sn;
  let v = centerV - du * sn + dv * cs;
  const sx = scale[2]! - translate[0]!;
  const sy = scale[3]! - translate[1]!;
  u = (u - sx) * scale[0]! + sx;
  v = (v - sy) * scale[1]! + sy;
  u += translate[0]! + translate[2]! * time;
  v += translate[1]! + translate[3]! * time;
  return [u, v];
}

/** Scalar transcription of the blend block repeated for each layer in the decompiled FS. */
function blendLayer(
  base: Float64Array, layerTex: Float64Array, color: number[], blend: number[], maskWeight: number,
  colorWeight: number,
  out: Float64Array,
): void {
  const colorAlpha = color[3] ?? 1;
  const bX = blend[0] ?? 0, bY = blend[1] ?? 0;
  const bZ = blend[2] ?? 0, bW = blend[3] ?? 0;
  const v = [0, 0, 0, 0];
  const mixBase = [0, 0, 0, 0];
  const modeBase = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    v[c] = layerTex[c]! * (color[c] ?? 1) * colorAlpha * colorWeight;
  }
  // The shader computes its mix amount from the completed float4 alpha, then applies that
  // same amount to every channel. Computing the amount inside the RGB loop reads v.a before
  // it is populated, silently disabling each layer's RGB blend (FS lines 132-157, 158-184,
  // 185-211).
  const amt = clamp01(v[3]! * bW);
  for (let c = 0; c < 4; c++) {
    mixBase[c] = bW > 0 ? base[c]! + amt * (v[c]! - base[c]!) : base[c]!;
    const mul = v[c]! * mixBase[c]!;
    modeBase[c] = mixBase[c]! + mul * bY + v[c]! * bX;
    const twice = modeBase[c]! * 2;
    const non = 1 - (1 - modeBase[c]!) * 2 * (1 - v[c]!) - twice * v[c]!;
    const mode = Math.min(Math.floor(twice), 1) * non + v[c]! * twice;
    const nonlinear = base[c]! + bZ * (mode - base[c]!);
    const chosen = bZ > 0 ? nonlinear : modeBase[c]!;
    out[c] = base[c]! + maskWeight * (chosen - base[c]!);
  }
}

/** Raster one UberCardBack triangle using the exact no-keyword FS layer chain. */
export function rasterUberCardBack(
  canvas: Float64Array,
  zbuf: Float64Array,
  W: number,
  H: number,
  tri2d: number[][],
  triZ: number[],
  triUv: number[][],
  material: FrameMaterial,
  textures: UberCardBackTextures,
  time: number,
): void {
  const [x0, y0] = tri2d[0]!;
  const [x1, y1] = tri2d[1]!;
  const [x2, y2] = tri2d[2]!;
  const xmin = Math.max(Math.floor(Math.min(x0!, x1!, x2!)), 0);
  const xmax = Math.min(Math.ceil(Math.max(x0!, x1!, x2!)), W - 1);
  const ymin = Math.max(Math.floor(Math.min(y0!, y1!, y2!)), 0);
  const ymax = Math.min(Math.ceil(Math.max(y0!, y1!, y2!)), H - 1);
  if (xmin > xmax || ymin > ymax) return;
  const d = (x1! - x0!) * (y2! - y0!) - (x2! - x0!) * (y1! - y0!);
  if (Math.abs(d) < 1e-12) return;

  const colors = material.colors ?? {};
  const floats = material.floats ?? {};
  const texProps = material.tex ?? {};
  const st = texProps['_MainTex'];
  const stScale = st?.scale ?? [1, 1];
  const stOffset = st?.offset ?? [0, 0];
  const mainUv = triUv.map(([u, v]) => [
    u! * stScale[0]! + stOffset[0]!, v! * stScale[1]! + stOffset[1]!,
  ]);
  const timeValue = typeof floats['_ShaderTime'] === 'number' && floats['_ShaderTime']! > 0
    ? floats['_ShaderTime']! + (floats['_Seed'] ?? 0)
    : time + (floats['_Seed'] ?? 0);
  const layerUvVerts = [1, 2, 3].map(n => mainUv.map(uv => layerUv(uv,
    colors, n as 1 | 2 | 3, timeValue)));
  const layerColors = [1, 2, 3].map(n => colors[`_Layer${n}_Color`] ?? [1, 1, 1, 1]);
  const layerBlend = [1, 2, 3].map(n => colors[`_Layer${n}_Blend`] ?? [0, 0, 0, 0]);
  const layerMask = [1, 2, 3].map(n => colors[`_Layer${n}_Mask`] ?? [0, 0, 0, 0]);
  const distort = [1, 2, 3].map(n => colors[`_Layer${n}_Distortion`] ?? [0, 0, 0, 0]);

  const triL1 = layerUvVerts[0]!;
  const triL2 = layerUvVerts[1]!;
  const triL3 = layerUvVerts[2]!;
  for (let y = ymin; y <= ymax; y++) {
    const gy = y + 0.5;
    for (let x = xmin; x <= xmax; x++) {
      const gx = x + 0.5;
      const l1 = ((gx - x0!) * (y2! - y0!) - (gy - y0!) * (x2! - x0!)) / d;
      const l2 = ((x1! - x0!) * (gy - y0!) - (y1! - y0!) * (gx - x0!)) / d;
      const l0 = 1 - l1 - l2;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const z = l0 * triZ[0]! + l1 * triZ[1]! + l2 * triZ[2]!;
      const pi = y * W + x;
      if (!(z >= zbuf[pi]!)) continue;

      const u = l0 * mainUv[0]![0]! + l1 * mainUv[1]![0]! + l2 * mainUv[2]![0]!;
      const v = l0 * mainUv[0]![1]! + l1 * mainUv[1]![1]! + l2 * mainUv[2]![1]!;
      // UnityPy probe of the original Signature_Evergreen_Atlas and _Mask textures:
      // TextureSettings m_WrapU=m_WrapV=0 (Repeat), m_FilterMode=2 (Bilinear), mipCount=1.
      // The earlier clamp sampler smeared edge texels when the shader's distortion pushed
      // frame UVs beyond [0,1].
      sampleRepeat(textures.mask, u, v, sampMask);

      const _u1 = l0 * triL1[0]![0] + l1 * triL1[1]![0] + l2 * triL1[2]![0];
      const _v1 = l0 * triL1[0]![1] + l1 * triL1[1]![1] + l2 * triL1[2]![1];
      const u2 = l0 * triL2[0]![0] + l1 * triL2[1]![0] + l2 * triL2[2]![0];
      const v2 = l0 * triL2[0]![1] + l1 * triL2[1]![1] + l2 * triL2[2]![1];
      const u3 = l0 * triL3[0]![0] + l1 * triL3[1]![0] + l2 * triL3[2]![0];
      const v3 = l0 * triL3[0]![1] + l1 * triL3[1]![1] + l2 * triL3[2]![1];

      const weights = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const m = layerMask[i]!;
        weights[i] = Math.min(sampMask[0]! * m[0]! + sampMask[1]! * m[1]!
          + sampMask[2]! * m[2]! + sampMask[3]! * m[3]!, 1);
      }

      sampleRepeat(textures.layer3, u3, v3, samp3);
      const w3 = weights[2]! * samp3[3]!;
      const d3 = distort[2]!;
      const u2d = u2 + samp3[0]! * d3[2]! * w3;
      const v2d = v2 + samp3[1]! * d3[3]! * w3;
      sampleRepeat(textures.layer2, u2d, v2d, samp2);
      const w2 = weights[1]! * samp2[3]!;
      const d2 = distort[1]!;
      const u1d = l0 * triL1[0]![0] + l1 * triL1[1]![0] + l2 * triL1[2]![0]
        + samp3[0]! * d3[2]! * w3 + samp2[0]! * d2[2]! * w2;
      const v1d = l0 * triL1[0]![1] + l1 * triL1[1]![1] + l2 * triL1[2]![1]
        + samp3[1]! * d3[3]! * w3 + samp2[1]! * d2[3]! * w2;
      sampleRepeat(textures.layer1, u1d, v1d, samp1);
      const w1 = weights[0]! * samp1[3]!;
      const d1 = distort[0]!;
      const mainU = u + samp1[0]! * d1[0]! * w1
        + samp2[0]! * d2[0]! * w2 + samp3[0]! * d3[0]! * w3;
      const mainV = v + samp1[1]! * d1[1]! * w1
        + samp2[1]! * d2[1]! * w2 + samp3[1]! * d3[1]! * w3;
      sampleRepeat(textures.main, mainU, mainV, sampMain);
      blendBase.set(sampMain);
      let current = blendBase;
      let output = blendNext;
      for (let i = 0; i < 3; i++) {
        const sample = i === 0 ? samp1 : i === 1 ? samp2 : samp3;
        const layerWeight = weights[i]! * sample[3]!;
        blendLayer(current, sample, layerColors[i]!, layerBlend[i]!, layerWeight,
          i === 0 ? 1 : layerWeight, output);
        const previous = current;
        current = output;
        output = previous === blendBase ? blendNext : blendBase;
      }
      const ci = pi * 4;
      // FS clamps the layered result before writing SV_Target0 (Uber FS line 212); its
      // final output is that result multiplied by VS COLOR0 (lines 212-216). This material
      // serializes _LightingBlend=0, so VS COLOR0 is exactly white (VS lines 206-208).
      // It is an opaque Z-writing material (_Surface=0, _SrcBlend=One, _DstBlend=Zero,
      // _ZWrite=1 in frame_recon.json), so source RGB replaces the destination. The official
      // frame exporter fills alpha from geometric coverage (ExporterController.cs
      // RenderWithOfficialAlpha / AlphaFillOpaque shader), hence alpha=1 for covered samples;
      // shader texture alpha must not be used as a transparency blend here.
      canvas[ci] = clamp01(current[0]!);
      canvas[ci + 1] = clamp01(current[1]!);
      canvas[ci + 2] = clamp01(current[2]!);
      canvas[ci + 3] = 1;
      zbuf[pi] = z;
    }
  }
}
