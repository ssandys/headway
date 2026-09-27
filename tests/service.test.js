// tests/service.test.js
//
// The first tests in this repo that EXECUTE Service.qml, rather than the pure
// modules beside it. They run the real file under the real Quickshell, with a
// harness that reads properties afterwards and reports through the exit code
// -- Qt logging is suppressed in this environment. The pattern is galley's
// tests/test_controller_lifecycle.py, ported to node so this repo keeps one
// test runner.
//
// Why these exist: Service.qml became a singleton in #3, and its settings
// stopped arriving (#15). The widget called attach({settings}) from
// Component.onCompleted, which runs BEFORE the bar injects settings in its
// Loader's onLoaded, and attach() latched that first, empty object for good.
// Every setting silently fell back to its default. Live verification ran with
// defaults only, which is exactly the case this bug cannot show -- and nothing
// in the suite could execute this file to catch it.
//
// Isolation, because this runs a real shell engine on the user's machine:
//   HOME  -> a scratch directory, so statePath can never be the real
//            ~/.local/state/omarchy/settings/headway.json
//   PATH  -> an empty directory, so curl, dd, sh and notify-send all fail to
//            spawn. No network, no file writes, no desktop notifications. A
//            failed spawn is a path Service.qml already handles.
// quickshell itself is invoked by absolute path so the empty PATH does not hide
// the runtime from the test too.
const test = require("node:test")
const assert = require("node:assert/strict")
const { spawnSync, execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")
const FILES = ["Service.qml", "qmldir", "Fetch.js", "Gtfs.js", "Model.js",
               "State.js", "Stations.js", "StationData.js"]

function quickshellPath() {
  try { return execFileSync("sh", ["-c", "command -v quickshell"], { encoding: "utf8" }).trim() }
  catch (e) { return "" }
}
const QS = quickshellPath()

// Runs `script` against the singleton, waits, then exits 0 if `check` holds.
//
// `setup(home, bin)`, when given, runs before the shell starts: it can plant
// files under the scratch HOME and put chosen programs into the otherwise
// EMPTY bin directory that is the whole PATH -- the real dd, or a fake curl.
// Nothing it adds can reach outside the temp dir.
function runService(script, check, wait, setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headway-service-"))
  try {
    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f))
    const home = path.join(dir, "home")
    const emptyBin = path.join(dir, "empty-bin")
    fs.mkdirSync(home)
    fs.mkdirSync(emptyBin)
    if (setup) setup(home, emptyBin)
    fs.writeFileSync(path.join(dir, "harness.qml"),
      "import QtQuick\n" +
      "import Quickshell\n" +
      "import \".\"\n" +
      "ShellRoot {\n" +
      "  id: root\n" +
      "  property int idleMs: -1\n" +
      "  property bool done: false\n" +
      "  Component.onCompleted: {\n" + script + "\n  }\n" +
      "  Timer {\n" +
      "    running: true; interval: " + (wait || 1500) + "\n" +
      "    onTriggered: Qt.exit((" + check + ") ? 0 : 1)\n" +
      "  }\n" +
      "}\n")
    const r = spawnSync(QS, ["-p", path.join(dir, "harness.qml")], {
      encoding: "utf8", timeout: 30000,
      env: Object.assign({}, process.env, { HOME: home, PATH: emptyBin })
    })
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const skip = QS === "" ? "quickshell is required to execute Service.qml" : false

test("with no settings the service uses its defaults", { skip }, () => {
  // The control. Every assertion below is about a value DIFFERENT from these.
  const r = runService("Service.attach({})",
    "Service.idleInterval === 90 && Service.trainsPerDirection === 3" +
    " && Service.notifyRouteAlert === true")
  assert.equal(r.code, 0, "defaults did not hold\n" + r.out)
})

test("settings that arrive AFTER attach still take effect", { skip }, () => {
  // #15, exactly as the host produces it: the widget attaches from
  // Component.onCompleted holding the default empty object, and the bar only
  // injects the real settings afterwards, from its Loader's onLoaded.
  const r = runService(
    "Service.attach({ settings: ({}) });" +
    " Service.configure({ pollIntervalIdleSec: 45, trainsPerDirection: 5," +
    " notifyRouteAlert: false })",
    "Service.idleInterval === 45 && Service.trainsPerDirection === 5" +
    " && Service.notifyRouteAlert === false")
  assert.equal(r.code, 0, "late settings were ignored\n" + r.out)
})

test("a later settings change replaces the earlier one", { skip }, () => {
  // The settings UI assigns a new object on every edit (applySettingsDelta),
  // so the latest must win -- a latch keeps the first forever.
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalIdleSec: 45 });" +
    " Service.configure({ pollIntervalIdleSec: 120 })",
    "Service.idleInterval === 120")
  assert.equal(r.code, 0, "the first settings object stuck\n" + r.out)
})

