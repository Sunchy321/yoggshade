# Signature_26 Frame and Rarity Gem Implementation Plan

> **For agentic workers:** Execute this ticket inline in the current task; the user asked to continue the next ticket. Track each completed step below.

**Goal:** Render WW_373 through its Signature_26 hand frame, including the rarity frame and the rarity gem's opaque scrolling body plus multiply shadow.

**Architecture:** Keep the existing premium frame resolver and renderer. Register frame 2 as a native minion frame in `plan.ts`, then give it the same tag-driven nodes and rarity-child selection already used by Evergreen frame 9. The renderer already consumes the extracted frame's two rarity submeshes and applies the shader-specific passes.

**Tech Stack:** TypeScript, Bun, extracted Unity prefab/material data, fixture L2 comparison.

---

## Evidence and scope

- `assets/frames/hand-minion-sig2/frame_recon.json` contains `RarityGem_Frame_Mesh` and four inactive rarity children. `RarityGem_Legendary_Mesh` has two material slots: `Signature_Evergreen_Rarity_Gem_Mat[Hero/Diffuse/DiffuseAlphaMaskScroller]` and `Signature_Evergreen_Shadow_Mat[Hero/Multiply/Multiply_AlphaFade]`.
- The first material serializes `_Intensity=0.7`, `_ScaleX/_ScaleY=6`, `_XSpeed=5`, `_YSpeed=0.3`; the second is the signature gem shadow. The renderer already supports the first shader as Blend One/Zero + ZWrite and the second shader as multiply.
- `ActorNames.GetSignatureActor` (`ActorNames.cs:885-923`) selects a hand prefab by `CARD.m_signatureFrameId`; `Actor.cs:4939-4959, 4992-5022` activates the rarity frame and the matching rarity child. The offline resolver requires a `FRAME_RULES` entry, which frame 2 currently lacks, so it falls back to the ordinary minion frame.
- Current `out/l2/summary.json` records WW_373 at `mae_visible=102.015` (`mae_nontext=97.166`). Treat this as the comparison starting point; write new render and L2 artifacts only under `explore/2026-10-26-signature26-frame-gem/output/`.

## Files

- Modify `packages/renderer/src/plan.ts`: register frame 2 as a native minion frame; define its rarity frame, stat gems, and text roles; preserve the existing signature rarity-child selection path.
- Update `.scratch/signature-frames/issues/05-signature26-frame-gem.md` with measured L2 and regression evidence and mark it done only after the required visual review.
- Update `docs/findings/signature-frame-research-2026-10-25.md` with the frame 2 result, source evidence, residuals, and output path.

## Task 1: Resolve frame 2 and select its live components

**Files:** `packages/renderer/src/plan.ts`

- [x] Add `'hand-minion-sig2': [4]` to `SLOT_NATIVE_CARD_TYPES` so missing attack/health tags use the same native minion zero-value behavior as the other implemented minion frame.
- [x] Add the following `FRAME_RULES` entry next to `hand-minion-sig9`, preserving exact Signature_26 component names and the four runtime rarity children:

```ts
'hand-minion-sig2': {
  elite:        [],
  rarity:       ['RarityGem_Frame_Mesh'],
  attack:       ['Gem_Attack'],
  health:       ['Gem_Health'],
  forcedHidden: [
    'RarityGem_Common_Mesh',
    'RarityGem_Rare_Mesh',
    'RarityGem_Epic_Mesh',
    'RarityGem_Legendary_Mesh',
  ],
  roles:        ['cost', 'name', 'desc', 'race', 'attack', 'health'],
},
```

- [x] Add a nearby four-part rendering-evidence comment citing the symptom/trigger (SIGNATURE `signatureFrameId=2` falls back), the fix (frame rule plus rarity selection), the offline/game behavior difference (`slotForFixture` rejects slots without rules while Actor selects SignatureHand by frame id), and the prefab/shader evidence listed above.
- [x] Run `bun run typecheck` and `bunx eslint packages/renderer/src/plan.ts --quiet`; both passed.

## Task 2: Measure L2 and protect unrelated fixtures

**Files:** `explore/2026-10-26-signature26-frame-gem/output/`, `docs/findings/signature-frame-research-2026-10-25.md`

- [x] Render the manifest's 43 fixtures into a new experiment directory:

```bash
EXP=explore/2026-10-26-signature26-frame-gem/output
mkdir -p "$EXP/fixtures"
for id in $(bun -e 'const m = require("./data/fixtures/manifest.json"); console.log(m.presets.map((p) => p.cardId).join("\n"));'); do
  bun packages/renderer/src/main.ts --card "$id" --out "$EXP/fixtures/$id.png"
done
bun packages/renderer/src/compare-reference.ts \
  --rendered "$EXP/fixtures" --out "$EXP/l2" --baseline out/l2/summary.json
```

- [x] Confirm WW_373 improves from `mae_visible=102.015`, including its `rarity_gem` zone; the L2 baseline gate reported no per-zone regressions across the 42 reference fixtures.
- [x] Compare decoded RGBA buffers for all 43 renders against the current `out/fixtures/` renders; only WW_373 changed (289,345 pixels).
- [x] Record exact before/after values, changed-pixel count, residual explanation, and output path in the findings document. Earlier `explore/**/output/` artifacts were not overwritten.

## Task 3: Prepare visual acceptance and close the ticket

**Files:** `.scratch/signature-frames/issues/05-signature26-frame-gem.md`

- [x] Open `explore/2026-10-26-signature26-frame-gem/output/l2/WW_373_side.png` and `WW_373_heat.png`; the Signature_26 frame is aligned and the Legendary gem shows its atlas body with multiply base shadow.
- [x] Add a ticket comment with L2, pixel-regression, typecheck, lint, and evidence-note results, then set `Status: done`.
- [x] Commit the finished change after the user's explicit request; record that visual consistency does not mean residuals are accepted.
