// tests/dev.test.js
//
// bin/dev's restart path, driven for real against PATH-shimmed omarchy
// binaries and a scratch $HOME.
//
// `omarchy restart shell` kills the running shell and launches a replacement,
// and the launch can win the race: the new process finds the old still alive,
// refuses with "An instance of this configuration is already running", and
// then the old exits on the IPC request it was already given. Nothing is left
// running, and bin/dev used to exit 0 and print its success lines anyway.
// Observed twice on 2026-09-22; no coredump either time, because a clean exit
// is not a crash. See issue #14.
//
// The shim's `restart shell` deliberately starts nothing, which is exactly
// that failure -- so these tests drive the guard rather than the happy path.
const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const REPO = path.join(__dirname, "..")

// A scratch HOME plus a PATH directory of shims. `pingSucceedsAfter` is which
// `shell ping` call first answers, so a test can make the shell come back
// late, or never.
function scratch(pingSucceedsAfter, restartExitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headway-dev-"))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const log = path.join(dir, "calls.log")
  const counter = path.join(dir, "pings")
  fs.writeFileSync(log, "")
  fs.writeFileSync(counter, "0")

  // `restart shell` can exit non-zero: omarchy-restart-shell reports
  // "Omarchy shell did not become ready after restart" when it loses its own
  // race. Default 0 keeps the other tests as they were.
  const rc = restartExitCode === undefined ? 0 : restartExitCode
  fs.writeFileSync(path.join(bin, "omarchy"),
    `#!/bin/bash\n` +
    `echo "omarchy $*" >> ${JSON.stringify(log)}\n` +
    `if [[ "$1 $2" == "restart shell" ]]; then exit ${rc}; fi\n` +
    `exit 0\n`,
    { mode: 0o755 })

  fs.writeFileSync(path.join(bin, "omarchy-shell"),
    `#!/bin/bash\n` +
    `echo "omarchy-shell $*" >> ${JSON.stringify(log)}\n` +
    `if [[ "$1 $2" == "shell ping" ]]; then\n` +
    `  n=$(cat ${JSON.stringify(counter)}); n=$((n + 1)); echo "$n" > ${JSON.stringify(counter)}\n` +
    `  if (( n >= ${pingSucceedsAfter} )); then echo ok; exit 0; fi\n` +
    `  exit 1\n` +
    `fi\nexit 0\n`,
    { mode: 0o755 })

  return {
    dir, bin,
    calls: () => fs.readFileSync(log, "utf8"),
    restarts: () => (fs.readFileSync(log, "utf8").match(/^omarchy restart shell$/gm) || []).length
  }
}

function runUp(s) {
  try {
    const out = execFileSync(path.join(REPO, "bin", "dev"), ["up"], {
      cwd: REPO, encoding: "utf8", timeout: 60000,
      env: Object.assign({}, process.env, {
        HOME: s.dir,
        PATH: s.bin + path.delimiter + process.env.PATH,
        // Bypasses the live registry query, the same hook wait_for_registration
        // is already tested through.
        DEV_STATE_FIXTURE: "enabled",
        DEV_SHELL_TIMEOUT: "1"
      })
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status,
             out: String(e.stdout || "") + String(e.stderr || "") }
  }
}

test("up succeeds, restarting once, when the shell answers straight away", () => {
  const s = scratch(1)
  const r = runUp(s)
  assert.equal(r.code, 0, "should succeed: " + r.out)
  assert.equal(s.restarts(), 1, "one restart is enough when it works")
})

test("up waits for the shell rather than trusting the restart returned", () => {
  // The restart command returning tells you nothing: it returns before the
  // replacement is answering, which is the whole bug.
  const s = scratch(4)
  const r = runUp(s)
  assert.equal(r.code, 0, "should succeed once the shell answers: " + r.out)
  assert.equal(s.restarts(), 1, "answering inside the first window needs no retry")
  assert.match(s.calls(), /omarchy-shell shell ping/, "it must actually ask")
})

test("up retries the restart once when the shell does not come back", () => {
  // Past the first window (1s at 0.2s intervals), inside the second.
  const s = scratch(7)
  const r = runUp(s)
  assert.equal(r.code, 0, "the retry should recover it: " + r.out)
  assert.equal(s.restarts(), 2, "exactly one retry, not a loop")
})

test("up fails, naming the recovery, when two restarts do not bring it back", () => {
  const s = scratch(9999)
  const r = runUp(s)
  assert.notEqual(r.code, 0, "a dead shell must not exit 0 with success lines")
  assert.match(r.out, /omarchy restart shell/,
    "the error must name the command that recovers it")
  assert.equal(s.restarts(), 2, "two attempts, then give up rather than thrash")
})

test("up survives a restart command that reports failure and recovers", () => {
  // `omarchy restart shell` exits non-zero when it loses its own race -- it
  // prints "Omarchy shell did not become ready after restart" and gives up.
  // Under `set -e` that aborted bin/dev at the restart line, BEFORE the wait
  // and retry that exist for exactly this case, so the guard never ran and the
  // desktop was left with no shell. Measured on a live desktop: the journal
  // showed the replacement refusing with "An instance of this configuration is
  // already running" while bin/dev had already exited.
  //
  // The restart's exit code is not the question. Whether a shell is answering
  // afterwards is.
  const s = scratch(4, 1)
  const r = runUp(s)
  assert.equal(r.code, 0,
    "a failing restart command must not abort the guard: " + r.out)
  assert.equal(s.restarts(), 1, "the shell answered, so no retry was needed")
})

test("up still fails when the restart reports failure AND nothing answers", () => {
  const s = scratch(9999, 1)
  const r = runUp(s)
  assert.notEqual(r.code, 0, "a dead shell must not exit 0")
  assert.match(r.out, /omarchy restart shell/)
  assert.equal(s.restarts(), 2, "two attempts, then give up")
})
