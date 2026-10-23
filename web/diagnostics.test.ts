import assert from "node:assert/strict"
import { minimalChange } from "./merge.ts"
import { readFileSync } from "node:fs"
import { missingTool, diagnosticRange, errorCount, isCurrentDiagnostic, shiftDiagnostics, type Diagnostic } from "./diagnostics.ts"

const error: Diagnostic = { path: "main.typ", line: 1, col: 9, end_line: 1, end_col: 12, message: "unknown variable: foo", hints: [] }
const text = "Heading\n🍞 café #foo()\n"
const range = diagnosticRange(text, error)!
assert.equal(text.slice(range.from, range.to), "foo", "UTF-16 columns preserve Unicode before the error")
assert.equal(diagnosticRange(text, { ...error, line: 20, end_line: 20 }), null, "never underline a different line when a location is stale")
const eof = diagnosticRange("#let x = (", { ...error, line: 0, col: 10, end_line: 0, end_col: 10 })!
assert.equal("#let x = (".slice(eof.from, eof.to), "(", "a zero-width error at EOF still has a visible mark")
const wholeLine = diagnosticRange("a\n\\unknown\nb", { ...error, line: 1, col: 0, end_line: 1, end_col: Number.MAX_SAFE_INTEGER })!
assert.equal("a\n\\unknown\nb".slice(wholeLine.from, wholeLine.to), "\\unknown")
assert.equal(errorCount([error, { ...error, col: 3 }, { ...error, path: "chapter.typ" }]), 2, "collapse follow-on errors on each line")
const batch = { root: "/project", main: "main.typ", generation: 4, diagnostics: [error] }
assert(isCurrentDiagnostic(batch, "/project", "main.typ", 4, "main.typ", text))
assert(!isCurrentDiagnostic(batch, "/project", "main.typ", 5, "main.typ", text), "a result already on its way cannot mark newly typed text")
assert(!isCurrentDiagnostic(batch, "/other", "main.typ", 4, "main.typ", text))
assert(!isCurrentDiagnostic(batch, "/project", "other.typ", 4, "main.typ", text))
assert(!isCurrentDiagnostic({ ...batch, sources: { "main.typ": "older saved text" } }, "/project", "main.typ", 4, "main.typ", text), "LaTeX builds of older disk text cannot mark unsaved text")
const word = (t: string, d: Diagnostic) => { const r = diagnosticRange(t, d)!; return t.slice(r.from, r.to) }
const typed = (t: string, at: number, ins: string) => t.slice(0, at) + ins + t.slice(at)
const shift = (a: string, b: string, p: string | null, e: Diagnostic[]) => shiftDiagnostics(a, minimalChange(a, b), p, e)
const same = shift(text, typed(text, 11, "xyz"), "main.typ", [error])
assert.equal(same.length, 1); assert.equal(same[0].col, 9 + 3, "typing before the error on its line moves its column")
assert.equal(word(typed(text, 11, "xyz"), same[0]), "foo")
const above = shift(text, typed(text, 3, "\nab\n"), "main.typ", [error])
assert.equal(above[0].line, 3, "newlines above move the error down")
assert.equal(word(typed(text, 3, "\nab\n"), above[0]), "foo")
assert.equal(shift(text, typed(text, 20, "x"), "main.typ", [error])[0].col, 9, "typing after the error leaves it")
assert.equal(shift(text, text.slice(0, 15) + text.slice(19), "main.typ", [error]).length, 0, "a deletion spanning the error drops it")
assert.equal(shift(text, typed(text, 18, "x"), "main.typ", [error]).length, 0, "an edit inside the error drops it")
const emoji = "🍞🍞\n#foo"
assert.equal(word(typed(emoji, 0, "é"), shift(emoji, typed(emoji, 0, "é"), "main.typ", [{ ...error, line: 1, col: 1, end_line: 1, end_col: 4 }])[0]), "foo")
assert.deepEqual(shift(text, typed(text, 0, "x"), "main.typ", [{ ...error, path: "other.typ" }]), [{ ...error, path: "other.typ" }], "other files are untouched")
const backend = readFileSync(new URL("../src-tauri/src/project.rs", import.meta.url), "utf8")
for (const said of ["LaTeX preview needs TeX. Install", "Quarto preview needs Quarto: quarto.org"])
  assert(backend.includes(`"${said}`), `project.rs still says "${said}"`)
assert.equal(missingTool("LaTeX preview needs TeX. Install Tectonic or your system's TeX.\nmore"), "LaTeX preview needs TeX. Install Tectonic or your system's TeX.")
assert(missingTool("Quarto preview needs Quarto: quarto.org/docs/get-started"))
assert.equal(missingTool("! Undefined control sequence."), "", "an ordinary LaTeX error is not a missing tool")
console.log("diagnostics: ok")
