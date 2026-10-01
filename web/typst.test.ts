// Self-check for the Typst tokenizer. Run: node web/typst.test.ts
import assert from "node:assert"
import { highlightHTML } from "./typst.ts"

const html = highlightHTML('#set page(a: "x")\n= Title\nSee @fig and $x^2$ <lbl>\n// note\n*bold* _it_ `raw`')
const lines = html.split("\n")
assert.equal(lines.length, 5, "one output line per input line")
assert.match(lines[0], /^<span class="tk-keyword">#set<\/span> page\(a: <span class="tk-string">"x"<\/span>\)$/)
assert.equal(lines[1], '<span class="tk-heading">= Title</span>')
assert.match(lines[2], /<span class="tk-label">@fig<\/span>.*<span class="tk-math">\$<\/span><span class="tk-math">x\^2<\/span><span class="tk-math">\$<\/span>.*<span class="tk-label">&lt;lbl&gt;<\/span>/)
assert.equal(lines[3], '<span class="tk-comment">// note</span>')
assert.match(lines[4], /tk-strong">\*bold\*.*tk-emphasis">_it_.*tk-raw">`raw`/)
// Text survives: stripping the tags gives back the source.
const src = "a < b & c\n#figure(x)"
assert.equal(highlightHTML(src).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), src)
console.log("ok")
