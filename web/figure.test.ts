import assert from "node:assert/strict"
import { figureSnippet, relativePath } from "./figure.ts"

assert.equal(relativePath("main.typ", "figures/a.png"), "figures/a.png")
assert.equal(relativePath("latex/main.tex", "figures/a.png"), "../figures/a.png")
assert.equal(relativePath("quarto/report.qmd", "quarto/img/a.png"), "img/a.png")
assert.equal(relativePath("a/b/c.typ", "a/figures/x.png"), "../figures/x.png")
assert.equal(relativePath("chapters/one.typ", "figures/a.png"), "../figures/a.png")

const typst = '#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n) <fig:name>'
const latex = "\\begin{figure}[ht]\n  \\includegraphics[width=0.8\\linewidth]{image.png}\n  \\label{fig:name}\n\\end{figure}"
assert.equal(figureSnippet(typst, "../figures/Results 2.png", "typst"), '#figure(\n  image("../figures/Results 2.png", width: 80%),\n  caption: [Caption],\n) <fig:results-2>')
assert.ok(figureSnippet(latex, "../figures/a.png", "latex").includes("{../figures/a.png}") && figureSnippet(latex, "x/a.png", "latex").includes("{fig:a}"))
assert.equal(figureSnippet("![Caption](image.png)", "figures/my pic.png", "markdown"), "![Caption](figures/my%20pic.png)")
assert.equal(figureSnippet("![Caption](image.png){#fig-name}", "figures/plot.png", "quarto"), "![Caption](figures/plot.png){#fig-plot}")
assert.ok(figureSnippet(typst, "figures/日本.png", "typst").endsWith("<fig:image>"))
console.log("figure ok")
