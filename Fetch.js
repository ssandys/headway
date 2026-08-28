// Feed fetching for Headway: the argv Service.qml hands to Process, and the
// error text a curl exit code becomes.
//
// Loaded by Service.qml (import "Fetch.js" as Fetch) AND by node --test, so it
// carries the same engine constraints as Gtfs.js and Model.js: no I/O, no QML
// imports, no state between calls, everything at top level `var` or `function`.
// Never introduce arrow functions, spread, template literals, let/const,
// Object.assign, .includes( or .endsWith( in this file.
//
// Why curl at all, when QML has XMLHttpRequest: a poll must not reuse anything
// from the poll before it. Qt's XMLHttpRequest is backed by one long-lived
// QNetworkAccessManager whose connection pool and DNS cache outlive any single
// request, so a routing change underneath the running shell -- switching a
// Tailscale exit node, moving between networks, a VPN going up -- leaves every
// later poll reaching for sockets and addresses that no longer route anywhere.
// Restarting the shell was the only cure. A curl process cannot carry that
// state across polls because it does not survive the poll.

function curlArgs(url, maxBytes, timeoutSec) {
  // https only, checked here as well as by --proto. feedUrl() builds these from
  // a fixed base so a bad scheme is not reachable today; this keeps it that way
  // if a URL ever becomes a setting.
  if (typeof url !== "string" || url.indexOf("https://") !== 0) return null
  return [
    "curl",
    "-sS",           // no progress meter, but do report errors on stderr
    "--fail",        // an HTTP error is an exit code, never a body to decode
    "--proto", "=https",
    "--max-time", String(timeoutSec),
    // Verified against the live feed: curl aborts on the Content-Length before
    // writing a single byte to stdout, so an oversized body never reaches the
    // shell's heap at all.
    "--max-filesize", String(maxBytes),
    // Last, always. curl reads a leading `-` as a flag, and the url is the one
    // argument that could ever grow to be caller-supplied.
    url
  ]
}

// curl's exit codes, turned into something a rider can act on. The XHR path
// this replaces reported every network-level failure as `HTTP 0` -- the status
// of a request that never got a response -- so a DNS failure, a refused
// connection and a dead route were one indistinguishable string. Issue #1 was
// diagnosed by restarting the shell rather than by reading the panel.
function errorText(exitCode) {
  if (exitCode === 0) return ""
  switch (exitCode) {
    case 6:  return "cannot resolve the feed host"
    case 7:  return "cannot connect to the feed host"
    case 28: return "timed out"
    case 63: return "feed too large"
    // --fail collapses every 4xx and 5xx into 22. The status itself is not
    // recoverable without --write-out, and the distinction has never mattered
    // here: the feed is either served or it is not.
    case 22: return "HTTP error from the feed"
    // Never silent. An unmapped code still names itself, so the panel says
    // something specific enough to search for.
    default: return "curl exit " + exitCode
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    curlArgs: curlArgs,
    errorText: errorText
  }
}
