// Closest existing keys for a reference or citation that points nowhere.
// The caller picks the pool (labels for a reference, bib keys for a citation), so kinds never mix.

/** Edit distance where swapping two neighbouring letters costs one. */
function distance(a: string, b: string) {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}

/** The letters of `k` appear in `n` in order. */
const spread = (n: string, k: string) => { let i = 0; for (const c of n) if (c === k[i]) i++; return i === k.length }

/** Up to three keys from `pool` the writer most likely meant by `key`, best first. */
export function suggestKeys(key: string, pool: string[]): string[] {
  const k = key.toLowerCase()
  const slack = Math.min(3, Math.max(1, Math.floor(k.length / 4)))
  const ranked: { name: string; tier: number; cost: number }[] = []
  for (const name of new Set(pool)) {
    const n = name.toLowerCase()
    if (name === key) continue
    const near = distance(k, n)
    // 0 same letters in another case, 1 one is the start of the other, 2 a typo, 3 the typed letters spread out in it
    const tier = n === k ? 0 : k.length >= 4 && n.length >= 4 && (n.startsWith(k) || k.startsWith(n)) ? 1 : k.length >= 3 && near <= slack ? 2 : k.length >= 5 && n.length <= 2 * k.length && spread(n, k) ? 3 : 4
    if (tier < 4) ranked.push({ name, tier, cost: tier === 1 ? Math.abs(n.length - k.length) : near })
  }
  ranked.sort((a, b) => a.tier - b.tier || a.cost - b.cost || a.name.localeCompare(b.name))
  return ranked.slice(0, 3).map((r) => r.name)
}

/**
 * Where `key` sits in `line` (UTF-16), given the backend's `col` counted in characters.
 * Null when the line no longer holds the key there, so a stale position never edits other text.
 */
export function keySpan(line: string, col: number, key: string): { from: number; to: number } | null {
  const from = Array.from(line).slice(0, col).join("").length
  const to = from + key.length
  // The next character must not continue the key: sec:intro is not the start of sec:introduction.
  return line.startsWith(key, from) && !/^[\p{L}\p{N}_:-]/u.test(line.slice(to, to + 2)) ? { from, to } : null
}
