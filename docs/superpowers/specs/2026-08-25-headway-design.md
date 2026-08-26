# Headway — Design

**Date:** 2026-08-25
**Status:** Approved for planning
**Plugin id:** `ssandys.headway` · **Repo:** `ssandys/headway`

Headway is an Omarchy shell bar widget showing minutes to the next train at
stations you've saved, with MTA service alerts for the lines you actually
ride. The name is the transit term for the interval between successive
trains — literally the number the widget puts in the bar.

It is the third plugin in this family, after `galley` (CUPS) and `colophon`
(Ollama), and it deviates from their architecture in exactly one way: it has
no external interpreter. See "Why there is no collector script."

## What the MVP does

- Shows a hat glyph and the minutes-to-next-train for one **active station**
  in the bar.
- Holds a short list of **saved stations**, each with its own route and
  direction filter — "Union Sq, the L, Brooklyn-bound". Clicking a station in
  the panel makes it active.
- Adds stations through an **in-panel search** whose empty state lists the
  closest stations first, using the location Omarchy already knows.
- Colors the bar glyph by **service alert severity** for the routes you ride,
  and lists the alert text in the panel.
- Notifies on a **new alert for a saved route**, and when the **feed goes
  stale or unreachable**.

## Decisions

Each of these was a fork with live alternatives; recording the reasoning so a
future reader doesn't reopen a closed question.

| Decision | Choice | Why |
|---|---|---|
| Services | Subway only | One feed format, one stop vocabulary, no credentials. Commuter rail would add track numbers as a first-class concern; bus would add an API key and a second protocol. |
| Watch model | Saved list, active one switchable in panel | Mirrors galley's click-a-printer-card-to-filter interaction. A single fixed station can't serve a commute. |
| Route scope | Per-station route **and** direction filter | At a seven-route interchange like Union Sq, "next train" without a filter is not a number anyone can plan around. |
| Bar face | Glyph + minutes badge | Holds the galley/colophon convention: severity is the glyph's color, the badge only ever carries a number. A colored route bullet would make color mean identity in one place and severity everywhere else. |
| Location | Omarchy's own fix, IP fallback | `~/.local/state/omarchy/settings/weather.json` already holds lat/lon on the target machine. Reuses a fix the user has already declared rather than inventing a second one. |
| Location scope | Setup convenience only | A desktop doesn't move. Location orders the picker and is then never consulted again — nothing on a timer, and the bar can't change out from under you. |
| Alerts | In MVP; drive glyph color and a panel list | The alerts feed is keyless and carries rider-readable text. It gives the glyph something real to encode; without it, color would only ever mean "feed broken". Severity comes from the Mercury extension, not GTFS `effect` — see "Alert severity". |
| Notifications | New route alert; feed stale/unreachable | Leave-now was considered and cut — it needs a per-station walking-time setting, which is scope the MVP doesn't need to carry. |
| Data layer | Pure QML/JS, no interpreter | See below. |
| Icon | `md-hat_fedora`, U+F0BA4 | Nerd Fonts has no derby or bowler; the fedora is the closest silhouette and the only hat that stays legible at 17px. |

### Why there is no collector script

`galley` and `colophon` both shell out to a stdlib-only Python collector that
prints one JSON snapshot. Headway does not, because a probe showed the QML
engine can do the whole job itself (see Verified findings 1 and 2).

Dropping the interpreter buys:

- **A one-command install, with no language runtime to obtain.**
  `python3` would have been free — `uwsm` pulls it in, so every Omarchy box
  has it — but Ruby, the preferred alternative, is not in `base` and would
  have cost a 17 MiB prerequisite plus live version skew (this machine
  carries both mise 3.3.6 and pacman 3.4.10).

  Stated precisely, because an earlier draft of this line claimed "no
  `omarchy pkg add` prerequisite of any kind" and that is false:
  `Service.qml` spawns `notify-send`, and `libnotify` is in neither `base`
  nor `base-devel`. It arrives as a dependency of other desktop software, so
  it is near-universal but not guaranteed, and both sibling plugins list it.
  What dropping the interpreter actually buys is narrower and still worth
  having: no language runtime, no version skew, no pip or npm packages, and
  no credential. A missing `notify-send` degrades gracefully — notifications
  silently do not appear, the widget is otherwise unaffected.
