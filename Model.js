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

// Severity is derived from the Mercury extension's alert_type, because GTFS
// `effect` and `cause` are populated on zero alerts in practice.
//
// The "Planned - " prefix is the single most important thing here: it is 144
// of 199 alerts, all scheduled engineering work, much of it for weekends still
// days away. Colouring the bar for those would pin the glyph amber forever.
var ALERT_RED = { "No Scheduled Service": true }
var ALERT_AMBER = { "Delays": true, "Reduced Service": true }
var PLANNED_PREFIX = "Planned - "

function classifyAlert(alertType) {
  // A typeof check, not merely a falsy guard. `alertType` arrives from the
  // decoder, and any truthy non-string makes `.substring` throw — a throw
  // that escapes through worstAlertClass and barState into a QML property
  // binding, taking out the WHOLE BAR rather than one alert row. A
  // misclassification degrades one row; an exception removes the widget.
  // alertIsActive and alertsFor already degrade gracefully on malformed
  // input; this was the only function in the file that did not.
  if (typeof alertType !== "string" || !alertType) return "info"
  if (alertType.substring(0, PLANNED_PREFIX.length) === PLANNED_PREFIX) return "planned"
  // hasOwnProperty, NOT a bare lookup. `ALERT_RED[alertType]` walks the
  // prototype chain, so an alertType of "constructor", "toString" or
  // "__proto__" returns a truthy inherited member and classifies as RED —
  // breaking the one safety property this function has, that an unrecognised
  // type is never red. alertType is upstream feed data, not a curated
  // constant. Gtfs.js and Stations.js already guard their lookup tables the
  // same way.
  if (ALERT_RED.hasOwnProperty(alertType)) return "red"
  if (ALERT_AMBER.hasOwnProperty(alertType)) return "amber"
  // Unrecognised types default to info deliberately. New ones appear without
  // warning, and a surprise value must degrade to a quiet panel row.
  return "info"
}

// An alert with no period, or an open-ended one, is ongoing. A planned alert
// is published well before it applies, so this filter is what stops next
// weekend's work from reading as today's disruption.
function alertIsActive(alert, nowSec) {
  var periods = alert.periods || []
  if (periods.length === 0) return true
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i]
    if (p.start && nowSec < p.start) continue
    if (p.end && nowSec > p.end) continue
    return true
  }
  return false
}

function alertsFor(routes, alerts, nowSec) {
  var out = []
  for (var i = 0; i < alerts.length; i++) {
    var a = alerts[i]
    if (!alertIsActive(a, nowSec)) continue
    var hit = false
    for (var j = 0; j < (a.routes || []).length; j++) {
      for (var k = 0; k < routes.length; k++) {
        if (normalizeRoute(a.routes[j]) === normalizeRoute(routes[k])) hit = true
      }
    }
    if (hit) out.push(a)
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeRoute: normalizeRoute,
    isExpress: isExpress,
    dedupeTrips: dedupeTrips,
    arrivalsFor: arrivalsFor,
    classifyAlert: classifyAlert,
    alertIsActive: alertIsActive,
    alertsFor: alertsFor
  }
}
