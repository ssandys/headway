// tests/fetch.test.js
const test = require("node:test")
const assert = require("node:assert/strict")

const Fetch = require("../Fetch.js")

test("curlArgs puts the url last so it can never be read as a flag", () => {
  const args = Fetch.curlArgs("https://example.com/feed", 4194304, 15)
  assert.equal(args[0], "curl")
  assert.equal(args[args.length - 1], "https://example.com/feed")
})

test("curlArgs carries the timeout and the byte cap curl enforces", () => {
  const args = Fetch.curlArgs("https://example.com/feed", 4194304, 15)
  assert.equal(args[args.indexOf("--max-time") + 1], "15")
  assert.equal(args[args.indexOf("--max-filesize") + 1], "4194304")
})

test("curlArgs pins the protocol and refuses to follow redirects", () => {
  const args = Fetch.curlArgs("https://example.com/feed", 4194304, 15)
  assert.equal(args[args.indexOf("--proto") + 1], "=https")
  assert.ok(!args.includes("--location"), "a redirect is attack surface the feed does not need")
  assert.ok(args.includes("--fail"), "an HTTP error must be an exit code, not a body")
})

test("curlArgs refuses a url that is not https", () => {
  assert.equal(Fetch.curlArgs("http://example.com/feed", 4194304, 15), null)
  assert.equal(Fetch.curlArgs("file:///etc/passwd", 4194304, 15), null)
})

test("curlArgs numbers are strings, because Process.command takes argv", () => {
  const args = Fetch.curlArgs("https://example.com/feed", 4194304, 15)
  args.forEach(function (a) { assert.equal(typeof a, "string") })
})

test("errorText is empty on success, so callers can test it as a flag", () => {
  assert.equal(Fetch.errorText(0), "")
})

test("errorText names the failure a routing change actually produces", () => {
  // Issue #1: switching a Tailscale exit node left the panel reading
  // "feed unreachable - HTTP 0", which says nothing about what broke.
  assert.match(Fetch.errorText(6), /resolve/i)
  assert.match(Fetch.errorText(7), /connect/i)
  assert.match(Fetch.errorText(28), /timed out/i)
})

test("errorText distinguishes an oversized feed from a network failure", () => {
  assert.match(Fetch.errorText(63), /too large/i)
})

test("errorText reports an HTTP error, which --fail turns into exit 22", () => {
  assert.match(Fetch.errorText(22), /HTTP/)
})

test("errorText never returns empty for a failure it does not recognise", () => {
  // A silent empty string would render as "feed unreachable - " and strand the
  // user with no clue at all, which is the bug this mapping exists to fix.
  const unmapped = [1, 35, 60, 77, 92]
  unmapped.forEach(function (code) {
    const text = Fetch.errorText(code)
    assert.notEqual(text, "", "exit " + code + " must still say something")
    assert.match(text, new RegExp(String(code)), "and must name the code")
  })
})

test("errorText names a missing curl, which is a failed spawn rather than an exit", () => {
  // Quickshell's Process never emits exited() on a failed SPAWN, so the feed
  // delegate synthesises 127 -- the shell convention for command-not-found --
  // to resolve a fetch that never started. curl's own codes stop well below
  // it, so the sentinel cannot collide with a real curl failure.
  assert.match(Fetch.errorText(127), /not installed|not found/i)
})

// ---------------------------------------------------------------------------
// Backing off a failed alerts poll (issue #9)
//
// Alerts poll on a 300s timer that does not shorten on failure, so a shell
// started during a network outage shows no alerts for up to five minutes after
// arrivals have already recovered on the next 30s poll. Retrying at the
// arrivals cadence forever is the other failure -- a missing curl would then
// spawn a doomed process every 30s indefinitely -- so the delay grows back.

test("retryDelaySec uses the normal interval when nothing has failed", () => {
  assert.equal(Fetch.retryDelaySec(0, 300), 300)
})

test("retryDelaySec retries the first failure well inside the normal interval", () => {
  // The point of the fix: recover with arrivals, not five minutes after them.
  const delay = Fetch.retryDelaySec(1, 300)
  assert.ok(delay <= 30, "first retry should be prompt, got " + delay)
  assert.ok(delay > 0, "and must still be a delay, got " + delay)
})

test("retryDelaySec backs off as failures repeat", () => {
  const first = Fetch.retryDelaySec(1, 300)
  const second = Fetch.retryDelaySec(2, 300)
  const third = Fetch.retryDelaySec(3, 300)
  assert.ok(second > first, "second retry must wait longer than the first")
  assert.ok(third > second, "and the third longer than the second")
})

test("retryDelaySec never polls slower than the normal interval", () => {
  // A sustained outage must settle back to the configured cadence, not drift
  // past it and leave alerts stale long after the feed returns.
  for (let n = 0; n <= 20; n++) {
    assert.ok(Fetch.retryDelaySec(n, 300) <= 300,
      "failure " + n + " waited longer than the interval")
  }
})

test("retryDelaySec never polls faster than a short configured interval", () => {
  // alertsIntervalSec is a setting. If someone sets it below the retry floor,
  // the retry must not become a speed-up.
  for (let n = 0; n <= 5; n++) {
    assert.ok(Fetch.retryDelaySec(n, 10) <= 10,
      "failure " + n + " polled faster than the configured 10s")
  }
})

test("retryDelaySec treats a nonsense failure count as no failure", () => {
  ;[-1, NaN, null, undefined, "2"].forEach(function (bad) {
    assert.equal(Fetch.retryDelaySec(bad, 300), 300,
      "count " + String(bad) + " should fall back to the normal interval")
  })
})
