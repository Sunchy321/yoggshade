# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_pivot_assets — pivot 卡素材提取（ADR-0001 双固化的素材侧）。

链路（Angelia lab/2026-10-02-textless-ref/scripts/tr_extract_portrait.py 逐行同构，
Mac 路径适配）：cards_map.asset → CardDef prefab → 组件扫 m_*PortraitTexturePath →
resolve_asset_ref Resolver → Texture2D → PNG。

产出 assets/card-render-v1/portraits/（素材属资产包，gitignored，脚本可复现）：
  {CARD_ID}.png                    —— 普通原画
  {CARD_ID}-golden.png             —— 金卡原画（m_GoldenPortraitTexturePath 非空时）
  {CARD_ID}-signature.png          —— 异画原画（同上）
  {CARD_ID}-diamond.png            —— 钻石原画（m_DiamondPortraitTexturePath 非空时）

前置：uv run scripts/extract_pivot_data.py（读 data/pivots/manifest.json）。
用法：uv run scripts/extract_pivot_assets.py [--portraits assets/card-render-v1/portraits] [--only CARD_ID]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")

# (CardDef 字段, 输出后缀)；主画无后缀
PORTRAIT_FIELDS = [
    ("m_PortraitTexturePath", ""),
    ("m_GoldenPortraitTexturePath", "-golden"),
    ("m_SignaturePortraitTexturePath", "-signature"),
    ("m_DiamondPortraitTexturePath", "-diamond"),
]


def ptr_dict(p) -> dict:
    if isinstance(p, dict):
        return {"m_FileID": p.get("m_FileID", 0), "m_PathID": p.get("m_PathID", 0)}
    return {"m_FileID": getattr(p, "m_FileID", 0), "m_PathID": getattr(p, "m_PathID", 0)}


def extract_portraits(r, card_id: str, out_dir: Path) -> list[str]:
    cref = r.card_def_ref(card_id)
    if not cref:
        print(f"[miss] {card_id}: cards_map 无此卡")
        return []
    cres = r.resolve(cref)
    if not cres["ok"]:
        print(f"[miss] {card_id}: CardDef 解析失败 {cres['checks']}")
        return []
    cobj, _ = r.container_get(cres["resolved"]["bundle"], cres["resolved"]["guid"])
    cgt = cobj.read_typetree()
    # CardDef 数据在 MonoBehaviour 组件上（GameObject 树没有）：扫 m_Component 找到它
    fields: dict[str, str] = {}
    for pair in cgt.get("m_Component") or []:
        cp = pair.get("component") if isinstance(pair, dict) else getattr(pair, "component", None)
        pd = ptr_dict(cp)
        if not pd["m_PathID"]:
            continue
        try:
            c2, _ = r.resolve_pptr(cres["resolved"]["bundle"], pd, cobj)
        except Exception:
            continue
        if c2.type.name != "MonoBehaviour":
            continue
        mt2 = c2.read_typetree()
        if isinstance(mt2, dict) and "m_PortraitTexturePath" in mt2:
            for field, _suffix in PORTRAIT_FIELDS:
                v = mt2.get(field)
                if isinstance(v, str) and v:
                    fields[field] = v
            break
    saved = []
    for field, suffix in PORTRAIT_FIELDS:
        ref = fields.get(field)
        if not ref:
            continue
        pres = r.resolve(ref)
        if not pres["ok"]:
            print(f"[miss] {card_id}{suffix}: {ref} 解析失败")
            continue
        pobj, _ = r.container_get(pres["resolved"]["bundle"], pres["resolved"]["guid"])
        out_png = out_dir / f"{card_id}{suffix}.png"
        pobj.read().image.save(out_png)
        saved.append(out_png.name)
    print(f"[ok] {card_id}: {', '.join(saved) if saved else '（无原画字段）'}")
    return saved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(REPO / "data" / "pivots" / "manifest.json"))
    ap.add_argument("--portraits", default=str(REPO / "assets" / "card-render-v1" / "portraits"))
    ap.add_argument("--only", default="", help="只提取指定 cardId（调试用）")
    args = ap.parse_args()
    out_dir = Path(args.portraits)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    sys.path.insert(0, str(HERE))
    from resolve_asset_ref import Resolver
    r = Resolver(HS_DATA)
    n = 0
    for p in manifest["presets"]:
        if args.only and p["cardId"] != args.only:
            continue
        n += len(extract_portraits(r, p["cardId"], out_dir))
    print(f"\n[done] {n} 张原画 → {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
