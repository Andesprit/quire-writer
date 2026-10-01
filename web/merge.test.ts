// Self-check for keeping unsaved typing. Run: node web/merge.test.ts
import assert from "node:assert"
import { rebase, type Change } from "./merge.ts"

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
console.log("ok")
