# /// script
# requires-python = ">=3.11"
# dependencies = ["unitypy", "numpy", "pillow"]
# ///
"""Compose a frozen UberGoldenCard portrait from a CardDef material and animation.

The offline renderer has no Unity material runtime. This tool evaluates the exact
UberGoldenCard keyword variant referenced by CardDef and writes its animated
material composite as the `-golden.png` input consumed by the TypeScript renderer.
The supported variants are frozen T09 fixtures; unsupported shader features fail
closed instead of silently producing an approximate portrait.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.3.11f1"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HS_DATA = Path("/Applications/Hearthstone/Data/OSX")


def ptr_dict(ptr: Any) -> dict[str, int]:
    if isinstance(ptr, dict):
        return {"m_FileID": int(ptr.get("m_FileID", 0)),
                "m_PathID": int(ptr.get("m_PathID", 0))}
    return {"m_FileID": int(getattr(ptr, "m_FileID", 0)),
            "m_PathID": int(getattr(ptr, "m_PathID", 0))}


def kv_entries(raw: Any) -> dict[str, Any]:
    """Unity serialized-property name/value pairs become a plain mapping."""
    result: dict[str, Any] = {}
    for entry in raw or []:
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            key, value = entry
            name = key[0] if isinstance(key, (list, tuple)) else key
            result[str(name)] = value
    return result


def read_asset(resolver: Any, ref: str) -> tuple[Any, str, dict[str, Any]]:
    resolved = resolver.resolve(ref)
    if not resolved.get("ok"):
        raise RuntimeError(f"asset reference failed: {ref}: {resolved.get('checks')}")
    bundle = resolved["resolved"]["bundle"]
    obj, _ = resolver.container_get(bundle, resolved["resolved"]["guid"])
    return obj, bundle, obj.read_typetree()


def carddef_fields(resolver: Any, card_id: str) -> dict[str, str]:
    ref = resolver.card_def_ref(card_id)
    if not ref:
        raise RuntimeError(f"cards_map has no {card_id}")
    root, bundle, tree = read_asset(resolver, ref)
    for pair in tree.get("m_Component") or []:
        component = pair.get("component") if isinstance(pair, dict) else getattr(pair, "component", None)
        ptr = ptr_dict(component)
        if not ptr["m_PathID"]:
            continue
        try:
            obj, _ = resolver.resolve_pptr(bundle, ptr, root)
        except Exception:
            continue
        if obj is None or obj.type.name != "MonoBehaviour":
            continue
        data = obj.read_typetree()
        if isinstance(data, dict) and "m_GoldenPortraitMaterialPath" in data:
            return {name: str(data.get(name) or "") for name in (
                "m_PortraitTexturePath", "m_GoldenPortraitTexturePath",
                "m_GoldenPortraitMaterialPath", "m_GoldenUberShaderAnimationPath")}
    raise RuntimeError(f"CardDef MonoBehaviour not found in {ref}")


def component(value: Any, key: str, default: float = 0.0) -> float:
    if isinstance(value, dict):
        return float(value.get(key, default))
    return float(default)


def vec4(value: Any, default: tuple[float, float, float, float] = (0, 0, 0, 0)) -> np.ndarray:
    if isinstance(value, dict):
        return np.array([component(value, k, default[i]) for i, k in enumerate("rgba")], dtype=np.float64)
    return np.array(default, dtype=np.float64)


def unity_curve(keys: list[dict[str, Any]], time: float, pre: int, post: int) -> float:
    if not keys:
        return 0.0
    first, last = float(keys[0]["time"]), float(keys[-1]["time"])
    span = last - first
    if span > 0 and time < first and pre == 1:
        time = first + ((time - first) % span)
    elif span > 0 and time > last and post == 1:
        time = first + ((time - first) % span)
    if time <= first:
        return float(keys[0]["value"])
    if time >= last:
        return float(keys[-1]["value"])
    for left, right in zip(keys, keys[1:]):
        if float(left["time"]) <= time <= float(right["time"]):
            dt = float(right["time"]) - float(left["time"])
            u = (time - float(left["time"])) / dt
            u2, u3 = u * u, u * u * u
            m0 = float(left.get("outSlope", 0.0)) * dt
            m1 = float(right.get("inSlope", 0.0)) * dt
            return ((2 * u3 - 3 * u2 + 1) * float(left["value"])
                    + (u3 - 2 * u2 + u) * m0
                    + (-2 * u3 + 3 * u2) * float(right["value"])
                    + (u3 - u2) * m1)
    return float(keys[-1]["value"])


def material_values(material: dict[str, Any]) -> tuple[dict[str, np.ndarray], dict[str, dict[str, Any]]]:
    saved = material.get("m_SavedProperties") or {}
    props: dict[str, np.ndarray] = {}
    for name, value in kv_entries(saved.get("m_Colors")).items():
        props[name] = vec4(value)
    for name, value in kv_entries(saved.get("m_Floats")).items():
        props[name] = np.array([float(value), 0.0, 0.0, 0.0], dtype=np.float64)
    texenvs: dict[str, dict[str, Any]] = {}
    for name, value in kv_entries(saved.get("m_TexEnvs")).items():
        if isinstance(value, dict):
            texenvs[name] = value
    main = texenvs.get("_MainTex", {})
    scale = main.get("m_Scale") or {}
    offset = main.get("m_Offset") or {}
    props["_MainTex_ST"] = np.array([
        component(scale, "x", 1), component(scale, "y", 1),
        component(offset, "x", 0), component(offset, "y", 0)], dtype=np.float64)
    return props, texenvs


def evaluate_animation(anim: dict[str, Any], props: dict[str, np.ndarray], phase: float) -> None:
    """Evaluate controller material writes at a frozen time (m_firstFrame semantics).

    TIME_EVENT_999 has no enabled random animations. Increment-only elements integrate
    their rates from 0; curve elements use Unity Hermite keys and the serialized wrap.
    """
    accum: dict[tuple[str, int], float] = {}
    for animation in anim.get("animations") or []:
        name = str(animation.get("materialPropertyName") or "")
        value = props.setdefault(name, np.zeros(4, dtype=np.float64)).copy()
        for element in animation.get("animationElement") or []:
            idx = int(element.get("element", 0))
            inc = bool(element.get("incrementingValue"))
            cur = 0.0 if inc else float(value[idx])
            curve = element.get("animationCurve") or {}
            nested = curve.get("animationCurve") or {}
            if curve.get("enabled"):
                cur = (unity_curve(nested.get("m_Curve") or [],
                                   phase * float(curve.get("speed", 1.0)),
                                   int(nested.get("m_PreInfinity") or 0),
                                   int(nested.get("m_PostInfinity") or 0))
                       + float(curve.get("offset", 0.0))) * float(curve.get("scale", 1.0))
            random_anim = element.get("randomAnimation") or {}
            if random_anim.get("enabled"):
                raise RuntimeError("TIME_EVENT_999 uses an enabled random animation; a fixed phase is not deterministic")
            if inc:
                rate = cur + float(element.get("incrementingSpeed", 0.0))
                accum[(name, idx)] = phase * rate
                cur = accum[(name, idx)]
            value[idx] = cur
        props[name] = value


def sample(texture: np.ndarray, u: np.ndarray, v: np.ndarray,
           wrap_u: int, wrap_v: int) -> np.ndarray:
    """Unity bilinear level-0 sampling with serialized per-axis texture wrapping."""
    h, w = texture.shape[:2]
    x = u * w - 0.5
    y = (1.0 - v) * h - 0.5
    if wrap_u == 0:  # TextureWrapMode.Repeat
        x = np.mod(x, w)
        # T09 phase fitting can put a coordinate a few ULPs below zero at a repeat
        # seam. NumPy may round that modulo result up to exactly `w`, which Unity's
        # sampler wraps but a NumPy array indexes out of range. The UberGoldenCard
        # Metal variants sample these repeated textures in xlatMtlMain; the probed
        # JAIL_321/JAIL_887 Texture2D settings serialize m_WrapU=0. Normalize only
        # the rounded upper seam back to zero, preserving the neighboring texel mix.
        x = np.where(x >= w, 0.0, x)
    else:
        x = np.clip(x, 0.0, w - 1.0)
    if wrap_v == 0:
        y = np.mod(y, h)
        y = np.where(y >= h, 0.0, y)
    else:
        y = np.clip(y, 0.0, h - 1.0)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    x1 = (x0 + 1) % w if wrap_u == 0 else np.minimum(x0 + 1, w - 1)
    y1 = (y0 + 1) % h if wrap_v == 0 else np.minimum(y0 + 1, h - 1)
    return (texture[y0, x0] * (1 - fx) * (1 - fy)
            + texture[y0, x1] * fx * (1 - fy)
            + texture[y1, x0] * (1 - fx) * fy
            + texture[y1, x1] * fx * fy)


def layer_uv(uv: np.ndarray, props: dict[str, np.ndarray], layer: int) -> np.ndarray:
    translate = props[f"_Layer{layer}_Translate"]
    rotate = props[f"_Layer{layer}_Rotate"]
    scale = props[f"_Layer{layer}_Scale"]
    theta = rotate[0] + rotate[1]
    c, s = np.cos(theta), np.sin(theta)
    pivot = rotate[2:4] - translate[0:2]
    scale_pivot = scale[2:4] - translate[0:2]
    delta = uv - pivot
    rotated = np.stack((delta[:, 0] * c + delta[:, 1] * s,
                        -delta[:, 0] * s + delta[:, 1] * c), axis=1)
    return translate[0:2] + translate[2:4] + ((pivot + rotated - scale_pivot) * scale[0:2] + scale_pivot)


def layer_uvs(uv: np.ndarray, props: dict[str, np.ndarray]) -> list[np.ndarray]:
    """UberGoldenCard VS TEXCOORD0/1/2 layer streams (VS variants, xlatMtlMain).

    Each later layer optionally inherits the previous transformed UV through
    `_Layers_Inherit_Transform`; this is the sequence emitted by the extracted
    Metal vertex shaders, not a same-origin shortcut.
    """
    inherit = props.get("_Layers_Inherit_Transform", np.zeros(4, dtype=np.float64))
    result: list[np.ndarray] = []
    previous = uv
    for layer in range(1, 6):
        source = uv if layer == 1 else uv + inherit[layer - 2] * (previous - uv)
        previous = layer_uv(source, props, layer)
        result.append(previous)
    return result


def mix_layer(acc: np.ndarray, texture_sample: np.ndarray, color: np.ndarray,
              blend: np.ndarray, weight: np.ndarray) -> np.ndarray:
    layer_color = texture_sample * (color[3] * color)
    t = np.clip(layer_color[:, 3] * blend[3], 0.0, 1.0)
    mixed = acc + t[:, None] * (layer_color - acc) if blend[3] > 0 else acc
    mixed = mixed + (layer_color * mixed) * blend[1]
    mixed = mixed + layer_color * blend[0]
    overlay = np.where(mixed < 0.5, 2.0 * mixed * layer_color,
                       1.0 - 2.0 * (1.0 - mixed) * (1.0 - layer_color))
    block = mixed + blend[2] * (overlay - mixed) if blend[2] > 0 else mixed
    return acc + weight[:, None] * (block - acc)


def compose(props: dict[str, np.ndarray], tex: dict[str, np.ndarray],
            wrap: dict[str, tuple[int, int]], flow_layers: set[int], max_layer: int) -> np.ndarray:
    """UberGoldenCard FS layer/distortion/mix chain for the frozen T09 variants.

    The layer order and distortion accumulation follow the extracted Metal
    `xlatMtlMain` fragments for TIME_EVENT_999, JAIL_321, JAIL_450, WW_0700,
    and JAIL_887. Flow-map UV remapping follows the corresponding
    `_LAYERn_FLOWMAP` branch; rotation flow-map variants are deliberately rejected.
    """
    main = tex["_MainTex"]
    height, width = main.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width]
    uv = np.stack(((xx.ravel() + 0.5) / width, 1.0 - (yy.ravel() + 0.5) / height), axis=1)
    st = props["_MainTex_ST"]
    uv *= st[:2]
    uv += st[2:]
    layer_coords = layer_uvs(uv, props)
    m = lambda name, coords: sample(tex[name], coords[:, 0], coords[:, 1], *wrap[name])

    mask = m("_MaskTex", uv)
    samples: dict[int, np.ndarray] = {}
    weights: dict[int, np.ndarray] = {}
    inherited_distortion = np.zeros((uv.shape[0], 2), dtype=np.float64)
    main_distortion = np.zeros_like(inherited_distortion)
    for layer in range(max_layer, 0, -1):
        name = f"_Layer{layer}"
        coords = layer_coords[layer - 1] + 0.001 * inherited_distortion
        if layer in flow_layers:
            flow = m(f"{name}_FlowTex", coords)
            ft, fs = props[f"{name}_FlowTranslate"], props[f"{name}_FlowScale"]
            pivot = fs[2:4] - ft[0:2]
            flow_uv = (flow[:, :2] - pivot) * fs[:2] + pivot + ft[2:4] + ft[0:2]
            layer_sample = m(f"{name}_Tex", flow_uv).copy()
            layer_sample[:, 3] *= flow[:, 2]
        else:
            layer_sample = m(f"{name}_Tex", coords)
        weight = np.minimum(mask @ props[f"{name}_Mask"], 1.0) * layer_sample[:, 3]
        samples[layer] = layer_sample
        weights[layer] = weight
        distortion = props[f"{name}_Distortion"]
        if layer == 1:
            main_distortion += weight[:, None] * layer_sample[:, :2] * distortion[:2]
        else:
            main_distortion += (weight ** 2)[:, None] * layer_sample[:, :2] * distortion[:2]
            # The extracted FS uses one power of w for Layer2's .zw displacement,
            # and w² for Layers3–5; this feeds the next lower layer's UV.
            z_weight = weight if layer == 2 else weight ** 2
            inherited_distortion += z_weight[:, None] * layer_sample[:, :2] * distortion[2:4]

    acc = m("_MainTex", uv + 0.001 * main_distortion)
    for layer in range(1, max_layer + 1):
        name = f"_Layer{layer}"
        acc = mix_layer(acc, samples[layer], props[f"{name}_Color"],
                        props[f"{name}_Blend"], weights[layer])
    return np.clip(acc, 0.0, 1.0).reshape(height, width, 4)


def resolve_material_textures(resolver: Any, bundle: str, material_obj: Any,
                              texenvs: dict[str, dict[str, Any]],
                             flow_layers: set[int], max_layer: int,
                             shader_tree: dict[str, Any]) -> tuple[dict[str, np.ndarray], dict[str, tuple[int, int]]]:
    used = ("_MainTex", "_MaskTex", *(f"_Layer{n}_Tex" for n in range(1, max_layer + 1)),
            *(f"_Layer{n}_FlowTex" for n in sorted(flow_layers)))
    textures: dict[str, np.ndarray] = {}
    wraps: dict[str, tuple[int, int]] = {}
    parsed = shader_tree.get("m_ParsedForm") or {}
    prop_info = parsed.get("m_PropInfo") or {}
    shader_props = {
        prop.get("m_Name"): prop
        for prop in prop_info.get("m_Props") or []
        if prop.get("m_Name")
    }
    for name in used:
        texenv = texenvs.get(name) or {}
        ptr = ptr_dict(texenv.get("m_Texture"))
        if not ptr["m_PathID"]:
            # Reno's WW_0700 PremiumCard material serializes a null _Layer3_Tex, but
            # UberGoldenCard samples it in the frozen `_LAYER4_FLOWMAP + _LAYER5`
            # Metal variant. Unity binds the ShaderLab property's serialized built-in
            # default (`m_ParsedForm.m_PropInfo._Layer3_Tex.m_DefTexture = clear`);
            # the offline compositor must do the same instead of failing or inventing
            # a layer. Probes: WW_0700_PremiumCard.mat has Layer3 pathID 0, and the
            # extracted shader variant samples `_Layer3_Tex` at xlatMtlMain:173.
            default_name = ((shader_props.get(name) or {}).get("m_DefTexture") or {}).get("m_DefaultName")
            if default_name == "clear":
                textures[name] = np.zeros((1, 1, 4), dtype=np.float64)
                wraps[name] = (0, 0)
                continue
            raise RuntimeError(f"material texenv {name} has no texture reference or supported shader default ({default_name!r})")
        obj, _ = resolver.resolve_pptr(bundle, ptr, material_obj)
        if obj is None or obj.type.name != "Texture2D":
            raise RuntimeError(f"material texenv {name} did not resolve to Texture2D")
        tree = obj.read_typetree()
        image = obj.read().image
        if image is None:
            raise RuntimeError(f"Texture2D {tree.get('m_Name')} has no decoded pixels")
        settings = tree.get("m_TextureSettings") or {}
        textures[name] = np.asarray(image.convert("RGBA"), dtype=np.float64) / 255.0
        wraps[name] = (int(settings.get("m_WrapU", tree.get("m_WrapMode", 0))),
                       int(settings.get("m_WrapV", tree.get("m_WrapMode", 0))))
    return textures, wraps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--card", default="TIME_EVENT_999")
    parser.add_argument("--phase", type=float, required=True,
                        help="UberShaderController m_time (seconds from its randomized start)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--game", default=str(HS_DATA))
    args = parser.parse_args()
    if not np.isfinite(args.phase) or args.phase < 0:
        parser.error("--phase must be a finite nonnegative time")

    sys.path.insert(0, str(HERE))
    from resolve_asset_ref import Resolver

    resolver = Resolver(Path(args.game))
    fields = carddef_fields(resolver, args.card)
    if not fields["m_GoldenPortraitMaterialPath"] or not fields["m_GoldenUberShaderAnimationPath"]:
        raise RuntimeError(f"{args.card} CardDef lacks premium material or animation")
    mat_obj, mat_bundle, material = read_asset(resolver, fields["m_GoldenPortraitMaterialPath"])
    _anim_obj, _anim_bundle, animation = read_asset(resolver, fields["m_GoldenUberShaderAnimationPath"])

    shader_obj, _ = resolver.resolve_pptr(mat_bundle, ptr_dict(material.get("m_Shader")), mat_obj)
    shader_tree = shader_obj.read_typetree() if shader_obj else {}
    parsed = shader_tree.get("m_ParsedForm") or {}
    shader_name = parsed.get("m_Name") or shader_tree.get("m_Name")
    # ShaderLab m_ParsedForm lists the shader's full keyword universe. The serialized
    # Material m_ValidKeywords field stores the selected variant used at runtime.
    keywords = set(material.get("m_ValidKeywords") or [])
    supported_variants = {
        "TIME_EVENT_999": {"_LAYER2_FLOWMAP", "_LAYER4"},
        "JAIL_321":      {"_LAYER4_FLOWMAP", "_LAYER5"},
        "JAIL_450":      {"_LAYER5"},
        "WW_0700":       {"_LAYER4_FLOWMAP", "_LAYER5"},
        "JAIL_887":      {"_LAYER1_FLOWMAP", "_LAYER3_FLOWMAP", "_LAYER4"},
    }
    expected_keywords = supported_variants.get(args.card)
    if shader_name != "Uber/UberGoldenCard" or expected_keywords is None or keywords != expected_keywords:
        raise RuntimeError(
            f"unsupported premium shader variant for {args.card}: {shader_name} {sorted(keywords)}")
    if any("FLOWMAP_ROTATION" in keyword or "DISTORTSELF" in keyword or "AS_MASK" in keyword
           for keyword in keywords):
        raise RuntimeError(f"unsupported UberGoldenCard feature for {args.card}: {sorted(keywords)}")
    max_layer = max(int(keyword.split("_")[1][5:]) for keyword in keywords)

    props, texenvs = material_values(material)
    flow_layers = {int(keyword.split("_")[1][5:])
                   for keyword in keywords if keyword.endswith("_FLOWMAP")}
    textures, wraps = resolve_material_textures(
        resolver, mat_bundle, mat_obj, texenvs, flow_layers, max_layer, shader_tree)

    # CardDef.GetPortraitTexturePath(GOLDEN, fallbackToLowerPremium: true) falls
    # back to m_PortraitTexturePath when the golden path is empty (CardDef.cs:384-420).
    # Actor/Portrait installs that resolved texture as UberGoldenCard._MainTex.
    portrait_ref = fields["m_GoldenPortraitTexturePath"] or fields["m_PortraitTexturePath"]
    if not portrait_ref:
        raise RuntimeError(f"{args.card} has no golden or lower-premium portrait texture")
    portrait_obj, _, _ = read_asset(resolver, portrait_ref)
    if portrait_obj.type.name != "Texture2D":
        raise RuntimeError(f"CardDef portrait ref is not Texture2D: {portrait_ref}")
    portrait_tree = portrait_obj.read_typetree()
    portrait_image = portrait_obj.read().image
    if portrait_image is None:
        raise RuntimeError(f"CardDef portrait texture has no decoded pixels: {portrait_ref}")
    textures["_MainTex"] = np.asarray(portrait_image.convert("RGBA"), dtype=np.float64) / 255.0
    portrait_settings = portrait_tree.get("m_TextureSettings") or {}
    wraps["_MainTex"] = (
        int(portrait_settings.get("m_WrapU", portrait_tree.get("m_WrapMode", 0))),
        int(portrait_settings.get("m_WrapV", portrait_tree.get("m_WrapMode", 0))))
    evaluate_animation(animation, props, args.phase)
    composite = compose(props, textures, wraps, flow_layers, max_layer)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.rint(composite * 255.0).astype(np.uint8), "RGBA").save(output)
    print(f"[ok] {args.card} phase={args.phase:.6f} shader={shader_name}"
          f" keywords={','.join(sorted(keywords))} size={composite.shape[1]}x{composite.shape[0]} -> {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
