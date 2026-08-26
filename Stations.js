// Queries over the generated station table.
//
// Loaded by Panel.qml/Service.qml AND by node --test. Pure: no I/O, no QML
// imports, no state between calls beyond the table handed to load(). Top level
// is `var`/`function` only -- no arrow functions, spread, template literals,
// let/const, Object.assign, .includes( or .endsWith(.
//
// QML cannot import one .js from another, so the table is injected:
//   QML  -> Stations.load(StationData.STATIONS)
//   node -> the same call, from the test or from collect.mjs

var TABLE = []

var BOROUGHS = {
  "M": "Manhattan", "Bk": "Brooklyn", "Q": "Queens",
  "Bx": "Bronx", "SI": "Staten Island"
}

// A direction whose label reads "Last Stop" is a terminal: no train departs
// that way, so it is never offered as a choice.
var TERMINAL_LABEL = "Last Stop"

function load(stations) {
  TABLE = stations || []
}

function all() {
  return TABLE
}

function byId(id) {
  for (var i = 0; i < TABLE.length; i++) {
    if (TABLE[i].id === id) return TABLE[i]
  }
  return null
}

function platformId(id, dir) {
  return id + dir
}

function parentOf(stopId) {
  if (!stopId) return ""
  var last = stopId.charAt(stopId.length - 1)
  if (last === "N" || last === "S") return stopId.substring(0, stopId.length - 1)
  return stopId
}

function toRadians(deg) {
  return deg * Math.PI / 180
}

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371
  var dLat = toRadians(lat2 - lat1)
  var dLon = toRadians(lon2 - lon1)
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function boroughName(code) {
  if (BOROUGHS.hasOwnProperty(code)) return BOROUGHS[code]
  return code
}

function directionsFor(station) {
  var out = []
  if (station.labelN && station.labelN !== TERMINAL_LABEL) {
    out.push({ dir: "N", label: station.labelN })
  }
  if (station.labelS && station.labelS !== TERMINAL_LABEL) {
    out.push({ dir: "S", label: station.labelS })
  }
  return out
}

// Returns rows carrying `distanceKm` (null with no origin). Ordered by
// distance when an origin is known, alphabetically otherwise -- then grouped
// so stations sharing a complex stay adjacent, since scattering them across
// the list is exactly what makes an ambiguous name hard to resolve.
function search(query, origin, limit) {
  var needle = (query || "").toLowerCase()
  var rows = []
  var i
  for (i = 0; i < TABLE.length; i++) {
    var s = TABLE[i]
    if (needle && s.name.toLowerCase().indexOf(needle) < 0) continue
    rows.push({
      id: s.id, name: s.name, routes: s.routes, borough: s.borough,
      line: s.line, complexId: s.complexId, lat: s.lat, lon: s.lon,
      labelN: s.labelN, labelS: s.labelS,
      distanceKm: origin ? haversineKm(origin.lat, origin.lon, s.lat, s.lon) : null
    })
  }
  rows.sort(function (a, b) {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      return a.distanceKm - b.distanceKm
    }
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })
  // Stable complex grouping: walk the sorted list, and whenever a complex is
  // first seen, pull its remaining members up behind it.
  var grouped = []
  var placed = {}
  for (i = 0; i < rows.length; i++) {
    if (placed[rows[i].id]) continue
    grouped.push(rows[i])
    placed[rows[i].id] = true
    if (!rows[i].complexId) continue
    for (var j = i + 1; j < rows.length; j++) {
      if (placed[rows[j].id]) continue
      if (rows[j].complexId !== rows[i].complexId) continue
      grouped.push(rows[j])
      placed[rows[j].id] = true
    }
  }
  if (limit && grouped.length > limit) return grouped.slice(0, limit)
  return grouped
}

if (typeof module !== "undefined") {
  module.exports = {
    load: load, all: all, byId: byId, platformId: platformId,
    parentOf: parentOf, haversineKm: haversineKm, boroughName: boroughName,
    directionsFor: directionsFor, search: search
  }
}