- **The death of trap #12.** With no Python/JS boundary there are no values
  hand-duplicated across languages to drift silently apart. `colophon`'s
  `tests/test_cross_language.py` shrinks here to a single manifest-versus-
  `Service.qml` defaults check that lives in the node suite.
- **No process-spawn latency** and no exposure to trap #10 (Quickshell's
  `Process` not emitting `exited()` on a failed spawn) for the data path.
  `Process` survives only for `notify-send`, where trap #10 still applies.

It costs the "run the collector directly" troubleshooting affordance that
both existing READMEs lean on. That is recovered by `scripts/collect.mjs`, a
small node CLI that imports **the same** `Gtfs.js` decoder and prints the
same snapshot — a shared code path rather than a parallel reimplementation,
which is strictly better than what it replaces.

## Verified findings

Everything below was checked live on the target machine on 2026-08-25, not
inferred. Claims not on this list are design intent and should be treated as
unverified until they aren't.

1. **QML fetches binary over HTTPS.** A `qml6` probe using
   `XMLHttpRequest` with `responseType = "arraybuffer"` retrieved 103,075
   bytes from the A/C/E feed; the first four bytes (`0a 47 0a 03`) matched
   what `curl` returned byte for byte.
2. **QML persists JSON.** `FileView.setText(JSON.stringify(...))` with
   `atomicWrites: true` is the shell's own idiom, used by
   `plugins/clipboard/Clipboard.qml`, `plugins/agents/Main.qml`,
   `plugins/notifications/Service.qml`, and `shell.qml` itself.
3. **Plugin settings are read-only.** `setting(name, fallback)` reads
   injected values in `Ui/BarWidget.qml`, `Ui/Panel.qml` and every first-party
   plugin service; no write-back API exists anywhere in
   `/usr/share/omarchy/shell/`. **This is load-bearing** — saved stations
   cannot live in `shell.json` and must have their own state file.
4. **All eight subway feeds answer 200 with no API key**, at
   `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F<feed>`.
   Sizes at time of check: `gtfs` 166,892 · `gtfs-bdfm` 173,809 ·
   `gtfs-nqrw` 111,817 · `gtfs-ace` 106,757 · `gtfs-jz` 28,563 ·
   `gtfs-l` 23,016 · `gtfs-g` 20,119 · `gtfs-si` 5,548. Total 636 KB.
5. **The alerts feed answers 200 with no API key**, in both JSON (996,144
   bytes) and protobuf (477,029 bytes) at
   `.../mtagtfsfeeds/camsys%2Fsubway-alerts[.json]`. The JSON carries 196
   entities with `informed_entity[].route_id` and rider-readable
   `header_text.translation[0].text`.
6. **Static GTFS is reachable** — `http://web.mta.info/developers/data/nyct/
   subway/google_transit.zip` redirects to
   `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip`, HTTP 200, 5.6 MB.
   It was used to *validate* the station model but is **not** a build
   dependency; see finding 17 for what replaced it.
7. **`String.fromCodePoint` works in QML's JS engine** and round-trips an
   astral codepoint (`length === 2`, `codePointAt(0) === 0xF0BA4`).
8. **A literal astral character does *not* survive the editing path.** The
   same probe embedded U+F0BA4 directly in the source and it came back
   `codePointAt(0) !== 0xF0BA4`. This is colophon trap #14 reproducing on
   demand, and it is why the glyph is constructed, never typed.
9. **No derby or bowler exists in Nerd Fonts.** An exhaustive glyph-name
   search of `FiraCodeNerdFont-Regular.ttf` (what `monospace` resolves to
   here) over `bowler|derby|tophat|beanie|beret|cap|helmet|headwear|porkpie|
   boater|trilby` found no candidate. `md-hat_fedora` (U+F0BA4) and
   `fae-hat` (U+E24E) are the only hats.
10. **`ruby` is not in `base` or `base-devel`** — 4.17 MiB download, 16.96
    MiB installed. `python` is pulled in by `uwsm`, so it is effectively
    guaranteed on every Omarchy install.
