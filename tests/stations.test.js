// tests/stations.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const { STATIONS } = require("../StationData.js")
const Stations = require("../Stations.js")

const UNION_SQ = { lat: 40.735736, lon: -73.990568 }

test("byId finds a station", () => {
  assert.equal(Stations.byId(STATIONS, "L08").name, "Bedford Av")
})

test("byId returns null for an unknown id", () => {
  assert.equal(Stations.byId(STATIONS, "NOPE"), null)
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
  const bedford = Stations.byId(STATIONS, "L08")
  const d = Stations.haversineKm(UNION_SQ.lat, UNION_SQ.lon, bedford.lat, bedford.lon)
  assert.ok(d > 1.5 && d < 4, `expected 1.5-4 km, got ${d}`)
})

test("search with no query returns the nearest stations first", () => {
  const results = Stations.search(STATIONS, "", UNION_SQ, 5)

  // Deliberately NOT `length === 5`, and NOT monotonic distance across all
  // rows. Complex grouping breaks both on purpose: a complex's platforms stay
  // together behind its nearest member, so a row can be closer than the row
  // above it, and the limit extends rather than cutting a complex in half.
  // Measured from Union Sq at limit 20, position 7 (23 St-Baruch College,
  // 0.568 km) sits below a 0.844 km row -- so the original assertion here was
  // false of the implementation and passed only because that row fell outside
  // a 5-row window. Worse, it would have kept passing if complex grouping were
  // removed entirely.
  assert.ok(results.length >= 5, "at least the requested window")
  assert.ok(results.every((r) => r.distanceKm !== null), "every row has a distance")

  // What IS guaranteed, and what this now checks: row one is the globally
  // nearest station, and each complex GROUP is anchored in ascending distance.
  const all = Stations.search(STATIONS, "", UNION_SQ, 1000)
  const nearest = all.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a))
  assert.equal(results[0].id, nearest.id, "row one is the globally nearest station")

  const anchors = []
  let group = null
  for (const r of results) {
    const key = r.complexId || "solo:" + r.id
    if (key !== group) { anchors.push(r.distanceKm); group = key }
  }
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i] >= anchors[i - 1],
      "complex groups are anchored in ascending distance")
  }
})

test("search matches on name, case-insensitively", () => {
  const results = Stations.search(STATIONS, "bedford", UNION_SQ, 10)
  assert.ok(results.some((s) => s.id === "L08"))
})

test("search for an ambiguous name returns every candidate", () => {
  const results = Stations.search(STATIONS, "86 St", UNION_SQ, 20)
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
  const results = Stations.search(STATIONS, "42 St", null, 20)
  const ids = results.map((s) => s.complexId)
  for (const c of new Set(ids)) {
    const idx = ids.map((v, i) => (v === c ? i : -1)).filter((i) => i >= 0)
    assert.equal(idx[idx.length - 1] - idx[0] + 1, idx.length,
      `complex ${c} should occupy a contiguous run, got positions ${idx}`)
  }
})

test("search works with no origin, falling back to alphabetical", () => {
  const results = Stations.search(STATIONS, "", null, 5)
  assert.equal(results.length, 5)
  for (const r of results) assert.equal(r.distanceKm, null)
})

test("directionsFor offers rider-facing labels", () => {
  const dirs = Stations.directionsFor(Stations.byId(STATIONS, "L08"))
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

test("search's comparator has a total order in both branches", () => {
  // Deferred minor #1. Qt's V4 sort is NOT stable and node's IS, so a missing
  // tie-breaker is invisible to a test that merely sorts real data -- the first
  // draft of this test asserted the six real "86 St" stations came back in id
  // order and passed against the unfixed code, because node's stable sort
  // happened to preserve a table already in that order.
  //
  // So the input is deliberately shuffled OUT of id order. A stable sort with
  // no tie-breaker returns it exactly as given; only a real tie-breaker
  // reorders it. That makes the assertion mean something under node.
  const tied = (extra) => ["C03", "A01", "B02"].map((id) => Object.assign({
    id, name: "86 St", routes: ["1"], borough: "M", line: "x",
    complexId: "", labelN: "N", labelS: "S"
  }, extra))

  // Alphabetical branch: no origin, every name identical.
  const alpha = Stations.search(tied({ lat: 40.7, lon: -74.0 }), "", null, 10)
  assert.deepEqual(alpha.map((r) => r.id), ["A01", "B02", "C03"],
    "tied names must fall back to id order")

  // Distance branch: identical coordinates, so every distance ties too.
  const near = Stations.search(tied({ lat: 40.7, lon: -74.0 }), "",
                               { lat: 40.7, lon: -74.0 }, 10)
  assert.deepEqual(near.map((r) => r.id), ["A01", "B02", "C03"],
    "tied distances must fall back to id order")
})

test("search does not hand out references into the station table", () => {
  // Deferred minor #6, and it matters more now: saveStation persists this
  // array to headway.json, so a mutation would corrupt the on-disk state.
  const before = Stations.byId(STATIONS, "L08").routes.slice()
  const row = Stations.search(STATIONS, "Bedford Av", null, 5)[0]
  row.routes.push("ZZZ")
  assert.deepEqual(Stations.byId(STATIONS, "L08").routes, before,
    "mutating a result row must not reach STATIONS")
})

test("search survives a malformed origin instead of scrambling the order", () => {
  // F7. haversineKm on a non-numeric coordinate returns NaN, and `a - b` is
  // then NaN, so the comparator answers "neither" for every pair and the sort
  // degrades to raw table order while still claiming to be nearest-first.
  const bad = Stations.search(STATIONS, "86 St", { lat: "x", lon: null }, 1000)
  assert.ok(bad.every((r) => r.distanceKm === null),
    "an unusable origin must read as no origin")
  const plain = Stations.search(STATIONS, "86 St", null, 1000)
  assert.deepEqual(bad.map((r) => r.id), plain.map((r) => r.id),
    "and must fall back to the no-origin ordering exactly")
})

test("search's limit never cuts a complex in half", () => {
  // Deferred minor #2, confirmed by the final review at the live limit of 6.
  // Complex contiguity is the whole reason grouping exists; slicing through
  // one delivers the opposite of what it promises.
  const full = Stations.search(STATIONS, "", UNION_SQ, 1000)
  const cut = Stations.search(STATIONS, "", UNION_SQ, 6)
  const last = cut[cut.length - 1]
  const next = full[cut.length]
  if (next && last.complexId) {
    assert.notEqual(next.complexId, last.complexId,
      `complex ${last.complexId} is split across the limit boundary`)
  }
})

test("search is not fooled by a prototype-chain station id", () => {
  // F14. `placed[id]` walks the prototype chain, so an id of "constructor"
  // reads as already-placed and that station silently never appears.
  const table = [
    { id: "constructor", name: "Alpha", routes: ["1"], borough: "M", line: "x",
      complexId: "", lat: 40.7, lon: -74.0, labelN: "N", labelS: "S" },
    { id: "toString", name: "Beta", routes: ["2"], borough: "M", line: "x",
      complexId: "", lat: 40.7, lon: -74.0, labelN: "N", labelS: "S" }
  ]
  assert.equal(Stations.search(table, "", null, 10).length, 2,
    "both stations must survive grouping")
})
