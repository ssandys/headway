// tests/gtfs.test.js
const test = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")

const Gtfs = require("../Gtfs.js")

const u8 = (...b) => new Uint8Array(b)

test("readVarint decodes a single-byte value", () => {
  assert.deepEqual(Gtfs.readVarint(u8(0x08), 0), [8, 1])
})

test("readVarint decodes a multi-byte value", () => {
  // 300 = 0b100101100 -> 0xAC 0x02
  assert.deepEqual(Gtfs.readVarint(u8(0xac, 0x02), 0), [300, 2])
})

test("readVarint decodes a real feed timestamp", () => {
  const bytes = u8(0x91, 0xbd, 0xb7, 0xd4, 0x06)
  assert.equal(Gtfs.readVarint(bytes, 0)[0], 1787682449)
})

test("readVarint survives values above 32 bits", () => {
  // This is the case that actually guards the multiplication-based
  // accumulator. Note what does NOT guard it: an ordinary feed timestamp like
  // 1787682449 needs only 31 bits, and the common broken idiom
  // (`v |= (b & 0x7f) << shift`) returns it perfectly. Measured. The bug is
  // only visible at two boundaries, so both are asserted here:
  //   2^31 + 1 -> a `<<` reader returns -2147483647 (sign-bit corruption)
  //   2^32     -> a `<<` reader returns 0          (truncation)
  assert.equal(Gtfs.readVarint(u8(0x81, 0x80, 0x80, 0x80, 0x08), 0)[0], 2147483649)
  assert.equal(Gtfs.readVarint(u8(0x80, 0x80, 0x80, 0x80, 0x10), 0)[0], 4294967296)
})

test("readVarint refuses a varint that runs past the end of the buffer", () => {
  // Every byte sets the continuation bit, then the buffer ends. Reading past
  // the end yields `undefined`, whose `& 0x80` is 0 -- so an unguarded reader
  // treats EOF as a valid terminator and silently returns a wrong value.
  assert.throws(() => Gtfs.readVarint(u8(0x80, 0x80, 0x80), 0), /past the end/)
})

test("walkFields reports a varint field", () => {
  // field 3, wire 0, value 42  -> tag = 3<<3|0 = 24 = 0x18
  const seen = []
  const bytes = u8(0x18, 0x2a)
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v) => seen.push([f, w, v]))
  assert.deepEqual(seen, [[3, 0, 42]])
})

test("walkFields reports a length-delimited field as a range", () => {
  // field 1, wire 2, len 3, "1.0" -> tag = 1<<3|2 = 10 = 0x0a
  const bytes = u8(0x0a, 0x03, 0x31, 0x2e, 0x30)
  let range = null
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v, s, e) => {
    if (f === 1) range = [s, e]
  })
  assert.deepEqual(range, [2, 5])
  assert.equal(Gtfs.utf8(bytes, range[0], range[1]), "1.0")
})

test("walkFields skips wire type 5 (4 bytes) without derailing", () => {
  // field 1 wire 5 (4 bytes), then field 2 wire 0 value 7
  const bytes = u8(0x0d, 1, 2, 3, 4, 0x10, 0x07)
  const seen = []
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v) => seen.push([f, w, v]))
  assert.deepEqual(seen, [[1, 5, 0], [2, 0, 7]])
})

test("walkFields skips wire type 1 (8 bytes) without derailing", () => {
  // Separate case on purpose. Wire 1 and wire 5 skip different distances, and
  // an off-by-one on either desynchronizes EVERY subsequent field in the
  // message -- silently, since the bytes still parse as something. The field
  // that follows is what proves the skip landed on the right byte.
  const bytes = u8(0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x10, 0x07)
  const seen = []
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v) => seen.push([f, w, v]))
  assert.deepEqual(seen, [[1, 1, 0], [2, 0, 7]])
})

test("walkFields refuses a length-delimited field that overruns the buffer", () => {
  // field 1, wire 2, declared length 200, but only 3 bytes follow. An
  // unguarded walker hands the caller a range past the end of the buffer.
  const bytes = u8(0x0a, 0xc8, 0x01, 0x41, 0x42, 0x43)
  assert.throws(() => Gtfs.walkFields(bytes, 0, bytes.length, () => {}), /past the end/)
})

