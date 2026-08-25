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
  // U+F0BA4 -- md-hat_fedora, the plugin's own bar glyph -- so this case
  // doubles as proof the engine round-trips the exact codepoint Model.js
  // builds in a later task.
  const bytes = u8(0xf3, 0xb0, 0xae, 0xa4)
  const decoded = Gtfs.utf8(bytes, 0, bytes.length)
  assert.equal(decoded.codePointAt(0), 0xF0BA4)
  assert.equal(decoded.length, 2, "an astral char is two UTF-16 units")
})
