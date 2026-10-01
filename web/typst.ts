// Typst highlighting: a small tokenizer that turns Typst source into colored HTML.
// What a line inherits from the lines before it (open math or raw blocks).
export type State = { math: boolean; raw: boolean }
export const startState = (): State => ({ math: false, raw: false })
export const sameState = (a: State, b: State) => a.math === b.math && a.raw === b.raw

// The few cursor moves the tokenizer needs over one line of text.
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

const KEYWORDS = new Set(["set", "let", "show", "import", "include", "if", "else", "for", "while", "return", "context", "break", "continue"])

const parser = {
  startState: (): State => ({ math: false, raw: false }),
  token(stream: Stream, s: State): string | null {
    if (s.raw) {
      if (stream.skipTo("```")) { stream.match("```"); s.raw = false } else stream.skipToEnd()
      return "raw"
    }
    if (s.math) {
      if (stream.match("$")) { s.math = false; return "math" }
      while (!stream.eol() && stream.peek() !== "$") stream.next()
      return "math"
    }
    if (stream.match("//")) { stream.skipToEnd(); return "comment" }
    if (stream.sol() && stream.match(/^=+\s/)) { stream.skipToEnd(); return "heading" }
    if (stream.match("```")) { s.raw = true; return "raw" }
    if (stream.match(/^`[^`]*`/)) return "raw"
    if (stream.match("$")) { s.math = true; return "math" }
    const hash = stream.match(/^#([a-zA-Z_][\w-]*)(\.[\w-]+)*/) as RegExpMatchArray | null
    if (hash) return KEYWORDS.has(hash[1]) ? "keyword" : "func"
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string"
    if (stream.match(/^\*[^*\n]+\*/)) return "strong"
    if (stream.match(/^_[^_\n]+_/)) return "emphasis"
    if (stream.match(/^(@[\w:.-]+|<[\w:.-]+>)/)) return "label"
    stream.next()
    return null
  },
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)

// One line as HTML spans (class "tk-<token>"). Updates `state` for the next line.
export function highlightLine(line: string, state: State): string {
  const s = new Stream(line)
  let out = ""
  while (!s.eol()) {
    const style = parser.token(s, state)
    if (s.pos === s.start) s.next() // never stall on a zero-width token
    const piece = esc(line.slice(s.start, s.pos))
    out += style ? `<span class="tk-${style}">${piece}</span>` : piece
    s.start = s.pos
  }
  return out
}

export function highlightHTML(text: string): string {
  const state = startState()
  return text
    .split("\n")
    .map((line) => highlightLine(line, state))
    .join("\n")
}
