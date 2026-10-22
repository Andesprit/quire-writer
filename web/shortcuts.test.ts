import assert from "node:assert/strict"
import fs from "node:fs"
import { DOC_SHORTCUTS, HINTS, SHORTCUTS, docShortcut, filterShortcuts, keyCaps, keysForCommand, keyText, placeKey } from "./shortcuts.ts"

const ids = SHORTCUTS.map((s) => s.id)
assert.equal(new Set(ids).size, ids.length, "ids are unique")
for (const h of HINTS) assert.ok(ids.includes(h), "hint " + h)

// Each window-level row matches its own key press, and no other row.
const press = (key: string, shiftKey = false) => ({ key, shiftKey, metaKey: true, ctrlKey: false, altKey: false })
for (const { id, doc } of DOC_SHORTCUTS) {
  const shift = doc.shift === true
  assert.equal(docShortcut(press(doc.key.length === 1 ? doc.key.toUpperCase() : "Enter", shift)), id, id)
  for (const a of doc.also ?? []) assert.equal(docShortcut(press(a, shift)), id, id + " alias")
}
assert.equal(docShortcut({ ...press("p"), altKey: true }), undefined)
assert.equal(docShortcut({ ...press("p"), metaKey: false }), undefined)
assert.equal(docShortcut(press("/", false)), undefined, "Cmd+/ stays Comment out")
assert.equal(docShortcut(press("?", true)), "shortcuts")
assert.equal(docShortcut(press("b")), undefined)

// Text rows: the handlers that react to them still contain the key they are listed under.
const src = fs.readFileSync("main.ts", "utf8") + fs.readFileSync("format.ts", "utf8")
for (const s of SHORTCUTS) if ("src" in s) assert.ok(src.includes(s.src), `${s.id}: handler no longer contains ${s.src}`)
// The format keys the textarea handles are exactly the ones the table lists.
const formatKeys = [...fs.readFileSync("format.ts", "utf8").matchAll(/^  ("?[a-z/]+"?): \(sx\)/gm)].map((m) => m[1].replaceAll('"', ""))
assert.deepEqual(formatKeys.sort(), ["/", "b", "i"])
for (const [k, id] of [["b", "bold"], ["i", "italic"], ["/", "comment"]]) assert.equal(keyText(SHORTCUTS.find((s) => s.id === id)!, true), "⌘" + k.toUpperCase())

const om = SHORTCUTS.find((s) => s.id === "outline-move")!
assert.equal(keyText(om, false), "Alt+↑↓")
assert.equal(keyText(om, true), "⌥↑↓")
assert.equal(keysForCommand("sections", true), "⌘⇧O")
assert.equal(keysForCommand("sections", false), "Ctrl+⇧O")
assert.equal(keysForCommand("export", true), undefined)
assert.deepEqual(keyCaps(SHORTCUTS.find((s) => s.id === "commands")!, true), ["⌘", "⇧", "P"])
assert.deepEqual(keyCaps(SHORTCUTS.find((s) => s.id === "rename")!, true), ["F2"])
assert.deepEqual(keyCaps(SHORTCUTS.find((s) => s.id === "prev-problem")!, true), ["⇧", "F8"])
assert.deepEqual(keyCaps(SHORTCUTS.find((s) => s.id === "prev-problem")!, false), ["Shift+", "F8"])
assert.ok(filterShortcuts("find", true).length >= 4)
assert.ok(filterShortcuts("⇧p", true).some((s) => s.id === "commands"))
assert.equal(filterShortcuts("zzz", true).length, 0)
// Back and Forward: Cmd+[ ] on a Mac, Alt+Arrow elsewhere, and neither takes the other's keys.
const k = (key: string, o: object = {}) => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o })
assert.equal(placeKey(k("[", { metaKey: true }), true), "back")
assert.equal(placeKey(k("]", { metaKey: true }), true), "forward")
assert.equal(placeKey(k("ArrowLeft", { altKey: true }), true), undefined, "Alt+Left is a word jump on a Mac")
assert.equal(placeKey(k("ArrowLeft", { altKey: true }), false), "back")
assert.equal(placeKey(k("ArrowRight", { altKey: true }), false), "forward")
assert.equal(placeKey(k("-", { ctrlKey: true }), false), undefined, "Ctrl+- stays zoom")
assert.equal(placeKey(k("[", { ctrlKey: true }), false), undefined)
assert.equal(keysForCommand("back", true), "⌘[")
assert.equal(keysForCommand("back", false), "Alt+←")
assert.deepEqual(keyCaps(SHORTCUTS.find((s) => s.id === "forward")!, false), ["Alt+", "→"])
console.log("shortcuts ok")
