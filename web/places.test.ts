import assert from "node:assert/strict"
import { LIMIT, goBack, goForward, leave, newTrail, rename } from "./places.ts"

const at = (path: string, line: number, col = 0) => ({ path, line, col })
const all = () => true

// Back retraces a jump across files, Forward returns to its target.
let t = newTrail()
leave(t, at("a.typ", 120), at("b.typ", 3))
assert.deepEqual(goBack(t, at("b.typ", 3), all), at("a.typ", 120))
assert.deepEqual(goForward(t, at("a.typ", 120), all), at("b.typ", 3))
assert.equal(goForward(t, at("b.typ", 3), all), undefined, "nothing further forward")
assert.equal(goBack(newTrail(), at("a.typ", 0), all), undefined, "empty trail")

// A near jump in the same file adds no stop; near places on the stack merge.
t = newTrail()
leave(t, at("a.typ", 10), at("a.typ", 12))
assert.equal(t.back.length, 0)
leave(t, at("a.typ", 10), at("a.typ", 80))
leave(t, at("a.typ", 82), at("a.typ", 200))
leave(t, at("a.typ", 84), at("a.typ", 400))
assert.deepEqual(t.back, [at("a.typ", 10), at("a.typ", 84)])

// A new jump clears Forward.
t = newTrail()
leave(t, at("a.typ", 1), at("b.typ", 1))
goBack(t, at("b.typ", 1), all)
leave(t, at("a.typ", 1), at("c.typ", 1))
assert.equal(t.fwd.length, 0)

// Missing files are skipped, and the skipped stops are gone.
t = newTrail()
leave(t, at("a.typ", 1), at("b.typ", 1))
leave(t, at("gone.typ", 1), at("c.typ", 1))
assert.deepEqual(goBack(t, at("c.typ", 1), (p) => p !== "gone.typ"), at("a.typ", 1))
assert.equal(t.back.length, 0)

// Renames, also of a folder, are followed.
t = newTrail()
leave(t, at("ch/one.typ", 1), at("b.typ", 1))
rename(t, "ch", "chapters")
assert.deepEqual(goBack(t, at("b.typ", 1), all), at("chapters/one.typ", 1))
leave(t, at("x.typ", 1), at("y.typ", 1))
rename(t, "x.typ", "z.typ")
assert.equal(t.back[0].path, "z.typ")

// The stack is bounded.
t = newTrail()
for (let i = 0; i < LIMIT + 20; i++) leave(t, at("a.typ", i * 100), at("b.typ", 0))
assert.equal(t.back.length, LIMIT)
console.log("places ok")
