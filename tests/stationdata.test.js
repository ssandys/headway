// tests/stationdata.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const { STATIONS } = require("../StationData.js")

test("the table holds every subway station", () => {
  assert.equal(STATIONS.length, 496)
})

test("station ids are unique", () => {
  assert.equal(new Set(STATIONS.map((s) => s.id)).size, STATIONS.length)
})

test("every station has coordinates and a name", () => {
  for (const s of STATIONS) {
    assert.ok(s.name.length > 0, `${s.id} has a name`)
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), `${s.id} has coords`)
    assert.ok(s.lat > 40 && s.lat < 41.2, `${s.id} latitude is in the NYC area`)
    assert.ok(s.lon > -74.3 && s.lon < -73.7, `${s.id} longitude is in the NYC area`)
  }
})

test("every station has both direction labels", () => {
  for (const s of STATIONS) {
    assert.ok(s.labelN.length > 0, `${s.id} has a north label`)
    assert.ok(s.labelS.length > 0, `${s.id} has a south label`)
  }
})

test("every station lists at least one route", () => {
  for (const s of STATIONS) assert.ok(s.routes.length > 0, `${s.id} has routes`)
})

test("duplicate names exist and are why search must show routes", () => {
  const byName = new Map()
  for (const s of STATIONS) byName.set(s.name, (byName.get(s.name) || 0) + 1)
  assert.equal(byName.get("86 St"), 6, "there really are six 86 St stations")
})

test("Bedford Av's north label is rider-facing", () => {
  const bedford = STATIONS.find((s) => s.id === "L08")
  assert.equal(bedford.name, "Bedford Av")
  assert.equal(bedford.labelN, "Manhattan")
})
