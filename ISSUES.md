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

**N9 — RESOLVED at v0.1.1.** The `selfWrites` counter existed only to swallow
the watcher events our own writes caused. The state file is no longer watched,
and no longer written through `FileView` at all, so the counter and its
cumulative-stranding bug are both gone.

**N10 — RESOLVED at v0.1.2.** The throw needed an XHR callback outliving the
component that owned it. There are no XHR callbacks now: each feed is fetched by
a `curl` `Process` created as an `Instantiator` delegate, so a teardown destroys
the delegate, which kills the child and takes its handlers with it. Probed by
destroying `Service.qml` 250 ms into a poll and waiting six seconds — no throw.
The XHR path was observed throwing on 2026-08-26 and again on 2026-08-27.

**S2 — `nextDirection`'s stale-direction repair path is unreachable.**
`Model.js` justifies its `return dirs[0]` fallback as letting a state file with
a stale direction be corrected by clicking. The only way to hold a direction a
station does not serve is a terminal, and at a terminal the toggle is disabled
(`options.length > 1` is false). So the path cannot be reached from the UI.

*Suggested fix:* either enable the toggle when the current direction is not in
`options` (making the justification true), or drop the justification and keep
the fallback as plain defence.

**S7 — RESOLVED at v0.1.1.** `validStation` now tests
`Object.prototype.toString.call(e.routes) !== "[object Array]"` (`Service.qml:206`)
rather than accepting anything with a numeric `.length`. The fix shipped with the
state-file hardening; this entry was left open by oversight.

---

## Correctness, unreachable today

**S8 — RESOLVED at v0.1.5.** `Stations.search` yielded `NaN` on a non-finite
*station* coordinate: the F7 fix guarded the *origin* only, so a bad `lat`
reached `haversineKm` and `Model.distanceText` rendered the result as the
literal string `"NaN mi"`. Both ends now go through one `hasFiniteCoords`
rather than two copies of the same conjunction — the copies are what drifted.

**This entry was itself wrong** for as long as it stood, and the correction is
the point: it said such a row "sorts first". It does not. The comparator
reaches `a.distanceKm - b.distanceKm` whenever the two differ, and `NaN`
differs from everything including itself, so it returns `NaN`, which sorts
treat as 0 — the row pins wherever it started. Measured with a three-row table:
the bad row came back **second of three**, and the good rows around it came
back far-then-near instead of near-then-far. The damage was quieter than
advertised and strictly worse: not a misplaced row, a list that stops being
ordered.

It was never reachable from committed data — 0 of 496 rows are non-finite and
`scripts/build-stations.mjs` throws on one — so the fix moves the property from
holding by upstream accident to holding by construction.

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

**S4 — RESOLVED at v0.1.5.** "195 alerts filter down to 7" in
`CONTRIBUTING.md` did not reproduce. Re-measured at the fixture's own header
timestamp (1787689797): the 195 decode to **9 active**, of which 1 is amber and
none red. The line now states that, with the timestamp it was measured at, so
the next person can re-run it.

**S5 — RESOLVED at v0.1.5.** `build-stations.mjs`'s tolerance comment gave two
justifications and **both** were false of the data — this entry had only caught
one. It claimed a terminal has no label for the direction it does not serve:
0 of 496 rows have an empty `labelN` or `labelS`, and a terminal carries the
literal `"Last Stop"`, which is exactly what `Stations.directionsFor` filters
on. It also claimed a station in no complex has no complex id: all 496 carry
one, including the **410** that are alone in their complex. The fallbacks stay
— they are defence against a feed schema change — but the comment now says so
instead of citing gaps nobody observed.

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
| The state-file read does not assert `S_ISREG` on the descriptor | A shell cannot `fstat` a descriptor it does not hold, and `dd` exposes no regular-file `iflag`. Not load-bearing: a symlink fails with `ELOOP`, a FIFO cannot stall (`nonblock`), a directory fails with `EISDIR`, a socket with `ENXIO`, and any inode is bounded by the byte cap. A device node needs root to create. |
| `--max-filesize` is inert when the body length is unknown | curl documents the flag as having no effect on a response with no `Content-Length`. The MTA sends one (measured: 218575 bytes), and `absorbFeed` re-checks `byteLength` after the fact, so an unbounded body would be rejected before decoding rather than before allocation. Revisit if the MTA ever switches to chunked encoding. |

---

## Not defects, but worth knowing

- **One poll per monitor.** The bar instantiates a widget per bar surface, and a
  surface exists per monitor. Neither sibling plugin coordinates across
  instances either. See the README's Known limitations.
- **Distances are always miles.** The unit is a one-function change
  (`Model.distanceText`) plus a manifest schema entry, deliberately deferred.
- **A failed alerts poll no longer waits out the full interval.** RESOLVED at
  v0.1.3. The alerts timer ran at 300s and did not retry sooner on failure, so a
  shell started during an outage showed no alerts for up to five minutes after
  arrivals had already recovered on the next 30s/90s poll. It now retries at 30s
  and doubles back to the configured interval (`Fetch.retryDelaySec`), so a
  sustained outage settles at the normal cadence instead of spawning a doomed
  process every 30s forever. Measured with the interval set to 60s and the
  resolver failing: first poll at T+2ms, next at T+30003ms.
- **Alert severity comes from the MTA's Mercury extension**, not GTFS `effect`,
  which is populated on zero alerts in practice. See `CONTRIBUTING.md`.
