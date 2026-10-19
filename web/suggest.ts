// Suggestions: the model reads paragraphs and answers with fixes; this finds each fix in them.

/** A fix inside one paragraph: replace `len` characters at `at` with `fix`. */
export type Fix = { at: number; len: number; fix: string; why: string }

/** Runs of non-blank lines, with where each starts in the text. */
export function paragraphs(text: string): { from: number; text: string }[] {
  return [...text.matchAll(/[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g)].map((m) => ({ from: m.index, text: m[0] }))
}

// Words, runs of space, and single other characters. A line break and a space are the same.
const tokens = (s: string) => s.match(/[\p{L}\p{N}']+|\s+|[^\p{L}\p{N}'\s]/gu) ?? []
const space = (t: string) => /^\s/.test(t)
// Characters of markup and math in Typst, LaTeX, Quarto and Markdown. A fix that adds or
// removes one is the model touching markup, which it was told not to do: it is dropped.
// ponytail: one set for every language; a fix of prose that needs one of these is lost.
const markup = /[$\\#{}_*<>@[\]`~^=]/
const same = (x: string, y: string) => x === y || (space(x) && space(y))

/**
 * The words that differ between `a`, copied from the paragraph, and `b`, as fixes in `a`. One
 * item from the model often holds two mistakes: each gets its own underline.
 */
export function changes(a: string, b: string, why: string): Fix[] {
  const [x, y] = [tokens(a), tokens(b)]
  // L[i][j]: how many tokens x[i..] and y[j..] share, in order.
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) L[i][j] = same(x[i], y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  }
  const out: Fix[] = []
  let [i, j, at] = [0, 0, 0]
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && same(x[i], y[j])) {
      at += x[i++].length
      j++
      continue
    }
    // A run of changes: the tokens of `a` it replaces (i..i1) and those of `b` that replace them.
    let [i1, j1] = [i, j]
    while ((i1 < x.length || j1 < y.length) && !(i1 < x.length && j1 < y.length && same(x[i1], y[j1]))) {
      if (j1 >= y.length || (i1 < x.length && L[i1 + 1][j1] >= L[i1][j1 + 1])) i1++
      else j1++
    }
    const old = x.slice(i, i1).join("")
    let fix = { at, len: old.length, fix: y.slice(j, j1).join(""), why }
    // Only added: underline the word before it ("However" for a missing comma), or after it.
    if (!old && i > 0 && !space(x[i - 1])) fix = { at: at - x[i - 1].length, len: x[i - 1].length, fix: x[i - 1] + fix.fix, why }
    else if (!old && i < x.length) fix = { at, len: x[i].length, fix: fix.fix + x[i], why }
    if (fix.len) out.push(fix)
    at += old.length
    ;[i, j] = [i1, j1]
  }
  return out
}

/**
 * The model's reply, a JSON array of {original, suggestion, reason}, as fixes for each of the
 * paragraphs it was given. Null when the reply is not such an array.
 */
export function readFixes(reply: string, paras: string[]): Fix[][] | null {
  let edits: unknown
  try {
    edits = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1))
  } catch {
    return null
  }
  if (!Array.isArray(edits)) return null
  const out: Fix[][] = paras.map(() => [])
  for (const e of edits) {
    const o = typeof e?.original === "string" ? e.original : ""
    const s = typeof e?.suggestion === "string" ? e.suggestion : ""
    if (!o.trim() || o === s) continue
    // The model copies a paragraph's line breaks as spaces.
    // ponytail: one whitespace character for one; an indented next line is not found.
    const find = new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s/g, "\\s"), "gu")
    for (const [i, p] of paras.entries()) {
      // The first place this text appears that no other fix took.
      const m = [...p.matchAll(find)].find((m) => !out[i].some((f) => f.at < m.index + o.length && m.index < f.at + f.len))
      if (!m) continue
      const why = typeof e?.reason === "string" ? e.reason : ""
      const prose = changes(m[0], s, why).filter((f) => !markup.test(m[0].slice(f.at, f.at + f.len)) && !markup.test(f.fix))
      out[i].push(...prose.map((f) => ({ ...f, at: m.index + f.at })))
      break
    }
  }
  for (const f of out) f.sort((x, y) => x.at - y.at)
  return out
}
