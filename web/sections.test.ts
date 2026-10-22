import assert from "node:assert/strict"
import { outline } from "./outline.ts"
import { moveSection, shiftSection } from "./sections.ts"

const marked = (mark: string) => (l: string): [number, string] | null => {
  const m = new RegExp(`^(\\${mark}+)\\s+(.*)`).exec(l)
  return m ? [m[1].length, m[2]] : null
}
const SECTIONS = ["section", "subsection", "subsubsection", "paragraph"]
const tex = (l: string): [number, string] | null => {
  const m = /^\\(\w+)\*?\{(.*)\}\s*$/.exec(l)
  const level = m ? SECTIONS.indexOf(m[1]) + 1 : 0
  return level ? [level, m![2]] : null
}
const sorted = (t: string) => t.split("\n").sort().join("\n")
function mv(text: string, lang: any, h: any, from: number, to: number) {
  const heads = outline(text, lang, h)
  const r = moveSection(text, heads, from, to)
  if (typeof r === "string") return r
  assert.equal(r.text.length, text.length, "length unchanged")
  assert.equal(sorted(r.text), sorted(text), "same lines")
  assert.equal(r.text.endsWith("\n"), text.endsWith("\n"), "final newline kept")
  assert.equal(text.slice(0, r.at) + r.put + text.slice(r.at + r.cut), r.text, "range reproduces the text")
  assert.ok(r.at + r.cut <= text.length)
  assert.equal(r.text.split("\n")[r.line], text.split("\n")[heads[from].line], "caret line is the moved heading")
  return r.text
}
const T = (t: string) => outline(t, "typst", marked("="))

// Typst: a section with a subsection moves down, then up.
const ty = "= A\na\n== A1\na1\n= B\nb\n= C\nc\n"
assert.equal(mv(ty, "typst", marked("="), 0, 3), "= B\nb\n= A\na\n== A1\na1\n= C\nc\n")
assert.equal(mv(ty, "typst", marked("="), 0, 4), "= B\nb\n= C\nc\n= A\na\n== A1\na1\n")
assert.equal(mv(ty, "typst", marked("="), 3, 0), "= C\nc\n= A\na\n== A1\na1\n= B\nb\n")
assert.equal(mv(ty, "typst", marked("="), 1, 3), "= A\na\n= B\nb\n== A1\na1\n= C\nc\n", "a subsection moves alone")
assert.equal(mv(ty, "typst", marked("="), 0, 1), "inside")
assert.equal(mv(ty, "typst", marked("="), 0, 0), "same")
assert.equal(mv(ty, "typst", marked("="), 1, 2), "same", "dropping a section where it already ends")

// The last section has no trailing newline: nothing is added or lost.
const nonl = "= A\na\n= B\nb"
assert.equal(mv(nonl, "typst", marked("="), 1, 0), "= B\nb\n= A\na")
assert.equal(mv(nonl, "typst", marked("="), 0, 2), "= B\nb\n= A\na")

// Text before the first heading stays put.
assert.equal(mv("#set page()\n\n= A\na\n= B\nb\n", "typst", marked("="), 1, 0), "#set page()\n\n= B\nb\n= A\na\n")

// LaTeX: preamble stays, the \label on the next line travels with its section.
const lx = "\\documentclass{article}\n\\begin{document}\n\\section{A}\n\\label{a}\nx\n\\subsection{A1}\ny\n\\section{B}\n\\label{b}\nz\n\\end{document}\n"
const lxh = outline(lx, "latex", tex)
assert.deepEqual(lxh.map((h) => h.line), [2, 5, 7])
const lxm = moveSection(lx, lxh, 2, 0)
assert.ok(typeof lxm !== "string")
assert.ok((lxm as any).text.endsWith("\\label{a}\nx\n\\subsection{A1}\ny\n\\end{document}\n"), "\\end{document} stays last")
assert.equal(mv(lx, "latex", tex, 0, 3), mv(lx, "latex", tex, 0, 3))
assert.ok((mv(lx, "latex", tex, 0, 3) as string).endsWith("\\label{a}\nx\n\\subsection{A1}\ny\n\\end{document}\n"), "moving to the end lands before \\end{document}")

// Bibliography and appendix lines close a section and stay put, in LaTeX and Typst.
for (const tail of ["\\appendix\n", "\\bibliography{refs}\n", "\\printbibliography\n", "\\begin{thebibliography}{9}\n\\end{thebibliography}\n"]) {
  const d = `\\section{A}\na\n\\section{B}\nb\n${tail}\\end{document}\n`
  assert.equal(mv(d, "latex", tex, 0, 2), `\\section{B}\nb\n\\section{A}\na\n${tail}\\end{document}\n`, tail)
  assert.equal(mv(d, "latex", tex, 1, 0), `\\section{B}\nb\n\\section{A}\na\n${tail}\\end{document}\n`, tail)
}
assert.equal(mv("= A\na\n= B\nb\n#bibliography(\"r.bib\")\n", "typst", marked("="), 0, 2), "= B\nb\n= A\na\n#bibliography(\"r.bib\")\n")

// Markdown: a '#' inside a fence is not a heading and is carried along as body text.
const md = "# A\n```\n# fake\n```\n## A1\ntext\n# B\nb\n"
assert.equal(outline(md, "markdown", marked("#")).length, 3)
assert.equal(mv(md, "markdown", marked("#"), 0, 3), "# B\nb\n# A\n```\n# fake\n```\n## A1\ntext\n")

