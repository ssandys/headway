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
// Advances past one field's payload without interpreting it. Used only by
// skipGroup -- walkFields needs the payload itself, so it does its own bounds
// checks with field-specific messages.
function skipValue(bytes, pos, end, wire) {
  if (wire === 0) return readVarint(bytes, pos)[1]
  if (wire === 1) {
    if (pos + 8 > end) throw new Error("gtfs: fixed64 runs past the end of the buffer")
    return pos + 8
  }
  if (wire === 2) {
    var lp = readVarint(bytes, pos)
    var stop = lp[1] + lp[0]
    if (stop > end) {
      throw new Error("gtfs: length-delimited field runs past the end of the buffer")
    }
    return stop
  }
  if (wire === 5) {
    if (pos + 4 > end) throw new Error("gtfs: fixed32 runs past the end of the buffer")
    return pos + 4
  }
  throw new Error("gtfs: unknown wire type " + wire)
}

// Consumes a group's body and its matching END_GROUP, returning the position
// after it. `pos` is just past the START_GROUP tag.
//
// Depth-tracked rather than scanning for the first wire-4 tag: groups nest, and
// a naive scan would stop at an inner group's terminator, leaving the outer
// group's remaining body to be read as top-level fields.
function skipGroup(bytes, pos, end, groupField) {
  var depth = 1
  while (depth > 0) {
    if (pos >= end) {
      throw new Error("gtfs: unterminated group for field " + groupField)
    }
    var tagPair = readVarint(bytes, pos)
    pos = tagPair[1]
    var wire = tagPair[0] % 8
    if (wire === 3) {
      depth = depth + 1
    } else if (wire === 4) {
      depth = depth - 1
    } else {
      pos = skipValue(bytes, pos, end, wire)
    }
  }
  return pos
}

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
    } else if (wire === 3) {
      // START_GROUP. Skipped whole, never handed to `visit` -- a group's payload
      // is a tag stream rather than a byte range, so there is nothing a caller
      // expecting (start, stop) could do with it.
      //
      // This branch used to throw, and Service.qml turns any decode throw into
      // "feed unreachable" -- so ONE group-encoded field anywhere in a 233 KB
      // feed painted the bar red for a feed that had returned 200 with
      // perfectly good trip data. Wire 3 and 4 are legal proto2 and
      // GTFS-Realtime IS proto2: the NYCT and Mercury extensions attach through
      // `extend` blocks. Only 6 and 7 are genuinely invalid.
      pos = skipGroup(bytes, pos, end, field)
    } else if (wire === 4) {
      // An END_GROUP with no START_GROUP. skipGroup consumes matched pairs, so
      // reaching one here means the stream is malformed.
      throw new Error("gtfs: unmatched END_GROUP for field " + field)
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

// Field numbers, confirmed against live NYCT output:
//   FeedMessage.header=1 (FeedHeader.timestamp=3), FeedMessage.entity=2
//   FeedEntity.trip_update=3, FeedEntity.alert=5
//   TripUpdate.trip=1 (TripDescriptor.trip_id=1, route_id=5)
//   TripUpdate.stop_time_update=2
//   StopTimeUpdate.arrival=2, departure=3, stop_id=4
//   StopTimeEvent.time=2
// Every unrecognised field -- including the whole NYCT extension block -- is
// skipped by walkFields, so an upstream addition cannot break this decoder.
// That now holds for group-encoded fields too (wire 3/4, legal proto2, which
// GTFS-Realtime is). It did NOT before: walkFields threw on them, and a decode
// throw becomes "feed unreachable", so one group field would have discarded a
// whole feed that returned 200 with good data. Only wire 6 and 7 still throw,
// and those are genuinely invalid.
function decodeStopTimeEvent(bytes, start, end) {
  var time = 0
  walkFields(bytes, start, end, function (f, w, v) {
    if (f === 2 && w === 0) time = v
  })
  return time
}

function decodeStopTimeUpdate(bytes, start, end) {
  var stopId = ""
  var arrival = 0
  var departure = 0
  walkFields(bytes, start, end, function (f, w, v, s, e) {
    if (f === 4 && w === 2) stopId = utf8(bytes, s, e)
    else if (f === 2 && w === 2) arrival = decodeStopTimeEvent(bytes, s, e)
    else if (f === 3 && w === 2) departure = decodeStopTimeEvent(bytes, s, e)
  })
  // Riders board at departure; fall back to arrival, which is all a terminal
  // arrival carries. A stop with neither is not a boarding opportunity.
  var time = departure > 0 ? departure : arrival
  if (!stopId || time <= 0) return null
  return { stopId: stopId, time: time }
}

function decodeTripUpdate(bytes, start, end) {
  var tripId = ""
  var routeId = ""
  var stops = []
  walkFields(bytes, start, end, function (f, w, v, s, e) {
    if (f === 1 && w === 2) {
      walkFields(bytes, s, e, function (df, dw, dv, ds, de) {
        if (df === 1 && dw === 2) tripId = utf8(bytes, ds, de)
        else if (df === 5 && dw === 2) routeId = utf8(bytes, ds, de)
      })
    } else if (f === 2 && w === 2) {
      var stop = decodeStopTimeUpdate(bytes, s, e)
      if (stop) stops.push(stop)
    }
  })
  if (!routeId) return null
  return { tripId: tripId, routeId: routeId, stops: stops }
}

function decodeTripUpdates(bytes) {
  var result = { timestamp: 0, trips: [] }
  if (!bytes || bytes.length === 0) return result
  walkFields(bytes, 0, bytes.length, function (f, w, v, s, e) {
    if (f === 1 && w === 2) {
      walkFields(bytes, s, e, function (hf, hw, hv) {
        if (hf === 3 && hw === 0) result.timestamp = hv
      })
    } else if (f === 2 && w === 2) {
      walkFields(bytes, s, e, function (ef, ew, ev, es, ee) {
        if (ef !== 3 || ew !== 2) return
        var trip = decodeTripUpdate(bytes, es, ee)
        if (trip) result.trips.push(trip)
      })
    }
  })
  return result
}

// Alert.active_period=1 (TimeRange.start=1, end=2), informed_entity=5
// (EntitySelector.route_id=2), header_text=10 (TranslatedString.translation=1,
// Translation.text=1), and the MTA Mercury extension at 1001 whose sub-field 3
// is alert_type.
//
// Alert.effect(7) and Alert.cause(6) are NOT read: they are populated on zero
// alerts in practice, and a severity rule built on them never fires.
var MERCURY_EXT = 1001
var MERCURY_ALERT_TYPE = 3

function decodeAlert(bytes, start, end) {
  var headerText = ""
  var alertType = ""
  var routes = []
  var periods = []
  walkFields(bytes, start, end, function (f, w, v, s, e) {
    if (f === 1 && w === 2) {
      var period = { start: 0, end: 0 }
      walkFields(bytes, s, e, function (pf, pw, pv) {
        if (pf === 1 && pw === 0) period.start = pv
        else if (pf === 2 && pw === 0) period.end = pv
      })
      periods.push(period)
    } else if (f === 5 && w === 2) {
      walkFields(bytes, s, e, function (sf, sw, sv, ss, se) {
        if (sf !== 2 || sw !== 2) return
        var route = utf8(bytes, ss, se)
        if (routes.indexOf(route) < 0) routes.push(route)
      })
    } else if (f === 10 && w === 2 && !headerText) {
      walkFields(bytes, s, e, function (tf, tw, tv, ts, te) {
        if (tf !== 1 || tw !== 2) return
        walkFields(bytes, ts, te, function (nf, nw, nv, ns, ne) {
          if (nf === 1 && nw === 2 && !headerText) headerText = utf8(bytes, ns, ne)
        })
      })
    } else if (f === MERCURY_EXT && w === 2) {
      walkFields(bytes, s, e, function (mf, mw, mv, ms, me) {
        if (mf === MERCURY_ALERT_TYPE && mw === 2) alertType = utf8(bytes, ms, me)
      })
    }
  })
  return {
    headerText: headerText, alertType: alertType,
    routes: routes, periods: periods
  }
}

function decodeAlerts(bytes) {
  var result = { timestamp: 0, alerts: [] }
  if (!bytes || bytes.length === 0) return result
  walkFields(bytes, 0, bytes.length, function (f, w, v, s, e) {
    if (f === 1 && w === 2) {
      walkFields(bytes, s, e, function (hf, hw, hv) {
        if (hf === 3 && hw === 0) result.timestamp = hv
      })
    } else if (f === 2 && w === 2) {
      var id = ""
      var body = null
      walkFields(bytes, s, e, function (ef, ew, ev, es, ee) {
        if (ef === 1 && ew === 2) id = utf8(bytes, es, ee)
        else if (ef === 5 && ew === 2) body = [es, ee]
      })
      if (!body) return
      var alert = decodeAlert(bytes, body[0], body[1])
      alert.id = id
      result.alerts.push(alert)
    }
  })
  return result
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
    ALERTS_URL: ALERTS_URL,
    decodeTripUpdates: decodeTripUpdates,
    decodeAlerts: decodeAlerts
  }
}
