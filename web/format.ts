// The formatting bar and its shortcuts: markup for the open file's language, written into the
// text field around the selection or at the caret.
import type { Lang } from "./highlight"
import { $, icon } from "./ui"

const ta = $<HTMLTextAreaElement>("text")

// The editor's edit (it keeps undo, and the caret where agent changes land) and the box that
// cites by DOI. main.ts connects both at start.
let edit: (from: number, to: number, text: string) => void
let openCite: () => void
export function connectEditor(editor: typeof edit, cite: () => void) {
  edit = editor
  openCite = cite
}

const WORD = /[\p{L}\p{N}'’-]/u

// The selection, or the word under the caret when nothing is selected.
function target(): [number, number] {
  let from = ta.selectionStart
  let to = ta.selectionEnd
  if (from === to) {
    const t = ta.value
    while (from > 0 && WORD.test(t[from - 1])) from--
    while (to < t.length && WORD.test(t[to])) to++
  }
  return [from, to]
}

const hasSelection = () => ta.selectionEnd > ta.selectionStart

export function select(from: number, to: number) {
  ta.setSelectionRange(from, to)
  ta.focus()
}

// Wrap the target in markup, or unwrap it when it is already wrapped.
function wrap(open: string, close: string, placeholder: string) {
  const t = ta.value
  const [from, to] = target()
  const inner = t.slice(from, to)
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    const bare = inner.slice(open.length, inner.length - close.length)
    edit(from, to, bare)
    return select(from, from + bare.length)
  }
  if (t.slice(from - open.length, from) === open && t.slice(to, to + close.length) === close) {
    edit(from - open.length, to + close.length, inner)
    return select(from - open.length, to - open.length)
  }
  const text = inner || placeholder
  edit(from, to, open + text + close)
  select(from + open.length, from + open.length + text.length)
}

// The whole lines the selection touches.
function lines(): [number, number] {
  const t = ta.value
  const end = ta.selectionEnd > ta.selectionStart && t[ta.selectionEnd - 1] === "\n" ? ta.selectionEnd - 1 : ta.selectionEnd
  const from = t.lastIndexOf("\n", ta.selectionStart - 1) + 1
  const nl = t.indexOf("\n", end)
  return [from, nl < 0 ? t.length : nl]
}

function mapLines(fn: (ls: string[]) => string[]) {
  const [from, to] = lines()
  const out = fn(ta.value.slice(from, to).split("\n")).join("\n")
  edit(from, to, out)
  select(from + out.length, from + out.length)
}

export function setHeading(sx: Syntax, level: number) {
  mapLines((ls) => {
    const lvl = ls.every((l) => sx.headingOf(l)?.[0] === level) ? 0 : level
    return ls.map((l) => sx.heading(sx.headingOf(l)?.[1] ?? l, lvl))
  })
}

function toggleLinePrefix(prefix: string, others: RegExp) {
  mapLines((ls) => {
    const filled = ls.filter((l) => l.trim())
    const on = filled.length > 0 && filled.every((l) => l.trimStart().startsWith(prefix))
    return ls.map((l) => {
      if (!l.trim()) return l
      const indent = l.match(/^\s*/)![0]
      const body = l.slice(indent.length)
      return on ? indent + body.slice(prefix.length) : indent + prefix + body.replace(others, "")
    })
  })
}

// Insert markup after the word at the caret and select the part the writer should replace.
export function insertAt(text: string, pick: string, spaced = true) {
  const t = ta.value
  let pos = ta.selectionEnd
  while (pos < t.length && WORD.test(t[pos])) pos++
  const space = spaced && pos > 0 && !/\s/.test(t[pos - 1]) ? " " : ""
  edit(pos, pos, space + text)
  const i = pos + space.length + text.indexOf(pick)
  select(i, i + pick.length)
}

// Insert a block on its own lines, after the current line.
function insertBlock(block: string, pick: string) {
  const t = ta.value
  const nl = t.indexOf("\n", ta.selectionEnd)
  const end = nl < 0 ? t.length : nl
  const lineStart = t.lastIndexOf("\n", end - 1) + 1
  const text = (t.slice(lineStart, end).trim() ? "\n\n" : "") + block
  edit(end, end, text)
  const i = end + text.indexOf(pick)
  select(i, i + pick.length)
}

function link(sx: Syntax) {
  const [from, to] = target()
  const text = sx.link(ta.value.slice(from, to) || "link text")
  edit(from, to, text)
  const i = from + text.indexOf("https://")
  select(i, i + 8)
}

