// The saved-stations file: the argv that reads and writes it, and what its
// contents are allowed to be.
//
// Loaded by Service.qml (import "State.js" as State) AND by node --test, so it
// carries the same engine constraints as Gtfs.js and Model.js: no I/O, no QML
// imports, no state between calls, everything at top level `var` or `function`.
// Never introduce arrow functions, spread, template literals, let/const,
// Object.assign, .includes( or .endsWith( in this file.
//
// It lives here, rather than inside Service.qml, because this is the one place
// Headway touches a predictable path an attacker can plant on -- and in QML it
// was the least tested code in the plugin instead of the most.
// tests/state.test.js executes what the argv functions return, against a
// symlink, a FIFO, an oversized file and a hostile payload, and drives the
// parser with malformed, oversized and adversarial documents.

// Reads the state file, or nothing at all.
//
// ONE open, carrying its guarantees as flags, with no stat beforehand -- there
// is deliberately no check-then-open pair here to race. The previous form
// tested `-L` and `-f` and then reopened the path with `head -c`, which is the
// classic TOCTOU shape: the path could become a symlink or a FIFO in between.
//
//   nofollow    a symlink fails at open() with ELOOP rather than being
//               followed, so the path cannot be aimed at another user's file
//   nonblock    a planted FIFO returns immediately instead of stalling the
//               SHARED shell process -- measured at 3 ms even with a live
//               writer holding the pipe open
//   count_bytes the cap is in bytes rather than blocks
//   fullblock   a short read does not silently truncate valid JSON
//
// There is no fstat-on-the-descriptor check for S_ISREG, because a shell
// cannot fstat a descriptor it does not hold and `dd` exposes no regular-file
// iflag. It is not load-bearing: symlink fails, FIFO cannot stall, a directory
// fails with EISDIR, a socket with ENXIO, and any inode at all is bounded by
// the byte cap. A device node needs root to create, at which point the game is
// already lost. Recorded so this is an adjudicated decision, not an oversight.
//
// No shell: this is dd's own argv. A missing file exits non-zero with empty
// stdout, which is the first-run path and must read as "no saved stations".
function readArgs(statePath, byteLimit) {
  return [
    "dd",
    "if=" + statePath,
    "bs=" + byteLimit,
    "count=" + byteLimit,
    "status=none",
    "iflag=nofollow,nonblock,count_bytes,fullblock"
  ]
}

// Writes the state file, atomically, without ever being redirected.
//
// A shell here is unavoidable -- four steps have to be sequenced -- but the
// payload is a POSITIONAL PARAMETER, never interpolated into the script, so
// quotes, backticks, `$(...)` and semicolons in a station name are written as
// the literal text they are.
//
//   mktemp            an unpredictable name, created O_EXCL at 0600, so there
//                     is nothing to pre-plant. The previous form wrote to a
//                     fixed `headway.json.tmp` through `>`, which follows a
//                     symlink -- measured: it clobbered the link's target
//   oflag=nofollow    mktemp hands back a NAME, not a descriptor, so the write
//                     necessarily reopens by path. This is what makes even a
//                     guessed name unusable
//   conv=nocreat      a temp file unlinked mid-flight is not recreated
//   conv=fsync        the bytes are on disk before the rename publishes them
//   mv -f             rename(2), which replaces a symlinked DESTINATION rather
//                     than writing through it
//
// Cleanup is explicit rather than a trap, which keeps the quoting legible: on
// either failure the temp file is removed, so a failed write leaves no
// randomly-named litter in the settings directory.
function writeArgs(statePath, payload) {
  var script =
    'p="$1"; d=$(dirname -- "$p"); mkdir -p -- "$d" || exit 1; ' +
    't=$(mktemp -- "$d/.headway.json.XXXXXXXX") || exit 1; ' +
    'printf %s "$2" | dd of="$t" conv=nocreat,fsync oflag=nofollow status=none ' +
    '|| { rm -f -- "$t"; exit 1; }; ' +
    'mv -f -- "$t" "$p" || { rm -f -- "$t"; exit 1; }'
  return ["sh", "-c", script, "headway-write", statePath, payload]
}