11. **Every feed's emitted `route_id` set was decoded directly.** Shuttles
    resolve as `GS`→`gtfs`, `H`→`gtfs-ace`, `FS`→`gtfs-bdfm`; Staten Island's
    id is `SI`. The decode also confirmed the field numbers in "Protobuf
    fields consumed" against live NYCT output.
12. **Express variants are distinct route ids, and feeds overlap.** `6X` and
    `7X` were observed in `gtfs`; one `F` trip was observed in `gtfs-g` as
    well as `gtfs-bdfm`. These drive the normalization and dedup rules above.
13. **`Alert.effect` and `Alert.cause` are set on 0 of 199 alerts.** Every
    alert instead carries the Mercury extension at field **1001**, whose
    sub-field **3** is the `alert_type` string. Sub-fields seen: 1, 2
    (varint timestamps), 3 (type), 4, 7 (varint), 8, 10 (repeated string).
14. **The alerts protobuf and JSON are equivalent in content.** 199 alerts
    each; all 199 matched by entity id had **byte-identical** `header_text`,
    and all 199 carried at least one `route_id`. The protobuf is 478,259
    bytes against the JSON's 998,576 — so the protobuf is chosen, halving
    the transfer and reusing the decoder already required for trip updates.
15. **14 distinct `alert_type` values in one capture, 144 of 199 prefixed
    `Planned - `.** See "Alert severity" for the full table and why that
    prefix is load-bearing.
16. **`stops.txt` is 1,488 rows: 496 parent stations and 992 children**, and
    every one of the 496 parents has exactly the children `{id+N, id+S}` —
    **496/496, no exceptions**. Child stop ids are therefore derivable and
    need not be stored.
17. **`data.ny.gov` resource `39hk-dx4f` returns exactly 496 rows that join
    1:1 to the GTFS parent stops** — 0 missing, 0 extra — with coordinates
    byte-identical to the GTFS (`max divergence 0.00e+0 deg`). It supplies
    `complex_id`, `daytime_routes`, `borough`, `line`, and both direction
    labels, which together remove the need for the GTFS zip,
    `transfers.txt`, and `stop_times.txt`.
18. **445 official complexes, of which 410 are a single station.** Only 35
    group more than one. A transfers-graph inference over `transfers.txt`
    independently produced 444, confirming the official ids rather than
    contradicting them.
19. **76 station names are shared by more than one station.** `86 St` is six
    separate stations in six *separate* complexes; `Canal St` six; `Fulton
    St` five; `125 St` four. Complexes do not resolve this — routes,
    borough and line do.
20. **`north_direction_label`/`south_direction_label` are populated on
    496/496 stations** and are rider-facing: `Uptown`/`Downtown` at Union
    Sq, `Manhattan`/`Outbound` at Bedford Av, `Manhattan`/`Last Stop` at
    Coney Island.

## Architecture

```
Gtfs.js       pure: protobuf wire decode -> { header, trips[], alerts[] }
Stations.js   pure: generated station table + haversine + name search
Model.js      pure: snapshot -> glyph, color, countdowns, labels, tooltip
Service.qml   non-visual: XHR, timers, FileView state, notify-send
Panel.qml     render only: binds to Service and to pure helpers
```

Data flows one direction, as in both predecessors. `Service.qml` fetches and
parses; `Panel.qml` binds to its properties and to the pure modules; nothing
downstream reaches back upstream.

**`Gtfs.js`, `Stations.js` and `Model.js` stay pure and QML-safe**, under the
same constraints `colophon`'s `AGENTS.md` records for `Model.js`: no I/O, no
QML imports, no state between calls, and top-level declarations only. They
are loaded by `Panel.qml`/`Service.qml` *and* by `node --test`, and the syntax
subset that satisfies both is the binding constraint. One deliberate
exception to the inherited ban list: `String.fromCodePoint` is used for the
bar glyph, verified working in QML (finding 7) and required by finding 8.

### Supporting scripts

