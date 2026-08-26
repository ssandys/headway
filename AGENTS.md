# AGENTS.md — extending Headway

Read this before changing anything. Most of it is failures that already
happened on this branch, not advice.

## Layer map

| File | Holds | Testable by |
|---|---|---|
| `Gtfs.js` | Protobuf primitives, the feed map, `decodeTripUpdates`, `decodeAlerts` | `node --test`, and a headless `qml6` probe |
| `Stations.js` | The station table's accessors: `byId`, `search`, `directionsFor`, `boroughName`, `parentOf`, `platformId`, haversine | same |
| `StationData.js` | 496 generated station records. Do not hand-edit | same |
| `Model.js` | Arrival assembly, alert classification, bar state, all display formatting | same |
| `Service.qml` | I/O only: XHR polling, `FileView` state, `notify-send` | **The live shell only** |
| `Panel.qml` | Rendering only: the bar button, its badge, the panel | **The live shell only** |
| `RouteBullet.qml` | One MTA route bullet — disc for local, diamond for express | **The live shell only** |

**Every decision worth testing lives in the pure modules,** and all of them are
reachable from `node --test`. `Service.qml` and `Panel.qml` hold only I/O and
rendering precisely so the unverifiable surface stays as small as possible.
That is an argument for keeping it that way, not an accident. When you add
logic, ask which side of that line it belongs on before writing it.

## The two invariants

**1. The pure modules stay QML-safe and dual-loadable.** They are parsed by
both Qt's V4 engine and node. No arrow functions, spread, template literals,
`let`/`const`, `Object.assign`, `.includes(`, or `.endsWith(`. Everything at
top level is `var` or `function`. `String.fromCodePoint` is the one verified
exception. The export shim at the bottom of each file is what lets node see it.

**2. Zero runtime dependencies.** No interpreter, no API key, no packages. The
only external program is `notify-send`, and its absence must stay harmless.

## Traps

### No pure module may hold mutable state

Every module-level `var` in `Gtfs.js`, `Stations.js`, `Model.js` and
`StationData.js` is a constant — assigned once at load, never reassigned. This
is not tidiness. **Without `.pragma library`, every QML component that imports
a `.js` file gets its OWN instance of it.** Measured: a component calling
`load([1,2,3])` sees three entries while another component importing the same
file still sees zero.

`Stations.js` originally kept the station table in a module variable, injected
once by `Service.qml`. `Panel.qml` would never have seen it — `byId()` null,
`search()` empty, **the station picker dead** — and every one of its 14 tests
passed, because under node the injection works exactly as written. It would
have surfaced only in the live shell.

The two fixes that look obvious both fail. `.pragma library` shares the
instance but makes node refuse to parse the file (`Unexpected token '.'`),
ending its test coverage. Loading in `Component.onCompleted` is too late: a
`Repeater`'s `model:` binding evaluates **before** its own component's
`onCompleted`.

So state is passed per call — `byId(stations, id)`, `search(stations, …)`. If
you add a cache, a memo table, or a lazily-built index to any of these files,
you reintroduce this bug and no test in this repo will tell you.

### Headway's own

