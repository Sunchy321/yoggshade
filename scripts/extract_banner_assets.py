# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy", "numpy"]
# ///
"""extract_banner_assets — 手牌帧横幅资产提取 + 嵌套 prefab 合并（长期工具）。

把运行时 NestedPrefab 实例化的四类横幅（可交易/锻造/准备 DeckActionBanner、阵营
HearthstoneFactionBanner）以「提取期合并」进各帧资产包：
  - textures：横幅贴图落 assets/textures/（帧间共享，plain 名）
  - meshes：横幅网格（Tradeable_Banner_mesh / Tradeable_banner_shadow / Faction_Icon 内建 quad）
    按 walkWithKey 键写入各帧 meshes.json
  - frame_recon.json：容器节点下挂合并子树（世界矩阵 = 容器 world × prefab 根 × 链；
    NestedPrefabBase.LoadPrefab 语义：localPosition 置零、保留根 rot/scale，NestedPrefabBase.cs:86-96）
  - prefab_report.json：合并节点的 renderer 材质槽（compileFramePlan 组件骨架来源）
合并节点 active_in_hierarchy=false（容器序列化失活），plan 编译期按 tag 翻 visible（符文横幅同模式）。

多职业绶带（Multiclass_Ribbon）不在本脚本范围：网格本就在帧预制里，plan 编译期直接翻显。

出处（explore/2026-10-05-banner-recon/findings.md）：
  - Actor.UpdateCardColor（Actor.cs:6418-6445）：faction/deck-action 容器 SetActive + else-if 链
  - 嵌套 prefab 引用：Actor m_*BannerContainer（NestedPrefab，m_Prefab 字符串 name:guid）
  - Faction 材质表：CardColorSwitcher faction* 三列表（data/tables.json colorSwitcher 已冻结引用）；
    图标图集 ST 由本脚本探测并写入 tables.json factionIconSt（材质 m_SavedProperties 序列化值）

用法：
  uv run scripts/extract_banner_assets.py [--pack assets] [--tables data/tables.json]
幂等：合并前先剥离各容器下此前合并的子树（按 go_path_id ∈ 嵌套 prefab 识别）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path(os.environ.get("HS_GAME_DATA", "/Applications/Hearthstone/Data/OSX"))

# deck-action 三兄弟互斥（Actor.cs:6431-6445 else-if），但容器字段彼此独立 → 全部合并，编译期裁决。
BANNER_FIELDS = [
    "m_tradeableBannerContainer",
    "m_forgeBannerContainer",
    "m_prepareBannerContainer",
    "m_hearthstoneFactionBannerContainer",
]

SLOTS = ["hand-minion", "hand-spell", "hand-weapon", "hand-location", "hand-hero"]

SWITCHER_BUNDLE = HS_DATA / "essential_base_global-prefab-0.unity3d"


# ---------------------------------------------------------------- 矩阵工具
def quat_to_mat(q: dict) -> list[list[float]]:
    x, y, z, w = q["x"], q["y"], q["z"], q["w"]
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def trs(pos: dict, rot: dict, scale: dict) -> list[list[float]]:
    r = quat_to_mat(rot)
    sx, sy, sz = scale["x"], scale["y"], scale["z"]
    m = [
        [r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, pos["x"]],
        [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, pos["y"]],
        [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, pos["z"]],
        [0.0, 0.0, 0.0, 1.0],
    ]
    return m


def mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def ptr(p) -> dict:
    if isinstance(p, dict):
        return {"m_FileID": p.get("m_FileID", 0), "m_PathID": p.get("m_PathID", 0)}
    return {"m_FileID": getattr(p, "m_FileID", 0), "m_PathID": getattr(p, "m_PathID", 0)}


# ---------------------------------------------------------------- 资产 walk
class BannerExtractor:
    def __init__(self, pack: Path):
        self.pack = pack
        self.tex_dir = pack / "textures"
        self.tex_dir.mkdir(parents=True, exist_ok=True)
        self.issues: list[str] = []
        self.saved_tex: dict[tuple[str, int], dict] = {}
        # 内建 Unity Quad（unity_builtin_extra pid 10210；Faction_Icon 的 MeshFilter 引用）。
        # 顶点/UV 为 Unity 内建 Quad 的标准几何：1×1、UV 0..1、朝 +Z。
        self.builtin_quad = {
            "verts": [[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0], [-0.5, 0.5, 0.0], [0.5, 0.5, 0.0]],
            "uv0": [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
            "subs": [[[0, 3, 1], [0, 1, 2]]],
        }

    def save_texture(self, t_reader, bundle: str) -> dict:
        key = (bundle, t_reader.path_id)
        if key in self.saved_tex:
            return self.saved_tex[key]
        tree = t_reader.read_typetree()
        info = {"name": tree.get("m_Name"), "bundle": bundle, "path_id": t_reader.path_id}
        png = self.tex_dir / f"{info['name']}.png"
        try:
            t_reader.read().image.save(png)
            info["file"] = f"textures/{info['name']}.png"
        except Exception as exc:  # noqa: BLE001
            info["file"] = None
            info["error"] = f"{type(exc).__name__}: {exc}"
        self.saved_tex[key] = info
        return info

    def walk_material(self, resolver, m_reader, mbundle: str, owner) -> dict | None:
        try:
            mt = m_reader.read_typetree()
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"material {m_reader.path_id}: {exc}")
            return None
        info: dict = {"name": mt.get("m_Name"), "bundle": mbundle, "path_id": m_reader.path_id,
                      "shader": None, "tex": {}, "colors": {}, "floats": {}}
        saved = mt.get("m_SavedProperties", {})
        shader_ptr = ptr(mt.get("m_Shader") or {})
        if shader_ptr.get("m_PathID"):
            try:
                s_reader, _sb = resolver.resolve_pptr(mbundle, shader_ptr, m_reader)
                st = s_reader.read_typetree()
                info["shader"] = (st.get("m_ParsedForm") or {}).get("m_Name") or st.get("m_Name")
            except Exception as exc:  # noqa: BLE001
                self.issues.append(f"shader {m_reader.path_id}: {exc}")

        def pair(e):
            return (e["first"], e["second"]) if isinstance(e, dict) else (e[0], e[1])

        for first, sec in (pair(e) for e in saved.get("m_TexEnvs", [])):
            tptr = ptr(sec.get("m_Texture") or {})
            sc, of = sec.get("m_Scale") or {}, sec.get("m_Offset") or {}
            slot = {"scale": [sc.get("x", 1), sc.get("y", 1)],
                    "offset": [of.get("x", 0), of.get("y", 0)]}
            if tptr.get("m_PathID"):
                try:
                    t_reader, tb = resolver.resolve_pptr(mbundle, tptr, m_reader)
                    if t_reader.type.name == "Texture2D":
                        tinfo = self.save_texture(t_reader, tb)
                        slot["texture"] = {"name": tinfo["name"], "bundle": tb,
                                           "file": tinfo.get("file")}
                except Exception as exc:  # noqa: BLE001
                    slot["error"] = str(exc)
            info["tex"][first] = slot
        for first, sec in (pair(e) for e in saved.get("m_Colors", [])):
            info["colors"][first] = [sec["r"], sec["g"], sec["b"], sec["a"]]
        for first, sec in (pair(e) for e in saved.get("m_Floats", [])):
            info["floats"][first] = sec
        return info

    def extract_mesh(self, mesh_reader, mbundle: str) -> dict | None:
        try:
            mesh = mesh_reader.read()
            h = MeshHandler(mesh)
            h.process()
            verts = np.array(h.m_Vertices, dtype=np.float64).reshape(-1, 3)
            uv0 = np.array(h.m_UV0, dtype=np.float64).reshape(-1, 2) if h.m_UV0 else np.zeros((len(verts), 2))
            subs = [[list(map(int, t)) for t in sub if len(t) == 3] for sub in h.get_triangles()]
            return {"verts": verts.tolist(), "uv0": uv0.tolist(), "subs": subs}
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"mesh {getattr(mesh_reader, 'path_id', '?')}: {type(exc).__name__}: {exc}")
            return None

    def walk_nested(self, resolver, env, bundle: str, go_pid: int, world: list[list[float]],
                    key: str, path: str, depth: int = 0) -> tuple[dict, dict[str, dict], list[dict]]:
        """嵌套 prefab 子树 → (recon 节点, meshes 增量, report 节点增量)。世界矩阵由调用方传入累积。"""
        if depth > 8:
            raise RuntimeError(f"{path}: 嵌套过深")
        objs = {o.path_id: o for o in env.objects}
        go = objs.get(go_pid)
        if go is None or go.type.name != "GameObject":
            raise RuntimeError(f"{bundle}: GO {go_pid} 不存在")
        tree = go.read_typetree()
        name = tree["m_Name"]
        node_path = f"{path}/{name}"
        node = {"name": name, "go_path_id": go.path_id, "path": node_path,
                "npz_key": key, "local": None, "world": None, "children": [],
                "renderers": [], "ubertext": None, "mono_unknown": [],
                "active_self": bool(tree.get("m_IsActive", 1)),
                "active_in_hierarchy": False,  # 容器序列化失活；编译期按 tag 翻 visible
                "mesh_stats": None}
        mesh_entry: dict[str, dict] = {}
        report_node: dict | None = None
        transform = None
        for comp in tree.get("m_Component", []):
            pd = ptr(comp["component"])
            if not pd["m_PathID"]:
                continue
            try:
                cobj, _cb = resolver.resolve_pptr(bundle, pd, go)
            except Exception as exc:  # noqa: BLE001
                self.issues.append(f"{node_path} 组件 {pd['m_PathID']}: {exc}")
                continue
            ctype = cobj.type.name
            ctree = cobj.read_typetree()
            if ctype == "Transform":
                transform = ctree
                p, q, s = ctree["m_LocalPosition"], ctree["m_LocalRotation"], ctree["m_LocalScale"]
                node["local"] = {"pos": [p["x"], p["y"], p["z"]],
                                 "rot": [q["x"], q["y"], q["z"], q["w"]],
                                 "scale": [s["x"], s["y"], s["z"]]}
            elif ctype == "MeshFilter":
                mp = ptr(ctree.get("m_Mesh") or {})
                if mp.get("m_PathID"):
                    if mp.get("m_FileID", 0) != 0:
                        exts = [Path(e.path).name for e in (cobj.assets_file.externals or [])]
                        target = exts[mp["m_FileID"] - 1] if mp["m_FileID"] <= len(exts) else "?"
                        if "builtin" in target or "default resources" in target:
                            # Faction_Icon → 内建 Quad（pid 10210；顶点/UV 标准几何见 self.builtin_quad）
                            if mp["m_PathID"] == 10210:
                                mesh_entry[key] = json.loads(json.dumps(self.builtin_quad))
                                node["mesh_stats"] = {"name": "builtin:Quad", "verts": 4,
                                                      "submesh_tris": [2]}
                            else:
                                self.issues.append(f"{node_path}: 未建模的内建网格 pid {mp['m_PathID']}")
                        else:
                            # 跨 bundle 网格（如 Tradeable_Banner_mesh @ 910a3655-mesh-0）正常解析
                            try:
                                mobj, mb = resolver.resolve_pptr(bundle, mp, cobj)
                                mesh = self.extract_mesh(mobj, mb)
                                if mesh is not None:
                                    mesh_entry[key] = mesh
                                    vv = np.array(mesh["verts"])
                                    node["mesh_stats"] = {
                                        "name": mobj.read_typetree().get("m_Name"),
                                        "verts": len(mesh["verts"]),
                                        "submesh_tris": [len(s) for s in mesh["subs"]],
                                        "bbox_min": vv.min(axis=0).tolist(),
                                        "bbox_max": vv.max(axis=0).tolist(),
                                    }
                            except Exception as exc:  # noqa: BLE001
                                self.issues.append(f"{node_path} mesh(外引): {exc}")
                    else:
                        try:
                            mobj, mb = resolver.resolve_pptr(bundle, mp, cobj)
                            mesh = self.extract_mesh(mobj, mb)
                            if mesh is not None:
                                mesh_entry[key] = mesh
                                vv = np.array(mesh["verts"])
                                node["mesh_stats"] = {
                                    "name": mobj.read_typetree().get("m_Name"),
                                    "verts": len(mesh["verts"]),
                                    "submesh_tris": [len(s) for s in mesh["subs"]],
                                    "bbox_min": vv.min(axis=0).tolist(),
                                    "bbox_max": vv.max(axis=0).tolist(),
                                }
                        except Exception as exc:  # noqa: BLE001
                            self.issues.append(f"{node_path} mesh: {exc}")
            elif ctype in ("MeshRenderer", "SkinnedMeshRenderer"):
                mats = []
                for mp in ctree.get("m_Materials", []):
                    pdm = ptr(mp)
                    if not pdm.get("m_PathID"):
                        mats.append(None)
                        continue
                    try:
                        mobj, mb = resolver.resolve_pptr(bundle, pdm, cobj)
                        mats.append(self.walk_material(resolver, mobj, mb, mobj))
                    except Exception as exc:  # noqa: BLE001
                        mats.append(None)
                        self.issues.append(f"{node_path} mat: {exc}")
                node["renderers"].append({"enabled": ctree.get("m_Enabled"), "materials": mats,
                                          "renderer_path_id": cobj.path_id})
                slots = []
                for i, mat in enumerate(mats):
                    if mat is None:
                        slots.append({"slot": i, "empty": True})
                        continue
                    texs = {}
                    for prop, t in mat["tex"].items():
                        texobj = t.get("texture") or {}
                        if texobj:
                            texs[prop] = {"name": texobj.get("name"), "bundle": texobj.get("bundle")}
                    slots.append({"slot": i, "name": mat["name"], "shader": mat.get("shader"),
                                  "textures": texs})
                report_node = {"path": node_path, "go_path_id": go.path_id,
                               "components": {"renderer": {"material_slots": slots}}}
        node["world"] = world
        children = []
        report_nodes = []
        if transform is not None:
            for ch in transform.get("m_Children", []):
                cpd = ptr(ch)
                if not cpd["m_PathID"]:
                    continue
                try:
                    tr_obj, _ = resolver.resolve_pptr(bundle, cpd, go)
                    tr_tree = tr_obj.read_typetree()
                    gop = ptr(tr_tree.get("m_GameObject") or {})
                    p, q, s = tr_tree["m_LocalPosition"], tr_tree["m_LocalRotation"], tr_tree["m_LocalScale"]
                    child_world = mat_mul(world, trs(p, q, s))
                    cgo, _ = resolver.resolve_pptr(bundle, gop, tr_obj)
                except Exception as exc:  # noqa: BLE001
                    self.issues.append(f"{node_path} 子解析: {exc}")
                    continue
                idx = len(children)
                child, cmesh, creport = self.walk_nested(
                    resolver, env, bundle, cgo.path_id, child_world,
                    f"{key}.{idx}", node_path, depth + 1)
                children.append(child)
                mesh_entry.update(cmesh)
                report_nodes.extend(creport)
        node["children"] = children
        if report_node:
            report_nodes.insert(0, report_node)
        return node, mesh_entry, report_nodes


def strip_previous(container: dict, prefab_go_ids: set[int], meshes: dict, container_key: str,
                   report_nodes: list[dict]) -> None:
    """幂等：删除容器下此前合并的子树（go_path_id 命中嵌套 prefab 的 GO）。"""
    def walk(node: dict) -> None:
        for key in [k for k in meshes if k.startswith(node["npz_key"] + ".")]:
            del meshes[key]
    old = container.get("children") or []
    kept = []
    for ch in old:
        if ch.get("go_path_id") in prefab_go_ids:
            walk(ch)
        else:
            kept.append(ch)
    container["children"] = kept
    old_paths = {c.get("path") for c in old}
    report_nodes[:] = [n for n in report_nodes if n.get("path") not in old_paths]


def find_node(node: dict, go_path_id: int) -> dict | None:
    if node.get("go_path_id") == go_path_id:
        return node
    for ch in node.get("children", []):
        hit = find_node(ch, go_path_id)
        if hit:
            return hit
    return None


def iter_nodes(node: dict):
    yield node
    for ch in node.get("children", []):
        yield from iter_nodes(ch)


def actor_ref(slot: str) -> tuple[str, str]:
    key = {"hand-minion": "HAND_MINION", "hand-spell": "HAND_SPELL", "hand-weapon": "HAND_WEAPON",
           "hand-location": "HAND_LOCATION", "hand-hero": "HAND_HERO"}[slot]
    with open(REPO / "data" / "actor_names.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["quality"] == "normal" and r["actor_slot"] == key:
                return r["asset_name"], r["guid"]
    raise KeyError(f"actor_names.csv 无 normal/{key}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=str(REPO / "assets"))
    ap.add_argument("--tables", default=str(REPO / "data" / "tables.json"))
    args = ap.parse_args()
    pack = Path(args.pack)

    sys_path = str(HERE)
    if sys_path not in __import__("sys").path:
        __import__("sys").path.insert(0, sys_path)
    from resolve_asset_ref import Resolver  # noqa: PLC0415

    R = Resolver()
    ex = BannerExtractor(pack)

    summary: dict[str, dict] = {}
    for slot in SLOTS:
        fdir = pack / "frames" / slot
        recon_path, meshes_path, report_path = (fdir / "frame_recon.json", fdir / "meshes.json",
                                                fdir / "prefab_report.json")
        if not recon_path.is_file():
            continue
        recon = json.loads(recon_path.read_text())
        meshes = json.loads(meshes_path.read_text())
        report = json.loads(report_path.read_text())
        refs = (report.get("actor_components") or [{}])[0].get("object_refs", {})
        hierarchy = recon["hierarchy"]
        asset_name, guid = actor_ref(slot)
        res = R.resolve(f"{asset_name}:{guid}")
        frame_bundle = res["object"]["bundle"]
        env_frame = UnityPy.load(str(R.win / frame_bundle))
        frame_root_pid = res["object"]["path_id"]
        frame_root_obj = {o.path_id: o for o in env_frame.objects}[frame_root_pid]

        slot_summary: dict[str, list[str]] = {}
        for field in BANNER_FIELDS:
            ref = refs.get(field)
            if not ref or ref.get("type") != "MonoBehaviour":
                continue
            try:
                mb_obj, mb_bundle = R.resolve_pptr(
                    frame_bundle, {"m_FileID": ref.get("file_id", 0), "m_PathID": ref["path_id"]},
                    frame_root_obj)
                mb_tree = mb_obj.read_typetree()
            except Exception as exc:  # noqa: BLE001
                ex.issues.append(f"{slot}/{field}: MB 解析失败 {exc}")
                continue
            prefab_ref = mb_tree.get("m_Prefab")
            if not prefab_ref:
                continue
            # 容器节点：MB 的 m_GameObject → recon 按 go_path_id 定位
            go_ptr = ptr(mb_tree.get("m_GameObject") or {})
            container_go, _ = R.resolve_pptr(mb_bundle, go_ptr, mb_obj)
            container = find_node(hierarchy, container_go.path_id)
            if container is None:
                ex.issues.append(f"{slot}/{field}: 容器 GO {container_go.path_id} 不在 recon")
                continue
            bres = R.resolve(prefab_ref)
            bobj = bres["object"]
            env_b = UnityPy.load(str(R.win / bobj["bundle"]))
            objs_b = {o.path_id: o for o in env_b.objects}
            root_go = objs_b[bobj["path_id"]]
            root_tree = root_go.read_typetree()
            prefab_go_ids = set()
            # 收集嵌套 prefab 全部 GO path_id（幂等剥离键）
            stack = [bobj["path_id"]]
            while stack:
                pid = stack.pop()
                if pid in prefab_go_ids:
                    continue
                prefab_go_ids.add(pid)
                g = objs_b.get(pid)
                if g is None or g.type.name != "GameObject":
                    continue
                gt = g.read_typetree()
                for c in gt.get("m_Component", []):
                    co = objs_b.get(c["component"]["m_PathID"])
                    if co is not None and co.type.name == "Transform":
                        tt = co.read_typetree()
                        for chh in tt.get("m_Children", []):
                            cho = objs_b.get(chh["m_PathID"])
                            if cho is not None:
                                cht = cho.read_typetree()
                                stack.append(cht.get("m_GameObject", {}).get("m_PathID"))
            report_nodes = report.get("nodes", [])
            strip_previous(container, prefab_go_ids, meshes, container["npz_key"], report_nodes)
            # 子树根键 = 容器键 + ".0"：container.children=[subtree] 后，walkWithKey 重算键时
            # prefab 根是容器的第 0 个子节点（2026-10-05 勘误：此前直接用容器键，整棵子树键
            # 错位一级，渲染端按重算键查网格 → 主 quad 命中 Glow 网格、阴影 miss——横幅被
            # 画成阴影 UV 的灰色象限，即"横幅渲染成阴影"的根因）。
            subtree_root_key = f"{container['npz_key']}.0"
            # 根 TRS：LoadPrefab localPosition 置零，rot/scale 保留（NestedPrefabBase.cs:86-96）
            root_tr = None
            for c in root_tree.get("m_Component", []):
                co = objs_b.get(c["component"]["m_PathID"])
                if co is not None and co.type.name == "Transform":
                    root_tr = co.read_typetree()
            if root_tr is None:
                ex.issues.append(f"{slot}/{field}: prefab 无根 Transform")
                continue
            p0, q, s = root_tr["m_LocalPosition"], root_tr["m_LocalRotation"], root_tr["m_LocalScale"]
            root_m = trs({"x": 0.0, "y": 0.0, "z": 0.0}, q, s)
            base_world = mat_mul(container["world"] or
                                 [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], root_m)
            subtree, mesh_add, rep_add = ex.walk_nested(
                R, env_b, bobj["bundle"], bobj["path_id"], base_world,
                subtree_root_key, container["path"])
            # 根节点自身 report 条目（若带 renderer）
            if subtree.get("renderers"):
                slots = []
                for i, mat in enumerate(subtree["renderers"][0]["materials"]):
                    if mat is None:
                        slots.append({"slot": i, "empty": True})
                        continue
                    texs = {prop: {"name": t["texture"]["name"], "bundle": t["texture"]["bundle"]}
                            for prop, t in mat["tex"].items() if t.get("texture")}
                    slots.append({"slot": i, "name": mat["name"], "shader": mat.get("shader"),
                                  "textures": texs})
                rep_add.insert(0, {"path": subtree["path"], "go_path_id": subtree["go_path_id"],
                                   "components": {"renderer": {"material_slots": slots}}})
            container["children"] = [subtree]
            meshes.update(mesh_add)
            known = {n["path"] for n in report_nodes}
            report_nodes.extend(n for n in rep_add if n["path"] not in known)
            slot_summary[field] = {
                "prefab": prefab_ref,
                "container": container["path"],
                "nodes": len(list(iter_nodes(subtree))),
                "meshes": sorted(mesh_add.keys()),
            }
        recon_path.write_text(json.dumps(recon, ensure_ascii=False, indent=1, default=str))
        meshes_path.write_text(json.dumps(meshes, ensure_ascii=False))
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str))
        summary[slot] = slot_summary

    # ---- CardColorSwitcher faction 图标图集 ST（材质序列化值 → tables.json factionIconSt）----
    # 图标材质运行时整体替换（CardColorSwitcher.GetMaterialIcon），plan 编译期需要每个阵营的
    # _MainTex ST；贴图本体 = Faction_Icons（普通）/FX3_gradient_vibrate_jitter_noBlack（签名）。
    def _col(v):
        if isinstance(v, dict):
            return [v.get("r", 0), v.get("g", 0), v.get("b", 0), v.get("a", 1)]
        return v

    env_sw = UnityPy.load(str(SWITCHER_BUNDLE))
    faction_icon_st: dict[str, list[dict]] = {"normal": [], "signature": []}
    for o in env_sw.objects:
        if o.type.name != "MonoBehaviour":
            continue
        t = o.read_typetree()
        if "factionIconMaterials" not in t:
            continue

        def mat_summary(ref: str) -> dict:
            """材质 → {mat, tex, file, scale, offset, color}（横幅/图标运行时换材质的编译期输入）。"""
            mres = R.resolve(ref)
            mobj = mres["object"]
            env_m = UnityPy.load(str(R.win / mobj["bundle"]))
            mo = {x.path_id: x for x in env_m.objects}[mobj["path_id"]]
            mt = mo.read_typetree()
            saved = mt.get("m_SavedProperties") or {}
            entry: dict = {"mat": mt.get("m_Name")}
            for pair in saved.get("m_TexEnvs", []) or []:
                k = pair[0] if isinstance(pair, (list, tuple)) else pair["first"]
                sec = pair[1] if isinstance(pair, (list, tuple)) else pair["second"]
                if k != "_MainTex":
                    continue
                sc, of = sec.get("m_Scale") or {}, sec.get("m_Offset") or {}
                entry["scale"] = [sc.get("x", 1), sc.get("y", 1)]
                entry["offset"] = [of.get("x", 0), of.get("y", 0)]
                tp = ptr(sec.get("m_Texture") or {})
                if tp.get("m_PathID"):
                    to, tb = R.resolve_pptr(mobj["bundle"], tp, mo)
                    tinfo = ex.save_texture(to, tb)
                    entry["tex"] = tinfo["name"]
                    entry["file"] = tinfo.get("file")
            for pair in saved.get("m_Colors", []) or []:
                k = pair[0] if isinstance(pair, (list, tuple)) else pair["first"]
                sec = pair[1] if isinstance(pair, (list, tuple)) else pair["second"]
                if k == "_Color":
                    entry["color"] = _col(sec)
            return entry

        for list_key, out_key in (("factionIconMaterials", "normal"),
                                  ("factionIconMaterialsSignature", "signature")):
            rows = []
            for ref in t.get(list_key) or []:
                if not ref:
                    rows.append(None)
                    continue
                try:
                    rows.append(mat_summary(ref))
                except Exception as exc:  # noqa: BLE001
                    rows.append({"error": f"{type(exc).__name__}: {exc}"})
            faction_icon_st[out_key] = rows
        # 绶带底板材质（factionBannerMaterials：1-3 帮派共用 Faction_Banner，4-6 星际共用
        # Faction_Banner_Starcraft）→ 按下标并进 icon 行（row.banner），编译期换 _MainTex。
        for i, ref in enumerate(t.get("factionBannerMaterials") or []):
            row = faction_icon_st["normal"][i] if i < len(faction_icon_st["normal"]) else None
            if row is None:
                continue
            if not ref:
                row["banner"] = None
                continue
            try:
                row["banner"] = mat_summary(ref)
            except Exception as exc:  # noqa: BLE001
                row["banner"] = {"error": f"{type(exc).__name__}: {exc}"}
        break

    tables_path = Path(args.tables)
    tables = json.loads(tables_path.read_text())
    tables["factionIconSt"] = faction_icon_st
    tables.setdefault("sources", {})["factionIconSt"] = \
        "CardColorSwitcher faction* 材质 m_SavedProperties（scripts/extract_banner_assets.py 探测）"
    tables_path.write_text(json.dumps(tables, ensure_ascii=False, indent=1))

    print(json.dumps({"slots": summary, "issues": ex.issues,
                      "textures": [v["name"] for v in ex.saved_tex.values()],
                      "factionIconSt": {k: [r and r.get("mat") for r in v]
                                          for k, v in faction_icon_st.items()}},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