| Path | When it runs | What it does |
|---|---|---|
| `scripts/build-stations.mjs` | By hand, rarely | Fetches `data.ny.gov/resource/39hk-dx4f.json` (276 KB) and generates `Stations.js`. Output is committed. No zip, no `stop_times.txt`. |
| `scripts/collect.mjs` | By hand, debugging | Imports `Gtfs.js`, prints the exact snapshot the panel sees. |
| `bin/test` | Every change | `jq` manifest validation, `qmllint` on every `*.qml`, `node --test`. |
| `bin/dev`, `bin/dev-watch` | Development | Copied **byte-identical** from galley, which is canonical. |

`bin/dev` and `bin/dev-watch` carry no plugin-specific literal — everything
comes from `manifest.json` at runtime. Fix them in `ssandys/galley` and
re-copy; never patch them here.

## Data sources

### Route → feed map

Only the feeds covering your saved routes are fetched. If you ride the L,
that is 23 KB rather than 636 KB — a 27× saving, and the reason this map
exists at all.

| Feed | Routes |
|---|---|
Verified by decoding every feed and collecting the `route_id`s each one
actually emits (finding 11), not from any document.

| Feed | Routes emitted |
|---|---|
| `nyct%2Fgtfs` | 1 2 3 4 5 6 **6X** 7 **7X** **GS** |
| `nyct%2Fgtfs-ace` | A C E **H** |
| `nyct%2Fgtfs-bdfm` | B D F M **FS** |
| `nyct%2Fgtfs-g` | G (+ F, see below) |
| `nyct%2Fgtfs-jz` | J Z |
| `nyct%2Fgtfs-nqrw` | N Q R W |
| `nyct%2Fgtfs-l` | L |
| `nyct%2Fgtfs-si` | SI |

All three shuttles are settled: `GS` (42 St) is in `gtfs`, `H` (Rockaway
Park) in `gtfs-ace`, `FS` (Franklin Av) in `gtfs-bdfm`. The Staten Island
route id is **`SI`**, not `SIR`.

**Express variants are separate route ids.** `6X` and `7X` appear alongside
`6` and `7`. A saved route of `6` matched literally would **silently drop
every express train** — a wrong answer that looks like a working widget.
Matching therefore normalizes a trailing `X` before comparing, and
`Stations.js`/`Model.js` keep the express flag only for display.

**Feeds do not partition cleanly.** An `F` trip was observed in the `gtfs-g`
feed as well as `gtfs-bdfm`. Any rider whose saved routes span both feeds
fetches both and can receive the same trip twice. **Trips are therefore
deduplicated by trip id across feeds before arrivals are computed** —
without it, duplicate rows appear in the panel for one real train.

`J` was observed without `Z`, and `W` without a sample, purely because
neither was running at capture time. Absence from a single capture is not
evidence a route is in a different feed.

### Protobuf fields consumed

The decoder is not a general protobuf implementation. It reads varints and
length-delimited fields, skips everything it doesn't recognise (including
the NYCT extensions), and extracts only:

```
FeedMessage.header          = 1   -> FeedHeader.timestamp = 3
FeedMessage.entity          = 2   -> FeedEntity
FeedEntity.trip_update      = 3
FeedEntity.alert            = 5
TripUpdate.trip             = 1   -> TripDescriptor.route_id = 5
TripUpdate.stop_time_update = 2
StopTimeUpdate.stop_id      = 4
StopTimeUpdate.arrival      = 2   -> StopTimeEvent.time = 2
StopTimeUpdate.departure    = 3   -> StopTimeEvent.time = 2
Alert.informed_entity       = 5   -> EntitySelector.route_id = 2
Alert.active_period         = 1   -> TimeRange.start = 1, .end = 2
Alert.header_text           = 10  -> TranslatedString.translation = 1 -> text = 1
Alert.<mercury ext>         = 1001 -> alert_type = 3 (string)
```

Note what is **absent**: `Alert.effect` (7) and `Alert.cause` (6) are set on
**zero** of 199 alerts (finding 13). Severity comes from the Mercury
extension instead — see "Alert severity".

Timestamps are POSIX seconds around 1.7e9, far inside the 2^53 range a JS
double represents exactly, so no bigint handling is required.

### Alert severity

Because GTFS `effect` is never populated, severity is derived from the
Mercury extension's `alert_type` string. The 14 values observed in one
capture, with counts:

