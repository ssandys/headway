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
