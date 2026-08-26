// Prints the exact snapshot the panel works from. Debugging affordance only --
// the widget never runs this; it does the same work in Service.qml.
//
//   node scripts/collect.mjs                     # uses saved stations
//   node scripts/collect.mjs L08 L N             # ad hoc: stop, routes, dir
//
// Pipe through `jq .` for something readable.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);
const Gtfs = require_("../Gtfs.js");
const Model = require_("../Model.js");
const Stations = require_("../Stations.js");
const { STATIONS } = require_("../StationData.js");
Stations.load(STATIONS);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(process.env.HOME, ".local/state/omarchy/settings/headway.json");

function savedStations() {
  const [stopId, routes, direction] = process.argv.slice(2);
  if (stopId) {
    // `routes` is required alongside a stopId. Without this guard,
    // `collect.mjs L08` throws "Cannot read properties of undefined
    // (reading 'split')" — a stack trace where a usage message belongs.
    if (!routes) {
      console.error("usage: node scripts/collect.mjs [<stopId> <routes,comma,separated> [N|S]]");
      console.error("   eg: node scripts/collect.mjs L08 L N");
      process.exit(2);
    }
    return { activeStationId: stopId,
      stations: [{ stopId, routes: routes.split(","), direction: direction || "N" }] };
  }
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { activeStationId: null, stations: [] };
  }
}

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

const state = savedStations();
const active = state.stations.find((s) => s.stopId === state.activeStationId)
  || state.stations[0] || null;

const snapshot = { schema: 1, ok: true, error: null, feedTimestamp: 0,
  staleAfterSec: 180, station: null, saved: active, arrivals: [], alerts: [] };

if (!active) {
  snapshot.error = "no saved stations";
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

try {
  const feeds = Gtfs.feedsForRoutes(active.routes);
  const lists = [];
  for (const feed of feeds) {
    const decoded = Gtfs.decodeTripUpdates(await getBytes(Gtfs.feedUrl(feed)));
    snapshot.feedTimestamp = Math.max(snapshot.feedTimestamp, decoded.timestamp);
    lists.push(decoded.trips);
  }
  const trips = Model.dedupeTrips(lists);
  const now = Math.floor(Date.now() / 1000);

  snapshot.station = Stations.byId(active.stopId);
  snapshot.arrivals = Model.arrivalsFor(active, trips, now).map((a) => ({
    ...a,
    destination: (Stations.byId(Stations.parentOf(a.destinationStopId)) || {}).name || null,
    countdown: Model.formatCountdown(a.etaSec),
  }));

  const alerts = Gtfs.decodeAlerts(await getBytes(Gtfs.ALERTS_URL));
  snapshot.alerts = Model.alertsFor(active.routes, alerts.alerts, now).map((a) => ({
    id: a.id, alertType: a.alertType, severity: Model.classifyAlert(a.alertType),
    routes: a.routes, headerText: a.headerText,
  }));

  snapshot.feedCount = feeds.length;
  snapshot.bar = Model.barState(snapshot, now);
  snapshot.tooltip = Model.tooltipText(snapshot, now);
} catch (e) {
  snapshot.ok = false;
  snapshot.error = String(e && e.message ? e.message : e);
}

console.log(JSON.stringify(snapshot, null, 2));