// What a non-zero exit from the writer means, in terms of what the user lost.
//
// The write was fire-and-forget: no exit code was read, so an unwritable
// settings directory, a full disk or a failed mktemp dropped the saved station
// with no signal. The panel kept showing it -- root.stations is updated in
// memory before the write -- so the loss only appeared on the next restart.
//
// No code is mapped individually because there is nothing to map: every failure
// path in writeArgs exits 1 by hand, and the script's own tools do not have a
// code vocabulary worth translating. What matters is naming the consequence.
function writeErrorText(exitCode) {
  if (exitCode === 0) return ""
  // Not an exit code from the script at all. Quickshell's Process never emits
  // exited() on a failed SPAWN, so the writer synthesises 127 -- the shell
  // convention for command-not-found -- for an sh that would not start.
  if (exitCode === 127) return "cannot run sh to save the station list"
  return "could not save the station list (exit " + exitCode + ")"
}

// What the file is ALLOWED TO CONTAIN. Entries are VALIDATED, not trusted.
//
// headway.json is plain JSON the README invites the user to inspect, so its
// contents are upstream data. An entry without `routes` reaches
// Model.alertsFor through the barState and tooltip property bindings, and a
// throw in a binding removes the whole widget rather than one row.
// Model.worstAlertClass guards this too; both halves are wanted, and this is
// the half that keeps junk out of `refresh()` as well.
//
// The limit is a PARAMETER because no pure module may hold mutable state --
// every QML component that imports this file gets its own instance of it, so
// a limit injected once by Service.qml would be zero everywhere else. Same
// reason Stations.byId takes its table per call.
function validStation(e, fieldLimit) {
  if (!e || typeof e.stopId !== "string" || e.stopId === "") return false
  if (e.stopId.length > fieldLimit) return false
  if (e.direction !== "N" && e.direction !== "S") return false
  // An actual array test. `typeof e.routes.length === "number"` admits a
  // string and {"length": 2}; neither throws downstream, but neither is a
  // route list either. Works in both engines, unlike Array.isArray in ES3.
  if (Object.prototype.toString.call(e.routes) !== "[object Array]") return false
  if (e.routes.length === 0 || e.routes.length > fieldLimit) return false
  for (var i = 0; i < e.routes.length; i++) {
    if (typeof e.routes[i] !== "string") return false
    if (e.routes[i].length > fieldLimit) return false
  }
  if (e.name !== undefined && typeof e.name !== "string") return false
  return true
}

// Turns the file's TEXT into the two properties Service.qml holds, or into
// empty ones. Never throws: the caller assigns the result straight into
// property bindings, so a throw here would take the widget with it.
//
// Takes text, not a path -- everything that reaches here has already been
// capped at byteLimit bytes by readArgs above. limits is
// { byteLimit, stationLimit, fieldLimit }.
function parseState(text, limits) {
  var loaded = []
  var active = ""
  try {
    // Belt as well as braces: readArgs bounds what arrives, and this bounds
    // what is parsed if the reader is ever replaced by something that does not.
    if (text && text.length <= limits.byteLimit) {
      var data = JSON.parse(text)
      var raw = data.stations || []
      // The cap bounds the WALK, not the output: a file of 60 duplicates is
      // 50 entries examined, not 50 kept. That is what makes this O(n) in a
      // number this file chooses rather than in one the file on disk chooses.
      var cap = raw.length < limits.stationLimit
        ? raw.length : limits.stationLimit
      for (var i = 0; i < cap; i++) {
        if (validStation(raw[i], limits.fieldLimit)) loaded.push(raw[i])
      }
      if (typeof data.activeStationId === "string" &&
          data.activeStationId.length <= limits.fieldLimit) {
        active = data.activeStationId
      }
    }
  } catch (e) {
    loaded = []
    active = ""
  }
  return { stations: loaded, activeStationId: active }
}

if (typeof module !== "undefined") {
  module.exports = {
    readArgs: readArgs,
    writeArgs: writeArgs,
    writeErrorText: writeErrorText,
    validStation: validStation,
    parseState: parseState
  }
}
