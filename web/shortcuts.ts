// Every shortcut in one table. The sheet, the command list's key text and the empty editor's
// hints are built from it; the document-level keys are also matched with it, so the handler
// and the text a writer reads cannot drift apart.
export type Press = { key: string; shift?: boolean | "any"; also?: string[] }
export type Shortcut = {
  id: string
  action: string
  group: string
  keys: string // "Mod" is Cmd (or Ctrl); a single character after it is a key
  win?: string // the keys off the Mac, when they are not the same keys with Ctrl
  cmd?: string // the command in the quick input that shows this key
  doc?: Press // handled for the whole window, from any focus
  src?: string // text the editor's own handlers must contain (checked by shortcuts.test.ts)
}

export const SHORTCUTS = [
  { id: "open-file", action: "Open a file", group: "Go to", keys: "ModP", doc: { key: "p", shift: false } },
  { id: "commands", action: "Run a command", group: "Go to", keys: "Mod⇧P", doc: { key: "p", shift: true } },
  { id: "search", action: "Search in project", group: "Go to", keys: "Mod⇧F", cmd: "search", doc: { key: "f", shift: true } },
  { id: "sections", action: "Go to section", group: "Go to", keys: "Mod⇧O", cmd: "sections", doc: { key: "o", shift: true } },
  { id: "label-prefix", action: "Go to label (type # in the open-a-file box)", group: "Go to", keys: "#" },
  { id: "rename-label", action: "Rename the label under the caret", group: "Go to", keys: "F2", cmd: "rename-label", src: '"F2"' },
  { id: "outline-move", action: "Move the focused Outline section up or down", group: "Go to", keys: "⌥↑↓", src: 'e.altKey && (e.key === "ArrowUp"' },
  { id: "next-problem", action: "Go to the next problem", group: "Go to", keys: "F8", cmd: "next-problem", src: '"F8"' },
  { id: "prev-problem", action: "Go to the previous problem", group: "Go to", keys: "⇧F8", win: "Shift+F8", cmd: "prev-problem", src: "stepProblems(" },
  { id: "back", action: "Go back to the previous place", group: "Go to", keys: "Mod[", win: "Alt+←", cmd: "back", src: "placeKey(" },
  { id: "forward", action: "Go forward to the next place", group: "Go to", keys: "Mod]", win: "Alt+→", cmd: "forward", src: "placeKey(" },
  { id: "save", action: "Save", group: "File", keys: "ModS", cmd: "save", doc: { key: "s", shift: false } },
  { id: "find", action: "Find in file", group: "Find", keys: "ModF", cmd: "find", src: 'key === "f"' },
  { id: "replace", action: "Find and replace", group: "Find", keys: "Mod⌥F", src: "openFind(e.altKey)" },
  { id: "find-next", action: "Next match", group: "Find", keys: "ModG", src: 'key === "g"' },
  { id: "find-prev", action: "Previous match", group: "Find", keys: "Mod⇧G", src: "stepFind(e.shiftKey" },
  { id: "bold", action: "Bold", group: "Writing", keys: "ModB", src: "FORMAT_KEYS[key]" },
  { id: "italic", action: "Italic", group: "Writing", keys: "ModI", src: "FORMAT_KEYS[key]" },
  { id: "comment", action: "Comment out", group: "Writing", keys: "Mod/", src: "FORMAT_KEYS[key]" },
  { id: "headings", action: "Heading level 0 to 4", group: "Writing", keys: "Mod⌥0–4", src: "heading >= 0" },
  { id: "ai", action: "Edit selection with AI", group: "Writing", keys: "ModK", src: 'key === "k"' },
  { id: "rewrite", action: "Rewrite menu, or apply the fix on an underline", group: "Writing", keys: "Mod.", src: 'e.key === "."' },
  { id: "accept", action: "Accept the suggestion", group: "Writing", keys: "Tab", src: 'e.key === "Tab"' },
  { id: "dismiss", action: "Dismiss a suggestion or card", group: "Writing", keys: "Esc", src: 'e.key === "Escape"' },
  { id: "chat", action: "Toggle chat", group: "Panels", keys: "ModJ", cmd: "chat", doc: { key: "j", shift: false } },
  { id: "preview", action: "Toggle preview", group: "Panels", keys: "Mod\\", cmd: "preview", doc: { key: "\\", shift: "any" } },
  { id: "sidebar", action: "Toggle explorer", group: "Panels", keys: "Mod⇧E", cmd: "sidebar", doc: { key: "e", shift: true } },
  { id: "focus", action: "Toggle focus mode", group: "Panels", keys: "Mod⇧↩", cmd: "focus", doc: { key: "enter", shift: true } },
  { id: "zoom-in", action: "Zoom in", group: "Panels", keys: "Mod+", cmd: "zoom-in", doc: { key: "=", shift: "any", also: ["+"] } },
  { id: "zoom-out", action: "Zoom out", group: "Panels", keys: "Mod−", cmd: "zoom-out", doc: { key: "-", shift: "any" } },
  { id: "zoom-reset", action: "Reset zoom", group: "Panels", keys: "Mod0", cmd: "zoom-reset", doc: { key: "0", shift: "any" } },
  { id: "shortcuts", action: "Keyboard shortcuts", group: "Help", keys: "Mod⇧/", cmd: "shortcuts", doc: { key: "/", shift: true, also: ["?"] } },
  { id: "rename", action: "Rename the selected file", group: "Explorer", keys: "F2", src: '"F2"' },
  { id: "trash", action: "Move the selected file to Trash", group: "Explorer", keys: "Mod⌫", src: '"Backspace"' },
] as const satisfies readonly Shortcut[]

