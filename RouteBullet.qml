import QtQuick
import qs.Commons
import "Model.js" as Model

// One MTA route bullet: a coloured disc for a local, a diamond for an express.
//
// The shape is the MTA's own convention and it REPLACES the "X" suffix the
// arrival rows used to append to the route id -- "6X" was never how anyone
// reads that train. Colour and text colour both come from Model.js so they are
// unit-tested rather than hand-picked per call site.
Item {
  id: root

  // The FEED's route id, not a display letter -- pass "6X", "GS" or "SI"
  // straight through. Model.routeColor normalizes and Model.normalizeRoute
  // strips the express marker for the label.
  property string routeId: ""
  property bool express: Model.isExpress(root.routeId)
  property string fontFamily: Style.font.family
  property real diameter: Style.font.body * 1.5

  // Interaction is OPT-IN. The arrival rows and the saved list want a plain
  // indicator, and a MouseArea there would swallow clicks meant for the row
  // beneath it -- the saved list's own row is a click target. Only the search
  // results turn this on.
  property bool interactive: false
  property bool selected: true
  signal toggled()

  // Deselected reads as dimmed rather than hidden: the station still serves
  // that route, and a bullet that vanished would make the row's route set look
  // wrong rather than filtered.
  opacity: root.selected ? 1.0 : 0.28

  implicitWidth: diameter
  implicitHeight: diameter

  Rectangle {
    anchors.centerIn: parent
    // A diamond is the square INSCRIBED in the disc's circle, so its side has
    // to shrink by sqrt(2) or its corners stick out past the disc's bounds and
    // push the row taller than every local-train row beside it.
    width: root.express ? root.diameter / Math.SQRT2 : root.diameter
    height: width
    radius: root.express ? 0 : width / 2
    rotation: root.express ? 45 : 0
    color: Model.routeColor(root.routeId)
    antialiasing: true
  }

  Text {
    // A SIBLING of the rectangle, never a child: a child inherits the 45-degree
    // rotation and every express label renders on its side.
    anchors.centerIn: parent
    text: Model.normalizeRoute(root.routeId)
    color: Model.routeTextColor(root.routeId)
    font.family: root.fontFamily
    font.bold: true
    // 0.62 of the disc, not of the inscribed square: the label stays the same
    // size whether the train is local or express, which is what keeps a mixed
    // column of bullets looking like one set.
    font.pixelSize: root.diameter * 0.62
    // The smallest text this widget draws, where hinting matters most -- the
    // same reason WidgetButton's own label uses it.
    renderType: Text.NativeRendering
  }

  MouseArea {
    anchors.fill: parent
    // Both guards: `enabled` alone still leaves the item accepting hover, and
    // an always-present MouseArea over a bullet in the saved list would eat
    // the click that activates the station.
    enabled: root.interactive
    visible: root.interactive
    cursorShape: Qt.PointingHandCursor
    onClicked: root.toggled()
  }
}
