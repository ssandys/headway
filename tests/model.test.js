// tests/model.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const Model = require("../Model.js")

const NOW = 1787682000

const trip = (tripId, routeId, stops) => ({ tripId, routeId, stops })
const stop = (stopId, offsetSec) => ({ stopId, time: NOW + offsetSec })

test("dedupeTrips merges lists from several feeds", () => {
  const a = [trip("t1", "F", [])]
  const b = [trip("t2", "G", [])]
  assert.equal(Model.dedupeTrips([a, b]).length, 2)
})

test("dedupeTrips drops a trip appearing in two feeds", () => {
  const shared = trip("F-shared", "F", [stop("F20N", 300)])
  assert.equal(Model.dedupeTrips([[shared], [shared]]).length, 1)
})

test("dedupeTrips keeps distinct trips with the same route", () => {
  const a = trip("t1", "F", [])
  const b = trip("t2", "F", [])
  assert.equal(Model.dedupeTrips([[a, b]]).length, 2)
})

test("dedupeTrips does not collapse distinct trips that lack a trip id", () => {
  // Every real trip carries a tripId, so this is the fallback path. It must
  // keep both: two different id-less trips on the same route, each first in
  // its own feed, would collide on a key of routeId+index alone and one real
  // train would vanish from the arrivals list.
  const a = trip("", "F", [stop("F20N", 300)])
  const b = trip("", "F", [stop("F21N", 600)])
  const out = Model.dedupeTrips([[a], [b]])
  assert.equal(out.length, 2, "a missing dedup key must never discard a trip")
  assert.deepEqual(out.map((t) => t.stops[0].stopId), ["F20N", "F21N"])
})

test("arrivalsFor returns trains at the saved platform, soonest first", () => {
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [
    trip("late", "L", [stop("L08N", 600)]),
    trip("soon", "L", [stop("L08N", 120)]),
  ]
  const out = Model.arrivalsFor(saved, trips, NOW)
  assert.deepEqual(out.map((a) => a.etaSec), [120, 600])
})

test("arrivalsFor ignores the opposite direction", () => {
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [trip("wrong-way", "L", [stop("L08S", 120)])]
  assert.deepEqual(Model.arrivalsFor(saved, trips, NOW), [])
})

test("arrivalsFor ignores routes the rider did not save", () => {
  const saved = { stopId: "635", routes: ["6"], direction: "N" }
  const trips = [trip("a4", "4", [stop("635N", 120)])]
  assert.deepEqual(Model.arrivalsFor(saved, trips, NOW), [])
})

test("arrivalsFor MATCHES an express train against the plain route", () => {
  // The regression that would otherwise ship silently: saving "6" must not
  // drop the 6X.
  const saved = { stopId: "635", routes: ["6"], direction: "N" }
  const trips = [trip("exp", "6X", [stop("635N", 180)])]
  const out = Model.arrivalsFor(saved, trips, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].routeId, "6")
  assert.equal(out[0].express, true)
})

test("arrivalsFor marks an ordinary train as not express", () => {
  const saved = { stopId: "635", routes: ["6"], direction: "N" }
  const trips = [trip("loc", "6", [stop("635N", 180)])]
  assert.equal(Model.arrivalsFor(saved, trips, NOW)[0].express, false)
})

test("arrivalsFor reports the trip's terminal as the destination", () => {
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [trip("t", "L", [stop("L08N", 120), stop("L02N", 900)])]
  assert.equal(Model.arrivalsFor(saved, trips, NOW)[0].destinationStopId, "L02N")
})

test("arrivalsFor drops trains that have already departed", () => {
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [trip("gone", "L", [stop("L08N", -120)])]
  assert.deepEqual(Model.arrivalsFor(saved, trips, NOW), [])
})

test("arrivalsFor keeps a train arriving right now", () => {
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [trip("here", "L", [stop("L08N", 0)])]
  assert.equal(Model.arrivalsFor(saved, trips, NOW).length, 1)
})

