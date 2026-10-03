# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_class_atlases — 类色图集批量提取（帧渲染的运行时 _MainTex 源）。

来源：colorswitcher 探针（explore/hs-render/lab/2026-09-30-render-chain-correspondence/
output/colorswitcher_probe.json，CardColorSwitcher 单例序列化表逆向，一次性冻结）。
卡牌渲染器按 TAG_CARDTYPE 选族（minionCardTextures/spellCardTextures）、TAG_CLASS 选
ColorType 下标取图集。本脚本把全部非空槽位提取进资产包，命名与 py 链同约定
`{stem}_{guid8}.png`（如 Card_Inhand_Minion_Priest_337cc086.png）。

用法：uv run scripts/extract_class_atlases.py [--probe PATH] [--textures DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
from resolve_asset_ref import Resolver  # noqa: E402

HS_DATA = Path("/Applications/Hearthstone/Data/OSX")



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tables", default=str(REPO / "data" / "tables.json"))
    ap.add_argument("--textures", default=str(REPO / "assets" / "card-render-v1" / "textures"))
    args = ap.parse_args()
    probe = {"switcher": {"data": json.loads(Path(args.tables).read_text(encoding="utf-8"))["colorSwitcher"]}}
    out_dir = Path(args.textures)
    out_dir.mkdir(parents=True, exist_ok=True)

    r = Resolver(HS_DATA)
    n = 0
    for family, slots in probe["switcher"]["data"].items():
        if not family.endswith("CardTextures"):
            continue
        for color_type, ref in enumerate(slots):
            if not ref or not ref.endswith(".tif") and ":" not in ref:
                continue
            stem, guid = ref.rsplit(":", 1)
            res = r.resolve(ref)
            if not res["ok"]:
                print(f"[miss] {ref}: {res['checks']}")
                continue
            obj, _ = r.container_get(res["resolved"]["bundle"], res["resolved"]["guid"])
            out_png = out_dir / f"{Path(stem).stem}_{guid[:8]}.png"
            obj.read().image.save(out_png)
            n += 1
            print(f"[ok] {family}[{color_type}] -> {out_png.name}")
    print(f"\n[done] {n} 张类色图集 → {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
