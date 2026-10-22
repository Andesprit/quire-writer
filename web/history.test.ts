import assert from "node:assert/strict"
import { changeCount, diffLines, whenText } from "./history.ts"

const show = (a: string, b: string) => diffLines(a, b).lines.map((l) => l.op + l.text).join("|")
assert.equal(show("a\nb\nc", "a\nb\nc"), " a| b| c")
assert.equal(show("a\nb\nc", "a\nX\nc"), " a|-b|+X| c")
assert.equal(show("a\nc", "a\nb\nc"), " a|+b| c")
assert.equal(show("a\nb\nc", "a\nc"), " a|-b| c")
assert.equal(show("", "x"), "-|+x", "an empty text is one empty line")
assert.equal(show("a\nb\nc\nd", "d\nc\nb\na"), "-a|-b|-c| d|+c|+b|+a", "a reversal keeps one line")
const counts = changeCount(diffLines("one\ntwo\nthree", "one\n2\nthree\nfour").lines)
assert.deepEqual(counts, { added: 2, removed: 1 })
// Applying the diff to the old text gives the new one, and the other way round.
const old = Array.from({ length: 300 }, (_, i) => `line ${i % 17} ${i}`).join("\n")
const next = old.split("\n").filter((_, i) => i % 7 !== 0).concat(["tail"]).join("\n")
const d = diffLines(old, next)
assert.equal(d.lines.filter((l) => l.op !== "+").map((l) => l.text).join("\n"), old)
assert.equal(d.lines.filter((l) => l.op !== "-").map((l) => l.text).join("\n"), next)
// A very long, entirely different file falls back to replaced-as-a-whole, and stays fast.
const big = (p: string) => Array.from({ length: 6000 }, (_, i) => p + i).join("\n")
const started = Date.now()
const coarse = diffLines(big("a"), big("b"))
assert.ok(coarse.coarse && Date.now() - started < 500 && changeCount(coarse.lines).removed === 6000)
// A small edit in a long file is not coarse.
const long = big("a")
assert.ok(!diffLines(long, long.replace("a3000", "changed")).coarse)

// Times read as "Today 14:02 · 2 hours ago".
const at = new Date(2026, 9, 22, 14, 2).getTime()
assert.equal(whenText(at, new Date(2026, 9, 22, 16, 5).getTime()), "Today 14:02 · 2 hours ago")
assert.equal(whenText(at, at + 30_000), "Today 14:02 · just now")
assert.equal(whenText(at, at + 61_000), "Today 14:02 · 1 minute ago")
assert.equal(whenText(at, new Date(2026, 9, 23, 9, 0).getTime()), "Yesterday 14:02 · 18 hours ago")
assert.equal(whenText(at, new Date(2026, 9, 25, 9, 0).getTime()), "Oct 22 14:02 · 2 days ago")
console.log("history ok")
