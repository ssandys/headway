// tests/state.test.js
//
// The state file is the one place Headway shells out on a path an attacker can
// plant on, so these tests do not stop at asserting argv: they RUN it, against
// a symlink, a FIFO, an oversized file and a hostile payload. Two rounds of
// internal review walked past a TOCTOU race and a predictable temp name here
// while this code was untested string literals inside QML.
const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const State = require("../State.js")

const CAP = 65536

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "headway-state-"))
}

// Runs argv the way Quickshell's Process would: no shell, 5s ceiling so a
// blocking open fails the test instead of hanging the suite.
function run(argv) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), { timeout: 5000, encoding: "buffer" })
    return { code: 0, out: out }
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: e.stdout || Buffer.alloc(0) }
  }
}

const readFile = (p) => run(State.readArgs(p, CAP)).out.toString()
const writeFile = (p, payload) => run(State.writeArgs(p, payload))

// ---- argv shape ------------------------------------------------------------

test("readArgs opens the file directly, with no shell in the path", () => {
  const argv = State.readArgs("/tmp/x.json", CAP)
  assert.equal(argv[0], "dd")
  assert.ok(!argv.includes("sh"), "a shell would reintroduce quoting and parsing")
})

test("readArgs carries the flags that make the open atomic and bounded", () => {
  const argv = State.readArgs("/tmp/x.json", CAP)
  const iflag = argv.find((a) => a.startsWith("iflag="))
  // nofollow: a symlink fails at open() instead of being tested and then followed.
  // nonblock: a FIFO cannot stall the shared shell process.
  // count_bytes + fullblock: the cap is in bytes and short reads do not truncate.
  for (const f of ["nofollow", "nonblock", "count_bytes", "fullblock"]) {
    assert.ok(iflag.includes(f), "iflag must carry " + f + ", got " + iflag)
  }
  assert.ok(argv.includes("bs=" + CAP))
  assert.ok(argv.includes("count=" + CAP))
})

test("writeArgs passes the payload as a positional parameter, never inline", () => {
  const argv = State.writeArgs("/tmp/x.json", "PAYLOAD-SENTINEL")
  const script = argv[2]
  assert.ok(!script.includes("PAYLOAD-SENTINEL"), "payload must not be interpolated into the script")
  assert.ok(argv.includes("PAYLOAD-SENTINEL"), "payload must be a positional parameter")
})

test("writeArgs uses an unpredictable temp name and a no-follow write", () => {
  const script = State.writeArgs("/tmp/x.json", "p")[2]
  assert.match(script, /mktemp/, "the temp name must be unpredictable and exclusively created")
  assert.match(script, /XXXXXX/, "mktemp needs an X template to randomise")
  assert.match(script, /oflag=nofollow/, "a guessed temp name must not redirect the write")
  assert.match(script, /conv=[a-z,]*nocreat/, "a temp file unlinked mid-flight must not be recreated")
  assert.match(script, /mv -f/, "the publish step must be an atomic rename")
})

// ---- read: executed against hostile inputs ---------------------------------

test("read returns the file when it is an ordinary regular file", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  fs.writeFileSync(p, '{"version":1}')
  assert.equal(readFile(p), '{"version":1}')
})

test("read is empty and clean when the file does not exist (first run)", () => {
  const d = tmpdir()
  assert.equal(readFile(path.join(d, "absent.json")), "")
})

test("read refuses a symlink instead of following it", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  const secret = path.join(d, "secret")
  fs.writeFileSync(secret, "SECRET-CONTENTS")
  fs.symlinkSync(secret, p)
  assert.equal(readFile(p), "", "a symlinked state path must yield nothing")
})

test("read does not stall on a FIFO, even with a writer holding it open", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  execFileSync("mkfifo", [p])
  // A writer that opens the FIFO and then sleeps is the stall attack: a
  // blocking open would hang the shared shell process at startup.
  const holder = require("node:child_process").spawn("sh", ["-c", 'exec 3> "$1"; sleep 30', "h", p])
  try {
    const started = Date.now()
    assert.equal(readFile(p), "")
    assert.ok(Date.now() - started < 3000, "must return promptly, not block")
  } finally {
    holder.kill()
  }
})

test("read truncates an oversized file at the cap", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  fs.writeFileSync(p, Buffer.alloc(CAP * 3, 0x61))
  assert.equal(readFile(p).length, CAP)
})

// ---- write: executed, including the symlink redirect ------------------------