test("a second surface attaching does not clobber settings with an empty object", { skip }, () => {
  // Every surface attaches with whatever its widget held at completion, which
  // is the empty default. Configuration must come from configure(), not from
  // whichever surface happened to attach last.
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalIdleSec: 45 });" +
    " Service.attach({ settings: ({}) })",
    "Service.idleInterval === 45 && Service.consumers === 2")
  assert.equal(r.code, 0, "a later attach wiped the settings\n" + r.out)
})

test("clearing a setting puts its default back", { skip }, () => {
  // configure() REPLACES the settings object; it does not merge into it. A
  // merge would keep a cleared key's old value forever -- the settings UI
  // drops a key back to the manifest default by leaving it out.
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalIdleSec: 45, notifyRouteAlert: false });" +
    " Service.configure({})",
    "Service.idleInterval === 90 && Service.notifyRouteAlert === true")
  assert.equal(r.code, 0, "a cleared setting kept its old value\n" + r.out)
})

test("settings that name only some keys leave the rest at their defaults", { skip }, () => {
  const r = runService(
    "Service.attach({}); Service.configure({ trainsPerDirection: 5 })",
    "Service.trainsPerDirection === 5 && Service.idleInterval === 90" +
    " && Service.openInterval === 30 && Service.notifyFeedStale === true")
  assert.equal(r.code, 0, "an unnamed key lost its default\n" + r.out)
})

test("configure with nothing falls back to defaults rather than throwing", { skip }, () => {
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalIdleSec: 45 }); Service.configure(null);" +
    " Service.configure({ pollIntervalIdleSec: 46 }); Service.configure(undefined)",
    "Service.idleInterval === 90")
  assert.equal(r.code, 0, "configure(null/undefined) misbehaved\n" + r.out)
})

test("the poll timer runs on the configured intervals", { skip }, () => {
  // pollIntervalMs aliases pollTimer.interval itself, so this is the schedule
  // the timer is really on -- not just the number a setting resolved to.
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalIdleSec: 45, pollIntervalOpenSec: 20 });" +
    " root.idleMs = Service.pollIntervalMs;" +
    " Service.setPanelOpen(false, true)",
    "root.idleMs === 45000 && Service.pollIntervalMs === 20000")
  assert.equal(r.code, 0, "the timer did not follow the settings\n" + r.out)
})

test("with no settings the poll timer runs on the default interval", { skip }, () => {
  const r = runService("Service.attach({})", "Service.pollIntervalMs === 90000")
  assert.equal(r.code, 0, "the default schedule is wrong\n" + r.out)
})

test("saving a station reaches the writer through State.serializeState", { skip }, () => {
  // writeState is the one caller of serializeState (#21), and only this
  // harness executes it. A bad call there throws out of saveStation. PATH is empty, so the writer's sh
  // fails to spawn and nothing is written anywhere.
  const r = runService(
    // Resolve the startup read first. It is asynchronous, and finishing after
    // the save would reset the list to the (empty) file -- a harness race,
    // since a person cannot pick a station within milliseconds of startup.
    "Service.attach({}); Service.consumeState('');" +
    " Service.saveStation({ stopId: '635', name: '14 St-Union Sq'," +
    " routes: ['4', '5', '6'], direction: 'N' }); root.done = true",
    // root.done, because the list is updated BEFORE writeState runs: a throw
    // in it would leave stations looking saved. Only a save that returned
    // sets it.
    "root.done && Service.stations.length === 1 && Service.activeStationId === '635'")
  assert.equal(r.code, 0, "saveStation did not complete\n" + r.out)
})

