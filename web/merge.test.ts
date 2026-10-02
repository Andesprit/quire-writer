// Self-check for keeping unsaved typing and for the changes to review. Run: node web/merge.test.ts
import assert from "node:assert"
import { Text } from "@codemirror/state"
import { Chunk } from "@codemirror/merge"
import { diff, rebase, type Change } from "./merge.ts"

const apply = (s: string, c: Change) => s.slice(0, c.from) + c.insert + s.slice(c.to)
const base = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."

// The writer typed at the top, the agent changed the end: both kept.
const mine = base.replace("First", "My first")
const theirs = base.replace("Third paragraph.", "Third paragraph, improved.")
assert.equal(apply(mine, rebase(base, mine, theirs)!), "My first paragraph.\n\nSecond paragraph.\n\nThird paragraph, improved.")

// The agent changed the top, the writer typed at the end: both kept.
const mine2 = base + " More."
const theirs2 = base.replace("First", "1st")
assert.equal(apply(mine2, rebase(base, mine2, theirs2)!), "1st paragraph.\n\nSecond paragraph.\n\nThird paragraph. More.")

// Both changed the same sentence: no guess, the writer decides.
assert.equal(rebase(base, base.replace("Second", "2nd"), base.replace("Second paragraph", "Middle")), null)

// The changes to review, kept up to date as the writer types: the same as diffing again.
const chapter = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} says something about pumps.`).join("\n")
const edited = chapter.replace("Paragraph 10 says", "Paragraph 10 now says").replace("Paragraph 300 says", "P300 says")
const spans = (d: readonly Chunk[]) => d.map((c) => [c.fromA, c.toA, c.fromB, c.toB])
let d = diff(chapter, edited, null)
for (const typed of [edited.replace("Paragraph 200", "Paragraph 200x"), edited.replace("Paragraph 200", "Paragraph 200xy"), edited.replace("Paragraph 10 now says", "Paragraph 10 says")]) {
  d = diff(chapter, typed, d)
  assert.deepEqual(spans(d.chunks), spans(Chunk.build(Text.of(chapter.split("\n")), Text.of(typed.split("\n")))))
}
// The agent rewrote every paragraph: worked out in moments, not minutes.
const rewritten = chapter.split("\n").map((l) => l.split(" ").reverse().join(" ")).join("\n")
const started = Date.now()
d = diff(chapter, rewritten, null)
d = diff(chapter, rewritten + " typed", d)
assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
console.log("ok")
