// The saved-stations file, as argv: what Service.qml hands to Process to read
// it and to write it.
//
// Loaded by Service.qml (import "State.js" as State) AND by node --test, so it
// carries the same engine constraints as Gtfs.js and Model.js: no I/O, no QML
// imports, no state between calls, everything at top level `var` or `function`.
// Never introduce arrow functions, spread, template literals, let/const,
// Object.assign, .includes( or .endsWith( in this file.
//
// It lives here, rather than as string literals inside Service.qml, because
// this is the one place Headway touches a predictable path an attacker can
// plant on -- and as literals it was the least tested code in the plugin
// instead of the most. tests/state.test.js executes what these functions
// return, against a symlink, a FIFO, an oversized file and a hostile payload.

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

if (typeof module !== "undefined") {
  module.exports = {
    readArgs: readArgs,
    writeArgs: writeArgs
  }
}
