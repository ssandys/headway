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

test("the devkit scripts carry no plugin-specific literal", () => {
  // bin/dev and bin/dev-watch are copied byte-identical from galley and
  // derive plugin identity from manifest.json at runtime. That is what makes
  // them portable to the next plugin without edits, and galley guards it with
  // tests/test_dev.py's PortabilityTest. This project has no Python, so the
  // guard would have been silently dropped -- and an invariant nothing checks
  // is one that quietly stops being true. The failure would surface only when
  // someone ported the scripts onward and found a hardcoded id.
  //
  // Comment lines are excluded deliberately: galley's own bin/dev names its
  // upstream repo in a comment, which is documentation, not a dependency.
  // Verified both ways -- with the filter both scripts are clean, without it
  // bin/dev is falsely flagged.
  const id = manifest.id
  const name = manifest.name
  const short = id.split(".").pop()
  for (const script of ["bin/dev", "bin/dev-watch"]) {
    const body = readFileSync(join(__dirname, "..", script), "utf8")
    const functional = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .toLowerCase()
    for (const literal of [id, name, short]) {
      assert.ok(!functional.includes(literal.toLowerCase()),
        `${script} must not hardcode "${literal}" — it is derived from manifest.json`)
    }
  }
})
