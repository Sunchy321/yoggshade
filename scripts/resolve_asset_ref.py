# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy"]
# ///
"""Hearthstone "名字:GUID" AssetReference 解析验证器（长期工具）。

复现游戏定位链（lab/2026-09-30-frame-texture-probe 逆向结论，语义照抄
AssetLoader.GetRuntimeAssetVariant / ScriptableAssetManifest.TryResolveAsset）：

    代码常量 "Card_Hand_Ally.prefab:d00eb..."   (AssetReference，名字:GUID)
      → asset_manifest.unity3d 变体解析（locale 覆盖查 asset_manifest_{locale}.unity3d；
        平台覆盖查主包 asset_catalog_platform_phone；默认 base/enUS，与 PC 运行时一致）
      → base_assets_catalog: GUID → bundle 文件名（392,791 条，一次性载入缓存）
      → 打开 bundle → env.container[GUID] = 对象（container 键即裸小写 GUID）

用法：
    CLI    uv run scripts/resolve_asset_ref.py "Card_Hand_Ally.prefab:d00eb0f7..." \
               [--locale zhcn] [--platform phone] [--json] [--game DIR]
    import from resolve_asset_ref import Resolver, resolve
           result = resolve("Card_Hand_Ally.prefab:d00eb...", locale="zhcn")

内置一致性检查（每项独立输出 pass/fail，不静默通过）：
    ① name-consistency   三源名称一致：引用名 stem == 对象 m_Name；
                          container 键 == 解析 GUID（本游戏 container 无路径只有 GUID，
                          故"路径 basename"退化为 GUID 恒等，见实验 findings）
    ② type-vs-extension  类型符合后缀预期（.prefab→GameObject / .mat→Material /
                          .psd→Texture2D / .asset→MonoBehaviour …；未知后缀记 skipped）
    ③ registration       登记一致：catalog 指向的 bundle == 对象实际所在 bundle 且文件
                          存在；locale 变体时另查：变体 GUID 在变体 bundle 命中、
                          变体 GUID 与 base catalog 的交叉登记

另附跨包 PPtr 解析（resolve_pptr，经 bundle_deps 的 CAB 依赖图），供走查脚本复用。
只读游戏目录，默认 D:\\game\\Hearthstone\\Data\\Win。

注意：quality/region 变体在当前 asset_manifest.unity3d 中无对应 catalog 资产
（仅 platform_phone + 各语言包），resolve(..., quality=...) 为保留参数、当前 no-op。
变体叠加顺序按游戏 Load 次序近似为 platform → locale（locale 最后生效）；
CompositeAssetCatalog 未反编译到，本工具的叠加语义是近似，单层覆盖时与游戏一致。
"""
from __future__ import annotations

import os

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

DEFAULT_WIN = Path(os.environ.get("HS_GAME_DATA", "/Applications/Hearthstone/Data/OSX"))

# 后缀 → 允许的 Unity 对象类型名（类型不匹配即 check ② fail）
EXT_EXPECTED_TYPES: dict[str, set[str]] = {
    "prefab": {"GameObject"},
    "mat": {"Material"},
    "psd": {"Texture2D"},
    "png": {"Texture2D"},
    "tif": {"Texture2D"},
    "tiff": {"Texture2D"},
    "tga": {"Texture2D"},
    "jpg": {"Texture2D"},
    "jpeg": {"Texture2D"},
    "exr": {"Texture2D"},
    "asset": {"MonoBehaviour"},
    "wav": {"AudioClip"},
    "ogg": {"AudioClip"},
    "mp3": {"AudioClip"},
    "mesh": {"Mesh"},
    "controller": {"AnimatorController"},
    "playable": {"PlayableAsset"},
    "shader": {"Shader"},
    "font": {"Font"},
    "ttf": {"Font"},
    "otf": {"Font"},
}


class PPtrError(Exception):
    """PPtr 解析失败。reason ∈ {empty_slot, builtin, no_external, missing_cab, missing_pathid, error}"""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


def _iter_serialized(env):
    """深度优先枚举 env 里全部 SerializedFile（bundle 内多个 CAB）。"""
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


