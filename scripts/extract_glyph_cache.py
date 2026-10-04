# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "fonttools", "numpy"]
# ///
"""extract_glyph_cache — 渲染期会用到的字形全部按 (ttf, fs) 用 PIL/FreeType 光栅化进资产包。

动机：PIL/FreeType 执行 TrueType hinting（笔画贴格），JS 生态无等价物；TS 侧未命中缓存的字符
退回自研 unhinted 光栅 → 笔画边缘出现硬阶梯「毛刺」（实测：GDB_142「无界空宇」命中=平滑、
TTN_090「尤格-萨隆的监狱」未命中=锯齿）。渲染期所用字形一次性格子化 → TS 命中缓存即与 py 链
（L1 黄金）逐像素一致；未命中（DIY 任意文本）仍退回 TS 光栅并登记残差。

栅格化语义 = explore/hs-render 的 uber_text.FontMetrics 逐行同构（setmask2/bitmap_left/bitmap_top
口径）：本脚本自带实现（不依赖 explore/ py 链目录），`--verify` 用资产包内已有字形复算并逐字节比对
以证明两边等价。

字形集合 = 本仓渲染计划真正会画出的字符（zhCN）：
  data/fixtures/*.json 的 name / textInHand（去标签）+ 种族/学派文本（data/tables.json）
  + 数字角色（费/攻/血/护甲）用到的 0-9 与 '-'
按「卡型 → 手牌帧 slot」选帧（与 packages/renderer/src/plan.ts 的 CARD_TYPE_TO_SLOT 同源），
逐帧读 frames/{slot}/manifest.json 的 role_paths + prefab_ubertext.json 得到角色 → 字体 + 字号
（fs = trunc(fontdef.m_FontSizeModifier × locale9.m_FontSizeModifier × m_FontSize)）。

产出 PACK/glyphs/{fontStem}-{fs}/{codepoint}.png（L 模式 mask）+ meta.json（CharInfo + line_height）。

用法：
  uv run scripts/extract_glyph_cache.py            # 补齐缺失字形
  uv run scripts/extract_glyph_cache.py --verify   # 复算已有字形并逐字节比对（不动文件）
  uv run scripts/extract_glyph_cache.py --dry-run  # 只报会新增哪些字形
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_PACK = REPO / "assets"
DATA = REPO / "data"

# 卡型 → 手牌帧 slot（plan.ts CARD_TYPE_TO_SLOT 同源；未知卡型回落 hand-minion）
CARD_TYPE_TO_SLOT = {4: "hand-minion", 5: "hand-spell", 3: "hand-hero", 7: "hand-weapon",
                     39: "hand-location", 10: "hand-heropower"}
FALLBACK_SLOT = "hand-minion"
# 数字角色（费/攻/血/护甲）：渲染的是 tag 数字，逐帧字体字号取自对应 UberText 节点
NUMERIC_ROLES = ("cost", "attack", "health", "armor")
DIGITS = "0123456789-"
# 学派文本（法术帧 RaceUberText 承载）用的 TAG_SPELL_SCHOOL 枚举值
SPELL_SCHOOL_TAG = 1635
CARD_RACE_TAG = 200
ZHCN_LOCALE = 9


class FontMetrics:
    """FreeType 位图语义（explore/hs-render uber_text.FontMetrics 逐行同构）：
    minX=bitmap_left, maxX=minX+width, maxY=bitmap_top, minY=maxY−rows；
    advance=int(round(线性 hmtx×fs/upem))；line_height=ceil(ascent)−floor(descent)。"""

    def __init__(self, ttf_path: Path, font_size: int):
        self.path = str(ttf_path)
        self.size = int(font_size)
        self._pil = ImageFont.truetype(self.path, self.size)
        self._tt = TTFont(self.path)
        upem = self._tt["head"].unitsPerEm
        self._hmtx = self._tt["hmtx"]
        self._cmap = self._tt.getBestCmap()
        hhea = self._tt["hhea"]
        self.ascent = math.ceil(hhea.ascent * self.size / upem)
        self.descent = math.floor(hhea.descent * self.size / upem)
        self.line_height = self.ascent - self.descent
        self._pil_ascent = self._pil.getmetrics()[0]

    def render(self, ch: str) -> tuple[dict, np.ndarray]:
        gname = self._cmap.get(ord(ch))
        adv_units = self._hmtx[gname][0] if gname else 0
        advance = int(round(adv_units * self.size / self._tt["head"].unitsPerEm))
        try:
            mask, (ox, oy) = self._pil.getmask2(ch, mode="L")
            arr = np.asarray(mask, dtype=np.uint8)
            if arr.ndim == 1:  # ImagingCore 平面缓冲 → 行主序 2D
                arr = arr.reshape(mask.size[1], mask.size[0])
        except Exception:  # noqa: BLE001
            arr = np.zeros((1, 1), dtype=np.uint8)
            ox, oy = 0, 0
        if arr.ndim != 2 or arr.size == 0 or arr.shape[0] == 0 or arr.shape[1] == 0:
            arr = np.zeros((1, 1), dtype=np.uint8)
            return {"advance": advance, "minX": 0, "maxX": 0, "minY": 0, "maxY": 0,
                    "w": 1, "h": 1}, arr
        max_y = self._pil_ascent - oy
        return {"advance": advance, "minX": int(ox), "maxX": int(ox) + arr.shape[1],
                "minY": max_y - arr.shape[0], "maxY": max_y,
                "w": int(arr.shape[1]), "h": int(arr.shape[0])}, arr


def strip_tags(text: str) -> str:
    """split_rich 等价：<b>/</b> 与其它 <...> 标签剥离，保留字符序列。"""
    out = []
    i = 0
    while i < len(text):
        if text.startswith("<b>", i):
            i += 3
            continue
        if text.startswith("</b>", i):
            i += 4
            continue
        if text[i] == "<":
            j = text.find(">", i)
            if j != -1:
                i = j + 1
                continue
        out.append(text[i])
        i += 1
    return "".join(out)


def fontdefs(pack: Path) -> dict:
    return json.loads((pack / "fontdefs.json").read_text(encoding="utf-8"))["fontdefs"]


def locale9(fields: dict) -> dict:
    adj = (fields.get("m_LocalizedSettings") or {}).get("m_LocaleAdjustments") or []
    for a in adj:
        if a.get("m_Locale") == ZHCN_LOCALE:
            return a
    return {}


def role_fonts(pack: Path, slot: str, fdefs: dict) -> dict[str, tuple[str, int]]:
    """帧 slot → {role: (ttf 相对路径, fs)}（role_paths + UberText 节点字体字号）。"""
    man = json.loads((pack / "frames" / slot / "manifest.json").read_text(encoding="utf-8"))
    nodes = json.loads((pack / "frames" / slot / "prefab_ubertext.json")
                       .read_text(encoding="utf-8"))["nodes"]
    out: dict[str, tuple[str, int]] = {}
    for role, suffix in man["role_paths"].items():
        node = next(n for n in nodes if n["path"].endswith(suffix))
        font = node["font_name"]
        f = node["fields"]
        fd = fdefs[font]["zhcn"]
        fs = int(fd["fontdef"].get("m_FontSizeModifier", 1.0)
                 * locale9(f).get("m_FontSizeModifier", 1.0)
                 * (f.get("m_FontSize") or 0))
        out[role] = (fd["font_object"]["saved_to"], fs)
    return out


def collect_texts(pack: Path, data: Path, fdefs: dict,
                  extra: list[Path] | None = None) -> dict[tuple[str, int], set[str]]:
    """(ttf, fs) → 需要光栅化的字符集（zhCN 口径，与 plan.ts 的文本来源同源）。"""
    tables = json.loads((data / "tables.json").read_text(encoding="utf-8"))
    race_zh = {int(k): v for k, v in tables["raceZh"].items()}
    school_zh = {int(k): v for k, v in (tables.get("schoolZh") or {}).items()}
    need: dict[tuple[str, int], set[str]] = {}
    slot_cache: dict[str, dict] = {}

    # fixture 集（data/fixtures/*.json）为口径来源；--extra-card 追加实验卡（如 L2 同卡对照的临时 fixture）
    fixtures = sorted(p for p in (data / "fixtures").glob("*.json") if p.name != "manifest.json")
    fixtures += [Path(p) for p in (extra or [])]
    for path in fixtures:
        card = json.loads(path.read_text(encoding="utf-8"))
        tags = {int(k): v for k, v in card.get("tags", {}).items()}
        slot = CARD_TYPE_TO_SLOT.get(tags.get(202, 4), FALLBACK_SLOT)
        try:
            roles = slot_cache.setdefault(slot, role_fonts(pack, slot, fdefs))
        except FileNotFoundError:            # 帧未抽（资产包缺该 slot）→ 用回落帧字号
            roles = slot_cache.setdefault(FALLBACK_SLOT, role_fonts(pack, FALLBACK_SLOT, fdefs))
        race_id = tags.get(CARD_RACE_TAG, 0)
        school_id = tags.get(SPELL_SCHOOL_TAG, 0)
        race_text = race_zh.get(race_id, "") if race_id else ""
        school_text = school_zh.get(school_id, "") if school_id else ""
        for role, key in (("name", "name"), ("desc", "textInHand")):
            text = (card.get(key) or {}).get("zhCN", "")
            if role in roles and text:
                need.setdefault(roles[role], set()).update(strip_tags(text))
        if "race" in roles:
            # 法术帧 RaceUberText 装学派文本；其余帧装种族名（plan.ts bodyFor 同源）
            race_body = (school_text if slot == "hand-spell" else race_text) or race_text or school_text
            if race_body:
                need.setdefault(roles["race"], set()).update(race_body)
        for role in NUMERIC_ROLES:
            if role in roles:
                need.setdefault(roles[role], set()).update(DIGITS)
    return need


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=str(DEFAULT_PACK))
    ap.add_argument("--data", default=str(DATA))
    ap.add_argument("--verify", action="store_true", help="复算已有字形并逐字节比对（不写文件）")
    ap.add_argument("--verify-all", action="store_true",
                    help="复算**资产包内全部**已有字形并逐字节比对（等价性自证；不写文件）")
    ap.add_argument("--dry-run", action="store_true", help="只报缺失字形数")
    ap.add_argument("--extra-card", action="append", default=[],
                    help="额外纳入的 fixture JSON 路径（实验卡；可重复）")
    ap.add_argument("--fix-stale", action="store_true",
                    help="改写既有条目的元数据：mask 字节一致但 advance/box 与 hmtx 不符的历史脏值")
    args = ap.parse_args()
    pack, data = Path(args.pack), Path(args.data)

    fdefs = fontdefs(pack)
    need = collect_texts(pack, data, fdefs, args.extra_card)
    if args.verify_all or args.fix_stale:
        # 覆盖 need 之外的既有字形（含 py 链历史产出）：--verify-all 用来自证与 py 链逐字节等价，
        # --fix-stale 用来把历史脏元数据（advance 等）一并纳入改写范围
        if args.verify_all:
            args.verify = True
        for gdir in sorted((pack / "glyphs").iterdir()):
            meta_path = gdir / "meta.json"
            if not meta_path.is_file():
                continue
            stem, _, fs_s = gdir.name.rpartition("-")
            ttf = next((Path(v["zhcn"]["font_object"]["saved_to"])
                        for v in fdefs.values() if Path(v["zhcn"]["font_object"]["saved_to"]).stem == stem),
                       None)
            if ttf is None:
                continue
            need.setdefault((str(ttf), int(fs_s)), set()).update(
                chr(int(cp)) for cp in json.loads(meta_path.read_text(encoding="utf-8")) if cp.isdigit())
    stats = {"ok": 0, "new": 0, "mismatch": 0, "files": 0, "stale": 0}
    fields = ("advance", "minX", "maxX", "minY", "maxY", "w", "h")
    for (ttf_rel, fs), chars in sorted(need.items()):
        stem = Path(ttf_rel).stem
        gdir = pack / "glyphs" / f"{stem}-{fs}"
        meta_path = gdir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
        fm = FontMetrics(pack / ttf_rel, fs)
        added = 0
        dirty = False
        for ch in sorted(c for c in chars if c != "\n"):
            cp = str(ord(ch))
            info, arr = fm.render(ch)
            if args.verify:
                old = gdir / f"{cp}.png"
                if cp not in meta or not old.is_file():
                    continue
                a = np.asarray(Image.open(old).convert("L"))
                bad = [k for k in fields if int(meta[cp][k]) != int(info[k])]
                if a.shape == arr.shape and np.array_equal(a, arr) and not bad:
                    stats["ok"] += 1
                else:
                    stats["mismatch"] += 1
                    print(f"[MISMATCH] {stem}-{fs} U+{ord(ch):04X} {ch!r} mask一致="
                          f"{a.shape == arr.shape and np.array_equal(a, arr)} 字段差={bad}")
                continue
            if cp in meta and (gdir / f"{cp}.png").is_file():
                if args.fix_stale:
                    # 既有条目：mask 与本次光栅逐字节相同、仅元数据不符 → 按 hmtx 口径改写
                    a = np.asarray(Image.open(gdir / f"{cp}.png").convert("L"))
                    bad = [k for k in fields if int(meta[cp][k]) != int(info[k])]
                    if a.shape == arr.shape and np.array_equal(a, arr) and bad:
                        old_vals = {k: meta[cp][k] for k in bad}
                        for k in fields:
                            meta[cp][k] = info[k]
                        stats["stale"] += 1
                        dirty = True
                        print(f"[stale] {stem}-{fs} U+{ord(ch):04X} {ch!r} {old_vals} → "
                              f"{ {k: info[k] for k in bad} }")
                continue
            stats["new"] += 1
            added += 1
            if args.dry_run:
                continue
            gdir.mkdir(parents=True, exist_ok=True)
            Image.fromarray(arr, "L").save(gdir / f"{cp}.png")
            meta[cp] = info
            stats["files"] += 1
        n_glyph = len([k for k in meta if k.isdigit()])
        if args.verify or args.dry_run:
            print(f"[glyphs] {stem}-{fs}: 包内 {n_glyph} 字形，本次新增 {added}")
            continue
        if not added and not dirty:
            print(f"[glyphs] {stem}-{fs}: 包内 {n_glyph} 字形，无需变更")
            continue
        meta["line_height"] = fm.line_height
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[glyphs] {stem}-{fs}: 包内 {n_glyph} 字形，新增 {added}，脏值改写 {stats['stale']}，"
              f"line_height={fm.line_height}")
    if args.verify:
        print(f"[verify] 复算一致 {stats['ok']}，不一致 {stats['mismatch']}")
        return 1 if stats["mismatch"] else 0
    if args.dry_run:
        print(f"[dry-run] 计划新增 {stats['new']} 字形")
        return 0
    print(f"[done] 新增 {stats['new']} 字形（写入 {stats['files']} 文件）→ {pack / 'glyphs'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
