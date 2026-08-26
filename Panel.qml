import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Stations.js" as Stations
import "StationData.js" as StationData

Panel {
  id: root
  moduleName: "ssandys.headway"

  // The base is Ui/Panel.qml, NOT Ui/BarWidget.qml — this is what galley and
  // colophon both extend, and the manifest's `entryPoints.barWidget` points
  // at this file regardless of the base's name. Ui/Panel.qml injects `bar`,
  // `moduleName` and `settings` AND provides the panel lifecycle:
  // `opened`, `barForeground`, `open()`, `close()`, `toggle()`, `setting()`.
  // Ui/BarWidget.qml provides only the first three and none of the
  // lifecycle, so a widget rooted at BarWidget has no way to open its panel.

  // Declared on the ROOT, because the search field and the results Repeater
  // both address it as `root.query`. QML resolves an unqualified name against
  // the object, the component root and declared ids — never an arbitrary
  // enclosing item — so declaring this on the inner ColumnLayout would fail
  // at runtime as a ReferenceError that qmllint cannot see.
  property string query: ""

  // REQUIRED. Ui/Panel.qml does not set its own implicit size, so a bar widget
  // must size itself from its button — every one of them does: galley:69,
  // colophon:81, and the first-party dropbox:135 and network:804. Without
  // these two lines the root is 0x0, `anchors.fill: parent` faithfully gives
  // the button 0x0, and the widget renders NOTHING with no error logged.
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Ui/Panel.qml provides bar, settings, opened and barForeground -- and NOT
  // these three. galley:39-42 and colophon declare the same set. The badge, the
  // route bullets and the header all read them, and a missing one is a
  // ReferenceError raised inside a property binding, which qmllint cannot see
  // and which fails as a silently unstyled element rather than an error.
  readonly property string barIcon: Model.BAR_GLYPH
  readonly property color dim: Qt.darker(root.barForeground, 1.45)
  // Follows the bar's own font so the panel matches its chrome; Style.font
  // .family (which resolves to "monospace") is the fallback before the bar is
  // injected, rather than galley's hardcoded family name.
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  Service {
    id: service
    settings: root.settings
    panelOpen: root.opened
  }

  // BarIconButton, NOT WidgetButton. It paints the glyph through OpticalGlyph,
  // which centres on the painted ink rather than the monospace advance cell;
  // WidgetButton is for text labels. Every icon-only widget in the bar — audio,
  // power, network, tray — uses BarIconButton, and both galley and colophon
  // switched to it for exactly this. It extends WidgetButton, so bar, text,
  // foreground, tooltipText and onPressed all carry over unchanged.
  //
  // anchors.fill: parent is REQUIRED. Without it the button has no geometry
  // inside the Panel root and renders at zero size — an invisible widget with
  // no error logged anywhere. Both siblings set it.
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The glyph ALONE. The countdown is no longer appended -- it renders as the
    // badge child below, so a minute ticking over no longer changes the
    // button's width and shoves its neighbours along the bar.
    text: Model.BAR_GLYPH
    tooltipText: service.tooltip
    // `foreground`, not `color` — that is WidgetButton's own colour property.
    // And `barForeground` rather than `foreground`: bar chrome convention, so
    // a transparent bar recolours this glyph along with its neighbours
    // instead of leaving it as the only unreadable widget.
    //
    // Severity reaches the bar entirely through the glyph's colour. The badge
    // never changes colour, so a red glyph carrying a number means "a train is
    // coming, AND something is wrong".
    foreground: {
      if (service.barState.severity === "error") return Model.COLOR_ERROR
      if (service.barState.severity === "warn") return Model.COLOR_WARN
      return root.barForeground
    }

    // No MouseArea here on purpose: a bare Rectangle/Text consumes no mouse
    // events, so click-to-open, middle-click-refresh and the tooltip all keep
    // working straight through the badge.
    BorderSurface {
      visible: badgeLabel.text !== ""
      width: Math.max(9, button.fontSize * 0.85)
      height: width
      radius: width / 2
      color: Color.accent
      // The 1px ring separates the badge from the glyph underneath. Color
      // .background, NOT Color.bar.background: the latter resolves through the
      // theme's bar.background-alpha, so on a translucent bar the ring itself
      // would go translucent and reintroduce the smear it exists to prevent.
      borderSpec: Border.flat(Color.background, 1)

      // glyphPaintedWidth, not labelWidth: BarIconButton sets labelVisible to
      // false and paints through OpticalGlyph, so labelWidth is 0 here and the
      // badge would collapse onto the glyph's centre. glyphPaintedWidth is the
      // ink width, which is what this wants anyway -- half of it right of
      // centre is the painted glyph's right edge, and half a font-size above
      // centre is its top. The badge straddles that corner.
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.horizontalCenterOffset: button.glyphPaintedWidth / 2
      anchors.verticalCenter: parent.verticalCenter
      anchors.verticalCenterOffset: -button.fontSize * 0.5

      Text {
        id: badgeLabel
        anchors.centerIn: parent
        // barState.badge comes from Model.badgeText, never formatCountdown:
        // this circle holds two characters and "now" is three. badgeText
        // returns a bullet for an arriving train; the panel rows below still
        // spell the word out, where there is room for it.
        text: service.barState.badge
        color: Color.background
        font.family: root.fontFamily
        font.bold: true
        font.pixelSize: Math.max(6, parent.height * 0.66)
        renderType: Text.NativeRendering
      }
    }

    onPressed: function (which) {
      if (which === Qt.MiddleButton) { service.refresh(); return }
      if (root.opened) root.close()
      else root.open()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    // KeyboardPanel has NO toggle() and NO visible. `open` is a property, and
    // the lifecycle lives on Ui/Panel.qml — so the panel follows root.opened
    // and the button drives root.open()/root.close().
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // `blocked` stops the panel swallowing j/k/h/l, Enter and Escape while
      // a text field has focus — the same wiring the first-party network,
      // clock and weather panels use for their inline editors. It also means
      // typing "r" into the search box types an r rather than refreshing.
      blocked: searchField.activeFocus

      // These are PanelKeyCatcher's OWN signal names, verified against
      // Ui/PanelKeyCatcher.qml: moveRequested, activateRequested,
      // returnRequested, closeRequested, deleteRequested, tabRequested,
      // textKey. There is no `onRefresh` and no `onDismiss` — an invented
      // handler name is not a compile error that qmllint can see, so it
      // fails silently at runtime and the key simply does nothing.
      // No searchField branch here. `blocked` above short-circuits
      // PanelKeyCatcher before this signal is emitted, so this only ever runs
      // when the search box does NOT have focus. Escape while typing is handled
      // on the field itself.
      onCloseRequested: root.close()
      onTextKey: function (text) {
        if (text === "r") service.refresh()
      }
    }

    ColumnLayout {
      id: contentColumn
      // REQUIRED, and left/right/top rather than anchors.fill. Without them the
      // column takes its own implicitWidth -- the widest child, which is an
      // unwrapped alert headline -- while the panel background stays at
      // contentWidth, so the right-hand column and long alerts paint OUTSIDE
      // the panel, over whatever window is behind it. `wrapMode` alone does not
      // prevent this: a wrapping Text still reports its full single-line
      // implicitWidth, and Layout.fillWidth only shares out surplus space, it
      // never caps an implicit width.
      //
      // Not anchors.fill: pinning the bottom too would drive the column's
      // height from the panel while contentHeight is bound BACK to
      // contentColumn.implicitHeight -- a binding loop. galley and colophon
      // both use exactly these three anchors for that reason.
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      spacing: Style.space(6)


      // ---- plugin header ----
      // Icon + name on the left, one dim line of status on the right, then a
      // separator. The shape galley and colophon both use, and the first-party
      // panels with it.
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.space(8)
        Text {
          text: root.barIcon + "  Headway"
          color: root.barForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          font.bold: true
          Layout.fillWidth: true
        }
        Text {
          // Data age, which the spec puts in the header. The wording comes from
          // Model.feedAgeText so the stale boundary is tested rather than
          // reimplemented in a binding.
          text: Model.feedAgeText(service.feedTimestamp, service.nowSec,
                                  service.staleAfterSec)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      PanelSeparator { Layout.fillWidth: true; foreground: root.barForeground }

      // ---- active station ----
      RowLayout {
        Layout.fillWidth: true
        // Was the panel's only title, and said "Headway" with nothing saved.
        // The plugin header carries the name now, so this row is the station
        // alone and disappears when there is not one -- the empty-state line
        // below already says so.
        visible: !!service.station
        Text {
          text: service.station ? service.station.name : ""
          color: root.barForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
        }
        Item { Layout.fillWidth: true }
        Text {
          visible: !!service.saved
          text: service.saved
            ? Model.directionLabelOf(service.station, service.saved.direction)
            : ""
          color: root.barForeground
          opacity: 0.6
          font.pixelSize: Style.font.caption
        }
      }

      Text {
        visible: !service.ok
        text: "feed unreachable - " + service.error
        color: Model.COLOR_ERROR
        font.pixelSize: Style.font.caption
      }

      // ---- arrivals ----
      Repeater {
        model: service.arrivals.slice(0, service.trainsPerDirection)
        delegate: RowLayout {
          id: arrivalRow
          required property var modelData
          Layout.fillWidth: true
          spacing: Style.space(6)

          RouteBullet {
            // arrivalsFor already split the id -- routeId is normalized and
            // `express` carries the marker separately -- so both are handed
            // over and the bullet draws a diamond instead of appending an X.
            routeId: arrivalRow.modelData.routeId
            express: arrivalRow.modelData.express
            fontFamily: root.fontFamily
          }
          Text {
            // The destination is the trip's own terminal, resolved through the
            // station table. No join against static trips.txt: NYCT's realtime
            // trip ids do not reliably match the static ones.
            text: {
              var terminal = Stations.parentOf(arrivalRow.modelData.destinationStopId)
              var dest = Stations.byId(StationData.STATIONS, terminal)
              return dest ? dest.name : ""
            }
            color: root.barForeground
            opacity: 0.6
            font.pixelSize: Style.font.caption
            Layout.fillWidth: true
            elide: Text.ElideRight
          }
          Text {
            text: Model.formatCountdown(arrivalRow.modelData.etaSec)
            color: root.barForeground
            font.pixelSize: Style.font.body
          }
        }
      }

      Text {
        visible: service.ok && service.arrivals.length === 0
        text: service.saved ? "No trains scheduled" : "No station saved yet"
        color: root.barForeground
        opacity: 0.6
        font.pixelSize: Style.font.caption
      }

      // ---- alerts ----
      Repeater {
        // service.liveAlerts, NOT Model.alertsFor(..., service.nowSec). A
        // Repeater's model is a `var` compared by reference, so binding it to
        // anything that changes every second rebuilds every delegate every
        // second. liveAlerts is keyed on a minute-resolution clock.
        model: service.liveAlerts
        delegate: RowLayout {
          id: alertRow
          required property var modelData
          Layout.fillWidth: true
          spacing: Style.space(4)
          readonly property string cls:
            Model.classifyAlert(alertRow.modelData.alertType)

          // The route the alert belongs to, so a list of alerts at an
          // interchange is readable. Model.alertsForDisplay attributes and
          // orders them; this just draws the bullet. An alert it could not
          // attribute renders without one rather than being dropped.
          RouteBullet {
            visible: alertRow.modelData.matchedRoute !== ""
            routeId: alertRow.modelData.matchedRoute
            fontFamily: root.fontFamily
            diameter: Style.font.caption * 1.4
            Layout.alignment: Qt.AlignTop
          }

          Text {
            Layout.fillWidth: true
            wrapMode: Text.WordWrap
            font.pixelSize: Style.font.caption
            text: alertRow.modelData.headerText
            color: alertRow.cls === "red" ? Model.COLOR_ERROR
                 : alertRow.cls === "amber" ? Model.COLOR_WARN
                 : root.barForeground
            opacity: alertRow.cls === "info" || alertRow.cls === "planned"
                     ? 0.6 : 1.0
          }
        }
      }

      // ---- saved stations ----
      // Wrapped in its own ColumnLayout so this list can be tighter than the
      // panel's section spacing. Direct children of contentColumn are separated
      // by Style.space(6), which is right BETWEEN sections and too loose within
      // a list.
      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(2)

      Repeater {
        model: service.stations
        delegate: RowLayout {
          id: savedRow
          required property var modelData
          Layout.fillWidth: true
          spacing: Style.space(4)
          Button {
            // The routes moved out of this label into the bullets beside it.
            // The NAME stays the click target that activates the station.
            // Falls back to the persisted name before the bare stop id.
            // writeState stores `name` on every entry, and it was never read --
            // so a station missing from a regenerated StationData.js would have
            // shown a raw id like "L08" when a perfectly good name was on disk.
            text: (Stations.byId(StationData.STATIONS, savedRow.modelData.stopId)
                   || { name: savedRow.modelData.name || savedRow.modelData.stopId }).name
            onClicked: service.setActive(savedRow.modelData.stopId)
            // Compact, not Ui/Button.qml's defaults. Those are body size with
            // controlPaddingY (6, so 12px vertical), which made these rows 41px
            // tall and the list read as a column of buttons rather than a list
            // of stations. Same values colophon uses for its action row.
            fontSize: Style.font.caption
            horizontalPadding: Style.space(6)
            verticalPadding: Style.space(2)
          }
          Repeater {
            model: savedRow.modelData.routes
            delegate: RouteBullet {
              required property var modelData
              routeId: modelData
              fontFamily: root.fontFamily
              diameter: Style.font.caption * 1.5
            }
          }
          Item { Layout.fillWidth: true }

          // The direction, shown AND clickable. Previously a saved row did not
          // say which way it was pointed at all -- you had to read the header,
          // and only for the active station -- and changing it meant searching
          // the station out again.
          //
          // Model.nextDirection, never an N<->S flip: 33 stations are terminals
          // with one usable direction, and flipping one lands on a direction
          // with no trains, leaving the widget blank with nothing to explain it.
          // Those rows show their single direction and are not clickable.
          Button {
            id: dirToggle
            readonly property var station:
              Stations.byId(StationData.STATIONS, savedRow.modelData.stopId)
            readonly property var options:
              dirToggle.station ? Stations.directionsFor(dirToggle.station) : []
            visible: !!dirToggle.station
            text: Model.directionLabelOf(dirToggle.station,
                                         savedRow.modelData.direction)
            enabled: dirToggle.options.length > 1
            opacity: enabled ? 1.0 : 0.45
            tooltipText: enabled ? "Switch direction"
                                 : "This station is a terminal -- one direction only"
            fontSize: Style.font.caption
            horizontalPadding: Style.space(6)
            verticalPadding: Style.space(2)
            onClicked: {
              var dirs = []
              for (var i = 0; i < dirToggle.options.length; i++) {
                dirs.push(dirToggle.options[i].dir)
              }
              // setDirection, NOT saveStation: saveStation activates, so
              // flipping a background row's direction used to drag the panel
              // and the bar over to it. Changing a row's setting is not a
              // request to look at that row -- clicking its name is.
              service.setDirection(
                savedRow.modelData.stopId,
                Model.nextDirection(dirs, savedRow.modelData.direction))
            }
          }

          Button {
            text: "✕"
            onClicked: service.removeStation(savedRow.modelData.stopId)
            fontSize: Style.font.caption
            horizontalPadding: Style.space(6)
            verticalPadding: Style.space(2)
          }
        }
      }
      }

      // ---- search ----
      TextField {
        id: searchField
        Layout.fillWidth: true
        placeholderText: "Add a station"
        // Typing does NOT break a QML binding, so the query must be routed into
        // the state the results binding reads from. Assigning `text` from a
        // binding would wipe half-typed input on every poll.
        onTextEdited: root.query = searchField.text
        // Escape is handled HERE, not in PanelKeyCatcher's onCloseRequested.
        // PanelKeyCatcher.qml:49 does `if (blocked) return` BEFORE it emits
        // closeRequested(), and `blocked` is bound to this field's activeFocus
        // -- so that signal cannot fire while the box has focus, and the guard
        // that used to sit in its handler was unreachable by construction. The
        // event fell through to this TextField, which does not handle Escape,
        // and keyCatcher is a SIBLING of contentColumn rather than an ancestor,
        // so it never saw the key a second time. Net effect: Escape while
        // typing did nothing at all, twice over, against three written
        // contracts that said it cleared the search.
        //
        // Clearing `text` imperatively is safe: the rule this file follows
        // forbids assigning `text` from a BINDING, not from a handler.
        Keys.onEscapePressed: {
          root.query = ""
          searchField.text = ""
          searchField.focus = false
        }
        // Qt does not clear activeFocus when an item is hidden, so the key
        // catcher would keep stealing `r` and Esc. Release it explicitly.
        onVisibleChanged: if (!visible) searchField.focus = false
      }

      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(2)

      Repeater {
        model: Stations.search(StationData.STATIONS, root.query, service.origin, 6)
        delegate: RowLayout {
          id: hit
          required property var modelData
          // The per-station ROUTE filter, defaulting to every route the station
          // serves -- so ignoring the bullets behaves exactly as it did before
          // this existed. Assigning it below deliberately breaks this binding;
          // that is what stops a selection resetting when the results array is
          // rebuilt on the next poll.
          property var picked: hit.modelData.routes.slice()
          Layout.fillWidth: true
          spacing: Style.space(4)
          // Split into name / bullets / place, where it used to be one string.
          // Routes, borough and line are NOT decoration: 76 station names are
          // ambiguous and six of them read exactly "86 St". A row showing only
          // a name is not a choice anyone can make correctly -- and the route
          // set is the part doing that work, which is why it gets the colour.
          Text {
            text: hit.modelData.name
            color: root.barForeground
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            // maximumWidth, not fillWidth: the bullets and the borough must
            // keep their room, so a long name elides rather than pushing them
            // off the row.
            Layout.maximumWidth: contentColumn.width * 0.45
          }
          Repeater {
            model: hit.modelData.routes
            delegate: RouteBullet {
              required property var modelData
              routeId: modelData
              fontFamily: root.fontFamily
              diameter: Style.font.caption * 1.4
              // Click a bullet to include or exclude that route. Model
              // .toggleRoute owns the rules -- station order preserved, never
              // empty -- because those are testable and a binding is not.
              interactive: true
              selected: hit.picked.indexOf(modelData) >= 0
              onToggled: hit.picked = Model.toggleRoute(hit.modelData.routes,
                                                        hit.picked, modelData)
            }
          }
          Text {
            // Model.distanceText, not an inline toFixed: it converts km to
            // miles and is the single place a unit setting would land.
            text: Stations.boroughName(hit.modelData.borough)
                  + "  " + Model.distanceText(hit.modelData.distanceKm)
            color: root.barForeground
            opacity: 0.6
            font.pixelSize: Style.font.caption
            Layout.fillWidth: true
            elide: Text.ElideRight
          }
          Repeater {
            model: Stations.directionsFor(hit.modelData)
            delegate: Button {
              id: dirButton
              required property var modelData
              text: dirButton.modelData.label
              // Compact, for the same reason as the saved list: these were the
              // 41px-tall buttons setting every search row's height.
              fontSize: Style.font.caption
              horizontalPadding: Style.space(6)
              verticalPadding: Style.space(2)
              // hit.picked, NOT hit.modelData.routes. Saving the whole route set
              // is what made the spec's own motivating example fail: at Union Sq,
              // "next train" across seven routes is not a number anyone can plan
              // around, which is the entire reason the filter is specced.
              onClicked: service.saveStation({
                stopId: hit.modelData.id, name: hit.modelData.name,
                routes: hit.picked, direction: dirButton.modelData.dir
              })
            }
          }
        }
      }
      }

      Text {
        text: "r refresh   esc close"
        Layout.alignment: Qt.AlignHCenter
        color: root.barForeground
        opacity: 0.6
        font.pixelSize: Style.font.caption
      }
    }
  }
}
