import assert from "node:assert/strict"
import { refTrigger } from "./refcomplete.ts"

const t = (s: string, lang: any) => {
  const r = refTrigger(s, lang)
  return r && `${r.kind}:${r.prefix}:${s.slice(r.replaceFrom)}`
}
// Typst
assert.equal(t("see @ti", "typst"), "both:ti:ti")
assert.equal(t("@", "typst"), "both::")
assert.equal(t("see (@sec:a", "typst"), "both:sec:a:sec:a")
assert.equal(t("mail me@site.org", "typst"), null)
assert.equal(t("a@b", "typst"), null)
assert.equal(t("#cite(<kn", "typst"), "cite:kn:kn")
assert.equal(t("#ref(<", "typst"), "ref::")
assert.equal(t("see @ti // @ti", "typst"), null)
assert.equal(t("```\n@ti", "typst"), null)
assert.equal(t("```\nx\n```\n@ti", "typst"), "both:ti:ti")
assert.equal(t("/* \n@ti", "typst"), null)
assert.equal(t("/* x */\n@ti", "typst"), "both:ti:ti")
assert.equal(t("`@ti", "typst"), null)
assert.equal(t("$ x @ti", "typst"), null)
// LaTeX
assert.equal(t("\\ref{sec:st", "latex"), "ref:sec:st:sec:st")
assert.equal(t("\\cref{a,b", "latex"), "ref:b:b")
assert.equal(t("\\cite{a,kn", "latex"), "cite:kn:kn")
assert.equal(t("\\cite{a, kn", "latex"), "cite:kn:kn")
assert.equal(t("\\citep[p.~3]{kn", "latex"), "cite:kn:kn")
assert.equal(t("\\textcite{", "latex"), "cite::")
assert.equal(t("\\cite{a}", "latex"), null)
assert.equal(t("% \\ref{sec", "latex"), null)
assert.equal(t("50\\% \\ref{sec", "latex"), "ref:sec:sec")
assert.equal(t("\\begin{verbatim}\n\\ref{sec", "latex"), null)
assert.equal(t("\\label{sec", "latex"), null)
// Quarto and Markdown
assert.equal(t("[@kn", "quarto"), "both:kn:kn")
assert.equal(t("see @fig-", "quarto"), "both:fig-:fig-")
assert.equal(t("mail me@site.org", "quarto"), null)
assert.equal(t("```\n@fig-", "quarto"), null)
assert.equal(t("<!-- @fig-", "quarto"), null)
assert.equal(t("@fig-", "markdown"), null)
