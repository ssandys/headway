# Known issues

Open items at v0.1.0, carried from the final review and the scoped re-review of
the fix wave. Every one was found by review rather than in use, and every one is
Minor — the six Important findings and twelve of the fourteen Minor ones were
fixed before this release.

Full reports live in `.superpowers/sdd/2026-08-25-headway/`:
`final-review-report.md` (692 lines) and `re-review-report.md` (641 lines).

Numbering is kept from those reports so the detail is findable.

---

## Behaviour

**N9 — `selfWrites` strands cumulatively.** `Service.qml`
`FileView.watchChanges` fires on our own `writeState()`, and `FileView.text()`
still returns the previous content when it does, so a counter absorbs one
watcher event per write. If a write fails, or coalesces, the counter never
drains — where the original boolean stranded once, this strands once per
un-consumed write, and each stranded count swallows one genuine external edit.
`onLoaded` is outside the guard entirely.

*Suggested fix:* replace the counter with a content comparison — remember the
exact string written and skip a reload whose text equals it. Not verifiable
outside the live shell, which is why it was not attempted blind.

*Impact:* nothing edits `headway.json` externally today, so the stranding costs
nothing in practice.

**S2 — `nextDirection`'s stale-direction repair path is unreachable.**
`Model.js` justifies its `return dirs[0]` fallback as letting a state file with
a stale direction be corrected by clicking. The only way to hold a direction a
station does not serve is a terminal, and at a terminal the toggle is disabled
(`options.length > 1` is false). So the path cannot be reached from the UI.

*Suggested fix:* either enable the toggle when the current direction is not in
`options` (making the justification true), or drop the justification and keep
the fallback as plain defence.

**S7 — `validStation` does not check that `routes` is an array.**
`Service.qml` tests `typeof e.routes.length === "number"`, which admits a string
and `{"length": 2}`. Neither throws downstream — `normalizeRoute` tolerates both
— but the comment claims an is-an-array check.

*Suggested fix:* `Object.prototype.toString.call(e.routes) === "[object Array]"`,
which works in both engines.

---

## Correctness, unreachable today

**S8 — `Stations.search` still yields `NaN` on a non-finite *station*
coordinate.** The F7 fix guarded the *origin* only. A table row with a bad `lat`
sorts first with `distanceKm: NaN`. Measured: 0 of 496 committed rows are
non-finite, and `scripts/build-stations.mjs` now throws on a non-finite
`gtfs_latitude`/`gtfs_longitude`, which closes the only route by which such a
row could be generated.

**S6 — `skipGroup` does not check that `END_GROUP`'s field number matches its
`START_GROUP`.** Protobuf requires the match. Being more permissive than the
spec, it can only mis-skip an already-malformed stream and can never reject a
valid one. Recorded so it is a decision rather than an oversight.

---

## Documentation

**S3 — RESOLVED at v0.1.0.** `preview.png` was recaptured on 2026-08-26 from
the released build installed as `ssandys.headway` v0.1.0 (commit `29e286c`,
`Panel.qml` byte-identical to source) rather than from the dev deployment, so
the header reads `Headway` and not `Headway (dev)`. It now shows the route
bullets on alert rows and the direction button on every saved row, both of which
the README describes.

**S4 — "195 alerts filter down to 7" in `AGENTS.md` is not reproducible.**
Measured at the fixture's own header timestamp (1787689797): **9** active, of
which **1** is amber or red. The surrounding figures were corrected; this one
was left.

*Suggested fix:* restate as "9 active, 1 amber/red at the fixture's timestamp",
or drop the number.

**S5 — `build-stations.mjs`'s tolerance comment is factually wrong.** It says "a
terminal has no label for the direction it does not serve". Measured: **0 of
496** rows have an empty `labelN` or `labelS` — a terminal carries the literal
string `"Last Stop"`, which is exactly what `Stations.directionsFor` filters on.
The tolerant branch is harmless; its justification is false.

---

## Deliberately not fixed

Raised, adjudicated, and left. Recorded so they are not reopened as discoveries.

| Item | Why it stands |
|---|---|
| `search` treats `limit === 0` as "no limit" | The only call site passes a literal `6`. Guard it if `limit` ever becomes user-supplied. |
| `readVarint` bounds-checks `bytes.length`, not the enclosing `end` | Damage is bounded to the malformed sub-message; a parent's position comes from its own length prefix, never from where the child walk stopped. Changing the signature would touch every caller. |
| Header-timestamp walk duplicated ~4 lines across two decoders | Four lines, two call sites. A shared helper would add an export to a file whose export list is the QML/node contract. |
| `feedsForRoutes` output order depends on `for…in` enumeration | Insertion order is spec-guaranteed for string keys in both engines, and the only consumer iterates without caring. |
| Unused `v` parameter in `decodeStopTimeUpdate` | House convention: every `visit` callback lists the prefix of the signature it uses. |

---

## Not defects, but worth knowing

- **One poll per monitor.** The bar instantiates a widget per bar surface, and a
  surface exists per monitor. Neither sibling plugin coordinates across
  instances either. See the README's Known limitations.
- **Distances are always miles.** The unit is a one-function change
  (`Model.distanceText`) plus a manifest schema entry, deliberately deferred.
- **Alert severity comes from the MTA's Mercury extension**, not GTFS `effect`,
  which is populated on zero alerts in practice. See `AGENTS.md`.
