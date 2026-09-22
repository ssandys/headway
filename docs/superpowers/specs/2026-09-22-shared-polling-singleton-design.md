# One polling service across every bar surface — Design

**Date:** 2026-09-22
**Status:** Implemented at `c588ab0`; partially measured — see Measured
**Issue:** [#3](https://github.com/ssandys/headway/issues/3)

The bar instantiates a widget once per bar surface, and a surface exists per
monitor. `Panel.qml` instantiates `Service { }`, so **everything in
`Service.qml` runs once per monitor**. This makes it run once, shared.

## What actually duplicates

The README documents one of these. There are three.

| Duplicated | On two monitors | Severity |
|---|---|---|
| The feed poll and the alerts poll | Every feed fetched twice per interval, against the MTA | Waste, and the thing the issue was filed about |
| `notify-send` on a new alert, and on stale/unreachable data | **Every notification fires twice** | A visible bug |
| The `headway.json` reader and writer | Two readers at startup, two writers on every change | Latent. `State.writeArgs` makes each write atomic, but nothing orders two of them, so last-writer-wins between instances that may hold different in-memory lists |

Only the first is in `README.md` under Known limitations, where it is excused as
"the house behaviour rather than a Headway bug". That is true of the polling and
was verified against galley and colophon — but duplicate notifications and
racing writers are not house style, they are consequences nobody looked for.

## Why not the shared cache file the issue proposes

The issue predates knowing that the shell supports plugin singletons.

| | Cache file | Singleton |
|---|---|---|
| Fixes the duplicate poll | yes | yes |
| Fixes duplicate notifications | no | yes |
| Fixes racing state writes | no | yes |
| New on-disk format to version | yes | none |
| New adversarial file surface | yes — another predictable path, even reusing `State.js` | none |
| Needs a "serve stale when offline" rule | yes, and it interacts with `feedTimestamp` and the stale-data notification | the question does not arise |
| Needs a per-feed vs per-poll decision | yes | the question does not arise |

Both of the issue's own open questions exist only because of the cache. They
disappear with the mechanism rather than being answered.

## The mechanism, and its precedent

`pragma Singleton` plus a `qmldir`, imported by `Panel.qml` as `import "."`.

This is the shell's own pattern — `Commons/qmldir` declares `Style`, `Color`,
`Util` and `Border` as singletons — and four plugins installed on this machine
already use it for exactly this purpose:

```
io.github.weedwhitesandwine.omafetti  singleton OmafettiState
jankeesvw.time-machine                singleton TimeMachineStore
io.github.fluffet.display             singleton DisplayStore
lucas.system-pulse                    singleton Metrics
```

`lucas.system-pulse` is the closest shape and worth reading before implementing:
a `Metrics` singleton owning the subprocess and the sample, a `Widget` that
consumes it, a `consumers` count with `attach(options)` / `detach()`, and
`readonly property bool shouldRun: consumers > 0 && sessionEnabled` gating the
poll. Its collector runs as one process regardless of how many widgets exist.

**This does not contradict the `.pragma library` trap in CONTRIBUTING.** That
trap is about `.js` files, which genuinely get one instance per importing
component — it is why `Stations.js` takes its table per call. A QML singleton is
the opposite: one instance for the whole engine. The two facts live side by side
and the distinction is the point.

## What moves

`Service.qml` becomes the singleton whole. Nothing in it is per-panel: the
station list, arrivals, alerts, feed timestamps, error state, notification
diffing and the state file are all shared by definition, and the only per-panel
input it takes is `panelOpen`.

| Today | After |
|---|---|
| `Panel.qml` holds `Service { id: service; settings: root.settings; panelOpen: root.opened }` | `Panel.qml` has `import "."` and no `Service` block; its 26 `service.` references address the singleton |
| `settings` is a bound property | passed once through `attach({ settings })` on `Component.onCompleted` |
| `panelOpen` is a bool from one panel | `openPanels` is a count; the active interval applies while it is above zero |
| nothing tracks instances | `consumers`, incremented by `attach()` and decremented by `detach()` on destruction; timers run only while it is above zero |

**What stays in `Panel.qml`** is the genuinely per-surface UI state: `query` and
`expandedAlertId`. A row expanded on one monitor must not expand on the other,
and a half-typed station search belongs to the panel it was typed into.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Mechanism | `pragma Singleton` | Fixes three duplications rather than one, adds no on-disk format, and is the pattern the shell and four installed plugins already use. |
| Which file | `Service.qml` itself | Nothing in it is per-panel. Splitting a shared store out of it would leave the remainder empty. |
| Configuration | `attach(options)` / `detach()` | A singleton cannot take bound properties from a caller. This is how `Metrics` does it. |
| Panel-open signal | A count, not a bool | With N panels, "open" means any of them. A bool would make the last writer win. |
| Refcount | Explicit, and clamped at zero | Polling must stop when the last widget goes, and a drifting count would poll forever. `Metrics` clamps with `Math.max(0, …)`; so does this. |
| Per-panel UI state | Stays in `Panel.qml` | Expansion and search text belong to the surface they happened on. |
| Verification | Two plugin instances first, a headless output second | Running the dev copy beside the installed one puts two widgets on one screen and needs no compositor support — found by accident when both were left enabled. The headless output is the faithful version, because it also exercises surface creation and teardown. Either beats reasoning about it, which is what left three duplications in place for five releases. |

## Risks

| Risk | What we do |
|---|---|
| **The loader may not resolve a plugin `qmldir`.** Four plugins ship one, but this design has not been observed initialising under this shell's plugin loader. If `import "."` does not resolve, the whole design is void. | **Settle it first, before any other work**: add the `qmldir`, import it from `Panel.qml`, deploy, read the journal. A `ReferenceError` or a failed import appears there and nowhere else. If it fails, this spec is withdrawn in favour of the cache file. |
| **Refcount drift across a hot reload.** `bin/dev` reloads the plugin in place. If the singleton outlives a reload while widgets are recreated, `attach()` runs again without a matching `detach()`, and `consumers` climbs — the widget could be removed and polling continue for the life of the shell. | Clamp at zero, and treat the count as a gate rather than a truth: `shouldRun` also requires at least one panel to have completed. Measured across a reload during verification, not assumed. |
| **`Component.onDestruction` may not fire** on every teardown path, which is the same class of problem as `Process` not emitting `exited()` on a failed spawn. | Verified during the multi-surface test by destroying a surface and watching whether the poll stops. |
| **One shared service means one failure.** Today a broken instance affects one monitor; after this it affects all of them. | Accepted. It is the point of the change, and the failure paths already resolve rather than strand — a failed spawn synthesises 127, a failed read resolves to "no saved stations". |

## Testing

Nothing here is reachable from `node --test`: it is QML lifecycle and process
behaviour. `Model.js`, `Gtfs.js`, `State.js` and their tests are untouched, and
the suite must stay at its current count and stay green, which is itself the
assertion that this changed no logic.

The verification is live, and there are two ways to create the condition. The
first was found by accident on 2026-09-22, when the released plugin and the dev
copy were both enabled at once and behaved exactly like two monitors:

```bash
# Two plugin ids, two widgets, one screen. The same condition as two surfaces,
# and it needs no compositor support at all.
./bin/dev up                    # alongside the installed ssandys.headway
pgrep -a -P "$(pgrep -x quickshell | head -1)" curl   # TWO mta fetches today
./bin/dev down                  # when finished, or normal use has two of everything
```

The faithful version, which also exercises surface creation and teardown:

```bash
hyprctl output create headless          # a second bar surface appears
# then, over one poll interval:
pgrep -a -P "$(pgrep -x quickshell | head -1)" curl   # ONE mta fetch, not two
hyprctl output remove HEADLESS-2         # and the poll continues, not stops
```

Checks, in order:

1. With two surfaces, one `api-endpoint.mta.info` fetch per interval, not two.
2. A new alert produces **one** notification, not two.
3. Removing the second output leaves polling running; removing both stops it.
4. `./bin/dev up` twice in a row does not leave `consumers` climbing — the poll
   interval must not accelerate, and the count must return to the number of
   live surfaces.
5. The panel still opens, the station search still filters, and a row expanded
   on one surface is **not** expanded on the other.

## Out of scope

- `galley`, `colophon` and `tonearm` have the same structure and two of them
  have the same duplicate-notification bug. They are separate repositories; the
  portable version of this is in `docs/shared-state-in-omarchy-plugins.md`.
- The README's Known limitations entry, which this makes false. It is rewritten
  as part of the work, not left for later.
- Any change to what is fetched, how it is decoded, or how alerts are
  classified.


## Measured, 2026-09-22

Observed numbers, not expected ones.

**The gate (does a plugin singleton resolve, and is it shared?).** A throwaway
`Probe.qml` with an `Item` root logged `marker=probe-resolved attaches=1` on
load — so a plugin `qmldir` does resolve under this shell's loader, and an
`Item` root works as a singleton. Creating a second bar surface with
`hyprctl output create headless` took it to `attaches=2` **on the same object**,
which is both halves of the gate: the type resolves, and two surfaces share one
instance rather than getting one each.

That also measured the premise the issue was filed on. The attach count going
1 → 2 when a monitor appears *is* the duplication.

**Concurrent fetches to `api-endpoint.mta.info`**, sampled at 0.2s against the
shell's `curl` children, two bar surfaces throughout:

| condition | concurrent |
|---|---|
| Unfixed code, two surfaces | **2** (and 4 momentarily, while two shells overlapped during a restart) |
| Installed copy (unfixed) and dev copy (singleton) both enabled | **3** — which is 2 + 1, each copy contributing its own |
| Dev copy alone, singleton, two surfaces | **1** |

The middle row is the useful one: it shows the two copies' contributions
separately in a single sample, so the singleton's "1" is not an artefact of a
quiet interval. A non-zero hit count in the third run also rules out the
confound that would otherwise make this worthless — a widget that never polled
would report "1 or fewer" too.

## Not yet measured

Three of the plan's checks did not happen, and the change should not be
described as verified until they do.

- **Refcount drift across reloads.** Running `./bin/dev up` three times in
  quick succession killed the shell before anything could be observed — see
  below. Whether `consumers` returns to the number of live surfaces after a
  reload is still unknown, and it is the failure mode that would keep polling
  forever after every widget is gone.
- **One notification rather than two.** No new alert arrived during the
  measurement window, and the stale path was not forced.
- **Per-surface state staying per-surface.** Confirming that a row expanded on
  one surface does not expand on the other needs two panels open and someone
  looking at both.

## An unrelated bug found while measuring

`bin/dev up` can leave the shell dead. The journal shows the replacement
launching before the old one has exited:

```
omarchy-shell[2016332]: An instance of this configuration is already running.
omarchy-shell[2004206]: INFO: Exiting due to IPC request.
```

The new process refuses to start because the old is still alive, then the old
exits on the IPC request, and nothing is left running. Reproduced twice —
once on a single `up`, once on three in a row — with no coredump either time,
because it is a clean exit rather than a crash. `omarchy restart shell` is the
recovery.

CONTRIBUTING records that `bin/dev` is copied **byte-identical** from galley and
derives plugin identity from `manifest.json` at runtime, so this is not
Headway's bug and not Headway's alone: galley, colophon and tonearm ship the
same script.
