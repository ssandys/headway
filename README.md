# Headway

An Omarchy shell bar widget showing minutes to the next NYC subway train at
stations you've saved, with MTA service alerts for the lines you actually ride.

*Headway* is the transit term for the interval between successive trains —
literally the number the widget puts in the bar.

![The Headway widget and its panel. In the bar, a conductor glyph carries a
small circular badge reading 3 — three minutes to the next train. The open
panel below is headed "Headway" with "updated 55s ago" on the right. Under it,
the active station "Franklin Av-Medgar Evers College" with its direction filter
"Manhattan", then three arrivals, each a coloured MTA route bullet, a
destination and a countdown: a red 2 to Wakefield-241 St in 3 minutes, a green
4 to Woodlawn in 21, a red 2 to Wakefield-241 St in 24. Below those, two live
service alerts in amber: no overnight 5 between Dyre Av and E 180 St, and
Woodlawn-bound 4 trains skipping Burnside Av. Then the saved-station list —
Franklin Av-Medgar Evers College with red 2 and 3 and green 4 and 5 bullets,
14 St-Union Sq with green 4, 5 and 6, Brooklyn Bridge-City Hall with green 4, 5
and 6 — each with an ✕ to remove it. At the bottom, a search box reading "Add a
station" and six nearby results with their route bullets, borough and distance
in miles, each offering two direction buttons such as Uptown and
Downtown.](preview.png)

## Prerequisites

| Program | Used for | Arch package |
|---|---|---|
| `notify-send` | Desktop notifications | `libnotify` |

Plus the Omarchy shell itself. **That is the whole list** — no interpreter, no
API key, no pip or npm packages, and no static GTFS download at runtime.

That is deliberately not the same claim as "there are no prerequisites."
`Service.qml` spawns `notify-send`, and `libnotify` is in neither `base` nor
`base-devel`; it arrives as a dependency of other desktop software, so it is
near-universal but not guaranteed. Both sibling plugins list it too.

Without it, **notifications silently do not appear** and nothing else changes.
The spawn fails, `onRunningChanged` still fires, the queue drains, and the
widget carries on.

The MTA's GTFS-Realtime feeds need no key and no registration. Headway decodes
the protobuf itself in QML's JavaScript engine, which is why there is no
collector script and no language runtime to install — unlike its siblings
`galley` and `colophon`, which shell out to Python.

## Install

```bash
omarchy plugin add https://github.com/ssandys/headway.git --enable
```

## Reading the bar

A conductor glyph, plus a badge carrying minutes to the next train matching the
active station's route and direction filter.

| State | Glyph colour | Badge |
|---|---|---|
| Normal | default bar foreground | minutes to next train |
| Active unplanned alert, amber, on a saved route | amber | minutes |
| Data stale past `staleAfterSec` | amber | last known minutes |
| Active unplanned alert, red, on the **active** route | red | minutes, or none |
| Feed unreachable | red | none |
| No trains scheduled | default | none |

**The badge colour never changes.** Severity reaches the bar entirely through
the glyph, so a red glyph carrying a number means "a train is coming, *and*
something is wrong". A train less than a minute out shows `•` rather than a
number — the badge is a circle sized for two characters, and the panel spells
out `now` where there is room for it.

## Using the panel

Click the glyph to open it. Middle-click the glyph to force a refresh without
opening anything.

| Key / action | Effect |
|---|---|
| `r` | Refresh now |
| `Esc` | Close the panel — or, while the search box has focus, leave the box |
| Click a saved station's name | Make it the active station |
| Click a saved station's `✕` | Remove it |
| Type in the search box | Filter all 496 stations by name |
| Click a direction button on a result | Save that station with that direction, and make it active |

The panel shows, top to bottom: the active station and its direction filter;
the next few arrivals, each with a coloured route bullet, its destination and a
countdown; any live alerts for your saved routes; your saved stations; and the
search box.

**Route bullets follow the MTA's colours,** and an express train gets a diamond
where a local gets a disc. Colour means *identity* here and never severity —
the bar is where severity lives.

