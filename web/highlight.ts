// Syntax colors: small tokenizers that turn Typst, LaTeX and Markdown/Quarto into colored HTML.

export type Lang = "typst" | "latex" | "quarto" | "markdown" | "text"

export function langOf(path: string | null): Lang {
  const ext = path?.split(".").pop()?.toLowerCase()
  return ({ typ: "typst", tex: "latex", qmd: "quarto", md: "markdown" } as Record<string, Lang>)[ext ?? ""] ?? "text"
}

// What a line inherits from the lines before it: the text that closes an open math, raw or
// comment block ("" when none is open), and whether it is the first line (Markdown front matter).
export type State = { math: string; raw: string; start: boolean }
export const startState = (): State => ({ math: "", raw: "", start: true })
export const sameState = (a: State, b: State) => a.math === b.math && a.raw === b.raw && a.start === b.start

// The few cursor moves the tokenizers need over one line of text.
class Stream {
  pos = 0
  start = 0
  line: string
  constructor(line: string) {
    this.line = line
  }
  eol() { return this.pos >= this.line.length }
  sol() { return this.pos === 0 }
  peek() { return this.line.charAt(this.pos) || undefined }
  next() { return this.eol() ? undefined : this.line.charAt(this.pos++) }
  skipToEnd() { this.pos = this.line.length }
  skipTo(s: string) {
    const i = this.line.indexOf(s, this.pos)
    if (i < 0) return false
    this.pos = i
    return true
  }
  // Up to and including `end`, or to the end of the line. True when `end` was found.
  through(end: string) {
    const found = this.skipTo(end)
    if (found) this.pos += end.length
    else this.skipToEnd()
    return found
  }
  // The character before the token: a letter or digit there means "inside a word".
  inWord() { return this.pos > 0 && /[\p{L}\p{N}_]/u.test(this.line[this.pos - 1]) }
  match(p: string | RegExp): RegExpMatchArray | boolean | null {
    if (typeof p === "string") {
      if (!this.line.startsWith(p, this.pos)) return false
      this.pos += p.length
      return true
    }
    const m = this.line.slice(this.pos).match(p)
    if (!m || m.index !== 0) return null
    this.pos += m[0].length
    return m
  }
}

type Parser = (stream: Stream, s: State) => string | null

const TYPST_KEYWORDS = new Set(["set", "let", "show", "import", "include", "if", "else", "for", "while", "return", "context", "break", "continue"])

