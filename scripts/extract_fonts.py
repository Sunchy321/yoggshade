# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.53"]
# ///
"""extract_fonts — 渲染字体进资产包（assets/fonts/ + assets/fontdefs.json + assets/fonts/metrics.json）。

来源：Angelia 冻结数据 fonts_zhcn/（Belwe/Belwe_Outline/FranklinGothic + fontdefs.json，
ANGELIA_HOME 指向 Angelia 工作区根）。该目录是历史产物的唯一现成来源——资产包导出链
正是从这里拷贝并改写 saved_to 后写进资产包；字体是 Blizzard 原始二进制，按资产边界
纪律只进 gitignored 资产包，不进 tracked data/。

产出：
  assets/fonts/{Belwe,Belwe_Outline,FranklinGothic}.ttf
  assets/fontdefs.json           —— 与源文件唯一差异：zhCN 侧 font_object.saved_to
                                    从 data/fonts_zhcn/<name>.ttf 改写为 fonts/<name>.ttf
                                    （TS 侧唯一读取方 ubertext.ts loadFontdev 只读 zhcn 侧）
  assets/fonts/metrics.json      —— 每字体 hhea.ascender/descender + head.unitsPerEm
                                    （ticket 18：FontMetrics 用它提供 ascent/descent/lineHeight，
                                    **懒解析** TTF——pack 字形全覆盖的卡不再为三个度量数
                                    parse 5.7-7.3 MB 字体进 opentype 对象。数值 = opentype.js
                                    运行时同源同表（font.ascender=hhea.ascender、
                                    font.descender=hhea.descender、unitsPerEm=head.unitsPerEm，
                                    实证 Belwe 900/-124/1024、Franklin 502/-113/512）， fixtures
                                    字节门禁验证。缺该文件的包回落即时 parse，行为不变。）

用法：uv run scripts/extract_fonts.py [--pack assets]
      （源默认取 Angelia 的 fonts_zhcn，ANGELIA_HOME 或 --src 可覆盖）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
ANGELIA_HOME = Path(os.environ.get(
    "ANGELIA_HOME", REPO.parent / "Angelia"))  # Angelia 工作区（py 渲染参照）


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ANGELIA_HOME / "data" / "fonts_zhcn"))
    ap.add_argument("--pack", default=str(REPO / "assets"))
    args = ap.parse_args()

    src = Path(args.src)
    pack = Path(args.pack)
    source_fontdefs = src / "fontdefs.json"
    if not source_fontdefs.is_file():
        print(f"[fail] 找不到 py 链字体数据 {source_fontdefs}（见脚本头注释的来源说明）", file=sys.stderr)
        return 1

    fontdefs = json.loads(source_fontdefs.read_text(encoding="utf-8"))
    fonts_dir = pack / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)

    copied: set[str] = set()
    for entry in fontdefs["fontdefs"].values():
        side = entry.get("zhcn") or {}
        saved_to = (side.get("font_object") or {}).get("saved_to")
        if not saved_to:
            continue
        name = Path(saved_to).name
        if not (src / name).is_file():
            print(f"[warn] fontdef 引用的 {name} 不在 {src}，跳过", file=sys.stderr)
            continue
        if name not in copied:
            shutil.copy2(src / name, fonts_dir / name)
            copied.add(name)
        side["font_object"]["saved_to"] = f"fonts/{name}"

    (pack / "fontdefs.json").write_text(json.dumps(fontdefs, ensure_ascii=False), encoding="utf-8")

    # metrics.json（懒解析度量，见头注释）：直接对拷进包的 TTF 读表
    from fontTools.ttLib import TTFont

    metrics: dict[str, dict[str, int]] = {}
    for name in sorted(copied):
        tf = TTFont(fonts_dir / name, lazy=True)
        hhea, head = tf["hhea"], tf["head"]
        metrics[name] = {
            "ascender": int(hhea.ascender),
            "descender": int(hhea.descender),
            "unitsPerEm": int(head.unitsPerEm),
        }
        tf.close()
    (fonts_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")

    print(f"[done] fonts/{sorted(copied)} + fontdefs.json + fonts/metrics.json -> {pack}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