| Trap | What happens |
|---|---|
| **Express route ids** | Feeds emit `6X`, `7X`. Anything keying on the raw id drops express trains silently, or renders them as unknown. Always `normalizeRoute` first. `routeColor` does. |
| **Cross-feed trip duplication** | An F trip appears in `gtfs-g` as well as `gtfs-bdfm`, so a rider whose routes span both feeds sees one real train twice. `dedupeTrips` exists for this; its fallback key includes the feed index, because two id-less trips at the same position in two feeds otherwise collide and a real train disappears. |
| **`Alert.effect` and `.cause` are never populated** | Zero alerts in practice. Severity comes from the MTA's Mercury extension, field 1001 sub-field 3. Do not "fix" classification by reading `effect`. |
| **Protobuf group wire types** | 3 and 4 are `START_GROUP`/`END_GROUP`, legal proto2, and GTFS-Realtime IS proto2 -- the NYCT and Mercury extensions attach through `extend` blocks. `walkFields` used to throw on them, and `Service.qml` turns any decode throw into "feed unreachable", so one group-encoded field would have discarded a whole 233 KB feed that returned 200 with good data. `skipGroup` now consumes them, depth-tracked because groups nest. 6 and 7 remain the only invalid wire types, though a MALFORMED group still throws -- unmatched or unterminated. A valid stream reaches neither. |
| **`active_period` filtering is mandatory** | 151 of 195 alerts are `Planned - ` engineering work, much of it for weekends days away. Unfiltered, the glyph pins amber forever. 195 alerts filter down to 7. |
| **Stations, not complexes** | The saved unit is a parent stop. `search` keeps a complex's platforms contiguous, so per-row distances are deliberately not monotonic. Do not "fix" that ordering. |
| **`FileView` fires its own watcher** | `writeState()` trips `watchChanges`, and `FileView.text()` still returns the PREVIOUS content when it does. An unguarded `onFileChanged: loadState()` silently undoes the write — measured as `writeState stations=4` followed immediately by `loadState -> stations=3`, which surfaced as "adding a station takes two clicks". `Service.qml` consumes one watcher event per write. |
| **`Ui/Panel.qml` sets no implicit size** | A bar widget must declare `implicitWidth`/`implicitHeight` from its button. Without them the root is 0×0, `anchors.fill: parent` faithfully passes that zero to the button, and the widget renders **nothing with no error logged**. |
| **`Ui/Panel.qml` provides no `fontFamily`, `dim` or `barIcon`** | Declare them on the root, as galley:39-42 and colophon do. Reading a property that does not exist is a `ReferenceError` raised inside a binding — invisible to `qmllint`, and it fails as a silently unstyled element. |
| **A layout child needs an explicit width** | `contentColumn` must be anchored left/right/top. Unanchored, it takes its own `implicitWidth` — the widest child, an unwrapped alert headline — while the background stays at `contentWidth`, and content paints outside the panel over the window behind. Not `anchors.fill`: pinning the bottom loops against `contentHeight`, which is bound back to `contentColumn.implicitHeight`. |
| **`wrapMode` does not constrain a `Text`** | A wrapping `Text` still reports its full single-line `implicitWidth`, and `Layout.fillWidth` only distributes *surplus* space. Neither caps an implicit width. |

### Inherited from galley and colophon

| Trap | What happens |
|---|---|
| **`Process` spawn failure** | A failed spawn does not emit `exited()`. Use `onRunningChanged` to drain the queue, or a missing `notify-send` hangs it. |
| **`Process.command` while running** | Assigning it mid-run is ignored. Queue instead. |
| **Caller-owned diff state** | Notification diffing state belongs to the caller, not the module. |
| **`BAR_GLYPH` is built, never typed** | `String.fromCodePoint(0xF1308)`. A literal astral character does not survive every editing path, and the failure mode is an invisible widget with nothing logged. The guard asserts the *codepoint*, because a shape check passes just as happily on a typo. |
| **ES3 reserved words** | Avoid them as property names in the pure modules. |
| **A hidden item cannot hold `activeFocus`** | Focus a text field only once its panel is visible. |
| **Typing does not break a QML binding** | A `TextField`'s `text` must be routed into the state its consumers read, or the results binding never updates. |
| **`qml6`, not `qml`** | The unversioned binary is either absent or Qt 5. |

### Nothing in this toolchain gates QML syntax

`qmllint` exited **0, with no output, on a `Panel.qml` that could not parse** —
an unbalanced brace from wrapping a list in a `ColumnLayout`. It also cannot see
a missing root property, which is how `root.fontFamily` nearly shipped broken.

`omarchy plugin validate <folder>` does not cover the gap. Tested directly on a
copy of this repo:

| Defect | `qmllint` | `omarchy plugin validate` |
|---|---|---|
| `manifest.json` missing `id` | — | **exit 1**, names the field |
| `Panel.qml` with brace balance +1 | exit 0 | exit 0 |

So `validate` is a real gate for the manifest and no gate at all for QML.

What actually verifies a QML change:

