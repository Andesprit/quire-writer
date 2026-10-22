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

const TEX_LEVELS = ["section", "subsection", "subsubsection", "paragraph"]
// A LaTeX heading line: \section{T}, \section*{T}, \section[Short]{T}. The title keeps the rest of the line.
export function texHeadingOf(l: string): [number, string] | null {
  const m = /^\\(\w+)\*?(?:\[[^\]]*\])?\{(.*)\}\s*$/.exec(l)
  const level = m ? TEX_LEVELS.indexOf(m[1]) + 1 : 0
  return level ? [level, m![2]] : null
}
// The same line at another level: only the command name changes, so the star and [Short] stay.
export const texRelevel = (l: string, level: number) => l.replace(/^\\\w+/, "\\" + TEX_LEVELS[level - 1])
const MAX_LEVEL = { typst: 6, markdown: 6, quarto: 6, latex: TEX_LEVELS.length } as const

// Promote (delta -1) or demote (+1) section `index` and every heading inside it by one level.
// Only the marker at the start of each heading line changes: the = or # run, or the LaTeX command
// name (its star, [short title], {title} and \label stay). "top" / "bottom" = some heading in the
// subtree would leave the levels the language has; "unsupported" = a heading line whose marker is
// not the plain form (nothing is edited then). A change is the smallest range, like Move.
export type Shift = { text: string; line: number; at: number; cut: number; put: string }
export function shiftSection(
  text: string,
  heads: Heading[],
  index: number,
  delta: -1 | 1,
  lang: keyof typeof MAX_LEVEL,
): Shift | "top" | "bottom" | "unsupported" {
  const lines = text.split("\n")
  const stop = lines.findIndex((l, i) => i > heads[index].line && CLOSES.test(l))
  const end = Math.min(sectionEnd(heads, index, lines.length), stop < 0 ? lines.length : stop)
  const inside = heads.filter((h) => h.line >= heads[index].line && h.line < end)
  for (const h of inside) {
    if (h.level + delta < 1) return "top"
    if (h.level + delta > MAX_LEVEL[lang]) return "bottom"
  }
  const next = lines.slice()
  for (const h of inside) {
    const l = lines[h.line]
    const to = h.level + delta
    const m = lang === "latex" ? /^\\(\w+)/.exec(l) : /^[=#]+(?=\s)/.exec(l)
    if (!m || (lang === "latex" && TEX_LEVELS[h.level - 1] !== m[1])) return "unsupported"
    const mark = lang === "latex" ? "\\" + TEX_LEVELS[to - 1] : (lang === "typst" ? "=" : "#").repeat(to)
    next[h.line] = mark + l.slice(m[0].length)
  }
  const out = next.join("\n")
  let a = 0
  while (a < text.length && text[a] === out[a]) a++
  let b = 0
  while (b < Math.min(text.length, out.length) - a && text[text.length - 1 - b] === out[out.length - 1 - b]) b++
  return { text: out, line: heads[index].line, at: a, cut: text.length - a - b, put: out.slice(a, out.length - b) }
}
