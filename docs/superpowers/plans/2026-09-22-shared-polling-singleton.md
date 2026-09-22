# Shared Polling Singleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Service.qml` a QML singleton so the feed polls, the notifications and the state file have exactly one owner regardless of how many bar surfaces exist.

**Architecture:** `Service.qml` gains `pragma Singleton` and a `qmldir` entry. `Panel.qml` stops instantiating it and addresses it by type, passing its settings through `attach()` and releasing it through `detach()`. A consumer count gates the timers so polling stops when the last widget goes; an open-panel count replaces the per-panel `panelOpen` bool.

**Tech Stack:** QML (Qt 6, Quickshell), plain ES3-safe JavaScript modules, `node --test`, the live shell.

**Spec:** `docs/superpowers/specs/2026-09-22-shared-polling-singleton-design.md`

## Global Constraints

- **Task 1 is a gate.** If a plugin `qmldir` does not resolve under this shell's loader, stop and report — the spec is withdrawn in favour of the cache file. Do not attempt Tasks 2-5 on a failed spike.
- **`Service.qml`'s root stays `Item`.** A `QtObject` cannot hold bare `Process`, `Timer` or `Instantiator` children, and converting each to an explicit property assignment is churn this change does not need.
- **No pure module changes.** `Model.js`, `Gtfs.js`, `State.js`, `Stations.js`, `StationData.js` and every test are untouched. `./bin/test` must stay at **240 passing** throughout — that count not moving is the assertion that this changed no logic.
- **`qmllint` is not a gate.** A QML change is verified by the brace-balance check, then the journal, then looking at it.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Branch: `issue-3-shared-polling`, already created and holding the spec.

---

### Task 1: Spike — does a plugin `qmldir` singleton resolve?

The gate. Four installed plugins ship one, but this has not been observed under the loader, and an `Item`-rooted singleton is less common than a `QtObject`-rooted one. Throwaway: everything here is deleted in Step 5.

**Files:**
- Create: `qmldir`, `Probe.qml` (both temporary)
- Modify: `Panel.qml` (one temporary line)

**Interfaces:** none — nothing later depends on this task's code, only on its answer.

- [ ] **Step 1: Write the probe**

`Probe.qml` — an `Item` root, matching what `Service.qml` will be:

```qml
pragma Singleton
import QtQuick

Item {
  id: root
  readonly property string marker: "probe-resolved"
  property int attaches: 0
  function attach() { root.attaches++ }
}
```

`qmldir`:

```
singleton Probe 1.0 Probe.qml
```

- [ ] **Step 2: Reference it from Panel.qml**

Add `import "."` beside the other imports, and inside the root `Panel { }`, a line that cannot silently do nothing:

```qml
  Component.onCompleted: {
    Probe.attach()
    console.warn("headway: probe marker=" + Probe.marker + " attaches=" + Probe.attaches)
  }
```

**If `Panel.qml` already has a `Component.onCompleted`, fold this into it.** Two handlers on one component makes QML reject the duplicate and the component fails to instantiate with nothing in the journal — the trap is in CONTRIBUTING.

- [ ] **Step 3: Deploy and read the journal**

```bash
./bin/dev up
journalctl --user _PID=$(pgrep -x quickshell | head -1) --since "1 min ago" --no-pager \
  | grep -iE "headway|ReferenceError|TypeError|is not available|Probe"
```

**Expected on success:** `headway: probe marker=probe-resolved attaches=1`.

**Expected on failure:** a `ReferenceError: Probe is not defined`, or an import error naming the qmldir. Either means the loader does not put the plugin directory on the import path.

- [ ] **Step 4: Prove the singleton is actually shared**

The marker alone only proves the type resolved. Enable a second instance and confirm both widgets reach the *same* object:

```bash
./bin/dev up            # dev copy, alongside the installed ssandys.headway
journalctl --user _PID=$(pgrep -x quickshell | head -1) --since "1 min ago" --no-pager | grep "probe marker"
```

**Expected:** two log lines, the second reading `attaches=2`. If both read `attaches=1`, the type resolved but each widget got its own instance, and the spec is void for the same reason as a failed import.

Note the installed plugin and the dev copy are separate plugin *ids* with separate directories — if they each get their own singleton, that is the honest answer for two monitors too, since the bar creates a widget per surface from one id. Confirm with `hyprctl output create headless` before concluding either way.

- [ ] **Step 5: Record the answer and delete the probe**

```bash
rm -f Probe.qml
git checkout Panel.qml    # drops the temporary import and handler
# keep qmldir ONLY if Task 2 is going ahead; otherwise rm -f qmldir
```

