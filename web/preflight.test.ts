import assert from "node:assert/strict"
import { gatherProblems, problemLines } from "./preflight.ts"

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
assert.equal(problemLines("main.typ", Array.from({ length: 8 }, (_, i) => ({ path: "main.typ", line: i, col: 0, text: "x" }))).at(-1), "and 3 more", "capped at five")
console.log("preflight ok")
