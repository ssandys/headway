# Inline Route Bullets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw route ids inside alert text as real `RouteBullet`s — coloured disc for a local, diamond for an express — instead of monochrome circled glyphs.

**Architecture:** `Model.js` gains a tokenizer that turns an alert string into lines of word-level runs, each run either a word or a route id, carrying whether a space precedes it. `Panel.qml` renders each line as a `Flow` of `Text` and `RouteBullet` items instead of one `Text`. `RouteBullet` gains a label size computed in `Model.js` so a three-character id stops overflowing its disc.

**Tech Stack:** QML (Qt 6, Quickshell), plain ES3-safe JavaScript modules, `node --test`, headless `qml6` probes.

**Spec:** `docs/superpowers/specs/2026-09-21-inline-route-bullets-design.md`

## Global Constraints

Copied from CONTRIBUTING.md and the spec. Every task's requirements include these.

- **`Model.js` is dual-loaded** by Qt's V4 engine and by node. No arrow functions, spread, template literals, `let`/`const`, `Object.assign`, `.includes(`, `.endsWith(`. Everything at top level is `var` or `function`. `String.fromCodePoint` is the one verified exception.
- **No pure module may hold mutable state.** Every module-level `var` is assigned once at load and never reassigned. No caches, no memo tables, no lazily-built indexes — each QML component gets its own instance of the file.
- **Any object used as a lookup table over upstream data is read with `hasOwnProperty`**, and a table that *records* upstream keys prefixes them.
- **Tests may use modern JavaScript.** The ES3 constraints apply to `Model.js`, not to `tests/`.
- **`qmllint` is not a gate.** A QML change is verified by the brace-balance check, then the live shell, then looking at it.
- **Run the whole suite with `./bin/test`.**
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Branch: `issue-6-alert-descriptions`. Do not merge or tag; the release is held.

---

### Task 1: Bullet label size

Repairs a shipped defect: `SIR` is on 21 stations in `StationData.js`, and `RouteBullet` sizes every label at `0.62 * diameter`, so three characters overflow the disc in the station search and saved rows today.

**Files:**
- Modify: `Model.js` (add `bulletLabelSize`, export it)
- Modify: `RouteBullet.qml:62`
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Model.bulletLabelSize(diameter, label)` → `Number`. `diameter` is the bullet's pixel diameter, `label` the already-normalized label string (`"6"`, `"SIR"`). Returns the label's `font.pixelSize`.

- [ ] **Step 1: Write the failing test**

Append to `tests/model.test.js`:

```js
test("bulletLabelSize leaves a one-character bullet exactly as it ships", () => {
  // Every bullet in the bar, the arrival rows and the saved list is one
  // character. This is a repair to the case nobody has looked at, not a
  // restyle of the case everybody sees -- so this number must not move.
  assert.equal(Model.bulletLabelSize(20, "6"), 20 * 0.62)
  assert.equal(Model.bulletLabelSize(18, "A"), 18 * 0.62)
})

test("bulletLabelSize shrinks a three-character label to fit the disc", () => {
  // SIR is on 21 stations. At 0.62 the three glyphs need about 1.1x the
  // disc's width, which is the overflow visible in the station list today.
  const d = 20
  const size = Model.bulletLabelSize(d, "SIR")
  assert.ok(size < d * 0.62, "must be smaller than the one-character size")
  assert.ok(3 * 0.6 * size <= d * 0.8 + 0.001,
    "three monospace advances must fit the usable chord across the disc")
})

