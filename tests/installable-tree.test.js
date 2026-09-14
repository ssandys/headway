// tests/installable-tree.test.js
//
// Installing the plugin clones this repository into
// ~/.config/omarchy/plugins/<id>/, so every tracked file lands in a directory
// coding agents routinely operate in or below. A file named AGENTS.md (or a
// sibling) is discovered and applied there automatically, which hands whoever
// wrote it an instruction channel into the user's agent that the user never
// opted into -- regardless of whether the text happens to be benign.
//
// Raised in the marketplace security review of tonearm on 2026-09-14, where it
// blocked listing. Headway ships the same way, so it gets the same guard.
//
// git ls-files is the right question: it is exactly what a clone delivers. An
// untracked AGENTS.md in a local worktree is not published and is fine.
const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { join } = require("node:path")

const REPO = join(__dirname, "..")

const AGENT_INSTRUCTION_FILES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "conventions.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
])

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
}

test("no tracked file instructs a coding agent", () => {
  const offenders = trackedFiles().filter(p =>
    AGENT_INSTRUCTION_FILES.has(p.split("/").pop().toLowerCase()))
  assert.deepEqual(offenders, [],
    `These ship to ~/.config/omarchy/plugins/ and would be read as ` +
    `instructions by any coding agent working there: ${offenders.join(", ")}. ` +
    `Rename to a filename that carries no agent meaning.`)
})

test("the contributor guide survived the rename", () => {
  // Deleting the file would also satisfy the test above.
  assert.ok(trackedFiles().includes("CONTRIBUTING.md"))
})