class Resolver:
    """manifest + bundle 的缓存式解析器（catalog 只载入一次）。"""

    def __init__(self, game_win: str | Path = DEFAULT_WIN):
        self.win = Path(game_win)
        if not (self.win / "asset_manifest.unity3d").is_file():
            raise FileNotFoundError(f"{self.win} 下没有 asset_manifest.unity3d（--game 指向 Data/Win？）")
        self._manifest_env = None
        self._catalog: dict[str, str] | None = None
        self._catalog_dup_guids: set[str] | None = None
        self._bundle_deps: dict[str, list[str]] | None = None
        self._cards_map: dict[str, str] | None = None
        self._platform_catalog: dict[str, tuple[str, str]] | None = None
        self._locale_catalogs: dict[str, dict[str, tuple[str, str]]] = {}
        self._envs: dict[str, object] = {}
        self._cabs_owner: dict[str, str] = {}
        self._cab_unreachable: set[str] = set()  # 确认找不到的 CAB，避免重扫依赖

    # ---------- manifest 侧 ----------

    def _manifest(self):
        if self._manifest_env is None:
            self._manifest_env = UnityPy.load(str(self.win / "asset_manifest.unity3d"))
        return self._manifest_env

    def _read_manifest_asset(self, suffix: str) -> dict:
        for key, obj in self._manifest().container.items():
            if key.lower().endswith(suffix.lower()):
                return obj.read_typetree()
        raise KeyError(f"asset_manifest.unity3d 无 {suffix}")

    @property
    def catalog(self) -> dict[str, str]:
        """base_assets_catalog：GUID → bundle 文件名。"""
        if self._catalog is None:
            data = self._read_manifest_asset("/base_assets_catalog.asset")
            names = data["m_bundleNames"]
            pairs = [(a["guid"], names[a["bundleId"]]) for a in data["m_assets"]]
            dup = {g for g, c in Counter(g for g, _ in pairs).items() if c > 1}
            self._catalog_dup_guids = dup
            self._catalog = dict(pairs)
        return self._catalog

    @property
    def catalog_duplicate_guids(self) -> set[str]:
        self.catalog  # 触发载入
        assert self._catalog_dup_guids is not None
        return self._catalog_dup_guids

    @property
    def bundle_deps(self) -> dict[str, list[str]]:
        """bundle_deps：bundle → 依赖 bundle 列表（allDependencies，含传递闭包）。"""
        if self._bundle_deps is None:
            data = self._read_manifest_asset("/bundle_deps.asset")
            names = data["allBundleNames"]
            self._bundle_deps = {
                n: [names[i] for i in d["allDependencies"] if names[i] != n]
                for n, d in zip(names, data["bundles"])
            }
        return self._bundle_deps

    @property
    def platform_catalog(self) -> dict[str, tuple[str, str]]:
        """asset_catalog_platform_phone：baseGuid → (变体 guid, bundle)。"""
        if self._platform_catalog is None:
            data = self._read_manifest_asset("/asset_catalog_platform_phone.asset")
            names = data["m_bundleNames"]
            self._platform_catalog = {
                a["baseGuid"]: (a["guid"], names[a["bundleId"]]) for a in data["m_assets"]
            }
        return self._platform_catalog

    def locale_catalog(self, locale: str) -> dict[str, tuple[str, str]]:
        """asset_manifest_{locale}.unity3d：baseGuid → (变体 guid, bundle)。"""
        code = locale.lower()
        if code in ("enus", "enus", "", "global", "none"):
            return {}
        if code not in self._locale_catalogs:
            path = self.win / f"asset_manifest_{code}.unity3d"
            if not path.is_file():
                raise FileNotFoundError(f"无 {path.name}（可用 locale 见 Data/Win 下 asset_manifest_*）")
            env = UnityPy.load(str(path))
            data = None
            for key, obj in env.container.items():
                if key.lower().endswith(f"asset_catalog_locale_{code}.asset"):
                    data = obj.read_typetree()
                    break
            if data is None:
                raise KeyError(f"{path.name} 内无 asset_catalog_locale_{code}.asset")
            names = data["m_bundleNames"]
            self._locale_catalogs[code] = {
                a["baseGuid"]: (a["guid"], names[a["bundleId"]]) for a in data["m_assets"]
            }
        return self._locale_catalogs[code]

    @property
    def cards_map(self) -> dict[str, str]:
        """cards_map：cardId → "名字.prefab:GUID"（CardDef 引用）。"""
        if self._cards_map is None:
            m = self._read_manifest_asset("/cards_map.asset")["map"]
            self._cards_map = dict(zip(m["keys"], m["values"]))
        return self._cards_map

    def card_def_ref(self, card_id: str) -> str | None:
        return self.cards_map.get(card_id)

    def stats(self) -> dict:
        return {
            "catalog_entries": len(self.catalog),
            "catalog_duplicate_guids": len(self.catalog_duplicate_guids),
            "bundles_in_deps": len(self.bundle_deps),
            "platform_phone_overrides": len(self.platform_catalog),
            "cached_bundles_opened": len(self._envs),
        }

    # ---------- bundle 侧 ----------

    def open_bundle(self, bundle: str):
        if bundle not in self._envs:
            path = self.win / bundle
            if not path.is_file():
                raise FileNotFoundError(f"bundle 不存在: {path}")
            env = UnityPy.load(str(path))
            self._envs[bundle] = env
            for sf in _iter_serialized(env):
                name = Path(str(getattr(sf, "name", ""))).name.lower()
                if name:
                    self._cabs_owner.setdefault(name, bundle)
        return self._envs[bundle]

    def container_get(self, bundle: str, guid: str):
        """container 精确 GUID 键优先，退化为 endswith 扫描（兼容带路径键的包）。
        注意 UnityPy 的 env.container 是代理对象（无 .get），值是 PPtr，需 deref。"""
        env = self.open_bundle(bundle)
        pptr = env.container.container_dict.get(guid)
        if pptr is not None:
            return pptr.deref(), guid
        for key, cand in env.container.items():
            if key.endswith(guid):
                return cand, key
        return None, None

    def find_by_name(self, bundle: str, name: str) -> list[tuple[str, str]]:
        """在 bundle container 里按对象名反查：返回 [(guid(container 键), 类型名)]。
        拆包资源 → manifest 反查（B 方向）用。"""
        env = self.open_bundle(bundle)
        hits = []
        for key, obj in env.container.items():
            try:
                if obj.read_typetree().get("m_Name") == name:
                    hits.append((key, obj.type.name))
            except Exception:  # noqa: BLE001
                continue
        return hits

    # ---------- PPtr（跨 bundle，bundle_deps CAB 图） ----------

    def resolve_pptr(self, cur_bundle: str, ptr: dict, owner_obj=None):
        """解 PPtr → (对象, 所在 bundle)。失败抛 PPtrError（reason 可分类统计）。"""
        path_id = ptr.get("m_PathID", 0)
        if not path_id:
            raise PPtrError("empty_slot", "m_PathID == 0（空槽位）")
        file_id = ptr.get("m_FileID", 0)
        env = self.open_bundle(cur_bundle)

        if file_id == 0:  # 同 bundle 内引用
            own = getattr(owner_obj, "assets_file", None)
            if own is not None and path_id in own.objects:
                return own.objects[path_id], cur_bundle
            for sf in _iter_serialized(env):
                if path_id in sf.objects:
                    return sf.objects[path_id], cur_bundle
            raise PPtrError("missing_pathid", f"{cur_bundle} 内无 pathID {path_id}")

        # 外部引用：owner 的 serialized file externals 给出目标 CAB 名
        own = getattr(owner_obj, "assets_file", None)
        target = None
        candidates: list[str] = []
        for sf in ([own] if own is not None else []) + list(_iter_serialized(env)):
            exts = list(getattr(sf, "externals", None) or [])
            if len(exts) >= file_id:
                candidates.append(Path(exts[file_id - 1].path).name.lower())
        target = next((c for c in candidates if c), None) if candidates else None
        if target is None:
            raise PPtrError("no_external", f"externals[{file_id - 1}] 不存在")

        if "unity default resources" in target or "unity_builtin_extra" in target:
            raise PPtrError("builtin", target)

        if target not in self._cabs_owner and target not in self._cab_unreachable:
            for dep in self.bundle_deps.get(cur_bundle, []):
                try:
                    self.open_bundle(dep)
                except Exception:  # noqa: BLE001
                    continue
                if target in self._cabs_owner:
                    break
            else:
                if target not in self._cabs_owner:
                    self._cab_unreachable.add(target)
        owner_bundle = self._cabs_owner.get(target)
        if owner_bundle is None:
            raise PPtrError(
                "missing_cab",
                f"CAB {target} 不在 {cur_bundle} 的依赖包中（deps={len(self.bundle_deps.get(cur_bundle, []))}）",
            )
        denv = self.open_bundle(owner_bundle)
        for sf in _iter_serialized(denv):
            if Path(str(getattr(sf, "name", ""))).name.lower() == target:
                if path_id in sf.objects:
                    return sf.objects[path_id], owner_bundle
                # 目标 CAB 找到但 pathID 不在（可能同名 CAB 多包，继续扫）
        raise PPtrError("missing_pathid", f"{owner_bundle}/{target} 无 pathID {path_id}")

    # ---------- 主解析 ----------

    def resolve(self, asset_ref: str, locale: str | None = None,
                platform: str | None = None, quality: str | None = None) -> dict:
        """"名字.ext:GUID" → 完整解析结果 + 一致性检查（见模块 docstring）。"""
        del quality  # 当前 manifest 无 quality catalog，保留参数
        asset_ref = asset_ref.strip()
        if ":" in asset_ref:
            ref_name, guid = asset_ref.rsplit(":", 1)
        else:
            ref_name, guid = "", asset_ref
        guid = guid.lower()
        result: dict = {
            "ref": asset_ref,
            "ref_name": ref_name,
            "guid": guid,
            "locale": locale,
            "platform": platform,
            "base": {"guid": guid, "bundle": self.catalog.get(guid)},
            "variant": None,
            "resolved": {"guid": guid, "bundle": None},
            "object": None,
            "checks": [],
            "ok": False,
        }

        # ---- 变体解析（platform → locale，后者覆盖前者；单层时与游戏一致） ----
        resolved_guid = guid
        if platform == "phone" and resolved_guid in self.platform_catalog:
            vguid, vbundle = self.platform_catalog[resolved_guid]
            result["variant"] = {"layer": "platform_phone", "guid": vguid, "bundle": vbundle}
            resolved_guid = vguid
        if locale:
            lc = self.locale_catalog(locale)
            if resolved_guid in lc:
                vguid, vbundle = lc[resolved_guid]
                result["variant"] = {"layer": f"locale_{locale.lower()}", "guid": vguid, "bundle": vbundle}
                resolved_guid = vguid

        resolved_bundle = self.catalog.get(resolved_guid) or (result["variant"] or {}).get("bundle")
        result["resolved"] = {"guid": resolved_guid, "bundle": resolved_bundle}
        if resolved_bundle is None:
            result["checks"].append(_check("registration", False,
                                           f"GUID {resolved_guid} 不在 base_assets_catalog（也无变体 bundle）"))
            return result

        # ---- 打开 bundle 取对象 ----
        container_key = None
        try:
            obj, container_key = self.container_get(resolved_bundle, resolved_guid)
        except FileNotFoundError as exc:
            result["checks"].append(_check("registration", False, str(exc)))
            return result
        if obj is None:
            result["checks"].append(_check(
                "registration", False,
                f"catalog 指向 {resolved_bundle}，但 container 无 {resolved_guid}"))
            return result

        try:
            tree = obj.read_typetree()
        except Exception as exc:  # noqa: BLE001
            result["checks"].append(_check("registration", False,
                                           f"对象读取失败 {type(exc).__name__}: {exc}"))
            return result

        obj_info = {
            "name": tree.get("m_Name"),
            "type": obj.type.name,
            "path_id": obj.path_id,
            "bundle": resolved_bundle,
            "cab": Path(str(getattr(obj.assets_file, "name", ""))).name,
            "container_key": container_key,
        }
        if obj.type.name == "Texture2D":
            obj_info["width"] = tree.get("m_Width")
            obj_info["height"] = tree.get("m_Height")
            obj_info["texture_format"] = tree.get("m_TextureFormat")
        elif obj.type.name == "Material":
            texenvs = tree.get("m_SavedProperties", {}).get("m_TexEnvs", [])
            obj_info["tex_slots"] = [slot for slot, _ in texenvs]
            obj_info["shader_ptr"] = tree.get("m_Shader", {})
        elif obj.type.name == "GameObject":
            obj_info["component_count"] = len(tree.get("m_Component", []))
        result["object"] = obj_info

        # ---- 检查 ①：三源名称一致 ----
        ref_stem = Path(ref_name).stem if ref_name else None
        obj_name = obj_info["name"]
        subs = []
        if ref_stem is not None:
            subs.append((f"引用名 stem({ref_stem!r}) == 对象名({obj_name!r})", ref_stem == obj_name))
        if container_key is not None:
            subs.append((f"container 键({container_key[:12]}…) == 解析 GUID",
                         container_key.lower().endswith(resolved_guid)))
        result["checks"].append(_check("name-consistency", all(p for _, p in subs),
                                       "; ".join(n for n, p in subs if not p) or "三源一致"))

        # ---- 检查 ②：类型符合后缀预期 ----
        ext = ref_name.rsplit(".", 1)[-1].lower() if "." in ref_name else ""
        expected = EXT_EXPECTED_TYPES.get(ext)
        if expected is None:
            result["checks"].append(_check("type-vs-extension", None, f"后缀 .{ext} 无预期表，跳过"))
        else:
            result["checks"].append(_check(
                "type-vs-extension", obj_info["type"] in expected,
                f".{ext} 预期 {sorted(expected)}，实际 {obj_info['type']}"))

        # ---- 检查 ③：登记一致 ----
        reg_notes = [f"catalog→{resolved_bundle} == 对象所在 {obj_info['bundle']}"]
        reg_ok = self.catalog.get(resolved_guid) == resolved_bundle or (
            result["variant"] is not None and result["variant"]["bundle"] == resolved_bundle)
        if result["variant"] is not None:
            v = result["variant"]
            base_hit = self.catalog.get(v["guid"])
            reg_notes.append(f"变体 GUID {v['guid'][:12]}… 在 base catalog 交叉登记 → {base_hit or '未登记'}")
        result["checks"].append(_check("registration", reg_ok, "; ".join(reg_notes)))

        result["ok"] = all(c["pass"] in (True, None) for c in result["checks"])
        return result


