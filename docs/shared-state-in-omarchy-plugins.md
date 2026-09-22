# Shared state across bar surfaces, in an Omarchy shell plugin

Portable notes. Written while fixing this in `headway` (issue #3, 2026-09-22),
and applicable unchanged to `galley`, `colophon`, `tonearm` or any other plugin
that puts a `Service`, a `Timer` or a `Process` inside its bar widget.

## The problem

**The bar instantiates a widget once per bar surface, and a bar surface exists
per monitor.** Anything instantiated *inside* that widget therefore exists once
per monitor: timers, `Process` blocks, file readers, notification senders.

On a two-monitor setup every one of them runs twice. On three, three times.

This is easy to miss because it is invisible on a single-monitor machine, which
is where plugins get developed. It has nothing to do with Quickshell's
`reloadableId` or with the `.pragma library` trap — it is one level up, at the
widget itself.

## What duplicates, in rough order of how much it matters

| What | Effect at N monitors | How bad |
|---|---|---|
| **`notify-send`** | The same desktop notification fires N times | A visible bug. Users report this. |
| **A long-running subscription** (`foo subscribe`, a websocket, a tail) | N persistent subscribers to one daemon | Depends entirely on the daemon. May duplicate events, may hit a connection limit. |
| **Writes to a state or settings file** | N writers, unordered | Atomic writes do not save you: each write lands whole, but the *last* one wins and instances may hold different in-memory state. |
| **A network poll** | N× the requests against someone else's API | Wasteful, and rude if the endpoint is not yours. |
| **A local poll** (CUPS, a socket, `/proc`) | N× the work | Usually just waste. |

Note the ordering. A duplicated *poll* is what you notice first and it is the
least harmful item on the list.

## Do you have it? A five-minute check

From the plugin's source directory:

```bash
# Does anything stateful live inside the widget rather than beside it?
grep -rn "Timer {\|Process {\|FileView {" *.qml

# Does it notify?
grep -rn "notify-send" *.qml *.js

# Does it already share state properly?
cat qmldir 2>/dev/null || echo "no qmldir — nothing is shared"
```

If there is no `qmldir` declaring a `singleton`, and the greps find anything,
you have it.

## The fix: a singleton

`pragma Singleton` plus a `qmldir`. This is the shell's own pattern —
`Commons/qmldir` declares `Style`, `Color`, `Util` and `Border` — and several
third-party plugins already ship one:

```
io.github.weedwhitesandwine.omafetti  singleton OmafettiState
jankeesvw.time-machine                singleton TimeMachineStore
io.github.fluffet.display             singleton DisplayStore
lucas.system-pulse                    singleton Metrics
```

**Read `lucas.system-pulse` before writing your own.** It is the complete shape:
a singleton owning the subprocess and the sample, a widget that consumes it, and
a consumer count that starts and stops the work.

### The shape

`qmldir`, at the plugin root:

```
singleton MyService 1.0 MyService.qml
```

`MyService.qml`:

```qml
pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io

QtObject {
  id: root

  // Shared: the thing every surface should agree about.
  property var sample: ({})
  property string error: ""

  // How many widgets are alive. The work runs only while this is above zero,
  // or a removed widget leaves a timer polling for the life of the shell.
  property int consumers: 0
  readonly property bool shouldRun: consumers > 0

  // A singleton cannot take bound properties from a caller, so configuration
  // arrives as a call instead.
  function attach(options) {
    if (options && options.settings) root.settings = options.settings
    consumers++
  }
  // Clamped: see "refcount drift" below.
  function detach() { consumers = Math.max(0, consumers - 1) }

  property Timer poll: Timer {
    running: root.shouldRun
    interval: 30000
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
}
```

The widget:

```qml
import "."          // resolves the qmldir beside this file

Panel {
  Component.onCompleted: MyService.attach({ settings: root.settings })
  Component.onDestruction: MyService.detach()

  Text { text: MyService.sample.whatever }
}
```

### What must stay per-instance

Not everything belongs in the singleton. **UI state belongs to the surface it
happened on.** A search box's half-typed text, which row is expanded, which tab
is selected — if you move those into the singleton, typing on one monitor
changes the other monitor's panel while someone is looking at it.

The test: *would two people looking at two monitors expect to see this the
same?* Feed data, yes. Scroll position, no.

## Gotchas

**A QML singleton is not `.pragma library`.** They are opposites and the
confusion is easy. A `.js` file without `.pragma library` gets **one instance
per importing component** — which is why shared tables have to be passed per
call. A QML singleton gets **one instance for the whole engine**. If a project's
contributing notes warn about the first, that warning does not apply here, and
it is worth writing down why so the next reader does not "fix" your singleton.

**Refcount drift across a hot reload.** A dev-mode reload recreates widgets. If
the singleton survives while widgets do not, `attach()` runs again with no
matching `detach()` and `consumers` climbs forever — the widget can be removed
and the work continues. Clamp at zero, and verify the count returns to the
number of live surfaces after a reload rather than assuming it.

**`Component.onDestruction` is not a guarantee.** It is the same class of
problem as a `Process` never emitting `exited()` on a failed spawn. Verify that
removing a surface actually stops the work; do not infer it from the code.

**One shared service means one shared failure.** Before, a wedged instance
affected one monitor. After, it affects all of them. This is the trade you are
making on purpose — make sure the failure paths resolve rather than strand
(a failed spawn should synthesise an exit, a failed read should resolve to
"nothing saved").

## Verifying it without a second monitor

You do not need two monitors, and this is the part that makes the whole thing
testable on a laptop.

**Easiest: run two instances of your own plugin.** Deploy the dev copy
alongside the released one and enable both. They are separate plugin ids, so
the bar creates two widgets — exactly the multi-surface condition, on one
screen. Then watch for the duplication:

```bash
# two widgets, one shell
pgrep -a -P "$(pgrep -x quickshell | head -1)" curl   # or your own subprocess

# and the loudest symptom
journalctl --user -f | grep -i notify
```

Before the fix you will see two of everything. After it, one. Turn the second
copy off with `./bin/dev down` when you are done — leaving both enabled means
two of everything in normal use, which is how this gets noticed by accident.

**The faithful version: a real second surface.**

```bash
hyprctl output create headless    # a second bar surface appears
# ... observe ...
hyprctl output remove HEADLESS-2
```

Check, in order:

1. One subprocess per interval, not two.
2. One notification, not two.
3. Removing one surface leaves the work running; removing all of them stops it.
4. A dev redeploy twice in a row does not leave the count climbing.
5. Per-surface UI state is still per-surface — expand a row on one, confirm the
   other did not expand.

## Status of the sibling plugins, as measured on 2026-09-22

None of these ships a `qmldir`, so all of them have the problem:

| plugin | duplicated per surface | worst symptom |
|---|---|---|
| **galley** | 1 poll timer, 3 `Process` blocks, `notify-send -a Galley` | duplicate printer notifications |
| **colophon** | 3 timers, 3 `Process` blocks, `notify-send -u critical` | duplicate **critical** notifications |
| **tonearm** | 2 timers, 2 `Process` blocks including a long-running `tonearmctl subscribe` | N persistent subscriptions to the daemon |
| **headway** | feed + alerts polls, `notify-send`, the state file reader and writer | duplicate notifications, and unordered writers to one JSON file |

`tonearm` deserves its own look rather than a copy of this recipe: a persistent
subscription duplicated N times is a different question from a poll duplicated N
times, and the right answer depends on how `tonearmctl` fans out events to
multiple subscribers.

`headway`'s README currently excuses the duplicated poll as "the house
behaviour rather than a Headway bug". That was true and is worth retiring rather
than repeating — house behaviour that fires two critical notifications is still
a bug, it is just one that four plugins share.
