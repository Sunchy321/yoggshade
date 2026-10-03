# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_static_tables — 渲染计划用的静态枚举/查名表冻结（data/tables.json）。

内容与来源：
- class:      TAG_CLASS 枚举值 → 英文名（DLL 反射导出 tag_enum.csv，TAG_CLASS/s_classNames）
- raceZh:     TAG_RACE 枚举值 → zhCN 种族名（TAG_RACE.cs 反编译枚举序 + 游戏 Strings/zhCN/GLOBAL.txt
              的 GLOBAL_RACE_*；同 GameStrings.GetRaceName 链）
- colorSwitcher: CardColorSwitcher 单例序列化列表本体（essential_base_global-prefab-0 内
              MonoBehaviour，含 GENERIC/双职业/佣兵/战棋全部槽位）——图集本体由
              scripts/extract_class_atlases.py 提取。注：旧 colorswitcher 探针按职业名扫描
              重建，漏掉无后缀的 Card_Inhand_Generic（槽 0），导致中立卡缺框，已弃用。
- hideTags:   HIDE 族 GAME_TAG id（game_tag.csv，DLL 反射）

用法：uv run scripts/extract_static_tables.py [--out data/tables.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")
EXPLORE_DATA = REPO / "explore" / "hs-render" / "data"
TAG_ENUM = EXPLORE_DATA / "card_tags" / "tag_enum.csv"
GAME_TAG = EXPLORE_DATA / "game_tag.csv"
TAG_RACE_CS = REPO / "explore" / "hs-render" / "lab" / "2026-09-30-mana-gem-locator" / "output" / "decomp-gem" / "full" / "TAG_RACE.cs"
SWITCHER_BUNDLE = HS_DATA / "essential_base_global-prefab-0.unity3d"


def parse_enum_csv() -> dict[str, str]:
    """tag_enum.csv 的 TAG_CLASS/s_classNames/label_enUS 列 → {value: name}。"""
    out: dict[str, str] = {}
    lines = TAG_ENUM.read_text(encoding="utf-8").splitlines()
    header = lines[0].split(",")
    idx = {c: i for i, c in enumerate(header)}
    for ln in lines[1:]:
        parts = ln.split(",")
        if len(parts) < len(header):
            continue
        if parts[idx["enum_class"]] == "TAG_CLASS" and parts[idx["variant"]] == "s_classNames":
            out[parts[idx["value"]]] = parts[idx["label_enUS"]]
    return out


GAMESTRINGS_CS = TAG_RACE_CS.parent / "GameStrings.cs"


def race_key_map() -> dict[int, str]:
    """TAG_RACE.cs 枚举序 + decomp GameStrings.cs 的 s_raceNames 表（TAG_RACE 名 → GLOBAL_RACE_* 键）。"""
    enum_val: dict[str, int] = {}
    cur = 0
    for m in re.finditer(r"^\s+([A-Z_]+)\s*=\s*(\d+),?|^\s+([A-Z_]+),", TAG_RACE_CS.read_text(encoding="utf-8"), re.M):
        if m.group(1):
            cur = int(m.group(2))
            enum_val[m.group(1)] = cur
        elif m.group(3):
            cur += 1
            enum_val[m.group(3)] = cur
    text = GAMESTRINGS_CS.read_text(encoding="utf-8")
    start = text.find("s_raceNames = new Map")
    end = text.find("s_raceNamesBattlegrounds")
    pairs = re.findall(r"TAG_RACE\.([A-Z_]+),\s*\n?\s*\"(GLOBAL_RACE_[A-Z_]+)\"", text[start:end])
    return {enum_val[name]: key for name, key in pairs if name in enum_val}


def race_strings_zhcn() -> dict[str, str]:
    """GLOBAL.txt 的 GLOBAL_RACE_* = zhCN 值（TSV：key\t...）。"""
    out: dict[str, str] = {}
    text = (HS_DATA.parent.parent / "Strings" / "zhCN" / "GLOBAL.txt").read_text(encoding="utf-8")
    for ln in text.splitlines():
        if ln.startswith("GLOBAL_RACE_") and "\t" in ln:
            key, _, val = ln.partition("\t")
            out[key.strip()] = val.strip()
    return out


def hide_tags() -> dict[str, int]:
    out: dict[str, int] = {}
    for ln in GAME_TAG.read_text(encoding="utf-8").splitlines()[1:]:
        parts = ln.split(",")
        if len(parts) >= 2 and parts[1].startswith("HIDE_"):
            out[parts[1]] = int(parts[0])
    return out


def switcher_lists() -> dict[str, list[str | None]]:
    """CardColorSwitcher 单例序列化列表本体（字符串列表字段全量导出）。"""
    env = UnityPy.load(str(SWITCHER_BUNDLE))
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        t = o.read_typetree()
        if isinstance(t, dict) and "minionCardTextures" in t:
            return {k: v for k, v in t.items()
                    if isinstance(v, list) and v and isinstance(v[0], str)}
    raise SystemExit(f"{SWITCHER_BUNDLE}: 未找到 CardColorSwitcher 序列化（minionCardTextures）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "data" / "tables.json"))
    args = ap.parse_args()
    keys = race_key_map()
    strings = race_strings_zhcn()
    race_zh = {rid: strings.get(key, "") for rid, key in sorted(keys.items())}
    tables = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "class": str(TAG_ENUM.relative_to(REPO)),
            "raceZh": f"{TAG_RACE_CS.relative_to(REPO)} + {GAMESTRINGS_CS.relative_to(REPO)} + Strings/zhCN/GLOBAL.txt",
            "colorSwitcher": str(SWITCHER_BUNDLE.relative_to("/Applications/Hearthstone")),
            "hideTags": str(GAME_TAG.relative_to(REPO)),
        },
        "class": parse_enum_csv(),
        "raceZh": race_zh,
        "colorSwitcher": switcher_lists(),
        "hideTags": hide_tags(),
    }
    out = Path(args.out)
    out.write_text(json.dumps(tables, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[done] class={len(tables['class'])} raceZh={len(race_zh)} hide={len(hide_tags())} → {out}")
    print("raceZh 样例:", {k: race_zh[k] for k in list(race_zh)[:5]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