// Markdown/Quarto front matter: does outline() read a YAML comment as a heading?
const fm = "---\ntitle: T\n# yaml comment\n---\n# A\na\n# B\nb\n"
assert.deepEqual(outline(fm, "markdown", marked("#")).map((h) => h.title), ["A", "B"], "YAML comment is not a heading")
assert.deepEqual(outline(fm, "quarto", marked("#")).map((h) => h.title), ["A", "B"])

// CRLF: lines keep their \r, so a moved block keeps its endings.
assert.equal(mv("= A\r\na\r\n= B\r\nb\r\n", "typst", marked("="), 1, 0), "= B\r\nb\r\n= A\r\na\r\n")

// Round trip: moving there and back restores the text; every legal move preserves lines.
const mix = "= A\na\n== A1\na1\n=== A1x\nq\n== A2\nr\n= B\nb\n= C\nc"
const heads = T(mix)
let legal = 0
for (let f = 0; f < heads.length; f++) for (let t = 0; t <= heads.length; t++) {
  const r = mv(mix, "typst", marked("="), f, t)
  if (typeof r === "string" && (r === "same" || r === "inside")) continue
  legal++
}
assert.ok(legal > 10)

// Timing on 5,000 lines.
const big = Array.from({ length: 5000 }, (_, i) => (i % 25 === 0 ? `== Section ${i}` : `line ${i} with words`)).join("\n")
const bh = outline(big, "typst", marked("="))
const t0 = performance.now()
const r = moveSection(big, bh, 150, 3)
console.log(`5000 lines: moveSection in ${(performance.now() - t0).toFixed(2)} ms`)
assert.ok(typeof r !== "string" && r.text.length === big.length)
console.log("sections: ok")

// Promote and demote: only marker characters change, the subtree follows, one range reproduces it.
const TEXH = (l: string): [number, string] | null => {
  const m = /^\\(\w+)\*?\{(.*)\}\s*$/.exec(l)
  const level = m ? SECTIONS.indexOf(m[1]) + 1 : 0
  return level ? [level, m![2]] : null
}
function sh(text: string, lang: any, h: any, i: number, d: -1 | 1) {
  const heads = outline(text, lang, h)
  const r = shiftSection(text, heads, i, d, lang)
  if (typeof r === "string") return r
  assert.equal(text.slice(0, r.at) + r.put + text.slice(r.at + r.cut), r.text, "range reproduces the text")
  assert.equal(r.text.split("\n").length, text.split("\n").length, "same line count")
  const strip = (t: string) => t.replace(/^(\\\w+|[=#]+)/gm, "")
  assert.equal(strip(r.text), strip(text), "only markers change")
  return r.text
}
const tyh = "= A\n== B <b>\ntext\n=== C\n== D\n= E\n"
assert.equal(sh(tyh, "typst", marked("="), 1, -1), "= A\n= B <b>\ntext\n== C\n== D\n= E\n", "typst promote moves the subtree, keeps the label")
assert.equal(sh(tyh, "typst", marked("="), 1, 1), "= A\n=== B <b>\ntext\n==== C\n== D\n= E\n")
assert.equal(sh(tyh, "typst", marked("="), 0, -1), "top", "a level-1 heading cannot go up")
assert.equal(sh("= A\n" + "=".repeat(6) + " Deep\n", "typst", marked("="), 0, 1), "bottom", "a descendant at the bottom level blocks the demote")
assert.equal(sh("= A\n== B\n= C\n", "typst", marked("="), 0, 1), "= A\n== B\n= C\n".replace("= A", "== A").replace("== B", "=== B"))
const ltx = "\\section{S}\n\\subsection*{Sub}\\label{x}\n\\subsubsection{Deep}\n\\section{T}\n\\end{document}\n"
assert.equal(sh(ltx, "latex", TEXH, 0, 1), "\\subsection{S}\n\\subsubsection*{Sub}\\label{x}\n\\paragraph{Deep}\n\\section{T}\n\\end{document}\n", "latex: star and label kept")
assert.equal(sh(ltx, "latex", TEXH, 1, -1), "\\section{S}\n\\section*{Sub}\\label{x}\n\\subsection{Deep}\n\\section{T}\n\\end{document}\n")
assert.equal(sh(ltx, "latex", TEXH, 0, -1), "top", "no level above \\section in the outline")
assert.equal(sh("\\section{S}\n\\paragraph{P}\n", "latex", TEXH, 0, 1), "bottom", "\\paragraph cannot be demoted")
const qmd = "# A {#sec-a}\n## B\n```\n# not a heading\n```\n### C\n# D\n"
assert.equal(sh(qmd, "quarto", marked("#"), 0, 1), "## A {#sec-a}\n### B\n```\n# not a heading\n```\n#### C\n# D\n", "markdown: code fence untouched, attribute kept")
assert.equal(sh("Title\n=====\n\n## B\n", "markdown", marked("#"), 0, -1), "Title\n=====\n\n# B\n", "setext is not in the outline and is left alone")
// A heading line that does not start with the plain marker is refused, nothing is edited.
assert.equal(shiftSection("  ## A\n", [{ level: 2, title: "A", line: 0 }], 0, -1, "markdown"), "unsupported")
// Promoting a section does not carry its later siblings: they become its children (D below).
assert.equal(sh("= A\n== B\n=== C\n== D\n", "typst", marked("="), 1, -1), "= A\n= B\n== C\n== D\n")
console.log("sections shift ok")
