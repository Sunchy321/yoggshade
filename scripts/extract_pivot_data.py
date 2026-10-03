# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""extract_pivot_data — pivot 卡数据提取（ADR-0001 双固化的数据侧）。

数据源：本机炉石安装 Data/OSX/dbf.unity3d（客户端自带全量 DBF：213 表，
CARD 36,022 行 / CARD_TAG 260,954 行，与 hearth-sight PG v327 同源同量；
Angelia docs/notes/textbuilder-drift-measurement.md 记录 Windows 侧同文件）。
语言序：m_locValues 为 14 语言定长数组，下标 12 = zhCN 简体（Angelia 台账同口径）。

产出 data/pivots/：
  manifest.json   —— pivot 清单（30 张 CardPresets + glow 基准 12 token）+ 提取元数据
  {CARD_ID}.json  —— 单卡 canonical 数据：全部 14 语言 name/text、全量 tags、
                     textBuilderType、preset/glow 归属

用法：uv run scripts/extract_pivot_data.py [--out data/pivots]
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
PRESETS = [
    ("GDB_142", "默认烟测卡", "NORMAL", "Normal", "Hand", "当前导出器默认卡，用于验证普通手牌渲染基线。"),
    ("TOY_519", "法术基线", "NORMAL", "Normal", "Hand", "普通法术基线（有稀有度），用于验证法术版式、稀有度与战棋模板铸币光效。"),
    ("REV_365", "派系法术", "NORMAL", "Normal", "Hand", "派系法术基线，用于验证派系法术版式与 spell-school 光效。"),
    ("WON_332", "带阵营样例", "NORMAL", "Normal", "Hand", "带阵营标识样例，用于验证阵营相关卡面元素渲染。"),
    ("YOG_502", "锻造样例", "NORMAL", "Normal", "Hand", "锻造机制样例，用于验证锻造相关文本与卡面版式。"),
    ("LOOT_392", "武器基线", "NORMAL", "Normal", "Hand", "武器框体基线，用于检查攻击、耐久与稀有度渲染。"),
    ("AV_205", "英雄基线", "NORMAL", "Normal", "Hand", "英雄样例，用于验证英雄手牌框体、护甲和头像区域渲染。"),
    ("CATA_190h", "多职业英雄基线", "NORMAL", "Normal", "Hand", "多职业英雄样例，用于验证多职业英雄手牌框体渲染。"),
    ("TTN_090", "地标基线", "NORMAL", "Normal", "Hand", "地标样例，用于验证地标手牌框体与耐久区域渲染。"),
    ("DMF_709", "单种族随从", "NORMAL", "Normal", "Hand", "单种族随从样例，用于验证单行种族栏布局。"),
    ("CFM_637", "双种族随从", "NORMAL", "Normal", "Hand", "双种族随从样例，用于验证多种族文本布局与换行。"),
    ("AV_205p", "英雄技能基线", "NORMAL", "Normal", "Hand", "英雄技能样例，用于验证英雄技能导出。"),
    ("ETC_210", "多符文基线", "NORMAL", "Normal", "Hand", "多符文死亡骑士样例，用于验证多符文导出。"),
    ("TIME_EVENT_999", "金卡测试", "GOLDEN", "Normal", "Hand", "金卡样例，用于验证金卡导出。"),
    ("TTN_850", "钻石基线", "DIAMOND", "Normal", "Hand", "钻石卡样例，用于验证钻石导出。"),
    ("RLK_706", "异画1基线", "SIGNATURE", "Normal", "Hand", "异画样例 1，用于验证异画导出。"),
    ("WW_373", "异画2基线", "SIGNATURE", "Normal", "Hand", "异画样例 2，用于验证异画导出。"),
    ("GDB_477", "异画3基线", "SIGNATURE", "Normal", "Hand", "异画样例 3，用于验证异画导出。"),
    ("TLC_433", "异画4基线", "SIGNATURE", "Normal", "Hand", "异画样例 4，用于验证异画导出。"),
    ("SC_004", "异画5基线", "SIGNATURE", "Normal", "Hand", "异画样例 5，用于验证异画导出。"),
    ("TLC_EVENT_402", "异画6基线", "SIGNATURE", "Normal", "Hand", "异画样例 6，用于验证异画导出。"),
    ("BG33_828", "战棋等级随从", "NORMAL", "Battlegrounds", "Hand", "六星酒馆战棋随从，用于验证酒馆等级图标和战棋手牌样式。"),
    ("BG30_802", "酒馆法术基线", "NORMAL", "Battlegrounds", "Hand", "酒馆法术样例，用于验证 BaconSpell 手牌样式和法术框体。"),
    ("BG27_Anomaly_580", "畸变基线", "NORMAL", "Battlegrounds", "Hand", "战棋畸变样例，用于验证畸变导出。"),
    ("BG32_MagicItem_350", "饰品基线", "NORMAL", "Battlegrounds", "Hand", "战棋饰品样例，用于验证饰品导出。"),
    ("BG34_Giant_072", "时空扭曲随从", "NORMAL", "Battlegrounds", "Hand", "时空扭曲随从基线，用于验证时间酒馆随从的 TIME_TAVERN_TIER_ICON 图标渲染。"),
    ("BG34_Treasure_917", "时空扭曲法术", "NORMAL", "Battlegrounds", "Hand", "时空扭曲法术基线，用于验证时间酒馆法术的 TIME_TAVERN_TIER_ICON 图标渲染。"),
    ("PET_3_1", "宠物测试", "NORMAL", "Normal", "Hand", "宠物样例，用于验证宠物预览导出。"),
    ("LT23_802P2", "佣兵技能基线", "NORMAL", "Normal", "Hand", "佣兵技能样例，用于验证 LETTUCE_ABILITY 法术类技能 BigCard 渲染。"),
    ("LT23_803P2", "佣兵技能2", "NORMAL", "Normal", "Hand", "佣兵技能样例 2，用于验证另一张 LETTUCE_ABILITY 渲染。"),
]

