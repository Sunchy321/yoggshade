# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_shader_variants — 列举并落盘指定 shader 的全部 Metal 变体（长期工具）。

为什么需要这个工具（变体覆盖缺陷的来历，docs/findings/signature-frame-research-2026-10-25.md §4.3）：
  exporter 的 tools/extract_shaders.py 按 {shader}_{stage}.metal 落盘、文件名不带 keyword
  后缀，同一 shader 的全部变体互相覆盖、只留最后写入的那个 —— exporter 缓存里的
  Uber_UberCardBack_FS.metal（Keywords: []，20 行恒等白）即其产物，不是签名帧材质实际
  使用的变体（VS 209 行那份碰巧是好的）。本工具按 keyword 集后缀落盘，变体互不覆盖；
  exporter 侧工具的覆盖 bug 跨仓不修（.scratch/signature-frames/spec.md 实现决策 15）。

变体清单解读法（Uber/UberCardBack 实测 62 变体 = VS/FS × keyword 集）：
  keyword 轴 = _LAYER{1,2,3}_FLOWMAP × _LAYER3 × _VERTEX_ROTATION/_VERTEX_WIND × _DEBUG。
  FS 变体全部采样纹理（219–291 行，_MainTex 图集 + _MaskTex + _Layer{1,2,3}_Tex 按通道
  混合）；VS 变体做逐层 rotate/translate/scale + _Time 的流动 UV（材质 _ShaderTime=0 时
  走 VGlobals._Time.x + _Seed，帧是动画的，静态渲染需定相位）。
  本工具落盘全部唯一 (stage, keyword集) 变体 —— 「FS 采样变体」是移植期直读主力，
  VS/非采样变体一并保留作证据源（金卡 UnlitTextureReflection 的 VS 含 dp2(_Time,
  _ReflectionRotation)，见 spec 实现决策 13）。

产物（默认 ./shader_variants/，即调用方实验目录之下；绝不写 exporter 缓存）：
  {Shader_Name}_{VS|FS}_{keywords 排序后以 _ 连接，空集记 nokw}.metal
  变体解析自 Shader 资源 compressedBlob 的 Metal 平台段（LZ4 解压 → 子程序表 →
  keyword 列表 → 0xF00DCAFE 源码段），文件名含 keyword 后缀故互不覆盖。
  游戏目录只读。

用法：
  uv run scripts/extract_shader_variants.py "Uber/UberCardBack"
  uv run scripts/extract_shader_variants.py "Custom/Card/UnlitTextureReflection" \
      --out explore/<你的实验>/output
  可选 --game DIR 覆盖游戏数据目录（默认 $HS_GAME_DATA 或 /Applications/Hearthstone/Data/OSX）。
