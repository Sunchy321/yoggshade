# T11 Remaining Signature Hand Frames Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task. The source issue is `.scratch/signature-frames/issues/11-remaining-signature-hand-frames.md`.

**Goal:** Add frame 11 (SC_754), frame 13 (TIME_446), and frame 14 (CATA_190h SIGNATURE) to the renderer and web form, with SC_400 as the ordinary multiclass hero benchmark.

**Architecture:** Reuse the signature-frame extraction and `signatureFrameId` selection path. Add one renderer slot per new frame, using prefab-derived visibility/text rules and the shader/material paths evidenced by UnityPy and the decompiled game sources. Use `SC_400/NORMAL` for the ordinary multiclass hero baseline and `CATA_190h/SIGNATURE` for frame 14; each user-facing fixture and reference uses its card ID without a premium suffix.

**Tech Stack:** TypeScript, Bun, UnityPy extraction scripts, Hearthstone DBF/prefab assets, PNG references, renderer L2.

---

## File map

- `scripts/extract_frame.py`: maps signature frame IDs 11/13/14 to named slots and extracts their hand prefabs.
- `packages/renderer/src/plan.ts`: maps frame IDs to slots, declares native card types, and defines component/text rules per extracted prefab.
- `packages/renderer/src/render.ts`, `packages/renderer/src/keys.ts`, and `packages/renderer/src/portrait.ts`: extend only where probe evidence shows a shader, texture-key, or portrait-channel path not covered by existing signature support.
- `data/fixture.md` and `scripts/extract_fixture_data.py`: register SC_400 as NORMAL, and SC_754, TIME_446 and CATA_190h as SIGNATURE presets.
- `scripts/render_fixtures.sh`: render the canonical preset fixtures directly.
- `apps/web/src/adapter.ts` and `packages/renderer/src/plan.ts`: make SIGNATURE available only for the newly supported native frame/type combinations.
- `docs/findings/signature-frame-research-2026-10-25.md`: record per-frame prefab, decompile, shader, and L2 evidence.
- `.scratch/signature-frames/issues/11-remaining-signature-hand-frames.md`: mark T11 acceptance items as they are completed.
- `reference/SC_400.png`, `reference/SC_754.png`, `reference/TIME_446.png`, and `reference/CATA_190h.png`: user-supplied 512×768 references; `CATA_190h.png` is now the SIGNATURE reference, while `SC_400.png` is the ordinary multiclass hero reference. Keep `reference/SC_004.png` and `reference/JAIL_887.png` unchanged.

### Task 1: Probe the three game prefabs and record source evidence

**Files:**
- Modify: `scripts/extract_frame.py`
- Create: `explore/2026-10-26-remaining-signature-frames/` probe outputs
- Modify: `docs/findings/signature-frame-research-2026-10-25.md`

- [x] Confirm the DBF `SIGNATURE_FRAME` records for IDs 11, 13, and 14, including `m_handActorPrefab`, against the current client bundle.
- [x] Probe each prefab's active hierarchy, mesh/submesh mapping, material shader, texture inputs, text-node paths, and portrait channels with UnityPy.
- [x] Follow the existing decompile cache for `ActorNames.GetSignatureActor`, `Actor.SetMaterialPremium`, `CardTextureLoader.LoadSignature`, and each newly observed component update path; record exact file and method locations.
- [x] Record only shader variants selected by the serialized material keywords and compare their Metal source with the already ported signature shader path.
- [x] Extend `SIG_SLOT_TO_FRAME` with `hand-hero-sig11: 11`, `hand-location-sig13: 13`, and `hand-hero-sig14: 14`; extract each slot with `scripts/extract_frame.py --slot <slot>`.
- [x] Write per-frame evidence and extraction provenance to the findings document before adding renderer rules.

### Task 2: Add fixture inputs

**Files:**
- Modify: `data/fixture.md`
- Modify: `scripts/extract_fixture_data.py`
- Modify: `scripts/render_fixtures.sh`
- Create from extraction: `data/fixtures/SC_400.json`, `data/fixtures/SC_754.json`, `data/fixtures/TIME_446.json`

- [x] Register SC_754 and TIME_446 in the presets table as SIGNATURE hand fixtures, retaining their DBF `signatureFrameId` values 11 and 13.
- [x] Register SC_400 as the NORMAL multiclass hero baseline; register CATA_190h itself as SIGNATURE and retain its DBF armor tag `292=12`.
- [x] Remove the benchmark-only alias path so extraction, rendering and web presets use the canonical card IDs.
- [x] Extract SC_400, SC_754 and TIME_446 portraits and confirm `CATA_190h-signature.png` remains available as the game's premium portrait asset.

### Task 3: Implement frame-specific renderer rules

**Files:**
- Modify: `packages/renderer/src/plan.ts`
- Modify only if the prefab evidence requires it: `packages/renderer/src/render.ts`, `packages/renderer/src/keys.ts`, `packages/renderer/src/portrait.ts`

- [x] Add `SIGNATURE_FRAME_TO_SLOT` entries for 11, 13, and 14 using the slot names from Task 1.
- [x] Add frame rules for hero signature Evergreen, location signature, and hero signature Deathwing using observed node paths, native card types, visibility, rarity/stat meshes, and text roles.
- [x] Reuse existing UberCardBack, signature portrait, text-gradient/divider, gem, and class-color paths where their serialized materials prove they match; add a new raster branch only for a measured shader/material difference.
- [x] Add code comments at each rendering change that state the visual behavior, triggering frame, offline/game pipeline difference, and specific prefab/decompile/Metal evidence.
- [x] Confirm `slotForFixture` selects the new slot only when premium is SIGNATURE and the matching `signatureFrameId` and native card type are present.

### Task 4: Enable matching web presets

**Files:**
- Modify if needed: `apps/web/src/adapter.ts`, `apps/web/src/shared.ts`
- Generated during build: `apps/web/src/asset-manifest.json`

- [x] Confirm the preset metadata reports SIGNATURE available for SC_754, TIME_446, and CATA_190h only after the corresponding slot manifest exists and the card type matches.
- [x] Keep blank DIY requests, DIAMOND, and mismatched card types rejected; expose SC_400 as NORMAL and CATA_190h as SIGNATURE.
- [x] Run the asset-key checker against the extracted slot manifests and build-generated asset manifest.

### Task 5: Run L2 and project acceptance checks

**Files:**
- Update: `docs/findings/signature-frame-research-2026-10-25.md`
- Update: `.scratch/signature-frames/issues/11-remaining-signature-hand-frames.md`

- [x] Render fixtures and run `bun run l2`; confirm SC_400, SC_754, TIME_446, and CATA_190h appear in the summary under their card IDs.
- [x] Inspect per-frame L2 heatmaps and side-by-side renders; attribute any remaining hotspots before changing raster rules.
- [x] Run `bun run typecheck`, `bun run lint`, `bun apps/web/scripts/check-parity.ts`, and `bun apps/web/scripts/check-asset-keys.ts`.
- [x] Record final L2 values, exact evidence links, and any measurable residual boundaries in the findings document.
- [x] Present the output/reference comparisons for user visual confirmation before marking T11 complete; user confirmed CATA_190h multiclass badge on 2026-10-27.
