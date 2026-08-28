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
