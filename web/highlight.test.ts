// Self-check for the tokenizers. Run: node web/highlight.test.ts
import assert from "node:assert"
import { highlightHTML, langOf, type Lang } from "./highlight.ts"

const html = highlightHTML('#set page(a: "x")\n= Title\nSee @fig and $x^2$ <lbl>\n// note\n*bold* _it_ `raw`', "typst")
const lines = html.split("\n")
assert.equal(lines.length, 5, "one output line per input line")
assert.match(lines[0], /^<span class="tk-keyword">#set<\/span> page\(a: <span class="tk-string">"x"<\/span>\)$/)
assert.equal(lines[1], '<span class="tk-heading">= Title</span>')
assert.match(lines[2], /<span class="tk-label">@fig<\/span>.*<span class="tk-math">\$<\/span><span class="tk-math">x\^2<\/span><span class="tk-math">\$<\/span>.*<span class="tk-label">&lt;lbl&gt;<\/span>/)
assert.equal(lines[3], '<span class="tk-comment">// note</span>')
assert.match(lines[4], /tk-strong">\*bold\*.*tk-emphasis">_it_.*tk-raw">`raw`/)

// LaTeX: commands, headings, labels, comments (not \%), and math that spans lines.
const tex = highlightHTML("\\section{Intro}\\label{sec:a}\n50\\% done % note\n\\begin{equation}\na_1\n\\end{equation} \\textbf{b}", "latex").split("\n")
assert.equal(tex[0], '<span class="tk-heading">\\section{Intro}</span><span class="tk-label">\\label{sec:a}</span>')
assert.equal(tex[1], '50<span class="tk-func">\\%</span> done <span class="tk-comment">% note</span>')
assert.equal(tex[3], '<span class="tk-math">a_1</span>')
assert.match(tex[4], /tk-math">\\end\{equation\}<\/span>.*tk-strong">\\textbf\{b\}/)

// Markdown and Quarto: front matter, a code block whose # is not a heading, labels, and
// underscores inside words that are not emphasis.
const md = highlightHTML("---\ntitle: X\n---\n# Head {#sec-a}\n```{r}\n# not a heading\n```\nsee @sec-a, [@key] and snake_case_name $x$", "quarto").split("\n")
assert.equal(md[1], '<span class="tk-keyword">title:</span><span class="tk-string"> X</span>')
assert.equal(md[3], '<span class="tk-heading"># Head {#sec-a}</span>')
assert.equal(md[5], '<span class="tk-raw"># not a heading</span>')
assert.match(md[7], /tk-label">@sec-a<\/span>.*tk-label">\[@key\]<\/span> and snake_case_name <span class="tk-math">\$x\$/)
// A rule further down is not front matter.
assert.doesNotMatch(highlightHTML("text\n---\nmore", "markdown"), /tk-raw/)

assert.deepEqual(["a.typ", "b.tex", "c.qmd", "d.md", "e.bib"].map(langOf), ["typst", "latex", "quarto", "markdown", "text"])

// Text survives in every language: stripping the tags gives back the source.
const src = "a < b & c\n#figure(x) \\cite{k} **b** $x$\n---\n```\nz\n```"
for (const lang of ["typst", "latex", "markdown", "text"] as Lang[]) {
  assert.equal(highlightHTML(src, lang).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), src, lang)
}
// Typst: escapes, * and _ inside words, block comments. Markdown: comments over several lines.
const t = highlightHTML("a \\$ b\nsnake_case_name\n/* one\ntwo */ after", "typst").split("\n")
assert.ok(!t[0].includes("tk-math"), "\\$ is a dollar sign, not math")
assert.ok(!t[1].includes("tk-emphasis"), "_ inside a word is not emphasis")
assert.equal(t[2], '<span class="tk-comment">/* one</span>')
assert.equal(t[3], '<span class="tk-comment">two */</span> after')
const m = highlightHTML("<!-- one\ntwo -->\ntext", "markdown").split("\n")
assert.equal(m[1], '<span class="tk-comment">two --&gt;</span>')
assert.equal(m[2], "text")
console.log("ok")
