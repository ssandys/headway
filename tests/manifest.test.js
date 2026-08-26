// tests/manifest.test.js
const test = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"))
const serviceQml = readFileSync(join(__dirname, "..", "Service.qml"), "utf8")

test("the manifest declares the plugin id the docs promise", () => {
  assert.equal(manifest.id, "ssandys.headway")
  assert.equal(manifest.entryPoints.barWidget, "Panel.qml")
})

test("every schema key has a matching default", () => {
  for (const entry of manifest.barWidget.schema) {
    assert.ok(entry.key in manifest.barWidget.defaults, `${entry.key} has a default`)
    assert.equal(manifest.barWidget.defaults[entry.key], entry.defaultValue,
      `${entry.key} default agrees with its schema defaultValue`)
  }
})

test("Service.qml's setting() fallbacks match the manifest defaults", () => {
  // The one surviving cross-file drift risk. A one-sided edit here fails
  // silently at runtime -- the widget just quietly uses a different number.
  for (const [key, value] of Object.entries(manifest.barWidget.defaults)) {
    const re = new RegExp(`setting\\(\\s*"${key}"\\s*,\\s*([^)]+?)\\s*\\)`)
    const m = serviceQml.match(re)
    assert.ok(m, `Service.qml reads setting("${key}", ...)`)
    assert.equal(m[1].trim(), JSON.stringify(value),
      `setting("${key}") fallback matches the manifest`)
  }
})
