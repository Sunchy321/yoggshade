# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_fixture_data — fixture 卡数据提取（ADR-0001 双固化的数据侧）。

数据源：本机炉石安装 Data/OSX/dbf.unity3d（客户端自带全量 DBF：213 表，
CARD 36,022 行 / CARD_TAG 260,954 行，与 hearth-sight PG v327 同源同量；
Angelia docs/notes/textbuilder-drift-measurement.md 记录 Windows 侧同文件）。
语言序：m_locValues 为 14 语言定长数组，下标 12 = zhCN 简体（Angelia 台账同口径）。

产出 data/fixtures/：
  manifest.json   —— fixture 清单（30 张 CardPresets + glow 基准 12 token）+ 提取元数据
  {CARD_ID}.json  —— 单卡 canonical 数据：全部 14 语言 name/text、全量 tags、
                     textBuilderType、preset/glow 归属

用法：uv run scripts/extract_fixture_data.py [--out data/fixtures]
"""
from __future__ import annotations

import argparse
import json
import plistlib
import sys
from datetime import datetime, timezone
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")
DBF_PATH = HS_DATA / "dbf.unity3d"
LOCALES = ["enUS", "deDE", "esES", "esMX", "frFR", "itIT", "jaJP", "koKR", "plPL", "ptBR", "ruRU", "thTH", "zhCN", "zhTW"]

# exporter bepinex/plugin/CardPresets.md（30 行，逐行照抄；Reason 字段锚定渲染行为）
# exporter docs/custom-glow-benchmark-plan.md（12 卡型 token；卡 ID 全部 ⊆ PRESETS）
# ↑ 两表均已外置到 data/fixture.md（唯一编辑入口），本脚本只读不定义。


def game_version() -> str:
    try:
        pl = plistlib.load(open("/Applications/Hearthstone/Hearthstone.app/Contents/Info.plist", "rb"))
        return str(pl.get("CFBundleVersion", "unknown"))
    except Exception:
        return "unknown"


def loc_dict(field: dict) -> dict:
    """LocalizedStrings 字段 → {locale: text}（空串保留，键齐全便于消费方索引）。"""
    vals = field.get("m_locValues", [])
    return {loc: (vals[i] if i < len(vals) else "") for i, loc in enumerate(LOCALES)}


def parse_fixture_md(path: Path) -> tuple[list[tuple], list[dict]]:
    """data/fixture.md → (presets 行, glow-bench 行)。按表头列名定位，容忍空列。"""
    lines = path.read_text(encoding="utf-8").splitlines()
    tables: dict[str, list[list[str]]] = {}
    section = None
    header: list[str] | None = None
    for ln in lines:
        s = ln.strip()
        if s.startswith("## "):
            section = s[3:].strip()
            header = None
            tables.setdefault(section, [])
            continue
        if section and s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells):
                continue
            if header is None:
                header = cells
                continue
            tables[section].append(cells)
    presets, glow = [], []
    for row in tables.get("presets", []):
        card_id, label, premium, template, zone, reason = row[:6]
        presets.append((card_id, label, premium, template, zone, reason))
    for row in tables.get("glow-bench", []):
        token, card_id, template, parts, rune = row[:5]
        glow.append({"token": token, "cardId": card_id, "template": template,
                     "parts": [p.strip() for p in parts.split(",") if p.strip()],
                     "runeOverride": int(rune) if rune.strip() else None})
    if not presets:
        raise SystemExit(f"{path}: 未解析到 presets 表")
    return presets, glow


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "data" / "fixtures"))
    ap.add_argument("--fixture-md", default=str(REPO / "data" / "fixture.md"))
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    presets, glow_bench = parse_fixture_md(Path(args.fixture_md))
    print(f"[fixture] presets={len(presets)} glow-bench={len(glow_bench)}（{args.fixture_md}）")

    env = UnityPy.load(str(DBF_PATH))
    tables: dict[str, dict] = {}
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        t = o.read_typetree()
        tables[t["m_Name"]] = t
    card_rows = tables["CARD"]["Records"]
    tag_rows = tables["CARD_TAG"]["Records"]
    by_guid: dict[str, dict] = {r["m_noteMiniGuid"]: r for r in card_rows if r.get("m_noteMiniGuid")}
    tags_by_dbf: dict[int, dict[int, int]] = {}
    for r in tag_rows:
        tags_by_dbf.setdefault(r["m_cardId"], {})[r["m_tagId"]] = r["m_tagValue"]

    ver = game_version()
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"file": str(DBF_PATH), "gameVersion": ver,
                   "tables": {"CARD": len(card_rows), "CARD_TAG": len(tag_rows)}},
        "adr": "docs/adr/0001-fixture-frozen-benchmark-data.md",
        "presets": [], "missing": [], "glowBench": glow_bench,
        "fixtureMd": str(Path(args.fixture_md).relative_to(REPO)),
    }
    for card_id, label, premium, template, zone, reason in presets:
        row = by_guid.get(card_id)
        if row is None:
            manifest["missing"].append(card_id)
            print(f"[miss] {card_id}（DBF 无此卡，登记后跳过）")
            continue
        dbf = row["m_ID"]
        doc = {
            "cardId": card_id,
            "dbfId": dbf,
            "preset": {"label": label, "premium": premium, "template": template,
                       "zone": zone, "reason": reason},
            "textBuilderType": row.get("m_cardTextBuilderType", 0),
            "watermarkTextureOverride": row.get("m_watermarkTextureOverride", ""),
            "name": loc_dict(row["m_name"]),
            "textInHand": loc_dict(row["m_textInHand"]),
            "tags": tags_by_dbf.get(dbf, {}),
        }
        (out_dir / f"{card_id}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        manifest["presets"].append({"cardId": card_id, "dbfId": dbf, "label": label,
                                    "premium": premium, "template": template, "zone": zone})
        t = doc["tags"]
        print(f"[ok] {card_id} dbf={dbf} cost={t.get(48)} atk={t.get(47)} hp={t.get(45)} "
              f"type={t.get(202)} rarity={t.get(203)} race={t.get(200)} zh={doc['name']['zhCN']}")
    manifest["gameVersion"] = ver
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n[done] {len(manifest['presets'])} 卡数据 + manifest（缺 {len(manifest['missing'])}）→ {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
