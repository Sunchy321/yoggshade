# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Restore GOLDEN side ornaments on the single-color DK weapon hand frame."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


# T09 JAIL_450 showed the Death Knight frame correctly but its side flowers were
# dark; this also triggers for other GOLDEN single-color DK weapons. Actor.cs
# `SetMaterialWithTexture` (`../exporter/tmp/ilspy/Assembly-Csharp/Actor.cs:6700-6708`)
# writes one class atlas into `m_portraitFrameMatIdx`, while the premium prefab's
# `PortraitFrame_mesh` slot 0 carries both the outer frame and flowers. Replacing
# the full atlas therefore cannot preserve the DK border and restore GOLDEN flowers
# independently in the offline renderer. Keep the DK atlas except for the flower
# texels from the matching premium atlas. UnityPy evidence is in
# `assets/frames/hand-weapon-golden/prefab_report.json` (`m_portraitFrameMatIdx=0`,
# `m_portraitMatIdx=1`).
# Unity UV coordinates measured from PortraitFrame_mesh submesh 0 and rendered
# against the JAIL_450 flower ROIs. See
# explore/2026-10-26-golden-stage-b/map_dk_weapon_flower_uv.mjs and its
# output/dk-weapon-flower-uv-map.json; the resulting A/B is
# output/dk-weapon-flower-uv-patch-probe/JAIL_450-gold-flowers-dark-DK-frame.png.
GOLDEN_FLOWER_UV_RECTS = (
    (0.04, 0.145, 0.365, 0.54),
    (0.84, 0.99, 0.50, 0.635),
)


def compose(pack: Path) -> Path:
    dk_path = pack / "textures" / "Card_Inhand_Weapon_DK_91041c28.png"
    premium_path = pack / "frames" / "hand-weapon-golden" / "textures" / "Card_Inhand_Weapon_Premium.png"
    output_path = pack / "frames" / "hand-weapon-golden" / "textures" / "Card_Inhand_Weapon_DK_Golden.png"

    with Image.open(dk_path) as source:
        dk = np.asarray(source.convert("RGBA"), dtype=np.uint8).copy()
    with Image.open(premium_path) as source:
        premium = np.asarray(source.convert("RGBA"), dtype=np.uint8)
    if dk.shape != premium.shape:
        raise ValueError(f"weapon atlas dimensions differ: DK={dk.shape}, GOLDEN={premium.shape}")

    height, width = dk.shape[:2]
    # The diagnostic used x/width and 1-y/height for the atlas texel's UV test.
    # Keep those same edge semantics so the generated pixels match the reviewed A/B.
    u = np.arange(width, dtype=np.float64)[None, :] / width
    v = 1.0 - np.arange(height, dtype=np.float64)[:, None] / height
    mask = np.zeros((height, width), dtype=bool)
    for u0, u1, v0, v1 in GOLDEN_FLOWER_UV_RECTS:
        mask |= (u >= u0) & (u <= u1) & (v >= v0) & (v <= v1)
    dk[mask] = premium[mask]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(dk, "RGBA").save(output_path)
    print(f"[done] {output_path} ({int(mask.sum())} GOLDEN texels; DK atlas preserved elsewhere)")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    args = parser.parse_args()
    compose(args.pack)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
