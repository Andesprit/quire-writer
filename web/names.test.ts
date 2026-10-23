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

import { labelAt, labelProblem } from "./names.ts"

const others = ["sec:intro", "sec:introduction"]
assert.equal(labelProblem("sec:start", "sec:intro", "latex", others), "")
assert.equal(labelProblem("", "sec:intro", "typst", others), "Type a name.")
assert.match(labelProblem("sec:intro", "sec:intro", "typst", others), /already its name/)
assert.match(labelProblem("sec:introduction", "sec:intro", "typst", others), /already exists/)
assert.match(labelProblem("two words", "a", "typst", []), /not a valid/)
assert.match(labelProblem("a b", "a", "latex", []), /not a valid/)
assert.match(labelProblem("1-start", "sec-a", "quarto", []), /starting with a letter/)
assert.equal(labelProblem("1-start", "a", "typst", []), "", "Typst allows a leading digit")
assert.equal(labelAt("see @sec:intro, and", 8, others), "sec:intro")
assert.equal(labelAt("see @sec:intro.", 6, others), "sec:intro", "a final dot is not part of the name")
assert.equal(labelAt("\\cref{a,sec:intro}", 12, others), "sec:intro")
assert.equal(labelAt("plain words", 2, others), null)
assert.equal(labelAt("see @sec:introduction", 8, others), "sec:introduction", "the longer name wins")
