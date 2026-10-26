# Signature_25 Glass Layer and Ordering Implementation Plan

> **For agentic workers:** Execute this ticket inline in the current task, as requested by the user. Track each completed step below.

**Goal:** Render RLK_706 with its Signature_25 frame, description/race plates, scrolling glass-mask layer, and game-correct PortraitFrame → Transluscent → text ordering.

**Architecture:** Register `hand-minion-sig1` as a native minion frame and keep its Signature_25-specific glass renderer in the existing frame raster pipeline. Render `Transluscent_Mesh` as a late transparent node after the portrait layer, test it against the frame depth buffer, and leave that depth buffer unchanged because the game shader has ZWrite Off. Translate only the forward pass selected by the game's RTT command collector.

**Tech Stack:** TypeScript, Bun, extracted Unity prefab/material data, Metal shader variants, fixture L2 comparison.

---

## Evidence and scope

- `assets/frames/hand-minion-sig1/frame_recon.json`, `RootObject/Mesh/Transluscent_Mesh`: enabled mesh, 323 triangles, Signature_25 Atlas + Glass Mask, `m_ValidKeywords=[]`, serialized scroll/mask/intensity values. `DescriptionBox_Mesh` and `RacePlate_Mesh` use the existing no-keyword UberCardBack path.
- The pass-aware shader dump is `explore/2026-10-26-signature25-glass-ordering/output/shader/Hero_Unlit_Unlit_Transparent2uvScrollMaskScroll_FS_nokw.metal` plus `_VS_nokw.metal`. The selected forward FS samples MaskTex channels Z/Y/X for alpha and MainTex RGB; the VS emits two UV streams. The source mesh has no UV1 vertex channel, and `scripts/extract_frame.py:289-293` packages `uv1=uv0` as its established fallback.
- The stale exporter cache FS is the `Glow` pass, not the selected forward pass. The actual Shader in `essential_base_global-shader-0.unity3d` has three passes. `RenderCommandLists.cs::AppendRenderCommands` selects `SRPDefaultUnlit`, `UniversalForward`, and `LightweightForward` only (lines 49–54, 187–204); `GlowPrePass` and `Glow` are excluded. Pass 0 uses SrcAlpha/OneMinusSrcAlpha, ZTest LEqual, ZWrite Off. Material `m_CustomRenderQueue=2999` places it in the transparent list.
- Ordering evidence: `RenderCommandLists.cs::SortRenderCommands` sorts sortingOrder before renderQueue (lines 70–76); `docs/signature-name-banner-investigation.md` records that frame 1 needs PortraitFrame before Transluscent so the latter restores the name-banner ends. The offline renderer controls ordering directly.
- Baseline: RLK_706 `mae_visible=91.9`; all new render/L2 outputs go under `explore/2026-10-26-signature25-glass-ordering/output/`.

## Files

- Modify `packages/renderer/src/plan.ts`: add the Signature_25 frame rule/native-card mapping and put its glass node in the late-node sequence.
- Modify `packages/renderer/src/types.ts`, `packages/renderer/src/render.ts`, and `packages/renderer/src/raster.ts`: represent ZWrite Off and implement the selected mask-scroll forward-pass formula using both UV channels.
- Modify `packages/renderer/src/render-card.ts`: let this late transparent pass test against the existing frame/portrait z-buffer without writing depth.
- Update `docs/findings/signature-frame-research-2026-10-25.md` and `.scratch/signature-frames/issues/07-signature25-glass-ordering.md` with measured L2, regression, shader, and ordering evidence. Keep the ticket open until user visual verification.

## Task 1: Register Signature_25 and establish its late draw slot

**Files:** `packages/renderer/src/plan.ts`, `packages/renderer/src/types.ts`, `packages/renderer/src/render-card.ts`

- [x] Add `hand-minion-sig1: [4]` to `SLOT_NATIVE_CARD_TYPES`.
- [x] Add the frame rule using the probed Signature_25 nodes: rarity `RarityGem_Mesh`, attack `Gem_Attack_Mesh`, health `Gem_Health_Mesh`, race `RacePlate_Mesh`, and roles `cost/name/desc/race/attack/health`.
- [x] For active SIGNATURE frame 1, append `Transluscent_Mesh` to `late_nodes` so it runs after the portrait layer and before gems/text.
- [x] Add `PlanSlot.write_depth?: boolean` (default true). Set it false for the Signature_25 glass material while retaining LEqual depth testing.
- [x] In `render-card.ts`, use the shared frame z-buffer for a late node that requires depth testing with `write_depth=false`; keep existing late-node behavior for all other nodes.
- [x] Add the four-part evidence comment citing the fallback symptom, frame registration/late ordering fix, game/offline renderer difference, and the prefab + decompiled source locations.

## Task 2: Translate the selected Signature_25 forward shader pass

**Files:** `packages/renderer/src/render.ts`, `packages/renderer/src/raster.ts`

- [x] Carry the shader's TEXCOORD0/TEXCOORD1 streams for `Transluscent_Mesh`; the source mesh has no UV1 channel, so the packaged `mesh.uv1` is the extractor's UV0 fallback.
- [x] Translate the VS at frozen `_Time.x=0`: apply `_MainTex_ST`, per-stream scales/offsets, and serialized scroll values to the UV0/UV1 mask/main coordinates.
- [x] Translate pass-0 FS: `alpha = MaskTex.z * _MaskModIntensity * MaskTex.y * MaskTex.x * _ModIntensity * vertexColor.a`; `rgb = MainTex.rgb * vertexColor.rgb`. Vertex color includes `_Intensity` and `_Color`; `_LightingBlend=0` makes its lighting multiplier unity for this material.
- [x] Alpha blend using the shader pass's SrcAlpha/OneMinusSrcAlpha state, keep LEqual depth testing, and do not write the z-buffer. Do not apply the stale Glow-pass output or unselected GlowPrePass.
- [x] Add a nearby rendering-evidence comment with shader pass selection (`RenderCommandLists.cs`), Metal functions/lines, material pass state, and the Sig25 probe path.
- [x] Run `bun run typecheck` and ESLint on the changed renderer files.

## Task 3: Measure parity and prepare visual review

**Files:** `explore/2026-10-26-signature25-glass-ordering/output/`, `docs/findings/signature-frame-research-2026-10-25.md`, `.scratch/signature-frames/issues/07-signature25-glass-ordering.md`

- [x] Render all 43 manifest fixtures into this experiment directory and compare L2 against `out/l2/summary.json` without overwriting prior outputs. L2 has 42 reference PNGs; `BG24_Reward_107` has no reference file.
- [x] Confirm RLK_706 improves from `mae_visible=91.865` to `50.765`; the other four SIGNATURE fixtures have no per-zone L2 regression.
- [x] Compare decoded RGBA buffers: only RLK_706 changes; the other 42 rendered fixtures, including all 38 non-premium fixtures, remain pixel-identical.
- [x] Generate per-card before/after and L2 heat views for RLK_706, record exact values/output paths, and open the comparison for user review.
- [x] Update the ticket and findings with evidence. Issue 07 remains open until the user confirms the image.
