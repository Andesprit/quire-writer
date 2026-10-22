import type { Heading } from "./outline.ts"

// Lines that belong to the whole document, not to the section above them: they end it and stay
// where they are. LaTeX \end{document}, \appendix and bibliography commands; Typst #bibliography(.
const CLOSES = /^\s*(\\(end\{document\}|appendix\b|bibliography\{|printbibliography\b|begin\{thebibliography\})|#bibliography\()/

// Where a section ends: the line before the next heading of the same or a higher level.
function sectionEnd(heads: Heading[], i: number, total: number): number {
  for (let j = i + 1; j < heads.length; j++) if (heads[j].level <= heads[i].level) return heads[j].line
  return total
}

export type Move = {
  text: string
  line: number // 0-based line the moved heading now sits on
  at: number // the smallest change: text.slice(at, at + cut) becomes put
  cut: number
  put: string
}

// Move section `from` (an index into heads) with all its subsections so it sits just before
// heading `to`; to === heads.length means the end of the file. Lines are only reordered, so
// the length never changes and a missing final newline stays missing.
// "same" = nothing would move, "inside" = the target is inside the section itself.
export function moveSection(text: string, heads: Heading[], from: number, to: number): Move | "same" | "inside" {
  const finalNL = text.endsWith("\n")
  const lines = (finalNL ? text.slice(0, -1) : text).split("\n")
  const start = heads[from].line
  const stop = lines.findIndex((l, i) => i > start && CLOSES.test(l))
  const cap = stop < 0 ? lines.length : stop
  const end = Math.min(sectionEnd(heads, from, lines.length), cap)
  const dst = to >= heads.length ? cap : heads[to].line
  if (dst > start && dst < end) return "inside"
  if (dst === start || dst === end) return "same"
  const block = lines.slice(start, end)
  const rest = lines.slice(0, start).concat(lines.slice(end))
  const at = dst > end ? dst - block.length : dst
  const next = rest.slice(0, at).concat(block, rest.slice(at)).join("\n") + (finalNL ? "\n" : "")
  let a = 0
  while (a < text.length && text[a] === next[a]) a++
  let b = 0
  while (b < text.length - a && text[text.length - 1 - b] === next[next.length - 1 - b]) b++
  return { text: next, line: at, at: a, cut: text.length - a - b, put: next.slice(a, next.length - b) }
}