test("walkFields throws on a genuinely invalid wire type", () => {
  assert.throws(() => Gtfs.walkFields(u8(0x0f, 0x00), 0, 2, () => {}), /wire type/)
})

test("utf8 decodes a 3-byte sequence", () => {
  // A real en dash (U+2013), which appears in MTA station names
  const bytes = u8(0x41, 0xe2, 0x80, 0x93, 0x42)
  assert.equal(Gtfs.utf8(bytes, 0, bytes.length), "A–B")
})

test("utf8 decodes a 4-byte (astral) sequence", () => {
  // The 4-byte branch is the only one that needs String.fromCodePoint and a
  // surrogate pair, and nothing else in the suite reaches it. These bytes are
  // U+F1308 -- md-account_tie_voice, the plugin's own bar glyph -- so this case
  // doubles as proof the engine round-trips the exact codepoint Model.js
  // builds in a later task.
  const bytes = u8(0xf3, 0xb1, 0x8c, 0x88)
  const decoded = Gtfs.utf8(bytes, 0, bytes.length)
  assert.equal(decoded.codePointAt(0), 0xF1308)
  assert.equal(decoded.length, 2, "an astral char is two UTF-16 units")
})

test("FEEDS covers all eight subway feeds", () => {
  assert.equal(Object.keys(Gtfs.FEEDS).length, 8)
})

test("shuttles are on their verified feeds", () => {
  assert.ok(Gtfs.FEEDS["gtfs"].indexOf("GS") >= 0, "GS is on gtfs")
  assert.ok(Gtfs.FEEDS["gtfs-ace"].indexOf("H") >= 0, "H is on gtfs-ace")
  assert.ok(Gtfs.FEEDS["gtfs-bdfm"].indexOf("FS") >= 0, "FS is on gtfs-bdfm")
})

test("Staten Island's route id is SI, not SIR", () => {
  assert.deepEqual(Gtfs.FEEDS["gtfs-si"], ["SI"])
})

test("normalizeRoute strips the express suffix", () => {
  assert.equal(Gtfs.normalizeRoute("6X"), "6")
  assert.equal(Gtfs.normalizeRoute("7X"), "7")
})

test("normalizeRoute leaves ordinary routes alone", () => {
  assert.equal(Gtfs.normalizeRoute("6"), "6")
  assert.equal(Gtfs.normalizeRoute("L"), "L")
})

test("normalizeRoute does not mangle a route legitimately ending in X", () => {
  // No such route exists today, but the rule must be suffix-on-a-longer-id,
  // never "any id containing X" -- a single-character "X" stays "X".
  assert.equal(Gtfs.normalizeRoute("X"), "X")
})

test("feedsForRoutes picks only the feeds needed", () => {
  assert.deepEqual(Gtfs.feedsForRoutes(["L"]), ["gtfs-l"])
})

test("feedsForRoutes returns each feed once for routes sharing it", () => {
  assert.deepEqual(Gtfs.feedsForRoutes(["N", "Q"]), ["gtfs-nqrw"])
})

test("feedsForRoutes resolves an express id to its parent feed", () => {
  assert.deepEqual(Gtfs.feedsForRoutes(["6X"]), ["gtfs"])
})

test("feedsForRoutes ignores an unknown route rather than throwing", () => {
  assert.deepEqual(Gtfs.feedsForRoutes(["ZZZ"]), [])
})

