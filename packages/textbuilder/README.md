# @tcg-cards/hs-text-builder

Offline reconstruction of Hearthstone card text — a complete translation of the game client's
`CardTextBuilder` family (all 47 types). Feed it the card's static data (raw text +
textBuilderType + a GAME_TAG value table) and it produces the text exactly as shown in-game,
including `@` alternate-text segments, `{0}..{5}` placeholders, `$`/`#` bonus tokens, and
localized keyword / class / referenced-card names.

Translation source: game client decompilation (`CardTextBuilder.cs`, `TextUtils.cs`,
and all 42 builder subclasses).

[中文文档（README.zh-CN.md）](./README.zh-CN.md)

## Features

- **All 47 builder types**: `DEFAULT` through `SILVER_HAND_RECRUIT` (enum order = type value),
  each translating both the static (EntityDef) and the runtime (Entity) code path;
- **Zero runtime dependencies**: Node built-ins only; pure functions that never throw
  (internal errors fall back to the base static transform);
- **Embedded 14-language data**: keyword names (185 entries, from the KEYWORD_TEXT DBF table),
  class names (11), and GameStrings strings (70 keys × 14 languages — Jade Golem, Galakrond,
  Herald, Zilliax combos, Spellstone prefixes, …), so `keywordName` / `className` /
  `gameString` hit without any hooks;
- **DIY overrides**: every embedded data point has a matching hook; pass one and it wins.

## Install

```sh
npm install @tcg-cards/hs-text-builder
```

## Usage

```ts
import { resolveCardText, resolveEntityText } from '@tcg-cards/hs-text-builder';

// Static card face (collection/display) — matches in-game exported renders
const r = resolveCardText({
  builderType: 7,          // SCRIPT_DATA_NUM_1 (DBF m_cardTextBuilderType)
  cardId: 'BG30_802',
  text: 'Your next 2 <b>Refreshes</b> are helpful! <i>(@ left!)</i>',
  tags: { '2': 2 },        // GAME_TAG numeric keys (TAG_SCRIPT_DATA_NUM_1 = 2)
});
// r.text === 'Your next 2 <b>Refreshes</b> are helpful! <i>(2 left!)</i>'

// Runtime (Entity) path — spell damage bonuses, in-game tags, countdown remainders, …
resolveEntityText({
  builderType: 22,         // SPELL_DAMAGE_ONLY
  cardId: 'CS2_029',
  text: 'Deal $3 damage.',
  tags: {},
  bonuses: { damage: 2 },  // +2 spell damage → *5* (game-style highlight markers)
});
```

### Resolve directly from a card JSON document

```ts
import { resolveFixtureText } from '@tcg-cards/hs-text-builder';

const fixture = {
  textBuilderType: 28,     // MULTIPLE_ALT_TEXT_SCRIPT_DATA_NUMS
  textInHand: { enUS: 'When you have {1} Gold…<i>(Once per game.)</i>' },
  tags: { '3': 15 },
};
resolveFixtureText(fixture, 'enUS', 'BG32_MagicItem_350').text;
```

## API

| Function | Description |
|---|---|
| `resolveCardText(ctx, opts?)` | Static card face (EntityDef) path; `opts.lang` switches embedded data language (default `enUS`-capable, data is per-language) |
| `resolveEntityText(ctx, opts?)` | Runtime (Entity) path; `ctx.bonuses` / `ctx.runtime` carry in-game state |
| `resolveFixtureText(fixture, lang?, cardId?, opts?)` | Convenience wrapper taking a card JSON document |
| `builtinLookup(hooks, opts)` | Use the embedded default hooks standalone (compose custom lookup chains) |

### ResolveContext

| Field | Description |
|---|---|
| `builderType` | DBF `m_cardTextBuilderType` numeric value (see `CARD_TEXT_BUILDER_TYPES`) |
| `text` | DBF `TextInHand` raw string |
| `tags` | DBF CARD_TAG (GAME_TAG numeric key → value; missing tag = 0) |
| `cardId` | Card ID (needed by per-card branches such as GameplayString prefixes) |
| `bonuses?` | Runtime bonuses: `damage`/`healing`/`attack`/`armor` + doubling counts |
| `lookup?` | DIY override hooks (each key wins over the embedded data) |
| `runtime?` | Game state: `controllerTag` / `localPlayerTag` / `zone` / `recruitStats` / … |

### lookup hooks (DIY override points)

| Hook | Overrides | Purpose |
|---|---|---|
| `gameString(key)` | Embedded GameStrings (14 languages) | GALAKROND_ONCE, GAMEPLAY_HERALD_*, … |
| `keywordName(gameTag)` | Embedded keyword table (185) | Dynamic keywords, BG Zilliax module keywords |
| `className(classTag)` | Embedded class table (11) | Referenced class name |
| `cardName(dbfId)` / `entityName(dbfId)` | none (placeholder fallback) | Referenced card / entity names (needs a card DB) |
| `card(dbfId)` | none (empty-text fallback) | Module card text recursion (Zilliax / Zombeast) |
| `buildCardText(dbfId)` | none | Referenced card text recursion (EntityPower family) |
| `zilliaxModule(dbfId)` | Embedded functional-module table (8) | Zilliax Deluxe 3000 combo ids |
| `bgZilliaxKeyword(dbfId)` | Embedded base-minion table (6) | Battlegrounds Zilliax keywords |
| `gameplayStringPrefix(cardId)` | Embedded prefix table (10 spellstone families) | GameStrings per-card keys |
| `raceName(raceTag)` / `universalTemplate(cardId)` | none | Quest race names / v2 template system |

## Coverage

- **Static-exact**: every type whose card-face text is fully determined by
  text + type + tags matches the game (the offline-export path used by benchmark renders);
- **Runtime best-effort**: `resolveEntityText` supports bonuses / thresholds / countdowns /
  shopping-phase scaling per the decompiled semantics, with live data injected via `runtime`;
- **Known boundary**: names/texts of *other cards* (Zilliax modules, Zombeast, EntityPower
  recursion) require a card database via `lookup`; without one the package degrades the same
  way the game does (e.g. the "unknown creator" placeholder).

## Data provenance & license

- **Code**: MIT (see LICENSE);
- **Embedded data** (`data/gamestrings.json`; extraction script
  `scripts/extract_textbuilder_strings.py` in the source repository): text and tables from
  the Hearthstone client localization files and the KEYWORD_TEXT DBF table. Copyright
  Blizzard Entertainment; distributed with this library as fan-project convention for
  rendering reproduction only — evaluate separately before commercial redistribution.
  To ship without the embedded data, use `builtinLookup(hooks, { noBuiltinStrings: true })`
  or override via hooks.

## Development

```sh
bun install                     # repository workspace
bun test                        # package tests (47-type semantics + adversarial inputs)
npm run build                   # tsc → dist/ (ESM + d.ts)
npm publish                     # prepublishOnly runs tests + build automatically
```

This is a scoped package — first publish requires `npm publish --access public`
(already configured via `publishConfig` in package.json).
