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

var FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/"
var ALERTS_URL = FEED_BASE + "camsys%2Fsubway-alerts"

// Verified by decoding every feed and collecting the route_ids it actually
// emits -- not from any document, which is how the shuttle placements were
// settled. Express variants (6X, 7X) are separate ids in the feed and are
// deliberately absent here: feedsForRoutes normalizes before lookup.
var FEEDS = {
  "gtfs": ["1", "2", "3", "4", "5", "6", "7", "GS"],
  "gtfs-ace": ["A", "C", "E", "H"],
  "gtfs-bdfm": ["B", "D", "F", "M", "FS"],
  "gtfs-g": ["G"],
  "gtfs-jz": ["J", "Z"],
  "gtfs-nqrw": ["N", "Q", "R", "W"],
  "gtfs-l": ["L"],
  "gtfs-si": ["SI"]
}

// "6X" -> "6". The suffix rule requires a longer id, so a hypothetical route
// literally named "X" is left intact rather than normalized to "".
function normalizeRoute(id) {
  if (!id) return ""
  if (id.length > 1 && id.charAt(id.length - 1) === "X") {
    return id.substring(0, id.length - 1)
  }
  return id
}

// Only the feeds covering the given routes. Riding the L means fetching 23 KB
// rather than the 636 KB of all eight.
function feedsForRoutes(routes) {
  var wanted = []
  var i, j
  for (i = 0; i < routes.length; i++) {
    var route = normalizeRoute(routes[i])
    for (var feed in FEEDS) {
      if (!FEEDS.hasOwnProperty(feed)) continue
      if (FEEDS[feed].indexOf(route) < 0) continue
      var already = false
      for (j = 0; j < wanted.length; j++) if (wanted[j] === feed) already = true
      if (!already) wanted.push(feed)
    }
  }
  return wanted
}

function feedUrl(feed) {
  return FEED_BASE + "nyct%2F" + feed
}

if (typeof module !== "undefined") {
  module.exports = {
    readVarint: readVarint,
    walkFields: walkFields,
    utf8: utf8,
    FEEDS: FEEDS,
    normalizeRoute: normalizeRoute,
    feedsForRoutes: feedsForRoutes,
    feedUrl: feedUrl,
    ALERTS_URL: ALERTS_URL
  }
}