| `alert_type` | n | Class |
|---|---|---|
| Planned - Stops Skipped | 61 | planned |
| Planned - Part Suspended | 46 | planned |
| Planned - Express to Local | 24 | planned |
| Boarding Change | 16 | info |
| Planned - Reroute | 11 | planned |
| Reduced Service | 10 | **amber** |
| Extra Service | 9 | info |
| Planned - Suspended | 7 | planned |
| Delays | 4 | **amber** |
| No Scheduled Service | 3 | **red** |
| Special Schedule | 3 | info |
| Planned - Extra Transfer | 2 | planned |
| Sunday Schedule | 2 | info |
| Station Notice | 1 | info |

**Planned engineering work must never colour the bar.** 151 of 195 alerts
carry the `Planned - ` prefix, much of it for weekends that have not
happened yet. An implementation that treats them as live disruption leaves
the glyph permanently lit, which is the same as having no severity signal at
all. Planned alerts are listed in the panel and never colour the bar.

Two separate mechanisms enforce that, and it is worth being precise about
which does the work — an earlier draft of this spec was not, and an
implementer caught it:

- **Exact-key matching does the heavy lifting.** `ALERT_RED` and
  `ALERT_AMBER` are keyed on whole strings, so no `Planned - …` value
  matches either one. Delete the prefix branch entirely and today's planned
  types still classify as `info`, leaving the glyph calm. Measured against
  the live fixture.
- **The prefix branch is defence, not the primary guard.** It is checked
  first, so it survives a future table edit that added a planned variant to
  either severity set, and it labels planned work distinctly from merely
  informational work.

The failure this protects against is **keyword matching**, which is the
natural first instinct — `/Suspend|No Scheduled/` over the raw type string.
Measured: that design classifies the L's currently-active
`Planned - Part Suspended` as **red**, a false "no service" alarm generated
entirely by scheduled weekend work. The exact-key table is what avoids it.

**`active_period` filtering is mandatory** for the same reason: a planned
alert is published well before it applies. An alert whose active period has
not started is not shown as current. The extension's `display_before_active`
(sub-field 7) says how far ahead the MTA intends it to surface, and is the
natural input if a "coming this weekend" section is ever added — it is not
in the MVP.

Classification lives in `Model.js` as a pure function of `alert_type`, with
an unrecognised value defaulting to **info** — new alert types appear
without warning, and the failure mode of a surprise value must be a quiet
panel row, never a red bar.

### Deriving the destination

The rider-facing label for a direction is the train's terminal — "Far
Rockaway–Mott Av", not "southbound".

The obvious route to that is joining `trip_id` against static `trips.txt`
for `trip_headsign`, but NYCT's realtime trip ids do not reliably match
static ones. Taking **the last stop in the trip's own `stop_time_update`
list** and resolving its name through `Stations.js` reaches the same answer
from data already in hand — no join, no second file to keep current, and no
dependence on an id correspondence that is known to be unreliable.

### Station data — stops, not complexes

**A station in Headway is a GTFS parent stop.** There are 496 of them, and
`Stations.js` is generated from exactly one source: the `MTA Subway Stations`
dataset at `https://data.ny.gov/resource/39hk-dx4f.json` (276 KB, 496 rows,
keyless). It joins 1:1 to the GTFS parent stops with zero missing and zero
extra rows, and its coordinates are byte-identical to the GTFS ones
(findings 16, 17).

That single source removes the static GTFS zip from the build entirely — no
5.6 MB download, no ZIP container parsing (which node has no built-in
support for), and no 35 MB `stop_times.txt` scan, because `daytime_routes`
already gives the routes per station.

Per station it yields: `gtfs_stop_id`, `stop_name`, `daytime_routes`,
`borough`, `line`, `complex_id`, `north_direction_label`,
`south_direction_label`, and coordinates.

**Stop ids are `<parent><direction>`** — `L08N`, `L08S` for parent `L08`.
All 496 parents have exactly the children `{id+N, id+S}`, with **no
exceptions** (finding 16), so child ids are derived rather than stored.
Saved stations store the parent id and `N`/`S`; matching a
`stop_time_update` compares against `parent + direction`.

### Why stations and not complexes