test("out-of-range settings are clamped to the schema's bounds (#25)", { skip }, () => {
  // A hand-edited shell.json is not held to the settings UI's min and max.
  // Each of these is outside its schema range, or not a number at all.
  const r = runService(
    "Service.attach({});" +
    " Service.configure({ pollIntervalOpenSec: 0, pollIntervalIdleSec: 100000," +
    " alertsIntervalSec: 0, staleAfterSec: -1, trainsPerDirection: '5' })",
    "Service.openInterval === 10 && Service.idleInterval === 600" +
    " && Service.alertsInterval === 60 && Service.staleAfterSec === 60" +
    " && Service.trainsPerDirection === 3 && Service.pollIntervalMs === 600000")
  assert.equal(r.code, 0, "a setting escaped its bounds\n" + r.out)
})

// The widget's half of #15, which the tests above cannot see: they call
// Service.configure() themselves, so they pass whether or not Panel.qml ever
// does. Loading Panel.qml for real needs the bar's own Ui components, so these
// read the source instead -- crude, but they fail on exactly the edits that
// bring #15 back. Static, so unlike the tests above they run without quickshell.
//
// Line comments are stripped first, and only where `//` starts the line or
// follows whitespace, so a URL's "https://" survives. The comments around this
// wiring NAME everything checked here, and prose must not satisfy -- or fail --
// a guard.
function source(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8").replace(/(^|\s)\/\/.*$/gm, "$1")
}

test("the widget hands over every settings change", () => {
  assert.match(source("Panel.qml"),
    /onSettingsChanged:\s*Service\.configure\(\s*root\.settings\s*\)/,
    "Panel.qml must forward settings from onSettingsChanged: the bar injects " +
    "them after Component.onCompleted, so attach() is too early")
})

test("the widget does not hand settings to attach", () => {
  const panel = source("Panel.qml")
  const start = panel.indexOf("Service.attach(")
  assert.notEqual(start, -1, "Panel.qml no longer attaches")
  const call = panel.slice(start, panel.indexOf("})", start) + 2)
  assert.doesNotMatch(call, /settings/,
    "attach() runs before the bar injects settings; whatever it is handed " +
    "there is the empty default")
})

test("attach does not take settings", () => {
  const service = source("Service.qml")
  const start = service.indexOf("function attach(options) {")
  assert.notEqual(start, -1, "Service.qml no longer has attach(options)")
  const body = service.slice(start, service.indexOf("\n  }\n", start))
  assert.doesNotMatch(body, /settings/,
    "attach() must not latch settings: the first surface attaches holding " +
    "the empty default (#15)")
})

// ---- weather.json: bounded, like the state file -----------------------------

const SETTINGS_DIR = path.join(".local", "state", "omarchy", "settings")

// Plants weather.json (or a symlink named for it) and puts the real dd on PATH,
// which is all the bounded read needs.
function withWeather(plant) {
  return function (home, bin) {
    fs.symlinkSync(execFileSync("sh", ["-c", "command -v dd"], { encoding: "utf8" }).trim(),
                   path.join(bin, "dd"))
    const dir = path.join(home, SETTINGS_DIR)
    fs.mkdirSync(dir, { recursive: true })
    plant(path.join(dir, "weather.json"), home)
  }
}

test("the weather location is read into origin", { skip }, () => {
  // The control for the two refusals below: the same dd, a real file.
  const r = runService("Service.attach({})",
    "Service.origin !== null && Service.origin.lat === 40.67 && Service.origin.lon === -73.95",
    1500, withWeather((p) => fs.writeFileSync(p,
      JSON.stringify({ name: "Brooklyn", latitude: 40.67, longitude: -73.95 }))))
  assert.equal(r.code, 0, "a real weather.json was not read\n" + r.out)
})