Report the outcome. On success, continue to Task 2. On failure, **stop**: update the spec's Status to `Withdrawn — the loader does not resolve a plugin qmldir`, commit that, and hand back.

---

### Task 2: `Service.qml` becomes the singleton

**Files:**
- Modify: `Service.qml` (add pragma, `consumers`, `openPanels`, `attach`, `detach`; change one interval binding)
- Create: `qmldir`

**Interfaces:**
- Consumes: nothing from Task 1 but its answer.
- Produces:
  - `Service.attach(options)` — `options.settings` is the plugin settings object. Increments `consumers`. Safe to call repeatedly; the first caller's settings win.
  - `Service.detach(options)` — `options.wasOpen` true if that panel was open. Decrements `consumers`, and `openPanels` when `wasOpen`. Both clamped at zero.
  - `Service.setPanelOpen(wasOpen, isOpen)` — adjusts `openPanels` by the delta, clamped.
  - `Service.consumers`, `Service.openPanels` — `int`, readable for verification.

- [ ] **Step 1: Add the pragma and the qmldir**

At the very top of `Service.qml`, above the imports:

```qml
pragma Singleton
```

`qmldir` at the repo root:

```
singleton Service 1.0 Service.qml
```

- [ ] **Step 2: Add the lifecycle block**

In `Service.qml`, immediately after `property var settings: ({})` and its comment:

```qml
  // HOW MANY WIDGETS ARE ALIVE, not how many monitors exist. The bar makes a
  // widget per bar surface and a surface per monitor, so before this file was a
  // singleton every timer, every Process and every notify-send in it ran once
  // per monitor -- and two instances wrote headway.json with nothing ordering
  // them. Now there is one of each, and this count is what stops the work when
  // the last widget goes.
  //
  // Clamped at zero on the way down. bin/dev reloads the plugin in place, and a
  // reload that recreates widgets without destroying them would otherwise climb
  // this forever and poll for the life of the shell.
  property int consumers: 0
  // Set by the first attach(), so a later surface's identical settings object
  // does not churn a bound property every time a monitor is plugged in.
  property bool settingsAttached: false
  // How many panels are open, not whether THIS one is: with several surfaces,
  // "open" means any of them, and the faster interval applies while any is.
  property int openPanels: 0
  readonly property bool shouldRun: root.consumers > 0

  // A singleton cannot take bound properties from a caller, so configuration
  // arrives as a call. The first caller's settings win: every surface is handed
  // the same settings object by the shell, so a later one has nothing to add.
  function attach(options) {
    if (options && options.settings && !root.settingsAttached) {
      root.settings = options.settings
      root.settingsAttached = true
    }
    root.consumers = root.consumers + 1
  }

  function detach(options) {
    if (options && options.wasOpen) root.setPanelOpen(true, false)
    root.consumers = root.consumers > 0 ? root.consumers - 1 : 0
  }

  // Called by each panel on its own opened/closed transition, as a delta rather
  // than an absolute: an absolute would make the last panel to change state
  // speak for all of them.
  function setPanelOpen(wasOpen, isOpen) {
    if (wasOpen === isOpen) return
    var next = root.openPanels + (isOpen ? 1 : -1)
    root.openPanels = next > 0 ? next : 0
  }

```

- [ ] **Step 3: Delete the old `panelOpen` property and rebind the interval**

Remove `property bool panelOpen: false` (`Service.qml:31`, with its comment).

At `Service.qml:651`, change:

```qml
    interval: (root.panelOpen ? root.openInterval : root.idleInterval) * 1000
```

to:

```qml
    interval: (root.openPanels > 0 ? root.openInterval : root.idleInterval) * 1000
```

- [ ] **Step 4: Gate the three timers on `shouldRun`**

There are exactly three `Timer`s with `running: true`, and three `Process`es with `running: false`. **Only the timers change.** A `Process`'s `running` is driven by `refresh()`, `flushState()` and `refreshAlerts()`; touching it would break the fetch logic.

`Service.qml:46-47`, the one-second countdown clock:

```qml
  Timer {
    interval: 1000; running: root.shouldRun; repeat: true
    onTriggered: root.nowSec = Math.floor(Date.now() / 1000)
  }
```

`Service.qml:649-653`, `pollTimer` — note this line also carries the `openPanels` change from Step 3:

```qml
  Timer {
    id: pollTimer
    interval: (root.openPanels > 0 ? root.openInterval : root.idleInterval) * 1000
    running: root.shouldRun; repeat: true; triggeredOnStart: true
    onTriggered: root.refresh()
  }
```

`Service.qml:661-665`, the alerts timer with its retry-backoff interval:

