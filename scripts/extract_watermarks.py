# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy", "pillow"]
# ///
"""extract_watermarks — 卡集水印提取（长期工具）：三张数据表 + 水印纹理族。

正典出处（canonical decomp，exporter ilspy 缓存 Assembly-Csharp；研究文档
docs/findings/watermark-rendering-2026-10-07.md）：
  - Actor.UpdateWatermark（Actor.cs:5075-5135，UpdateDescriptionMesh :5071 恒调）：
    纹理四级优先 = actor 级 WATERMARK_OVERRIDE_CARD_SET → 逐卡 CARD DBF
    m_watermarkTextureOverride（EntityDef.cs:258-261）→ CARD_SET DBF
    m_cardWatermarkTexture（按 GetCardSet）→ IsCoreCard 无条件年标
    CoreIcon_Odd/Even（SetRotationIcon.cs:33-40，奇偶=轮换年%2，冻结口径=Even）；
    alpha = 99/128（HIDE_WATERMARK 1107 或纹理空串 → 0）。
  - GetCardSet（EntityBase.cs:1351-1377）：tag 183 恒缺省（CARD_TAG 0 行）→
    CARD_SET_TIMING 表序首条活跃 timing；离线正典仅 SPECIAL_EVENT_ALWAYS(203)
    判活（EventTimingManager.IsEventActive_Impl；164 恒假、服务器窗口事件离线判假）。
  - 渲染几何（尺寸/位置）不在本表范围：desc mesh UV1 + 序列化 _SecondTex_ST
    + 运行时 offset.y（withRace 规则）由 extract_frame.py / 渲染层固定复刻。

产物（幂等，纹理已存在则跳过）：
  data/card_meta/card_set_watermarks.json      set → 水印纹理映射 + core 标记
  data/card_meta/card_set_timings.json         card_id → [[set_id, event], ...]（DBF 表序）
  data/card_meta/card_watermark_overrides.json 逐卡水印纹理 override（非空全集）
  assets/watermarks/{资产实名}_{guid8}.png     纹理族（CARD_SET 非空 + 年标 + override）

上游脚本（Angelia lab/2026-10-02-textless-align ta_extract_watermarks.py、
lab/2026-10-04-watermark-chain wc_extract_card_set_timings.py）为 Windows 链
（硬编码 D:\ 路径、依赖前任实验 npz/CSV），本脚本是 yoggshade 侧重写：
直读本机安装（/Applications/Hearthstone/Data/OSX，HS_GAME_DATA 可覆盖），
Resolver 解析 refs（探针实证 47/47 全解析），不依赖任何实验产物。
短 guid 前缀的序列化占位（GenFX_Set1_Icon.psd:9996d2ef）不在 catalog、运行时
恒被 UpdateWatermark 改写 —— 不提取。

用法：
  uv run scripts/extract_watermarks.py [--pack assets] [--data data]
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import warnings
from datetime import datetime, timezone
from pathlib import Path

import UnityPy
from PIL import Image

warnings.filterwarnings("ignore")
UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

import sys  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from resolve_asset_ref import Resolver  # noqa: E402

HS_DATA = Path(os.environ.get("HS_GAME_DATA", "/Applications/Hearthstone/Data/OSX"))
DBF = "Assets/Game/DBF-Asset"

# SetRotationIcon.cs:15/17（decomp 全 guid 硬编码；offline 冻结口径取 Even，78325 参照裁决）
CORE_ICONS = [
    "CoreIcon_Odd.tif:66255e7e42828b94c828861986fa68f8",
    "CoreIcon_Even.tif:8f398522346ce634bb1e26b2f556403f",
]


def game_version() -> str:
    pl = plistlib.load(open("/Applications/Hearthstone/Hearthstone.app/Contents/Info.plist", "rb"))
    return str(pl.get("CFBundleVersion", "?"))


def _meta(source: str, semantics: list[str]) -> dict:
    return {
        "source": source,
        "game_version": game_version(),
        "extracted_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "extraction": "scripts/extract_watermarks.py",
        "semantics": semantics,
    }


def extract_tables() -> tuple[dict, dict, dict]:
    env = UnityPy.load(str(HS_DATA / "dbf.unity3d"))

    # set → 水印纹理映射（Actor.cs:5096-5104 消费）
    recs = env.container[f"{DBF}/CARD_SET.asset"].read_typetree()["Records"]
    sets = {}
    for rec in recs:
        sets[int(rec["m_ID"])] = {
            "m_isCoreCardSet": int(rec.get("m_isCoreCardSet", 0)),
            "m_cardWatermarkTexture": rec.get("m_cardWatermarkTexture") or "",
            "m_standardEvent": rec.get("m_standardEvent"),
            "m_setFilterEvent": rec.get("m_setFilterEvent"),
            "m_releaseOrder": rec.get("m_releaseOrder"),
            "m_isCollectible": int(rec.get("m_isCollectible", 0)),
            "m_isExpansionCardSet": int(rec.get("m_isExpansionCardSet", 0)),
        }
    out_sets = {
        "_meta": _meta(
            f"dbf.unity3d {DBF}/CARD_SET.asset（{HS_DATA}）",
            [
                "本表只管 set → 水印纹理映射（Actor.UpdateWatermark → CardSetDbfRecord.CardWatermarkTexture）。",
                "逐卡 set 归属权威 = 引擎 GetCardSet（EntityBase.cs:1351-1377）：GAME_TAG.CARD_SET(183) 优先，"
                "缺省走 CARD_SET_TIMING 首条活跃 timing；见 card_set_timings.json。",
                "IsCoreCard（m_isCoreCardSet=1）时水印无条件改用年标 CoreIcon_Odd/Even"
                "（Actor.cs:5101-5104 + SetRotationIcon.cs:33-40；冻结口径=偶数轮 Even，参照 78325 裁决）。",
                "HIDE_WATERMARK(1107) 或纹理空串 → alpha=0（无水印）。",
            ]),
        "sets": {str(k): v for k, v in sorted(sets.items())},
    }

    # 逐卡 set 归属（GetCardSet fallback 数据源；表序即"首条活跃"语义）
    recs = env.container[f"{DBF}/CARD_SET_TIMING.asset"].read_typetree()["Records"]
    timings: dict[str, list[list[int]]] = {}
    for rec in recs:
        timings.setdefault(str(rec["m_cardId"]), []).append(
            [int(rec["m_cardSetId"]), int(rec["m_eventTimingEvent"])])
    out_timings = {
        "_meta": _meta(
            f"dbf.unity3d {DBF}/CARD_SET_TIMING.asset（{HS_DATA}）",
            [
                "card_id(str) → [[set_id, event], ...]，DBF 表序；消费方按序取首条 event==203 的行",
                "（SPECIAL_EVENT_ALWAYS 恒活；离线正典仅 203 判活——164 恒假、服务器窗口事件判假，"
                "GameUtils.cs:2710-2713 + EventTimingManager.IsEventActive_Impl）。",
                "全不活跃 → set INVALID → 无水印。",
            ]),
        "timings": dict(sorted(timings.items(), key=lambda kv: int(kv[0]))),
    }

    # 逐卡水印纹理 override（CARD DBF 列；EntityDef.cs:258-261）
    recs = env.container[f"{DBF}/CARD.asset"].read_typetree()["Records"]
    overrides = {str(rec["m_ID"]): rec["m_watermarkTextureOverride"]
                 for rec in recs if rec.get("m_watermarkTextureOverride")}
    out_overrides = {
        "_meta": _meta(
            f"dbf.unity3d {DBF}/CARD.asset m_watermarkTextureOverride 列（{HS_DATA}）",
            [
                "dbf_id → 水印纹理 ref（name.ext:guid，全 32 位 guid）。",
                "优先级：高于 set 纹理、低于 IsCoreCard 年标、低于 actor 级"
                " WATERMARK_OVERRIDE_CARD_SET（Actor.cs:5083-5104）。",
            ]),
        "overrides": dict(sorted(overrides.items(), key=lambda kv: int(kv[0]))),
    }
    return out_sets, out_timings, out_overrides


def extract_textures(r: Resolver, refs: list[str], wm_dir: Path) -> list[Path]:
    wm_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for ref in refs:
        name, guid = ref.rsplit(":", 1)
        res = r.resolve(ref)
        assert res["resolved"] and res["resolved"].get("bundle"), \
            f"解析失败 {ref}: {res.get('checks')}"
        obj, _ = r.container_get(res["resolved"]["bundle"], res["resolved"]["guid"])
        tobj = obj.read()
        real = tobj.m_Name
        dest = wm_dir / f"{real}_{guid[:8]}.png"
        if not dest.exists():
            img: Image.Image = tobj.image
            img.save(dest)
        saved.append(dest)
    return saved


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pack", default="assets")
    ap.add_argument("--data", default="data")
    ap.add_argument("--skip-textures", action="store_true",
                    help="只重导三表，不落纹理（纹理幂等，一般无需）")
    args = ap.parse_args()
    data_dir = (REPO / args.data if not Path(args.data).is_absolute() else Path(args.data))
    pack_dir = (REPO / args.pack if not Path(args.pack).is_absolute() else Path(args.pack))

    out_sets, out_timings, out_overrides = extract_tables()

    meta_dir = data_dir / "card_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "card_set_watermarks.json").write_text(
        json.dumps(out_sets, ensure_ascii=False, indent=1), encoding="utf-8")
    (meta_dir / "card_set_timings.json").write_text(
        json.dumps(out_timings, ensure_ascii=False, indent=1), encoding="utf-8")
    (meta_dir / "card_watermark_overrides.json").write_text(
        json.dumps(out_overrides, ensure_ascii=False, indent=1), encoding="utf-8")
    n_sets = len(out_sets["sets"])
    n_wm = sum(1 for v in out_sets["sets"].values() if v["m_cardWatermarkTexture"])
    print(f"[tables] CARD_SET {n_sets} 行（{n_wm} 条非空纹理）→ {meta_dir}/card_set_watermarks.json")
    print(f"[tables] CARD_SET_TIMING {len(out_timings['timings'])} 卡 → card_set_timings.json")
    print(f"[tables] overrides {len(out_overrides['overrides'])} 卡 / "
          f"{len(set(out_overrides['overrides'].values()))} 纹理 → card_watermark_overrides.json")

    if args.skip_textures:
        return 0

    refs = sorted({v["m_cardWatermarkTexture"] for v in out_sets["sets"].values()
                   if v["m_cardWatermarkTexture"]})
    refs += [x for x in CORE_ICONS if x not in refs]
    refs += sorted(set(out_overrides["overrides"].values()))
    refs = sorted(set(refs))
    r = Resolver()
    saved = extract_textures(r, refs, pack_dir / "watermarks")
    missing = [p.name for p in saved if not p.exists()]
    assert not missing, f"落盘缺失: {missing}"
    print(f"[textures] {len(refs)} refs → {pack_dir}/watermarks/ "
          f"（{len({p.name for p in saved})} 张，已存在跳过）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