test("weather.json is not followed through a symlink", { skip }, () => {
  // It was a FileView, which follows links and reads without bound -- exactly
  // what the marketplace review flagged for the state file, and what that
  // file's bounded read was built to refuse. This file sits at a predictable
  // path in the same directory.
  const r = runService("Service.attach({})", "Service.origin === null",
    1500, withWeather((p, home) => {
      const target = path.join(home, "elsewhere.json")
      fs.writeFileSync(target, JSON.stringify({ latitude: 40.67, longitude: -73.95 }))
      fs.symlinkSync(target, p)
    }))
  assert.equal(r.code, 0, "a symlinked weather.json was followed\n" + r.out)
})

test("weather.json is read only up to its cap", { skip }, () => {
  // Valid JSON, padded past the 4 KiB cap: the read stops at the cap, the
  // truncated text does not parse, and origin stays unset -- rather than the
  // shared shell reading however much the file holds.
  const r = runService("Service.attach({})", "Service.origin === null",
    1500, withWeather((p) => fs.writeFileSync(p,
      JSON.stringify({ latitude: 40.67, longitude: -73.95, pad: " ".repeat(8192) }))))
  assert.equal(r.code, 0, "an oversized weather.json was read whole\n" + r.out)
})

// ---- alerts: only a fetch that succeeded is decoded -------------------------

// A fake curl that prints the saved alerts feed -- 195 alerts -- and exits with
// `code`. It stands in for the real one only inside the scratch bin.
function withCurl(code) {
  return function (home, bin) {
    const fixture = path.join(ROOT, "tests", "fixtures", "alerts.pb")
    const cat = execFileSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).trim()
    fs.writeFileSync(path.join(bin, "curl"),
      "#!/bin/sh\n" + cat + " '" + fixture + "'\nexit " + code + "\n", { mode: 0o755 })
  }
}

test("a successful alerts fetch is decoded", { skip }, () => {
  // The control: the same fake curl, exiting 0.
  const r = runService("Service.attach({})",
    "Service.alerts.length === 195 && Service.alertsFailures === 0", 2000, withCurl(0))
  assert.equal(r.code, 0, "a good alerts fetch was not absorbed\n" + r.out)
})

test("alerts from a curl that FAILED are not decoded", { skip }, () => {
  // curl streams the body to stdout as it arrives, so a timeout (28) partway
  // through leaves whatever arrived. The stdout handler used to decode it
  // regardless of the exit code, and a cut that landed on an entity boundary
  // decodes cleanly -- replacing the alert list with part of it, silently. The
  // train feeds already wait for the exit code; alerts now do too.
  const r = runService("Service.attach({})",
    "Service.alerts.length === 0 && Service.alertsFailures === 1", 2000, withCurl(28))
  assert.equal(r.code, 0, "a failed fetch's output was decoded\n" + r.out)
})


// ---- notifications follow every saved route (#23) ---------------------------

// A fake notify-send that appends each notification's body to `log`. Service
// calls it as `notify-send -a Headway -- <summary> <body>`, so the body is $5.
// Its shebang is an absolute /bin/sh and printf is a builtin, so it runs with
// PATH empty.
function withNotifyLog(log) {
  return function (home, bin) {
    fs.writeFileSync(path.join(bin, "notify-send"),
      "#!/bin/sh\nprintf '%s\\n' \"$5\" >> '" + log + "'\n", { mode: 0o755 })
  }
}

const js = (v) => JSON.stringify(v)
const alertOn = (id, routes) =>
  ({ id: id, alertType: "Delays", routes: routes, periods: [], headerText: id })
const station = (id, routes) =>
  ({ stopId: id, name: id, routes: routes, direction: "N" })

test("three notifications raised in one tick are all sent, in order", { skip }, () => {
  // Process.running reads false until the event loop starts the process, so
  // the queue used to hand the second and third notification to a process it
  // took for idle -- overwriting the first's command. Only the last was sent.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "headway-notify-"))
  const log = path.join(logDir, "log")
  try {
    const r = runService(
      "Service.attach({}); Service.notify('s', 'one'); Service.notify('s', 'two');" +
      " Service.notify('s', 'three'); root.done = true",
      "root.done", 2000, withNotifyLog(log))
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["one", "two", "three"])
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true })
  }
})

