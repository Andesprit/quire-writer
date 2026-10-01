// Text changes as single replacements, used to keep unsaved typing when the file changes on disk.

export type Change = { from: number; to: number; insert: string }

// Smallest replacement that turns a into b.
export function minimalChange(a: string, b: string): Change {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) }
}

// `mine` and `theirs` both started from `base`. Returns the change that brings theirs into
// mine, or null when both touched the same place and a person has to choose.
export function rebase(base: string, mine: string, theirs: string): Change | null {
  const t = minimalChange(base, theirs)
  const m = minimalChange(base, mine)
  if (!(t.to < m.from || m.to < t.from)) return null
  const shift = t.from > m.to ? m.insert.length - (m.to - m.from) : 0
  return { from: t.from + shift, to: t.to + shift, insert: t.insert }
}
