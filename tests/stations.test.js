// tests/stations.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const { STATIONS } = require("../StationData.js")
const Stations = require("../Stations.js")
Stations.load(STATIONS)

const UNION_SQ = { lat: 40.735736, lon: -73.990568 }

test("byId finds a station", () => {
  assert.equal(Stations.byId("L08").name, "Bedford Av")
})

test("byId returns null for an unknown id", () => {
  assert.equal(Stations.byId("NOPE"), null)
})

test("platformId composes the feed's stop id", () => {
  assert.equal(Stations.platformId("L08", "N"), "L08N")
  assert.equal(Stations.platformId("L08", "S"), "L08S")
})

test("parentOf strips the direction suffix", () => {
  assert.equal(Stations.parentOf("L08N"), "L08")
  assert.equal(Stations.parentOf("635S"), "635")
})

test("parentOf leaves an already-parent id alone", () => {
  assert.equal(Stations.parentOf("L08"), "L08")
})

test("haversineKm measures a known distance", () => {
  // Union Sq to Bedford Av is roughly 2.5 km as the crow flies
  const bedford = Stations.byId("L08")
  const d = Stations.haversineKm(UNION_SQ.lat, UNION_SQ.lon, bedford.lat, bedford.lon)
  assert.ok(d > 1.5 && d < 4, `expected 1.5-4 km, got ${d}`)
})

test("search with no query returns the nearest stations first", () => {
  const results = Stations.search("", UNION_SQ, 5)
  assert.equal(results.length, 5)
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].distanceKm >= results[i - 1].distanceKm,
      "results are ordered by distance")
  }
})

test("search matches on name, case-insensitively", () => {
  const results = Stations.search("bedford", UNION_SQ, 10)
  assert.ok(results.some((s) => s.id === "L08"))
})

test("search for an ambiguous name returns every candidate", () => {
  const results = Stations.search("86 St", UNION_SQ, 20)
  const exact = results.filter((s) => s.name === "86 St")
  assert.equal(exact.length, 6, "all six 86 St stations are offered")
  // and each is distinguishable
  const keys = exact.map((s) => s.routes.join("") + s.borough + s.line)
  assert.equal(new Set(keys).size, 6, "each is distinguishable by routes/boro/line")
})

test("search groups stations sharing a complex adjacently", () => {
  // "42 St" is chosen deliberately, and no other query in this dataset would
  // do. Sorted by name alone, its matches come back as:
  //     609  42 St-Bryant Pk
  //     611  42 St-Port Authority Bus Terminal
  //     610  Grand Central-42 St   (x3)
  //     611  Times Sq-42 St        (x4)
  // Complex 611 is SPLIT by the three Grand Central rows, so an
  // implementation that only sorts fails this test. A query like "Times Sq",
  // whose every match already shares one complex, would pass with no grouping
  // logic whatsoever and prove nothing.
  const results = Stations.search("42 St", null, 20)
  const ids = results.map((s) => s.complexId)
  for (const c of new Set(ids)) {
    const idx = ids.map((v, i) => (v === c ? i : -1)).filter((i) => i >= 0)
    assert.equal(idx[idx.length - 1] - idx[0] + 1, idx.length,
      `complex ${c} should occupy a contiguous run, got positions ${idx}`)
  }
})

test("search works with no origin, falling back to alphabetical", () => {
  const results = Stations.search("", null, 5)
  assert.equal(results.length, 5)
  for (const r of results) assert.equal(r.distanceKm, null)
})

test("directionsFor offers rider-facing labels", () => {
  const dirs = Stations.directionsFor(Stations.byId("L08"))
  assert.deepEqual(dirs.map((d) => d.dir), ["N", "S"])
  assert.equal(dirs[0].label, "Manhattan")
})

test("directionsFor omits a Last Stop direction", () => {
  // Coney Island-Stillwell Av is a terminal: its south label is "Last Stop"
  const coney = STATIONS.find((s) => s.labelS === "Last Stop")
  assert.ok(coney, "at least one terminal exists in the data")
  const dirs = Stations.directionsFor(coney)
  assert.ok(!dirs.some((d) => d.dir === "S"), "a terminal offers no departures that way")
})

test("boroughName expands the code", () => {
  assert.equal(Stations.boroughName("Bk"), "Brooklyn")
  assert.equal(Stations.boroughName("M"), "Manhattan")
  assert.equal(Stations.boroughName("??"), "??")
})
