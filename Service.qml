import QtQuick
import Quickshell
import Quickshell.Io
import "Fetch.js" as Fetch
import "Gtfs.js" as Gtfs
import "Model.js" as Model
import "State.js" as State
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
    onTriggered: root.nowSec = Math.floor(Date.now() / 1000)
  }

  // ONE handler. QML rejects a duplicate Component.onCompleted and the whole
  // component then fails to instantiate -- silently, as far as the journal is
  // concerned. Adding a second one for the state reader cost a deploy to find.
  Component.onCompleted: {
    root.nowSec = Math.floor(Date.now() / 1000)
    // Kick the bounded state read. Not a `running: true` default on the
    // Process: that starts it during component construction, before statePath
    // and the collector are necessarily bound.
    stateReader.running = true
  }

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
  //
  // READS AND WRITES GO DIFFERENT WAYS, deliberately, after the Omarchy plugin
  // marketplace review raised UNBOUNDED-STATE-FILE-IN-SHELL against
  // 12d6630: this service is always loaded, the file path is predictable, and
  // a FileView read is unbounded -- so a very large or hostile file could
  // exhaust or stall the SHARED shell process, taking every other widget with
  // it. FileView cannot help: its whole API is blockWrites, atomicWrites,
  // watchChanges, adapter, path, text, data, preload, loaded, blockLoading,
  // blockAllReads and printErrors. No size cap, no stat, no symlink control.
  // Quickshell exports no filesystem primitive either. So the read is bounded
  // outside QML and the write keeps FileView for its atomic rename.
  readonly property string statePath:
    Quickshell.env("HOME") + "/.local/state/omarchy/settings/headway.json"

  // 64 KiB. Four saved stations is about 1 KB, so this is ~250x any real use
  // and far below anything that stalls a shell.
  readonly property int stateByteLimit: 65536
  // A saved-stations list, not a database. Bounds the O(n) walk in consumeState
  // and everything downstream that iterates it.
  readonly property int stateStationLimit: 50
  readonly property int stateFieldLimit: 64

  // NO FileView here, for reads OR writes. MEASURED on this machine: FileView
  // attempts a read whenever `path` is assigned, and neither `preload: false`
  // nor `blockAllReads: true` prevents it -- a probe logged
  // "Read of ... failed: File does not exist" under both. (Its sibling property
  // is `blockLoading`, so `blockAllReads` most likely means "make reads
  // blocking" rather than "prevent reads" -- worse here, not better.) There is
  // therefore no write-only FileView, and keeping one for writes would keep
  // exactly the unbounded read the marketplace review flagged.
  //
  // So writes go through the same shell the read does: printf to a sibling temp
  // file, then mv -f -- the same atomic rename atomicWrites gave us. mkdir -p
  // covers a first run where ~/.local/state/omarchy/settings does not exist.
  //
  // The payload is passed as a POSITIONAL PARAMETER, never interpolated into
  // the script, so quotes, backticks and semicolons in a station name are
  // written verbatim. Verified with a payload containing $(whoami), backticks
  // and ;rm -rf / -- every one landed as literal text.
  property string pendingWrite: ""

  Process {
    id: stateWriter
    running: false
    onRunningChanged: {
      // runningChanged, not exited, for the reason the notifier documents:
      // Quickshell's Process never emits exited() on a failed spawn, so an
      // exited-only handler would strand a queued write forever.
      if (stateWriter.running) return
      if (root.pendingWrite !== "") Qt.callLater(root.flushState)
    }
  }

  // Bounded, symlink-rejecting, FIFO-proof, one-shot read. The flags and the
  // reasoning live in State.js next to the tests that execute them; the short
  // version is that there is no stat-then-open pair here to race, because the
  // guarantees ride on the single open() itself.
  //
  // Empty output when the file is absent is the first-run path and must not
  // read as an error -- onRunningChanged below resolves it either way.
  Process {
    id: stateReader
    running: false
    command: State.readArgs(root.statePath, root.stateByteLimit)
    // dd names a missing file on stderr, which on a first run is expected and
    // not worth a journal line. Collected rather than inherited so it does not
    // reach the shell's own stderr.
    stderr: StdioCollector { waitForEnd: true }
    stdout: StdioCollector {
      // waitForEnd is REQUIRED, and omitting it is why the first attempt at
      // this read produced nothing at all: without it the collector does not
      // hold the stream open to the end, so onStreamFinished never delivers a
      // complete payload. Every first-party user in the shell sets it --
      // Commons/Style.qml:446 and plugins/panels/disk-speedtest:105.
      waitForEnd: true
      // Bare `text`, not `this.text`, matching those same call sites.
      onStreamFinished: root.consumeState(text)
    }
    onRunningChanged: {
      // runningChanged, not exited: Quickshell's Process never emits exited()
      // on a failed SPAWN, so an exited-only handler would leave the widget
      // waiting forever for state that is never coming. A failed spawn must
      // still resolve to "no saved stations" and let the panel say so.
      if (stateReader.running) return
      if (!root.stateResolved) root.consumeState("")
    }
  }

  property bool stateResolved: false

  // Entries are VALIDATED, not trusted. headway.json is plain JSON the README
  // invites the user to inspect, so its contents are upstream data. An entry
  // without `routes` reaches Model.alertsFor through the barState and tooltip
  // property bindings, and a throw in a binding removes the whole widget rather
  // than one row. Model.worstAlertClass guards this too; both halves are wanted,
  // and this is the half that keeps junk out of `refresh()` as well.
  function validStation(e) {
    if (!e || typeof e.stopId !== "string" || e.stopId === "") return false
    if (e.stopId.length > root.stateFieldLimit) return false
    if (e.direction !== "N" && e.direction !== "S") return false
    // An actual array test. `typeof e.routes.length === "number"` admits a
    // string and {"length": 2}; neither throws downstream, but neither is a
    // route list either. Works in both engines, unlike Array.isArray in ES3.
    if (Object.prototype.toString.call(e.routes) !== "[object Array]") return false
    if (e.routes.length === 0 || e.routes.length > root.stateFieldLimit) return false
    for (var i = 0; i < e.routes.length; i++) {
      if (typeof e.routes[i] !== "string") return false
      if (e.routes[i].length > root.stateFieldLimit) return false
    }
    if (e.name !== undefined && typeof e.name !== "string") return false
    return true
  }

  // Takes TEXT, not a FileView. Everything that reaches here has already been
  // capped at stateByteLimit bytes by a non-symlink regular file.
  function consumeState(text) {
    root.stateResolved = true
    var loaded = []
    var active = ""
    try {
      // Belt as well as braces: head bounds what arrives, and this bounds what
      // is parsed if the reader is ever replaced by something that does not.
      if (text && text.length <= root.stateByteLimit) {
        var data = JSON.parse(text)
        var raw = data.stations || []
        var cap = raw.length < root.stateStationLimit
          ? raw.length : root.stateStationLimit
        for (var i = 0; i < cap; i++) {
          if (root.validStation(raw[i])) loaded.push(raw[i])
        }
        if (typeof data.activeStationId === "string" &&
            data.activeStationId.length <= root.stateFieldLimit) {
          active = data.activeStationId
        }
      }
    } catch (e) {
      loaded = []
      active = ""
    }
    root.stations = loaded
    root.activeStationId = active
    // REQUIRED. The poll Timer has triggeredOnStart, so refresh() runs once at
    // component completion -- but the state read is asynchronous and finishes
    // AFTER that, so the first refresh sees no saved station and early-returns.
    // Without this call nothing re-triggers a fetch and the bar stays blank
    // until the next idle tick, up to pollIntervalIdleSec (90s) after every
    // shell start. Observed on every redeploy during development.
    root.refresh()
  }

  // Last-write-wins. The state file is a whole-file snapshot, so a payload
  // superseded before it reached disk has no value -- and a burst of saves
  // (toggling three directions quickly) costs one write rather than three.
  //
  // No selfWrites counter any more: it existed only to swallow the watcher
  // events our own writes caused, and nothing watches this file now. That also
  // retires the cumulative-stranding bug it had (open issue N9).
  function writeState() {
    root.pendingWrite = JSON.stringify({
      version: 1, activeStationId: root.activeStationId, stations: root.stations
    }, null, 2) + "\n"
    root.flushState()
  }

  function flushState() {
    // Assigning Process.command while it is running is a silent no-op, so a
    // busy writer waits for onRunningChanged rather than clobbering itself.
    if (stateWriter.running) return
    var payload = root.pendingWrite
    if (payload === "") return
    root.pendingWrite = ""
    stateWriter.command = State.writeArgs(root.statePath, payload)
    stateWriter.running = true
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

  // The feed timeout. curl honours it natively, which is why there is no
  // deadline registry here any more. The XHR path needed one because Qt's
  // XMLHttpRequest does not reliably honour its own `timeout` property, so
  // every request carried a deadline that the one-second tick swept; the
  // registry, the sweep and the settled-before-abort dance all existed to
  // serve that one defect. --max-time replaces the lot, and stays shorter
  // than the 30s open interval so a hung fetch cannot outlive its successor.
  readonly property int feedTimeoutSec: 15

  // Hard ceiling on a single feed body. Measured live: the numbered-lines feed
  // ran 67 KB at one hour and 222 KB at the next, so this is a wide margin
  // rather than a tuned figure -- the size tracks how many trains are moving.
  //
  // The XHR path had NO ceiling at all: `new Uint8Array(xhr.response)` took
  // whatever arrived. The feed is the one input here an attacker can actually
  // influence -- a hostile exit node, a hijacked DNS answer, a MITM -- and it
  // was the only unbounded read left once the state file was capped. curl
  // aborts on the Content-Length BEFORE writing a byte to stdout (verified: 0
  // bytes reach the pipe), so an oversized body never reaches this heap.
  readonly property int feedByteLimit: 4194304

  // One curl per feed of the CURRENT refresh, spawned by an Instantiator over
  // this list. Each entry is { url, gen }.
  //
  // Reassigning the list IS the supersede: the Instantiator destroys the old
  // delegates, and destroying a Process kills its child. Measured -- three
  // `sleep 60` children spawned, model cleared, all three reaped, no orphans.
  // That is the whole of what abortInflight() used to do by hand.
  //
  // Deliberately an Instantiator and not Qt.createQmlObject, which appears
  // nowhere in this shell or in galley/colophon and recompiles QML at runtime.
  // An Instantiator instantiates a Component that was compiled with the file.
  //
  // The alerts fetch is deliberately NOT in this list. It runs on its own 300s
  // timer, and the old shared registry meant superseding a trips refresh could
  // silently drop an in-flight alerts request, delaying a "no service"
  // notification by up to five minutes because someone pressed `r`. Keeping it
  // out of the model makes that separation structural rather than a filter.
  property var feedQueue: []

  Instantiator {
    model: root.feedQueue
    delegate: Process {
      id: feedProc
      required property var modelData

      command: Fetch.curlArgs(feedProc.modelData.url, root.feedByteLimit,
                              root.feedTimeoutSec)

      // exited() and streamFinished() have NO guaranteed ordering, so neither
      // alone can decide the outcome: with --fail an HTTP error is an empty
      // stdout plus a non-zero code, and reading only the stream would turn a
      // server error into a silently empty feed. Both must land before this
      // resolves. A delegate destroyed mid-flight never resolves at all, which
      // is correct -- it was superseded, and the next refresh resets `pending`.
      property bool sawExit: false
      property bool sawStream: false
      property int exitCode: 0
      property var payload: null

      function settle() {
        if (!feedProc.sawExit || !feedProc.sawStream) return
        root.absorbFeed(feedProc.modelData.gen, feedProc.exitCode, feedProc.payload)
      }

      stdout: StdioCollector {
        // waitForEnd, for the reason the state reader documents: without it the
        // collector does not hold the stream open to the end, so onStreamFinished
        // never delivers a complete payload.
        waitForEnd: true
        onStreamFinished: {
          feedProc.payload = data
          feedProc.sawStream = true
          feedProc.settle()
        }
      }

      // curl writes its own diagnosis here. The exit code is the contract, but
      // swallowing stderr would make a failed spawn indistinguishable from an
      // empty feed in the journal.
      stderr: StdioCollector {
        waitForEnd: true
        onStreamFinished: if (text.length) console.warn("headway: curl: " + text)
      }

      onExited: function (code) {
        feedProc.exitCode = code
        feedProc.sawExit = true
        feedProc.settle()
      }

      // runningChanged as well as exited, for the reason the state reader and
      // the notifier both document: Quickshell's Process never emits exited()
      // on a failed SPAWN. Resolving on exited() alone strands `pending` and
      // leaves the panel loading forever with `ok` still true -- measured with
      // curl removed from PATH, which reported "everything is fine" while
      // showing nothing, indefinitely.
      //
      // Deferred with Qt.callLater rather than decided here, because a normal
      // exit also drives running false and its exited() may arrive after this
      // handler. By the time the deferred call runs, a real exit has already
      // set sawExit and this does nothing.
      onRunningChanged: {
        if (feedProc.running) return
        Qt.callLater(feedProc.settleFailedSpawn)
      }

      function settleFailedSpawn() {
        if (feedProc.sawExit) return
        feedProc.exitCode = 127
        feedProc.sawExit = true
        // No stream either -- nothing ever opened one.
        feedProc.sawStream = true
        feedProc.settle()
      }

      // Set here rather than bound: `command` must be resolved before start.
      Component.onCompleted: feedProc.running = true
    }
  }

  // Where a finished curl lands, whatever it was carrying.
  function absorbFeed(gen, exitCode, payload) {
    if (gen !== root.generation) return
    if (exitCode !== 0) { root.finishFeed(false, Fetch.errorText(exitCode)); return }
    // Defence in depth behind --max-filesize, which curl documents as inert
    // when the body length is not known in advance. The MTA sends a
    // Content-Length today (measured), so the flag does work -- but that is a
    // property of their server, not a guarantee, and this costs one compare.
    if (!payload || payload.byteLength > root.feedByteLimit) {
      root.finishFeed(false, "feed too large")
      return
    }
    // Gtfs.js throws on a malformed or truncated buffer rather than returning
    // garbage. A body cut off mid-stream is a realistic input, and an uncaught
    // throw here escapes into the shell process, so the decode is wrapped and
    // routed to the same failure path as a transport error.
    var decoded
    try {
      decoded = Gtfs.decodeTripUpdates(new Uint8Array(payload))
    } catch (e) {
      root.finishFeed(false, "malformed feed: " + e.message)
      return
    }
    var lists = root.tripLists.slice()
    lists.push(decoded.trips)
    root.tripLists = lists
    if (decoded.timestamp > root.maxTimestamp) root.maxTimestamp = decoded.timestamp
    root.finishFeed(true, "")
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

  function refresh() {
    // Supersede and bump FIRST, before any early return. Otherwise a refresh
    // that bails out -- no saved station, or a station whose routes map to no
    // feed -- leaves the previous generation's fetches live AND current. When
    // they land, finishFeed calls Model.arrivalsFor(root.saved, ...) with
    // `saved` now null, which THROWS. Reachable by removing your only saved
    // station while a poll is in flight.
    root.feedQueue = []
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
    // Built whole, then assigned once. Mutating a QML `var` array in place
    // fires no change notification, so the Instantiator would not see it.
    var queue = []
    for (var i = 0; i < feeds.length; i++) {
      queue.push({ url: Gtfs.feedUrl(feeds[i]), gen: gen })
    }
    root.feedQueue = queue
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
    // Assigning command while the process runs is a silent no-op, so an
    // overlapping poll is skipped rather than clobbering the one in flight.
    // A 15s timeout inside a 300s interval means this cannot happen today; it
    // is here because the state writer documents the same trap.
    if (alertsFetcher.running) return
    alertsFetcher.command = Fetch.curlArgs(Gtfs.ALERTS_URL, root.feedByteLimit,
                                           root.feedTimeoutSec)
    alertsFetcher.running = true
  }

  // Alerts are advisory. A failure leaves the previous list standing rather
  // than blanking it, and never touches `ok`/`error`, which describe arrivals.
  Process {
    id: alertsFetcher
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // Empty stdout is how a curl failure arrives here, since --fail makes
        // an HTTP error a code rather than a body. Nothing to decode, and
        // nothing to report: the previous alerts stand.
        if (!data || data.byteLength === 0) return
        if (data.byteLength > root.feedByteLimit) return
        try {
          var decoded = Gtfs.decodeAlerts(new Uint8Array(data))
          root.alerts = decoded.alerts
          root.checkNewAlerts()
        } catch (e) {
          // keep the last good alerts
        }
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.length) console.warn("headway: curl (alerts): " + text)
    }
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