def _check(name: str, passed, note: str) -> dict:
    return {"check": name, "pass": passed, "note": note}


# ---------- 模块级便捷入口（import 用；catalog 全局缓存一次） ----------

_default: Resolver | None = None


def get_resolver(game: str | Path = DEFAULT_WIN) -> Resolver:
    global _default
    if _default is None or Path(_default.win) != Path(game):
        _default = Resolver(game)
    return _default


def resolve(asset_ref: str, locale: str | None = None, platform: str | None = None,
            quality: str | None = None, game: str | Path = DEFAULT_WIN) -> dict:
    """便捷入口：resolve("Card_Hand_Ally.prefab:d00eb...", locale="zhcn")。"""
    return get_resolver(game).resolve(asset_ref, locale=locale, platform=platform, quality=quality)


# ---------- CLI ----------

def _print_result(r: dict) -> None:
    print(f"[ref]     {r['ref']}")
    base = r["base"]
    print(f"[base]    catalog[{r['guid'][:12]}…] -> {base['bundle'] or '未登记'}")
    if r["variant"]:
        v = r["variant"]
        print(f"[variant] {v['layer']}: {r['guid'][:12]}… -> {v['guid'][:12]}… ({v['bundle']})")
    elif r["locale"]:
        print(f"[variant] locale={r['locale']}: 无覆盖，走 base")
    print(f"[object]  {r['object']}")
    for c in r["checks"]:
        mark = "PASS" if c["pass"] else ("skip" if c["pass"] is None else "FAIL")
        print(f"[check]   {c['check']:<18} {mark}  {c['note']}")
    print(f"RESULT: {'OK' if r['ok'] else 'MISMATCH/FAIL'}")
    print()


def cli(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="解析 Hearthstone \"名字:GUID\" AssetReference 并做一致性检查",
        epilog='例: uv run scripts/resolve_asset_ref.py "Card_Hand_Ally.prefab:d00eb0f79080e0749993fe4619e9143d" --locale zhcn')
    ap.add_argument("refs", nargs="+", help='"名字.ext:GUID" 引用（可多个）')
    ap.add_argument("--locale", default=None, help="语言变体（zhcn/zhtw/jajp/…，默认 base=enUS）")
    ap.add_argument("--platform", default=None, help="平台变体（phone），默认 PC/Any")
    ap.add_argument("--game", default=str(DEFAULT_WIN), help="游戏 Data/Win 目录")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    r = Resolver(args.game)
    results = [r.resolve(ref, locale=args.locale, platform=args.platform) for ref in args.refs]
    if args.json:
        print(json.dumps({"stats": r.stats(), "results": results},
                         ensure_ascii=False, indent=1, default=str))
    else:
        for res in results:
            _print_result(res)
    return 0 if all(x["ok"] for x in results) else 1


if __name__ == "__main__":
    sys.exit(cli())