test("write round-trips through read", () => {
  const d = tmpdir(), p = path.join(d, "sub", "headway.json")
  assert.equal(writeFile(p, '{"version":1,"stations":[]}').code, 0)
  assert.equal(readFile(p), '{"version":1,"stations":[]}')
})

test("write leaves no temp file behind", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  writeFile(p, "x")
  assert.deepEqual(fs.readdirSync(d), ["headway.json"])
})

test("write replaces a symlinked destination instead of writing through it", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  const victim = path.join(d, "victim")
  fs.writeFileSync(victim, "ORIGINAL")
  fs.symlinkSync(victim, p)
  writeFile(p, "NEW")
  assert.equal(fs.readFileSync(victim, "utf8"), "ORIGINAL", "the symlink target must be untouched")
  assert.ok(!fs.lstatSync(p).isSymbolicLink(), "the link itself must have been replaced")
})

test("write treats shell metacharacters in the payload as literal text", () => {
  const d = tmpdir(), p = path.join(d, "headway.json")
  const hostile = '{"name":"$(whoami) `id` ;rm -rf / \\"quoted\\" \'single\'"}'
  writeFile(p, hostile)
  assert.equal(readFile(p), hostile)
})

// ---- the platform guarantee these flags are chosen for ----------------------

test("dd's nofollow refuses a symlinked output, which is what protects the temp file", () => {
  // mktemp hands back a NAME, not a descriptor, so the write necessarily
  // reopens by path. This asserts the guarantee that reopen relies on.
  const d = tmpdir()
  const victim = path.join(d, "victim")
  const planted = path.join(d, "planted")
  fs.writeFileSync(victim, "ORIGINAL")
  fs.symlinkSync(victim, planted)
  const r = run(["sh", "-c", 'printf %s ATTACK | dd of="$1" conv=nocreat oflag=nofollow status=none', "t", planted])
  assert.notEqual(r.code, 0, "dd must refuse to open a symlink for writing")
  assert.equal(fs.readFileSync(victim, "utf8"), "ORIGINAL")
})

// ---------------------------------------------------------------------------
// Reporting a failed write (issue #8)
//
// The write is fire-and-forget today: stateWriter's onRunningChanged re-queues
// a pending payload and never reads the exit code, so a read-only settings
// directory, a full disk or an unwritable temp loses the saved station with no
// signal at all. The panel keeps showing it because root.stations was already
// updated in memory, so the loss only surfaces on the next shell restart.

test("writeErrorText says nothing when the write succeeded", () => {
  assert.equal(State.writeErrorText(0), "")
})

test("writeErrorText never returns empty for a failure it does not recognise", () => {
  // Same rule as Fetch.errorText: a silent empty string is how this bug got
  // filed in the first place. An unmapped code must still name itself.
  const unmapped = [1, 2, 13, 28]
  unmapped.forEach(function (code) {
    const text = State.writeErrorText(code)
    assert.notEqual(text, "", "exit " + code + " must still say something")
    assert.match(text, new RegExp(String(code)), "and must name the code")
  })
})

test("writeErrorText names a missing shell, which is a failed spawn rather than an exit", () => {
  // writeArgs runs `sh -c`, and Quickshell's Process never emits exited() on a
  // failed SPAWN -- the same hole that stranded the feed poll in 8247826. The
  // writer synthesises 127 for it, so the text must not read as a script error.
  assert.match(State.writeErrorText(127), /sh|shell/i)
})

test("writeErrorText says what was lost, not just that something failed", () => {
  // The user-visible consequence is a station that silently will not come back
  // after a restart. A line reading only "exit 1" does not let anyone act.
  ;[1, 127].forEach(function (code) {
    assert.match(State.writeErrorText(code), /save|saved|station/i)
  })
})

// ---------------------------------------------------------------------------
// Parsing the file's contents (issue #7)
//
// validStation and parseState are what bound headway.json -- the 50-station
// cap, the per-field type and length checks, the rejection of malformed
// entries. They lived in Service.qml, which node --test cannot load, so the
// most security-sensitive validation in the plugin was the only validation
// with no coverage. The same thing was true of readArgs and writeArgs above,
// and two review rounds walked past real bugs in them while it was.
//
// A miss here is louder than a bad row: an entry without `routes` reaches
// Model.alertsFor through a property binding, and a throw in a QML binding
// removes the whole widget rather than one row.

const LIMITS = { byteLimit: CAP, stationLimit: 50, fieldLimit: 64 }

