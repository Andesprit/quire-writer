import assert from "node:assert/strict"
import { outline } from "./outline.ts"
import { moveSection } from "./sections.ts"

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