test("arrivalsFor orders tied arrivals deterministically", () => {
  // Qt's V4 engine does NOT have a stable sort -- measured: 40 items across
  // 8 tied groups come back reordered, while node's has been stable since
  // ES2019. So a suite running only under node cannot catch an unstable
  // ordering; this test catches it by feeding the same trips in both orders
  // and requiring the same output.
  const saved = { stopId: "L08", routes: ["L"], direction: "N" }
  const trips = [
    trip("zulu", "L", [stop("L08N", 300)]),
    trip("alpha", "L", [stop("L08N", 300)]),
  ]
  const forward = Model.arrivalsFor(saved, trips, NOW).map((a) => a.tripId)
  const reversed = Model.arrivalsFor(saved, trips.slice().reverse(), NOW).map((a) => a.tripId)
  assert.deepEqual(forward, reversed,
    "tied arrivals must order identically regardless of input order")
  assert.deepEqual(forward, ["alpha", "zulu"], "ties break on tripId")
})

const Gtfs = require("../Gtfs.js")

test("normalizeRoute agrees between Model.js and Gtfs.js", () => {
  // It is duplicated because QML cannot import one .js from another. This test
  // is the only thing stopping the two copies from drifting apart silently.
  for (const id of ["6", "6X", "7X", "L", "X", "GS", "SI", ""]) {
    assert.equal(Model.normalizeRoute(id), Gtfs.normalizeRoute(id), `for "${id}"`)
  }
})

test("classifyAlert reddens a total loss of service", () => {
  assert.equal(Model.classifyAlert("No Scheduled Service"), "red")
})

test("classifyAlert ambers a degradation", () => {
  assert.equal(Model.classifyAlert("Delays"), "amber")
  assert.equal(Model.classifyAlert("Reduced Service"), "amber")
})

test("classifyAlert treats every Planned- type as planned", () => {
  for (const t of ["Planned - Stops Skipped", "Planned - Part Suspended",
                   "Planned - Express to Local", "Planned - Reroute",
                   "Planned - Suspended", "Planned - Extra Transfer"]) {
    assert.equal(Model.classifyAlert(t), "planned", t)
  }
})

test("a Planned- suspension does NOT redden the bar", () => {
  // The whole point: 144 of 199 alerts are planned work. If these coloured the
  // glyph it would be amber or red essentially permanently.
  assert.notEqual(Model.classifyAlert("Planned - Suspended"), "red")
})

test("classifyAlert treats informational types as info", () => {
  for (const t of ["Boarding Change", "Extra Service", "Special Schedule",
                   "Sunday Schedule", "Station Notice"]) {
    assert.equal(Model.classifyAlert(t), "info", t)
  }
})

test("an unrecognised alert type is info, never red", () => {
  // New types appear without warning. The failure mode of a surprise value
  // must be a quiet panel row, never a red bar.
  assert.equal(Model.classifyAlert("Meteor Strike"), "info")
  assert.equal(Model.classifyAlert(""), "info")
})

test("a non-string alert type degrades to info rather than throwing", () => {
  // classifyAlert sits under worstAlertClass, which sits under barState,
  // which is read by a QML property binding. A throw there removes the whole
  // bar; a misclassification only degrades one alert row. Its two siblings
  // (alertIsActive, alertsFor) already tolerate malformed input, so this one
  // must too. Unreachable from the decoder today — every alertType it emits
  // is a string — which is exactly why it needs a test rather than trust.
  for (const bad of [42, true, {}, [], 0.5]) {
    assert.equal(Model.classifyAlert(bad), "info",
      `classifyAlert(${JSON.stringify(bad)}) must not throw`)
  }
})

test("an Object.prototype member as an alert type is info, never red", () => {
  // The severity tables are plain objects, so a bare `TABLE[alertType]`
  // lookup walks the prototype chain and returns a truthy inherited member
  // for these — classifying them as red. alertType is upstream feed data,
  // not a curated constant, so the tables must be probed with
  // hasOwnProperty. This test fails against a bare-lookup implementation.
  for (const key of ["constructor", "toString", "__proto__", "valueOf",
                     "hasOwnProperty", "isPrototypeOf"]) {
    assert.equal(Model.classifyAlert(key), "info", `"${key}" must not be red`)
  }
})

test("alertIsActive is false before the period opens", () => {
  const a = { periods: [{ start: NOW + 3600, end: NOW + 7200 }] }
  assert.equal(Model.alertIsActive(a, NOW), false)
})

test("alertIsActive is true inside the period", () => {
  const a = { periods: [{ start: NOW - 60, end: NOW + 60 }] }
  assert.equal(Model.alertIsActive(a, NOW), true)
})

test("alertIsActive is false after the period closes", () => {
  const a = { periods: [{ start: NOW - 7200, end: NOW - 3600 }] }
  assert.equal(Model.alertIsActive(a, NOW), false)
})

