import assert from "node:assert/strict"
import { findMatches, replacementEdit } from "./find.ts"

assert.deepEqual(findMatches("Bread bread BREAD", "bread"), [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }])
assert.deepEqual(findMatches("Bread bread BREAD", "bread", true), [{ from: 6, to: 11 }])
assert.deepEqual(findMatches("the then other the", "the", false, true), [{ from: 0, to: 3 }, { from: 15, to: 18 }])
assert.deepEqual(findMatches("café décafé café2 _café café\u0301", "café", false, true), [{ from: 0, to: 4 }], "Unicode letters, numbers, underscores and combining marks belong to words")
assert.deepEqual(findMatches("🍞 𐐀 𐐨", "𐐨"), [{ from: 3, to: 5 }, { from: 6, to: 8 }], "Unicode case matching keeps UTF-16 editor offsets")
assert.deepEqual(findMatches("İ i I ı", "i"), [{ from: 2, to: 3 }, { from: 4, to: 5 }], "case folding never changes source offsets")
assert.deepEqual(findMatches("a.b a*b [x]", "a.b"), [{ from: 0, to: 3 }], "queries are literal, not regular expressions")
assert.deepEqual(findMatches("banana", "ana"), [{ from: 1, to: 4 }], "matches do not overlap, so every replacement is unambiguous")
assert.deepEqual(findMatches("aaa", "aa"), [{ from: 0, to: 2 }])
assert.deepEqual(findMatches("hello", ""), [])
assert.deepEqual(findMatches("", "hello"), [])
assert.deepEqual(findMatches("one\ntwo", "one\ntwo"), [{ from: 0, to: 7 }])
const text = "Before: the bread and the yeast. After."
const matches = findMatches(text, "the")
const edit = replacementEdit(text, matches, "$&")!
assert.equal(text.slice(0, edit.from) + edit.insert + text.slice(edit.to), "Before: $& bread and $& yeast. After.", "replacement text stays literal")
assert.equal(edit.from, 8)
assert.equal(edit.to, 25, "only the span from first to last match is edited")
assert.equal(replacementEdit(text, [], "x"), null)
assert.equal(replacementEdit("aaa", findMatches("aaa", "a"), "")?.insert, "", "Replace All can delete all matches")
console.log("find: ok")
