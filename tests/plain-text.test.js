// tests/plain-text.test.js
//
// Every QML Text item renders as plain text, never as markup.
//
// A Text with no textFormat defaults to Text.AutoText, which renders anything
// that looks like markup as styled text -- and styled text loads <img src=...>,
// including from a remote URL. Galley shipped exactly that: a print job titled
// <img src="https://.../pixel"> made the viewer's desktop fetch the URL on
// opening the panel, and the marketplace review blocked the release on it
// (omarchy-plugin-marketplace#8264).
//
// Headway's one string an outsider controls -- MTA alert prose -- already
// rendered as PlainText. Every other Text showed only fixed labels, the static
// station table, route ids from the feed's known vocabulary or error text
// Headway builds itself, so none was exploitable. But that was true by tracing,
// not by rule, and the next Text to show a feed string (a trip headsign, say)
// would reopen it with nothing to notice. Headway never renders markup on
// purpose, so the rule is every Text, static labels included.
//
// Ported from galley's tests/test_plain_text.py, scrape and self-tests alike.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "..")

// `Text {` as a type, not TextMetrics, TextField or an enum like Text.ElideRight.
const TEXT_OPEN = /(?<![\w.])Text\s*\{/g
const PLAIN = /^\s*textFormat\s*:\s*Text\.PlainText\s*$/m

// Every top-level QML file, globbed so a new file is covered unasked.
function qmlSources() {
  const names = fs.readdirSync(ROOT).filter((n) => n.endsWith(".qml")).sort()
  assert.ok(names.length > 0, "no *.qml files at the repo root -- the glob is broken")
  return names.map((n) => [n, fs.readFileSync(path.join(ROOT, n), "utf8")])
}

// Same length as source, with string literals and comments spaced out, so
// brace matching ignores a "{" inside either without shifting any offset --
// line numbers still point at the real source.
function blankStringsAndComments(source) {
  const out = source.split("")
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && source[j] !== c) j += source[j] === "\\" ? 2 : 1
      for (let k = i + 1; k < Math.min(j, n); k++) if (out[k] !== "\n") out[k] = " "
      i = j + 1
    } else if (source.startsWith("//", i)) {
      let j = source.indexOf("\n", i)
      if (j === -1) j = n
      for (let k = i; k < j; k++) out[k] = " "
      i = j
    } else if (source.startsWith("/*", i)) {
      let j = source.indexOf("*/", i + 2)
      j = j === -1 ? n : j + 2
      for (let k = i; k < j; k++) if (out[k] !== "\n") out[k] = " "
      i = j
    } else {
      i++
    }
  }
  return out.join("")
}

const lineOf = (s, offset) => s.slice(0, offset).split("\n").length

// [line, direct body] for each Text item; nested blocks are removed, so a
// child's textFormat cannot satisfy its parent's check.
function textItems(source) {
  const clean = blankStringsAndComments(source)
  const items = []
  for (const match of clean.matchAll(TEXT_OPEN)) {
    let depth = 1
    let i = match.index + match[0].length
    let body = ""
    while (i < clean.length && depth) {
      const c = clean[i]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (depth === 1) body += c
      i++
    }
    assert.equal(depth, 0, "unbalanced braces after line " + lineOf(clean, match.index))
    items.push([lineOf(clean, match.index), body])
  }
  return items
}

test("every Text item renders as plain text, never as markup", () => {
  let total = 0
  const missing = []
  for (const [name, source] of qmlSources()) {
    for (const [line, body] of textItems(source)) {
      total++
      if (!PLAIN.test(body)) missing.push(name + ":" + line)
    }
  }
  // Fails loudly rather than passing vacuously if the scrape breaks.
  assert.ok(total > 0, "no Text items found -- the scrape is broken")
  assert.deepEqual(missing, [], "Text items without textFormat: Text.PlainText")
})

test("the scrape sees an item's direct properties only", () => {
  // A nested item's textFormat must not satisfy its parent's check, and a
  // brace in a string must not end the item early.
  const source =
    'Text {\n' +
    '  text: "{ not a block"\n' +
    '  Item { textFormat: Text.PlainText }\n' +
    '}\n'
  const items = textItems(source)
  assert.equal(items.length, 1)
  assert.equal(items[0][0], 1)
  assert.ok(!PLAIN.test(items[0][1]))
})

test("the scrape matches a delegate Text", () => {
  const items = textItems("ListView {\n  delegate: Text {\n  }\n}\n")
  assert.equal(items.length, 1)
  assert.equal(items[0][0], 2)
})

test("the scrape ignores enum references and other Text* types", () => {
  assert.deepEqual(textItems("Item { elide: Text.ElideRight }"), [])
  assert.deepEqual(textItems("TextMetrics { text: \" \" }\nTextField {\n}\n"), [])
})