test("feedUrl builds the encoded nyct path", () => {
  assert.equal(
    Gtfs.feedUrl("gtfs-l"),
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l")
})

test("ALERTS_URL points at the protobuf variant, not the json one", () => {
  assert.equal(
    Gtfs.ALERTS_URL,
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts")
})

const fixture = (name) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures", name)))

test("decodeTripUpdates reads the feed header timestamp", () => {
  const feed = Gtfs.decodeTripUpdates(fixture("gtfs-l.pb"))
  assert.ok(feed.timestamp > 1700000000, "timestamp is a plausible epoch")
  assert.ok(feed.timestamp < 4000000000, "timestamp was not truncated to 32 bits")
})

test("decodeTripUpdates returns trips with route and stops", () => {
  const feed = Gtfs.decodeTripUpdates(fixture("gtfs-l.pb"))
  assert.ok(feed.trips.length > 0, "the L feed has trips")
  const trip = feed.trips[0]
  assert.equal(typeof trip.tripId, "string")
  assert.equal(trip.routeId, "L")
  assert.ok(trip.stops.length > 0)
  assert.match(trip.stops[0].stopId, /^L\d+[NS]$/)
  assert.ok(trip.stops[0].time > 1700000000)
})

test("decodeTripUpdates yields only route ids the feed's vocabulary allows", () => {
  const feed = Gtfs.decodeTripUpdates(fixture("gtfs.pb"))
  const ids = new Set(feed.trips.map((t) => t.routeId))
  assert.ok(ids.size > 0, "the numbered feed yields routes")
  for (const id of ids) assert.match(id, /^[1-7]X?$|^GS$/)
})
// Note what this case deliberately does NOT assert: that 6X or 7X is present.
// Expresses run only at certain hours and this fixture is captured live, so
// requiring them would make the suite pass or fail on the time of day someone
// happened to run capture-fixtures.sh. That express ids are *handled* is
// verified deterministically in Model.js's tests against a synthetic 6X trip.
// What this case guards is narrower and always true: the decoder never invents
// a route id outside the feed's known vocabulary.

test("decodeTripUpdates tolerates an empty buffer", () => {
  const feed = Gtfs.decodeTripUpdates(new Uint8Array(0))
  assert.deepEqual(feed, { timestamp: 0, trips: [] })
})

test("decodeTripUpdates skips a stop_time_update with neither time", () => {
  // FeedMessage.entity(2) > FeedEntity.trip_update(3) > TripUpdate:
  //   trip(1) { route_id(5) = "L" }, stop_time_update(2) { stop_id(4) = "L08N" }
  // The stop carries no arrival(2) and no departure(3), so it must be dropped.
  const trip = [0x2a, 0x01, 0x4c]                       // field 5, len 1, "L"
  const tripMsg = [0x0a, trip.length].concat(trip)      // TripUpdate.trip = 1
  const stop = [0x22, 0x04, 0x4c, 0x30, 0x38, 0x4e]     // field 4, len 4, "L08N"
  const stopMsg = [0x12, stop.length].concat(stop)      // TripUpdate.stop_time_update = 2
  const tu = tripMsg.concat(stopMsg)
  const tuMsg = [0x1a, tu.length].concat(tu)            // FeedEntity.trip_update = 3
  const ent = [0x12, tuMsg.length].concat(tuMsg)        // FeedMessage.entity = 2
  const feed = Gtfs.decodeTripUpdates(new Uint8Array(ent))
  assert.equal(feed.trips.length, 1)
  assert.deepEqual(feed.trips[0].stops, [])
})

test("decodeAlerts reads every alert with text and routes", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  assert.ok(feed.alerts.length > 0, "the alerts feed decoded at least one alert")
  // The guard here is per-alert structure, not a count threshold. A magic
  // number like "> 50" fails on a quiet day for reasons that have nothing to
  // do with the decoder, and passes a decoder that mangles every field.
  for (const a of feed.alerts) {
    assert.equal(typeof a.id, "string")
    assert.ok(a.id.length > 0, "every alert has a non-empty entity id")
    // NOT `length > 0`. TranslatedString.Translation has `text` (1) and
    // `language` (2), both strings. If the decoder read field 2, headerText
    // would be "en" -- non-empty, and a `> 0` check passes it happily. The
    // shortest real header in the fixture is 22 characters, so this bound
    // separates a sentence from a language code.
    assert.ok(a.headerText.length > 10,
      `headerText should be prose, got ${JSON.stringify(a.headerText)}`)
  }
})

test("decodeAlerts extracts alert_type from the Mercury extension", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  const typed = feed.alerts.filter((a) => a.alertType)
  assert.equal(typed.length, feed.alerts.length,
    "every alert carries a Mercury alert_type")
})

test("decodeAlerts sees the Planned- prefix that keeps the glyph calm", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  const planned = feed.alerts.filter((a) => a.alertType.indexOf("Planned - ") === 0)
  assert.ok(planned.length > 0, "planned work is present and marked")
})

test("decodeAlerts collects informed route ids, not some other string field", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  const withRoutes = feed.alerts.filter((a) => a.routes.length > 0)
  assert.ok(withRoutes.length > 0)
  // NOT `typeof r === "string"`. EntitySelector carries route_id (2) AND
  // stop_id (5), both strings -- reading the wrong one yields "L08N" instead
  // of "L", and a typeof check cannot tell them apart. A subway route id is
  // one or two letters, or a digit with an optional express X; a stop id
  // never matches that shape.
  const ROUTE = /^([1-7]X?|[A-Z]{1,2})$/
  for (const a of withRoutes) {
    for (const r of a.routes) {
      assert.match(r, ROUTE, `"${r}" does not look like a route id`)
    }
  }
})

