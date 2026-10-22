import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { headingTitle, outline } from "./outline.ts"

// Same rules as syntaxOf() in format.ts, which needs the DOM and cannot be imported here.
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
const titles = (t: string, lang: any, h: any) => outline(t, lang, h).map((x) => "=".repeat(x.level) + x.title)

assert.deepEqual(titles("= A\ntext\n== B\n#set page()\n#let x = 1\n=nospace", "typst", marked("=")), ["=A", "==B"])
assert.deepEqual(titles("= A\n```\n= fake\n```\n/* \n= hidden\n*/\n// = line\n/* one */\n== B", "typst", marked("=")), ["=A", "==B"])
assert.deepEqual(titles("# A\n```py\n# comment\n```\n~~~\n# x\n~~~\n<!--\n# no\n-->\n## B", "markdown", marked("#")), ["=A", "==B"])
assert.deepEqual(titles("\\section{A}\n% \\section{x}\n\\begin{verbatim}\n\\section{y}\n\\end{verbatim}\n\\subsection*{B}\n\\textbf{z}", "latex", tex), ["=A", "==B"])
assert.equal(outline("# \n#  \n# T", "markdown", marked("#")).length, 1, "empty titles are skipped")
assert.equal(outline("a\n# T", "markdown", marked("#"))[0].line, 1)

// Display titles: no label tail, nested braces kept.
assert.equal(headingTitle("latex", "Starter}\\label{sec:starter"), "Starter")
assert.equal(headingTitle("latex", "Using \\emph{x} well}\\label{a"), "Using \\emph{x} well")
assert.equal(headingTitle("latex", "Plain"), "Plain")
assert.equal(headingTitle("latex", "Braces \\{ ok}"), "Braces \\{ ok")
assert.equal(headingTitle("typst", "Fermentation <sec:ferm>"), "Fermentation")
assert.equal(headingTitle("quarto", "Methods {#sec-methods}"), "Methods")
assert.equal(headingTitle("markdown", "Plain # title"), "Plain # title")

// The Text menu rewrites a heading line as heading(headingOf(line)[1], level) (format.ts setHeading).
// headingOf must keep the label tail so changing a level never drops it.
const fmt = readFileSync(new URL("./format.ts", import.meta.url), "utf8")
assert.ok(fmt.includes("const m = /^\\\\(\\w+)\\*?\\{(.*)\\}\\s*$/.exec(l)"), "LaTeX headingOf must stay greedy")
const retitle = (l: string, level: number) => `\\${SECTIONS[level - 1]}{${tex(l)![1]}}`
assert.equal(retitle("\\section{Starter}\\label{sec:starter}", 2), "\\subsection{Starter}\\label{sec:starter}", "label survives a level change")

// Real sample files, when run from a checkout that has them.
const sample = (p: string) => readFileSync(new URL(`../sample/${p}`, import.meta.url), "utf8")
console.log("sample headings:",
  JSON.stringify([["main.typ", "typst", "="], ["markdown/notes.md", "markdown", "#"]].map(([p, lang, m]) => [p, titles(sample(p), lang, marked(m))])),
  JSON.stringify(titles(sample("latex/main.tex"), "latex", tex)))

// Timing on 5,000 lines.
const big = Array.from({ length: 5000 }, (_, i) => (i % 25 === 0 ? `== Section ${i}` : i % 97 === 0 ? "```\n= x\n```" : `line ${i} with words`)).join("\n")
const t0 = performance.now()
const n = outline(big, "typst", marked("=")).length
const ms = performance.now() - t0
console.log(`5000 lines: ${n} headings in ${ms.toFixed(2)} ms`)
assert.ok(ms < 50)
console.log("outline: ok")
