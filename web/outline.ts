import type { Lang } from "./highlight.ts"

export type Heading = { level: number; title: string; line: number } // line: 0-based

type HeadingOf = (line: string) => [number, string] | null

// Lines that open and close text where a heading mark means nothing: fenced code, block
// comments, and for LaTeX the verbatim-like environments.
const FENCE = /^\s*(```|~~~)/
const TEX_RAW = /^\s*\\begin\{(verbatim\*?|lstlisting|minted|comment)\}/
const TEX_RAW_END = /^\s*\\end\{(verbatim\*?|lstlisting|minted|comment)\}/

export function outline(text: string, lang: Lang, headingOf: HeadingOf): Heading[] {
  const out: Heading[] = []
  let fence = "" // closing marker of the raw block we are inside, "" when outside
  let block = false // inside /* */ (Typst) or <!-- --> (Markdown)
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (fence) {
      if (lang === "latex" ? TEX_RAW_END.test(l) : l.trimStart().startsWith(fence)) fence = ""
      continue
    }
    if (block) {
      if (l.includes(lang === "typst" ? "*/" : "-->")) block = false
      continue
    }
    if (lang === "latex") {
      if (TEX_RAW.test(l)) fence = "x"
    } else {
      const f = FENCE.exec(l)
      if (f) {
        fence = f[1]
        continue
      }
      const open = lang === "typst" ? "/*" : "<!--"
      const close = lang === "typst" ? "*/" : "-->"
      const at = l.indexOf(open)
      if (at === 0 || (at > 0 && !l.slice(0, at).trim())) {
        if (!l.includes(close, at + open.length)) block = true
        continue
      }
    }
    if (lang === "typst" && l.startsWith("//")) continue
    const h = headingOf(l)
    if (h && h[1].trim()) out.push({ level: h[0], title: h[1].trim(), line: i })
  }
  return out
}
