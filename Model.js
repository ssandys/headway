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
      // hasOwnProperty, not a bare lookup: `seen[key]` walks the prototype
      // chain, so a tripId of "constructor" or "toString" reads as already-seen
      // and a real train vanishes from the arrivals list. Trip ids come from
      // the feed, so this is upstream data.
      if (Object.prototype.hasOwnProperty.call(seen, key)) continue
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
// The "Planned - " prefix is the single most important thing here: it is 151
// of 195 alerts, all scheduled engineering work, much of it for weekends still
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

// The saved route an alert belongs to, or "" when it cannot be attributed.
// Normalizes both sides, so a 6X alert lands on the 6.
function matchedRouteOf(routes, alert) {
  var mine = routes || []
  var theirs = (alert && alert.routes) || []
  for (var i = 0; i < mine.length; i++) {
    for (var j = 0; j < theirs.length; j++) {
      if (normalizeRoute(theirs[j]) === normalizeRoute(mine[i])) return mine[i]
    }
  }
  return ""
}

// alertsFor, plus the route each alert belongs to, ordered by the rider's own
// route order rather than the feed's.
//
// The spec asks for alerts grouped by route; without this they render as a flat
// wall of unattributed sentences, which at an interchange is most of the panel.
// It lives here rather than in a QML binding because a binding cannot be tested,
// and because sorting inside one would rebuild the Repeater's model on every
// evaluation.
//
// An alert that cannot be attributed is KEPT with an empty matchedRoute.
// alertsFor has already filtered to saved routes, so a blank means an id shape
// this code did not expect -- and dropping the row would hide a real service
// alert to avoid an unlabelled bullet.
function alertsForDisplay(routes, alerts, nowSec) {
  var mine = routes || []
  var live = alertsFor(mine, alerts, nowSec)
  var out = []
  for (var i = 0; i < live.length; i++) {
    var a = live[i]
    out.push({
      id: a.id, alertType: a.alertType, headerText: a.headerText,
      routes: a.routes, periods: a.periods,
      matchedRoute: matchedRouteOf(mine, a)
    })
  }
  out.sort(function (x, y) {
    var xi = indexOfRoute(mine, x.matchedRoute)
    var yi = indexOfRoute(mine, y.matchedRoute)
    if (xi !== yi) return xi - yi
    // Total order: V4's sort is not stable, and alert rows that swap places
    // every minute are worse than rows in an odd order.
    if (x.id < y.id) return -1
    if (x.id > y.id) return 1
    return 0
  })
  return out
}

// Unattributed alerts sort last, not first: a blank matchedRoute is a fallback,
// not a category anyone is looking for.
function indexOfRoute(routes, route) {
  if (!route) return routes.length
  for (var i = 0; i < routes.length; i++) {
    if (routes[i] === route) return i
  }
  return routes.length
}

// md-account_tie_voice -- the conductor announcing the next stop. Built with
// fromCodePoint, NEVER pasted as a literal: a literal astral character does not
// survive every editing path, and the failure mode is a widget that is simply
// invisible with nothing logged. Presence verified in VictorMono Nerd Font's
// cmap, which is what "monospace" resolves to here.
var BAR_GLYPH = String.fromCodePoint(0xF1308)

var COLOR_WARN = "#e0af68"
var COLOR_ERROR = "#f7768e"

// Official MTA trunk colours, keyed by the route ids the FEEDS emit rather than
// the letters riders read off a sign. GS, FS and H are the Grand Central,
// Franklin Av and Rockaway Park shuttles -- all verified in the live feeds
// during the Gtfs work -- so keying on "S" alone would leave every shuttle
// uncoloured.
var ROUTE_COLORS = {
  "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
  "4": "#00933C", "5": "#00933C", "6": "#00933C",
  "7": "#B933AD",
  "A": "#0039A6", "C": "#0039A6", "E": "#0039A6",
  "B": "#FF6319", "D": "#FF6319", "F": "#FF6319", "M": "#FF6319",
  "G": "#6CBE45",
  "J": "#996633", "Z": "#996633",
  "L": "#A7A9AC",
  "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
  "S": "#808183", "GS": "#808183", "FS": "#808183", "H": "#808183",
  // Staten Island Railway shares the ACE blue in the MTA palette.
  "SI": "#0039A6"
}

// A neutral grey, deliberately dark enough to take white text. An unknown route
// must still paint a visible disc: an empty colour string renders as a hole with
// a letter floating in it, which reads as a rendering bug rather than as an
// unrecognised route.
var ROUTE_COLOR_FALLBACK = "#6E7681"

function routeColor(id) {
  // normalizeRoute first, so 6X resolves to the 6's green rather than falling
  // through to the fallback -- otherwise every express train looks unknown.
  var key = normalizeRoute(id)
  // hasOwnProperty, not a bare lookup: "constructor" and "__proto__" resolve up
  // the prototype chain and would hand QML a function where a colour belongs.
  // The same class of bug that classifyAlert had.
  if (key && ROUTE_COLORS.hasOwnProperty(key)) return ROUTE_COLORS[key]
  return ROUTE_COLOR_FALLBACK
}

