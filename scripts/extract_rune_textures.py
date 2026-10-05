# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_rune_textures — DK 符文横幅运行时纹理提取（assets/textures/ 补件）。

CardRunes_DeathKnight_sm（Rune_{Blood,Frost,Unholy}_sm 材质的运行时 _MainTex）不在任何
帧 prefab 的引用链里（帧材质序列化引用的是同名基础版 CardRunes_DeathKnight 占位），
ally 时代 export_asset_pack 收集不到——按 asset_index 实录 pid 直取（Angelia
lab/2026-10-01-dk-runes dk_extract_runes_sm.py 的 Mac 复现）。

  -8374584392692364380  CardRunes_DeathKnight     256²（符文图形版；帧 prefab 占位引用，
                                                   assets/textures/ 已有）
  -7217558262942142559  CardRunes_DeathKnight_sm  256²（无符号宝石面；引擎手牌显示用）
两对象同名异 pid（两个 texture bundle 各一份），跨包按名解析会撞名——必须 pid 直取。

用法：uv run scripts/extract_rune_textures.py [--pack assets]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")
BUNDLE = HS_DATA / "essential_base_global-texture-1.unity3d"

# (pid, 文件名)；sm 材质族 _MainTex（dk-runes findings §2 + rune-display §3 纹理对账）
TEXTURES = [
    (-7217558262942142559, "CardRunes_DeathKnight_sm.png"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default="assets")
    args = ap.parse_args()
    out_dir = Path(args.pack) / "textures"
    env = UnityPy.load(str(BUNDLE))
    by_pid = {obj.path_id: obj for obj in env.objects}
    for pid, name in TEXTURES:
        obj = by_pid.get(pid)
        if obj is None:
            print(f"[fail] pid {pid} 不在 {BUNDLE.name}")
            return 1
        img = obj.read().image
        out_dir.mkdir(parents=True, exist_ok=True)
        dst = out_dir / name
        img.save(dst)
        print(f"[ok] {dst} {img.size[0]}x{img.size[1]} pid={pid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