const typst: Parser = (stream, s) => {
  if (s.raw) {
    const style = s.raw === "*/" ? "comment" : "raw"
    if (stream.through(s.raw)) s.raw = ""
    return style
  }
  if (s.math) {
    if (stream.match(s.math)) { s.math = ""; return "math" }
    while (!stream.eol() && stream.peek() !== "$") stream.next()
    return "math"
  }
  if (stream.match(/^\\./)) return null // \$ \* \_ \# \@ are the characters themselves
  if (stream.match("//")) { stream.skipToEnd(); return "comment" }
  if (stream.match("/*")) {
    if (!stream.through("*/")) s.raw = "*/"
    return "comment"
  }
  if (stream.sol() && stream.match(/^=+\s/)) { stream.skipToEnd(); return "heading" }
  if (stream.match("```")) { s.raw = "```"; return "raw" }
  if (stream.match(/^`[^`]*`/)) return "raw"
  if (stream.match("$")) { s.math = "$"; return "math" }
  const hash = stream.match(/^#([a-zA-Z_][\w-]*)(\.[\w-]+)*/) as RegExpMatchArray | null
  if (hash) return TYPST_KEYWORDS.has(hash[1]) ? "keyword" : "func"
  if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string"
  // Inside a word (snake_case) * and _ are plain characters, as Typst reads them.
  if (!stream.inWord() && stream.match(/^\*[^*\n]+\*/)) return "strong"
  if (!stream.inWord() && stream.match(/^_[^_\n]+_/)) return "emphasis"
  if (stream.match(/^(@[\w:.-]+|<[\w:.-]+>)/)) return "label"
  stream.next()
  return null
}

const VERBATIM = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "comment"])
const MATH_ENVS = /^(equation|align|gather|multline|flalign|alignat|eqnarray|math|displaymath)\*?$/

const latex: Parser = (stream, s) => {
  if (s.raw) {
    if (stream.through(s.raw)) s.raw = ""
    return "raw"
  }
  if (s.math && stream.match(s.math)) { s.math = ""; return "math" }
  if (s.math) {
    // Commands inside math are math too, up to the text that closes it.
    if (!stream.match(/^\\[a-zA-Z]+|^\\./)) stream.next()
    while (!stream.eol() && !stream.line.startsWith(s.math, stream.pos) && stream.peek() !== "\\") stream.next()
    return "math"
  }
  if (stream.match(/^%.*/)) return "comment"
  const env = stream.match(/^\\(begin|end)\{([^}]*)\}/) as RegExpMatchArray | null
  if (env) {
    if (env[1] === "begin" && VERBATIM.has(env[2])) s.raw = `\\end{${env[2]}}`
    else if (env[1] === "begin" && MATH_ENVS.test(env[2])) s.math = `\\end{${env[2]}}`
    return "keyword"
  }
  if (stream.match("\\[")) { s.math = "\\]"; return "math" }
  if (stream.match("\\(")) { s.math = "\\)"; return "math" }
  if (stream.match("$$")) { s.math = "$$"; return "math" }
  if (stream.match(/^\$(?:[^$\\]|\\.)+\$/)) return "math"
  if (stream.match(/^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{[^}]*\}?/)) return "heading"
  if (stream.match(/^\\(?:label|ref|eqref|pageref|autoref|nameref|[cCvV]ref|cite\w*|\w*cite)\*?(?:\[[^\]]*\])*\{[^}]*\}/)) return "label"
  if (stream.match(/^\\textbf\{[^}]*\}/)) return "strong"
  if (stream.match(/^\\(?:emph|textit)\{[^}]*\}/)) return "emphasis"
  if (stream.match(/^\\(?:[a-zA-Z@]+\*?|.)/)) return "func"
  stream.next()
  return null
}

// Markdown, with what Quarto adds: front matter, {#labels}, @references and code chunks.
const markdown: Parser = (stream, s) => {
  if (s.raw === "---") {
    // Front matter: YAML keys stand out.
    if (stream.sol() && stream.match(/^(---|\.\.\.)\s*$/)) { s.raw = ""; return "raw" }
    if (stream.sol() && stream.match(/^\s*[\w-]+:/)) return "keyword"
    stream.skipToEnd()
    return "string"
  }
  if (s.raw === "-->") {
    if (stream.through("-->")) s.raw = ""
    return "comment"
  }
  if (s.raw) {
    if (stream.sol() && stream.line.trimStart().startsWith(s.raw)) s.raw = ""
    stream.skipToEnd()
    return "raw"
  }
  if (s.math) {
    if (stream.through(s.math)) s.math = ""
    return "math"
  }
  if (stream.sol()) {
    if (s.start && stream.match(/^---\s*$/)) { s.raw = "---"; return "raw" }
    const fence = stream.match(/^\s*(```+|~~~+)/) as RegExpMatchArray | null
    if (fence) { s.raw = fence[1]; stream.skipToEnd(); return "raw" }
    if (stream.match(/^#{1,6}\s.*/)) return "heading"
    if (stream.match(/^\s*(?:[-*+]|\d+[.)])\s/) || stream.match(/^\s*>\s?/)) return "keyword"
  }
  if (stream.match("<!--")) {
    if (!stream.through("-->")) s.raw = "-->" // goes on over the next lines
    return "comment"
  }
  if (stream.match(/^`[^`]+`/)) return "raw"
  if (stream.match("$$")) {
    if (!stream.through("$$")) s.math = "$$"
    return "math"
  }
  if (stream.match(/^\$[^\s$](?:[^$\\]|\\.)*?\$/)) return "math"
  if (stream.match(/^\*\*[^*]+\*\*/) || stream.match(/^__[^_]+__/)) return "strong"
  if (stream.match(/^\*[^*\s][^*]*\*/) || (!stream.inWord() && stream.match(/^_[^_\s][^_]*_(?![\p{L}\p{N}])/u))) return "emphasis"
  if (stream.match(/^\[-?@[^\]]*\]/) || (!stream.inWord() && stream.match(/^@[\w-]+(?:[:.][\w-]+)*/))) return "label"
  if (stream.match(/^\{[^}]*#[^}]*\}/)) return "label"
  if (stream.match(/^!?\[[^\]]*\]\([^)]*\)/)) return "func"
  if (stream.match(/^<https?:\/\/[^>]*>/)) return "string"
  stream.next()
  return null
}

const PARSERS: Record<Lang, Parser | null> = { typst, latex, quarto: markdown, markdown, text: null }

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)

// One line as HTML spans (class "tk-<token>"). Updates `state` for the next line.
export function highlightLine(line: string, state: State, lang: Lang): string {
  const parser = PARSERS[lang]
  if (!parser) return esc(line)
  const s = new Stream(line)
  let out = ""
  while (!s.eol()) {
    const style = parser(s, state)
    if (s.pos === s.start) s.next() // never stall on a zero-width token
    const piece = esc(line.slice(s.start, s.pos))
    out += style ? `<span class="tk-${style}">${piece}</span>` : piece
    s.start = s.pos
  }
  state.start = false
  return out
}

export function highlightHTML(text: string, lang: Lang): string {
  const state = startState()
  return text
    .split("\n")
    .map((line) => highlightLine(line, state, lang))
    .join("\n")
}
