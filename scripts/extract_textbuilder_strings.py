# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_textbuilder_strings — 提取 @tcg-cards/hs-text-builder 依赖的 GameStrings 文本。

数据源：hsdata/Strings/<lang>/*.txt（14 语言，TSV：TAG/TEXT/COMMENT；炉石全语言字符串
数据，与本地安装 /Applications/Hearthstone/Strings 同源）。路径经 --hsdata 或环境变量
YOGGRAPH_HSDATA 提供（含个人机器布局，不入库）。
提取 key 清单 = packages/textbuilder 里 builder 依赖的全部 GameStrings 键族
（builders.ts 内 BLOCK 的 gameString 调用 + GameplayString per-card 前缀族）：

  精确键  GAMEPLAY_UNKNOWN_CREATED_BY / GALAKROND_ONCE / GALAKROND_TWICE /
          GAMEPLAY_UNDATAKAH1-3
  前缀族  GAMEPLAY_HERALD_* / ZILLIAX_DELUXE_COMBINED_MODULE_* / ZILLIAX_DELUXE_MODULE_*
          GAMEPLAY_DIAMOND|PEARL|SAPPHIRE|JASPER|AMETHYST|RUBY|ONYX_SPELLSTONE_*
          GAMEPLAY_LOOT_526d_DARKNESS_* / GAMEPLAY_TOT_109t_STASIS_DRAGON_*
          GAMEPLAY_TRLA_TROLL_SHRINE_*

产出 packages/textbuilder/data/gamestrings.json：
  { "<lang>": { "<key>": "<text>" }, ... }（14 语言全覆盖；缺 key 不写键）
  另附四块（每语言）：
  "keywords": { "<GAME_TAG数值>": "关键词名" }（DBF KEYWORD_TEXT：tag→GLOBAL_KEY × Strings；
              GetKeywordName 对译，GameStrings.cs:1550）
  "classes":  { "<TAG_CLASS数值>": "职业名" }（s_classNames 映射 GameStrings.cs:52 ×
              Strings GLOBAL_CLASS_*；GetClassName 对译，:1465）
  "races":    { "<TAG_RACE数值>": "种族名" }（s_raceNames 映射 × GLOBAL_RACE_*；
              GetRaceName 对译，:1719）
  "racesBattlegrounds": { ... }（s_raceNamesBattlegrounds × GLOBAL_RACE_*_BATTLEGROUNDS；
              GetRaceNameBattlegrounds 对译，:1744；GetRaceString count>1 时用）

用法：uv run scripts/extract_textbuilder_strings.py --hsdata <Strings 目录>
      [--dbf <dbf.unity3d 或含 KEYWORD_TEXT 的 dbf 快照>]
数据源（含个人机器布局）经参数/环境变量提供，不入库。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_OUT = REPO / "packages" / "textbuilder" / "data" / "gamestrings.json"
# TAG_RACE 数值（TAG_RACE.cs 全量）
RACE_IDS = {
    "INVALID": 0, "BLOODELF": 1, "DRAENEI": 2, "DWARF": 3, "GNOME": 4, "GOBLIN": 5,
    "HUMAN": 6, "NIGHTELF": 7, "ORC": 8, "TAUREN": 9, "TROLL": 10, "UNDEAD": 11,
    "WORGEN": 12, "GOBLIN2": 13, "MURLOC": 14, "DEMON": 15, "SCOURGE": 16,
    "MECHANICAL": 17, "ELEMENTAL": 18, "OGRE": 19, "BEAST": 20, "TOTEM": 21,
    "NERUBIAN": 22, "PIRATE": 23, "DRAGON": 24, "BLANK": 25, "ALL": 26, "EGG": 38,
    "QUILBOAR": 43, "CENTAUR": 80, "FURBOLG": 81, "HIGHELF": 83, "TREANT": 84,
    "OWLKIN": 85, "HALFORC": 88, "LOCK": 89, "NAGA": 92, "OLDGOD": 93, "PANDAREN": 94,
    "GRONN": 95, "CELESTIAL": 96, "GNOLL": 97, "GOLEM": 98, "HARPY": 99, "VULPERA": 100,
}
# s_raceNames（GameStrings.cs:104-276）：RACE 名 → GLOBAL_RACE 键名
RACE_KEYS = {
    "BLOODELF": "GLOBAL_RACE_BLOODELF", "DRAENEI": "GLOBAL_RACE_DRAENEI",
    "DWARF": "GLOBAL_RACE_DWARF", "GNOME": "GLOBAL_RACE_GNOME",
    "GOBLIN": "GLOBAL_RACE_GOBLIN", "HUMAN": "GLOBAL_RACE_HUMAN",
    "NIGHTELF": "GLOBAL_RACE_NIGHTELF", "ORC": "GLOBAL_RACE_ORC",
    "TAUREN": "GLOBAL_RACE_TAUREN", "TROLL": "GLOBAL_RACE_TROLL",
    "UNDEAD": "GLOBAL_RACE_UNDEAD", "WORGEN": "GLOBAL_RACE_WORGEN",
    "MURLOC": "GLOBAL_RACE_MURLOC", "DEMON": "GLOBAL_RACE_DEMON",
    "SCOURGE": "GLOBAL_RACE_SCOURGE", "MECHANICAL": "GLOBAL_RACE_MECHANICAL",
    "ELEMENTAL": "GLOBAL_RACE_ELEMENTAL", "OGRE": "GLOBAL_RACE_OGRE",
    "BEAST": "GLOBAL_RACE_PET", "TOTEM": "GLOBAL_RACE_TOTEM",
    "NERUBIAN": "GLOBAL_RACE_NERUBIAN", "PIRATE": "GLOBAL_RACE_PIRATE",
    "DRAGON": "GLOBAL_RACE_DRAGON", "ALL": "GLOBAL_RACE_ALL",
    "EGG": "GLOBAL_RACE_EGG", "QUILBOAR": "GLOBAL_RACE_QUILBOAR",
    "CENTAUR": "GLOBAL_RACE_CENTAUR", "FURBOLG": "GLOBAL_RACE_FURBOLG",
    "HIGHELF": "GLOBAL_RACE_HIGHELF", "TREANT": "GLOBAL_RACE_TREANT",
    "OWLKIN": "GLOBAL_RACE_OWLKIN", "HALFORC": "GLOBAL_RACE_HALFORC",
    "LOCK": "GLOBAL_RACE_LOCK", "NAGA": "GLOBAL_RACE_NAGA",
    "OLDGOD": "GLOBAL_RACE_OLDGOD", "PANDAREN": "GLOBAL_RACE_PANDAREN",
    "GRONN": "GLOBAL_RACE_GRONN", "CELESTIAL": "GLOBAL_RACE_CELESTIAL",
    "GNOLL": "GLOBAL_RACE_GNOLL", "GOLEM": "GLOBAL_RACE_GOLEM",
    "HARPY": "GLOBAL_RACE_HARPY", "VULPERA": "GLOBAL_RACE_VULPERA",
}
# s_raceNamesBattlegrounds（GameStrings.cs:276+）：RACE 名 → _BATTLEGROUNDS 键名
RACE_BG_KEYS = {
    "BLOODELF": "GLOBAL_RACE_BLOODELF_BATTLEGROUNDS",
    "DRAENEI": "GLOBAL_RACE_DRAENEI_BATTLEGROUNDS",
    "DWARF": "GLOBAL_RACE_DWARF_BATTLEGROUNDS",
    "GNOME": "GLOBAL_RACE_GNOME_BATTLEGROUNDS",
    "GOBLIN": "GLOBAL_RACE_GOBLIN_BATTLEGROUNDS",
    "HUMAN": "GLOBAL_RACE_HUMAN_BATTLEGROUNDS",
    "NIGHTELF": "GLOBAL_RACE_NIGHTELF_BATTLEGROUNDS",
    "ORC": "GLOBAL_RACE_ORC_BATTLEGROUNDS",
    "TAUREN": "GLOBAL_RACE_TAUREN_BATTLEGROUNDS",
    "TROLL": "GLOBAL_RACE_TROLL_BATTLEGROUNDS",
    "UNDEAD": "GLOBAL_RACE_UNDEAD_BATTLEGROUNDS",
    "WORGEN": "GLOBAL_RACE_WORGEN_BATTLEGROUNDS",
    "MURLOC": "GLOBAL_RACE_MURLOC_BATTLEGROUNDS",
    "DEMON": "GLOBAL_RACE_DEMON_BATTLEGROUNDS",
    "SCOURGE": "GLOBAL_RACE_SCOURGE_BATTLEGROUNDS",
    "MECHANICAL": "GLOBAL_RACE_MECHANICAL_BATTLEGROUNDS",
    "ELEMENTAL": "GLOBAL_RACE_ELEMENTAL_BATTLEGROUNDS",
    "OGRE": "GLOBAL_RACE_OGRE_BATTLEGROUNDS",
    "BEAST": "GLOBAL_RACE_PET_BATTLEGROUNDS",
    "TOTEM": "GLOBAL_RACE_TOTEM_BATTLEGROUNDS",
    "NERUBIAN": "GLOBAL_RACE_NERUBIAN_BATTLEGROUNDS",
    "PIRATE": "GLOBAL_RACE_PIRATE_BATTLEGROUNDS",
    "DRAGON": "GLOBAL_RACE_DRAGON_BATTLEGROUNDS",
    "ALL": "GLOBAL_RACE_ALL_BATTLEGROUNDS",
    "EGG": "GLOBAL_RACE_EGG_BATTLEGROUNDS",
    "NAGA": "GLOBAL_RACE_NAGA_BATTLEGROUNDS",
    "QUILBOAR": "GLOBAL_RACE_QUILBOARS_BATTLEGROUNDS",
}
# TAG_CLASS 数值 → GLOBAL_CLASS 键（GameStrings.cs:52 s_classNames 映射）
CLASS_NAMES = {
    1: "DEATHKNIGHT", 2: "DRUID", 3: "HUNTER", 4: "MAGE", 5: "PALADIN",
    6: "PRIEST", 7: "ROGUE", 8: "SHAMAN", 9: "WARLOCK", 10: "WARRIOR",
    14: "DEMONHUNTER",
}
LANGS = ["zhCN", "enUS", "deDE", "esES", "esMX", "frFR", "itIT", "jaJP", "koKR",
         "plPL", "ptBR", "ruRU", "thTH", "zhTW"]

EXACT_KEYS = [
    "GAMEPLAY_UNKNOWN_CREATED_BY",
    "GALAKROND_ONCE",
    "GALAKROND_TWICE",
    "GAMEPLAY_UNDATAKAH1",
    "GAMEPLAY_UNDATAKAH2",
    "GAMEPLAY_UNDATAKAH3",
]
PREFIX_FAMILIES = [
    "GAMEPLAY_HERALD_",
    "ZILLIAX_DELUXE_COMBINED_MODULE_",
    "ZILLIAX_DELUXE_MODULE_",
    "GAMEPLAY_DIAMOND_SPELLSTONE_",
    "GAMEPLAY_PEARL_SPELLSTONE_",
    "GAMEPLAY_SAPPHIRE_SPELLSTONE_",
    "GAMEPLAY_JASPER_SPELLSTONE_",
    "GAMEPLAY_AMETHYST_SPELLSTONE_",
    "GAMEPLAY_RUBY_SPELLSTONE_",
    "GAMEPLAY_ONYX_SPELLSTONE_",
    "GAMEPLAY_LOOT_526d_DARKNESS_",
    "GAMEPLAY_TOT_109t_STASIS_DRAGON_",
    "GAMEPLAY_TRLA_TROLL_SHRINE_",
]
SOURCE_FILES = ["GAMEPLAY.txt", "GLOBAL.txt", "ZILLIAX_DELUXE_3000.txt"]


def load_strings_file(f: Path) -> dict[str, str]:
    """TSV（TAG/TEXT/COMMENT）→ {TAG: TEXT}；重复 TAG 首见胜出。"""
    table: dict[str, str] = {}
    if not f.is_file():
        return table
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].strip() and parts[0].strip() != "TAG":
            table.setdefault(parts[0].strip(), parts[1])
    return table


def load_keyword_text(dbf_path: str) -> dict[int, str]:
    """DBF KEYWORD_TEXT 表：m_tag → m_name（GLOBAL_KEY；GetKeywordTextRecord 同口径，
    GameStrings.cs:1544-1548）。"""
    env = UnityPy.load(dbf_path)
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        t = o.read_typetree()
        if t.get("m_Name") == "KEYWORD_TEXT":
            out: dict[int, str] = {}
            for r in t["Records"]:
                name = r.get("m_name")
                tag_id = r.get("m_tagId")
                if name and tag_id:
                    out.setdefault(int(tag_id), name)
            return out
    raise SystemExit(f"{dbf_path}: 无 KEYWORD_TEXT 表")


def wanted(key: str) -> bool:
    if key in EXACT_KEYS:
        return True
    return any(key.startswith(p) for p in PREFIX_FAMILIES)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hsdata", default=os.environ.get("YOGGRAPH_HSDATA"),
                    help="hsdata/Strings 目录（环境变量 YOGGRAPH_HSDATA 亦可）")
    ap.add_argument("--dbf", default=os.environ.get("YOGGRAPH_DBF"),
                    help="dbf.unity3d（含 KEYWORD_TEXT 表；环境变量 YOGGRAPH_DBF 亦可）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()
    if not args.hsdata:
        raise SystemExit(
            "缺少数据源路径：--hsdata <hsdata/Strings> 或环境变量 YOGGRAPH_HSDATA "
            "（全语言炉石字符串数据，按机器布局提供，不入库）")
    hsdata = Path(args.hsdata)
    if not hsdata.is_dir():
        raise SystemExit(f"{hsdata}: Strings 目录不存在（--hsdata 指向 hsdata/Strings）")

    out: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        lang_dir = hsdata / lang
        if not lang_dir.is_dir():
            print(f"[miss] {lang}（无目录，跳过）")
            continue
        table: dict[str, str] = {}
        for name in SOURCE_FILES:
            f = lang_dir / name
            if not f.is_file():
                continue
            for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                parts = line.split("\t")
                if len(parts) < 2:
                    continue
                key, text = parts[0].strip(), parts[1]
                if wanted(key) and key not in table and text:
                    table[key] = text
        out[lang] = table
        print(f"[{lang}] {len(table)} keys")

    # KEYWORD_TEXT 表（tag → GLOBAL_KEY）与 GLOBAL_CLASS_*
    if args.dbf:
        kw_by_key = load_keyword_text(args.dbf)
        for lang, table in out.items():
            gl = load_strings_file(hsdata / lang / "GLOBAL.txt")
            table["keywords"] = {
                str(tag_id): gl.get(gkey, "").strip() or gl.get(gkey, "")
                for tag_id, gkey in kw_by_key.items()
                if gl.get(gkey)
            }
            table["classes"] = {
                str(cid): gl.get(f"GLOBAL_CLASS_{cname}", "").strip()
                for cid, cname in CLASS_NAMES.items()
                if gl.get(f"GLOBAL_CLASS_{cname}")
            }
            races = {}
            races_bg = {}
            for rname, rkey in RACE_KEYS.items():
                v = gl.get(rkey, "")
                if v:
                    races[str(RACE_IDS[rname])] = v
            for rname, rkey in RACE_BG_KEYS.items():
                v = gl.get(rkey, "")
                if v:
                    races_bg[str(RACE_IDS[rname])] = v
            table["races"] = races
            table["racesBattlegrounds"] = races_bg
        n_kw = len(out.get("zhCN", {}).get("keywords", {}))
        n_cls = len(out.get("zhCN", {}).get("classes", {}))
        print(f"[keywords] {n_kw} tags；[classes] {n_cls} classes")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(len(t) for t in out.values())
    print(f"[done] {total} keys × {len(out)} langs → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
