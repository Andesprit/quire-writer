import type { Lang } from "./highlight.ts"

// What the writer is typing at the caret: a reference to a label, a citation key, or either.
// replaceFrom is where the key starts in the text; the key typed so far is text[replaceFrom..caret].
export type RefTrigger = { kind: "ref" | "cite" | "both"; prefix: string; replaceFrom: number; close: string }

export type RefChoice = { key: string; tag: "label" | "citation" }
const MAX = 8
const inOrder = (s: string, q: string) => {
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length
}

// The keys that fit what was typed: names that start with it first (any case), then looser matches.
export function refChoices(t: RefTrigger, labels: string[], cites: string[]): RefChoice[] {
  const all: RefChoice[] = []
  const seen = new Set<string>()
  const add = (keys: string[], tag: RefChoice["tag"]) => keys.forEach((key) => seen.has(tag + key) || (seen.add(tag + key), all.push({ key, tag })))
  if (t.kind !== "cite") add(labels, "label")
  if (t.kind !== "ref") add(cites, "citation")
  const q = t.prefix.toLowerCase()
  const starts = all.filter((c) => c.key.toLowerCase().startsWith(q))
  const loose = q ? all.filter((c) => !c.key.toLowerCase().startsWith(q) && inOrder(c.key.toLowerCase(), q)) : []
  return [...starts, ...loose].filter((c) => c.key !== t.prefix || starts.length + loose.length > 1).slice(0, MAX)
}

const TEX_REF = /\\(?:ref|eqref|cref|Cref|autoref|pageref|nameref|vref)\*?\{([^{}]*)$/
const TEX_CITE = /\\(?:\w*cite\w*|nocite)\*?(?:\[[^\]\n]*\]){0,2}\{([^{}]*)$/
const AT = /(?:^|[^\w@.\\])@([\w:.-]*)$/ // '@' not glued to a word: e-mails never match
const TYPST_LINK = /#(ref|cite)\(\s*<([\w:.-]*)$/

// ponytail: line-based like outline.ts; a $ or ` that spans lines is not seen. Add a real scan if it matters.
const odd = (s: string, ch: string) => (s.split(ch).length - 1) % 2 === 1

export function refTrigger(before: string, lang: Lang): RefTrigger | null {
  if (lang === "markdown" || lang === "text") return null
  const lines = before.split("\n")
  const line = lines.pop()!
  // Fenced code and block comments opened on an earlier line and still open.
  let fence = false
  let block = false
  for (const l of lines) {
    if (fence) {
      if (lang === "latex" ? /^\s*\\end\{(verbatim\*?|lstlisting|minted|comment)\}/.test(l) : /^\s*(```|~~~)/.test(l)) fence = false
    } else if (block) {
      if (l.includes(lang === "typst" ? "*/" : "-->")) block = false
    } else if (lang === "latex") fence = /^\s*\\begin\{(verbatim\*?|lstlisting|minted|comment)\}/.test(l)
    else if (/^\s*(```|~~~)/.test(l)) fence = true
    else {
      const open = lang === "typst" ? "/*" : "<!--"
      const at = l.indexOf(open)
      if (at >= 0 && !l.includes(lang === "typst" ? "*/" : "-->", at + open.length)) block = true
    }
  }
  if (fence || block) return null
  if (/^\s*(```|~~~)/.test(line)) return null
  const hit = (kind: RefTrigger["kind"], prefix: string, close = ""): RefTrigger => ({ kind, prefix, replaceFrom: before.length - prefix.length, close })

  if (lang === "latex") {
    if (/(^|[^\\])%/.test(line)) return null
    let m = TEX_CITE.exec(line)
    if (m) return hit("cite", m[1].slice(m[1].lastIndexOf(",") + 1).trimStart(), "}")
    m = TEX_REF.exec(line)
    if (m) return hit("ref", m[1].slice(m[1].lastIndexOf(",") + 1).trimStart(), "}")
    return null
  }
  if (odd(line, "`") || odd(line, "$")) return null
  if (lang === "typst") {
    if (/(^|[^:])\/\//.test(line)) return null // line comment (a URL has "://")
    const l = TYPST_LINK.exec(line)
    if (l) return hit(l[1] === "ref" ? "ref" : "cite", l[2], ">")
  } else if (line.includes("<!--") && !line.includes("-->")) return null
  const m = AT.exec(line)
  return m ? hit("both", m[1]) : null
}
