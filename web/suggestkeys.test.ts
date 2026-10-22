import assert from "node:assert/strict"
import { suggestKeys, keySpan } from "./suggestkeys.ts"

const labels = ["sec:introduction", "sec:methods", "fig-results", "fig-setup", "eq:energy", "tab:a"]
const cites = ["smith2020", "lee2019", "knuth1984"]
const top = (k: string, pool: string[]) => suggestKeys(k, pool)[0]

assert.equal(top("sec:intro", labels), "sec:introduction")
assert.equal(top("fig-resuls", labels), "fig-results")
assert.equal(top("fig-reuslts", labels), "fig-results") // swapped letters
assert.equal(top("Smith2020", cites), "smith2020")
assert.equal(top("smith2021", cites), "smith2020")
assert.equal(top("sec:introduction2", labels), "sec:introduction") // longer than the real one
assert.deepEqual(suggestKeys("zzzzzz", labels), []) // nothing close
assert.deepEqual(suggestKeys("tab:b", ["tab:a"]), ["tab:a"]) // short keys: one slip at most
assert.deepEqual(suggestKeys("ab", ["xy", "cd"]), [])
assert.deepEqual(suggestKeys("x", ["y", "z"]), []) // one letter is never a guess
// A citation is never fixed with a label, because the caller only hands over its own pool.
assert.equal(top("sec:intro", cites), undefined)
assert.deepEqual(suggestKeys("smith2020", ["smith2020"]), []) // already exists
assert.ok(suggestKeys("sec", labels).length <= 3)

// The key's own span, also inside a \cref list and after non-ASCII text.
assert.deepEqual(keySpan("\\cref{a,sec:nope}", 8, "sec:nope"), { from: 8, to: 16 })
const wide = "Ünï 😀 see @fig-resuls"
assert.equal(wide.slice(keySpan(wide, 11, "fig-resuls")!.from), "fig-resuls") // the emoji is 2 UTF-16 units, 1 character
assert.equal(keySpan("see @other", 5, "fig-resuls"), null) // moved: do not touch
console.log("suggestkeys ok")
