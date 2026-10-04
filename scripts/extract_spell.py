# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy", "numpy"]
# ///
"""extract_spell — 战棋模板视觉 spell prefab 提取（coin / tavern-tier 图标）→ 资产包 spells/{key}/。

背景（decomp/exporter 出处）：
- 战棋手牌的铸币/等级视觉不是 actor 自带网格，而是 SpellTable 里的 spell prefab 实例：
  Actor.UpdateManaGemComponent（Actor.cs:5150-5206）在 UseTechLevelManaGem()/UseCoinManaGem()
  成立时隐藏 m_manaObject；ShowTavernTierSpell（Actor.cs:7489-7506）激活
  TECH_LEVEL_MANA_GEM（BACON_TIMEWARPED → TIME_TAVERN_TIER_ICON，Actor.cs:7474-7484）；
  exporter ApplyBattlegroundsHandVisualSetup（ExporterController.cs:5056-5620）逐卡型给规则。
- SpellTable 条目（SpellTable.cs m_Table[] = {m_Type, m_SpellPrefabName}，探针
  explore/2026-10-03-bg-template/output/spell_tables.json）：
    TECH_LEVEL_MANA_GEM(156) = Card_Hand_Ally_TechLevelManaGem.prefab:fafee4fd…
    TIME_TAVERN_TIER_ICON(308) = Card_Hand_Ally_TierIcon_Timewarped_Tavern.prefab:f72c0460…
    COIN_MANA_GEM(145) = Card_Hand_Ability_CoinManaGem.prefab:3416ba18…（法术帧变体；
                         History_HeroPower_CoinManaGem.prefab:b0d925c1… 为英雄技能变体）
    COIN_MANA_GEM_BACON_SPELL(267) = Card_Hand_Ability_CoinManaGem_BaconSpell.prefab:6ddefa5a…
- spell prefab 实例挂到 actor 根下恒等 "Spells" 节点（Actor.LoadSpell → GetSpellParent，
  Actor.cs:6949/7814），AttachAndPreserveLocalTransform 保留预制本地 TRS（TransformUtil.cs:920）
  → 预制根序列化位姿即相对 actor 根的摆位，**不归零**（帧才因 zone 摆位归零根平移）。

产出 spells/{key}/：frame_recon.json（层级+世界矩阵+材质）、meshes.json、textures/、
prefab_report.json（节点表）、manifest.json（spell_root / mesh_keys / textures）。
FSM 驱动的子节点显隐（如 TechLevel 星数）按层级名记录进 manifest.fsm_hints，渲染规则在
plan 编译期实现（依据 PlayMaker 变量名，逐条注出处）。

用法：uv run scripts/extract_spell.py --all
      uv run scripts/extract_spell.py --key tech-level-gem
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

HS_DATA = "/Applications/Hearthstone/Data/OSX"

# key → (spell prefab ref, 备注)。refs 来自 SpellTable 探针（ SpellTable.cs 条目结构；
# explore/2026-10-03-bg-template/output/spell_tables.json，guid 逐条核对过 name-consistency）。
SPELLS = {
    "tech-level-gem": ("Card_Hand_Ally_TechLevelManaGem.prefab:fafee4fdb205ce84984f1c7f2147cdab",
                       "TECH_LEVEL_MANA_GEM(156)：随从/法术手牌 tavern-tier 盾+星"),
    "tier-icon-timewarp": ("Card_Hand_Ally_TierIcon_Timewarped_Tavern.prefab:f72c04600fde42940a8156619c758e9c",
                           "TIME_TAVERN_TIER_ICON(308)：时空扭曲酒馆 tier 图标"),
    "coin-ability": ("Card_Hand_Ability_CoinManaGem.prefab:3416ba18b6faec347a91692f9ecb33eb",
                     "COIN_MANA_GEM(145)：法术帧铸币"),
    "coin-bacon-spell": ("Card_Hand_Ability_CoinManaGem_BaconSpell.prefab:6ddefa5a3e359e045b84f737944b8a80",
                         "COIN_MANA_GEM_BACON_SPELL(267)：酒馆法术专用铸币"),
    "coin-heropower": ("History_HeroPower_CoinManaGem.prefab:b0d925c1124201444b626336c386a464",
                       "COIN_MANA_GEM(145)：英雄技能帧铸币（宝石在顶部中央）"),
    # 饰品表（Card_Hand_BG_Trinket_SpellTable）的 145 条目——注意不是 coin-ability：
    # 名字带 " 1" 的独立预制，位姿按饰品帧宝石排（逐表探针 explore/.../probe_table_refs.py）
    "alt-tavern-coin": ("Card_Hand_Ability_CardsCostAltTavernCoin.prefab:7a4db85c9dc03754ea6c6a130d5db60c",
                        "COST_ALT_TAVERN_COIN(305)：时空扭曲酒馆法术的铸币替付（表 305 条目）"),
    "coin-trinket": ("Card_Hand_Ability_CoinManaGem 1.prefab:b34640671f3d74b44a85343f91c0b571",
                     "COIN_MANA_GEM(145)：饰品帧铸币（表条目名字串陈旧，实际对象 Card_Hand_Trinket_CoinManaGem）"),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--pack", default=str(REPO / "assets"))
    args = ap.parse_args()
    from extract_frame import Recon  # noqa: E402  复用帧提取的 walk/材质/网格机制
    from resolve_asset_ref import Resolver  # noqa: E402

    pack = Path(args.pack)
    keys = sorted(SPELLS) if args.all else [args.key]
    r = Resolver(HS_DATA)
    rc = 0
    for key in keys:
        ref, note = SPELLS[key]
        out = pack / "spells" / key
        (out / "textures").mkdir(parents=True, exist_ok=True)
        print(f"[spell] {key}: {ref} — {note}")
        rec = Recon(out, key)
        rec.r = r
        res = r.resolve(ref)
        if not res["ok"]:
            # SpellTable 条目里的名字串可能陈旧（GUID 才权威）——名字不一致但 registration
            # 通过时照常解析（同款容忍见 five-cardtypes findings 的 DK-atlas 名字引用）。
            reg_ok = any(c.get("check") == "registration" and c.get("pass")
                         for c in (res.get("checks") or []))
            if not (reg_ok and res["resolved"]):
                print(f"[fail] {res['checks']}")
                rc = 1
                continue
            print(f"[warn] 名字串陈旧，按 GUID 解析: {res['resolved']['guid']}")
        rec.bundle = res["resolved"]["bundle"]
        guid = res["resolved"]["guid"]
        root_go, _ = r.container_get(rec.bundle, guid)
        spell_root = root_go.read_typetree()["m_Name"]
        hierarchy = rec.walk(root_go, "", "root")
        rec.hierarchy = hierarchy
        # Recon.tex_ref 产出 frames/{key}/textures/...；spell 资产落在 spells/{key}/textures/ → 改写前缀
        def fix_tex(n):
            for rr in n.get("renderers") or []:
                for m in rr.get("materials") or []:
                    if not m:
                        continue
                    for t in m["tex"].values():
                        f = (t.get("texture") or {}).get("file")
                        if f and f.startswith(f"frames/{key}/textures/"):
                            t["texture"]["file"] = "spells/" + f[len("frames/"):]
            for c in n["children"]:
                fix_tex(c)
        fix_tex(hierarchy)

        # （与 extract_frame.extract_one 同构：局部 TRS → 世界矩阵。帧根平移归零（zone 摆位），
        # spell 根**保留**序列化 TRS：Actor.LoadSpell（Actor.cs:6949）用
        # TransformUtil.AttachAndPreserveLocalTransform（TransformUtil.cs:920-925）把预制按
        # 本地 TRS 原样挂到 GetSpellParent()（Actor.cs:7814-7825，actor 根下恒等 "Spells"
        # 节点），随后 localScale ×SpellTable 根缩放（探针 /tmp：Card_Hand_Ability_SpellTable
        # 根 scale=(1,1,1)，乘法无操作）→ 预制根位就是运行时摆位的一部分。实测根位：
        # coin-bacon-spell (-0.007,0.062,-0.643)（z 屏幕下移 ≈113.7px = 等级徽章正下方）、
        # coin-ability (-0.007,0.062,0.007)、coin-trinket (0.82,0.062,0.25)、其余 =0。
        # 此前照搬帧的归零纪律抹掉该偏移，酒馆法术铸币因此叠上等级徽章（2026-10-04 修复）。
        def mat_of(node):
            from extract_frame import mat4_from_trs
            return mat4_from_trs(**{k: node["local"][k] for k in ("pos", "rot", "scale")}) \
                if node["local"] else np.eye(4)
        def assign(node, pm):
            node["world"] = (pm @ mat_of(node)).tolist()
            for ch in node["children"]:
                assign(ch, np.array(node["world"]))
        assign(hierarchy, np.eye(4))

        meshes = {}
        for n in rec.iter_nodes(hierarchy):
            mesh = n.pop("mesh", None)
            if not mesh:
                continue
            meshes[n["npz_key"]] = {"verts": mesh["verts"].tolist(), "uv0": mesh["uv0"].tolist(),
                                    "subs": [t.tolist() for t in mesh["submeshes"]]}
            n["mesh_stats"] = {"name": mesh["name"], "verts": len(mesh["verts"]),
                               "submesh_tris": [len(t) for t in mesh["submeshes"]],
                               "bbox_min": mesh["bbox_min"], "bbox_max": mesh["bbox_max"]}
        actor = rec.finalize_actor(rec.actor_owner) if rec.actor_owner is not None else {}
        (out / "frame_recon.json").write_text(json.dumps(
            {"spell_root": spell_root, "prefab_ref": ref, "bundle": rec.bundle, "guid": guid,
             "root_translation_preserved": {
                 "reason": "spell 预制根序列化 TRS = authored 摆位（LoadSpell "
                           "AttachAndPreserveLocalTransform 保留；Actor.cs:6949）"},
             "hierarchy": hierarchy, "actor_components": [actor] if actor else []},
            ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        (out / "meshes.json").write_text(json.dumps(meshes, ensure_ascii=False), encoding="utf-8")
        rnodes = []
        for n in rec.iter_nodes(hierarchy):
            comp = {}
            rr = n.get("renderers") or []
            if rr:
                slots = []
                for i, m in enumerate(rr[0]["materials"]):
                    if m is None:
                        slots.append({"slot": i, "empty": True})
                        continue
                    slots.append({"slot": i, "name": m["name"], "shader": m.get("shader"),
                                  "textures": {k: {"name": (v.get("texture") or {}).get("name")}
                                               for k, v in m["tex"].items() if v.get("texture")}})
                comp["renderer"] = {"material_slots": slots}
            if n.get("ubertext"):
                comp["TextComponent"] = {"path_id": n["ubertext"]["path_id"]}
            rnodes.append({"path": n["path"], "go_path_id": n["go_path_id"], "components": comp})
        (out / "prefab_report.json").write_text(json.dumps(
            {"prefab": {"name": spell_root, "ref": ref, "guid": guid, "bundle": rec.bundle},
             "nodes": rnodes, "issues": rec.issues}, ensure_ascii=False, indent=1, default=str),
            encoding="utf-8")
        # FSM 提示：子节点名/序列化 active（星数显隐规则在 plan 编译期实现）
        def names(n, d=0):
            rows = []
            for c in n["children"]:
                rows.append(f"{'  '*d}{c['name']} active={c['active_in_hierarchy']}"
                            + (f" tris={c['mesh_stats']['submesh_tris']}" if c.get("mesh_stats") else ""))
                rows += names(c, d + 1)
            return rows
        print("[tree]")
        print("\n".join(names(hierarchy)))
        texs = sorted({t["file"] for t in rec.tex_saved.values() if t.get("file")})
        (out / "manifest.json").write_text(json.dumps(
            {"key": key, "spell_root": spell_root, "prefab_ref": ref, "textures": texs,
             "mesh_keys": sorted(meshes)}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[done] {key}: nodes={len(list(rec.iter_nodes(hierarchy)))} meshes={len(meshes)} "
              f"textures={len(texs)} issues={len(rec.issues)}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
