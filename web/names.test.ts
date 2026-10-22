import assert from "node:assert/strict"
import { nameProblem } from "./names.ts"

const taken = ["main.typ", "notes.md", "chapters", "chapters/one.typ"]
assert.equal(nameProblem("fresh.typ", "fresh.typ", taken), "")
assert.match(nameProblem("notes.md", "notes.md", taken), /already exists/)
assert.match(nameProblem("NOTES.md", "NOTES.md", taken), /already exists/, "macOS names clash regardless of case")
assert.match(nameProblem("one.typ", "chapters/one.typ", taken), /named "one.typ"/)
assert.equal(nameProblem("one.typ", "chapters/one.typ", taken, "chapters/one.typ"), "", "renaming to itself is fine")
assert.equal(nameProblem("Main.typ", "Main.typ", taken, "main.typ"), "", "case-only rename is allowed")
assert.equal(nameProblem("", "", taken), "Type a name.")
assert.match(nameProblem("..", "..", taken), /not a valid/)
assert.match(nameProblem("a/../b", "a/../b", taken), /not a valid/)
assert.match(nameProblem("a//b", "a//b", taken), /not a valid/)
assert.match(nameProblem("a:b", "a:b", taken), /":"/)