test("bulletLabelSize survives an empty or missing label", () => {
  assert.equal(Model.bulletLabelSize(20, ""), 20 * 0.62)
  assert.equal(Model.bulletLabelSize(20, undefined), 20 * 0.62)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 3 failures, each `TypeError: Model.bulletLabelSize is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `Model.js`, immediately above `function routeColor(`:

```js
// The label's pixel size for a bullet of this diameter.
//
// Lives here rather than in RouteBullet.qml for the reason the colours do:
// "Colour and text colour both come from Model.js so they are unit-tested
// rather than hand-picked per call site." The size is the same kind of
// decision, and it is the only way the SIR case gets a test at all.
//
// 0.62 is what every bullet has always used and what every one-character
// bullet keeps. The second term is the fit: 0.6 is a monospace glyph's
// advance as a fraction of its pixel size, and 0.8 * diameter is the usable
// chord across a disc, so `label.length` glyphs fit within it. SIR lands at
// 0.44 * diameter; anything one or two characters long is unchanged, because
// the cap wins.
function bulletLabelSize(diameter, label) {
  var len = label ? label.length : 1
  if (len < 1) len = 1
  var fitted = (diameter * 0.8) / (0.6 * len)
  var capped = diameter * 0.62
  return fitted < capped ? fitted : capped
}
```

Add to the export block at the bottom of `Model.js`, after `routeColor: routeColor,`:

```js
    bulletLabelSize: bulletLabelSize,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`, total count up by 3.

- [ ] **Step 5: Use it in RouteBullet**

In `RouteBullet.qml`, replace line 62:

```qml
    font.pixelSize: root.diameter * 0.62
```

with:

```qml
    // Model.js, not a literal here, so the SIR case is unit-tested. A
    // one-character label is unchanged to the pixel.
    font.pixelSize: Model.bulletLabelSize(root.diameter,
                                          Model.normalizeRoute(root.routeId))
```

- [ ] **Step 6: Verify the QML parses and the suite is still green**

```bash
python3 -c "
import re,sys
s=open(sys.argv[1]).read()
t=re.sub(r'//[^\n]*','',s); t=re.sub(r'\"(\\\\.|[^\"\\\\])*\"','\"\"',t)
print('brace balance:', t.count('{')-t.count('}'))" RouteBullet.qml
./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `brace balance: 0`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add Model.js RouteBullet.qml tests/model.test.js
git commit -m "fix: a three-character route bullet no longer overflows its disc

SIR is on 21 stations in StationData.js, and every label was sized at
0.62 of the disc's diameter, so three glyphs needed about 1.1x the
width available and spilled out both sides. Visible in the station
search and the saved rows today.

The size moves into Model.js for the reason the colours already live
there -- unit-tested rather than hand-picked per call site. A
one-character label is unchanged to the pixel, which a test pins,
because that is every bullet anyone currently sees.

Refs #6

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The runs tokenizer

**Files:**
- Modify: `Model.js` (add `alertRuns`, export it)
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: `Model.alertTextWithIcons(text)` from the shipped code — substitutes `[accessibility icon]` and friends for Nerd Font glyphs, returns `""` for a non-string.
- Produces: `Model.alertRuns(text)` → `Array` of lines. A line is an `Array` of runs, empty for a blank line. A run is `{ t: "s" | "r", v: String, sp: Boolean }` — `"s"` a literal word, `"r"` a route id carrying the **feed's** id (`"6X"`, not `"6"`), `sp` true when a space precedes the run.

- [ ] **Step 1: Write the failing tests**

Append to `tests/model.test.js`:

```js
// ---------------------------------------------------------------------------
// Alert text as runs (issue #6)
//
// Word-level, because a Text inside a Flow needs an explicit width to wrap and
// CONTRIBUTING is explicit that wrapMode does not constrain one. Spacing rides
// on each run rather than on Flow.spacing, or "[SIR]," renders as "SIR ,".

const runText = (v, sp) => ({ t: "s", v: v, sp: sp })
const runRoute = (v, sp) => ({ t: "r", v: v, sp: sp })

test("alertRuns splits a line into words, marking which ones follow a space", () => {
  assert.deepEqual(Model.alertRuns("No trains"), [
    [runText("No", false), runText("trains", true)]
  ])
})

test("alertRuns turns a bracketed route id into a route run", () => {
  assert.deepEqual(Model.alertRuns("No [6] between"), [
    [runText("No", false), runRoute("6", true), runText("between", true)]
  ])
})

test("alertRuns keeps trailing punctuation against its bullet", () => {
  // The defect the spike had: with uniform Flow spacing this renders as
  // "SIR , see below", and the spike's tokenizer dropped the comma entirely.
  assert.deepEqual(Model.alertRuns("the [SIR], see"), [
    [runText("the", false), runRoute("SIR", true),
     runText(",", false), runText("see", true)]
  ])
})

test("alertRuns splits leading punctuation off a route id too", () => {
  assert.deepEqual(Model.alertRuns("take ([6])"), [
    [runText("take", false), runText("(", true),
     runRoute("6", false), runText(")", false)]
  ])
})

test("alertRuns carries the feed's id, express marker and all", () => {
  // RouteBullet normalizes for the label and decides disc versus diamond,
  // exactly as it does at the row head. Stripping the X here would throw away
  // the one thing the circled glyphs could never express.
  assert.deepEqual(Model.alertRuns("[6X] and [SIR]"), [
    [runRoute("6X", false), runText("and", true), runRoute("SIR", true)]
  ])
})

test("alertRuns does not mistake ordinary bracketed words for routes", () => {
  ;["[icon]", "[6789]", "[]", "[a]", "[6 ]"].forEach(function (word) {
    const runs = Model.alertRuns("x " + word)
    assert.equal(runs[0][1].t, "s", word + " must stay text")
    assert.equal(runs[0][1].v, word)
  })
})

test("alertRuns gives a blank line an empty array, so it can be a spacer", () => {
  // An empty Flow collapses to zero height, which is how the spike lost the
  // paragraph break. The line has to survive as something the panel can size.
  assert.deepEqual(Model.alertRuns("a\n\nb"), [
    [runText("a", false)],
    [],
    [runText("b", false)]
  ])
})

test("alertRuns collapses a run of spaces into one gap, not empty runs", () => {
  assert.deepEqual(Model.alertRuns("a   b"), [
    [runText("a", false), runText("b", true)]
  ])
})

test("alertRuns substitutes icons before tokenizing, so a glyph rides in a word", () => {
  const out = Model.alertRuns("[shuttle bus icon] Free")
  assert.equal(out[0][0].t, "s")
  assert.equal(out[0][0].v.codePointAt(0), 0xF207, "the glyph, not the placeholder")
})

test("alertRuns returns nothing for an absent or non-string input", () => {
  assert.deepEqual(Model.alertRuns(""), [])
  assert.deepEqual(Model.alertRuns(undefined), [])
  assert.deepEqual(Model.alertRuns(null), [])
  assert.deepEqual(Model.alertRuns(42), [])
})

test("alertRuns round-trips every alert in the fixture without losing a character", () => {
  // THE test. The spike's tokenizer silently ate a comma, and nothing it
  // rendered looked wrong enough to notice. Reassembling the runs must
  // reproduce the icon-substituted input exactly.
  const bytes = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "fixtures", "alerts.pb"))
  const feed = Gtfs.decodeAlerts(new Uint8Array(bytes))
  let checked = 0
  for (const a of feed.alerts) {
    for (const s of [a.headerText, a.descriptionText]) {
      if (!s) continue
      const rebuilt = Model.alertRuns(s).map(
        (line) => line.map((r) => (r.sp ? " " : "") + (r.t === "r" ? "[" + r.v + "]" : r.v)).join("")
      ).join("\n")
      // Space runs collapse, so compare against the input with its own runs of
      // spaces collapsed. Nothing else may differ.
      const expected = Model.alertTextWithIcons(s).split("\n")
        .map((line) => line.split(/ +/).filter((w, i) => w !== "" || i === 0).join(" ").replace(/^ +| +$/g, ""))
        .join("\n")
      assert.equal(rebuilt, expected, "lost text in: " + JSON.stringify(s.slice(0, 80)))
      checked++
    }
  }
  assert.ok(checked > 380, "should have checked both strings of all 195 alerts, got " + checked)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./bin/test 2>&1 | grep -cE "^✖"`
Expected: failures reported as `TypeError: Model.alertRuns is not a function` — not as assertion mismatches.

- [ ] **Step 3: Write the implementation**

In `Model.js`, immediately above `function alertsForDisplay(`:

```js
// One alert string as lines of word-level runs, for a Flow to lay out.
//
// Word-level because a Text inside a Flow needs an explicit width to wrap, and
// wrapMode does not constrain one -- so the Flow has to do the wrapping and
// needs items to wrap. The 2000-character cap bounds this at roughly 330 runs.
//
// `sp` rides on the run rather than coming from Flow.spacing, which is uniform:
// with uniform spacing "[SIR]," renders as "SIR , see below". Punctuation is
// split off the id and marked sp:false so it hugs the bullet.
//
// A route run carries the FEED's id -- "6X", not "6". RouteBullet normalizes
// for the label and picks disc or diamond, exactly as it does at the row head.
var ROUTE_TRAIL = ",.:;)?!"
// NOT "[". Stripping the opening bracket as leading punctuation would leave
// "6]", which is not a bracketed id, and every route in the feed would come
// back out as plain text having looked like it worked.
var ROUTE_LEAD = "(\"'"

// "[6]" -> "6", "[SIR]" -> "SIR", anything else -> "". One to three characters
// of A-Z or 0-9 between brackets, and nothing else.
function bracketedRouteId(word) {
  if (word.length < 3 || word.charAt(0) !== "[") return ""
  if (word.charAt(word.length - 1) !== "]") return ""
  var id = word.substring(1, word.length - 1)
  if (id.length < 1 || id.length > 3) return ""
  for (var i = 0; i < id.length; i++) {
    var c = id.charAt(i)
    if (!((c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) return ""
  }
  return id
}

// Splits one space-delimited word into runs. `sp` applies to the first of them;
// everything after it hugs what precedes it.
function wordRuns(word, sp, out) {
  var lead = ""
  while (word.length > 0 && ROUTE_LEAD.indexOf(word.charAt(0)) >= 0) {
    lead = lead + word.charAt(0)
    word = word.substring(1)
  }
  var trail = ""
  while (word.length > 0 && ROUTE_TRAIL.indexOf(word.charAt(word.length - 1)) >= 0) {
    trail = word.charAt(word.length - 1) + trail
    word = word.substring(0, word.length - 1)
  }
  var id = bracketedRouteId(word)
  if (id === "") {
    // Not a route after all, so the punctuation was never punctuation --
    // put the word back together and emit it whole.
    out.push({ t: "s", v: lead + word + trail, sp: sp })
    return
  }
  if (lead !== "") out.push({ t: "s", v: lead, sp: sp })
  out.push({ t: "r", v: id, sp: lead === "" ? sp : false })
  if (trail !== "") out.push({ t: "s", v: trail, sp: false })
}

function alertRuns(text) {
  if (!text || typeof text !== "string") return []
  var lines = alertTextWithIcons(text).split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var words = lines[i].split(" ")
    var runs = []
    for (var j = 0; j < words.length; j++) {
      if (words[j] === "") continue
      wordRuns(words[j], runs.length > 0, runs)
    }
    out.push(runs)
  }
  return out
}
```

Add to the export block, after `alertDisplayText: alertDisplayText`:

```js
,
    alertRuns: alertRuns
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`.

- [ ] **Step 5: Verify it runs under Qt's V4 engine**

node accepts syntax V4 rejects. Write `/tmp/v4runs.qml` in the repo root as `.v4runs.qml`:

```qml
import QtQuick
import "Model.js" as Model

QtObject {
  Component.onCompleted: {
    var fail = 0
    var r = Model.alertRuns("No [6] between")
    if (r.length !== 1) fail++
    if (r[0].length !== 3) fail++
    if (r[0][1].t !== "r" || r[0][1].v !== "6" || r[0][1].sp !== true) fail++
    var p = Model.alertRuns("the [SIR], see")
    if (p[0][2].v !== "," || p[0][2].sp !== false) fail++
    if (Model.alertRuns("a\n\nb").length !== 3) fail++
    if (Model.alertRuns("a\n\nb")[1].length !== 0) fail++
    if (Model.alertRuns(undefined).length !== 0) fail++
    Qt.exit(fail === 0 ? 42 : 1)
  }
}
```

Run, then confirm the probe can fail, then delete it:

```bash
QT_QPA_PLATFORM=offscreen qml6 .v4runs.qml; echo "exit=$? (42 = passed)"
sed 's/r\[0\]\.length !== 3/r[0].length !== 99/' .v4runs.qml > .v4runs-neg.qml
QT_QPA_PLATFORM=offscreen qml6 .v4runs-neg.qml; echo "negative control exit=$? (1 = can fail)"
rm -f .v4runs.qml .v4runs-neg.qml
```

Expected: `exit=42`, then `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat: turn alert text into runs a Flow can lay out

Word-level runs, because a Text inside a Flow needs an explicit width
to wrap and wrapMode does not constrain one -- the Flow has to do the
wrapping, which means it needs items to wrap.

Spacing rides on each run rather than on Flow.spacing. Uniform spacing
renders \"[SIR],\" as \"SIR , see below\", and the throwaway spike that
proved this approach dropped the comma outright.

A route run carries the feed's id, express marker and all, so
RouteBullet can pick a diamond -- the one thing the circled glyphs
could never express.

A round-trip test reassembles every run of both strings of all 195
fixture alerts and requires the result to equal the input. That is the
test that would have caught the spike's silent loss.

Refs #6

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Carry runs to the panel

**Files:**
- Modify: `Model.js:313-322` (the `out.push` in `alertsForDisplay`)
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: `Model.alertRuns` from Task 2.
- Produces: each object from `Model.alertsForDisplay(routes, alerts, nowSec)` gains `headerRuns` and `descriptionRuns`, both the shape `alertRuns` returns. `headerText` and `descriptionText` are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/model.test.js`:

```js
test("alertsForDisplay carries runs beside the strings, changing neither", () => {
  // Purely additive. Three variants of one string in circulation is how a
  // reader ends up unable to say which one a surface shows -- and if the Flow
  // rendering is ever reverted, the delegate falls back to a Text on a string
  // that still reads correctly.
  const alerts = [{ id: "a", alertType: "Delays", routes: ["6"], periods: [],
    headerText: "No [6] between Hunts Point Av",
    descriptionText: "[shuttle bus icon] Free T102 buses" }]
  const out = Model.alertsForDisplay(["6"], alerts, NOW)[0]

  assert.equal(out.headerText, "No " + CIRCLED_6 + " between Hunts Point Av",
    "the string keeps its circled glyph, exactly as it ships")
  assert.equal(out.headerRuns[0][1].t, "r")
  assert.equal(out.headerRuns[0][1].v, "6")
  assert.equal(out.descriptionRuns[0][0].v.codePointAt(0), 0xF207)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./bin/test 2>&1 | grep -A4 "carries runs beside"`
Expected: FAIL reading a property of `undefined` — `headerRuns` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `Model.js`, inside `alertsForDisplay`'s `out.push({ ... })`, after the `descriptionText:` line:

```js
      // ADDITIVE. The strings above are untouched and still fully
      // substituted; these are what Panel.qml lays out as a Flow. Keeping
      // both means the runs can be reverted without anything downstream
      // changing with them.
      headerRuns: alertRuns(a.headerText),
      descriptionRuns: alertRuns(a.descriptionText),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat: hand the panel runs as well as strings

Additive: headerText and descriptionText keep going through
alertDisplayText exactly as they ship, and headerRuns and
descriptionRuns arrive beside them.

Three variants of one string in circulation is how a reader ends up
unable to say which one a surface shows. This way the runs can be
reverted and the delegate falls back to a Text on a string that still
reads correctly.

Refs #6

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Render the runs

The only task with no unit test available: `Panel.qml` is verifiable in the live shell alone.

**Files:**
- Modify: `Panel.qml:323-405` (the alert delegate)

**Interfaces:**
- Consumes: `modelData.headerRuns` and `modelData.descriptionRuns` from Task 3; `Model.bulletLabelSize` indirectly, through `RouteBullet` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the run components to the delegate**

Inside `delegate: ColumnLayout { ... }`, after the `expanded` property, add
the two colour properties first — both run components below read them, so they
have to exist before the components are written:

```qml
          // Lifted off the headline Text, which is about to stop existing.
          // Both run components read these, so they belong on the delegate.
          readonly property color runColor:
            alertRow.cls === "red" ? Model.COLOR_ERROR
          : alertRow.cls === "amber" ? Model.COLOR_WARN
          : root.barForeground
          readonly property real runOpacity:
            alertRow.cls === "info" || alertRow.cls === "planned" ? 0.6 : 1.0

          // Measured, not guessed in pixels: the gap between words has to be
          // the font's own space at this size, or the prose reads as either
          // justified or cramped depending on the theme's font.
          TextMetrics {
            id: spaceMetrics
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            text: " "
          }
```

Add these components as siblings of the delegate's children, at the end of the `ColumnLayout`:

```qml
          Component {
            id: runWordComp
            Text {
              property var run: null
              // Set per call site: the headline tints by severity, the
              // description does not. OPACITY is deliberately absent -- it
              // belongs to the container, so it is applied exactly once. Put
              // it here as well and a planned alert's description compounds
              // 0.6 with the Column's 0.75 down to 0.45, which is dimmer than
              // anything that ships today.
              property color tint: root.barForeground
              text: run ? run.v : ""
              leftPadding: (run && run.sp) ? spaceMetrics.width : 0
              // PlainText for the reason the whole string was: the feed ships
              // an en-html translation of everything it sends.
              textFormat: Text.PlainText
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              color: tint
            }
          }

          Component {
            id: runBulletComp
            Item {
              property var run: null
              // One line tall, so a bullet centres against the words instead
              // of setting the line's height and spreading the paragraph.
              implicitWidth: (run && run.sp ? spaceMetrics.width : 0)
                           + Style.font.caption * 1.4
              implicitHeight: spaceMetrics.height
              RouteBullet {
                anchors.verticalCenter: parent.verticalCenter
                anchors.right: parent.right
                routeId: parent.run ? parent.run.v : ""
                fontFamily: root.fontFamily
                diameter: Style.font.caption * 1.4
                // NOT interactive: its MouseArea would eat the tap that
                // expands the row.
                interactive: false
              }
            }
          }
```

- [ ] **Step 2: Replace the headline Text with a Flow**

Inside `RowLayout { id: alertHeadline ... }`, replace the headline `Text { ... }` block with:

```qml
            Flow {
              Layout.fillWidth: true
              // Zero, because every run carries its own leading gap. Uniform
              // spacing here is what detaches punctuation from its bullet.
              spacing: 0
              // Applied ONCE, on the container, exactly as the headline Text
              // it replaces applied it to itself.
              opacity: alertRow.runOpacity
              Repeater {
                model: alertRow.modelData.headerRuns.length > 0
                     ? alertRow.modelData.headerRuns[0] : []
                delegate: Loader {
                  required property var modelData
                  sourceComponent: modelData.t === "r" ? runBulletComp : runWordComp
                  onLoaded: {
                    item.run = modelData
                    if (modelData.t !== "r") item.tint = alertRow.runColor
                  }
                }
              }
            }
```

The `color` and `opacity` that were on this `Text` now live on the delegate as
`runColor` and `runOpacity`, added in Step 1.

- [ ] **Step 3: Replace the description Text with a loaded Column of Flows**

Replace the description `Text { visible: alertRow.expanded ... }` block with:

```qml
          Loader {
            // active, not visible: a 2000-character alert is roughly 330 runs,
            // and they should exist while the row is open and not otherwise.
            active: alertRow.expanded
            visible: active
            Layout.fillWidth: true
            Layout.leftMargin: alertRow.modelData.matchedRoute !== ""
                             ? Style.font.caption * 1.4 + Style.space(4)
                             : 0
            sourceComponent: Column {
              spacing: 0
              // The body stays lighter than the headline, as it ships today.
              opacity: 0.75
              Repeater {
                model: alertRow.modelData.descriptionRuns
                delegate: Flow {
                  required property var modelData
                  width: parent.width
                  spacing: 0
                  // A blank line survives as a line-height spacer. An empty
                  // Flow collapses to nothing, which loses the paragraph break.
                  height: modelData.length === 0 ? spaceMetrics.height : implicitHeight
                  Repeater {
                    model: modelData
                    delegate: Loader {
                      required property var modelData
                      sourceComponent: modelData.t === "r" ? runBulletComp : runWordComp
                      // No tint: the description's words keep the component's
                      // default, root.barForeground, which is what the
                      // description Text uses today. Severity colours the
                      // headline only.
                      onLoaded: item.run = modelData
                    }
                  }
                }
              }
            }
          }
```

Opacity is applied **once per container** and never on a run: the headline
`Flow` carries `alertRow.runOpacity`, the description `Column` carries `0.75`.
Today's headline `Text` and description `Text` are siblings, so nothing
compounds between them — putting opacity on the runs as well would dim a
planned alert's description to `0.6 * 0.75 = 0.45`, darker than anything that
ships.

- [ ] **Step 4: Verify it parses**

```bash
python3 -c "
import re,sys
s=open(sys.argv[1]).read()
t=re.sub(r'//[^\n]*','',s); t=re.sub(r'\"(\\\\.|[^\"\\\\])*\"','\"\"',t)
print('brace balance:', t.count('{')-t.count('}'))" Panel.qml
./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `brace balance: 0`, `fail 0` (no test covers `Panel.qml`; this confirms nothing else broke).

- [ ] **Step 5: Deploy and read the journal**

```bash
./bin/dev up
journalctl --user _PID=$(pgrep -x quickshell | head -1) --since "1 min ago" --no-pager \
  | grep -iE "ReferenceError|TypeError|Error:" | head
```

Expected: no output. A `ReferenceError` in a QML binding appears here and nowhere else — `qmllint` cannot see one.

- [ ] **Step 6: Look at it, and check the three risks the spec names**

Open the panel and confirm, in order:

1. Route ids in the headline and the expanded description draw as coloured bullets.
2. **Tapping the headline still expands and collapses the row** — the handler now sits over a `Flow` of items rather than one `Text`. If it does not, move the `TapHandler` from `alertHeadline` to the delegate root.
3. Punctuation hugs its bullet: find an alert reading `[SIR],` or `[6].` and confirm there is no gap before the comma.
4. The paragraph break before "Note:" is still there.
5. A hyphenated station name wraps rather than overflowing the panel.

If no live alert carries a route id, print what the panel should draw:

```bash
node -e '
const { execFileSync } = require("node:child_process")
const Gtfs = require("./Gtfs.js"), Model = require("./Model.js")
const buf = execFileSync("curl", ["-sS","--fail","--proto","=https","--max-time","20","--max-filesize","4194304", Gtfs.ALERTS_URL], { maxBuffer: 1<<26 })
const feed = Gtfs.decodeAlerts(new Uint8Array(buf))
const routes = [...new Set(feed.alerts.flatMap((a) => a.routes.map(Gtfs.normalizeRoute)))]
for (const r of Model.alertsForDisplay(routes, feed.alerts, Math.floor(Date.now()/1000)).slice(0, 3)) {
  console.log(r.matchedRoute, "|", r.headerText.slice(0, 70))
  console.log("   bullets in headline:", r.headerRuns[0].filter((x) => x.t === "r").map((x) => x.v).join(" ") || "(none)")
}'
```

- [ ] **Step 7: Commit**

```bash
git add Panel.qml
git commit -m "feat: draw alert route ids as real bullets, inline

The headline and the expanded description become a Flow of runs rather
than one Text, so a route id inside alert prose draws the same
RouteBullet the row head does -- colour, and a diamond for an express.

Flow.spacing is 0 and every run carries its own leading gap, which is
what keeps punctuation against its bullet.

A blank line renders as a line-height spacer rather than an empty Flow,
which collapses to nothing.

The description's runs sit behind a Loader whose active follows the
row's expansion: a 2000-character alert is roughly 330 items and they
should not exist while the row is closed.

Verified in the live shell, which is the only thing that can verify it:
[record what you saw -- bullets drawn, tap still expands, punctuation
tight, paragraph break intact, wrapping sane].

Refs #6

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Record the decision and close the loop on #6

**Files:**
- Modify: `CONTRIBUTING.md` (the `Model.js` layer-map row)
- Modify: `docs/superpowers/specs/2026-09-21-inline-route-bullets-design.md` (status line)

- [ ] **Step 1: Update the layer map**

`Model.js`'s row currently reads "Arrival assembly, alert classification, bar state, all display formatting". Extend it to name the runs, since a new interface crossing to the QML is exactly what that table is for:

```
| `Model.js` | Arrival assembly, alert classification, bar state, all display formatting, and alert text as layout runs (`alertRuns`) | same |
```

- [ ] **Step 2: Mark the spec implemented**

Change the spec's `**Status:**` line from `Awaiting review` to `Implemented at <commit>` with the Task 4 commit's short hash.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md docs/superpowers/specs/2026-09-21-inline-route-bullets-design.md
git commit -m "docs: record alertRuns in the layer map

A new interface crossing Model.js to Panel.qml is exactly what that
table exists to name.

Refs #6

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Report what is left**

The release is still held. Report to the user:

- what the live shell showed for each of Task 4 Step 6's five checks,
- that `master` is untouched and both branches unpushed,
- that the remaining open question on #6 is now only whether `[SIR]`-style ids should ever have been bullets rather than text, since everything else in that thread is implemented.