test("alertIsActive treats an open-ended period as ongoing", () => {
  const a = { periods: [{ start: NOW - 60, end: 0 }] }
  assert.equal(Model.alertIsActive(a, NOW), true)
})

test("alertIsActive treats no period at all as ongoing", () => {
  assert.equal(Model.alertIsActive({ periods: [] }, NOW), true)
})

test("alertsFor keeps only alerts touching the saved routes", () => {
  const alerts = [
    { id: "a", routes: ["L"], alertType: "Delays", periods: [] },
    { id: "b", routes: ["G"], alertType: "Delays", periods: [] },
  ]
  const out = Model.alertsFor(["L"], alerts, NOW)
  assert.deepEqual(out.map((a) => a.id), ["a"])
})

test("alertsFor matches an express route against the saved plain route", () => {
  const alerts = [{ id: "x", routes: ["6X"], alertType: "Delays", periods: [] }]
  assert.equal(Model.alertsFor(["6"], alerts, NOW).length, 1)
})

test("alertsFor drops alerts whose period has not begun", () => {
  const alerts = [
    { id: "future", routes: ["L"], alertType: "Planned - Suspended",
      periods: [{ start: NOW + 86400, end: NOW + 90000 }] },
  ]
  assert.deepEqual(Model.alertsFor(["L"], alerts, NOW), [])
})

const snap = (over) => Object.assign({
  ok: true, feedTimestamp: NOW, staleAfterSec: 180,
  station: { id: "L08", name: "Bedford Av", labelN: "Manhattan", labelS: "Outbound" },
  saved: { stopId: "L08", routes: ["L"], direction: "N" },
  arrivals: [], alerts: [],
}, over)

test("BAR_GLYPH is the conductor, built not typed", () => {
  // Trap: a literal astral character does NOT survive the editing path. This
  // asserts the codepoint, not the shape -- a shape check passes just as
  // happily on a typo'd codepoint.
  // md-account_tie_voice, verified present in VictorMono Nerd Font's cmap.
  assert.equal(Model.BAR_GLYPH.codePointAt(0), 0xF1308)
  assert.equal(Model.BAR_GLYPH.length, 2, "astral chars are two UTF-16 units")
})

test("badgeText shortens an arriving train, formatCountdown does not", () => {
  // The bar badge is a circle sized for two characters, so "now" cannot go in
  // it. The PANEL still says "now" -- these two must not be the same function,
  // and a refactor that collapses them is the failure this guards.
  assert.equal(Model.badgeText(0), "\u2022")
  assert.equal(Model.badgeText(59), "\u2022")
  assert.equal(Model.badgeText(60), "1")
  assert.equal(Model.badgeText(1080), "18")
  assert.equal(Model.formatCountdown(0), "now", "the panel is unchanged")
  assert.equal(Model.formatCountdown(59), "now")
})

test("routeColor covers the route ids the FEEDS actually emit", () => {
  // Not the display letters. The live feeds emit GS, FS and H for the three
  // shuttles and SI for Staten Island -- keying on "S" alone leaves all three
  // shuttles uncoloured, which is the bug this exists to prevent.
  assert.equal(Model.routeColor("1"), "#EE352E")
  assert.equal(Model.routeColor("6"), "#00933C")
  assert.equal(Model.routeColor("7"), "#B933AD")
  assert.equal(Model.routeColor("A"), "#0039A6")
  assert.equal(Model.routeColor("M"), "#FF6319")
  assert.equal(Model.routeColor("G"), "#6CBE45")
  assert.equal(Model.routeColor("J"), "#996633")
  assert.equal(Model.routeColor("L"), "#A7A9AC")
  assert.equal(Model.routeColor("Q"), "#FCCC0A")
  for (const shuttle of ["S", "GS", "FS", "H"]) {
    assert.equal(Model.routeColor(shuttle), "#808183", `${shuttle} is a shuttle`)
  }
  assert.equal(Model.routeColor("SI"), "#0039A6")
})

test("routeColor resolves an express id to its trunk colour", () => {
  // 6X is the 6. Without normalizing, every express train renders as the
  // unknown-route fallback.
  assert.equal(Model.routeColor("6X"), Model.routeColor("6"))
  assert.equal(Model.routeColor("7X"), Model.routeColor("7"))
})

