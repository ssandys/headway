// GTFS-Realtime wire decoding for Headway.
//
// Loaded by Service.qml (import "Gtfs.js" as Gtfs) AND by node --test, and the
// two engines do not accept the same syntax. So: no I/O, no QML imports, no
// state between calls, and everything at top level is `var` or `function`.
// Never introduce arrow functions, spread, template literals, let/const,
// Object.assign, .includes( or .endsWith( in this file.
//
// `bytes` is always a Uint8Array. node's Buffer is one, and QML's
// `new Uint8Array(xhr.response)` is one, so one implementation serves both.

// Varints are accumulated by MULTIPLICATION, not by `<<`. JavaScript's bitwise
// operators truncate to 32 bits, and feed timestamps are ~1.79e9 seconds and
// climbing -- a `<<`-based reader silently returns garbage for them.
function readVarint(bytes, pos) {
  var value = 0
  var scale = 1
  for (;;) {
    // Without this guard, reading past the end yields `undefined`, and
    // `undefined & 0x80` is 0 -- so EOF reads as a valid terminator and the
    // function returns a plausible-looking wrong number instead of failing.
    // A truncated HTTP response is a realistic input here.
    if (pos >= bytes.length) {
      throw new Error("gtfs: varint runs past the end of the buffer")
    }
    var b = bytes[pos]
    pos = pos + 1
    value = value + (b & 0x7f) * scale
    scale = scale * 128
    if ((b & 0x80) === 0) return [value, pos]
  }
}

// visit(field, wire, varintValue, rangeStart, rangeEnd)
// For wire 2, rangeStart/rangeEnd bound the payload. Otherwise both are -1.
function walkFields(bytes, start, end, visit) {
  var pos = start
  while (pos < end) {
    var tagPair = readVarint(bytes, pos)
    var tag = tagPair[0]
    pos = tagPair[1]
    var field = Math.floor(tag / 8)
    var wire = tag % 8
    if (wire === 0) {
      var v = readVarint(bytes, pos)
      pos = v[1]
      visit(field, wire, v[0], -1, -1)
    } else if (wire === 2) {
      var lp = readVarint(bytes, pos)
      pos = lp[1]
      var stop = pos + lp[0]
      // A declared length longer than the remaining buffer would otherwise
      // hand the caller a range past the end, and every nested decode built
      // on it would read garbage without ever erroring.
      if (stop > end) {
        throw new Error("gtfs: length-delimited field runs past the end of the buffer")
      }
      visit(field, wire, 0, pos, stop)
      pos = stop
    } else if (wire === 5) {
      if (pos + 4 > end) {
        throw new Error("gtfs: fixed32 field runs past the end of the buffer")
      }
      visit(field, wire, 0, -1, -1)
      pos = pos + 4
    } else if (wire === 1) {
      if (pos + 8 > end) {
        throw new Error("gtfs: fixed64 field runs past the end of the buffer")
      }
      visit(field, wire, 0, -1, -1)
      pos = pos + 8
    } else {
      throw new Error("gtfs: unknown wire type " + wire)
    }
  }
}

// QML's engine has no TextDecoder, so UTF-8 is decoded by hand.
function utf8(bytes, start, end) {
  var out = ""
  var i = start
  while (i < end) {
    var c = bytes[i]
    if (c < 0x80) {
      out = out + String.fromCharCode(c)
      i = i + 1
    } else if (c < 0xe0) {
      out = out + String.fromCharCode(((c & 0x1f) * 64) + (bytes[i + 1] & 0x3f))
      i = i + 2
    } else if (c < 0xf0) {
      out = out + String.fromCharCode(
        ((c & 0x0f) * 4096) + ((bytes[i + 1] & 0x3f) * 64) + (bytes[i + 2] & 0x3f))
      i = i + 3
    } else {
      var cp = ((c & 0x07) * 262144) + ((bytes[i + 1] & 0x3f) * 4096) +
               ((bytes[i + 2] & 0x3f) * 64) + (bytes[i + 3] & 0x3f)
      out = out + String.fromCodePoint(cp)
      i = i + 4
    }
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    readVarint: readVarint,
    walkFields: walkFields,
    utf8: utf8
  }
}
