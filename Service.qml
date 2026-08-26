import QtQuick
import Quickshell
import Quickshell.Io
import "Gtfs.js" as Gtfs
import "Model.js" as Model
import "Stations.js" as Stations
import "StationData.js" as StationData

Item {
  id: root

  // Injected by Panel.qml. Ui/Panel.qml declares `settings`; this Item does
  // not, so it must be handed down explicitly.
  property var settings: ({})

  function setting(key, fallback) {
    var value = root.settings ? root.settings[key] : undefined
    return value === undefined || value === null ? fallback : value
  }

  readonly property int openInterval: setting("pollIntervalOpenSec", 30)
  readonly property int idleInterval: setting("pollIntervalIdleSec", 90)
  readonly property int alertsInterval: setting("alertsIntervalSec", 300)
  readonly property int staleAfterSec: setting("staleAfterSec", 180)
  readonly property int trainsPerDirection: setting("trainsPerDirection", 3)
  readonly property bool notifyRouteAlert: setting("notifyRouteAlert", true)
  readonly property bool notifyFeedStale: setting("notifyFeedStale", true)

  property bool panelOpen: false

  property bool ok: true
  property string error: ""
  property int feedTimestamp: 0
  property var arrivals: []
  property var alerts: []
  property var stations: []
  property string activeStationId: ""
  property int nowSec: 0
  property bool loading: false

  // Ticks every second so countdowns move without refetching. Arrival times are
  // absolute epoch seconds, so this is the whole reason a 30s poll still reads
  // as live.
  Timer {
    interval: 1000; running: true; repeat: true
    onTriggered: {
      root.nowSec = Math.floor(Date.now() / 1000)
      root.sweepInflight()
    }
  }

  Component.onCompleted: root.nowSec = Math.floor(Date.now() / 1000)

  readonly property var saved: {
    for (var i = 0; i < root.stations.length; i++) {
      if (root.stations[i].stopId === root.activeStationId) return root.stations[i]
    }
    return root.stations.length > 0 ? root.stations[0] : null
  }

  readonly property var station: root.saved ? Stations.byId(StationData.STATIONS, root.saved.stopId) : null

  readonly property var snapshot: ({
    ok: root.ok, feedTimestamp: root.feedTimestamp, staleAfterSec: root.staleAfterSec,
    station: root.station, saved: root.saved, arrivals: root.arrivals, alerts: root.alerts
  })

  // Named barState, NOT bar. `bar` is the host Bar object throughout this
  // codebase (Ui/Panel.qml injects it, WidgetButton and KeyboardPanel both
  // take it), so a property called `bar` here would read as that everywhere
  // it is used in Panel.qml.
  // Alerts are filtered against a MINUTE-resolution clock, never nowSec.
  // Panel.qml's alert Repeater binds to this, and a Repeater's `model` is a
  // `var` that QML compares BY REFERENCE — so a fresh array on every 1s tick
  // would destroy and recreate every alert row once a second. Active-period
  // boundaries move on a human timescale, so minute resolution costs nothing
  // and the rows stay put.
  readonly property int nowMinute: Math.floor(root.nowSec / 60)

  // alertsForDisplay, not alertsFor: each row carries the saved route it belongs
  // to, and the list is ordered by the rider's own route order. The spec asks
  // for alerts grouped by route; a flat list of unattributed sentences is most
  // of the panel at an interchange.
  readonly property var liveAlerts: root.saved
    ? Model.alertsForDisplay(root.saved.routes, root.alerts, root.nowMinute * 60)
    : []

  readonly property var barState: Model.barState(root.snapshot, root.nowSec)
  readonly property string tooltip: Model.tooltipText(root.snapshot, root.nowSec)

  // ---- persisted state -------------------------------------------------
  // Plugin settings are READ-ONLY -- the shell exposes no write-back API -- so
  // saved stations need their own file. This sits beside weather.json and
  // flight-radar.json, the convention Omarchy already uses for exactly this.
  FileView {
    id: stateFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/headway.json"
    watchChanges: true
    printErrors: false
    atomicWrites: true
    onLoaded: root.loadState()
    // Our own writeState fires this watcher, and FileView.text() still returns
    // the PREVIOUS file content when it does. MEASURED: saving a fourth station
    // logged `writeState stations=4 active=L14` and then, in the same second,
    // `loadState -> stations=3 active=640` -- the reload silently undoing the
    // save. That is why adding a station appeared to need two clicks. The first
    // was reverted, and the second only worked because by then the first
    // write had reached the disk.
    //
    // A COUNTER, not a bool. Two writeState() calls landing before the first
    // watcher event set one flag twice; event 1 consumed it and event 2 ran
    // loadState() -- the exact path documented above as returning stale content
    // and undoing a save. Clicking saved station A then B in quick succession
    // was enough. Consumed, not latched, so a failed write still costs at most
    // one missed external edit rather than deafening the watcher for good.
    onFileChanged: {
      if (root.selfWrites > 0) { root.selfWrites = root.selfWrites - 1; return }
      root.loadState()
    }
    onLoadFailed: { root.stations = []; root.activeStationId = "" }
  }

  // Entries are VALIDATED, not trusted. headway.json is plain JSON the README
  // invites the user to inspect, so its contents are upstream data. An entry
  // without `routes` reaches Model.alertsFor through the barState and tooltip
  // property bindings, and a throw in a binding removes the whole widget rather
  // than one row. Model.worstAlertClass guards this too; both halves are wanted,
  // and this is the half that keeps junk out of `refresh()` as well.
  function validStation(e) {
    if (!e || typeof e.stopId !== "string" || e.stopId === "") return false
    if (e.direction !== "N" && e.direction !== "S") return false
    if (!e.routes || typeof e.routes.length !== "number") return false
    return true
  }

  function loadState() {
    var loaded = []
    var active = ""
    try {
      var data = JSON.parse(stateFile.text())
      var raw = data.stations || []
      for (var i = 0; i < raw.length; i++) {
        if (root.validStation(raw[i])) loaded.push(raw[i])
      }
      active = data.activeStationId || ""
    } catch (e) {
      loaded = []
      active = ""
    }
    root.stations = loaded
    root.activeStationId = active
    // REQUIRED. The poll Timer has triggeredOnStart, so refresh() runs once at
    // component completion -- but FileView loads asynchronously AFTER that, so
    // that first refresh sees no saved station and early-returns. Without this
    // call nothing re-triggers a fetch and the bar stays blank until the next
    // idle tick, which is up to pollIntervalIdleSec (90s) after every shell
    // start. Observed on every redeploy during development.
    root.refresh()
  }

  // Incremented before every setText, decremented by each watcher event it
  // causes. See stateFile.onFileChanged for why this is a count and not a flag.
  property int selfWrites: 0

  function writeState() {
    root.selfWrites = root.selfWrites + 1
    stateFile.setText(JSON.stringify({
      version: 1, activeStationId: root.activeStationId, stations: root.stations
    }, null, 2) + "\n")
  }

  function setActive(id) { root.activeStationId = id; writeState(); refresh() }

  // Changes one saved station's direction WITHOUT activating it.
  //
  // Deliberately not saveStation(). That activates by design -- picking a
  // station AND a direction out of search is a statement of intent -- but
  // adjusting a background row's direction is not a request to look at it.
  // Clicking the name is. Routing the toggle through saveStation meant flipping
  // Bedford Av's direction silently moved the panel header and the bar to
  // Bedford Av, which no documentation claimed and nobody asked for.
  function setDirection(stopId, dir) {
    var next = root.stations.slice()
    var hit = -1
    for (var i = 0; i < next.length; i++) {
      if (next[i].stopId === stopId) { hit = i; break }
    }
    if (hit < 0) return
    if (next[hit].direction === dir) return
    // A fresh object rather than a mutation: root.stations is read by property
    // bindings that compare by reference, and mutating in place would leave
    // them showing the old direction until something else happened to change
    // the array identity.
    next[hit] = {
      stopId: next[hit].stopId, name: next[hit].name,
      routes: next[hit].routes, direction: dir
    }
    root.stations = next
    writeState()
    // Only when it is the station actually on screen. Refreshing for a
    // background row would spend a full feed fetch to change nothing visible
    // but that row's own label.
    if (root.activeStationId === stopId) refresh()
  }

  function saveStation(entry) {
    var next = root.stations.slice()
    var found = false
    for (var i = 0; i < next.length; i++) {
      // Rewrite in place, then fall through to the same activate/write/refresh
      // as an insert. The update branch used to return early, doing neither --
      // so re-picking a saved station with a different direction wrote the file
      // and changed nothing visible, which is the same dead click the
      // activate-on-save amendment exists to remove. And when the station WAS
      // already active, `saved` picked up the new direction while root.arrivals
      // kept showing the old one for up to 90s.
      if (next[i].stopId === entry.stopId) { next[i] = entry; found = true; break }
    }
    if (!found) next.push(entry)
    root.stations = next
    // Adopt it. The spec split the gestures -- search saves, the saved list
    // activates -- but picking a station AND a direction out of search is an
    // unambiguous statement of intent, and leaving the panel on the previous
    // station makes that click look like it did nothing. Observed: saving
    // Union Sq left the header on Franklin Av, read as a dead button, and
    // cost a second click on the saved row to finish the job.
    root.activeStationId = entry.stopId
    writeState()
    refresh()
  }

  function removeStation(id) {
    var next = []
    for (var i = 0; i < root.stations.length; i++) {
      if (root.stations[i].stopId !== id) next.push(root.stations[i])
    }
    root.stations = next
    if (root.activeStationId === id) root.activeStationId = next.length ? next[0].stopId : ""
    writeState()
    refresh()
  }

  // ---- fetching --------------------------------------------------------
  property int pending: 0
  // Set by any failed feed in the current refresh. Without it, a station
  // whose routes span two feed groups (an F and G rider) could have one feed
  // fail and one succeed, and finishFeed would still clear ok/error on the
  // last call — reporting a confident, silently incomplete arrivals list.
  property bool anyFailed: false
  property var tripLists: []
  property int maxTimestamp: 0

  // Qt's XMLHttpRequest does not reliably honour the `timeout` property, so
  // each request carries a deadline that the one-second tick sweeps. This
  // path is also what the unreachable-feed state depends on, so it is not
  // merely defensive.
  //
  // Deliberately NOT a Timer created per request via Qt.createQmlObject:
  // that call appears nowhere in this shell or in galley/colophon, it
  // recompiles QML at runtime, and it would create one object per feed per
  // poll (up to eight every 30s) that must be explicitly destroyed.
  property var inflight: []

  function fetchBytes(url, kind, onOk, onFail) {
    var xhr = new XMLHttpRequest()
    // `kind` is "trips" or "alerts". abortInflight() supersedes only trip
    // fetches — the alerts poll shares this list and runs on its own timer.
    var entry = { xhr: xhr, kind: kind, deadline: root.nowSec + 15,
                  settled: false, onFail: onFail }
    // Reassign, never push in place: mutating a QML `var` array property
    // does not fire a change notification, so bindings would not see it.
    var queued = root.inflight.slice()
    queued.push(entry)
    root.inflight = queued
    xhr.open("GET", url)
    xhr.responseType = "arraybuffer"
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE || entry.settled) return
      entry.settled = true
      if (xhr.status !== 200) { onFail("HTTP " + xhr.status); return }
      onOk(new Uint8Array(xhr.response))
    }
    xhr.send()
  }

  function sweepInflight() {
    var keep = []
    for (var i = 0; i < root.inflight.length; i++) {
      var e = root.inflight[i]
      if (e.settled) continue
      if (root.nowSec > e.deadline) {
        e.settled = true
        e.xhr.abort()
        e.onFail("timed out")
        continue
      }
      keep.push(e)
    }
    root.inflight = keep
  }

  // Bumped by every refresh. A callback belonging to a superseded refresh
  // returns without touching state.
  //
  // Without this, two overlapping refreshes interleave: refresh() resets
  // tripLists and pending, so the first refresh's callbacks push into the
  // second's fresh array and decrement the second's counter. `pending` hits
  // zero early, arrivals are computed from a PARTIAL MIX of both, and the
  // remaining callbacks then drive `pending` negative and recompute on each.
  //
  // The poll timer alone cannot cause it — the 15s abort deadline is shorter
  // than the 30s open interval. But refresh() is called on demand from four
  // places: the `r` key, middle-click, setActive(), and saveStation()/
  // removeStation(). Clicking a saved station while a poll is in flight is
  // the ordinary way to hit this.
  property int generation: 0

  function abortInflight() {
    var keep = []
    for (var i = 0; i < root.inflight.length; i++) {
      var e = root.inflight[i]
      if (e.settled) continue
      // Supersede ONLY trip fetches. The alerts poll runs on its own 300s
      // timer and shares this list; aborting it here would silently drop an
      // in-flight alerts request, delaying a "no service" notification by up
      // to five minutes because someone pressed `r` or switched station.
      if (e.kind !== "trips") { keep.push(e); continue }
      // Mark settled BEFORE aborting: abort() fires readystatechange with
      // DONE, and the existing `entry.settled` guard is what swallows it.
      e.settled = true
      e.xhr.abort()
    }
    root.inflight = keep
  }

  function refresh() {
    // Supersede and bump FIRST, before any early return. Otherwise a refresh
    // that bails out — no saved station, or a station whose routes map to no
    // feed — leaves the previous generation's requests live AND current. When
    // they land, finishFeed calls Model.arrivalsFor(root.saved, …) with
    // `saved` now null, which THROWS inside an XHR callback. Reachable by
    // removing your only saved station while a poll is in flight.
    root.abortInflight()
    root.generation = root.generation + 1
    var gen = root.generation
    if (!root.saved) { root.arrivals = []; root.loading = false; return }
    var feeds = Gtfs.feedsForRoutes(root.saved.routes)
    if (feeds.length === 0) { root.arrivals = []; root.loading = false; return }
    root.anyFailed = false
    root.loading = true
    root.tripLists = []
    root.maxTimestamp = 0
    root.pending = feeds.length
    for (var i = 0; i < feeds.length; i++) {
      fetchBytes(Gtfs.feedUrl(feeds[i]), "trips", function (bytes) {
        if (gen !== root.generation) return
        // Gtfs.js throws on a malformed or truncated buffer rather than
        // returning garbage. A dropped connection mid-body is a realistic
        // input, and an uncaught throw here escapes into the shell process,
        // so the decode is wrapped and routed to the same failure path as an
        // HTTP error.
        var decoded
        try {
          decoded = Gtfs.decodeTripUpdates(bytes)
        } catch (e) {
          root.finishFeed(false, "malformed feed: " + e.message)
          return
        }
        var lists = root.tripLists.slice()
        lists.push(decoded.trips)
        root.tripLists = lists
        if (decoded.timestamp > root.maxTimestamp) root.maxTimestamp = decoded.timestamp
        root.finishFeed(true, "")
      }, function (why) {
        if (gen !== root.generation) return
        root.finishFeed(false, why)
      })
    }
  }

  function finishFeed(succeeded, why) {
    if (!succeeded) { root.anyFailed = true; root.ok = false; root.error = why }
    root.pending = root.pending - 1
    if (root.pending > 0) return
    root.loading = false
    // Defensive: the station can be removed while requests are in flight.
    // The generation guard should already have filtered those callbacks, but
    // Model.arrivalsFor throws on a null `saved`, and a throw here escapes
    // into an XHR handler.
    if (!root.saved) return
    if (root.tripLists.length === 0) {
      // checkStale() MUST run here. It is what raises the stale/unreachable
      // notification, and it used to sit only at the bottom of this function,
      // below this early return -- so when EVERY feed failed, tripLists was
      // empty, this returned, and the one case the notification exists for
      // could never fire it. Unplugging the network produced silence.
      root.checkStale()
      return
    }
    // Only claim success if EVERY feed succeeded. Partial data is still worth
    // showing, so arrivals are computed either way — but `ok` stays false so
    // the bar reports the gap rather than a confident wrong answer.
    if (!root.anyFailed) {
      root.ok = true
      root.error = ""
    }
    root.feedTimestamp = root.maxTimestamp
    root.arrivals = Model.arrivalsFor(
      root.saved, Model.dedupeTrips(root.tripLists), root.nowSec)
    root.checkStale()
  }

  function refreshAlerts() {
    fetchBytes(Gtfs.ALERTS_URL, "alerts", function (bytes) {
      // Same guard as the trip decode: a malformed body must not throw into
      // the shell. Alerts are advisory, so a failure leaves the previous
      // alert list standing rather than blanking it.
      try {
        var decoded = Gtfs.decodeAlerts(bytes)
        root.alerts = decoded.alerts
        root.checkNewAlerts()
      } catch (e) {
        // keep the last good alerts
      }
    }, function (why) { /* alerts are advisory; a failure must not blank arrivals */ })
  }

  Timer {
    id: pollTimer
    interval: (root.panelOpen ? root.openInterval : root.idleInterval) * 1000
    running: true; repeat: true; triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: root.alertsInterval * 1000
    running: true; repeat: true; triggeredOnStart: true
    onTriggered: root.refreshAlerts()
  }

  // ---- notifications ---------------------------------------------------
  // Diff state lives here, not in the pure modules: they hold nothing between
  // calls, so anything needing memory across polls belongs to the caller.
  property var seenAlertIds: ({})
  property bool wasStale: false

  // False until the first alert poll has been absorbed. The alerts Timer has
  // triggeredOnStart, so without this every alert already active on a saved
  // route counts as new at shell start and fires a notification -- a burst on
  // every login and every redeploy, for alerts that were running long before
  // the widget started. The spec frames notifications as firing on the
  // transition INTO an alert, and at a cold start there is no transition, only
  // a backlog.
  property bool alertsPrimed: false

  function checkNewAlerts() {
    if (!root.notifyRouteAlert || !root.saved) return
    if (!root.alertsPrimed) {
      // Absorb the current state silently, so later polls report real changes.
      // Every active alert is still visible in the panel -- this suppresses the
      // notification, not the alert.
      var backlog = Model.alertsFor(root.saved.routes, root.alerts, root.nowSec)
      for (var b = 0; b < backlog.length; b++) {
        root.seenAlertIds["a:" + backlog[b].id] = true
      }
      root.alertsPrimed = true
      return
    }
    // Computes its own list rather than reading root.liveAlerts, and that is
    // deliberate — not duplication to be tidied away. liveAlerts filters at
    // MINUTE resolution, which is what stops the panel's alert Repeater
    // rebuilding every delegate once a second. Notifications want SECOND
    // resolution so a "no service" alert reaches you promptly instead of up
    // to 59 seconds late. (Reading liveAlerts here would be safe — QML
    // bindings are eager, verified by probe — it would just be slower.)
    var live = Model.alertsFor(root.saved.routes, root.alerts, root.nowSec)
    for (var i = 0; i < live.length; i++) {
      var a = live[i]
      var cls = Model.classifyAlert(a.alertType)
      if (cls !== "amber" && cls !== "red") continue
      // hasOwnProperty, not a bare lookup. seenAlertIds is a plain object
      // used as a set, so `seenAlertIds["constructor"]` finds the inherited
      // member, reads as already-seen, and that alert would NEVER notify.
      // Alert ids come from the feed (`lmm:alert:264661:26`), and this is the
      // third place in this project where a plain-object lookup table needed
      // the same guard — Gtfs.js's feed map and Model.js's severity tables
      // were the others.
      // Prefixed like dedupeTrips' and search's tables: hasOwnProperty guards
      // the read, but assigning seenAlertIds["__proto__"] never creates an own
      // property, so such an alert would notify on EVERY poll forever.
      if (Object.prototype.hasOwnProperty.call(root.seenAlertIds, "a:" + a.id)) continue
      root.seenAlertIds["a:" + a.id] = true
      root.notify("Headway - " + a.alertType, a.headerText || "")
    }
  }

  function checkStale() {
    if (!root.notifyFeedStale) return
    var age = root.nowSec - root.feedTimestamp
    var stale = root.feedTimestamp > 0 && age > root.staleAfterSec
    if (stale && !root.wasStale) root.notify("Headway", "Train data has gone stale.")
    if (!stale && root.wasStale) root.notify("Headway", "Train data is current again.")
    root.wasStale = stale
  }

  // A QUEUE, not a single pending slot. Colophon uses one slot and records
  // why that is enough there: "there is only one notification type, so a
  // burst is not reachable... add galley's full queue if you add a second
  // type."
  //
  // Measured, because the obvious justification is wrong: a single slot
  // handles a burst of TWO perfectly — the first sends immediately, the
  // second waits in the slot and drains after it. It only starts losing
  // messages at THREE, where the middle one is overwritten before it can be
  // sent. So "Headway has two notification types" is not by itself the
  // reason.
  //
  // The reason is that checkNewAlerts emits one notification per NEWLY
  // APPEARED alert, not one per type. Two new alerts on saved routes in the
  // same poll, plus the feed going stale, is a three-message burst — and a
  // rider on N/Q/R/W can pick up two at once.
  property var notifyQueue: []

  Process {
    id: notifyProc
    onRunningChanged: {
      // Handle runningChanged, NOT just exited: Quickshell's Process never
      // emits exited() when a process fails to SPAWN, so an exited-only
      // handler latches forever the first time a binary is missing.
      //
      // Qt.callLater rather than assigning command/running here directly —
      // both galley and colophon do this, and re-entering the handler by
      // starting the next process inside it is what they are avoiding.
      if (notifyProc.running) return
      Qt.callLater(root.sendNextNotification)
    }
  }

  function notify(summary, body) {
    var queued = root.notifyQueue.slice()
    queued.push({ summary: summary, body: body })
    root.notifyQueue = queued
    sendNextNotification()
  }

  function sendNextNotification() {
    // Assigning Process.command while it is still running is a silent no-op,
    // so exactly one at a time.
    if (notifyProc.running) return
    if (root.notifyQueue.length === 0) return
    var next = root.notifyQueue[0]
    root.notifyQueue = root.notifyQueue.slice(1)
    // `--` before the title terminates option parsing. Alert headlines come
    // straight from the MTA feed, so one beginning with a dash would
    // otherwise be read as a flag. Galley passes `--` for the same reason.
    notifyProc.command = ["notify-send", "-a", "Headway", "--", next.summary, next.body]
    notifyProc.running = true
  }

  // ---- location --------------------------------------------------------
  // Reuses the fix Omarchy already has rather than inventing a second one.
  // Setup convenience only: read once, never on a timer.
  property var origin: null

  FileView {
    id: weatherFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    printErrors: false
    onLoaded: {
      try {
        var w = JSON.parse(weatherFile.text())
        // typeof, not falsy. Latitude 0 (the equator) and longitude 0 (the
        // prime meridian) are real coordinates, and this branch is the same
        // rule Model.distanceText already states explicitly.
        if (typeof w.latitude === "number" && typeof w.longitude === "number") {
          root.origin = { lat: w.latitude, lon: w.longitude }
        }
      } catch (e) { root.origin = null }
    }
    onLoadFailed: root.origin = null
  }
}
