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
    text: Model.BAR_GLYPH + (service.barState.badge ? "  " + service.barState.badge : "")
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
      onCloseRequested: {
        if (searchField.activeFocus) { searchField.focus = false; return }
        root.close()
      }
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


      // ---- header ----
      RowLayout {
        Layout.fillWidth: true
        Text {
          text: service.station ? service.station.name : "Headway"
          color: root.barForeground
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

          Text {
            text: arrivalRow.modelData.routeId +
                  (arrivalRow.modelData.express ? "X" : "")
            color: root.barForeground
            font.pixelSize: Style.font.body
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
        delegate: Text {
          id: alertRow
          required property var modelData
          Layout.fillWidth: true
          wrapMode: Text.WordWrap
          font.pixelSize: Style.font.caption
          text: alertRow.modelData.headerText
          color: {
            var cls = Model.classifyAlert(alertRow.modelData.alertType)
            return cls === "red" ? Model.COLOR_ERROR
                 : cls === "amber" ? Model.COLOR_WARN
                 : root.barForeground
          }
          opacity: Model.classifyAlert(alertRow.modelData.alertType) === "info"
                   || Model.classifyAlert(alertRow.modelData.alertType) === "planned"
                   ? 0.6 : 1.0
        }
      }

      // ---- saved stations ----
      Repeater {
        model: service.stations
        delegate: RowLayout {
          id: savedRow
          required property var modelData
          Layout.fillWidth: true
          spacing: Style.space(4)
          Button {
            text: (Stations.byId(StationData.STATIONS, savedRow.modelData.stopId)
                   || { name: savedRow.modelData.stopId }).name
                  + "  " + savedRow.modelData.routes.join(" ")
            onClicked: service.setActive(savedRow.modelData.stopId)
          }
          Item { Layout.fillWidth: true }
          Button { text: "✕"; onClicked: service.removeStation(savedRow.modelData.stopId) }
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
        // Qt does not clear activeFocus when an item is hidden, so the key
        // catcher would keep stealing `r` and Esc. Release it explicitly.
        onVisibleChanged: if (!visible) searchField.focus = false
      }

      Repeater {
        model: Stations.search(StationData.STATIONS, root.query, service.origin, 6)
        delegate: RowLayout {
          id: hit
          required property var modelData
          Layout.fillWidth: true
          spacing: Style.space(4)
          Text {
            // Routes, borough and line are NOT decoration: 76 station names are
            // ambiguous and six of them read exactly "86 St". A row showing
            // only a name is not a choice anyone can make correctly.
            text: hit.modelData.name + "  " + hit.modelData.routes.join(" ")
                  + "  " + Stations.boroughName(hit.modelData.borough)
                  + (hit.modelData.distanceKm !== null
                     ? "  " + hit.modelData.distanceKm.toFixed(1) + " km" : "")
            color: root.barForeground
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
              onClicked: service.saveStation({
                stopId: hit.modelData.id, name: hit.modelData.name,
                routes: hit.modelData.routes, direction: dirButton.modelData.dir
              })
            }
          }
        }
      }

      Text {
        text: "r refresh   esc close"
        color: root.barForeground
        opacity: 0.6
        font.pixelSize: Style.font.caption
      }
    }
  }
}
