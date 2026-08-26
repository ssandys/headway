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

test("BAR_GLYPH is the fedora, built not typed", () => {
  // Trap: a literal astral character does NOT survive the editing path. This
  // asserts the codepoint, not the shape -- a shape check passes just as
  // happily on a typo'd codepoint.
  assert.equal(Model.BAR_GLYPH.codePointAt(0), 0xF0BA4)
  assert.equal(Model.BAR_GLYPH.length, 2, "astral chars are two UTF-16 units")
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
