import assert from "node:assert/strict"
import { diagnosticRange, errorCount, isCurrentDiagnostic, type Diagnostic } from "./diagnostics.ts"

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
console.log("diagnostics: ok")
