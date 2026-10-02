// Text changes as single replacements, used to keep unsaved typing when the file changes on disk,
// and the changes the writer reviews.

import { ChangeSet, Text } from "@codemirror/state"
import { Chunk } from "@codemirror/merge"

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

// Time limits, after which the diff turns quicker and rougher. Without one, an agent's rewrite of
// a long chapter froze the page for minutes. Typing gets the short one: it waits for each key.
const FIRST = { timeout: 100 }
const TYPING = { timeout: 10 }

// The changes between `base` (the text before the agent's changes) and `text`. Given the last
// result for the same base, only the place that changed since is compared again: diffing the
// whole of a long chapter again cost every key 10 ms or more.
export type Diff = { base: string; a: Text; text: string; chunks: readonly Chunk[] }
export function diff(base: string, text: string, last: Diff | null): Diff {
  const b = Text.of(text.split("\n"))
  if (last?.base !== base) {
    const a = Text.of(base.split("\n"))
    return { base, a, text, chunks: Chunk.build(a, b, FIRST) }
  }
  const c = minimalChange(last.text, text)
  return { ...last, text, chunks: Chunk.updateB(last.chunks, last.a, b, ChangeSet.of(c, last.text.length), TYPING) }
}