1. A brace balance count over the file, comments and strings stripped:
   ```bash
   python3 -c "
   import re,sys
   s=open(sys.argv[1]).read()
   t=re.sub(r'//[^\n]*','',s); t=re.sub(r'\"(\\\\.|[^\"\\\\])*\"','\"\"',t)
   print(t.count('{')-t.count('}'))" Panel.qml   # 0 = balanced
   ```
2. `./bin/dev up`, then read the shell's log:
   `journalctl --user _PID=$(pgrep -x quickshell) --since "1 minute ago"`.
   A `ReferenceError` in a binding shows up here and nowhere else.
3. Look at it. A widget can load without error and still render at 0×0.

Treat a clean `qmllint` as no information.

## What is probeable without the live shell

The single most useful thing to know when changing this plugin.

| What | Probeable in headless `qml6`? |
|---|---|
| `Gtfs.js`, `Stations.js`, `Model.js` — the pure modules | **Yes.** `import "Gtfs.js" as Gtfs` loads and runs in Qt's V4 engine. Verified end to end: a fixture read via XHR decoded to 37 trips, the 2³² varint returned `4294967296`, `String.fromCodePoint` and the astral UTF-8 branch worked, and the bounds checks threw. |
| `FileView`, `Process`, `Quickshell.env` | **No.** `/usr/lib/qt6/qml/Quickshell/qmldir` declares `linktarget quickshell-coreplugin` and the package ships no `.so` — the types are compiled into the `quickshell` binary. A generic `qml6` fails with `plugin "quickshell-coreplugin" not found`. Anything touching these is verifiable only in the live shell. |
| `file://` XHR inside a probe | Only with `QML_XHR_ALLOW_FILE_READ=1`. Irrelevant in production (`Service.qml` fetches `https://`), but required if a colophon-style fixture-driven panel is ever added. |

**Qt's V4 `Array.prototype.sort` is not stable.** Node's has been since ES2019,
so no test running only under node can catch it. Measured: 40 items across 8
tied groups come back reordered. `arrivalsFor` carries an explicit `tripId`
tie-breaker for this reason — without it, two trains sharing an `etaSec` swap
places between polls and the panel visibly reshuffles. Any new comparator in
these modules needs a total order, not a partial one.

## Regenerating `StationData.js`

```bash
node scripts/build-stations.mjs
```

It expects 496 rows and warns rather than throws on a different count, so check
its output — an unattended run can commit a short table. It is a hand-run
maintenance script, not part of the build.

## Prototype-chain lookups

Any object used as a lookup table over **upstream data** must be read with
`hasOwnProperty`. A bare `TABLE[key]` walks the prototype chain, so a key of
`"constructor"`, `"toString"` or `"__proto__"` returns a truthy inherited
member. This was a real bug: `classifyAlert("constructor")` returned `red`,
breaking the one safety property it has — that an unrecognised alert type is
never red. `ALERT_RED`, `ALERT_AMBER`, `ROUTE_COLORS` and the `Gtfs.js` feed
map all guard this way.

## How to run things

```bash
./bin/test              # the whole node suite
node --test             # same, directly
./bin/dev up            # deploy as a dev plugin and restart the shell
./bin/dev down          # disable it and restart
./bin/dev status        # what is deployed
./bin/dev-watch         # redeploy on change
omarchy plugin validate .  # manifest gate -- NOT a QML gate, see the traps
node scripts/collect.mjs   # print the snapshot the widget works from
```

`bin/dev` and `bin/dev-watch` are copied **byte-identical** from galley and
derive plugin identity from `manifest.json` at runtime. That portability is what
lets them move to the next plugin unedited, and
`tests/manifest.test.js` guards it by asserting neither script contains a
plugin-specific literal outside a comment. If you hardcode an id there, that
test fails — correctly.

Note that `bin/dev` rewrites the display name in the **deployed** copy, so the
running panel reads `Headway (dev)`. That is why `preview.png` was captured
against a copy with the suffix stripped: a preview is a photograph of what
someone is about to install.

## Never edit `/usr/share/omarchy/`

It is package-managed and will be overwritten. Read it freely — it is the best
available documentation of the shell's own conventions, and every claim in this
file about `Ui/*.qml` came from reading it. Change nothing in it.
