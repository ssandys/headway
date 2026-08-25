// tests/gtfs.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const Gtfs = require("../Gtfs.js")

const u8 = (...b) => new Uint8Array(b)

test("readVarint decodes a single-byte value", () => {
  assert.deepEqual(Gtfs.readVarint(u8(0x08), 0), [8, 1])
})

test("readVarint decodes a multi-byte value", () => {
  // 300 = 0b100101100 -> 0xAC 0x02
  assert.deepEqual(Gtfs.readVarint(u8(0xac, 0x02), 0), [300, 2])
})

test("readVarint survives values above 32 bits", () => {
  // 1787682449 is a real feed timestamp. A `<<`-based reader truncates to 32
  // bits and returns garbage here, which is the whole point of this case.
  const bytes = u8(0x91, 0xbd, 0xb7, 0xd4, 0x06)
  const [value] = Gtfs.readVarint(bytes, 0)
  assert.equal(value, 1787682449)
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

test("walkFields skips unknown wire types 1 and 5 without derailing", () => {
  // field 1 wire 5 (4 bytes), then field 2 wire 0 value 7
  const bytes = u8(0x0d, 1, 2, 3, 4, 0x10, 0x07)
  const seen = []
  Gtfs.walkFields(bytes, 0, bytes.length, (f, w, v) => seen.push([f, w, v]))
  assert.deepEqual(seen, [[1, 5, 0], [2, 0, 7]])
})

test("walkFields throws on a genuinely invalid wire type", () => {
  assert.throws(() => Gtfs.walkFields(u8(0x0f, 0x00), 0, 2, () => {}), /wire type/)
})

test("utf8 decodes multi-byte sequences", () => {
  // "E 105 St" is ASCII; test a real en dash (U+2013) as 3 bytes
  const bytes = u8(0x41, 0xe2, 0x80, 0x93, 0x42)
  assert.equal(Gtfs.utf8(bytes, 0, bytes.length), "A–B")
})
