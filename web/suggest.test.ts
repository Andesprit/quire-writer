// Self-check for finding the model's fixes in the text. Run: node web/suggest.test.ts
import assert from "node:assert"
import { paragraphs, readFixes } from "./suggest.ts"

assert.deepEqual(paragraphs("= Title\n\nOne line\nnext line.\n  \nLast."), [
  { from: 0, text: "= Title" },
  { from: 9, text: "One line\nnext line." },
  { from: 32, text: "Last." },
])

const fix = (reply: object[], paras: string[]) => readFixes(JSON.stringify(reply), paras)
const apply = (p: string, f: { at: number; len: number; fix: string }) => p.slice(0, f.at) + f.fix + p.slice(f.at + f.len)
const edit = (original: string, suggestion: string) => ({ original, suggestion, reason: "r" })

// A misspelled word: the whole word is underlined, and replacing it gives the suggestion.
const p = "We recieve the data."
let [[f]] = fix([edit("We recieve the", "We receive the")], [p])!
assert.deepEqual(f, { at: 3, len: 7, fix: "receive", why: "r" })

// A missing comma underlines the word before it; a doubled word underlines the extra one.
const q = "However the the results hold."
const [fs] = fix([edit("However the", "However, the"), edit("the the results", "the results")], [q])!
assert.deepEqual(fs.map((f) => q.slice(f.at, f.at + f.len)), ["However", "the "])
assert.equal(apply(q, fs[0]), "However, the the results hold.")
assert.equal(apply(q, fs[1]), "However the results hold.")

// A word added at the start of the text it copied.
;[[f]] = fix([edit("cat sat", "The cat sat")], ["cat sat down."])!
assert.equal(apply("cat sat down.", f), "The cat sat down.")

// A line break inside the paragraph, copied as a space; the second paragraph has the fix.
const r = "Results are\nsignificent here."
const both = fix([edit("are significent", "are significant")], ["Nothing here.", r])!
assert.deepEqual(both[0], [])
assert.equal(apply(r, both[1][0]), "Results are\nsignificant here.")

// Two mistakes in one item: two underlines, each on its word. An added word underlines the next one.
const y = "When yeast eat the sugars in flour, it release carbon."
const [two0] = fix([edit("yeast eat the sugars in flour, it release", "yeast eats the sugars in flour, it releases")], [y])!
assert.deepEqual(two0.map((f) => [y.slice(f.at, f.at + f.len), f.fix]), [["eat", "eats"], ["release", "releases"]])
;[[f]] = fix([edit("the cat", "the big cat")], ["See the cat."])!
assert.deepEqual([f.at, f.len, f.fix], [8, 3, "big cat"])

// Fixes that touch markup or math are dropped; the prose fix next to them stays.
const mk = "*Timing matter more*, and _patience_ wins: $r_0 dot 2$."
const [kept] = fix([edit("*Timing matter more*, and _patience_", "*Timing matters more*, and patience"), edit("$r_0 dot 2$", "$r_0 \\cdot 2$")], [mk])!
assert.deepEqual(kept.map((f) => [mk.slice(f.at, f.at + f.len), f.fix]), [["matter", "matters"]])

// The same text twice: each fix takes its own place.
const t = "teh end, teh end"
const [two] = fix([edit("teh end", "the end"), edit("teh end", "the end")], [t])!
assert.deepEqual(two.map((f) => f.at), [0, 9])

// Text that is not in the paragraphs, no change, chatter around the array, and no array.
assert.deepEqual(fix([edit("missing", "found"), edit("We", "We")], [p]), [[]])
assert.equal(readFixes('Sure! [{"original": "teh", "suggestion": "the", "reason": ""}] Done.', ["teh"])![0][0].fix, "the")
assert.equal(readFixes("No mistakes found.", [p]), null)
assert.deepEqual(readFixes("[]", [p]), [[]])

console.log("suggest: ok")
