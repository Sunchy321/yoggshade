# AGENTS.md

## Project

TypeScript offline Hearthstone card renderer. This repo replicates in-game Hearthstone card rendering pixel-for-pixel behind renderer protocol v1 (`POST /render` / `GET /status`) with zero game and zero Python at runtime; the final runtime target is Cloudflare Workers. The Angelia workspace hosts the Python reference chain consulted for behavior arbitration. Unpacked image assets come from the unpack scripts in `scripts/`; renderer inputs are versioned under `assets/` (asset pack root).

## Prime Directive

The highest-priority product requirement is exact 1:1 reproduction of the in-game card rendering. Any architecture, asset pipeline, text layout, or rendering change must optimize for visual parity, verified by pixel diff — prefer higher fidelity over lower engineering cost. When a tradeoff is necessary, fidelity wins.

## Hard behavioral rules

**NEVER make design decisions on your own. Always ask the user before deciding.**

**NEVER revert design decisions previously made without the user's explicit request.**

**NEVER commit on your own unless the user explicitly instructs you to commit.**

Never delete a document the user created (`CONTEXT.md`, `docs/adr/`, everything under `docs/`).

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles are used as-is: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Delivery Workflow

Route work through the engineering skills instead of inventing a process:

- **A small, self-contained change** — just implement it. No spec, no tickets.
- **Anything bigger** — `/grill-with-docs` to sharpen the idea, `/to-spec` to record it, `/to-tickets` to split it into tracer-bullet tickets, then `/implement` one ticket at a time.
- **A hard bug** — `/diagnosing-bugs`. **Incoming bug reports and feature requests** — `/triage`. **An effort too big or too foggy to hold in one session** — `/wayfinder`.

Design decisions belong to the user. Never settle one yourself; ask.

Specs and tickets are working artifacts of the issue tracker and are written in Simplified Chinese. Long-term memory is `CONTEXT.md` (a glossary, never implementation details) and `docs/adr/` (decisions that are hard to reverse and involved a real trade-off, e.g. ADR-0001 fixture-frozen benchmark data). Both are committed.

Work tickets from the tracker, and mark a ticket done as soon as it is done.

## Evidence-Based Fixing Rule

All rendering modifications MUST be grounded in evidence from these sources:

- UnityPy-probed original asset structure (prefab hierarchy, material assignments, texture formats)
- Decompiled rendering source (ilspy caches and investigation notes accumulated under the workspace research materials)
- Decompiled shader source (Metal shaders extracted from game shader bundles)
- Pixel evidence: L2 diff against in-game-rendered fixture benchmarks; behavioral arbitration against the Angelia py reference chain

Before writing any fix, cite specific decompiled code locations (file + line/function name) or diff numbers, and explain how they prove the fix targets the correct root cause. "Try this and see" patches are forbidden unless the user explicitly permits exploration.

The goal is to reproduce the in-game rendering, not to paper over visual differences with post-processing kludges.

## Rendering Bug Fix Workflow

Before committing a change classified as a rendering bug fix:

1. **Understand the root cause first** — study the decompiled pipeline, shaders, probed asset data, and the L2 diff to locate the pipeline stage where divergence occurs.
2. **Isolate faulty components** — when the root cause is unclear, isolate layers (e.g. `DEBUG_LAYER=<role>`, `supersample=1`, single-glyph A/B) to attribute the artifact before fixing.
3. **Clean up** — remove debug hooks and superseded fallbacks; keep only the minimal change.
4. **User verification** — ask the user to verify visually. Do not assume a fix is correct without confirmation.
5. **Iterate** — if the user reports the fix doesn't work, analyze the root cause, revert or adjust, and go back to step 1.
6. **Document with comments** — once verified, add a comment block at every code change covering: (1) what visual issue was fixed and when it triggers, (2) how it was fixed, (3) why the offline chain differs from the in-game rendering making the fix necessary, (4) decompiled locations / probed asset paths proving the root cause.
7. **Detailed commit message** — the commit body must include items (1)–(3) from step 6.

## Verification and baselines

- **L2** = in-game-rendered benchmark images for the frozen fixture set (`data/fixture.md`, ADR-0001). The fixture set is the acceptance anchor: acceptance for ported behavior = L2 diff against the in-game image for the same request (`bun run l2`).
- **Angelia** = the Python reference chain workspace, consulted for behavior arbitration and as the porting reference. It is not a sync target: TS-side changes do not need mirroring into it.
- **Baseline artifacts are provenance.** Never overwrite a previous render/diff under `explore/**/output/`; comparisons are written into the current experiment's own output. Quote baseline numbers from findings docs (committed), not from mutable files.
- Parity invariants discovered the hard way live in code comments (`packages/renderer/src/resize.ts` Pillow 8bpc semantics, `packages/renderer/src/glyph.ts` outline shader units, `packages/renderer/src/font.ts` FreeType getmask2 semantics). When you fight a parity battle, leave the evidence where the next person will look.

## Workspace layout

Bun workspaces monorepo: renderer and web app are separate packages; shared frozen data, extraction tools and the unpacked asset pack live at the root.

- `packages/renderer/` — tracked TS renderer (`bun`, `tsc` strict). CLI: `bun run render` / `bun run fixtures` from the repo root; asset pack and frozen-data paths are injectable via `--pack`/`--data` or `YOGGRAPH_PACK`/`YOGGRAPH_DATA` (defaults: `assets`, `data`, relative to CWD).
- `apps/web/` — card-site package (skeleton; framework TBD). Consumes the renderer as `@yoggraph/renderer` (workspace dependency) or over protocol v1 as a separate Worker.
- `scripts/` — tracked long-term extraction tools (uv + PEP 723 headers, `uv run scripts/<tool>.py`).
- `data/` — tracked frozen data (e.g. `data/fixtures/`); `data/fixture.md` is the single editing point for fixture membership.
- `assets/` — unpacked asset pack (gitignored, reproducible via scripts); raw Blizzard assets never leave this boundary into any distribution path.
- `explore/` — gitignored experiments. Game install at `/Applications/Hearthstone` is read-only; extraction scripts must never write into it.
- Cross-package imports use the package name (`@yoggraph/renderer/...`), never a relative path into another package's source.

## Decompile and extract discipline

- Cache ilspycmd decompilation output under the workspace decompile cache and search the cached files instead of re-decompiling the same assemblies.
- Knowledge learned from decompilation and asset unpacking must be recorded in separate Markdown notes — not kept only in chat or code comments.
- Long-term helpers belong in `scripts/`; experiment scripts stay self-contained inside their experiment directory.

## Commit Messages

Use Conventional Commits for all commit messages: `type(scope): subject`.

- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`
- `fix` commits must describe the problem that was solved, not how it was fixed. State what was broken and why it mattered.
- Keep commit messages to a single line by default. Rendering bug fixes are the exception: their bodies must carry the root cause, the fix, and the parity evidence (see Rendering Bug Fix Workflow).
- Use the most specific reasonable scope (`renderer`, `resize`, `fixtures`, `scripts`) instead of broad generic ones, matching repository history.
- When the user asks to commit, create the commit directly without waiting for confirmation of the message, then show the message after the commit is created.