// A station parseState accepts, so each test varies one field and asserts on
// that field alone.
function entry(over) {
  return Object.assign(
    { stopId: "635", direction: "N", routes: ["4", "5", "6"], name: "51 St" },
    over
  )
}

function parse(doc, limits) {
  const text = typeof doc === "string" ? doc : JSON.stringify(doc)
  return State.parseState(text, limits || LIMITS)
}

// Every rejection case is the same shape: one field made bad, nothing loaded.
function rejects(over, why) {
  assert.deepEqual(parse({ version: 1, stations: [entry(over)] }).stations, [], why)
}

function manyStations(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(entry({ stopId: "s" + i }))
  return out
}

test("parseState returns nothing for the empty read of a first run", () => {
  assert.deepEqual(parse(""), { stations: [], activeStationId: "" })
})

test("parseState survives malformed JSON without throwing", () => {
  // Service.qml has no try/catch around this call any more, so a throw here
  // would reach a QML binding and take the widget with it.
  assert.deepEqual(parse("{not json"), { stations: [], activeStationId: "" })
})

test("parseState yields nothing when stations is not a list", () => {
  assert.deepEqual(parse({ stations: "635" }).stations, [])
  assert.deepEqual(parse({ stations: 7 }).stations, [])
  assert.deepEqual(parse({}).stations, [])
})

test("parseState ignores text larger than the byte cap", () => {
  // Belt as well as braces: readArgs bounds what arrives, this bounds what is
  // parsed if the reader is ever replaced by something that does not.
  const doc = JSON.stringify({ stations: [entry()] })
  assert.equal(parse(doc, { ...LIMITS, byteLimit: doc.length - 1 }).stations.length, 0)
  assert.equal(parse(doc, { ...LIMITS, byteLimit: doc.length }).stations.length, 1)
})

test("parseState loads a well-formed station unchanged", () => {
  const e = entry()
  assert.deepEqual(parse({ version: 1, stations: [e] }).stations, [e])
})

test("parseState keeps at most stationLimit stations", () => {
  assert.equal(parse({ stations: manyStations(49) }).stations.length, 49)
  assert.equal(parse({ stations: manyStations(50) }).stations.length, 50)
  assert.equal(parse({ stations: manyStations(51) }).stations.length, 50)
})

test("parseState rejects a stopId that is missing, empty or not a string", () => {
  rejects({ stopId: undefined }, "a missing stopId names no station")
  rejects({ stopId: "" }, "an empty stopId names no station")
  rejects({ stopId: 635 }, "a number would compare unequal to every saved id")
  rejects({ stopId: ["635"] }, "an array is not an id")
  assert.deepEqual(parse({ stations: [null] }).stations, [], "an entry may be null")
})

test("parseState bounds stopId at fieldLimit", () => {
  assert.equal(parse({ stations: [entry({ stopId: "x".repeat(63) })] }).stations.length, 1)
  assert.equal(parse({ stations: [entry({ stopId: "x".repeat(64) })] }).stations.length, 1)
  assert.equal(parse({ stations: [entry({ stopId: "x".repeat(65) })] }).stations.length, 0)
})

test("parseState rejects a direction the subway does not have", () => {
  rejects({ direction: "E" }, "only N and S exist in this feed")
  rejects({ direction: "n" }, "the comparison is case-sensitive on purpose")
  rejects({ direction: "" }, "an empty direction picks no platform")
  rejects({ direction: undefined }, "direction is required, not optional")
})

test("parseState rejects anything that merely looks like a routes array", () => {
  // S7. `typeof e.routes.length === "number"` admitted both of these, and
  // neither throws downstream -- but neither is a route list either. Shipped
  // fixed at v0.1.1 and never pinned until now.
  rejects({ routes: "456" }, "a string has a numeric length and indexes")
  rejects({ routes: { length: 2 } }, "so does a hand-made object")
})

test("parseState rejects an empty or oversized routes list", () => {
  rejects({ routes: [] }, "a station serving no route has nothing to show")
  assert.equal(parse({ stations: [entry({ routes: Array(64).fill("4") })] }).stations.length, 1)
  assert.equal(parse({ stations: [entry({ routes: Array(65).fill("4") })] }).stations.length, 0)
})

test("parseState rejects a route that is not a bounded string", () => {
  rejects({ routes: ["4", 5] }, "a numeric route id would miss every route table")
  rejects({ routes: ["x".repeat(65)] }, "a route id is bounded like every other field")
})