test("decodeAlerts deduplicates repeated route ids on one alert", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  for (const a of feed.alerts) {
    assert.equal(a.routes.length, new Set(a.routes).size, "no duplicate routes")
  }
})

test("decodeAlerts reads active_period with start and end not transposed", () => {
  const feed = Gtfs.decodeAlerts(fixture("alerts.pb"))
  const withPeriod = feed.alerts.filter((a) => a.periods.length > 0)
  assert.ok(withPeriod.length > 0, "alerts carry active periods")
  assert.ok(withPeriod[0].periods[0].start > 1700000000, "start is a plausible epoch")
  // "Is it a plausible epoch" cannot distinguish TimeRange.start (1) from
  // .end (2) -- both are epoch seconds minutes apart, so a decoder that
  // swapped the two field numbers passes that check unchanged. Ordering is
  // what actually pins which field is which.
  const bounded = feed.alerts.filter((a) =>
    a.periods.some((p) => p.start > 0 && p.end > 0))
  assert.ok(bounded.length > 0, "some alerts carry both bounds")
  for (const a of bounded) {
    for (const p of a.periods) {
      if (p.start > 0 && p.end > 0) {
        assert.ok(p.end > p.start,
          `end ${p.end} must follow start ${p.start} on alert ${a.id}`)
      }
    }
  }
})

test("decodeAlerts tolerates an empty buffer", () => {
  assert.deepEqual(Gtfs.decodeAlerts(new Uint8Array(0)), { timestamp: 0, alerts: [] })
})

test("walkFields SKIPS a group-encoded field instead of discarding the feed", () => {
  // F12. Wire types 3 and 4 are START_GROUP/END_GROUP -- legal proto2, and
  // GTFS-Realtime IS proto2 (the NYCT and Mercury extensions attach through
  // `extend` blocks). walkFields used to throw on them, and Service.qml turns
  // any decode throw into "feed unreachable" -- so ONE group-encoded field
  // anywhere in a 233 KB feed would paint the bar red for a feed that returned
  // 200 with perfectly good trip data. The comment above decodeTripUpdates
  // claimed unrecognised fields were always skipped; for a group that was false.
  //
  //   field 1, varint 1        08 01
  //   field 2, START_GROUP     13
  //     field 3, varint 7      18 07
  //   field 2, END_GROUP       14
  //   field 4, varint 9        20 09
  const bytes = u8(0x08, 0x01, 0x13, 0x18, 0x07, 0x14, 0x20, 0x09)
  const seen = []
  Gtfs.walkFields(bytes, 0, bytes.length, (field, wire, value) => {
    seen.push([field, wire, value])
  })
  assert.deepEqual(seen, [[1, 0, 1], [4, 0, 9]],
    "fields either side of the group decode; the group itself is skipped whole")
})

test("walkFields skips a NESTED group", () => {
  // Depth tracking, not a scan for the first wire-4 tag.
  //   field 1, START_GROUP     0b
  //     field 2, START_GROUP   13
  //       field 3, varint 7    18 07
  //     field 2, END_GROUP     14
  //   field 1, END_GROUP       0c
  //   field 5, varint 4        28 04
  const bytes = u8(0x0b, 0x13, 0x18, 0x07, 0x14, 0x0c, 0x28, 0x04)
  const seen = []
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v) => seen.push([f, w, v]))
  assert.deepEqual(seen, [[5, 0, 4]])
})

test("walkFields still rejects a genuinely invalid wire type", () => {
  // 6 and 7 are the only invalid ones. Wire 7 on field 1 is 0x0f.
  assert.throws(() => Gtfs.walkFields(u8(0x0f), 0, 1, () => {}),
    /unknown wire type 7/)
})

test("walkFields rejects an unterminated group rather than running off the end", () => {
  // START_GROUP with no matching END_GROUP. Must throw, not loop or read past.
  assert.throws(() => Gtfs.walkFields(u8(0x13, 0x18, 0x07), 0, 3, () => {}),
    /group/)
})
