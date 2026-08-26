// Pure presentation helpers for Headway.
//
// Loaded by Panel.qml (import "Model.js" as Model) AND by node --test, and the
// two engines do not accept the same syntax. So: no I/O, no QML imports, no
// timers, no state between calls, and everything at top level is `var` or
// `function`. Never introduce arrow functions, spread, template literals,
// let/const, Object.assign, .includes( or .endsWith( in this file. The test
// file is exempt -- it only ever runs under node.
//
// One deliberate exception to that ban list: String.fromCodePoint, verified
// working in QML's engine and required for BAR_GLYPH.

// Duplicated from Gtfs.js rather than imported: QML cannot import one .js from
// another, and this is a three-line rule. tests/model.test.js pins the two
// against each other so they cannot drift.
function normalizeRoute(id) {
  if (!id) return ""
  if (id.length > 1 && id.charAt(id.length - 1) === "X") {
    return id.substring(0, id.length - 1)
  }
  return id
}

function isExpress(id) {
  return normalizeRoute(id) !== id
}

// Feeds do not partition cleanly -- an F trip appears in gtfs-g as well as
// gtfs-bdfm -- so a rider whose routes span both feeds would otherwise see one
// real train twice.
function dedupeTrips(tripLists) {
  var seen = {}
  var out = []
  for (var i = 0; i < tripLists.length; i++) {
    var list = tripLists[i] || []
    for (var j = 0; j < list.length; j++) {
      var t = list[j]
      // The fallback key includes the FEED index `i`, not just the position
      // within one feed. Without it, two different id-less trips on the same
      // route sitting at the same index in two feeds both key to "F:0", and
      // one is silently dropped — a real train disappearing from the
      // arrivals list. A fallback used when the dedup key is missing must
      // keep everything, never discard; every real trip carries a tripId
      // today (0 of 364 in the committed fixtures lack one), so this path
      // exists only for the day that stops being true.
      var key = t.tripId || ("pos:" + i + ":" + j + ":" + t.routeId)
      if (seen[key]) continue
      seen[key] = true
      out.push(t)
    }
  }
  return out
}

function savedWantsRoute(saved, routeId) {
  var wanted = normalizeRoute(routeId)
  for (var i = 0; i < saved.routes.length; i++) {
    if (normalizeRoute(saved.routes[i]) === wanted) return true
  }
  return false
}

function arrivalsFor(saved, trips, nowSec) {
  // Composed inline rather than via Stations.platformId, for the same reason
  // normalizeRoute is duplicated: QML cannot import one .js from another, so
  // Model.js has no way to call into Stations.js. Do not "fix" this by adding
  // an import -- it will not load in the shell. The two must simply agree, and
  // the rule is one concatenation.
  var platform = saved.stopId + saved.direction
  var out = []
  for (var i = 0; i < trips.length; i++) {
    var t = trips[i]
    if (!savedWantsRoute(saved, t.routeId)) continue
    for (var j = 0; j < t.stops.length; j++) {
      if (t.stops[j].stopId !== platform) continue
      var eta = t.stops[j].time - nowSec
      if (eta < 0) break
      var terminal = t.stops[t.stops.length - 1]
      out.push({
        routeId: normalizeRoute(t.routeId),
        express: isExpress(t.routeId),
        tripId: t.tripId,
        destinationStopId: terminal ? terminal.stopId : "",
        etaSec: eta
      })
      break
    }
  }
  out.sort(function (a, b) {
    if (a.etaSec !== b.etaSec) return a.etaSec - b.etaSec
    // Qt's V4 sort is NOT stable. Measured: 40 items across 8 tied groups
    // come back reordered, where node's has been stable since ES2019 — so no
    // test running only under node can catch this. Without an explicit
    // tie-breaker, two trains sharing an etaSec swap places between polls and
    // the panel visibly reshuffles. tripId is unique per train and is the
    // natural stable key.
    if (a.tripId < b.tripId) return -1
    if (a.tripId > b.tripId) return 1
    return 0
  })
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeRoute: normalizeRoute,
    isExpress: isExpress,
    dedupeTrips: dedupeTrips,
    arrivalsFor: arrivalsFor
  }
}