test("routeColor falls back rather than returning nothing", () => {
  // A bullet with an empty colour paints an invisible disc with text on top,
  // which reads as a rendering bug rather than an unknown route.
  for (const bad of ["", null, undefined, "ZZ", "constructor", "__proto__"]) {
    assert.equal(Model.routeColor(bad), "#6E7681",
      `${JSON.stringify(bad)} gets the fallback`)
  }
})

test("routeTextColor picks the higher-contrast text for the disc", () => {
  // Derived from luminance, not a per-route table: the yellow, grey and light
  // green bullets are all too light for white text at caption size. This
  // deliberately departs from the MTA, which uses white on G and on L.
  assert.equal(Model.routeTextColor("Q"), "#000000", "yellow needs black")
  assert.equal(Model.routeTextColor("L"), "#000000", "light grey needs black")
  assert.equal(Model.routeTextColor("G"), "#000000", "light green needs black")
  assert.equal(Model.routeTextColor("A"), "#FFFFFF", "dark blue needs white")
  assert.equal(Model.routeTextColor("1"), "#FFFFFF", "red needs white")
  assert.equal(Model.routeTextColor("J"), "#FFFFFF", "brown needs white")
  assert.equal(Model.routeTextColor("ZZ"), "#FFFFFF", "the fallback is dark")
})

test("formatCountdown rounds down to whole minutes", () => {
  assert.equal(Model.formatCountdown(119), "1")
  assert.equal(Model.formatCountdown(120), "2")
})

test("formatCountdown says now for an imminent train", () => {
  assert.equal(Model.formatCountdown(0), "now")
  assert.equal(Model.formatCountdown(30), "now")
})

test("barState badges the next arrival in minutes", () => {
  const s = snap({ arrivals: [{ routeId: "L", express: false, etaSec: 240 }] })
  assert.equal(Model.barState(s, NOW).badge, "4")
})

test("barState shows no badge when nothing is coming", () => {
  assert.equal(Model.barState(snap({}), NOW).badge, "")
})

test("barState is ok when all is well", () => {
  const s = snap({ arrivals: [{ routeId: "L", express: false, etaSec: 240 }] })
  assert.equal(Model.barState(s, NOW).severity, "ok")
})

test("barState warns on stale data and keeps the last number", () => {
  const s = snap({
    feedTimestamp: NOW - 600,
    arrivals: [{ routeId: "L", express: false, etaSec: 240 }],
  })
  const bar = Model.barState(s, NOW)
  assert.equal(bar.severity, "warn")
  assert.equal(bar.badge, "4")
})

test("barState errors and drops the badge when the feed is unreachable", () => {
  const bar = Model.barState(snap({ ok: false }), NOW)
  assert.equal(bar.severity, "error")
  assert.equal(bar.badge, "")
})

test("barState warns for an amber alert", () => {
  const s = snap({ alerts: [{ id: "a", routes: ["L"], alertType: "Delays", periods: [] }] })
  assert.equal(Model.barState(s, NOW).severity, "warn")
})

test("barState errors for a red alert", () => {
  const s = snap({
    alerts: [{ id: "a", routes: ["L"], alertType: "No Scheduled Service", periods: [] }],
  })
  assert.equal(Model.barState(s, NOW).severity, "error")
})

test("barState lets a red alert win over stale data", () => {
  // Both conditions hold at once, and the spec's table says error, not warn:
  // "your line has no service" outranks "this data is a few minutes old".
  //
  // This test exists because the precedence was previously unguarded —
  // proven by mutation: swapping the stale and red branches left every other
  // test in this file passing. A rider whose line was suspended would have
  // seen an amber "stale" glyph instead of a red one.
  const s = snap({
    feedTimestamp: NOW - 600,
    arrivals: [{ routeId: "L", express: false, etaSec: 240 }],
    alerts: [{ id: "a", routes: ["L"], alertType: "No Scheduled Service", periods: [] }],
  })
  assert.equal(Model.barState(s, NOW).severity, "error")
})

test("barState stays calm for planned work", () => {
  const s = snap({
    arrivals: [{ routeId: "L", express: false, etaSec: 240 }],
    alerts: [{ id: "p", routes: ["L"], alertType: "Planned - Suspended", periods: [] }],
  })
  assert.equal(Model.barState(s, NOW).severity, "ok")
})

test("tooltipText names the station, direction and next trains", () => {
  const s = snap({
    arrivals: [
      { routeId: "L", express: false, etaSec: 240 },
      { routeId: "L", express: false, etaSec: 660 },
    ],
  })
  const text = Model.tooltipText(s, NOW)
  assert.match(text, /Bedford Av/)
  assert.match(text, /Manhattan/)
  assert.match(text, /4/)
})

