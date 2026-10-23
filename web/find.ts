export type Match = { from: number; to: number }

const wordEnd = /[\p{L}\p{N}\p{M}_]$/u
const wordStart = /^[\p{L}\p{N}\p{M}_]/u

// Literal, non-overlapping matches. RegExp's Unicode case folding preserves UTF-16 offsets.
export function findMatches(text: string, query: string, matchCase = false, wholeWord = false): Match[] {
  if (!query) return []
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches: Match[] = []
  for (const m of text.matchAll(new RegExp(literal, matchCase ? "gu" : "giu"))) {
    const from = m.index, to = from + m[0].length
    if (wholeWord && (wordEnd.test(text.slice(Math.max(0, from - 2), from)) || wordStart.test(text.slice(to, to + 2)))) continue
    matches.push({ from, to })
  }
  return matches
}

// One native edit keeps Replace All undoable in one step without replacing untouched ends.
export function replacementEdit(text: string, matches: readonly Match[], replacement: string) {
  if (!matches.length) return null
  const from = matches[0].from, to = matches[matches.length - 1].to
  const pieces: string[] = []
  let at = from
  for (const match of matches) {
    pieces.push(text.slice(at, match.from), replacement)
    at = match.to
  }
  return { from, to, insert: pieces.join("") }
}
