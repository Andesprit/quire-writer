export type FuzzyMatch = { score: number; positions: number[] }

// Subsequence matching rewards consecutive letters and word/path boundaries.
// Keep UTF-16 positions so rendering matched characters never splits a surrogate pair.
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const needle = Array.from(query.trim(), (c) => c.toLowerCase())
  if (!needle.length) return { score: 0, positions: [] }
  const chars = Array.from(text)
  const offsets: number[] = []
  let offset = 0
  for (const c of chars) { offsets.push(offset); offset += c.length }
  let best: FuzzyMatch | null = null
  for (let start = 0; start < chars.length; start++) {
    if (chars[start].toLowerCase() !== needle[0]) continue
    const positions: number[] = []
    let at = start, score = -start
    for (const c of needle) {
      const from = at
      while (at < chars.length && chars[at].toLowerCase() !== c) at++
      if (at === chars.length) break
      score += (at === from ? 12 : 0) - (at - from)
      if (at === 0 || /[\s/_.-]/u.test(chars[at - 1])) score += 8
      positions.push(offsets[at++])
    }
    if (positions.length === needle.length && (!best || score > best.score)) best = { score, positions }
  }
  return best
}

export function rankFiles(files: string[], query: string, recent: string[] = []) {
  const recency = (path: string) => { const i = recent.indexOf(path); return i < 0 ? Infinity : i }
  return files.flatMap((path) => {
    const start = path.lastIndexOf("/") + 1
    const basename = path.slice(start)
    const name = fuzzyMatch(basename, query)
    const match = name ?? fuzzyMatch(path, query)
    const q = query.trim().toLowerCase()
    const exact = q && basename.toLowerCase() === q ? 100 : q && basename.split(".").pop()!.toLowerCase() === q ? 60 : 0
    return match ? [{ path, score: match.score + exact, name: !!name, positions: match.positions.map((p) => p + (name ? start : 0)) }] : []
  }).sort((a, b) => Number(b.name) - Number(a.name) || b.score - a.score || recency(a.path) - recency(b.path) || a.path.localeCompare(b.path))
}
