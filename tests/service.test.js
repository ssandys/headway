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
function runService(script, check, wait) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headway-service-"))
  try {
    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f))
    const home = path.join(dir, "home")
    const emptyBin = path.join(dir, "empty-bin")
    fs.mkdirSync(home)
    fs.mkdirSync(emptyBin)
    fs.writeFileSync(path.join(dir, "harness.qml"),
      "import QtQuick\n" +
      "import Quickshell\n" +
      "import \".\"\n" +
      "ShellRoot {\n" +
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