```qml
  Timer {
    interval: Fetch.retryDelaySec(root.alertsFailures, root.alertsInterval) * 1000
    running: root.shouldRun; repeat: true; triggeredOnStart: true
    onTriggered: root.refreshAlerts()
  }
```

`triggeredOnStart` on the latter two means each fires immediately when `shouldRun` becomes true — so the first widget to attach starts a poll at once, which is the behaviour today when the component completes.

- [ ] **Step 5: Verify it parses and the suite is untouched**

```bash
python3 -c "
import re,sys
s=open(sys.argv[1]).read()
t=re.sub(r'//[^\n]*','',s); t=re.sub(r'\"(\\\\.|[^\"\\\\])*\"','\"\"',t)
print('brace balance:', t.count('{')-t.count('}'))" Service.qml
./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `brace balance: 0`, `tests 240`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add Service.qml qmldir
git commit -m "feat: Service.qml is a singleton, with a consumer count

The bar makes a widget per bar surface and a surface per monitor, so
every timer, every Process and every notify-send in this file ran once
per monitor -- and two instances wrote headway.json with nothing
ordering them.

consumers gates the timers so the work stops when the last widget goes,
clamped at zero because bin/dev reloads the plugin in place and a
climbing count would poll for the life of the shell.

openPanels replaces panelOpen: with several surfaces, open means any of
them, and a bool would let the last panel to change state speak for all
of them.

The root stays an Item. QtObject cannot hold bare Process, Timer or
Instantiator children, and converting each to a property assignment is
churn this change does not need.

Refs #3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `Panel.qml` consumes the singleton

**Files:**
- Modify: `Panel.qml` (imports, the `Service { }` block, 26 `service.` references, the lifecycle handlers)

**Interfaces:**
- Consumes: `Service.attach`, `Service.detach`, `Service.setPanelOpen` from Task 2.
- Produces: nothing later depends on this.

- [ ] **Step 1: Import the directory and drop the instance**

Add beside the existing imports:

```qml
import "."
```

Delete the whole block at `Panel.qml:59-63`:

```qml
  Service {
    id: service
    settings: root.settings
    panelOpen: root.opened
  }
```

- [ ] **Step 2: Rename the references**

`service.` becomes `Service.` — the singleton is addressed by type name, capitalised:

```bash
sed -i 's/\bservice\./Service./g' Panel.qml
grep -c "Service\." Panel.qml      # expect 26
grep -c "\bservice\." Panel.qml    # expect 0
```

Reading `Service.` rather than a lowercase alias is deliberate: an alias would keep the diff smaller and hide that this is process-wide shared state, which is the one thing a reader of this file most needs to know.

- [ ] **Step 3: Attach, detach, and report panel state**

Add to the root `Panel { }`. **If a `Component.onCompleted` already exists, fold this into it** — QML rejects a duplicate handler and the component fails to instantiate with nothing logged.

```qml
  // The service is shared by every bar surface, so this widget does not own it
  // -- it registers interest and releases it. wasOpen is passed on the way out
  // because a surface destroyed while its panel is open would otherwise leave
  // openPanels counting a panel that no longer exists.
  Component.onCompleted: Service.attach({ settings: root.settings })
  Component.onDestruction: Service.detach({ wasOpen: root.opened })
  onOpenedChanged: Service.setPanelOpen(!root.opened, root.opened)
```

- [ ] **Step 4: Verify it parses and the suite is untouched**

```bash
python3 -c "
import re,sys
s=open(sys.argv[1]).read()
t=re.sub(r'//[^\n]*','',s); t=re.sub(r'\"(\\\\.|[^\"\\\\])*\"','\"\"',t)
print('brace balance:', t.count('{')-t.count('}'))" Panel.qml
./bin/test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `brace balance: 0`, `tests 240`, `fail 0`.

- [ ] **Step 5: Deploy and read the journal before looking at anything**

```bash
./bin/dev up
journalctl --user _PID=$(pgrep -x quickshell | head -1) --since "1 min ago" --no-pager \
  | grep -iE "ReferenceError|TypeError|Unable to assign|headway"
```

Expected: nothing. A missing property or a wrong type surfaces here and nowhere else.

- [ ] **Step 6: Confirm the widget still works at all**

Open the panel. Arrivals listed, the station search filters, a station can be activated, an alert row expands. This is the smoke test before measuring anything.

- [ ] **Step 7: Commit**