export type DocShortcutId = Extract<(typeof SHORTCUTS)[number], { doc: Press }>["id"]
export const DOC_SHORTCUTS = SHORTCUTS.filter((s): s is Extract<(typeof SHORTCUTS)[number], { doc: Press }> => "doc" in s)

export type KeyLike = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

// The window-level shortcut this key press is, if any.
export function docShortcut(e: KeyLike): DocShortcutId | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const key = e.key.toLowerCase()
  return DOC_SHORTCUTS.find(({ doc }) => {
    const press: Press = doc
    return (key === press.key || press.also?.includes(key)) && (press.shift === "any" || !!press.shift === e.shiftKey)
  })?.id
}

export const modKey = (mac: boolean) => (mac ? "⌘" : "Ctrl+")
export const keyText = (s: Shortcut, mac: boolean) => (mac ? s.keys : s.win ?? s.keys).replace("Mod", modKey(mac))

// Back and Forward are not window shortcuts above: Ctrl+[ is left to the text, and Alt+Arrow is a
// word jump on a Mac, so the Mac keys are Cmd+[ and Cmd+], the others Alt+Left and Alt+Right.
export function placeKey(e: KeyLike & { code?: string }, mac: boolean): "back" | "forward" | undefined {
  if (e.shiftKey) return
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === "[" || e.code === "BracketLeft") return "back"
    if (e.key === "]" || e.code === "BracketRight") return "forward"
    return
  }
  if (!e.altKey || e.metaKey || e.ctrlKey) return
  return e.key === "ArrowLeft" ? "back" : e.key === "ArrowRight" ? "forward" : undefined
}
// "⌘⇧P" as ["⌘", "⇧", "P"] for kbd boxes; Tab, Esc, F2 and Ctrl+ stay whole.
export const keyCaps = (s: Shortcut, mac: boolean) => keyText(s, mac).match(/Ctrl\+|Alt\+|Shift\+|Tab|Esc|F\d|[^]/gu) ?? []

export const shortcutFor = (id: string) => SHORTCUTS.find((s) => s.id === id)
export const keysForCommand = (cmd: string, mac: boolean) => {
  const s = SHORTCUTS.find((s) => "cmd" in s && s.cmd === cmd)
  return s ? keyText(s, mac) : undefined
}

// What the sheet shows for a search: every word must appear in the action, group or keys.
export function filterShortcuts(query: string, mac: boolean): readonly Shortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return SHORTCUTS.filter((s) => {
    const hay = (s.action + " " + s.group + " " + keyText(s, mac)).toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// The empty editor's hints, in order.
export const HINTS = ["open-file", "commands", "search", "sections", "find", "focus", "ai", "preview"] as const
