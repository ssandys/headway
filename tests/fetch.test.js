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
