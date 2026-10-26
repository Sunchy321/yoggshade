# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy", "numpy", "pillow"]
# ///
"""extract_frame — 参数化手牌帧 recon：actor prefab → 资产包 frames/{slot}/。

卡型 → actor（ActorNames.cs s_actorAssets，反编译出处见 data/actor_names.csv）：
  hand-minion  Card_Hand_Ally      （随从，现包基线，可重导校验）
  hand-spell   Card_Hand_Ability   （法术）
  hand-weapon  Card_Hand_Weapon    （武器）
  hand-hero    Card_Hand_Hero      （英雄）
  hand-location Card_Hand_Location （地标）
  hand-minion-golden Card_Hand_Ally_Premium（金卡随从，GOLDEN 阶段 B）

签名帧槽位（SIG_SLOT_TO_FRAME，异画 SIGNATURE premium）：引用不经 actor_names.csv
normal 档（那是 GetHandActor 普通链），走 SIGNATURE_FRAME DBF「名字:GUID 直指」——
签名链 = ActorNames.GetSignatureActor → SignatureHand[frameId]（ActorNames.cs:885-923），
frame → hand prefab AssetReference 在 dbf.unity3d SIGNATURE_FRAME.m_handActorPrefab：
  hand-minion-sig1   frame 1  Card_Hand_Ally_Signature_25     （旧式玻璃，RLK_706）
  hand-minion-sig2   frame 2  Card_Hand_Ally_Signature_26     （WW_373）
  hand-minion-sig9   frame 9  Card_Hand_Ally_Signature_Evergreen（GDB_477）
  hand-spell-sig10   frame 10 Card_Hand_Ability_Signature_Evergreen（TLC_433；play prefab 空串）
  hand-weapon-sig12  frame 12 Card_Hand_Weapon_Signature_Evergreen（TLC_EVENT_402）

每个帧输出到 PACK/frames/{slot}/：
  frame_recon.json       帧层级（world 矩阵 / active_in_hierarchy / mesh_stats / renderers+材质）
  meshes.json            网格（npz_key → verts/uv0/uv1/subs；extra/{actor字段} 为 actor 直引网格）
  portrait.json          肖像网格通道（verts/uv0/uv1/sub0/sub1，肖像公式层消费）
  material_props.json    肖像材质 _SecondTint/_BlendIntensity（+ second_tex 纹理名）
  curved.json            名字 RTT 载体网格（m_RenderOnObject 指向；武器帧无 → 平面 fallback）
  prefab_report.json     节点表（renderer 材质槽）+ actor_components（object_refs/scalars）
  prefab_ubertext.json   UberText 节点全字段（role_paths 同目录 manifest 内）
  manifest.json          frame_root / role_paths / portrait_node_key / second_tex / carrier
  textures/*.png         帧引用纹理（材料 refs 重写为 pack 根相对 frames/{slot}/textures/…）

不变式（照 ally_recon.py 逐行同构；出处见 Angelia 实验）：
  - 根平移归零：prefab 根位置=场景摆位残留，canonical 快照位姿=恒等根（Ability 帧原点实证）
  - uv1 走 MeshHandler.m_UV1（portrait _SecondTex 采样用；武器帧另有单补脚本先例）
  - 类色图集/原画/glyph 不随帧提取（TS 编译期按卡解析）

用法：
  uv run scripts/extract_frame.py --slot hand-spell
  uv run scripts/extract_frame.py --all          # 全部常规帧（不含签名帧）
  uv run scripts/extract_frame.py --sig          # 全部签名帧（引用来自 SIGNATURE_FRAME 表）
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path(os.environ.get("HS_GAME_DATA", "/Applications/Hearthstone/Data/OSX"))

# 卡型 → actor。出处 ActorNames.cs s_actorAssets（exporter ilspy 缓存）；表在 data/actor_names.csv
SLOT_TO_ACTOR_KEY = {
    "hand-minion": "HAND_MINION",
    "hand-spell": "HAND_SPELL",
    "hand-weapon": "HAND_WEAPON",
    "hand-hero": "HAND_HERO",
    "hand-location": "HAND_LOCATION",
    # 英雄技能：ActorNames.GetHandActor(HERO_POWER) → HISTORY_HERO_POWER（ActorNames.cs:555-556）
    # = History_HeroPower.prefab。不是 Card_Hand_Ability（那是 SPELL=5 的帧），也不是对局区的
    # Card_Play_HeroPower（GetPlayActorByTags 才走那条；exporter docs/decompile-notes.md 已记）。
    "hand-heropower": "HAND_HERO_POWER",
    # 战棋专用手牌帧（GetHandActor：BATTLEGROUND_ANOMALY → BIG_CARD_BG_ANOMALY、
    # BATTLEGROUND_TRINKET → BIG_CARD_BG_TRINKET，ActorNames.cs:562-565）。
    # 注意 BG 法术(42)/任务奖励(40) 走 HAND_SPELL（复用 hand-spell 帧），BG 随从走 HAND_MINION。
    "hand-bg-anomaly": "BIG_CARD_BG_ANOMALY",
    "hand-bg-trinket": "BIG_CARD_BG_TRINKET",
    # 佣兵（Lettuce）四族（GetHandActorByTags，ActorNames.cs:570-591 组合判定；
    # 谓词与 prefab 拆解见 docs/findings/lettuce-frame-teardown-2026-10-10.md）：
    # CARDTYPE 23 无特殊 tag → spell；+LETTUCE_ABILITY_SUMMONED_MINION(1676) → minion；
    # +LETTUCE_IS_EQUPIMENT(1855) → equipment；TAG_LETTUCE_MERCENARY(1665)>0 → mercenary。
    "hand-lettuce-ability": "BIG_CARD_LETTUCE_ABILITY_SPELL",
    "hand-lettuce-ability-minion": "BIG_CARD_LETTUCE_ABILITY_MINION",
    "hand-lettuce-equipment": "BIG_CARD_LETTUCE_EQUIPMENT",
    "hand-mercenary": "HAND_MERCENARY",
}

# GOLDEN 帧使用 ActorNames.s_premiumActorAssets，而非普通 s_actorAssets
# （ActorNames.cs:176-200, 833-898）。
PREMIUM_SLOT_TO_ACTOR_KEY = {
    "hand-minion-golden": "HAND_MINION",
    "hand-spell-golden": "HAND_SPELL",
    "hand-weapon-golden": "HAND_WEAPON",
    "hand-hero-golden": "HAND_HERO",
    "hand-location-golden": "HAND_LOCATION",
}

# 签名帧槽位 → SIGNATURE_FRAME frame id（spec 方案表
# .scratch/signature-frames/spec.md；槽位命名 hand-{minion,spell,weapon,hero,location}-sig{frameId}
# 直接对表可反查；frameId 区分多个 Evergreen 架构并支持后续 hero/location 帧。）
SIG_SLOT_TO_FRAME = {
    "hand-minion-sig1": 1,
    "hand-minion-sig2": 2,
    "hand-minion-sig9": 9,
    "hand-spell-sig10": 10,
    "hand-weapon-sig12": 12,
    "hand-hero-sig11": 11,
    "hand-location-sig13": 13,
    "hand-hero-sig14": 14,
}

_SIG_HAND_REFS: dict[int, str] | None = None


def signature_hand_refs() -> dict[int, str]:
    """SIGNATURE_FRAME DBF → {frame_id: hand prefab "名字:GUID"}（dbf.unity3d 只读一次）。

    表结构探针 2026-10-25：8 条记录，字段 m_ID / m_handActorPrefab / m_playActorPrefab
    （AssetReference 串；frame 10 的 play 侧为空串——法术签名帧无 play prefab）。
    """
    global _SIG_HAND_REFS
    if _SIG_HAND_REFS is None:
        env = UnityPy.load(str(HS_DATA / "dbf.unity3d"))
        # container 直取（同 extract_watermarks.py 的 CARD_SET 惯例；探针实证键存在）
        recs = env.container["Assets/Game/DBF-Asset/SIGNATURE_FRAME.asset"].read_typetree()["Records"]
        _SIG_HAND_REFS = {r["m_ID"]: r["m_handActorPrefab"]
                          for r in recs if r.get("m_handActorPrefab")}
    return _SIG_HAND_REFS

# UberText 节点名 → 物理角色（TS plan 编译按卡型决定渲染与否与文本来源）
ROLE_BY_NODE = {
    "CostUberText": "cost",
    "NameUberText": "name",
    "PowersUberText": "desc",
    "AttackUberText": "attack",
    "HealthUberText": "health",   # 武器/地标 = 耐久（HEALTH tag）
    "ArmorUberText": "armor",
    "RaceUberText": "race",       # 随从=种族；法术=学派板（同节点名）
    # 佣兵技能冷却配置数字（LettuceAbilityActor.UpdateCooldownConfigText；
    # 两个 ability prefab 该 actor 引用序列化为空 → 文本恒空、Hourglass 恒隐）
    "CooldownConfigUberText": "cooldown",
    # 佣兵本体（Card_Hand_Mercenary，hand-mercenary）：
    #  - 种族文本不是 RaceUberText：m_raceTextMesh/m_multiRaceTextMesh 绑定
    #    Race_Tribe_Merc_text / DualRace_Tribe_Merc_text（探针 merc-bindings.json，
    #    Actor.UpdateRace 单/多族二选一 SetActive，Actor.cs:6205-6234）；
    #    单族节点在 walk 序中靠前 → 由本表登记为 race，多族节点路径由 plan 按名扫层级取。
    #  - 等级数字（MercenaryActorLevelObject.m_levelText，探针实证已绑定）：等级取自
    #    LETTUCE_MERCENARY_EXPERIENCE tag（Actor.UpdateMercenaryLevelTextMesh，:3516-3528）。
    "Race_Tribe_Merc_text": "race",
    "LevelText": "level",
    # 签名帧（Evergreen/26 族）文本节点命名带下划线（T2 抽取探针：
    # Attack_UberText/Health_UberText/RacePlate_UberText，普通帧是 AttackUberText 等）；
    # Multi_RacePlate_UberText 故意不登记——walk 序在单族节点之前，登记会让单族卡绑错节点
    # （多族换节点由 plan.ts 按 wanted 集扫层级，见 plan.ts texts race 分支）。
    "Attack_UberText": "attack",
    "Health_UberText": "health",
    "RacePlate_UberText": "race",
}


def mat4_from_trs(pos, rot, scale) -> np.ndarray:
    """Unity 四元数(x,y,z,w) + 平移 + 缩放 → 4x4（行主序，右乘列向量）。同 ally_recon。"""
    x, y, z, w = rot
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)
    M = np.eye(4)
    M[:3, :3] = R @ np.diag(scale)
    M[:3, 3] = pos
    return M


def ptr_dict(p) -> dict:
    if isinstance(p, dict):
        return {"m_FileID": p.get("m_FileID", 0), "m_PathID": p.get("m_PathID", 0)}
    return {"m_FileID": getattr(p, "m_FileID", 0), "m_PathID": getattr(p, "m_PathID", 0)}


def list_actor_ref(slot: str) -> str:
    """签名帧：SIGNATURE_FRAME 表「名字:GUID 直指」（先例 five-cardtypes
    explore/2026-10-03-five-cardtypes/scripts/extract_signature_probe.py 的硬编码版转正）。
    常规帧：data/actor_names.csv normal × actor_slot 行（ActorNames.GetHandActor 离线等价）。"""
    if slot in SIG_SLOT_TO_FRAME:
        refs = signature_hand_refs()
        frame_id = SIG_SLOT_TO_FRAME[slot]
        if frame_id not in refs:
            raise KeyError(f"SIGNATURE_FRAME 无 frame {frame_id} 的 m_handActorPrefab")
        return refs[frame_id]
    quality = "golden" if slot in PREMIUM_SLOT_TO_ACTOR_KEY else "normal"
    key = PREMIUM_SLOT_TO_ACTOR_KEY.get(slot, SLOT_TO_ACTOR_KEY.get(slot))
    if key is None:
        raise KeyError(f"无 actor 映射的帧槽: {slot}")
    with open(REPO / "data" / "actor_names.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["quality"] == quality and r["actor_slot"] == key:
                return f"{r['asset_name']}:{r['guid']}"
    raise KeyError(f"actor_names.csv 无 {quality}/{key}")


class Recon:
    def __init__(self, out_dir: Path, slot: str):
        self.r = None
        self.bundle = None
        self.out = out_dir
        self.slot = slot
        self.nodes: list[dict] = []
        self.mesh_jobs: list[dict] = []
        self.tex_saved: dict[tuple[str, int], dict] = {}
        self.issues: list[str] = []
        self.actor_mt: dict | None = None
        self.actor_owner = None

    def tex_ref(self, name: str) -> str:
        return f"frames/{self.slot}/textures/{name}.png"

    def save_texture(self, t_reader, bundle: str) -> dict:
        key = (bundle, t_reader.path_id)
        if key in self.tex_saved:
            return self.tex_saved[key]
        tree = t_reader.read_typetree()
        settings = tree.get("m_TextureSettings") or {}
        info = {"name": tree.get("m_Name"), "bundle": bundle, "path_id": t_reader.path_id,
                "width": tree.get("m_Width"), "height": tree.get("m_Height"),
                "format": tree.get("m_TextureFormat"),
                "wrap_u": settings.get("m_WrapU", tree.get("m_WrapMode")),
                "wrap_v": settings.get("m_WrapV", tree.get("m_WrapMode")),
                "filter_mode": settings.get("m_FilterMode", tree.get("m_FilterMode"))}
        png = self.out / "textures" / f"{info['name']}.png"
        png.parent.mkdir(parents=True, exist_ok=True)
        try:
            t_reader.read().image.save(png)
            info["file"] = self.tex_ref(info["name"])
        except Exception as exc:  # noqa: BLE001
            info["file"] = None
            info["error"] = f"{type(exc).__name__}: {exc}"
        self.tex_saved[key] = info
        return info

    def walk_material(self, m_reader, mbundle: str, owner) -> dict | None:
        try:
            mt = m_reader.read_typetree()
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"material {m_reader.path_id}: {exc}")
            return None
        info = {"name": mt.get("m_Name"), "bundle": mbundle, "path_id": m_reader.path_id,
                "shader": None, "tex": {}, "colors": {}, "floats": {}}
        # shader keyword 状态（多变体 shader 如 Uber/UberCardBack 的变体选择证据）：
        # Unity 6 序列化为 m_ValidKeywords/m_InvalidKeywords，旧字段 m_ShaderKeywords 已不在
        # typetree（存在则一并带出）。实测签名帧 uber 图集材质 valid/invalid 皆空 = nokw
        # 基础变体——特效层 keyword/参数由运行时 UberShaderAnimation 驱动
        # （CardDef.GetUberShaderAnimationPath(SIGNATURE)，CardDef.cs:1292-1297），
        # 离线静态口径按序列化态冻结（spec 实现决策 6）。_Layer{1,2,3}_ 参数族
        # （Translate/Rotate/Scale/Blend/Mask/Color/Distortion/FlowTranslate/FlowScale +
        # _Seed/_TimeScale/_ShaderTime）是普通 floats/colors，走下方全量导出，无需特判。
        info["keywords"] = {kf: (mt.get(kf) or [])
                            for kf in ("m_ShaderKeywords", "m_ValidKeywords", "m_InvalidKeywords")
                            if kf in mt}
        saved = mt.get("m_SavedProperties", {})

        # shader 名（PPtr → Shader.m_ParsedForm.m_Name）。混合语义靠它区分：
        # Hero/Multiply/* = 乘法阴影（FS: rgb=_MainTex.rgb+COLOR0.rgb, a=0；VS: COLOR0=vertColor*_Color），
        # 离线链若按 alpha-over 画会把乘法阴影涂成不透明黑（精英银龙影啃掉卡角，TLC_433）。
        shader_ptr = ptr_dict(mt.get("m_Shader") or {})
        if shader_ptr.get("m_PathID"):
            try:
                s_reader, _sb = self.r.resolve_pptr(mbundle or self.bundle, shader_ptr, owner)
                st = s_reader.read_typetree()
                parsed = st.get("m_ParsedForm") or {}
                info["shader"] = parsed.get("m_Name") or st.get("m_Name")
            except Exception as exc:  # noqa: BLE001
                self.issues.append(f"shader {m_reader.path_id}: {exc}")

        def pair(e):
            return (e["first"], e["second"]) if isinstance(e, dict) else (e[0], e[1])

        for first, sec in (pair(e) for e in saved.get("m_TexEnvs", [])):
            tptr = ptr_dict(sec.get("m_Texture") or {})
            sc, of = sec.get("m_Scale") or {}, sec.get("m_Offset") or {}
            slot = {"scale": [sc.get("x", 1), sc.get("y", 1)],
                    "offset": [of.get("x", 0), of.get("y", 0)]}
            if tptr.get("m_PathID"):
                try:
                    t_reader, tb = self.r.resolve_pptr(mbundle or self.bundle, tptr, owner)
                except Exception as exc:  # noqa: BLE001
                    slot["error"] = str(exc)
                else:
                    if t_reader.type.name == "Texture2D":
                        tinfo = self.save_texture(t_reader, tb)
                        slot["texture"] = {"name": tinfo["name"], "bundle": tb,
                                           "file": tinfo.get("file"),
                                           "wrap_u": tinfo.get("wrap_u"),
                                           "wrap_v": tinfo.get("wrap_v"),
                                           "filter_mode": tinfo.get("filter_mode")}
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
            uv1 = np.array(h.m_UV1, dtype=np.float64).reshape(-1, 2) if h.m_UV1 else uv0
            # TIME_EVENT_999's selected UnlitTextureReflection VS reads Mesh NORMAL to form
            # reflection UV. Unity's offline frame pack previously dropped that vertex stream,
            # making an exact translation impossible; preserve the serialized normals when present.
            normal_data = np.asarray(h.m_Normals, dtype=np.float64) if h.m_Normals else None
            normals = (normal_data.reshape(len(verts), -1)[:, :3]
                       if normal_data is not None and len(normal_data) == len(verts) else None)
            tris_per_sub = [np.array([t for t in sub if len(t) == 3], dtype=np.int32)
                            for sub in h.get_triangles()]
            return {"name": mesh.m_Name, "verts": verts, "uv0": uv0, "uv1": uv1,
                    "normals": normals,
                    "uv1_present": bool(h.m_UV1),
                    "submeshes": tris_per_sub,
                    "bbox_min": verts.min(axis=0).tolist(), "bbox_max": verts.max(axis=0).tolist(),
                    "bundle": mbundle, "path_id": mesh_reader.path_id}
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"mesh {getattr(mesh_reader, 'path_id', '?')}: {type(exc).__name__}: {exc}")
            return None

    def walk(self, go_reader, path: str, key: str, depth: int = 0,
             parent_active: bool = True) -> dict:
        if depth > 16:
            raise RuntimeError(f"{path}: 超深层级")
        tree = go_reader.read_typetree()
        name = tree["m_Name"]
        node_path = f"{path}/{name}" if path else name
        node = {"name": name, "go_path_id": go_reader.path_id, "path": node_path,
                "npz_key": key, "local": None, "world": None, "children": [],
                "renderers": [], "ubertext": None, "mono_unknown": [],
                "active_self": bool(tree.get("m_IsActive", 1)),
                "active_in_hierarchy": bool(parent_active and tree.get("m_IsActive", 1))}
        transform = None
        transform_obj = None
        for comp in tree.get("m_Component", []):
            pd = ptr_dict(comp["component"])
            if not pd["m_PathID"]:
                continue
            try:
                cobj, _cb = self.r.resolve_pptr(self.bundle, pd, go_reader)
            except Exception as exc:  # noqa: BLE001
                self.issues.append(f"{node_path} 组件 {pd['m_PathID']}: {exc}")
                continue
            ctype = cobj.type.name
            ctree = cobj.read_typetree()
            if ctype == "Transform":
                transform = ctree
                transform_obj = cobj
                p, q, s = ctree["m_LocalPosition"], ctree["m_LocalRotation"], ctree["m_LocalScale"]
                node["local"] = {"pos": [p["x"], p["y"], p["z"]],
                                 "rot": [q["x"], q["y"], q["z"], q["w"]],
                                 "scale": [s["x"], s["y"], s["z"]]}
            elif ctype in ("MeshFilter", "MeshRenderer", "SkinnedMeshRenderer"):
                if ctype == "MeshFilter":
                    mp = ptr_dict(ctree.get("m_Mesh") or {})
                    if mp.get("m_PathID"):
                        # 内建 Quad（unity default resources / unity_builtin_extra 的 pid 10210）：
                        # resolve_pptr 解不了内建外部引用，此前直接记 issue → 无网格 → 渲染端
                        # 跳过该 quad。游戏数据实例（2026-10-07 探针
                        # explore/2026-10-07-edge-align/probe_multiclass2.py）：
                        # Multiclass_Ribbon_Shadow_mesh（多职业绶带阴影 quad，序列化名带尾随
                        # 空格）的 MeshFilter = fid=7 pid=10210 → "unity default resources"，
                        # 缺网格即"缎带无投影"的根因。几何 = Unity 内建 Quad 标准 1×1；
                        # 三角剖分须共享一条对角线才盖满 quad（[0,1,3]+[0,3,2]）——
                        # extract_banner_assets.py builtin_quad 曾误写 [0,3,1]+[0,1,2]
                        # （两条对角线各取一三角），Faction_Icon 渲染缺左上四分之一。
                        builtin_external = False
                        if mp.get("m_FileID", 0) != 0:
                            exts = [Path(e.path).name for e in (cobj.assets_file.externals or [])]
                            target = exts[mp["m_FileID"] - 1] if mp["m_FileID"] <= len(exts) else "?"
                            builtin_external = "builtin" in target or "default resources" in target
                        # 内建网格：Quad(10210, 1×1) 与 Plane(10209, 10×10)。Plane 是平坦网格，
                        # 网格细分不改变像素结果 → 用两个共对角线的三角形覆盖同一矩形即可；
                        # 尺度按内建 Plane 的 ±5 展开。UV 角向两网格不同（2026-10-11 探针
                        # explore/2026-10-10-lettuce-frame/scripts/probe_plane_flagshadow.py
                        # 逐顶点实测 unity default resources pid 10209，121 顶点 200 三角）：
                        #   Quad = uv(0,0) 在 (-x,-y) 角，u 沿 +x、v 沿 +y；
                        #   Plane = uv(0,0) 在 (+x,+z) 角，u 沿 -x、v 沿 -z
                        #   （角点实测 (+5,+5)→(0,0)、(-5,-5)→(1,1)）——与 Quad 恰好 180° 反向，
                        # 照 Quad 抄会让贴图在平面上旋转 180°（旗影 OvalShadow 首版即踩此坑）。
                        # 实证：Card_Hand_Mercenary 的 OvalShadow（旗影，Hero/Multiply/Multiply +
                        # FlagShadow）MeshFilter = 内建 Plane。
                        _builtin_quad = (mp["m_PathID"] == 10210)
                        _builtin_plane = (mp["m_PathID"] == 10209)
                        if builtin_external and (_builtin_quad or _builtin_plane):
                            # Quad = 竖直面（xy 平面，±0.5）；Plane = **水平面**（xz 平面，±5，
                            # 探针 pid 10209 bbox [-5,0,-5]..[5,0,5]）。用错平面会让节点矩阵
                            # （把 mesh x/z 映到世界 x/z）把网格压成一条线：OvalShadow（旗影）
                            # 首版按 Quad 竖直约定 → 屏幕上退化为线段 → 不可见。
                            h = 0.5 if _builtin_quad else 5.0
                            quad_verts = (np.array([[-h, -h, 0.0], [h, -h, 0.0],
                                                    [-h, h, 0.0], [h, h, 0.0]]) if _builtin_quad
                                          else np.array([[-h, 0.0, -h], [h, 0.0, -h],
                                                         [-h, 0.0, h], [h, 0.0, h]]))
                            quad_uv = (np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
                                       if _builtin_quad
                                       else np.array([[1.0, 1.0], [0.0, 1.0], [1.0, 0.0], [0.0, 0.0]]))
                            _nm = "builtin:Quad" if _builtin_quad else "builtin:Plane"
                            node["mesh"] = {"name": _nm, "verts": quad_verts,
                                            "uv0": quad_uv, "uv1": quad_uv, "uv1_present": False,
                                            "submeshes": [np.array([[0, 1, 3], [0, 3, 2]], dtype=np.int32)],
                                            "bbox_min": quad_verts.min(axis=0).tolist(),
                                            "bbox_max": quad_verts.max(axis=0).tolist(),
                                            "bundle": "<builtin>", "path_id": mp["m_PathID"]}
                        else:
                            try:
                                mobj, mb = self.r.resolve_pptr(self.bundle, mp, cobj)
                                mesh = self.extract_mesh(mobj, mb)
                                if mesh is not None:
                                    node["mesh"] = mesh
                            except Exception as exc:  # noqa: BLE001
                                self.issues.append(f"{node_path} mesh: {exc}")
                else:
                    mats = []
                    for mp in ctree.get("m_Materials", []):
                        pdm = ptr_dict(mp)
                        if not pdm.get("m_PathID"):
                            mats.append(None)
                            continue
                        try:
                            mobj, mb = self.r.resolve_pptr(self.bundle, pdm, cobj)
                            mats.append(self.walk_material(mobj, mb, mobj))
                        except Exception as exc:  # noqa: BLE001
                            mats.append(None)
                            self.issues.append(f"{node_path} mat: {exc}")
                    node["renderers"].append({"enabled": ctree.get("m_Enabled"),
                                              "materials": mats,
                                              "renderer_path_id": cobj.path_id})
            elif ctype == "MonoBehaviour":
                if "m_CharacterSize" in ctree and "m_FontSize" in ctree:
                    node["ubertext"] = self.ubertext_record(ctree, cobj)
                elif "m_cardMesh" in ctree or "m_portraitMesh" in ctree:
                    if self.actor_mt is None:
                        self.actor_mt = ctree
                        self.actor_owner = cobj
                else:
                    keys = sorted(k for k in ctree.keys() if k.startswith("m_")) if isinstance(ctree, dict) else []
                    node["mono_unknown"].append({"path_id": cobj.path_id, "m_keys": keys[:24]})
        if transform is not None:
            for ch in transform.get("m_Children", []):
                cpd = ptr_dict(ch)
                if not cpd["m_PathID"]:
                    continue
                try:
                    tr_obj, _ = self.r.resolve_pptr(self.bundle, cpd, transform_obj)
                    tr_tree = tr_obj.read_typetree()
                    gop = ptr_dict(tr_tree.get("m_GameObject") or {})
                    go_child, _ = self.r.resolve_pptr(self.bundle, gop, tr_obj)
                except Exception as exc:  # noqa: BLE001
                    self.issues.append(f"{node_path} 子解析: {exc}")
                    continue
                child = self.walk(go_child, node_path, f"{key}.{len(node['children'])}",
                                  depth + 1, node["active_in_hierarchy"])
                node["children"].append(child)
        return node

    def ubertext_record(self, mt: dict, cobj) -> dict:
        rec = {"path_id": cobj.path_id, "fields": mt}
        fp = ptr_dict(mt.get("m_Font") or {})
        rec["font_pptr"] = fp
        if fp.get("m_PathID"):
            try:
                fobj, fb = self.r.resolve_pptr(self.bundle, fp, cobj)
                ftree = fobj.read_typetree()
                rec["font_name"] = ftree.get("m_Name")
                rec["font_bundle"] = fb
            except Exception as exc:  # noqa: BLE001
                rec["font_error"] = str(exc)
        return rec

    def finalize_actor(self, root_owner) -> dict:
        mt = self.actor_mt
        by_pid = {n["go_path_id"]: n["path"] for n in self.iter_nodes(self.hierarchy)}
        rec: dict = {}
        for k, v in mt.items():
            if not k.startswith("m_"):
                continue
            if isinstance(v, dict) and "m_PathID" in v:
                pd = ptr_dict(v)
                if not pd["m_PathID"]:
                    continue
                entry: dict = {"file_id": pd["m_FileID"], "path_id": pd["m_PathID"]}
                hit = by_pid.get(pd["m_PathID"])
                if hit:
                    entry["node"] = hit
                else:
                    try:
                        o, b = self.r.resolve_pptr(self.bundle, pd, root_owner)
                        t = o.read_typetree()
                        entry.update({"name": t.get("m_Name"), "type": o.type.name, "bundle": b})
                    except Exception as exc:  # noqa: BLE001
                        entry["error"] = str(exc)
                rec.setdefault("object_refs", {})[k] = entry
            elif isinstance(v, (int, float, str, bool)) or v is None:
                rec.setdefault("scalars", {})[k] = v
        return rec

    def iter_nodes(self, node):
        yield node
        for c in node["children"]:
            yield from self.iter_nodes(c)


def _iter_sf(env):
    from UnityPy.files import SerializedFile

    def walk(file):
        if isinstance(file, SerializedFile):
            yield file
            return
        subs = getattr(file, "files", None)
        if isinstance(subs, dict):
            for sub in subs.values():
                yield from walk(sub)

    for f in env.files.values():
        yield from walk(f)


def extract_mesh_from_bundle(r: Recon, bundle: str, path_id: int) -> dict | None:
    env = r.r.open_bundle(bundle)
    for sf in _iter_sf(env):
        if path_id in sf.objects:
            obj = sf.objects[path_id]
            if obj.type.name != "Mesh":
                return None
            return r.extract_mesh(obj, bundle)
    return None


def ref_pptr_path(rec: Recon, ptr: dict, owner) -> str | None:
    """PPtr(MonoBehaviour 字段) → 目标 GameObject 的帧路径（go_path_id 对表）。"""
    if not ptr.get("m_PathID"):
        return None
    by_pid = {n["go_path_id"]: n["path"] for n in rec.iter_nodes(rec.hierarchy)}
    if ptr["m_PathID"] in by_pid:
        return by_pid[ptr["m_PathID"]]
    # GameObject 引用（m_RenderOnObject 直接指 GO 或指带 GO 的节点）
    try:
        obj, _b = rec.r.resolve_pptr(rec.bundle, ptr, owner)
        if obj.type.name == "GameObject":
            return by_pid.get(obj.path_id)
        tree = obj.read_typetree()
        gop = ptr_dict(tree.get("m_GameObject") or {})
        if gop.get("m_PathID"):
            return by_pid.get(gop["m_PathID"])
    except Exception:  # noqa: BLE001
        return None
    return None


def tris_json(mesh: dict) -> dict:
    # uv1：desc 水印采样通道（Unlit_2Texture2uv VS `o1.zw = UV1×_SecondTex_ST`）。
    # mesh 无 UV1 通道时回退 uv0 = 引擎语义（hero desc mesh 实测仅 channel4=UV0、
    # channel5=UV1 缺位；hero 序列化 _SecondTex_ST=(5,5,−2.01,−0.54) → 采样 =
    # uv0×(5,5)+offset → 水印 5× 放大窗出现在 desc 框中部——2026-10-07 用户指认
    # AV_205 参照明确有水印、uv0 回退渲染与参照匹配，(0,0) 零填假设被参照证伪）。
    # portrait.json 不经此处，肖像网格恒有真 uv1。
    result = {"verts": mesh["verts"].tolist(), "uv0": mesh["uv0"].tolist(),
              "uv1": mesh["uv1"].tolist(),
              "subs": [t.tolist() for t in mesh["submeshes"]]}
    if mesh.get("normals") is not None:
        result["normals"] = mesh["normals"].tolist()
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", default="hand-spell",
                    choices=sorted([*SLOT_TO_ACTOR_KEY, *PREMIUM_SLOT_TO_ACTOR_KEY,
                                    *SIG_SLOT_TO_FRAME]))
    ap.add_argument("--all", action="store_true", help="全部常规帧（不含签名帧）")
    ap.add_argument("--sig", action="store_true",
                    help="全部签名帧（SIG_SLOT_TO_FRAME，引用来自 SIGNATURE_FRAME 表）")
    ap.add_argument("--pack", default=str(REPO / "assets"))
    args = ap.parse_args()

    slots = (sorted(SLOT_TO_ACTOR_KEY) if args.all
             else sorted(SIG_SLOT_TO_FRAME) if args.sig
             else [args.slot])
    pack = Path(args.pack)
    for slot in slots:
        rc = extract_one(pack, slot)
        if rc != 0:
            return rc
        if slot == "hand-weapon-golden":
            # JAIL_450's DK class atlas also darkens the premium weapon's flowers because
            # Actor.cs:6700-6708 assigns one texture to PortraitFrame_mesh slot 0; the offline
            # plan has the same single-texture slot and cannot independently tint its subregions.
            # Generate the UV-evidenced composite after extracting that atlas. The exact asset
            # paths and A/B probe evidence are documented by compose_golden_dk_weapon_atlas.py.
            from compose_golden_dk_weapon_atlas import compose
            compose(pack)
    return 0


def extract_one(pack: Path, slot: str) -> int:
    out = pack / "frames" / slot
    (out / "textures").mkdir(parents=True, exist_ok=True)
    actor_ref = list_actor_ref(slot)
    print(f"[ref] {slot}: {actor_ref}")

    rec = Recon(out, slot)
    rec.r = __import__("resolve_asset_ref", fromlist=["Resolver"]).Resolver(HS_DATA) \
        if False else None
    # Resolver 由 scripts/ 同目录提供（uv run 时 CWD 不保证，显式插路径）
    sys.path.insert(0, str(HERE))
    from resolve_asset_ref import Resolver  # noqa: E402
    rec.r = Resolver(HS_DATA)

    res = rec.r.resolve(actor_ref)
    if not res["ok"]:
        print(f"[fail] actor 解析失败: {res['checks']}")
        return 1
    rec.bundle = res["resolved"]["bundle"]
    guid = res["resolved"]["guid"]
    root_go, _ = rec.r.container_get(rec.bundle, guid)
    frame_root = root_go.read_typetree()["m_Name"]
    print(f"[frame] root={frame_root} bundle={rec.bundle}")

    hierarchy = rec.walk(root_go, "", "root")
    rec.hierarchy = hierarchy

    def assign_world(node, parent_m):
        M = mat4_from_trs(**{k: node["local"][k] for k in ("pos", "rot", "scale")}) \
            if node["local"] else np.eye(4)
        node["world"] = (parent_m @ M).tolist()
        for ch in node["children"]:
            assign_world(ch, np.array(node["world"]))

    # 根平移归零（canonical 快照位姿；出处 ally_recon.py 同节）
    root_pos_raw = None
    if hierarchy.get("local"):
        root_pos_raw = hierarchy["local"]["pos"]
        hierarchy["local"] = {**hierarchy["local"], "pos": [0.0, 0.0, 0.0]}
    assign_world(hierarchy, np.eye(4))

    # ---- 网格表（meshes.json：npz_key → verts/uv0/subs）----
    meshes: dict[str, dict] = {}
    full_mesh_by_path: dict[str, dict] = {}
    for n in list(rec.iter_nodes(hierarchy)):
        mesh = n.pop("mesh", None)
        if not mesh:
            continue
        full_mesh_by_path[n["path"]] = mesh
        meshes[n["npz_key"]] = tris_json(mesh)
        n["mesh_stats"] = {"name": mesh["name"], "verts": len(mesh["verts"]),
                           "submesh_tris": [len(t) for t in mesh["submeshes"]],
                           "bbox_min": mesh["bbox_min"], "bbox_max": mesh["bbox_max"]}

    # ---- actor 绑定 + actor 直引 extra 网格 ----
    actor = rec.finalize_actor(rec.actor_owner)
    refs = actor.get("object_refs", {})
    # m_premiumRibbon：SIGNATURE/GOLDEN 时类色注入的材质槽索引（Actor.m_premiumRibbon
    # 默认 -1，Actor.cs:211；SetMaterialPremium → m_cardMesh.renderer.GetMaterial(
    # m_premiumRibbon)，Actor.cs:6577-6599——单类 material.color=CLASS_COLOR_* 且
    # _EnableDualClass=0，多类 _Color/_SecondColor 且 _EnableDualClass=1，spec 实现决策 7）
    premium_ribbon_slot = actor.get("scalars", {}).get("m_premiumRibbon")
    if premium_ribbon_slot is not None and premium_ribbon_slot >= 0:
        card_mesh_node = (refs.get("m_cardMesh") or {}).get("node")
        print(f"[ribbon] m_premiumRibbon={premium_ribbon_slot}（m_cardMesh={card_mesh_node}）")
    extra = {}
    for field, e in refs.items():
        if e.get("type") != "Mesh" or not e.get("bundle"):
            continue
        mesh = extract_mesh_from_bundle(rec, e["bundle"], e["path_id"])
        if mesh is None:
            continue
        key = f"extra/{field}"
        meshes[key] = tris_json(mesh)
        extra[key] = {"name": mesh["name"], "verts": len(mesh["verts"]),
                      "submesh_tris": [len(t) for t in mesh["submeshes"]],
                      "bundle": e["bundle"], "path_id": e["path_id"]}

    # ---- actor 引用的 Material 资产（如饰品 m_lesserTrinketMaterial/m_greaterTrinketMaterial，
    #      UpdateBaconTrinketComponents 运行时换上；Actor.cs:5368-5420）----
    material_refs = {}
    for field, e in refs.items():
        if e.get("type") != "Material" or not e.get("bundle"):
            continue
        try:
            env = rec.r.open_bundle(e["bundle"])
            mat_info = None
            for sf in _iter_sf(env):
                if e["path_id"] in sf.objects:
                    mat_info = rec.walk_material(sf.objects[e["path_id"]], e["bundle"],
                                                 sf.objects[e["path_id"]])
                    break
            if mat_info:
                material_refs[field] = mat_info
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] material ref {field}: {exc}")

    # ---- role_paths（UberText 节点名 → 角色；路径相对帧根）----
    # 失活子树豁免（runtime-driven texts）：序列化失活子树里的 UberText 若 (a) 节点自身
    # 激活（active_self）、(b) 被 actor 文本字段直引（m_attackTextMesh 等的 PPtr 命中该
    # UberText 组件），仍登记角色——运行时 UpdateXxxTextMesh 会对非空引用写文本；但
    # 写文本 ≠ 可见：只有 def 路径（entityDef 语境）才无条件 GemObject.Show()（=
    # SetActive(true)，GemObject.cs:55-58）翻正失活父级（Actor.cs:3414-3418/3462-3487），
    # 游戏内手牌 actor 无 entityDef（Card.cs:6150-6168）走 entity 路径、只写不 Show
    # （Actor.cs:4370-4377；GemObject.m_hiddenFlag 非序列化恒 false）。实证：佣兵技能
    # spell 变体 AttackObject/HealthObject 出厂失活 → 游戏内非召唤技不显示攻血
    # （"0" 写进失活对象）；基准图上的 "0" 是 exporter def 路径伪影，渲染端按现场口径
    # 登记角色但置空不画（docs/findings/lettuce-frame-teardown-2026-10-10.md §9，
    # 2026-10-11 修正——旧结论「游戏对所有技能画攻血 0」系把 exporter 伪影当成游戏行为）。
    TEXT_FIELD_TO_ROLE = {
        "m_costTextMesh": "cost", "m_attackTextMesh": "attack",
        "m_healthTextMesh": "health", "m_nameTextMesh": "name",
        "m_powersTextMesh": "desc", "m_raceTextMesh": "race",
        "m_cooldownConfigText": "cooldown",
    }
    bound_ubertext_pids = {
        refs[f]["path_id"] for f in TEXT_FIELD_TO_ROLE
        if refs.get(f, {}).get("path_id")
    }
    role_paths: dict[str, str] = {}
    for n in rec.iter_nodes(hierarchy):
        if not n.get("ubertext"):
            continue
        role = ROLE_BY_NODE.get(n["name"])
        if not role or role in role_paths:
            continue
        if not n.get("active_in_hierarchy"):
            runtime_driven = bool(n.get("active_self")) and \
                n["ubertext"].get("path_id") in bound_ubertext_pids
            if not runtime_driven:
                continue   # 序列化失活子树（如 BG_TrinketMesh）里的同名文本节点不渲染
        rel = n["path"]
        if rel.startswith(f"{frame_root}/"):
            rel = rel[len(frame_root) + 1:]
        role_paths[role] = rel
    print(f"[roles] {json.dumps(role_paths, ensure_ascii=False)}")

    # ---- 肖像通道（m_portraitMesh 节点：mesh uv0/uv1/sub0/sub1 + 材质 _SecondTint/_BlendIntensity/_SecondTex）----
    portrait_node = refs.get("m_portraitMesh", {}).get("node")
    portrait_node_key = None
    portrait = None
    material_props = None
    second_tex = None
    if portrait_node:
        pn = next(n for n in rec.iter_nodes(hierarchy) if n["path"] == portrait_node)
        portrait_node_key = pn["npz_key"]
        m = full_mesh_by_path[portrait_node]
        mesh_name = m["name"]
        subs = [t.tolist() for t in m["submeshes"]]
        portrait = {"verts": m["verts"].tolist(), "uv0": m["uv0"].tolist(),
                    "uv1": m["uv1"].tolist(),
                    "sub0": subs[0] if len(subs) > 0 else [],
                    "sub1": subs[1] if len(subs) > 1 else []}
        # 肖像材质：节点 renderer 的 m_portraitMatIdx 槽
        pnode = next(n for n in rec.iter_nodes(hierarchy) if n["path"] == portrait_node)
        pmat_idx = actor.get("scalars", {}).get("m_portraitMatIdx", 0)
        mat = None
        for rr in pnode.get("renderers", []):
            mats = rr.get("materials") or []
            if 0 <= pmat_idx < len(mats) and mats[pmat_idx]:
                mat = mats[pmat_idx]
                break
        if mat is None:
            # 饰品帧（Card_Hand_BG_Trinket）的肖像槽序列化为空：运行时经
            # UpdatePortraitMaterials → cardDef.GetPortraitMaterial(NORMAL)（m_useCardDefMaterial=1）
            # 塞入标准肖像材质，原画纹理由 CardDef 给。离线链按「槽位 + 标准肖像公式 + fixture 原画」处理。
            print(f"[portrait] {portrait_node}: 肖像材质槽 {pmat_idx} 序列化为空（运行时 CardDef 材质）")
        material_props = None if mat is None else {
            "m_Colors": {"_SecondTint": dict(zip("rgba", mat["colors"].get("_SecondTint", [0.5, 0.5, 0.5, 1.0])))},
            "m_Floats": {"_BlendIntensity": mat["floats"].get("_BlendIntensity", 1.0)},
        }
        st = mat["tex"].get("_SecondTex", {}).get("texture") if mat else None
        second_tex = st.get("file") if st else None
        print(f"[portrait] node={portrait_node_key} mesh={mesh_name} matIdx={pmat_idx} secondTex={second_tex}")

    # ---- 名字 RTT 载体网格（NameUberText.m_RenderOnObject → 网格；武器帧无 → 平面 fallback）----
    carrier = None
    name_path = None
    if role_paths.get("name"):
        name_path = f"{frame_root}/{role_paths['name']}"
    for n in rec.iter_nodes(hierarchy):
        u = n.get("ubertext")
        if not u or n["path"] != name_path:
            continue
        ro = u["fields"].get("m_RenderOnObject")
        rop = ptr_dict(ro) if ro else {}
        target_path = ref_pptr_path(rec, rop, None) if rop.get("m_PathID") else None
        if not target_path:
            print("[carrier] m_RenderOnObject 空 → 平面 fallback（无 curved.json）")
            break
        tn = next((x for x in rec.iter_nodes(hierarchy) if x["path"] == target_path), None)
        if tn is None or not tn.get("mesh_stats"):
            print(f"[carrier] {target_path}: 无网格（跳过）")
            break
        # 载体网格：meshes 表已含（walk 时按 npz_key 落表）；curved.json 取该键
        cmesh = meshes[tn["npz_key"]]
        carrier = {"node": target_path, "npz_key": tn["npz_key"],
                   "mesh_name": tn["mesh_stats"]["name"],
                   "world": tn["world"]}
        print(f"[carrier] {target_path} mesh={tn['mesh_stats']['name']}")
        break

    # ---- 落盘 ----
    frame_recon = {"frame_root": frame_root, "prefab_ref": actor_ref, "bundle": rec.bundle,
                   "guid": guid,
                   "root_translation_neutralized": {
                       "raw_root_pos": root_pos_raw,
                       "reason": "prefab 根位置=场景摆位残留；游戏区域布局覆写根位置；canonical 位姿=恒等根（Ability 帧原点+E7 自然映射零偏移实证）"},
                   "hierarchy": hierarchy, "extra_meshes": extra,
                   "material_refs": material_refs}
    (out / "frame_recon.json").write_text(
        json.dumps(frame_recon, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    (out / "meshes.json").write_text(json.dumps(meshes, ensure_ascii=False), encoding="utf-8")
    if portrait:
        (out / "portrait.json").write_text(json.dumps(portrait, ensure_ascii=False), encoding="utf-8")
        (out / "material_props.json").write_text(
            json.dumps(material_props, ensure_ascii=False, indent=1), encoding="utf-8")
    if carrier:
        cmesh = meshes[carrier["npz_key"]]
        (out / "curved.json").write_text(json.dumps({
            "verts": cmesh["verts"], "uv0": cmesh["uv0"],
            "tris": [t for sub in cmesh["subs"] for t in sub],
            "world": carrier["world"], "_node": carrier["node"],
            "_mesh": carrier["mesh_name"]}, ensure_ascii=False), encoding="utf-8")

    # prefab_report
    rnodes = []
    for n in rec.iter_nodes(hierarchy):
        comp: dict = {}
        rr = n.get("renderers") or []
        if rr:
            slots = []
            for i, mat in enumerate(rr[0]["materials"]):
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
            comp["renderer"] = {"material_slots": slots}
        if n.get("ubertext"):
            comp["TextComponent"] = {"path_id": n["ubertext"]["path_id"],
                                     "font_name": n["ubertext"].get("font_name"),
                                     "font_pptr": n["ubertext"].get("font_pptr")}
        rnodes.append({"path": n["path"], "go_path_id": n["go_path_id"], "components": comp})
    (out / "prefab_report.json").write_text(json.dumps({
        "prefab": {"name": frame_root, "ref": actor_ref, "guid": guid, "bundle": rec.bundle},
        "nodes": rnodes, "actor_components": [actor],
        "issues": rec.issues,
        "textures": [dict(v) for v in rec.tex_saved.values()]}, ensure_ascii=False, indent=1,
        default=str), encoding="utf-8")

    # prefab_ubertext
    unodes = []
    for n in rec.iter_nodes(hierarchy):
        if n.get("ubertext"):
            u = n["ubertext"]
            unodes.append({"path": n["path"], "mono_path_id": u["path_id"],
                           "localPosition": (n["local"] or {}).get("pos"),
                           "localScale": (n["local"] or {}).get("scale"),
                           "localRotation": (n["local"] or {}).get("rot"),
                           "fields": u["fields"], "font_name": u.get("font_name")})
    unodes.sort(key=lambda n: n["path"])
    (out / "prefab_ubertext.json").write_text(json.dumps({
        "ref": actor_ref, "bundle": rec.bundle, "n_ubertext": len(unodes),
        "nodes": unodes}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    # 帧 manifest
    (out / "manifest.json").write_text(json.dumps({
        "slot": slot, "frame_root": frame_root, "prefab_ref": actor_ref,
        "role_paths": role_paths,
        "premium_ribbon_slot": premium_ribbon_slot,
        "portrait_node_key": portrait_node_key,
        "second_tex": second_tex,
        "carrier": ({k: v for k, v in carrier.items()} if carrier else None),
        "nodes": sum(1 for _ in rec.iter_nodes(hierarchy)),
        "mesh_keys": len(meshes),
        "textures": [v["name"] for v in rec.tex_saved.values() if v.get("file")]},
        ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[done] {slot}: nodes={sum(1 for _ in rec.iter_nodes(hierarchy))} meshes={len(meshes)} "
          f"textures={len(rec.tex_saved)} issues={len(rec.issues)}")
    for i in rec.issues[:12]:
        print("  -", i)
    return 0


if __name__ == "__main__":
    sys.exit(main())