// sRGB -> linear, per WCAG 2.x relative luminance.
function channelLuminance(c) {
  var s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex) {
  return 0.2126 * channelLuminance(parseInt(hex.substring(1, 3), 16)) +
         0.7152 * channelLuminance(parseInt(hex.substring(3, 5), 16)) +
         0.0722 * channelLuminance(parseInt(hex.substring(5, 7), 16))
}

// A luminance THRESHOLD, not the higher of the two WCAG contrast ratios.
// Measured: maximising contrast puts BLACK text on the red 1/2/3 bullet
// (contrast 5.19 vs white's 4.05), and on the green, the orange and the
// shuttle grey. That is mathematically better and visibly wrong -- nobody has
// ever seen a black 1 in a red disc.
//
// 0.35 is not a knife-edge. The measured luminances leave an empty band between
// the orange at 0.303 and the light grey at 0.396, and the threshold sits in it.
//
// This agrees with the MTA everywhere except the G and the L, where the MTA
// prints white on a disc too light to carry it. At caption size on a ~16px
// disc, legibility outranks brand fidelity.
var LIGHT_DISC_LUMINANCE = 0.35

function routeTextColor(id) {
  return relativeLuminance(routeColor(id)) > LIGHT_DISC_LUMINANCE
    ? "#000000" : "#FFFFFF"
}

function formatCountdown(etaSec) {
  if (etaSec < 60) return "now"
  return String(Math.floor(etaSec / 60))
}

// Deliberately NOT formatCountdown. The bar badge is a circle sized for two
// characters, copied from galley, and "now" is three -- it would be clipped in
// exactly the state that matters most. The panel's arrival rows keep the word,
// where there is room for it and it reads better than a symbol. Collapsing
// these two back into one function reintroduces the clipping.
// Cycles a saved station's direction through the ones it ACTUALLY has.
//
// Not an N<->S flip. 33 stations are terminals with a single usable direction --
// Van Cortlandt Park-242 St, South Ferry, Wakefield-241 St -- and flipping one
// of those lands on a direction with no trains, leaving the widget blank with
// nothing to explain it. `available` comes from Stations.directionsFor, which
// already excludes the terminal label.
//
// An unrecognised current direction falls to the first available rather than
// staying put, so a state file carrying a stale direction can be corrected by
// clicking rather than by deleting the station.
function nextDirection(available, current) {
  var dirs = available || []
  if (dirs.length < 2) return current
  for (var i = 0; i < dirs.length; i++) {
    if (dirs[i] === current) return dirs[(i + 1) % dirs.length]
  }
  return dirs[0]
}

// The per-station route filter. Returns the selection with `route` toggled,
// rebuilt in the STATION's own route order rather than appended -- so
// deselecting the 5 at Union Sq and putting it back gives 4,5,6 again and not
// 4,6,5, and the bullets never reshuffle under the cursor.
//
// Never returns empty. A saved station with no routes can never produce an
// arrival, so the widget would sit blank with nothing explaining why;
// deselecting the last route is a no-op instead of a reachable dead state.
function toggleRoute(all, picked, route) {
  var table = all || []
  var current = picked || []
  var next = []
  for (var i = 0; i < table.length; i++) {
    var isTarget = table[i] === route
    var wasIn = false
    for (var j = 0; j < current.length; j++) {
      if (current[j] === table[i]) { wasIn = true; break }
    }
    if (isTarget ? !wasIn : wasIn) next.push(table[i])
  }
  if (next.length === 0) return current
  return next
}

// The panel header's right-hand slot. Kept here rather than inline in the QML
// so the wording and the stale boundary are unit-tested -- the same reason
// barState and tooltipText live in this file.
function feedAgeText(feedTimestamp, nowSec, staleAfterSec) {
  if (!feedTimestamp || feedTimestamp <= 0) return ""
  // Clamped at zero. nowSec is the LOCAL clock and feedTimestamp is the MTA's,
  // so NTP stepping this machine backwards would otherwise render a negative
  // age -- "updated -4s ago".
  var age = nowSec - feedTimestamp
  if (age < 0) age = 0
  var phrase
  if (age < 60) phrase = age + "s"
  else if (age < 3600) phrase = Math.floor(age / 60) + "m"
  else phrase = Math.floor(age / 3600) + "h"
  // "updated" is exactly the wrong word for data that has stopped arriving, so
  // past the stale boundary the wording changes rather than just the colour.
  if (staleAfterSec > 0 && age > staleAfterSec) return "stale - " + phrase + " old"
  return "updated " + phrase + " ago"
}

