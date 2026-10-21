import assert from "node:assert/strict"
import { fuzzyMatch, rankFiles } from "./palette.ts"

const files = ["chapter/text.typ", "latex/main.tex", "context.typ", "tex/appendix.typ", "main.typ"]
assert.equal(rankFiles(files, "tex")[0].path, "latex/main.tex", "consecutive extension beats scattered letters")
assert.equal(rankFiles(files, "txt")[0].path, "chapter/text.typ", "name matches rank above folder-only matches")
assert.equal(rankFiles(files, "ltx/m")[0].path, "latex/main.tex", "path subsequences work")
assert.deepEqual(rankFiles(files, "TEX"), rankFiles(files, "tex"), "case does not affect ranking or positions")
assert.deepEqual(rankFiles(files, "", ["main.typ", "latex/main.tex", "deleted.typ"]).slice(0, 2).map((m) => m.path), ["main.typ", "latex/main.tex"], "empty query lists valid recent files first")
assert.deepEqual(rankFiles(files, "absent"), [])
assert.deepEqual(fuzzyMatch("Preview as Word", "prev")?.positions, [0, 1, 2, 3])
assert.deepEqual(fuzzyMatch("🍞/Résumé.typ", "Ré")?.positions, [3, 4], "indices refer to UTF-16 text")
assert.deepEqual(fuzzyMatch("x", "  "), { score: 0, positions: [] })
assert.equal(fuzzyMatch("abc", "acb"), null, "letters must occur in order")
assert.equal(rankFiles(["dir/abc.typ", "abc.typ"], "abc")[0].path, "abc.typ", "equal names fall back to stable path order")
console.log("palette: ok")
