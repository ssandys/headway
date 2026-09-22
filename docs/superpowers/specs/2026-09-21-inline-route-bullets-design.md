# Inline route bullets in alert text — Design

**Date:** 2026-09-21
**Status:** Implemented at `6cb506d`
**Issue:** [#6](https://github.com/ssandys/headway/issues/6) · **Branch:** `issue-6-alert-descriptions`

Alert text carries route ids as bracketed words. `v0.2.0` currently substitutes
circled Unicode glyphs for them — ⑥, Ⓐ — which is monochrome and cannot express
an express train at all. This replaces that, in the panel only, with the real
`RouteBullet` the row head already draws: a coloured disc for a local, a
diamond for an express.

## Why this is worth the layout it costs

Measured over `tests/fixtures/alerts.pb` before any of it was written: route ids
appear **1382 times** across headers and descriptions, against 242 icon
placeholders. 1363 of those have a circled form, so the shipped substitution
reaches 98.6% of them — and the 19 it cannot reach are exactly the ones a
bullet draws best: `[SIR]` ×10, `[6X]` ×5, `[7X]` ×4.

A throwaway spike (2026-09-21, not kept) rendered the real paragraph both ways
side by side. Findings:

- Colour reads clearly at caption size; the express diamond renders correctly.
- Baseline alignment is a non-issue — discs sit centred in the line box.
- A `Flow` of per-word items wraps like a paragraph.
- Three defects, all in the spike's throwaway tokenizer, all addressed below:
  punctuation attached to a token was eaten, blank lines collapsed, and a
  three-character label overflowed its disc.

That last one is **not** new. `SIR` is on 21 stations in `StationData.js`, so
`RouteBullet` draws an overflowing label in the station search and saved rows
today. Fixing it here fixes it everywhere.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where text is tokenized | `Model.js` | The layer map puts every decision worth testing in the pure modules. A regex inside a QML binding cannot be tested at all. |
| Run granularity | One run per **word** | A `Text` inside a `Flow` needs an explicit width to wrap, and CONTRIBUTING is explicit that `wrapMode` does not constrain one. Word-level runs let the `Flow` do the wrapping. |
| Where spacing lives | On each run, not `Flow.spacing` | Uniform spacing renders `[SIR],` as `SIR , see below`. The spike proved it by losing the comma entirely. |
| Blank lines | An explicit empty line, rendered as a spacer | An empty `Flow` collapses to zero height, which is how the spike lost the paragraph break before "Note:". |
| Multi-character bullets | Scale the label to fit the disc | Keeps one shape vocabulary — disc local, diamond express — and repairs the shipped overflow at its source. |
| Where the label size is computed | `Model.js`, not the QML | `RouteBullet` already takes its colour and text colour from `Model.js` "so they are unit-tested rather than hand-picked per call site". The size earns the same treatment. |
| When the description's runs are built | Behind a `Loader`, `active` while expanded | A 2000-character alert is roughly 330 words. They should exist while the row is open and not otherwise. |
| The bar tooltip | Keeps the circled glyphs | `Model.tooltipText` returns a **string**. A tooltip cannot hold QML items, so the substitution keeps its job there. |
| `RichText` with escaped upstream text | Rejected | It would reopen the markup surface `PlainText` closes by construction, guarded only by escaping being airtight — on text that genuinely contains `en-html` markup. And a coloured ⑥ is a green *ring*, not a filled disc with a white numeral, with no diamond available. |
| Desktop notifications | Unchanged | Already decided at `e5619cc`: `notify-send` hands text to a daemon whose font is not ours to choose. |

## The runs interface

The one new thing crossing `Model.js` → `Panel.qml`.

```
alertRuns(text) -> [line, line, ...]

line = []                        // a blank line
     | [run, run, ...]

run  = { t: "s", v: "<word>",     sp: <bool> }   // literal text
     | { t: "r", v: "<route id>", sp: <bool> }   // a route bullet
```

`sp` is true when a space precedes this run in the source. `Flow.spacing` is
`0` and each item supplies its own leading gap, so punctuation hugs the token
before it.

`"No [6] between Hunts Point Av"` becomes one line:

```
[ {t:"s", v:"No",      sp:false},
  {t:"r", v:"6",       sp:true},
  {t:"s", v:"between", sp:true},
  {t:"s", v:"Hunts",   sp:true}, ... ]
```

`"For the [SIR], see below."` keeps the comma against the bullet:

```
... {t:"r", v:"SIR", sp:true},
    {t:"s", v:",",   sp:false},
    {t:"s", v:"see", sp:true}, ...
```

### Tokenizer rules

1. Icon substitution (`ALERT_ICONS`) runs **first**, so glyphs ride inside
   ordinary text runs and never need a run type of their own.
2. Split on `\n`. An empty line yields `[]`.
3. Within a line, split on spaces. A gap of several spaces is one `sp`, not
   several empty runs.
4. A word that is exactly `[ID]`, where `ID` matches `^[A-Z0-9]{1,3}$`, becomes
   a route run.
5. A word that is `[ID]` plus trailing punctuation from `,.:;)?!` splits into a
   route run and a text run carrying the punctuation, with `sp:false`.
6. Leading punctuation from `("'` before `[ID]` splits the same way, in
   reverse: a text run carrying the punctuation, then the route run with
   `sp:false`. The set deliberately excludes `[` — stripping the opening
   bracket would leave `6]`, which is not a bracketed id, and every route in
   the feed would come back out as plain text.
7. Anything else is a text run, verbatim.
8. A route run carries the **feed's** id — `6X`, not `6`. `RouteBullet`
   normalizes for the label and decides disc versus diamond, exactly as it does
   at the row head.
9. A non-string, or an empty string, yields `[]`.

Rule 4 will bulletise any bracketed one-to-three-character token, including a
hypothetical footnote marker. Every such token in both sampled feeds is a route
id; if that stops being true it shows up as a bullet where prose was meant, not
as a crash.

### What replaces what

`Model.alertTextWithRouteGlyphs` stays, and stays exported, because
`alertDisplayText` still feeds `tooltipText`.

`alertsForDisplay` **adds** `headerRuns` and `descriptionRuns` and **changes
nothing else**. `headerText` and `descriptionText` keep going through
`alertDisplayText` exactly as they do today, fully substituted.

That is deliberate rather than tidy. Three variants of one string — raw,
icon-only, icon-and-glyph — is how a reader ends up unable to say which one a
surface shows. Keeping the plain strings exactly as they ship means the runs
are purely additive: if the `Flow` rendering has to be reverted, the delegate
falls back to a `Text` on a string that still reads correctly, and nothing
downstream has to change with it.

## Panel rendering

The alert delegate keeps its current shape — a `ColumnLayout` holding the
headline row and the description — and changes what draws the text.

- **Headline**: the single `Text` becomes a `Flow` over `headerRuns[0]`. The
  headline is one source line, so there is exactly one line array; the `Flow`
  wraps it across as many visual lines as it needs.
- **Description**: a `Column` of `Flow`s, one per line array, inside a `Loader`
  whose `active` follows `alertRow.expanded`.
- **A text run** is a `Text` with `textFormat: Text.PlainText`,
  `leftPadding: run.sp ? spaceWidth : 0`, at `Style.font.caption`.
- **A route run** is a `RouteBullet` with `routeId: run.v`,
  `diameter: Style.font.caption * 1.4`, `fontFamily: root.fontFamily`,
  `interactive: false` — wrapped in an `Item` of one line height so it centres
  against the words rather than setting the line's height.
- `spaceWidth` is measured once per delegate from a hidden `TextMetrics` on a
  single space at the same size, rather than guessed in pixels — and it is
  `TextMetrics.advanceWidth`, **not** `.width`. `.width` is the bounding rect,
  a space has no ink, so it measures exactly `0` and every word runs into the
  next. Found on the first deploy; confirmed with a headless probe asserting
  `width === 0 && advanceWidth > 0`.
- The text runs deliberately set no `font.family`. The alert `Text` they
  replace never set one either: alert prose renders in the default face rather
  than the bar's monospace, and setting it would restyle the panel while
  claiming only to add bullets.

The dimming rules are unchanged: `cls` still drives the headline's colour, and
the description stays at `0.75` opacity.

## `RouteBullet` label scaling

New in `Model.js`, unit-tested:

```js
function bulletLabelSize(diameter, label) { ... }
```

returning `min(0.62 * diameter, 0.8 * diameter / (0.6 * max(1, label.length)))`.

The `0.6` is the monospace advance ratio; `0.8 * diameter` is the usable chord
across a disc. The result:

| label | size | vs today |
|---|---|---|
| `6` | `0.62 d` | unchanged |
| `SI` | `0.62 d` | unchanged |
| `SIR` | `0.44 d` | fits, where today it overflows |

Single-character bullets — every bullet in the bar, the arrival rows and the
saved list — are unchanged to the pixel. That is deliberate: this is a repair
to a case nobody has looked at, not a restyle of the case everybody sees.

## Testing

**`Model.js`, under `node --test` and a headless `qml6` probe:**

- Each tokenizer rule above, including `[6X]`, `[SIR]`, `[6],`, `([6])`, a
  multi-space gap, a blank line, a trailing blank line, and a line that is only
  a route id.
- Icon substitution happening before tokenization, so a glyph lands inside a
  text run.
- **Round trip**: reassembling every run of every header and description in the
  committed fixture — value plus a space where `sp` — reproduces the icon-
  substituted input exactly. This is the test that proves no text is dropped,
  which is the failure the spike actually had.
- `bulletLabelSize` at lengths 1, 2 and 3, asserting length 1 is unchanged.
- Non-string and empty input.

**Live shell, because nothing else can see it:**

- A tap on the headline still expands the row, now that the headline is a
  `Flow` of items rather than one `Text`.
- Wrapping at the real panel width, including a hyphenated station name.
- `SIR` in the station search, which is the shipped defect this repairs.

## Risks

| Risk | Mitigation |
|---|---|
| The `TapHandler` stops receiving taps across a `Flow` of items | Children are `Text` and non-interactive `RouteBullet`s, neither of which accepts pointer events — `RouteBullet`'s own `MouseArea` is `enabled: false` and `visible: false` unless `interactive`. Verified in the live shell; if it fails, the handler moves to the delegate root. |
| Item count on a long alert | The 2000-character cap bounds it at roughly 330 words, and the `Loader` means they exist only while one row is open. |
| A word longer than the panel is wide cannot be broken by a `Flow` | Station names are hyphenated, not unbroken. If one is found, that text run gets an explicit width and its own `wrapMode`. |
| This lands on top of four commits already verified on this branch | Nothing here changes `Gtfs.js`, the cap, the language selection, or the icon substitution. The circled-glyph path stays whole and keeps serving the tooltip. |

## Out of scope

- The icon glyphs and their pad, which ship as they are.
- `tooltipText`, which keeps circled glyphs for the reason in the decisions
  table.
- The notification path.
- Any change to how alerts are decoded, filtered, ordered or classified.