// Comment out (or back in) the lines with <!-- -->, which Markdown has instead of line comments.
function htmlComment() {
  const [from, to] = lines()
  const text = ta.value.slice(from, to)
  const out = /^<!-- ([\s\S]*) -->$/.exec(text)?.[1] ?? `<!-- ${text} -->`
  edit(from, to, out)
  select(from + out.length, from + out.length)
}

// LaTeX lists are environments: wrap the lines in one, or unwrap them.
const texList = (env: string) => () =>
  mapLines((ls) =>
    ls[0].trim() === `\\begin{${env}}` && ls.at(-1)!.trim() === `\\end{${env}}`
      ? ls.slice(1, -1).map((l) => l.replace(/^\s*\\item\s?/, ""))
      : [`\\begin{${env}}`, ...ls.map((l) => `  \\item ${l.trim()}`), `\\end{${env}}`],
  )

// Headings marked with a run of = or #, one per level.
const marked = (mark: string) => ({
  headingOf: (l: string): [number, string] | null => {
    const m = new RegExp(`^(\\${mark}+)\\s+(.*)`).exec(l)
    return m ? [m[1].length, m[2]] : null
  },
  heading: (title: string, level: number) => (level ? `${mark.repeat(level)} ${title}` : title),
})
const SECTIONS = ["section", "subsection", "subsubsection", "paragraph"]

// What each button writes. "key", "name", "image.png" and "Header" are selected for the writer
// to replace.
export type Syntax = {
  bold: [string, string]
  italic: [string, string]
  code: [string, string]
  math: [string, string]
  mathBlock: string
  bullet: () => void
  numbered: () => void
  quote: () => void
  comment: () => void
  link: (text: string) => string
  cite: string
  label: string | null
  footnote: [string, string]
  figure: string
  table: string
  headingOf: (line: string) => [number, string] | null // level and title
  heading: (title: string, level: number) => string // level 0: plain text
}

const MD_TABLE = "| Header | Header |\n|--------|--------|\n| Cell   | Cell   |"
const MARKDOWN: Syntax = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  code: ["`", "`"],
  math: ["$", "$"],
  mathBlock: "$$\nx\n$$",
  bullet: () => toggleLinePrefix("- ", /^(?:[-*+]|\d+[.)])\s/),
  numbered: () => toggleLinePrefix("1. ", /^(?:[-*+]|\d+[.)])\s/),
  quote: () => toggleLinePrefix("> ", /^$/),
  comment: htmlComment,
  link: (t) => `[${t}](https://)`,
  cite: "[@key]",
  label: null,
  footnote: ["^[", "]"],
  figure: "![Caption](image.png)",
  table: MD_TABLE,
  ...marked("#"),
}

const SYNTAX: Partial<Record<Lang, Syntax>> = {
  typst: {
    bold: ["*", "*"],
    italic: ["_", "_"],
    code: ["`", "`"],
    math: ["$", "$"],
    mathBlock: "$ x $",
    bullet: () => toggleLinePrefix("- ", /^[-+]\s/),
    numbered: () => toggleLinePrefix("+ ", /^[-+]\s/),
    quote: () => (hasSelection() ? wrap("#quote(block: true)[", "]", "") : insertBlock("#quote(block: true)[\n  Quote\n]", "Quote")),
    comment: () => toggleLinePrefix("// ", /^$/),
    link: (t) => `#link("https://")[${t}]`,
    cite: "@key",
    label: "<name>",
    footnote: ["#footnote[", "]"],
    figure: '#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n) <fig:name>',
    table: "#figure(\n  table(\n    columns: 2,\n    [*Header*], [*Header*],\n    [Cell], [Cell],\n  ),\n  caption: [Caption],\n) <tab:name>",
    ...marked("="),
  },
  latex: {
    bold: ["\\textbf{", "}"],
    italic: ["\\emph{", "}"],
    code: ["\\texttt{", "}"],
    math: ["$", "$"],
    mathBlock: "\\[\n  x\n\\]",
    bullet: texList("itemize"),
    numbered: texList("enumerate"),
    quote: () => (hasSelection() ? wrap("\\begin{quote}\n", "\n\\end{quote}", "") : insertBlock("\\begin{quote}\n  Quote\n\\end{quote}", "Quote")),
    comment: () => toggleLinePrefix("% ", /^$/),
    link: (t) => `\\href{https://}{${t}}`,
    cite: "\\cite{key}",
    label: "\\label{name}",
    footnote: ["\\footnote{", "}"],
    figure: "\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{image.png}\n  \\caption{Caption}\n  \\label{fig:name}\n\\end{figure}",
    table: "\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{ll}\n    Header & Header \\\\\n    Cell & Cell \\\\\n  \\end{tabular}\n  \\caption{Caption}\n  \\label{tab:name}\n\\end{table}",
    headingOf: (l) => {
      const m = /^\\(\w+)\*?\{(.*)\}\s*$/.exec(l)
      const level = m ? SECTIONS.indexOf(m[1]) + 1 : 0
      return level ? [level, m![2]] : null
    },
    heading: (title, level) => (level ? `\\${SECTIONS[level - 1]}{${title}}` : title),
  },
  markdown: MARKDOWN,
  quarto: { ...MARKDOWN, label: "{#sec-name}", figure: "![Caption](image.png){#fig-name}", table: `${MD_TABLE}\n\n: Caption {#tbl-name}` },
}
export const syntaxOf = (lang: Lang) => SYNTAX[lang]