Complexes were the obvious candidate for the picker's unit, and the data
says they are the wrong one.

- **They barely apply.** 410 of the 445 official complexes are a single
  station. Only 35 group more than one (finding 18).
- **They don't solve the ambiguity they looked like they'd solve.** 76
  station names are shared by more than one station. `86 St` belongs to
  **six** stations — and all six are in *separate* complexes, spread across
  Manhattan and Brooklyn on the R, N, C/B, 1, 4/5/6 and Q (finding 19).
  Merging complexes leaves that collision completely untouched.
- **17 of the 35 multi-station complexes have members with different
  names** — `Times Sq-42 St` is one complex with `42 St-Port Authority Bus
  Terminal`, and `Park Place`, `Cortlandt St`, `World Trade Center` and
  `Chambers St` are all one complex. There is no honest single label for
  those, so presenting them merged would mean inventing one.

**Disambiguation comes from routes, borough and line instead**, which is
what actually distinguishes the six `86 St`s:

```
  626   4 5 6    M    Lexington Av
  121   1        M    Broadway - 7Av
  A20   C B      M    8th Av - Fulton St
  Q04   Q        M    Second Av
  N10   N        Bk   Sea Beach
  R44   R        Bk   4th Av
```

`complex_id` is still carried in `Stations.js`, for one job only: keeping
related stations adjacent in search results rather than scattered. It never
becomes the unit a user selects.

**This is where the nearby-sort stops being a convenience.** With six
identically-named stations in the list, distance is not a nicety — it is a
primary disambiguator, and the reason the location fix earns its place in
the MVP rather than being deferred.

### Direction labels

The MTA dataset carries `north_direction_label` and `south_direction_label`,
populated on **496 of 496** stations, and they are written the way a rider
thinks rather than the way a feed does (finding 20):

| Station | N | S |
|---|---|---|
| 14 St-Union Sq | Uptown | Downtown |
| Bedford Av (L) | Manhattan | Outbound |
| Coney Island-Stillwell Av | Manhattan | Last Stop |

So the direction picker offers "Manhattan" and "Outbound" for Bedford Av,
never "N" and "S". `Last Stop` additionally marks a terminal, where one
direction has no departures at all and should not be offered.

The stored value stays `N`/`S`, because that is what the feed matches on;
the label is presentation, resolved through `Stations.js`.

## State and settings

### Saved stations — `~/.local/state/omarchy/settings/headway.json`

Written by `Service.qml` through `FileView` with `atomicWrites: true`
(finding 2), and placed beside `weather.json` and `flight-radar.json` to
match the convention Omarchy already uses for this exact purpose.

```json
{
  "version": 1,
  "activeStationId": "L08",
  "stations": [
    { "stopId": "L08", "name": "Bedford Av", "routes": ["L"], "direction": "N" }
  ]
}
```

`stopId` is the **parent** id; the platform matched in the feed is
`stopId + direction`. `direction` is stored as `N`/`S` because that is what
the feed keys on — the rider-facing label ("Manhattan" for `L08` northbound)
is resolved through `Stations.js` at render time and deliberately not
persisted, so a label correction from the MTA doesn't strand saved state.

Only `stopId`, `routes` and `direction` are load-bearing. `name` is
denormalized purely so the panel can render something sensible if a station
id ever disappears from a regenerated `Stations.js`.

`version` is present from the first release so a later shape change has
something to migrate from.

### Widget settings — `manifest.json`

Read-only (finding 3), through the inherited `setting(key, fallback)` helper.

| Key | Type | Default | Range | Effect |
|---|---|---|---|---|
| `pollIntervalOpenSec` | integer | 30 | 10–120 | Trip-update poll cadence while the panel is open. |
| `pollIntervalIdleSec` | integer | 90 | 30–600 | Cadence while the panel is closed. |
| `alertsIntervalSec` | integer | 300 | 60–1800 | Alerts poll cadence. Alerts change on a human timescale. |
| `staleAfterSec` | integer | 180 | 60–900 | Age past which data is stale: glyph goes amber, and the stale notification may fire. |
| `trainsPerDirection` | integer | 3 | 1–6 | Arrivals listed per direction in the panel. |
| `notifyRouteAlert` | boolean | true | — | Notify on a new alert for a saved route. |
| `notifyFeedStale` | boolean | true | — | Notify when data goes stale or the feed is unreachable. |