// Distance is measured in km -- haversineKm is the natural unit for the formula
// and what Stations.search sorts on -- and converted only for display. That
// keeps unit choice a property of this one function.
//
// TODO: make this a plugin setting. The unit is hardcoded imperial today
// because the target machine is in New York; the manifest schema is where a
// `distanceUnit` option would go, and every caller already routes through
// here, so nothing else would need to change.
var MILES_PER_KM = 0.621371

function distanceText(km) {
  // An explicit null/undefined check, NOT a falsy one: 0 km is a real answer --
  // the station you are standing on -- and a falsy test would hide the
  // distance on the nearest station of all.
  if (km === null || km === undefined) return ""
  return (km * MILES_PER_KM).toFixed(1) + " mi"
}

function badgeText(etaSec) {
  // Escaped, not pasted -- U+2022 is BMP so it would survive, but this file
  // already learned that lesson the hard way with BAR_GLYPH.
  if (etaSec < 60) return "\u2022"
  return String(Math.floor(etaSec / 60))
}

function directionLabelOf(station, direction) {
  if (!station) return ""
  return direction === "N" ? station.labelN : station.labelS
}

function worstAlertClass(snapshot, nowSec) {
  // Guards saved.routes, not just saved. A state-file entry without `routes`
  // reaches alertsFor, which dereferences routes.length -- and this runs inside
  // the barState and tooltip property BINDINGS, where a throw removes the whole
  // widget rather than one row. headway.json is plain JSON the user is invited
  // to inspect, so its shape is upstream data, not an internal invariant.
  var routes = (snapshot.saved && snapshot.saved.routes) ? snapshot.saved.routes : []
  var live = alertsFor(routes, snapshot.alerts || [], nowSec)
  var worst = "info"
  for (var i = 0; i < live.length; i++) {
    var c = classifyAlert(live[i].alertType)
    if (c === "red") return "red"
    if (c === "amber") worst = "amber"
  }
  return worst
}

function barState(snapshot, nowSec) {
  var badge = ""
  if (snapshot.ok && snapshot.arrivals && snapshot.arrivals.length > 0) {
    badge = badgeText(snapshot.arrivals[0].etaSec)
  }
  if (!snapshot.ok) return { badge: "", severity: "error" }
  var cls = worstAlertClass(snapshot, nowSec)
  if (cls === "red") return { badge: badge, severity: "error" }
  var age = nowSec - snapshot.feedTimestamp
  if (snapshot.feedTimestamp > 0 && age > snapshot.staleAfterSec) {
    return { badge: badge, severity: "warn" }
  }
  if (cls === "amber") return { badge: badge, severity: "warn" }
  return { badge: badge, severity: "ok" }
}

function tooltipText(snapshot, nowSec) {
  if (!snapshot.saved || !snapshot.station) return "Headway - no station saved"
  // The ROUTES are named, which the spec's format has always called for and
  // which was missing entirely. It only became meaningful once the route filter
  // existed: before that every route the station served was watched, so there
  // was no subset worth printing. All of them are listed rather than just the
  // first -- naming one of three is a quieter kind of wrong than naming none.
  var watched = snapshot.saved.routes || []
  var head = snapshot.station.name + " - " +
             (watched.length > 0 ? watched.join(" ") + " " : "") +
             directionLabelOf(snapshot.station, snapshot.saved.direction)
  if (!snapshot.ok) return head + " - feed unreachable"
  var routes = snapshot.saved.routes
  var live = alertsFor(routes, snapshot.alerts || [], nowSec)
  for (var i = 0; i < live.length; i++) {
    var cls = classifyAlert(live[i].alertType)
    if (cls === "red" || cls === "amber") {
      return head + " - " + (live[i].headerText || live[i].alertType)
    }
  }
  var arrivals = snapshot.arrivals || []
  if (arrivals.length === 0) return head + " - no trains scheduled"
  var mins = []
  for (var j = 0; j < arrivals.length && j < 3; j++) {
    mins.push(formatCountdown(arrivals[j].etaSec))
  }
  return head + " - " + mins.join(", ") + " min"
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeRoute: normalizeRoute,
    isExpress: isExpress,
    dedupeTrips: dedupeTrips,
    arrivalsFor: arrivalsFor,
    classifyAlert: classifyAlert,
    alertIsActive: alertIsActive,
    alertsFor: alertsFor,
    BAR_GLYPH: BAR_GLYPH,
    COLOR_WARN: COLOR_WARN,
    COLOR_ERROR: COLOR_ERROR,
    ROUTE_COLOR_FALLBACK: ROUTE_COLOR_FALLBACK,
    routeColor: routeColor,
    routeTextColor: routeTextColor,
    formatCountdown: formatCountdown,
    badgeText: badgeText,
    feedAgeText: feedAgeText,
    distanceText: distanceText,
    toggleRoute: toggleRoute,
    nextDirection: nextDirection,
    matchedRouteOf: matchedRouteOf,
    alertsForDisplay: alertsForDisplay,
    directionLabelOf: directionLabelOf,
    barState: barState,
    tooltipText: tooltipText
  }
}