type Fmt = { icon: string; label: string; keys?: string; run: () => void } | "|"
function formats(sx: Syntax): Fmt[] {
  return [
    { icon: "bold", label: "Bold", keys: "Cmd+B", run: () => wrap(...sx.bold, "bold text") },
    { icon: "italic", label: "Italic", keys: "Cmd+I", run: () => wrap(...sx.italic, "italic text") },
    { icon: "code", label: "Code", run: () => wrap(...sx.code, "code") },
    "|",
    { icon: "symbol-operator", label: "Inline math", run: () => wrap(...sx.math, "x") },
    { icon: "symbol-numeric", label: "Math block", run: () => insertBlock(sx.mathBlock, "x") },
    "|",
    { icon: "list-unordered", label: "Bullet list", run: sx.bullet },
    { icon: "list-ordered", label: "Numbered list", run: sx.numbered },
    { icon: "quote", label: "Quote", run: sx.quote },
    "|",
    { icon: "link", label: "Link", run: () => link(sx) },
    { icon: "mention", label: `Citation or reference (${sx.cite})`, run: () => insertAt(sx.cite, "key") },
    { icon: "library", label: "Cite by DOI or arXiv ID", run: () => openCite() },
    ...(sx.label ? [{ icon: "tag", label: `Label (${sx.label})`, run: () => insertAt(sx.label!, "name") }] : []),
    { icon: "note", label: "Footnote", run: () => (hasSelection() ? wrap(...sx.footnote, "") : insertAt(sx.footnote.join("Footnote text"), "Footnote text", false)) },
    "|",
    { icon: "file-media", label: "Figure", run: () => insertBlock(sx.figure, "image.png") },
    { icon: "table", label: "Table", run: () => insertBlock(sx.table, "Header") },
    { icon: "comment", label: "Comment out", keys: "Cmd+/", run: sx.comment },
  ]
}
export const FORMAT_KEYS: Record<string, (sx: Syntax) => void> = {
  b: (sx) => wrap(...sx.bold, "bold text"),
  i: (sx) => wrap(...sx.italic, "italic text"),
  "/": (sx) => sx.comment(),
}

// Rebuilt when the open file's language changes. Plain text files get no bar. In review mode
// the buttons are off: the text field they edit is hidden. A narrow editor wraps the bar onto
// a second row, so every button stays in view.
let barLang: Lang | null = null
export function buildFormatBar(lang: Lang, review: boolean) {
  if (barLang === lang) return
  barLang = lang
  const bar = $("format-bar")
  bar.replaceChildren()
  const sx = syntaxOf(lang)
  if (!sx) return
  const heading = document.createElement("select")
  heading.id = "fmt-heading"
  heading.className = "ghost-select"
  heading.title = "Text style (Cmd+Option+0 to 4)"
  heading.append(new Option("Text", "0"), ...[1, 2, 3, 4].map((n) => new Option(`Heading ${n}`, String(n))))
  heading.onchange = () => setHeading(sx, Number(heading.value))
  heading.disabled = review
  bar.append(heading, Object.assign(document.createElement("span"), { className: "sep" }))
  for (const f of formats(sx)) {
    if (f === "|") {
      bar.append(Object.assign(document.createElement("span"), { className: "sep" }))
      continue
    }
    const b = document.createElement("button")
    b.className = "icon-btn"
    b.title = f.keys ? `${f.label} (${f.keys})` : f.label
    b.setAttribute("aria-label", f.label)
    b.innerHTML = icon(f.icon)
    b.onmousedown = (e) => e.preventDefault() // keep the text selection
    b.onclick = f.run
    b.disabled = review
    bar.append(b)
  }
}