test("parseState allows name to be absent but not to be the wrong type", () => {
  assert.equal(parse({ stations: [entry({ name: undefined })] }).stations.length, 1)
  rejects({ name: 51 }, "name reaches a QML Text element")
})

test("parseState drops only the invalid entry, keeping its valid neighbours", () => {
  const doc = { stations: [entry({ stopId: "a" }), entry({ stopId: "b", direction: "E" }), entry({ stopId: "c" })] }
  assert.deepEqual(parse(doc).stations.map((s) => s.stopId), ["a", "c"])
})

test("parseState rejects an activeStationId that is not a bounded string", () => {
  assert.equal(parse({ stations: [], activeStationId: 635 }).activeStationId, "")
  assert.equal(parse({ stations: [], activeStationId: "x".repeat(65) }).activeStationId, "")
})

test("parseState keeps an activeStationId that names a loaded station", () => {
  const doc = { stations: [entry({ stopId: "a" }), entry({ stopId: "b" })], activeStationId: "b" }
  assert.equal(parse(doc).activeStationId, "b")
})

test("parseState treats a prototype-chain stopId as ordinary text", () => {
  // Defensive. Nothing in Service.qml or Stations.byId indexes an object by
  // stopId -- both are linear scans -- so this is not the live bug it is in
  // Model.js and Stations.js. It is pinned so that stops being true loudly.
  const doc = { stations: [entry({ stopId: "__proto__" }), entry({ stopId: "constructor" })] }
  assert.deepEqual(parse(doc).stations.map((s) => s.stopId), ["__proto__", "constructor"])
})

// ---- what a hand-edited file can still get wrong (issue #7) -----------------
//
// Two shapes the validator let through entry-by-entry, because neither is
// wrong about any single entry -- only about the list as a whole.

test("parseState keeps the first of two entries sharing a stopId", () => {
  // A duplicate is not a harmless extra row. setDirection and the add path
  // both `break` on the first stopId match, while removeStation filters every
  // copy -- so the second copy is a row you can delete but cannot edit, and
  // toggling its direction silently edits the one above it.
  const doc = { stations: [entry({ stopId: "a", direction: "N" }), entry({ stopId: "a", direction: "S" })] }
  const out = parse(doc).stations
  assert.equal(out.length, 1)
  assert.equal(out[0].direction, "N", "the first wins, which is what both callers already assume")
})

test("parseState counts a duplicate against the station cap", () => {
  // The cap bounds the WALK. 51 entries with one duplicate among the first 50
  // is 50 examined and 49 kept -- the 51st is never reached, and does not get
  // promoted into the freed slot.
  const list = manyStations(51)
  list[1].stopId = list[0].stopId
  assert.equal(parse({ stations: list }).stations.length, 49)
})

test("parseState falls back to the first station when activeStationId names none", () => {
  // Otherwise `saved` scans the list, finds nothing and returns null, so
  // refresh() early-returns and the panel shows no active station while
  // holding a full list. removeStation already falls back this way.
  const doc = { stations: [entry({ stopId: "a" }), entry({ stopId: "b" })], activeStationId: "zzz" }
  assert.equal(parse(doc).activeStationId, "a")
})

test("parseState falls back when activeStationId names a station that was rejected", () => {
  const doc = { stations: [entry({ stopId: "a" }), entry({ stopId: "b", direction: "E" })], activeStationId: "b" }
  assert.equal(parse(doc).activeStationId, "a")
})

test("parseState leaves activeStationId empty when no station loaded", () => {
  assert.equal(parse({ stations: [], activeStationId: "a" }).activeStationId, "")
  assert.equal(parse({ stations: [entry({ direction: "E" })], activeStationId: "635" }).activeStationId, "")
})

test("parseState dedupes a prototype-chain stopId as an ordinary one", () => {
  // F14's write side. `seen["__proto__"] = true` hits the prototype setter and
  // creates no own property at all, so an unprefixed key never recognises the
  // second copy: every ordinary id dedupes and this one does not. Model.js
  // prefixes its dedupe key for exactly this reason. The read side is the
  // prototype-chain test above -- it passes just as happily when the write is
  // broken, which is why both exist.
  const dup = { stations: [entry({ stopId: "__proto__" }), entry({ stopId: "__proto__" })] }
  assert.equal(parse(dup).stations.length, 1, "an identical __proto__ station must dedupe")
})
