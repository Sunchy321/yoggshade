# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_static_tables — 渲染计划用的静态枚举/查名表冻结（data/tables.json）。

内容与来源：
- class:      TAG_CLASS 枚举值 → 枚举名（explore/ilspy/TAG_CLASS.cs 反编译枚举序；
              CardColorSwitcher.GetColorTypeForClass 的 switch 键即此枚举，见
              explore/ilspy/CardColorSwitcher.cs:171-189）。注意不能用 tag_enum.csv 的
              s_classNames 行：那些值是 GameStrings 名称表的下标（Neutral 起头、无 Paladin），
              与 TAG_CLASS 枚举值不是一回事，按它查表会把德鲁伊/猎人/法师/圣骑士/恶魔猎手
              错配到别的职业框体（LOOT_392 德鲁伊武器渲染成恶魔猎手深绿框即此因）。
- schoolZh:   TAG_SPELL_SCHOOL 枚举值 → zhCN 学派名（枚举序 explore/ilspy/TAG_SPELL_SCHOOL.cs +
              tag_enum.csv 的 label_enUS/label_zhCN 按名对齐；CSV 的 value 列是名称表下标，不可直用）
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
import os
import re
import sys

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")
# 枚举/名称表冻结数据源：Angelia（data/ 枚举表 + lab decomp 缓存）
ANGELIA_HOME = Path(os.environ.get("ANGELIA_HOME", REPO.parent / "Angelia"))
EXPLORE_DATA = ANGELIA_HOME / "data"
TAG_ENUM = EXPLORE_DATA / "card_tags" / "tag_enum.csv"
GAME_TAG = EXPLORE_DATA / "game_tag.csv"
ILSPY = REPO / "explore" / "ilspy"
TAG_CLASS_CS = ILSPY / "TAG_CLASS.cs"
TAG_SPELL_SCHOOL_CS = ILSPY / "TAG_SPELL_SCHOOL.cs"
TAG_RACE_CS = ANGELIA_HOME / "lab" / "2026-09-30-mana-gem-locator" / "output" / "decomp-gem" / "full" / "TAG_RACE.cs"
SWITCHER_BUNDLE = HS_DATA / "essential_base_global-prefab-0.unity3d"


def parse_enum_names(path: Path, expect: dict[str, str]) -> dict[str, str]:
    """反编译枚举 .cs → {值: 枚举名}（隐式序号续排；expect 为抽查断言）。"""
    out: dict[str, str] = {}
    value = -1
    for m in re.finditer(r"^\s*([A-Z_]+)\s*(?:=\s*(\d+))?,?", path.read_text(encoding="utf-8"), re.M):
        name, explicit = m.group(1), m.group(2)
        value = int(explicit) if explicit is not None else value + 1
        out[str(value)] = name
    for k, v in expect.items():
        if out.get(k) != v:
            raise SystemExit(f"{path}: 枚举解析结果不合预期（{k}={out.get(k)}，期望 {v}）")
    return out


def parse_tag_class_enum() -> dict[str, str]:
    """TAG_CLASS.cs 反编译枚举 → {值: 枚举名}（CardColorSwitcher switch 的键）。"""
    return parse_enum_names(TAG_CLASS_CS, {"2": "DRUID", "14": "DEMONHUNTER", "12": "NEUTRAL"})


def parse_school_zh() -> dict[str, str]:
    """TAG_SPELL_SCHOOL.cs 枚举序 → zhCN 学派名（name 对齐 tag_enum.csv 的 label_enUS/label_zhCN）。

    注意不能用 CSV 的 value 列：那是 GameStrings 名称表下标（冰霜=4、自然=11…），与 TAG_SPELL_SCHOOL
    枚举值（FROST=3、NATURE=4…）不是一回事——REV_365 的学派 tag=4 是 NATURE(自然)，照 CSV 取值会渲染成
    "冰霜"（官方卡面为"自然"，2026-10-03 与官方导出图对照发现）。"""
    enum_names = parse_enum_names(TAG_SPELL_SCHOOL_CS, {"1": "ARCANE", "4": "NATURE", "6": "SHADOW"})
    zh_by_name: dict[str, str] = {}
    lines = TAG_ENUM.read_text(encoding="utf-8").splitlines()
    header = lines[0].split(",")
    idx = {c: i for i, c in enumerate(header)}
    for ln in lines[1:]:
        parts = ln.split(",")
        if len(parts) < len(header):
            continue
        if parts[idx["enum_class"]] == "TAG_SPELL_SCHOOL" and parts[idx["variant"]] == "s_spellSchoolNames":
            zh_by_name[parts[idx["label_enUS"]].replace(" ", "_").upper()] = parts[idx["label_zhCN"]]
    # CSV 无 2023 后新增学派行（PHYSICAL_COMBAT/TAVERN/SPELLCRAFT/LESSER|GREATER_TRINKET/UPGRADE，
    # GameStrings.cs:1168-1200 有键但 tag_enum.csv 未收录）。TAVERN 的 zhCN 取游戏内通用译名「酒馆」
    # （GLOBAL_SPELL_SCHOOL_TAVERN；BG 法术学派板，BG30_80p 首证，用户视觉复核项）。其余无译名来源 →
    # 不落表（渲染侧 schoolText 为 UNKNOWN 的兜底不触发，因 plate 文本为空即不渲染）。
    zh_by_name.setdefault("TAVERN", "酒馆")
    return {value: zh_by_name[name] for value, name in enum_names.items() if name in zh_by_name}


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


def _rel(p: Path) -> str:
    """展示用短写：REPO 内相对化；Angelia 内以 "Angelia/" 前缀短写；其余保留绝对形式。"""
    try:
        return str(p.relative_to(REPO))
    except ValueError:
        pass
    try:
        return "Angelia/" + str(p.relative_to(ANGELIA_HOME))
    except ValueError:
        return str(p)


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
            "class": _rel(TAG_CLASS_CS),
            "schoolZh": f"{_rel(TAG_SPELL_SCHOOL_CS)} + {_rel(TAG_ENUM)}",
            "raceZh": f"{_rel(TAG_RACE_CS)} + {_rel(GAMESTRINGS_CS)} + Strings/zhCN/GLOBAL.txt",
            "colorSwitcher": str(SWITCHER_BUNDLE.relative_to("/Applications/Hearthstone")),
            "hideTags": _rel(GAME_TAG),
        },
        "class": parse_tag_class_enum(),
        "raceZh": race_zh,
        "schoolZh": parse_school_zh(),
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