test("tooltipText names the fault instead of counting when one exists", () => {
  const s = snap({
    alerts: [{ id: "a", routes: ["L"], alertType: "Delays",
               headerText: "[L] trains are running with delays.", periods: [] }],
  })
  assert.match(Model.tooltipText(s, NOW), /delays/i)
})

test("tooltipText says so when no station is saved", () => {
  assert.match(Model.tooltipText(snap({ station: null, saved: null }), NOW), /no station/i)
})

test("feedAgeText says how old the data is, and when it is stale", () => {
  // The panel header's right-hand slot. The spec already puts data age in the
  // header; this is the string that goes there.
  assert.equal(Model.feedAgeText(0, 1000, 300), "", "nothing fetched yet")
  assert.equal(Model.feedAgeText(1000, 1000, 300), "updated 0s ago")
  assert.equal(Model.feedAgeText(1000, 1045, 300), "updated 45s ago")
  assert.equal(Model.feedAgeText(1000, 1120, 300), "updated 2m ago")
  assert.equal(Model.feedAgeText(1000, 8200, 99999), "updated 2h ago")
  // Past staleAfterSec the wording changes, because "updated" is exactly the
  // wrong word for data that has stopped arriving.
  assert.equal(Model.feedAgeText(1000, 1400, 300), "stale - 6m old")
})

test("feedAgeText survives a clock that runs backwards", () => {
  // nowSec comes from the local clock and feedTimestamp from the MTA's. NTP
  // stepping the local clock backwards would otherwise render "updated -4s ago".
  assert.equal(Model.feedAgeText(1000, 996, 300), "updated 0s ago")
})

test("distanceText renders miles, not kilometres", () => {
  // haversineKm stays in km -- that is the natural unit for the formula and
  // what `search` sorts on. Only the DISPLAY is imperial, so switching units
  // later is a change to this function and nothing else.
  assert.equal(Model.distanceText(null), "", "no origin, no distance")
  assert.equal(Model.distanceText(0.16), "0.1 mi")
  assert.equal(Model.distanceText(1), "0.6 mi")
  assert.equal(Model.distanceText(10), "6.2 mi")
  assert.equal(Model.distanceText(0), "0.0 mi")
})

test("distanceText does not confuse 0 with absent", () => {
  // 0 km is a real answer -- the station you are standing on -- and `null` is
  // "there is no location fix". A falsy check would collapse the two and hide
  // the distance on the nearest station of all.
  assert.notEqual(Model.distanceText(0), Model.distanceText(null))
})

test("barState and tooltipText survive a saved station with no routes", () => {
  // F4. Both are readonly property BINDINGS on the Service item, and a throw in
  // a QML binding is not confined to one row -- it removes the whole widget.
  // Reachable from a hand-edited headway.json, a partial write, or an older
  // build's shape. The state file is advertised as plain JSON, so this is
  // upstream data, not an internal invariant.
  const snap = {
    ok: true, feedTimestamp: 1000, staleAfterSec: 180,
    station: null, saved: { stopId: "L08", direction: "N" },  // no `routes`
    arrivals: [],
    // A LIVE alert is required to reach the throw. With an empty alerts array
    // the loop in alertsFor never runs and routes.length is never dereferenced,
    // so the test passes without exercising anything -- which is how the first
    // draft of this test was green against the unfixed code.
    alerts: [{ alertType: "Delays", routes: ["L"], periods: [] }]
  }
  assert.doesNotThrow(() => Model.barState(snap, 2000), "barState must not throw")
  assert.doesNotThrow(() => Model.tooltipText(snap, 2000), "tooltipText must not throw")
})

test("dedupeTrips is not fooled by a prototype-chain tripId", () => {
  // F14. `seen[key]` walks the prototype chain, so a tripId of "constructor"
  // reads as already-seen and a real train is dropped from the arrivals list.
  // Same class as the classifyAlert bug that was fixed; AGENTS.md states this
  // as an absolute rule for any table keyed on upstream data.
  const trips = [
    { tripId: "constructor", routeId: "L", stops: [] },
    { tripId: "__proto__",   routeId: "L", stops: [] },
    { tripId: "toString",    routeId: "L", stops: [] }
  ]
  assert.equal(Model.dedupeTrips([trips]).length, 3,
    "three distinct trips must survive")
})
