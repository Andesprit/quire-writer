import assert from "node:assert/strict"
import { elsewhere, gatherProblems, problemLines } from "./preflight.ts"

const d = (path: string, line: number, message = "unknown variable foo") => ({ path, line, col: 2, end_line: line, end_col: 5, message, hints: [] })
const n = (path: string, line: number) => ({ kind: "ref" as const, key: "sec:nope", path, line, col: 0 })

assert.deepEqual(gatherProblems("main.typ", "main.typ", [], false, []), [], "clean")
assert.equal(gatherProblems("main.typ", "main.typ", [d("main.typ", 8)], false, []).length, 1, "error only")
assert.equal(gatherProblems("main.typ", "main.typ", [], false, [n("main.typ", 18)]).length, 1, "nowhere only")
const both = gatherProblems("main.typ", "main.typ", [d("main.typ", 8)], false, [n("main.typ", 18)])
assert.deepEqual(problemLines("main.typ", both), ["Line 9: unknown variable foo", "Line 19: Reference sec:nope points nowhere"], "both")
assert.match(problemLines("main.typ", gatherProblems("main.typ", "main.typ", [d("main.typ", 8)], true, []))[0], /possibly outdated/, "pending")
assert.equal(gatherProblems("main.typ", "main.typ", [d("main.typ", 8)], false, [n("notes.md", 1)]).length, 1, "nowhere in another file ignored")
assert.equal(problemLines("main.typ", gatherProblems("main.typ", "main.typ", [d("ch1.typ", 2)], false, []))[0], "ch1.typ, Line 3: unknown variable foo", "error in a pulled-in file")
assert.deepEqual(gatherProblems("notes.md", "main.typ", [d("main.typ", 8)], false, []), [], "errors of another main do not count")
assert.equal(gatherProblems("main.typ", "main.typ", [d("main.typ", 1), d("main.typ", 1, "second")], false, []).length, 1, "one per line")
assert.equal(problemLines("main.typ", Array.from({ length: 8 }, (_, i) => ({ path: "main.typ", line: i, col: 0, utf16: true, text: "x" }))).at(-1), "and 3 more", "capped at five")
assert.equal(elsewhere("main.typ", "main.typ", [n("main.typ", 1), n("ch1.typ", 2), n("a.tex", 3)]), 1, "other files of the same kind, counted")
assert.equal(elsewhere("main.typ", null, [n("ch1.typ", 2)]), 0, "not the compiled main")
assert.deepEqual(both.map((p) => p.utf16), [true, false], "compile errors count UTF-16, references characters")
console.log("preflight ok")

import { projectProblems, stepProblem } from "./preflight.ts"
const all = projectProblems([d("b.typ", 4), d("a.typ", 9), d("a.typ", 9, "dup")], false, [n("a.typ", 2), n("a.typ", 20)])
assert.deepEqual(all.map((p) => p.path + ":" + p.line), ["a.typ:2", "a.typ:9", "a.typ:20", "b.typ:4"], "ordered by file then line, one error per line")
assert.match(projectProblems([d("a.typ", 1)], true, [])[0].text, /possibly outdated/, "pending marks every row")
const at = (path: string, line: number, dir: 1 | -1) => { const r = stepProblem(all, { path, line }, dir)!; return r.problem.path + ":" + r.problem.line + (r.wrapped ? "!" : "") }
assert.equal(at("a.typ", 0, 1), "a.typ:2", "next from before the first")
assert.equal(at("a.typ", 2, 1), "a.typ:9", "next skips the caret's own line")
assert.equal(at("a.typ", 20, 1), "b.typ:4", "next crosses files")
assert.equal(at("b.typ", 4, 1), "a.typ:2!", "next wraps")
assert.equal(at("b.typ", 4, -1), "a.typ:20", "previous crosses files")
assert.equal(at("a.typ", 2, -1), "b.typ:4!", "previous wraps")
assert.equal(at("c.typ", 0, 1), "a.typ:2!", "a file with no problems after the last one wraps")
assert.equal(stepProblem([], { path: "a.typ", line: 0 }, 1), undefined, "nothing to step to")