Every default is duplicated as a `setting()` fallback in `Service.qml`, and
the node suite asserts the two agree — the surviving remnant of trap #12.

## The bar

Glyph plus a badge carrying minutes to the next train matching the active
station's route and direction filter.

| State | Glyph color | Badge |
|---|---|---|
| Normal | default bar foreground | minutes to next train |
| Active unplanned alert classed amber on a saved route | amber | minutes |
| Data stale past `staleAfterSec` | amber | last known minutes |
| Active unplanned alert classed red on the **active** route | red | minutes, or none |
| Feed unreachable | red | none |
| No trains scheduled | default | none |

The badge color never changes. Severity reaches the bar entirely through the
glyph, so a red glyph with a badge means "a train is coming, *and* something
is wrong" — the same contract galley and colophon both hold.

**The countdown ticks locally.** Arrival times are absolute epoch seconds, so
a 1-second display timer recomputes the number without refetching. The widget
reads as live while polling every 30–90 seconds. This is why a slow poll does
not produce a visibly laggy bar, and it is the single most important reason
the bandwidth numbers stay small.

Tooltip: `Bedford Av · L Manhattan-bound · 4, 11, 18 min`, replaced by the
alert headline when one is active on a saved route.

## The panel

- **Header** — active station name, its route/direction filter, data age.
- **Arrivals** — up to `trainsPerDirection` per direction, each row a route
  bullet, the destination (from the trip's terminal), and a countdown.
- **Alerts** — filtered to saved routes, showing `header_text`, grouped by
  route. Absent entirely when there are none.
- **Stations** — the saved list; click to activate, `✕` to remove.
- **Search** — a text field filtering all 496 stations by name. Its empty
  state lists the nearest first, by haversine distance from the Omarchy
  location. Selecting one opens a route/direction choice, then saves it
  **and makes it active** — amended after live use. Saving without activating
  left the panel on the previously active station, so the click read as dead
  and took a second one on the saved row to finish the job. Picking a station
  AND a direction is an unambiguous choice; the saved list remains the way to
  switch between stations already added.

  **Every result row must carry its routes, borough and line**, because 76
  names are ambiguous and six of them read exactly `86 St` (finding 19). A
  row showing only a name is not a choice a user can make correctly. Rows
  sharing a `complex_id` sort adjacently. Direction is offered by label —
  "Manhattan" / "Outbound" — and a direction labelled `Last Stop` is not
  offered at all, since a terminal has no departures that way.

Keys follow the house pattern: `r` refreshes, `Esc` clears the search if it
has focus and closes the panel otherwise.

**Two inherited QML traps apply directly to the search field.** Colophon's
trap #32: Qt does not clear `activeFocus` when an item is hidden, so the
field must release focus in its own `onVisibleChanged` or `PanelKeyCatcher`
will steal `r` and `Esc`. Colophon's trap #35: typing does not break a QML
binding, so the query must route through `onTextEdited` into the state the
binding reads from, never by assigning `text`.

## Notifications

Sent through a `Process` running `notify-send`, carrying the single-pending-
slot pattern from colophon's `Service.qml` rather than a queue — and subject
to trap #10, which is why the handler must implement `onRunningChanged` and
not only `onExited`.

- **New alert on a saved route.** Fires on transition into an alert, keyed by
  alert id, never re-firing for an alert already seen. Needs hysteresis in
  the same spirit as galley's supply-low rule so an alert that flaps cannot
  nag once per poll.
- **Feed stale or unreachable.** Fires once on entering the stale state and
  once on recovery, not per poll.

Diff state lives in `Service.qml`, not in the pure modules — trap #13: the
pure layer holds nothing between calls, so anything needing memory across
polls belongs to the caller.

## Testing

`bin/test` runs `jq` manifest validation, `qmllint` on every `*.qml`, and
`node --test`.

A green run proves the QML **parses** and nothing more. `qmllint` cannot
resolve `qs.Ui`, `qs.Commons`, or `WidgetButton`, so an unknown component or
a typo'd property passes silently. QML correctness is verified by hand
against the live shell, or by a headless `qml6` probe — never `qml`, which is
Qt 5.15 and dies on versionless imports (colophon trap #33).

Node suites:

- **`Gtfs.js`** — decoded against committed `.pb` fixtures captured from the
  live feeds. Cases: a normal feed, a trip with no `departure`, a truncated
  buffer, an unknown field that must be skipped, an empty entity list, and
  the Mercury extension at field 1001 decoding to an `alert_type`.
- **`Stations.js`** — haversine ordering, name search, parent/direction id
  composition, and: a search for `86 St` returns six rows distinguishable by
  routes/borough/line; rows sharing a `complex_id` sort adjacently; a
  `Last Stop` direction is not offered.
- **`Model.js`** — countdown formatting, glyph and color selection per state
  in the bar table above, tooltip text, stale classification.
- **Regression guards for findings 12 and 13**, each of which is a bug that
  would otherwise ship looking like working software:
  - a saved route of `6` matches a `6X` trip (express normalization);
  - the same trip id present in two feeds yields **one** arrival row;
  - every `Planned - ` type leaves the glyph its default color;
  - `Delays` ambers it and `No Scheduled Service` reddens it;
  - an `alert_type` string not in the table classifies as info, not as an
    error and not as red;
  - an alert whose `active_period` has not begun is not counted as current.
- **Guards** — `BAR_GLYPH.codePointAt(0) === 0xF0BA4` (finding 8, and a
  codepoint assertion rather than a shape check, per colophon trap #14); the
  manifest-versus-`Service.qml` defaults check.

Fixtures are captured `.pb` bytes, so the decoder is tested against real
NYCT output including its extension fields rather than against a synthetic
encoder that would share the decoder's own assumptions.

## Out of scope

Deliberately deferred, not forgotten. If you reach for one of these while
fixing a bug, the bug has probably been misdiagnosed as a missing feature.

1. **Leave-now notifications.** Needs a per-station walking time. The most
   likely first addition, and the one that would make the widget actively
   useful rather than merely informative.
2. **LIRR, Metro-North, and bus.** Bus additionally needs an API key.
3. **Train positions / a map.** The vehicle positions are in the same feeds.
4. **Trip planning** between two saved stations.
5. **Filtering by express versus local.** The MVP must *recognise* `6X`/`7X`
   so express trains aren't silently dropped (finding 12), and may mark them
   in the panel — but choosing to see only expresses is not an MVP control.
6. **A station's full timetable**, as opposed to the next few arrivals.
7. **Alert `description_text`**, the long form. The MVP shows `header_text`.

## Open questions

To settle during implementation, each with a stated fallback so none of them
blocks progress:

1. **Qt `XMLHttpRequest` timeout support.** Qt's XHR has historically not
   honoured the `timeout` property. Fallback: an explicit `Timer` that calls
   `abort()`, which is needed for the unreachable-feed path regardless.
2. **IP geolocation provider** for the location fallback. Must be keyless
   **and** HTTPS — `ip-api.com`'s free tier is HTTP-only, which disqualifies
   it. Fallback: no IP lookup at all, and the picker sorts alphabetically
   when `weather.json` is absent. Note this path never runs on the target
   machine, whose `weather.json` already carries coordinates.
3. **Whether `39hk-dx4f` needs a Socrata app token** for the build script's
   anonymous request under sustained use. It answered fine unauthenticated;
   the script runs rarely enough that throttling is unlikely to bite.
   Fallback: derive the same table from the GTFS zip, which needs ZIP
   parsing node lacks built in — the reason it isn't the primary source.

Three of the original five questions were settled on 2026-08-25 by decoding
live data rather than by argument: shuttle feed assignments (finding 11),
the alerts format (finding 14), and complexes versus stops (findings 16–20).

**Every one of those investigations found a defect in this spec's first
draft** — the express route ids, the cross-feed trip duplication, the
never-populated `effect` field, and a station model built on the wrong
unit. That is a 3-for-3 hit rate on "settle it against real data before
planning," and the reason the remaining questions carry explicit fallbacks
rather than assumptions.