# exporter docs/custom-glow-benchmark-plan.md（12 卡型 token；卡 ID 全部 ⊆ PRESETS）
GLOW_BENCH = [
    {"token": "minion-single-race", "cardId": "DMF_709", "template": "Normal", "parts": ["cost", "attack", "health", "rarity", "text", "name", "art", "race", "runes"], "runeOverride": 1},
    {"token": "minion-dual-race", "cardId": "CFM_637", "template": "Normal", "parts": ["cost", "attack", "health", "rarity", "text", "name", "art", "race", "runes"], "runeOverride": 1},
    {"token": "spell-school", "cardId": "REV_365", "template": "Normal", "parts": ["cost", "rarity", "text", "name", "art", "spell-school", "runes"], "runeOverride": 1},
    {"token": "weapon", "cardId": "LOOT_392", "template": "Normal", "parts": ["cost", "attack", "durability", "rarity", "text", "name", "art", "runes"], "runeOverride": 1},
    {"token": "hero", "cardId": "AV_205", "template": "Normal", "parts": ["cost", "armor", "rarity", "text", "name", "art", "runes"], "runeOverride": 1},
    {"token": "location", "cardId": "TTN_090", "template": "Normal", "parts": ["cost", "durability", "rarity", "text", "name", "art", "runes"], "runeOverride": 1},
    {"token": "bg-minion", "cardId": "BG33_828", "template": "Battlegrounds", "parts": ["cost", "attack", "health", "text", "name", "art", "tech-level"]},
    {"token": "tavern-spell", "cardId": "BG30_802", "template": "Battlegrounds", "parts": ["cost-coin", "text", "name", "art", "tech-level", "spell-school"]},
    {"token": "hero-power", "cardId": "AV_205p", "template": "Normal", "parts": ["cost-relocated", "text-shape"]},
    {"token": "trinket", "cardId": "BG32_MagicItem_350", "template": "Battlegrounds", "parts": ["cost-coin", "text-shape", "trinket-size"]},
    {"token": "spell-bg", "cardId": "TOY_519", "template": "Battlegrounds", "parts": ["cost-coin", "rarity", "text", "name", "art"]},
    {"token": "hero-power-bg", "cardId": "AV_205p", "template": "Battlegrounds", "parts": ["cost-coin", "text-shape"]},
]


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "data" / "pivots"))
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

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
        "adr": "docs/adr/0001-pivot-frozen-benchmark-data.md",
        "presets": [], "missing": [], "glowBench": GLOW_BENCH,
    }
    for card_id, label, premium, template, zone, reason in PRESETS:
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
        (out_dir / f"{card_id}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        manifest["presets"].append({"cardId": card_id, "dbfId": dbf, "label": label,
                                    "premium": premium, "template": template, "zone": zone})
        t = doc["tags"]
        print(f"[ok] {card_id} dbf={dbf} cost={t.get(48)} atk={t.get(47)} hp={t.get(45)} "
              f"type={t.get(202)} rarity={t.get(203)} race={t.get(200)} zh={doc['name']['zhCN']}")
    manifest["gameVersion"] = ver
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n[done] {len(manifest['presets'])} 卡数据 + manifest（缺 {len(manifest['missing'])}）→ {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