```bash
git add Panel.qml
git commit -m "feat: the panel registers interest in the service rather than owning it

Service is addressed by type, not instantiated: one object for every
bar surface. attach() hands it the settings a singleton cannot receive
as a bound property, detach() releases it, and the opened transition is
reported as a delta so no single panel speaks for the rest.

detach carries wasOpen because a surface destroyed while its panel is
open would otherwise leave openPanels counting a panel that is gone.

References read Service. rather than a lowercase alias on purpose: an
alias would keep the diff smaller and hide that this is process-wide
shared state, which is what a reader of this file most needs to know.

Refs #3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Measure that all three duplications are gone

No code. This is the task the whole change exists for, and it is the one that cannot be inferred from a green suite.

**Files:** none.

- [ ] **Step 1: Create the two-surface condition**

The dev copy alongside the installed plugin gives two widgets on one screen:

```bash
./bin/dev up          # ssandys.headway-dev, beside the installed ssandys.headway
omarchy-shell shell listPlugins    # confirm both are enabled
```

**Both copies must be built from this branch** for the comparison to mean anything — reinstall or rebuild the non-dev copy from the same tree first, otherwise you are measuring old code against new.

- [ ] **Step 2: Count the fetches**

Over one poll interval:

```bash
QS=$(pgrep -x quickshell | head -1)
end=$((SECONDS+180))
while [ $SECONDS -lt $end ]; do
  out=$(pgrep -a -P $QS curl 2>/dev/null | grep "api-endpoint.mta.info")
  [ -n "$out" ] && { echo "$out"; }
  sleep 0.2
done
```

Expected: **one** MTA fetch per feed per interval, not two. Sampling at 0.2s can miss a short-lived curl, so a single observation of one fetch is not proof — watch for at least two intervals, and treat "never saw two at once" plus "saw one repeatedly" as the result.

- [ ] **Step 3: Count the notifications**

```bash
journalctl --user -f | grep -i "notify\|headway"
```

Wait for a new alert, or force the stale path by disconnecting the network for longer than the stale threshold. Expected: **one** notification, not two.

- [ ] **Step 4: Check the refcount does not drift**

```bash
./bin/dev up && ./bin/dev up && ./bin/dev up
```

Then confirm the poll interval has not accelerated and the widget still stops polling when disabled:

```bash
./bin/dev down
# over the next interval, no MTA fetch from the shell at all if the installed
# copy is also disabled; with the installed copy enabled, exactly one.
```

A climbing `consumers` shows as polling that continues after every widget is gone. That is the failure this step exists to catch.

- [ ] **Step 5: Confirm per-surface state stayed per-surface**

With both widgets enabled, open both panels. Expand an alert row in one. **The other must not expand.** Type in one station search; the other's must stay empty.

If either leaks, `expandedAlertId` or `query` has been moved into the singleton by mistake.

- [ ] **Step 6: Record the results in the spec**

Change the spec's `**Status:**` to `Implemented at <commit>` and add a short "Measured" section with what each of Steps 2-5 actually showed. Do not write the expected numbers — write the observed ones.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-22-shared-polling-singleton-design.md
git commit -m "docs: record what the two-surface measurement showed

Refs #3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Retire the claim the README makes

**Files:**
- Modify: `README.md` (Known limitations)
- Modify: `CONTRIBUTING.md` (the `Service.qml` layer-map row)

- [ ] **Step 1: Rewrite the README entry**

`README.md:240-246` currently opens "**One poll per monitor.**" and excuses it as house behaviour. Replace the whole bullet with:

```markdown
- **One poll for every monitor.** The Omarchy bar instantiates a widget once per
  bar surface, and a surface exists per monitor — so a widget that polls from
  inside itself polls once per monitor, notifies once per monitor, and writes
  its state file once per monitor with nothing ordering the writes. `Service.qml`
  is a QML singleton for that reason: one poll, one notification and one writer
  however many screens you have. `docs/shared-state-in-omarchy-plugins.md` has
  the portable version, since galley, colophon and tonearm all still have it.
```

- [ ] **Step 2: Update the layer map**

The `Service.qml` row reads "I/O only: `curl` polling, shell-mediated state file, `notify-send`". Make the sharing part of its stated job:

```
| `Service.qml` | I/O only, and shared by every bar surface as a singleton: `curl` polling, shell-mediated state file, `notify-send` | **The live shell only** |
```

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: the poll is no longer one per monitor

The Known limitations entry excused this as house behaviour, which was
true of the polling and never true of the duplicate notifications or
the unordered writers to headway.json.

Refs #3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Report**

State plainly:

- what Task 1 found, since everything rests on it,
- the observed numbers from Task 4 Steps 2-5, not the expected ones,
- that `master` is untouched and the branch unpushed,
- that galley, colophon and tonearm still have this, with the portable note as the starting point.