test("a missing notify-send does not stall the queue", { skip }, () => {
  // A failed spawn emits only runningChanged(false), which must clear `busy`
  // -- otherwise the first notification with notify-send absent latches the
  // queue shut for the life of the shell.
  const r = runService(
    "Service.attach({}); Service.notify('s', 'one'); Service.notify('s', 'two')",
    "Service.notifyQueue.length === 0", 1500)
  assert.equal(r.code, 0, "the queue stalled\n" + r.out)
})

test("alerts notify for every saved route, with no burst on save or switch (#23)", { skip }, () => {
  // One scripted session. Expected: B, D and F notify, and nothing else.
  //   A  running at startup                 absorbed (backlog)
  //   B  new on the active station's 6      notifies
  //   C  running on L before L is saved     absorbed when L's station is saved
  //   D  new on L                           notifies
  //   F  new on L while 635 is active       notifies -- every saved route counts
  //   G  new while notifications are off   remembered, so it stays silent
  //                                         when they are turned back on
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "headway-notify-"))
  const log = path.join(logDir, "log")
  try {
    const A = alertOn("A", ["6"]), B = alertOn("B", ["6"]), C = alertOn("C", ["L"])
    const D = alertOn("D", ["L"]), F = alertOn("F", ["L"]), G = alertOn("G", ["6"])
    const r = runService(
      "Service.attach({}); Service.consumeState('');" +
      " Service.saveStation(" + js(station("635", ["6"])) + ");" +
      " Service.alertsArrived(" + js([A]) + ");" +
      " Service.alertsArrived(" + js([A, B]) + ");" +
      " Service.alertsArrived(" + js([A, B, C]) + ");" +
      " Service.saveStation(" + js(station("L08", ["L"])) + ");" +
      " Service.alertsArrived(" + js([A, B, C, D]) + ");" +
      " Service.setActive('635');" +
      " Service.alertsArrived(" + js([A, B, C, D, F]) + ");" +
      " Service.configure({ notifyRouteAlert: false });" +
      " Service.alertsArrived(" + js([A, B, C, D, F, G]) + ");" +
      " Service.configure({});" +
      " Service.alertsArrived(" + js([A, B, C, D, F, G]) + ");" +
      " root.done = true",
      "root.done", 2500, withNotifyLog(log))
    assert.equal(r.code, 0, "the session did not complete\n" + r.out)
    const sent = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
    assert.deepEqual(sent, ["B", "D", "F"])
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true })
  }
})

// ---- the bar with no station to show (#19) ----------------------------------

test("removing the last station clears the old feed status (#19)", { skip }, () => {
  // refresh() returned early with no station and left ok, error and
  // feedTimestamp as the last station had them: permanently red on a dead
  // feed, or amber once that timestamp aged past staleAfterSec. And wasStale
  // left true made the next real poll announce "current again".
  const r = runService(
    "Service.attach({}); Service.consumeState('');" +
    " Service.saveStation(" + js(station("635", ["6"])) + ");" +
    " Service.ok = false; Service.error = 'boom';" +
    " Service.feedTimestamp = 123; Service.wasStale = true;" +
    " Service.removeStation('635')",
    "Service.ok === true && Service.error === '' && Service.feedTimestamp === 0" +
    " && Service.wasStale === false && Service.arrivals.length === 0" +
    " && Service.loading === false && Service.barState.severity === 'ok'")
  assert.equal(r.code, 0, "the old status survived\n" + r.out)
})

test("a station no feed serves says so, instead of keeping the last status (#19)", { skip }, () => {
  // Only a hand-edited file can hold one -- every station the picker offers
  // maps to a feed -- but then something really is wrong, and the panel
  // should say what rather than go quietly blank.
  const r = runService(
    "Service.attach({});" +
    " Service.consumeState(" + js(js({ stations: [station("X1", ["ZZ"])] })) + ")",
    "Service.ok === false && Service.error === \"no feed serves this station's routes\"" +
    " && Service.arrivals.length === 0 && Service.feedTimestamp === 0")
  assert.equal(r.code, 0, "the no-feed station was not reported\n" + r.out)
})