**Search results are ordered nearest-first** using the location Omarchy already
knows, read from `~/.local/state/omarchy/settings/weather.json`. Distances show
in miles.

Two things about that ordering are worth knowing, because both look like bugs
and are not:

- **Every result names its routes, borough and line.** 76 station names are
  ambiguous and six of them read exactly `86 St`; a row showing only a name is
  not a choice anyone can make correctly.
- **A station complex's platforms stay together,** anchored at the complex's
  nearest member. So per-row distances are not always ascending — Chambers St's
  J/Z platform can sit above its A/C platform. Burying one platform of a
  complex several rows from its neighbours would be worse.

Location is used for setup convenience only. It orders the picker once and is
then never consulted again: nothing runs on a timer, and the bar cannot change
out from under you.

## Configuration

Configure per-widget through Omarchy's plugin settings.

| Setting | Default | Effect |
|---|---|---|
| `pollIntervalOpenSec` | `30` | Feed poll interval while the panel is open |
| `pollIntervalIdleSec` | `90` | Feed poll interval while idle |
| `alertsIntervalSec` | `300` | Service-alert refresh interval |
| `staleAfterSec` | `180` | Treat data older than this as stale |
| `trainsPerDirection` | `3` | Arrivals to list per direction |
| `notifyRouteAlert` | `true` | Notify on a new alert for a saved route |
| `notifyFeedStale` | `true` | Notify when the feed goes stale or unreachable |

Saved stations are **not** plugin settings. Omarchy's plugin settings are
read-only at runtime — the shell exposes no write-back API — so the saved list
lives in `~/.local/state/omarchy/settings/headway.json`, beside the shell's own
`weather.json` and `flight-radar.json`.

## Troubleshooting

**Nothing in the bar.** Run `omarchy restart shell`. The shell reads a
plugin's structure at startup, so a newly added or changed plugin needs one.

**See the raw data.** `node scripts/collect.mjs` prints the same snapshot the
widget works from, using the *same* `Gtfs.js` decoder rather than a parallel
reimplementation. Use it to tell "the MTA is not returning what I expect" apart
from "the widget is not rendering what it was given".

**An amber glyph** means either a service alert on one of your routes, or data
older than `staleAfterSec`. The panel's header says which: it reads
`updated 45s ago` normally and `stale - 6m old` once the feed has stopped
arriving.

**A red glyph with no badge** means the feed is unreachable. The panel says so
explicitly, with the error.

**Saved stations vanished.** Check `~/.local/state/omarchy/settings/headway.json`
is valid JSON. Headway falls back to an empty list rather than refusing to
start, so a corrupt file looks like lost stations rather than an error.

## Known limitations

- **One poll per monitor.** The Omarchy bar instantiates a widget once per bar
  surface, and a bar surface exists per monitor — so on a two-monitor setup
  Headway fetches the feeds twice per interval, on three monitors three times.
  Neither galley nor colophon coordinates across instances either (verified:
  their poll timers run unconditionally per instance), so this is the house
  behaviour rather than a Headway bug. It matters slightly more here because
  those two poll local services while this one polls the MTA over the network.
  The volume is small — riding only the L is 23 KB per fetch — but it is real,
  and worth knowing before running Headway on a wall of monitors.
- **Distances are always miles.** Not yet a setting.
- **Subway only.** No LIRR, Metro-North or bus. Bus additionally needs an API
  key.
- **No leave-now notifications.** This needs a per-station walking time. It is
  the most likely first addition, and the one that would make the widget
  actively useful rather than merely informative.
- **No train positions or map**, though the vehicle positions are in the same
  feeds.
- **No trip planning** between two saved stations.
- **No express-versus-local filter.** Headway recognises `6X`/`7X` so express
  trains are never silently dropped, and marks them with a diamond, but
  choosing to see only expresses is not a control.
- **Next arrivals, not a timetable.**
- **Alerts show `header_text`,** not the long `description_text`.

## Uninstall

```bash
omarchy plugin remove ssandys.headway
```

That leaves `~/.local/state/omarchy/settings/headway.json` in place, so
reinstalling restores your saved stations. Delete it too for a clean slate.