"""
from __future__ import annotations

import argparse
import glob
import os
import struct
import sys
from pathlib import Path

import UnityPy
from UnityPy.enums import ShaderCompilerPlatform, ShaderGpuProgramType
from UnityPy.helpers import CompressionHelper

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"


def variants_of(tt: dict) -> list[dict]:
    """从 Shader typetree 的 compressedBlob 解出 Metal 平台的全部 VS/FS 变体。"""
    out = []
    platforms = tt.get("platforms", [])
    blob = bytes(tt.get("compressedBlob", b""))
    offsets = tt.get("offsets", [])
    comp_lens = tt.get("compressedLengths", [])
    dls = tt.get("decompressedLengths", [])
    for i, plt in enumerate(platforms):
        if plt != ShaderCompilerPlatform.kShaderCompPlatformMetal:
            continue
        if i >= len(offsets):
            continue
        for j in range(len(offsets[i])):
            off, cl, dl = offsets[i][j], comp_lens[i][j], dls[i][j]
            if off + cl > len(blob):
                continue
            try:
                dec = CompressionHelper.decompress_lz4(blob[off:off + cl], dl)
            except Exception:  # noqa: BLE001
                continue
            buf = memoryview(dec)
            if len(dec) < 4:
                continue
            sub_count = struct.unpack_from("<I", buf, 0)[0]
            if sub_count > 4096:
                continue
            for sp in range(sub_count):
                entry_pos = 4 + sp * 12
                if entry_pos + 4 > len(dec):
                    continue
                sub_off = struct.unpack_from("<I", buf, entry_pos)[0]
                if sub_off <= 0 or sub_off + 16 >= len(dec):
                    continue
                sub_ver = struct.unpack_from("<I", buf, sub_off)[0]
                try:
                    ptype = ShaderGpuProgramType(struct.unpack_from("<I", buf, sub_off + 4)[0])
                except ValueError:
                    continue
                if ptype not in (ShaderGpuProgramType.kShaderGpuProgramMetalVS,
                                 ShaderGpuProgramType.kShaderGpuProgramMetalFS):
                    continue
                pos = sub_off + 8 + 12
                if sub_ver >= 201608170:
                    pos += 4
                if pos + 4 > len(dec):
                    continue
                kw_count = struct.unpack_from("<I", buf, pos)[0]
                pos += 4
                kws = []
                for _ in range(kw_count):
                    if pos + 4 > len(dec):
                        break
                    strlen = struct.unpack_from("<I", buf, pos)[0]
                    pos += 4
                    if pos + strlen > len(dec):
                        break
                    kws.append(bytes(buf[pos:pos + strlen]).decode("utf-8", "replace"))
                    pos += strlen
                    pos = (pos + 3) & ~3
                if sub_ver >= 201806140 and sub_ver < 202012090:
                    # 该版本区段另存 local keywords，跳过后才是代码长度
                    if pos + 4 > len(dec):
                        continue
                    lkc = struct.unpack_from("<I", buf, pos)[0]
                    pos += 4
                    for _ in range(lkc):
                        if pos + 4 > len(dec):
                            break
                        lsl = struct.unpack_from("<I", buf, pos)[0]
                        pos += 4 + lsl
                        pos = (pos + 3) & ~3
                if pos + 4 > len(dec):
                    continue
                code_size = struct.unpack_from("<I", buf, pos)[0]
                pos += 4
                if pos + code_size > len(dec):
                    continue
                code = bytes(buf[pos:pos + code_size])
                if len(code) < 8:
                    continue
                src_pos = 4
                magic = struct.unpack_from("<I", code, 0)[0]
                if magic == 0xF00DCAFE:
                    src_pos = struct.unpack_from("<I", code, 4)[0]
                src = code[src_pos:]
                nul = src.find(b"\x00")
                if nul < 0:
                    continue
                metal = src[nul + 1:].decode("utf-8", "replace")
                out.append({
                    "stage": "VS" if ptype == ShaderGpuProgramType.kShaderGpuProgramMetalVS else "FS",
                    "keywords": tuple(kws),
                    "samples": "sample(" in metal or ".sample" in metal,
                    "lines": metal.count("\n"),
                    "src": metal,
                })
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="列举并落盘 shader 的全部 Metal 变体（keyword 后缀命名）")
    ap.add_argument("shader", help='shader 名，如 "Uber/UberCardBack"')
    ap.add_argument("--out", default="shader_variants",
                    help="输出目录（默认 ./shader_variants，落在调用方实验目录下；不写 exporter 缓存）")
    ap.add_argument("--game", default=os.environ.get("HS_GAME_DATA", "/Applications/Hearthstone/Data/OSX"),
                    help="游戏数据目录（默认 $HS_GAME_DATA 或 /Applications/Hearthstone/Data/OSX，只读）")
    args = ap.parse_args()
    want = args.shader

    found = 0
    raw_total = 0
    # 跨 bundle 全局去重：同一 (stage, keyword集) 只落盘一次，避免同名文件来回覆盖
    seen: dict[tuple[str, tuple[str, ...]], dict] = {}
    for f in sorted(glob.glob(f"{args.game}/*.unity3d")):
        try:
            env = UnityPy.load(f)
        except Exception:  # noqa: BLE001
            continue
        for o in env.objects:
            if o.type.name != "Shader":
                continue
            try:
                tt = o.read_typetree()
            except Exception:  # noqa: BLE001
                continue
            name = tt.get("m_ParsedForm", {}).get("m_Name") or tt.get("m_Name", "")
            if name != want:
                continue
            found += 1
            vs = variants_of(tt)
            raw_total += len(vs)
            for v in vs:
                seen.setdefault((v["stage"], v["keywords"]), v)

    if not found:
        print(f"shader {want} not found in {args.game}")
        return 1

    print(f"[{want}] raw variants: {raw_total}  unique (stage x keywords): {len(seen)}")
    for (stage, kws), v in sorted(seen.items(), key=lambda kv: (kv[0][0], len(kv[0][1]), kv[0][1])):
        print(f"  {stage}  kw={sorted(kws) if kws else '[]'}  samples={v['samples']}  lines={v['lines']}")

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    n = 0
    for (stage, kws), v in seen.items():
        tag = "_".join(sorted(kws)) or "nokw"
        p = outdir / f"{want.replace('/', '_')}_{stage}_{tag}.metal"
        p.write_text(v["src"])
        n += 1
    print(f"  -> wrote {n} variants to {outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
