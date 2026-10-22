import "@vscode/codicons/dist/codicon.css"
import "@fontsource/ia-writer-quattro/400.css"
import "@fontsource/ia-writer-quattro/400-italic.css"
import "@fontsource/ia-writer-quattro/700.css"
import "@fontsource/ia-writer-quattro/700-italic.css"
import { Chunk } from "@codemirror/merge"
import { highlightHTML, highlightLine, langOf, startState, sameState, type Lang, type State } from "./highlight"
import { suggestKeys, keySpan } from "./suggestkeys"
import { fixFor, planEdit, type Fix as ErrorFix } from "./errorfix"
import { diagnosticRange, errorCount, missingTool, isCurrentDiagnostic, shiftDiagnostics, type Diagnostic, type DiagnosticBatch } from "./diagnostics"
import { findMatches, replacementEdit, type Match } from "./find"
import { fuzzyMatch, rankFiles } from "./palette"
import { headingTitle, outline, type Heading } from "./outline"
import { moveSection, shiftSection } from "./sections"
import { refChoices, refTrigger, type RefChoice, type RefTrigger } from "./refcomplete"
import { diff, minimalChange, rebase, type Diff } from "./merge"
import { $, ask, esc, fileIcon, icon, toast } from "./ui"
import { FORMAT_KEYS, buildFormatBar, connectEditor, insertAt, select, setHeading, syntaxOf } from "./format"
import { figureSnippet } from "./figure"
import { changeCount, diffLines, whenText, type Line } from "./history"
import { MAX_GOAL, goalProgress, parseGoal, readGoal, type Goal } from "./goal"
import { goBack, goForward, leave, newTrail, rename as renameTrail, type Place } from "./places"
import { HINTS, SHORTCUTS, docShortcut, filterShortcuts, keyCaps, keysForCommand, keyText, placeKey, shortcutFor, type DocShortcutId, type Shortcut } from "./shortcuts"
import { labelAt, labelProblem, nameProblem } from "./names"
import { elsewhere, gatherProblems, problemLines, projectProblems, stepProblem, type Problem } from "./preflight"
import { changes, paragraphs, readFixes, type Fix } from "./suggest"
import { add, connectChat, onFolderOpened, onPermission, onTurnEnd, onTurnStart, onUpdate, renderChips, running, setAgentReady } from "./chat"

// The product name: change it here only.
const APP_NAME = "Quire"

const app = $("app")
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} },
  del: (k: string) => { try { localStorage.removeItem(k) } catch {} },
}

// ---------- messages to the app (Tauri's own; replies come as "message" events) ----------

const tauri = (window as any).__TAURI__
// Every message names the folder this page shows; the app refuses file changes for any other.
const send = (msg: object) => {
  tauri.core.invoke("message", { msg: { ...msg, root } }).catch((e: unknown) => toast(String(e)))
}

// ---------- theme ----------

// VS Code's two themes (style.css) and Quire's own (themes.css). With no choice stored, follow the system.
const THEMES = [
  ["dark", "VS Code Dark Modern"],
  ["light", "VS Code Light Modern"],
  "-",
  ["quire-series", "Quire Series"],
  ["quire-galley", "Quire Galley"],
  ["quire-coupon", "Quire Coupon"],
  ["quire-slate", "Quire Slate"],
] as const
const systemLight = matchMedia("(prefers-color-scheme: light)")
const applyTheme = () => {
  document.documentElement.dataset.theme = store.get("theme") ?? (systemLight.matches ? "light" : "dark")
}
applyTheme()
systemLight.addEventListener("change", applyTheme)
$("theme").onclick = () => {
  const chosen = store.get("theme")
  const pick = (id: string | null) => {
    if (id) store.set("theme", id)
    else store.del("theme")
    applyTheme()
  }
  const r = $("theme").getBoundingClientRect()
  showMenu(r.right + 4, r.top, [
    { label: "Follow system", keys: chosen ? "" : "Current", run: () => pick(null) },
    "-",
    ...THEMES.map((t) => (t === "-" ? t : { label: t[1], keys: chosen === t[0] ? "Current" : "", run: () => pick(t[0]) })),
  ])
}

// ---------- layout: panels, sashes, shortcuts ----------

const panels = { sidebar: "no-sidebar", preview: "no-preview", chat: "no-chat" } as const
type Panel = keyof typeof panels
const defaults: Record<Panel, boolean> = { sidebar: true, preview: true, chat: false }

// Focus mode closes the panels without touching the saved layout, so a reload or quit in it
// comes back normal. Opening a panel by hand ends it.
let focusSaved: Record<Panel, boolean> | null = null
let leavingFocus = false
function setPanel(p: Panel, open: boolean) {
  if (open && focusSaved && !leavingFocus) toggleFocus()
  app.classList.toggle(panels[p], !open)
  if (!focusSaved) store.set(`panel.${p}`, open ? "1" : "0")
  $(`toggle-${p}`).setAttribute("aria-pressed", String(open))
  if (p === "sidebar") {
    const searching = sidebar.classList.contains("searching")
    $("act-explorer").classList.toggle("active", open && !searching)
    $("act-search").classList.toggle("active", open && searching)
  }
  if (p === "chat") $("act-chat").classList.toggle("active", open)
  scheduleRender() // the text column may have changed width
}
const isOpen = (p: Panel) => !app.classList.contains(panels[p])
const togglePanel = (p: Panel) => setPanel(p, !isOpen(p))
function toggleFocus() {
  const all = Object.keys(panels) as Panel[]
  if (focusSaved) {
    const saved = focusSaved
    leavingFocus = true
    for (const p of all) setPanel(p, saved[p]) // still in focus mode here: nothing is written
    leavingFocus = false
    focusSaved = null
    app.classList.remove("focus")
    ta.focus({ preventScroll: true })
  } else {
    focusSaved = { sidebar: isOpen("sidebar"), preview: isOpen("preview"), chat: isOpen("chat") }
    for (const p of all) setPanel(p, false)
    app.classList.add("focus")
    if (current && mode === "edit") ta.focus({ preventScroll: true })
  }
  paintWords()
}

function openChat() {
  setPanel("chat", true)
  $("chat-input").focus()
}
const sidebar = $("sidebar")
// The sidebar shows the explorer or the search results; its button leaves the search first.
function showExplorer() {
  sidebar.classList.remove("searching")
  $("pane-name").textContent = "Explorer"
  $("act-search").classList.remove("active")
  $("act-explorer").classList.toggle("active", isOpen("sidebar"))
}
$("toggle-sidebar").onclick = $("act-explorer").onclick = () => {
  if (sidebar.classList.contains("searching") && isOpen("sidebar")) showExplorer()
  else togglePanel("sidebar")
}
$("act-search").onclick = () => (sidebar.classList.contains("searching") && isOpen("sidebar") ? setPanel("sidebar", false) : openSearch())
$("toggle-preview").onclick = $("open-preview-side").onclick = () => togglePanel("preview")
$("close-preview").onclick = () => setPanel("preview", false)
$("toggle-chat").onclick = $("act-chat").onclick = $("close-chat").onclick = () => togglePanel("chat")
// When the agent is not running in an open folder, a click starts it.
$("sb-agent").onclick = () => (root && agentState === "none" ? send({ type: "set_agent", id: agentId }) : openChat())

// Cmd+= and Cmd+- make the whole window larger or smaller, previews too, as in VS Code.
// Cmd+0 goes back to normal size.
let zoom = Number(store.get("zoom")) || 1
function setZoom(z: number) {
  zoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10))
  store.set("zoom", String(zoom))
  tauri.webview.getCurrentWebview().setZoom(zoom)
}
if (zoom !== 1) setZoom(zoom)

const DOC_KEYS: Record<DocShortcutId, (e: KeyboardEvent) => void> = {
  focus: () => toggleFocus(),
  "open-file": () => openPalette(),
  commands: () => openPalette(">"),
  sections: () => openPalette("@"),
  save: () => flushSave(true),
  sidebar: () => {
    if (sidebar.classList.contains("searching") && isOpen("sidebar")) showExplorer()
    else togglePanel("sidebar")
  },
  search: () => openSearch(),
  preview: () => togglePanel("preview"),
  chat: () => {
    if (isOpen("chat") && document.activeElement === $("chat-input")) {
      setPanel("chat", false)
      ta.focus()
    } else openChat()
  },
  "zoom-in": () => setZoom(zoom + 0.1),
  "zoom-out": () => setZoom(zoom - 0.1),
  "zoom-reset": () => setZoom(1),
  shortcuts: () => openShortcuts(),
}
document.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || palette.open) return
    const nav = placeKey(e, mac)
    if (nav && (e.target === ta || !(e.target as HTMLElement).closest?.("input, textarea"))) {
      e.preventDefault()
      e.stopPropagation()
      return void goPlace(nav)
    }
    if (e.key === "F8" && !e.metaKey && !e.ctrlKey && !e.altKey && root) {
      e.preventDefault()
      e.stopPropagation()
      return stepProblems(e.shiftKey ? -1 : 1)
    }
    const id = docShortcut(e)
    // Cmd+B and Cmd+I are bold and italic in the text; Chrome keeps Cmd+L for itself.
    if (!id) return
    DOC_KEYS[id](e)
    e.preventDefault()
    e.stopPropagation()
  },
  true,
)

// Escape leaves focus mode only when nothing else wanted it. What is open is read before any
// other handler runs (capture), because most of them close their thing without preventDefault.
let escapeFree = false
const OVERLAYS = ["problems", "find-box", "inline-box", "diagnostic-card", "rewrite-menu", "rewrite-card", "fix-card", "ref-list", "ctx-menu"]
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") escapeFree = !document.querySelector("dialog[open]") && !ghost && !cardMark && OVERLAYS.every((id) => $(id).hidden)
}, true)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focusSaved && escapeFree && !e.defaultPrevented && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault()
    toggleFocus()
  }
})

for (const sash of document.querySelectorAll<HTMLElement>(".sash")) {
  sash.onpointerdown = (e) => {
    const kind = sash.dataset.sash
    const startX = e.clientX
    const sidebarW = $("sidebar").offsetWidth
    const chatW = $("chat").offsetWidth
    const editorW = $("editor-group").offsetWidth
    const previewW = $("preview-group").offsetWidth
    sash.setPointerCapture(e.pointerId)
    sash.classList.add("dragging")
    document.body.classList.add("resizing")
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    sash.onpointermove = (m) => {
      const dx = m.clientX - startX
      if (kind === "sidebar") app.style.setProperty("--sidebar-w", `${clamp(sidebarW + dx, 170, 480)}px`)
      if (kind === "chat") app.style.setProperty("--chat-w", `${clamp(chatW - dx, 300, 680)}px`)
      if (kind === "preview") {
        const total = editorW + previewW
        const pv = clamp(previewW - dx, 220, total - 280)
        app.style.setProperty("--preview-fr", `${(pv / (total - pv)).toFixed(3)}fr`)
      }
      scheduleRender()
    }
    sash.onpointerup = () => {
      sash.onpointermove = sash.onpointerup = null
      sash.classList.remove("dragging")
      document.body.classList.remove("resizing")
      for (const k of ["sidebar-w", "chat-w", "preview-fr"]) {
        const v = app.style.getPropertyValue(`--${k}`)
        if (v) store.set(k, v)
      }
    }
  }
}

// ---------- editor: a plain text field (so Grammarly works) with colors drawn behind it ----------

const ta = $<HTMLTextAreaElement>("text")
const hl = $("hl")
const rv = $("review-view")
let current: string | null = null // open file path
let lang: Lang = "text" // the language of the open file
const syntax = () => syntaxOf(lang) // its markup; none for plain text
let baseline: string | null = null // the text before unreviewed changes
let chunks: readonly Chunk[] = []
let diffed: Diff | null = null // what `chunks` was worked out from
let mode: "edit" | "review" = "edit"
let focusChunk = 0
let lineStarts: number[] = [0]
let docVersion = 0
let programmatic = false // an edit made by the app, not by typing
let fromDisk = false // an edit that came from the agent or another program
let lastTyped = 0
let saveTimer = 0
let saved = "" // the text as it is on disk
// Saves sent, by request: each waits for the app to answer that the disk has its text, or why not.
const saving = new Map<number, { path: string; text: string; done: (error: string) => void }>()
let saveError: HTMLElement | null = null // the notice about the open file's failed save
let leaving = 0 // the request replacing the open text: typing waits for its answer
let holdSave = false // a disk conflict is waiting for the writer's choice
let autosave = store.get("autosave") !== "off"

function lineOf(pos: number) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

let renderQueued = false
function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

let shown: string[] = [] // the lines the colored layer shows now
let states: State[] = [] // highlighting state at the start of each shown line

// Start the colored layer from scratch (a different file).
function resetLayer() {
  shown = []
  states = []
  hl.textContent = ""
}

// Redraw only the lines that changed. Lines after them are recolored only while an open
// math or raw block carries over; a 2,000-line thesis stays fast to type in.
function paintLines(next: string[]) {
  hl.querySelector(".ghost-line")?.remove()
  let p = 0
  while (p < shown.length && p < next.length && shown[p] === next[p]) p++
  let q = 0
  while (q < shown.length - p && q < next.length - p && shown[shown.length - 1 - q] === next[next.length - 1 - q]) q++
  const delta = next.length - shown.length
  const st = p < states.length ? { ...states[p] } : startState()
  const fresh: State[] = []
  const html: string[] = []
  let i = p
  for (; i < next.length; i++) {
    if (i >= next.length - q && sameState(states[i - delta], st)) break
    fresh.push({ ...st })
    html.push(`<div class="ln">${highlightLine(next[i], st, lang) || "<br>"}</div>`)
  }
  const keepFrom = i - delta // first old line that stays as it is
  for (let k = keepFrom - 1; k >= p; k--) hl.children[k].remove()
  const tpl = document.createElement("template")
  tpl.innerHTML = html.join("")
  hl.insertBefore(tpl.content, hl.children[p] ?? null)
  states = states.slice(0, p).concat(fresh, states.slice(keepFrom))
  shown = next
}

function render() {
  const text = ta.value
  const next = text.split("\n")
  lineStarts = new Array(next.length)
  for (let k = 0, at = 0; k < next.length; k++) {
    lineStarts[k] = at
    at += next[k].length + 1
  }
  chunks = baseline == null ? [] : (diffed = diff(baseline, text, diffed)).chunks
  if (baseline != null && chunks.length === 0) {
    // Every change was accepted or rejected.
    baseline = null
    setMode("edit")
    scheduleSave()
  }
  paintLines(next)
  for (const el of hl.querySelectorAll(".ln.added, .ln.modified, .ln.deleted-above")) el.classList.remove("added", "modified", "deleted-above")
  for (const c of chunks) {
    if (c.fromB === c.toB) hl.children[lineOf(c.fromB)]?.classList.add("deleted-above")
    else for (let l = lineOf(c.fromB); l <= lineOf(Math.max(c.fromB, c.endB)); l++) hl.children[l]?.classList.add(c.fromA === c.toA ? "added" : "modified")
  }
  markActive()
  hl.scrollTop = ta.scrollTop
  placeGhost()
  paintIssues()
  paintDiagnostics()
  queueFindPaint()
  scheduleCheck()
  if (previewKind === "markdown") sendMarkdown()
  sendTyped()
  if (mode === "review") renderReview()
  updateReviewUI()
  updateInfo()
}

function markActive() {
  const active = lineOf(ta.selectionStart)
  hl.querySelector(".ln.active")?.classList.remove("active")
  hl.children[active]?.classList.add("active")
}

// Replace a range the way typing would, so the text field's own undo still works.
function edit(from: number, to: number, text: string, disk = false) {
  if (ta.readOnly && !disk) return // the open text is being replaced: see holdTyping
  const keep = { start: ta.selectionStart, end: ta.selectionEnd, scroll: ta.scrollTop, focus: document.activeElement }
  programmatic = true
  fromDisk = disk
  ta.focus({ preventScroll: true })
  ta.setSelectionRange(from, to)
  const ok = text ? document.execCommand("insertText", false, text) : from === to || document.execCommand("delete")
  if (!ok) {
    ta.setRangeText(text, from, to, "end")
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertReplacementText" }))
  }
  programmatic = false
  fromDisk = false
  if (disk) {
    // Agent edits must not move the writer's caret, scroll or focus.
    const delta = text.length - (to - from)
    const map = (p: number) => (p <= from ? p : p >= to ? p + delta : from + text.length)
    ta.setSelectionRange(map(keep.start), map(keep.end))
    ta.scrollTop = keep.scroll
    if (keep.focus instanceof HTMLElement && keep.focus !== ta) keep.focus.focus({ preventScroll: true })
  }
}

ta.addEventListener("input", (e) => {
  docVersion++
  shiftDiagnosticsForTyping()
  ghost = null
  closeCard()
  menu.hidden = true
  scheduleRender()
  scheduleOutline()
  if (!fromDisk) scheduleSave()
  scheduleFind()
  if (!programmatic) {
    lastTyped = Date.now()
    if ((e as InputEvent).inputType?.startsWith("insert")) scheduleComplete()
  }
})
ta.addEventListener("scroll", () => {
  hl.scrollTop = ta.scrollTop
  queueFindPaint()
  showDiagnosticAtCaret()
  closeCard()
  menu.hidden = true
  if (rw) floatAt(rwCard, rw.from, rw.to)
})
// macOS "smart quotes and dashes" rewrite the word before the caret after every insert, so
// `"en")` became `“en")` and `-->` became `—>`: in typing, the format bar's markup and agent
// changes alike. Markup needs the characters as written; Typst and LaTeX make curly ones.
ta.addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertReplacementText" && /^[‘’“”–—]+$/.test(e.data ?? "")) e.preventDefault()
})
const onCaret = () => {
  if (ghost && (ta.selectionStart !== ghost.pos || ta.selectionEnd !== ghost.pos)) clearGhost()
  const pos = ta.selectionStart
  if (cardMark && !(ta.selectionEnd === pos && cardMark.from <= pos && pos <= cardMark.to)) closeCard()
  if (refOpen && ta.selectionStart !== refOpen.caret) closeRefs()
  scheduleMenu()
  markActive()
  markOutlineHere()
  scheduleInfo()
  followCaret()
  showDiagnosticAtCaret()
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === ta) onCaret()
})
ta.addEventListener("select", onCaret)
// ---------- reference completion: labels and citation keys under the caret ----------

const refList = $("ref-list")
let cites: string[] = [] // every citation key of the project's .bib files
let refOpen: { t: RefTrigger; items: RefChoice[]; sel: number; caret: number } | null = null
const closeRefs = () => {
  refOpen = null
  refList.hidden = true
}
function updateRefs() {
  const caret = ta.selectionStart
  const t = mode === "edit" && caret === ta.selectionEnd ? refTrigger(ta.value.slice(0, caret), lang) : null
  const items = t ? refChoices(t, labels.map((l) => l.name), cites) : []
  if (!t || !items.length) return closeRefs()
  refOpen = { t, items, sel: 0, caret }
  paintRefs()
}
function paintRefs() {
  if (!refOpen) return
  refList.innerHTML = refOpen.items
    .map((c, i) => `<div class="ref-row${i === refOpen!.sel ? " sel" : ""}" data-i="${i}"><span class="ref-key">${esc(c.key)}</span><span class="ref-tag">${c.tag}</span></div>`)
    .join("")
  refList.hidden = false
  floatAt(refList, refOpen.caret, refOpen.caret)
}
function acceptRef(i: number) {
  const r = refOpen!
  const caret = ta.selectionStart
  closeRefs()
  // The closing mark goes in only when the writer has not typed it.
  const close = r.t.close && !"},>".includes(ta.value[caret] ?? " ") ? r.t.close : ""
  edit(r.t.replaceFrom, caret, r.items[i].key + close)
}
// While the list is open it owns these keys; closed, it never sees them.
ta.addEventListener("keydown", (e) => {
  if (!refOpen || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  const k = e.key
  if (k === "Tab" || k === "Enter") acceptRef(refOpen.sel)
  else if (k === "Escape") closeRefs()
  else if (k === "ArrowDown" || k === "ArrowUp") {
    refOpen.sel = (refOpen.sel + (k === "ArrowDown" ? 1 : refOpen.items.length - 1)) % refOpen.items.length
    paintRefs()
  } else return
  e.preventDefault()
  e.stopImmediatePropagation()
})
ta.addEventListener("input", () => (programmatic ? closeRefs() : updateRefs()))
ta.addEventListener("blur", closeRefs)
ta.addEventListener("scroll", closeRefs)
refList.onmousedown = (e) => e.preventDefault() // keep the caret in the text
refList.onclick = (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".ref-row")
  if (row && refOpen) acceptRef(Number(row.dataset.i))
}

ta.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  const heading = /^Digit[0-4]$/.test(e.code) ? Number(e.code.slice(5)) : -1
  const sx = syntax()
  if (mod && !e.shiftKey && !e.altKey && sx && FORMAT_KEYS[key]) {
    e.preventDefault()
    FORMAT_KEYS[key](sx)
  } else if (mod && e.altKey && heading >= 0 && sx) {
    e.preventDefault()
    setHeading(sx, heading)
  } else if (mod && key === "k") {
    e.preventDefault()
    openInline()
  } else if (mod && e.key === ".") {
    // On a selection, the rewrite menu; on an underline, its fix.
    e.preventDefault()
    if (ta.selectionStart === ta.selectionEnd) openCard(true)
    else if (placeMenu()) menu.querySelector("button")!.focus()
  } else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // Tab accepts a suggestion or indents. Shift+Tab still leaves the editor.
    e.preventDefault()
    if (ghost && ta.selectionStart === ghost.pos && ta.selectionEnd === ghost.pos) {
      const g = ghost
      clearGhost()
      edit(g.pos, g.pos, g.text)
    } else edit(ta.selectionStart, ta.selectionEnd, "  ")
  } else if (e.key === "Escape" && ghost) {
    e.preventDefault()
    clearGhost()
  } else if (e.key === "Escape" && cardMark) {
    e.preventDefault()
    closeCard()
  }
})
new ResizeObserver(scheduleRender).observe($("editor"))

function scheduleSave() {
  clearTimeout(saveTimer)
  updateDirty()
  if (holdSave) return
  // With auto save off, review decisions are still remembered; the text waits for Cmd+S.
  saveTimer = window.setTimeout(() => (autosave ? flushSave() : sendReview()), 400)
}

// While a disk conflict waits for the writer, only Cmd+S and "Keep mine" (force) save.
// Resolves with why the save failed, or "" (saved, or nothing to report).
function flushSave(force = false): Promise<string> {
  clearTimeout(saveTimer)
  if ((holdSave && !force) || !current) return Promise.resolve("")
  holdSave = false
  const req = ++reqSeq
  const answer = new Promise<string>((done) => saving.set(req, { path: current!, text: ta.value, done }))
  send({ type: "save", req, path: current, content: ta.value, baseline })
  return answer
}

const sendReview = () => current && send({ type: "review", path: current, baseline })
const isDirty = () => !!current && ta.value !== saved
let baseTitle = APP_NAME

function updateDirty() {
  const dirty = !autosave && isDirty()
  $("tab").classList.toggle("dirty", dirty)
  document.title = (dirty ? "\u25cf " : "") + baseTitle
}

// Typing waits while the open text is being replaced, so nothing typed meanwhile can be lost.
function holdTyping(on: boolean) {
  ta.readOnly = on
  if (!on) leaving = 0
}

// Before another file or folder replaces the open text. True once the disk has the text or the
// writer chose Don't Save; false means they stay. Typing waits from here: see leaveThen.
async function leaveCurrent(): Promise<boolean> {
  holdTyping(true)
  let answer = autosave && !holdSave ? "save" : ""
  while (current && isDirty()) {
    const name = baseName(current)
    answer ||= await ask(`Save changes to ${name}?`, "If you don't save, your changes since the last save are lost.")
    if (answer === "discard") {
      clearTimeout(saveTimer)
      ta.value = saved
      invalidateDiagnostics()
      render()
      updateDirty()
      break
    }
    if (answer !== "save") {
      if (!leaving) holdTyping(false)
      return false
    }
    const error = await flushSave(true)
    answer = error
      ? (await ask(`${name} was not saved`, `${error} Your changes are still here. Save tries again. Don't Save drops them.`)) || "cancel" // Escape stays
      : autosave && !holdSave ? "save" : ""
  }
  return true
}

// Open another file, a new file or another folder once the open text is safe. Typing waits
// for the app's answer to this request ("done" or an error), not for a timer.
async function leaveThen(msg: object) {
  const ok = await leaveCurrent()
  // A fix waits only for the file it asked for: opening anything else drops it.
  if (ok && pendingFix && (msg as { path?: string }).path !== pendingFix.path) pendingFix = null
  if (ok) send({ ...msg, req: (leaving = ++reqSeq) })
  return ok
}

let conflict: HTMLElement | null = null // the question about a disk change where the writer typed

// The open file changed on disk (the agent, another program, a restore).
function onDiskChange(content: string, base: string | null) {
  if (!isDirty()) {
    applyContent(content, base)
    saved = content
    return updateDirty()
  }
  // Unsaved typing and a change on disk: keep both when they touch different places.
  const change = rebase(saved, ta.value, content)
  if (change) {
    applyContent(content, base, change)
    saved = content
    return scheduleSave()
  }
  // Same place: the writer decides. Nothing is saved until then.
  clearTimeout(saveTimer)
  holdSave = true
  const name = baseName(current!)
  conflict?.remove()
  conflict = toast(`${name} changed on disk where you have unsaved changes.`, "error", [
    {
      label: "Use the disk version",
      run: () => {
        holdSave = false
        applyContent(content, base)
        saved = content
        updateDirty()
      },
    },
    {
      label: "Keep mine",
      run: () => {
        saved = content
        holdSave = false
        if (autosave) flushSave(true)
        updateDirty()
      },
    },
  ])
}

// New content from disk (`c` is how the text changes). With a baseline, the difference
// becomes changes to review.
function applyContent(content: string, base: string | null, c = minimalChange(ta.value, content)) {
  if (base == null) baseline = null
  else if (baseline == null) baseline = base
  if (c.from !== c.to || c.insert) edit(c.from, c.to, c.insert, true)
  // Open the review view, unless the writer is typing right now.
  if (baseline != null && Date.now() - lastTyped > 2000) setMode("review")
  scheduleRender()
}

// The open file changes: nothing meant for the old one (a suggestion, an edit or a citation
// on its way, a disk conflict) may land in the new one.
function dropFileState() {
  closeFind(false)
  clearGhost()
  closeCard()
  $("diagnostic-card").hidden = true
  closeRewrite()
  menu.hidden = true
  holdSave = false
  saveError?.remove()
  conflict?.remove()
  inlineWant = acWant = null
  box.hidden = true
  acBusy = false
  renderAcStatus()
}

// Only after leaveCurrent: the open text is on disk or dropped by the writer.
function openFile(path: string, content: string, base: string | null) {
  const from = current && current !== path ? here() : null
  savePos()
  dropFileState()
  current = path
  rememberFile(path)
  lang = langOf(path)
  baseline = base
  ta.value = content // a new file starts a fresh undo history
  resetLayer()
  saved = content
  ta.setSelectionRange(0, 0)
  ta.scrollTop = 0
  setMode(base != null ? "review" : "edit")
  render()
  const jump = pendingJump?.path === path ? pendingJump : null
  const spot = jump || base != null ? null : loadPos()[path]
  if (spot) restorePos(spot)
  if (from && jump?.track !== false) leave(trail, from, { path, line: jump?.line ?? spot?.line ?? 0, col: jump?.col ?? spot?.col ?? 0 })
  renderTree()
  renderTab()
  renderLabels() // its hint is for this file's language
  renderOutline()
  // Take the keyboard only if the writer is not typing somewhere else (a name box, the chat).
  const busy = document.activeElement?.matches("input, textarea, select") && document.activeElement !== ta
  if (mode === "edit" && !busy) ta.focus({ preventScroll: true })
  // Typst previews main.typ when there is one, and LaTeX its main file (the app finds it).
  const target = lang === "text" ? null : lang === "typst" && files.includes("main.typ") ? "main.typ" : path
  if (target && target !== previewing) {
    previewing = target
    requestPreview(target)
  }
  if (jump) goTo(path, jump.line, jump.col, jump.utf16, jump.len, false)
  if (historyFor === path) openHistory(path)
}

function closeFile(message?: string) {
  dropFileState()
  current = null
  baseline = null
  ta.value = ""
  saved = ""
  setMode("edit")
  render()
  renderTab()
  renderOutline()
  if (message) toast(message, "info")
}

// ---------- track changes: review view ----------

function setMode(m: "edit" | "review") {
  if (m === "review" && baseline == null) m = "edit"
  mode = m
  rv.hidden = m !== "review"
  for (const c of $("format-bar").querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) c.disabled = m === "review"
  if (m === "review") {
    closeFind(false)
    clearGhost()
    renderReview()
  }
  updateReviewUI()
}

function renderReview() {
  const doc = ta.value
  const base = baseline ?? ""
  const scroll = rv.scrollTop
  const plain = (s: string) => highlightHTML(s.replace(/\n$/, ""), lang)
  let out = ""
  let pos = 0
  chunks.forEach((c, i) => {
    out += plain(doc.slice(pos, c.fromB))
    let inner = ""
    let at = c.fromB
    for (const ch of c.changes) {
      const fb = c.fromB + ch.fromB
      const tb = c.fromB + ch.toB
      inner += esc(doc.slice(at, fb))
      if (ch.toA > ch.fromA) inner += `<del>${esc(base.slice(c.fromA + ch.fromA, c.fromA + ch.toA))}</del>`
      if (tb > fb) inner += `<ins>${esc(doc.slice(fb, tb))}</ins>`
      at = tb
    }
    inner += esc(doc.slice(at, c.endB))
    out +=
      `<div class="chunk${i === focusChunk ? " focused" : ""}" data-i="${i}">` +
      `<div class="chunk-bar"><span>Change ${i + 1} of ${chunks.length}</span>` +
      `<button class="btn secondary sm" data-act="reject" data-i="${i}">${icon("discard")}Reject</button>` +
      `<button class="btn primary sm" data-act="accept" data-i="${i}">${icon("check")}Accept</button></div>` +
      `<div>${inner.replace(/\n$/, "")}</div></div>`
    pos = Math.min(doc.length, c.toB)
  })
  out += plain(doc.slice(pos))
  rv.innerHTML = out
  rv.scrollTop = scroll
}

function acceptChunk(i: number) {
  const c = chunks[i]
  const base = baseline
  if (!c || base == null) return
  const doc = ta.value
  let insert = doc.slice(c.fromB, Math.max(c.fromB, c.toB - 1))
  if (c.fromB !== c.toB && c.toA <= base.length) insert += "\n"
  baseline = base.slice(0, c.fromA) + insert + base.slice(Math.min(base.length, c.toA))
  focusChunk = Math.max(0, Math.min(i, chunks.length - 2))
  render()
  scheduleSave()
}

function rejectChunk(i: number) {
  const c = chunks[i]
  const base = baseline
  if (!c || base == null) return
  const doc = ta.value
  let insert = base.slice(c.fromA, Math.max(c.fromA, c.toA - 1))
  if (c.fromA !== c.toA && c.toB <= doc.length) insert += "\n"
  focusChunk = Math.max(0, Math.min(i, chunks.length - 2))
  edit(c.fromB, Math.min(doc.length, c.toB), insert)
  render()
}

rv.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-act]")
  if (!b) return
  const i = Number(b.dataset.i)
  if (b.dataset.act === "accept") acceptChunk(i)
  else rejectChunk(i)
  rv.querySelector<HTMLElement>(`.chunk[data-i="${focusChunk}"] button[data-act="accept"]`)?.focus({ preventScroll: true })
})

function goToChunk(step: number) {
  if (!chunks.length) return
  focusChunk = (focusChunk + step + chunks.length) % chunks.length
  if (mode === "review") {
    renderReview()
    const el = rv.querySelector<HTMLElement>(`.chunk[data-i="${focusChunk}"]`)
    el?.scrollIntoView({ block: "center" })
    el?.querySelector<HTMLElement>('button[data-act="accept"]')?.focus({ preventScroll: true })
  } else {
    const pos = chunks[focusChunk].fromB
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(pos, pos)
    const line = hl.children[lineOf(pos)] as HTMLElement | undefined
    if (line) ta.scrollTop = Math.max(0, line.offsetTop - 60)
  }
  updateReviewUI()
}

function updateReviewUI() {
  const n = chunks.length
  $("review-bar").hidden = !n
  if (n) {
    focusChunk = Math.min(focusChunk, n - 1)
    $("review-count").textContent = mode === "review" ? `${focusChunk + 1} of ${n}` : `${n} change${n > 1 ? "s" : ""}`
    $("review-toggle").innerHTML = mode === "review" ? `${icon("edit")} Edit text` : `${icon("diff")} Show changes`
  }
  const undo = $("undo-op")
  undo.hidden = !(n && lastOp && current && lastOp.paths.includes(current))
  if (lastOp) undo.textContent = `Undo this ${lastOp.kind} in all files`
  renderReviewStatus()
}

$("review-toggle").onclick = () => {
  setMode(mode === "review" ? "edit" : "review")
  if (mode === "edit") ta.focus()
}
$("accept-all").onclick = () => {
  baseline = null
  setMode("edit")
  render()
  scheduleSave()
  ta.focus()
}
// The newest rename or replace across files, which one click can undo while it is the latest.
let lastOp: { id: number; kind: "replace" | "rename"; paths: string[] } | null = null
let undoing = false
let opToast: HTMLElement | null = null // the notice with the Undo button: gone once the undo ran

async function undoOperation() {
  if (!lastOp || undoing) return
  undoing = true
  // The open text goes to disk first, and typing waits until the app answers.
  holdTyping(true)
  const error = await flushSave(true)
  if (error) {
    holdTyping(false)
    undoing = false
    toast(`Nothing was undone: ${baseName(current!)} could not be saved first.`)
    return
  }
  send({ type: "undo_operation", req: (leaving = ++reqSeq), op: lastOp.id })
}

// The app answered (or failed): typing is free again.
function undone(r: { ok: boolean; restored: string[]; skipped: string[]; error: string }, kind: string) {
  undoing = false
  opToast?.remove()
  if (!r.ok) {
    lastOp = null // the app forgot it: its answer says why
    updateReviewUI()
    return toast(r.error)
  }
  lastOp = null
  updateReviewUI()
  const restored = r.restored ?? []
  const skipped = r.skipped ?? []
  const files = restored.length
  const left = skipped.length
  toast(`Undid the ${kind} in ${files} file${files === 1 ? "" : "s"}.${left ? ` ${skipped.join(", ")} ${left === 1 ? "was" : "were"} changed since, so ${left === 1 ? "it was" : "they were"} left as ${left === 1 ? "it is" : "they are"}.` : ""}`, "info")
  refreshSearch()
}

// After a rename or replace: the notice and the review bar offer Undo while it is the latest.
// A reply without an op number offers no Undo.
function offerUndo(kind: "replace" | "rename", r: { op?: number; paths?: string[] }) {
  if (typeof r.op !== "number") return []
  lastOp = { id: r.op, kind, paths: r.paths ?? [] }
  updateReviewUI()
  return [{ label: "Undo", run: undoOperation }]
}
$("undo-op").onclick = undoOperation
$("reject-all").onclick = () => {
  const base = baseline
  if (base == null) return
  edit(0, ta.value.length, base)
  baseline = null
  setMode("edit")
  render()
  scheduleSave()
  ta.focus()
}
$("next-change").onclick = () => goToChunk(1)
$("prev-change").onclick = () => goToChunk(-1)

// ---------- explorer, tab, breadcrumbs, window title ----------

let root: string | null = null
let files: string[] = []
let dirs: string[] = []
let changed = new Set<string>()
let previewing: string | null = null
const collapsed = new Set<string>()
let selected: string | null = null // the row the explorer actions apply to
// A name box in the tree: a new file or folder inside `parent`, or a rename of `path`.
type Naming = { kind: "file" | "folder"; parent: string } | { kind: "rename"; path: string }
let naming: Naming | null = null
let rendering = false
let lastName: { n: Naming; name: string } | null = null // the name just sent, to reopen if the app refuses it
let nameDraft: string | null = null // what to put in the name box when it reopens after a refusal
let nameError = "" // why the name box refuses what was typed, shown right under it

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1)
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const within = (p: string, dir: string) => p === dir || p.startsWith(dir + "/")
const isDir = (p: string) => dirs.includes(p)


type TreeNode = { name: string; path: string; dir: boolean; kids: TreeNode[] }

function buildTree(): TreeNode[] {
  const top: TreeNode[] = []
  const byPath = new Map<string, TreeNode>()
  const add = (path: string, dir: boolean) => {
    const node: TreeNode = { name: baseName(path), path, dir, kids: [] }
    byPath.set(path, node)
    const parent = parentOf(path)
    ;(parent ? byPath.get(parent)?.kids : top)?.push(node) // dirs are sorted, so parents come first
  }
  for (const d of dirs) add(d, true)
  for (const f of files) add(f, false)
  const sort = (ns: TreeNode[]) => {
    ns.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const n of ns) sort(n.kids)
  }
  sort(top)
  return top
}

function renderTree() {
  const tree = $("tree")
  $("folder-name").textContent = $("folder-name").title = root ? baseName(root.replace(/\/$/, "")) : "No folder opened"
  $("no-folder").hidden = !!root
  tree.hidden = !root
  // Keep what the writer is typing in a name box when the tree redraws.
  const prev = document.getElementById("tree-input") as HTMLInputElement | null
  const keep = prev && { value: prev.value, start: prev.selectionStart, end: prev.selectionEnd }

  const rows: string[] = []
  const nameBox = (depth: number, iconHtml: string, value: string) =>
    `<div class="row naming" style="--depth:${depth}"><span class="twist"></span>${iconHtml}` +
    `<input class="tree-input" id="tree-input" value="${esc(value)}" spellcheck="false" autocomplete="off" aria-label="Name"${nameError ? ' aria-invalid="true" aria-describedby="name-msg"' : ""}></div>` +
    (nameError ? `<div class="name-msg" id="name-msg" role="alert" style="--depth:${depth}">${esc(nameError)}</div>` : "")
  const newBox = (parent: string, depth: number) => {
    if (!naming || naming.kind === "rename" || naming.parent !== parent) return
    rows.push(nameBox(depth, naming.kind === "folder" ? icon("folder") : icon("file", "ft-other"), nameDraft ?? ""))
  }
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = !collapsed.has(n.path)
      const lead = n.dir ? icon(open ? "chevron-down" : "chevron-right") : `<span class="twist"></span>${fileIcon(n.path)}`
      if (naming?.kind === "rename" && naming.path === n.path) rows.push(nameBox(depth, lead.replace('<span class="twist"></span>', ""), nameDraft ?? n.name))
      else {
        const dirty = n.dir ? [...changed].some((c) => c.startsWith(n.path + "/")) : changed.has(n.path)
        rows.push(
          `<button class="row${n.path === current ? " active" : ""}${n.path === selected ? " selected" : ""}${dirty ? " changed" : ""}" ` +
            `data-path="${esc(n.path)}"${n.dir ? ` data-dir="1" aria-expanded="${open}"` : ""} style="--depth:${depth}" ` +
            `title="${dirty ? "Has changes to review" : esc(n.path)}">${lead}<span class="name">${esc(n.name)}</span>${dirty ? icon("diff", "review-mark") : ""}</button>`,
        )
      }
      if (n.dir && open) {
        newBox(n.path, depth + 1)
        walk(n.kids, depth + 1)
      }
    }
  }
  newBox("", 0)
  walk(buildTree(), 0)
  rendering = true
  tree.innerHTML = rows.join("")
  rendering = false

  nameDraft = null
  const input = document.getElementById("tree-input") as HTMLInputElement | null
  if (!input) return
  input.focus()
  if (keep) {
    input.value = keep.value
    input.setSelectionRange(keep.start, keep.end)
  } else {
    const dot = input.value.lastIndexOf(".")
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length) // select the name, not the extension
  }
}

function startNew(kind: "file" | "folder") {
  if (!root) return
  const parent = selected ? (isDir(selected) ? selected : parentOf(selected)) : ""
  collapsed.delete(parent)
  naming = { kind, parent }
  nameError = ""
  setPanel("sidebar", true)
  renderTree()
}

// The open text goes to disk first (a path in it may change), and typing waits until the app answers.
async function renameFile(from: string, to: string) {
  holdTyping(true)
  const error = await flushSave(true)
  if (error) {
    holdTyping(false)
    return void toast(`Nothing was renamed: ${baseName(current!)} could not be saved first.`)
  }
  send({ type: "rename", req: (leaving = ++reqSeq), from, to })
}

// What the writer is told after a rename: the links that followed, and the ones that did not.
function renameNotice(msg: { from: string; links: number; files: number; op: number | null; paths: string[]; skipped: string[] }) {
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
  const left = msg.skipped?.length ? ` Not updated, check them by hand: ${msg.skipped.join(", ")}.` : ""
  if (!msg.links && !left) return
  const done = msg.links ? ` Updated ${n(msg.links, "link")} in ${n(msg.files, "file")}. Review the changes.` : ""
  opToast = toast(`Renamed ${baseName(msg.from)}.${done}${left}`, left ? "error" : "info", msg.links ? offerUndo("rename", { op: msg.op ?? undefined, paths: msg.paths }) : [])
}

function startRename(path: string) {
  naming = { kind: "rename", path }
  nameError = ""
  renderTree()
}

// `leaving`: the box lost focus; a refused name then closes the box instead of pulling focus back.
function commitName(leaving = false) {
  const input = document.getElementById("tree-input") as HTMLInputElement | null
  const n = naming
  const name = input?.value.trim().replace(/^\/+|\/+$/g, "") ?? ""
  if (n) {
    const to = joinPath(n.kind === "rename" ? parentOf(n.path) : n.parent, name)
    const problem = nameProblem(name, to, [...files, ...dirs], n.kind === "rename" ? n.path : undefined)
    if (problem && !leaving) {
      nameError = problem
      renderTree()
      return
    }
    if (!problem) {
      if (n.kind === "rename") {
        if (to !== n.path) renameFile(n.path, to)
      } else if (n.kind === "folder") send({ type: "create", path: to, folder: true })
      // A new file opens, replacing the open one: ask first when that one has unsaved changes.
      else leaveThen({ type: "create", path: to, folder: false })
      selected = to
      lastName = { n, name }
    }
  }
  naming = null
  nameError = ""
  renderTree()
}

let lastTrashed = ""
function trash(path: string) {
  const what = isDir(path) ? `the folder "${baseName(path)}" and everything in it` : `"${baseName(path)}"`
  // Not confirm(): the desktop app's window answers it with "no" without showing it.
  ask(`Move ${what} to the Trash?`, "You can get it back from the Trash.", "Move to Trash").then(
    (a) => {
      if (a !== "save") return
      lastTrashed = path
      send({ type: "delete", path })
    },
  )
}

$("tree").onclick = (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-path]")
  if (!row) return
  const path = row.dataset.path!
  selected = path
  if (row.dataset.dir) {
    if (collapsed.has(path)) collapsed.delete(path)
    else collapsed.add(path)
    renderTree()
  } else {
    renderTree()
    if (path === current) return
    leaveThen({ type: "open_file", path }).then((ok) => ok && innerWidth < 640 && setPanel("sidebar", false))
  }
}
// Where a file or folder may go: any folder (or "" for the top level) except where it already is,
// itself, or inside itself.
const canMoveTo = (from: string, to: string) => to !== parentOf(from) && to !== from && !to.startsWith(from + "/")

// A move is a rename into another folder: it saves first, keeps links working and offers Undo.
function moveInto(from: string, to: string) {
  const dest = joinPath(to, baseName(from))
  lastName = null // a refusal now is about this move, not about a name typed earlier
  if ([...files, ...dirs].some((p) => p.toLowerCase() === dest.toLowerCase()))
    return void toast(`Nothing was moved: ${to ? `the folder "${baseName(to)}"` : "the top level of the project"} already has a file or folder called "${baseName(from)}". Rename one of them first.`)
  renameFile(from, dest)
}

// Dragging a row onto a folder moves it. Pointer events on the document, not HTML5 drag-and-drop: the
// desktop window's own drag handler would swallow those, and a plain click must stay a click.
let dragging = false
const dropDir = (el: Element | null, from: string): string | null => {
  const row = el?.closest<HTMLElement>(".row[data-path]")
  const to = row ? (row.dataset.dir ? row.dataset.path! : null) : el?.closest("#folder-name, #tree") ? "" : null
  return to === null || !canMoveTo(from, to) ? null : to
}
$("tree").addEventListener("pointerdown", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-path]")
  if (!row || e.button !== 0) return
  const from = row.dataset.path!
  const x = e.clientX, y = e.clientY
  let target: Element | null = null
  let ghost: HTMLElement | null = null
  let expand = 0
  let at: Element | null = null
  let px = x, py = y
  const mark = (to: string | null, el: Element | null) => {
    target?.classList.remove("drop")
    target = to === null ? null : (el?.closest(".row[data-dir]") ?? $("tree"))
    target?.classList.add("drop")
    document.body.classList.toggle("drag-refused", to === null)
  }
  // A collapsed folder under the pointer opens after a short wait, so a file can go into a subfolder.
  const hover = (el: Element | null) => {
    const dir = el?.closest<HTMLElement>(".row[data-dir]")
    const path = dir?.dataset.path
    clearTimeout(expand)
    if (!path || !collapsed.has(path) || !canMoveTo(from, path)) return
    expand = window.setTimeout(() => {
      collapsed.delete(path)
      renderTree()
      at = document.elementFromPoint(px, py) // the rows were redrawn
      mark(dropDir(at, from), at)
    }, 600)
  }
  const move = (m: PointerEvent) => {
    if (!dragging && Math.hypot(m.clientX - x, m.clientY - y) < 4) return
    if (!dragging) {
      dragging = true
      ghost = document.createElement("div")
      ghost.className = "drag-ghost"
      ghost.textContent = baseName(from)
      document.body.append(ghost)
      document.body.classList.add("dragging")
    }
    px = m.clientX
    py = m.clientY
    ghost!.style.transform = `translate(${m.clientX + 12}px, ${m.clientY + 12}px)`
    const el = document.elementFromPoint(m.clientX, m.clientY)
    if (el !== at) hover((at = el))
    mark(dropDir(el, from), el)
  }
  const end = (u: PointerEvent) => {
    document.removeEventListener("pointermove", move)
    document.removeEventListener("pointerup", end)
    document.removeEventListener("keydown", esc, true)
    const to = u.type === "pointerup" ? dropDir(document.elementFromPoint(u.clientX, u.clientY), from) : null
    clearTimeout(expand)
    mark(null, null)
    ghost?.remove()
    document.body.classList.remove("dragging", "drag-refused")
    if (!dragging) return
    // The click that follows the release must not open or toggle the row.
    // (No click comes when the release is on another element, so the guard must not outlive this turn.)
    const stop = (c: Event) => c.stopPropagation()
    document.addEventListener("click", stop, { capture: true, once: true })
    setTimeout(() => {
      document.removeEventListener("click", stop, true)
      dragging = false
    })
    if (to !== null) moveInto(from, to)
  }
  const esc = (k: KeyboardEvent) => {
    if (k.key === "Escape" && dragging) {
      k.preventDefault()
      end(new PointerEvent("pointercancel"))
    }
  }
  document.addEventListener("pointermove", move)
  document.addEventListener("pointerup", end)
  document.addEventListener("keydown", esc, true)
})
$("tree").addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement
  if (el.id === "tree-input") {
    if (e.key === "Enter") {
      e.preventDefault()
      commitName()
    } else if (e.key === "Escape") {
      e.preventDefault()
      naming = null
      nameError = ""
      renderTree()
    }
    return
  }
  const path = el.dataset.path
  if (!path) return
  if (e.key === "F2") {
    e.preventDefault()
    startRename(path)
  } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    trash(path)
  }
})
// Leaving the name box keeps the name, as in VS Code (a redraw is not leaving).
$("tree").addEventListener("focusout", (e) => {
  if ((e.target as HTMLElement).id === "tree-input" && naming && !rendering) commitName(true)
})
$("tree").addEventListener("input", (e) => {
  if ((e.target as HTMLElement).id === "tree-input" && nameError) {
    nameError = ""
    document.getElementById("name-msg")?.remove()
    ;(e.target as HTMLElement).removeAttribute("aria-invalid")
  }
})
$("tree").addEventListener("focusin", (e) => {
  const path = (e.target as HTMLElement).dataset.path
  if (path) selected = path
})

type MenuItem = { label: string; keys?: string; run: () => void } | "-"

function showMenu(x: number, y: number, items: MenuItem[]) {
  const m = $("ctx-menu")
  m.replaceChildren(
    ...items.map((it) => {
      if (it === "-") return document.createElement("hr")
      const b = document.createElement("button")
      b.setAttribute("role", "menuitem")
      b.innerHTML = `<span>${esc(it.label)}</span>${it.keys ? `<span class="keys">${esc(it.keys)}</span>` : ""}`
      b.onclick = () => {
        hideMenu()
        it.run()
      }
      return b
    }),
  )
  m.hidden = false
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 4)}px`
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 4)}px`
  m.querySelector("button")?.focus()
}
const hideMenu = () => ($("ctx-menu").hidden = true)
document.addEventListener("mousedown", (e) => {
  if (!$("ctx-menu").hidden && !$("ctx-menu").contains(e.target as Node)) hideMenu()
})
$("ctx-menu").addEventListener("keydown", (e) => {
  const items = [...$("ctx-menu").querySelectorAll<HTMLElement>("button")]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === "Escape") hideMenu()
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault()
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus()
  }
})

$("tree").oncontextmenu = (e) => {
  e.preventDefault()
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-path]")
  const path = row?.dataset.path ?? null
  selected = path
  renderTree()
  const items: MenuItem[] = [
    { label: "New File…", run: () => startNew("file") },
    { label: "New Folder…", run: () => startNew("folder") },
  ]
  if (path) {
    items.push(
      "-",
      { label: "Rename…", keys: kc("rename"), run: () => startRename(path) },
      { label: "Move to Folder…", run: () => openPalette(MOVE, path) },
      ...(files.includes(path) ? [{ label: "File History…", run: () => openHistory(path) }] : []),
      { label: "Move to Trash", keys: kc("trash"), run: () => trash(path) },
      "-",
      { label: "Copy Relative Path", run: () => navigator.clipboard?.writeText(path) },
    )
  }
  showMenu(e.clientX, e.clientY, items)
}
$("sidebar").oncontextmenu = (e) => {
  if (e.defaultPrevented || !root) return // the tree already showed its menu
  e.preventDefault()
  selected = null
  showMenu(e.clientX, e.clientY, [
    { label: "New File…", run: () => startNew("file") },
    { label: "New Folder…", run: () => startNew("folder") },
  ])
}

$("new-file").onclick = () => startNew("file")
$("new-folder").onclick = () => startNew("folder")
$("collapse-all").onclick = () => {
  for (const d of dirs) collapsed.add(d)
  renderTree()
}
// ---------- labels: every <label> in the project, and which ones nothing refers to ----------

let labels: { name: string; path: string; line: number; col: number; refs: number }[] = []
// Uses of a label or citation key that match nothing in the project.
type Nowhere = { kind: "ref" | "cite"; key: string; path: string; line: number; col: number }
let nowhere: Nowhere[] = []
const NOWHERE_HINT = "Citations are judged only when a bibliography (.bib) is found in the project."
const LABEL_HINT: Record<Lang, string> = {
  typst: "Put <name> after a heading, figure or equation, then refer to it with @name.",
  latex: "Put \\label{name} in a section, figure or equation, then refer to it with \\ref{name}.",
  quarto: "Put {#sec-name} after a heading or {#fig-name} after a figure, then refer to it with @sec-name.",
  markdown: "Markdown has no labels. Quarto (.qmd) adds them.",
  text: "",
}

// The keys the writer most likely meant. Typst and Quarto write a citation like a reference (@key), so they offer labels
// and bibliography keys; LaTeX \ref gets labels only and a citation gets bibliography keys only, so the kinds never mix.
function keyChoices(n: Nowhere): string[] {
  const lang = langOf(n.path)
  const own = labels.filter((l) => langOf(l.path) === lang).map((l) => l.name)
  return suggestKeys(n.key, n.kind === "cite" ? cites : lang === "typst" || lang === "quarto" ? [...own, ...cites] : own)
}

function fixRow(n: Nowhere, i: number): string {
  const [top, ...more] = keyChoices(n)
  if (!top) return `<div class="fixes"><span class="muted">No similar ${n.kind === "cite" ? "citation" : "label"}</span></div>`
  return `<div class="fixes"><button class="fix" data-fix="${i}" data-key="${esc(top)}" title="Replace ${esc(n.key)} with ${esc(top)}">Did you mean ${esc(top)}?</button>` +
    more.map((k) => `<button class="fix alt" data-fix="${i}" data-key="${esc(k)}" title="Replace ${esc(n.key)} with ${esc(k)}">${esc(k)}</button>`).join("") + "</div>"
}

function renderLabels() {
  const open = store.get("labels") !== "closed"
  const unused = labels.filter((l) => !l.refs).length
  $("labels-head").hidden = $("labels").hidden = !root
  $("labels-head").setAttribute("aria-expanded", String(open))
  $("labels-head").querySelector(".codicon")!.className = `codicon codicon-chevron-${open ? "down" : "right"}`
  $("labels-count").textContent = [
    nowhere.length && `${nowhere.length} reference${nowhere.length > 1 ? "s point" : " points"} nowhere`,
    unused && `${unused} unused`,
  ].filter(Boolean).join(", ")
  $("labels-count").title = $("labels-count").textContent!
  $("labels").classList.toggle("closed", !open)
  const prev = document.getElementById("label-input") as HTMLInputElement | null
  const keep = prev && { value: prev.value, start: prev.selectionStart, end: prev.selectionEnd }
  const broken = nowhere.length
    ? `<div class="labels-group" title="${esc(NOWHERE_HINT)}">Points nowhere</div>` +
      nowhere.map((n, i) =>
        `<button class="row label broken" data-m="${i}" title="${esc(`${n.path}, line ${n.line + 1}. No ${n.kind === "cite" ? "citation" : "label"} named ${n.key}. ${NOWHERE_HINT}`)}">` +
        `${icon("warning")}<span class="name">${esc(n.key)}</span>` +
        `<span class="refs">${n.kind === "cite" ? "citation" : "reference"} · ${esc(n.path.split("/").pop()!)}:${n.line + 1}</span></button>` +
        fixRow(n, i)).join("")
    : ""
  $("labels").innerHTML = broken + (labels.length
    ? labels
        .map(
          (l, i) =>
            labelNaming?.name === l.name && labelNaming.path === l.path
              ? `<div class="row naming label-naming"><span class="twist"></span>${icon("tag")}` +
                `<input class="tree-input" id="label-input" value="${esc(labelNaming.draft)}" spellcheck="false" autocomplete="off" aria-label="New name for ${esc(l.name)}"${labelNaming.error ? ' aria-invalid="true"' : ""} aria-describedby="label-msg"></div>` +
                `<div class="name-msg" id="label-msg" role="alert"${labelNaming.error ? "" : " hidden"}>${esc(labelNaming.error)}</div>`
              : `<button class="row label${l.refs ? "" : " unused"}" data-i="${i}" ` +
            `title="${esc(`${l.path}, line ${l.line + 1}${l.refs ? "" : ". Nothing refers to this label."}`)}">` +
            `${icon("tag")}<span class="name">${esc(l.name)}</span>` +
            `<span class="refs">${l.refs ? `${l.refs} use${l.refs > 1 ? "s" : ""}` : "unused"}</span></button>`,
        )
        .join("")
    : nowhere.length ? "" : `<p class="muted labels-empty">No labels yet. ${esc(LABEL_HINT[lang])}</p>`)
  const input = document.getElementById("label-input") as HTMLInputElement | null
  if (!input) return
  input.focus()
  if (keep) {
    input.value = keep.value
    input.setSelectionRange(keep.start, keep.end)
  } else input.select()
}

// ---------- rename a label everywhere ----------

// The name box in the Labels panel: `name` defined in `path` is being renamed.
let labelNaming: { name: string; path: string; draft: string; error: string } | null = null
let pendingRename: { name: string; path: string; to: string } | null = null
const sameLanguage = (path: string) => labels.filter((l) => langOf(l.path) === langOf(path)).map((l) => l.name)

function startLabelRename(name: string, path: string, draft = name, error = "") {
  if (!root) return
  labelNaming = { name, path, draft, error }
  store.set("labels", "open")
  if (sidebar.classList.contains("searching")) showExplorer()
  setPanel("sidebar", true)
  renderLabels()
}

// F2 in the editor, or the command: the label under the caret, defined in a file of this language.
function renameLabelAtCaret(): boolean {
  const own = labels.filter((l) => langOf(l.path) === lang)
  const name = current && labelAt(ta.value, ta.selectionStart, own.map((l) => l.name))
  const l = own.find((l) => l.name === name)
  if (l) startLabelRename(l.name, l.path)
  return !!l
}

function cancelLabelRename() {
  labelNaming = null
  renderLabels()
}

function showLabelProblem(problem: string) {
  const msg = document.getElementById("label-msg")
  const input = document.getElementById("label-input")
  if (!msg || !input) return
  msg.hidden = !problem
  msg.textContent = problem
  if (problem) input.setAttribute("aria-invalid", "true")
  else input.removeAttribute("aria-invalid")
}

async function commitLabelRename() {
  const n = labelNaming
  const input = document.getElementById("label-input") as HTMLInputElement | null
  if (!n || !input) return
  const to = input.value.trim()
  const problem = labelProblem(to, n.name, langOf(n.path), sameLanguage(n.path))
  if (problem) return showLabelProblem(problem) // Enter does nothing else
  labelNaming = null
  renderLabels()
  // The open text goes to disk first, and typing waits until the app answers.
  holdTyping(true)
  const error = await flushSave(true)
  if (error) {
    holdTyping(false)
    toast(`Nothing was renamed: ${baseName(current!)} could not be saved first.`)
    return startLabelRename(n.name, n.path, to)
  }
  pendingRename = { name: n.name, path: n.path, to }
  send({ type: "rename_label", req: (leaving = ++reqSeq), path: n.path, from: n.name, to })
}

$("labels").addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement
  if (el.id === "label-input") {
    if (e.isComposing) return
    if (e.key === "Enter") commitLabelRename()
    else if (e.key === "Escape") cancelLabelRename()
    else return
    e.preventDefault()
    e.stopPropagation()
  } else if (e.key === "F2" && el.dataset.i) {
    e.preventDefault()
    const l = labels[Number(el.dataset.i)]
    if (l) startLabelRename(l.name, l.path)
  }
})
$("labels").addEventListener("input", (e) => {
  const n = labelNaming
  if (n && (e.target as HTMLElement).id === "label-input") showLabelProblem(labelProblem((e.target as HTMLInputElement).value.trim(), n.name, langOf(n.path), sameLanguage(n.path)))
})
$("labels").addEventListener("focusout", (e) => {
  if ((e.target as HTMLElement).id === "label-input" && labelNaming && !(e.relatedTarget as HTMLElement | null)?.closest?.("#labels")) cancelLabelRename()
})
$("labels").oncontextmenu = (e) => {
  const l = labels[Number((e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")?.dataset.i)]
  if (!l) return
  e.preventDefault()
  showMenu(e.clientX, e.clientY, [{ label: "Rename…", keys: kc("rename-label"), run: () => startLabelRename(l.name, l.path) }])
}

$("breadcrumbs").onclick = (e) => { if ((e.target as HTMLElement).closest(".section-crumb")) openPalette("@") }

$("labels-head").onclick = () => {
  store.set("labels", store.get("labels") === "closed" ? "open" : "closed")
  renderLabels()
}
$("labels").onclick = (e) => {
  const fix = (e.target as HTMLElement).closest<HTMLElement>(".fix")
  if (fix) return void applyKeyFix(nowhere[Number(fix.dataset.fix)], fix.dataset.key!)
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row")
  const l = row?.dataset.m ? nowhere[Number(row.dataset.m)] : labels[Number(row?.dataset.i)]
  if (l) goTo(l.path, l.line, l.col)
}

// ---------- outline: the open file's headings, a map that also moves whole sections ----------

const OUTLINE_HINT: Record<Lang, string> = {
  typst: "Start a line with = and a space, like = Introduction.",
  latex: "Write \\section{Introduction}.",
  quarto: "Start a line with # and a space, like # Introduction.",
  markdown: "Start a line with # and a space, like # Introduction.",
  text: "",
}
let heads: Heading[] = []
let outlineTimer = 0
let outlineStale = false // the text changed since the list was drawn
let outlineHere = -1 // the heading whose section holds the caret

const scheduleOutline = () => {
  outlineStale = true
  clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(renderOutline, 200)
}
const hereIndex = () => {
  const caret = lineOf(ta.selectionStart)
  let n = -1
  while (n + 1 < heads.length && heads[n + 1].line <= caret) n++
  return n
}
function markOutlineHere() {
  const n = hereIndex()
  if (n === outlineHere) return
  outlineHere = n
  const box = $("outline")
  box.querySelector(".here")?.removeAttribute("aria-current")
  box.querySelector(".here")?.classList.remove("here")
  const row = box.querySelector<HTMLElement>(`.row[data-i="${n}"]`)
  row?.classList.add("here")
  row?.setAttribute("aria-current", "location")
  // Reach the tab stop for the section the caret is in.
  box.querySelectorAll<HTMLElement>(".row[tabindex='0']").forEach((r) => (r.tabIndex = -1))
  if (row) {
    row.tabIndex = 0
    if (!box.contains(document.activeElement)) row.scrollIntoView({ block: "nearest" })
  }
}
function renderOutline() {
  clearTimeout(outlineTimer)
  outlineStale = false
  const open = store.get("outline") !== "closed"
  const refocus = $("outline").contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.i : undefined
  heads = current && syntax() ? outline(ta.value, lang, syntax()!.headingOf) : []
  outlineHere = -2
  $("outline-head").hidden = $("outline").hidden = !root
  $("outline-head").setAttribute("aria-expanded", String(open))
  $("outline-head").querySelector(".codicon")!.className = `codicon codicon-chevron-${open ? "down" : "right"}`
  $("outline-count").textContent = heads.length ? String(heads.length) : ""
  $("outline").classList.toggle("closed", !open)
  const top = Math.min(...heads.map((h) => h.level), 9)
  $("outline").innerHTML = heads.length
    ? heads.map((h, i) => {
        const title = headingTitle(lang, h.title)
        return `<button class="row outline" data-i="${i}" tabindex="-1" style="--depth:${h.level - top + 1}" title="${esc(`${title}, line ${h.line + 1}`)}"><span class="name">${esc(title)}</span></button>`
      }).join("")
    : `<p class="muted outline-empty">${!current ? "Open a file to see its sections." : lang === "text" ? "Plain text files have no outline." : `No headings yet. ${esc(OUTLINE_HINT[lang])}`}</p>`
  markOutlineHere()
  if (refocus !== undefined) $("outline").querySelector<HTMLElement>(`.row[data-i="${refocus}"]`)?.focus({ preventScroll: true })
}
$("outline-head").onclick = () => {
  store.set("outline", store.get("outline") === "closed" ? "open" : "closed")
  renderOutline()
}

// Move heading `from` before heading `to` (to === heads.length: the end). One edit, so one undo step.
function moveHeading(from: number, to: number): boolean {
  if (ta.readOnly) return void toast("Wait a moment, then try again."), false
  if (outlineStale) return void renderOutline(), false // typed a moment ago: the list was out of date
  const r = moveSection(ta.value, heads, from, to)
  if (r === "same") return false
  if (r === "inside") return void toast("A section cannot go inside itself."), false
  if (mode === "review") setMode("edit")
  edit(r.at, r.at + r.cut, r.put)
  let p = 0
  for (let n = 0; n < r.line; n++) p = ta.value.indexOf("\n", p) + 1
  ta.setSelectionRange(p, p)
  const div = hl.children[r.line] as HTMLElement | undefined
  if (div) ta.scrollTop = Math.max(0, div.offsetTop - ta.clientHeight / 3)
  renderOutline()
  const i = heads.findIndex((h) => h.line === r.line)
  $("outline").querySelector<HTMLElement>(`.row[data-i="${i}"]`)?.focus({ preventScroll: true })
  return true
}
// Shift+Alt+Left / Right: the section and everything inside it one level up or down. One edit, so one undo step.
function shiftHeading(i: number, delta: -1 | 1) {
  if (ta.readOnly) return void toast("Wait a moment, then try again.")
  if (outlineStale) return void renderOutline()
  const r = shiftSection(ta.value, heads, i, delta, lang as "typst" | "latex" | "markdown" | "quarto")
  if (typeof r === "string")
    return void toast(
      r === "top" ? "This section is already at the top level." : r === "bottom" ? "A section inside it is already at the deepest level, so it cannot go lower." : "This heading is written in a form Quire cannot change here. Edit it by hand.",
    )
  if (mode === "review") setMode("edit")
  edit(r.at, r.at + r.cut, r.put)
  renderOutline()
  $("outline").querySelector<HTMLElement>(`.row[data-i="${i}"]`)?.focus({ preventScroll: true })
}
// Alt+Up / Alt+Down: before the previous sibling, or after the next one.
function moveHeadingBy(i: number, step: -1 | 1) {
  const lvl = heads[i].level
  let j = i + step
  while (heads[j] && heads[j].level > lvl) j += step // a deeper heading belongs to the section next door
  if (!heads[j] || heads[j].level < lvl) return
  if (step < 0) return void moveHeading(i, j)
  let to = j + 1
  while (heads[to] && heads[to].level > lvl) to++
  moveHeading(i, to)
}

$("outline").addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")
  if (!row) return
  const i = Number(row.dataset.i)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
    // A moved section is undone from where the writer is: the outline has no undo of its own.
    e.preventDefault()
    ta.focus({ preventScroll: true })
    document.execCommand(e.shiftKey ? "redo" : "undo")
  } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault()
    moveHeadingBy(i, e.key === "ArrowUp" ? -1 : 1)
  } else if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    shiftHeading(i, e.key === "ArrowLeft" ? -1 : 1)
  } else if (!e.altKey && !e.metaKey && !e.ctrlKey && ["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
    e.preventDefault()
    const n = e.key === "Home" ? 0 : e.key === "End" ? heads.length - 1 : i + (e.key === "ArrowUp" ? -1 : 1)
    $("outline").querySelector<HTMLElement>(`.row[data-i="${Math.max(0, Math.min(heads.length - 1, n))}"]`)?.focus()
  }
})
$("outline").oncontextmenu = (e) => {
  const i = Number((e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")?.dataset.i)
  if (!heads[i]) return
  e.preventDefault()
  showMenu(e.clientX, e.clientY, [
    { label: "Promote Section", keys: kc("outline-promote"), run: () => shiftHeading(i, -1) },
    { label: "Demote Section", keys: kc("outline-demote"), run: () => shiftHeading(i, 1) },
    "-",
    { label: "Move Section Up", keys: "⌥↑", run: () => moveHeadingBy(i, -1) },
    { label: "Move Section Down", keys: "⌥↓", run: () => moveHeadingBy(i, 1) },
  ])
}
$("outline").onclick = (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")
  const h = row && heads[Number(row.dataset.i)]
  if (h && current) goTo(current, h.line, 0)
}

// Dragging a heading onto another place moves its section. The same pointer pattern as the file tree:
// below 4 px it is still a click.
$("outline").addEventListener("pointerdown", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")
  if (!row || e.button !== 0) return
  const from = Number(row.dataset.i)
  const x = e.clientX, y = e.clientY
  let drag = false
  let to = -1 // drop before heading `to`; heads.length is after the last row
  const rows = () => [...$("outline").querySelectorAll<HTMLElement>(".row[data-i]")]
  const clear = () => {
    for (const r of rows()) r.classList.remove("drop-before", "drop-after", "dragged")
    document.body.classList.remove("drag-refused")
  }
  const aim = (m: PointerEvent) => {
    const all = rows()
    const over = all.find((r) => { const b = r.getBoundingClientRect(); return m.clientY >= b.top && m.clientY < b.bottom })
    to = -1
    if (over) {
      const b = over.getBoundingClientRect()
      to = Number(over.dataset.i) + (m.clientY < b.top + b.height / 2 ? 0 : 1)
    } else if (all.length && m.clientY >= all[all.length - 1].getBoundingClientRect().bottom && $("outline").contains(m.target as Node)) to = all.length
    for (const r of all) r.classList.remove("drop-before", "drop-after")
    const verdict = to < 0 ? "same" : moveSection(ta.value, heads, from, to)
    document.body.classList.toggle("drag-refused", verdict === "inside")
    if (typeof verdict === "object") (to < all.length ? all[to].classList.add("drop-before") : all[all.length - 1].classList.add("drop-after"))
    else to = -1
  }
  const move = (m: PointerEvent) => {
    if (!drag && Math.hypot(m.clientX - x, m.clientY - y) < 4) return
    if (!drag) {
      drag = true
      row.classList.add("dragged")
      document.body.classList.add("dragging")
    }
    aim(m)
  }
  const end = (u: PointerEvent) => {
    document.removeEventListener("pointermove", move)
    document.removeEventListener("pointerup", end)
    document.removeEventListener("keydown", esc, true)
    document.body.classList.remove("dragging")
    const go = drag && u.type === "pointerup" ? to : -1
    clear()
    if (!drag) return
    const stop = (c: Event) => c.stopPropagation()
    document.addEventListener("click", stop, { capture: true, once: true })
    setTimeout(() => document.removeEventListener("click", stop, true))
    if (go >= 0) moveHeading(from, go)
  }
  const esc = (k: KeyboardEvent) => {
    if (k.key === "Escape" && drag) {
      k.preventDefault()
      end(new PointerEvent("pointercancel"))
    }
  }
  document.addEventListener("pointermove", move)
  document.addEventListener("pointerup", end)
  document.addEventListener("keydown", esc, true)
})

$("open-folder").onclick = $("open-folder-2").onclick = $("start-open").onclick = async () => {
  // Unsaved typing belongs to the folder that is open now.
  leaveThen({ type: "open_folder" })
}

// New project: the kind here, then the app asks for the folder and puts a starter file in it.
$("new-project").onclick = $("new-project-2").onclick = $("start-new").onclick = async () => {
  const d = $<HTMLDialogElement>("new-project-ask")
  d.returnValue = ""
  d.showModal()
  const kind = await new Promise<string>((done) => d.addEventListener("close", () => done(d.returnValue), { once: true }))
  if (kind) leaveThen({ type: "new_project", kind })
}

// ---------- start page: the projects opened last ----------

const recent = (): string[] => {
  try {
    return JSON.parse(store.get("recent") ?? "[]")
  } catch {
    return []
  }
}
let opening = "" // the recent project being opened: forgotten if it cannot be opened
function renderRecent(list = recent()) {
  store.set("recent", JSON.stringify(list))
  $("recent-none").hidden = !!list.length
  // The folder's name, then where it is: two projects may share a name.
  $("recent").innerHTML = list
    .map(
      (p) =>
        `<li><button type="button" class="start-row" data-open="${esc(p)}" title="${esc(p)}">${icon("folder")}<b>${esc(baseName(p))}</b><span>${esc(p.slice(0, p.lastIndexOf("/")))}</span></button></li>`,
    )
    .join("")
}
$("recent").onclick = async (e) => {
  const path = (e.target as HTMLElement).closest<HTMLElement>("[data-open]")?.dataset.open
  if (path && (await leaveThen({ type: "open_folder", path }))) opening = path // set before the app can answer
}
renderRecent()

// Another folder was opened: nothing from the previous one may stay on screen.
function resetForFolder(newRoot: string) {
  lastOp = null
  trail = newTrail()
  closePalette(false)
  clearTimeout(saveTimer)
  closeFile()
  invalidateDiagnostics()
  compileMain = null
  compileTool = ""
  compiledMains.clear()
  typedSent = ""
  previewing = null
  previewKind = ""
  showPreview("")
  selected = null
  naming = null
  collapsed.clear()
  changed.clear()
  clearTimeout(refreshTimer)
  searchQuery.value = ""
  showSearch(++searchReq, [], false)
  onFolderOpened(baseName(newRoot.replace(/\/$/, "")))
}

function renderTab() {
  const has = !!current
  $<HTMLButtonElement>("open-find").disabled = !has
  $("tab").hidden = !has
  $("welcome").hidden = has
  // No project yet: the start page in place of the watermark, and no preview next to it.
  app.classList.toggle("starting", !root)
  $("start").hidden = !!root
  $("welcome-mark").hidden = $("shortcuts").hidden = $("welcome-keys").hidden = !root
  $("breadcrumbs").hidden = !has
  buildFormatBar(lang, mode === "review")
  $("format-bar").hidden = !has || !syntax()
  $("export").hidden = !has || !syntax()
  if (current) {
    $("tab-name").textContent = current.split("/").pop()!
    $("tab").title = current
    $("tab-icon").outerHTML = fileIcon(current).replace("<i ", '<i id="tab-icon" ')
  }
  const folder = root?.split("/").filter(Boolean).pop()
  const title = [current?.split("/").pop(), folder].filter(Boolean).join(" — ")
  $("window-title").textContent = title
  baseTitle = [title, APP_NAME].filter(Boolean).join(" — ")
  updateDirty()
}

// ---------- status bar & breadcrumbs (throttled) ----------

let infoQueued = false
function scheduleInfo() {
  if (infoQueued) return
  infoQueued = true
  requestAnimationFrame(() => {
    infoQueued = false
    updateInfo()
  })
}

// Markup that is not words: comments, math, code and commands.
const NOT_WORDS: Record<Lang, RegExp[]> = {
  typst: [/\/\/.*$/gm, /\$[^$]*\$/g, /#[a-zA-Z_][\w.-]*/g],
  latex: [/(?<!\\)%.*$/gm, /\$[^$]*\$/g, /\\[a-zA-Z@]+\*?/g],
  quarto: [/<!--[\s\S]*?-->/g, /```[\s\S]*?```/g, /\$[^$]*\$/g, /\{[^}]*\}/g],
  markdown: [/<!--[\s\S]*?-->/g, /```[\s\S]*?```/g, /\$[^$]*\$/g],
  text: [],
}
const countWords = (s: string) =>
  (NOT_WORDS[lang].reduce((t, r) => t.replace(r, " "), s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

const lineText = (n: number) => ta.value.slice(lineStarts[n], (lineStarts[n + 1] ?? ta.value.length + 1) - 1)

function currentHeading(): string | null {
  for (let n = lineOf(ta.selectionStart); n >= 0; n--) {
    const h = syntax()?.headingOf(lineText(n))
    if (h) return headingTitle(lang, h[1])
  }
  return null
}

// A writing goal is kept per file: how many words it had when the goal was set.
const goals = new Map<string, Goal>() // the same, in memory, for when storage is not available
const goalKey = () => `goal.${root ?? ""}\n${current}`
function currentGoal(): Goal | null {
  if (!current) return null
  const key = goalKey()
  if (!goals.has(key)) { const g = readGoal(store.get(key)); if (g) goals.set(key, g) }
  return goals.get(key) ?? null
}
function setGoal(n: number) {
  if (!current) return
  const g = { goal: n, start: countWords(ta.value) }
  goals.set(goalKey(), g)
  store.set(goalKey(), JSON.stringify(g))
  paintWords(g.start)
}
let words = { total: 0, picked: 0 }
function paintWords(total = words.total, picked = words.picked) {
  words = { total, picked }
  const g = currentGoal()
  const p = g && goalProgress(g.start, total, g.goal)
  const el = $("sb-words")
  const goalText = p ? `${p.done.toLocaleString()} / ${g!.goal.toLocaleString()}` : ""
  el.textContent = app.classList.contains("focus") && goalText ? goalText : `${total.toLocaleString()} words` + (picked ? ` (${picked.toLocaleString()} selected)` : "") + (goalText ? ` · ${goalText}` : "")
  el.classList.toggle("reached", !!p?.reached)
  el.title = p ? (p.reached ? "Writing goal reached" : "Words added to this file since you set the goal") : ""
}

let wordsTimer = 0
function updateInfo() {
  document.documentElement.dataset.lang = current ? lang : "" // Quire Series colours by kind of file
  if (!current) {
    $("sb-pos").textContent = ""
    $("sb-words").textContent = ""
    $("sb-lang").hidden = true
    renderChips()
    return
  }
  $("sb-lang").hidden = false
  $("sb-lang").textContent = { typst: "Typst", latex: "LaTeX", quarto: "Quarto", markdown: "Markdown", text: "Plain Text" }[lang]
  const head = ta.selectionStart
  const line = lineOf(head)
  $("sb-pos").textContent = `Ln ${line + 1}, Col ${head - lineStarts[line] + 1}`
  const level = syntax()?.headingOf(lineText(line))?.[0] ?? 0
  const style = document.getElementById("fmt-heading") as HTMLSelectElement | null
  if (style) style.value = String(Math.min(level, 4))
  clearTimeout(wordsTimer)
  wordsTimer = window.setTimeout(() => {
    const total = countWords(ta.value)
    const picked = ta.selectionEnd > ta.selectionStart ? countWords(ta.value.slice(ta.selectionStart, ta.selectionEnd)) : 0
    paintWords(total, picked)
  }, 250)
  const crumbs = [...(root ? [root.split("/").filter(Boolean).pop()!] : []), ...current.split("/")]
  const heading = currentHeading()
  if (heading) crumbs.push(heading)
  $("breadcrumbs").innerHTML = crumbs
    .map((c, i) => (i ? icon("chevron-right") : "") + (heading && i === crumbs.length - 1 ? `<button class="crumb section-crumb" title="Go to section">${esc(c)}</button>` : `<span class="crumb">${esc(c)}</span>`))
    .join("")
  renderChips()
}

function renderReviewStatus() {
  const others = [...changed].filter((f) => f !== current)
  const n = chunks.length
  if (n) $("sb-review-text").textContent = `${n} change${n > 1 ? "s" : ""} to review`
  else if (others.length) $("sb-review-text").textContent = `${others.length} file${others.length > 1 ? "s" : ""} to review`
  $("sb-review").hidden = !(n || others.length)
  $("tab").classList.toggle("changed", !!current && changed.has(current))
}
$("sb-review").onclick = () => {
  if (chunks.length) {
    setMode("review")
    return
  }
  const next = [...changed].find((f) => f !== current)
  if (next) leaveThen({ type: "open_file", path: next })
}

// ---------- agent & options ----------

let agents: { id: string; name: string }[] = []
let agentId = ""
let agentState: "none" | "starting" | "ready" | "working" = "none"

function renderAgentStatus(text?: string) {
  const name = agents.find((a) => a.id === agentId)?.name ?? "Agent"
  const busy = agentState === "starting" || agentState === "working"
  const label =
    text ??
    { none: root ? `${name} is not running. Click to start it.` : "Open a folder to start the agent", starting: `Starting ${name}…`, ready: name, working: `${name} is working…` }[agentState]
  $("sb-agent").innerHTML = `${icon(busy ? "loading" : "hubot", busy ? "codicon-modifier-spin" : "")} <span>${esc(label)}</span>`
  $("sb-agent").title = root && agentState === "none" ? "Start the agent" : "Open chat"
  setAgentReady(chApi() ? chReady() : agentState === "ready" || agentState === "working")
  if ($<HTMLDialogElement>("setup").open || !root) renderSetup()
  renderAgentNote(name, label)
}

// Above the composer, the chat says what the agent does until it can take a message: it is
// starting, or why it could not start, with a way out.
let agentNote = ""
let slowStart: ReturnType<typeof setTimeout> | undefined
function renderAgentNote(name: string, label: string) {
  const failed = agentState === "none" && !!agentError
  const key = agentState === "starting" ? `starting:${label}` : failed ? `failed:${agentError}:${agentFix}` : ""
  if (key === agentNote) return
  agentNote = key
  clearTimeout(slowStart)
  const note = $("agent-note")
  note.hidden = !key
  note.className = failed ? "failed" : ""
  if (agentState === "starting") {
    note.innerHTML = `${icon("loading", "codicon-modifier-spin")}<div><span>${esc(label)}</span></div>`
    const hint = `<p>The first start downloads ${esc(name)}. This can take a minute or two.</p>`
    slowStart = setTimeout(() => note.lastElementChild!.insertAdjacentHTML("beforeend", hint), 5000)
  } else if (failed) {
    const fix = agentFix ? `<div class="setup-fix"><code>${esc(agentFix)}</code><button type="button" class="btn secondary sm" data-run="agent">Run</button><button type="button" class="btn secondary sm" data-copy="${esc(agentFix)}">Copy</button></div>` : ""
    note.innerHTML = `${icon("error")}<div><b>${esc(name)} could not start.</b><pre class="setup-said">${esc(agentError)}</pre>${fix}<div class="actions"><button type="button" class="btn primary sm" data-start>Try Again</button><button type="button" class="btn secondary sm" data-setup>Check Setup</button></div></div>`
    setPanel("chat", true)
  }
}
$("agent-note").onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button")
  if (b?.dataset.copy)
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      b.textContent = "Copied"
      setTimeout(() => {
        if (b.textContent === "Copied") b.textContent = "Copy" // back, unless copied again
      }, 1500)
    })
  else if (b?.dataset.run === "agent") startSetupRun("agent", "", agents.find((a) => a.id === agentId)?.name ?? "Agent")
  else if (b?.hasAttribute("data-start")) send({ type: "set_agent", id: agentId })
  else if (b?.hasAttribute("data-setup")) send({ type: "check_setup" })
}

// ---------- Check Setup: what the agent, the previews and the exports need ----------

let agentError = "" // why the agent last failed to start
let agentFix = "" // the command that fixes it, when the agent says which one it is
let setupRows: { id: string; label: string; status: string; detail: string; fix: string; fix_label?: string; runnable?: boolean }[] = []
let readyAgents: string[] = [] // the agents whose starter is on this computer
let setupRun: { id: string; text: string; failed: boolean; done: boolean } | null = null // the install the page started, and its output so far
let setupDraft = "" // what the writer has typed to a setup so far, kept across re-renders
const SETUP_ICONS: Record<string, string> = { ok: "pass", warn: "warning", error: "error", off: "circle-slash", busy: "loading codicon-modifier-spin" }

// Run one of the fixes on this computer. First the writer sees exactly what would happen —
// what it installs, and the command itself — and only a yes runs it. Rust knows the command
// for each row id; the one shown here comes along so the dialog can spell it out.
const startSetupRun = async (id: string, fix: string, what: string) => {
  if (setupRun && !setupRun.done) return
  const agent = id === "agent"
  const ok = await ask(
    agent ? `Set up ${what.replace(/ API key$/, "")}?` : `Install ${what}?`,
    agent
      ? "Quire runs the agent's setup here in the app: its output appears where you clicked Run, and it asks for the API key in a box there. The key is stored on this computer."
      : "Quire runs a command on this computer that installs it, in the background. Its output appears where you clicked Run, and this page checks the computer again afterwards.",
    "Run",
    fix || undefined,
  )
  if (ok !== "save") return
  setupRun = { id, text: "", failed: false, done: false }
  send({ type: "run_setup", id })
  renderSetup()
}

function renderSetup() {
  // The answer box keeps what is typed and where the caret is while output re-renders around it.
  const answering = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("setup-input")
  const caret = answering ? (document.activeElement as HTMLInputElement).selectionStart : 0
  const box = answering && (document.activeElement as HTMLElement).closest("#setup-rows") ? "setup-rows" : "start-rows"
  const name = agents.find((a) => a.id === agentId)?.name ?? "Agent"
  const agent =
    agentState === "ready" || agentState === "working"
      ? { status: "ok", detail: "Running." }
      : agentState === "starting"
        ? { status: "busy", detail: "Starting…" }
        : !root
          ? { status: "off", detail: "It starts when you open a project." }
          : { status: agentError ? "error" : "off", detail: agentError || "Not running.", start: true }
  const rows = [{ id: "agent", label: name, fix: agentFix, runnable: !!agentFix, ...agent }, ...setupRows]
  // The same lines in the Check Setup dialog and on the start page.
  $("setup-rows").innerHTML = $("start-rows").innerHTML = rows
    .map((r: any) => {
      const detail = r.detail.includes("\n") ? `<pre class="setup-said">${esc(r.detail)}</pre>` : `<span>${esc(r.detail)}</span>`
      const busy = !!setupRun && !setupRun.done
      const running = setupRun?.id === r.id && busy
      const run = !r.runnable
        ? ""
        : running
          ? `<button type="button" class="btn secondary sm" data-stop>Stop</button>`
          : `<button type="button" class="btn secondary sm" data-run="${esc(r.id)}" data-fix="${esc(r.fix)}"${busy ? " disabled" : ""}>Run</button>`
      const fix = r.fix
        ? `<div class="setup-fix">${r.fix_label ? `<span class="muted">${esc(r.fix_label)}</span>` : `<code>${esc(r.fix)}</code>`}${run}<button type="button" class="btn secondary sm" data-copy="${esc(r.fix)}">Copy</button></div>`
        : ""
      const out = setupRun != null && setupRun.id === r.id ? `<pre class="setup-run${setupRun.failed ? " failed" : ""}">${esc(setupRun.text ?? "") || (busy ? "…" : "")}</pre>` : ""
      // The agent's setup runs in the app now: what it asks, the writer answers here.
      const answer = setupRun?.id === "agent" && busy ? `<div class="setup-in"><input type="text" class="setup-input" value="${esc(setupDraft)}" placeholder="Type your answer and press Enter" autocomplete="off" spellcheck="false"></div>` : ""
      const start = r.start ? `<button type="button" class="btn secondary sm" data-start>${agentError ? "Try Again" : "Start"}</button>` : ""
      return `<li class="setup-row ${r.status}">${icon(SETUP_ICONS[r.status])}<div><b>${esc(r.label)}</b> ${detail}${fix}${out}${answer}${start}</div></li>`
    })
    .join("")
  if (answering) {
    const el = $(box).querySelector<HTMLInputElement>(".setup-input")
    if (el) {
      el.focus()
      el.setSelectionRange(caret ?? el.value.length, caret ?? el.value.length)
    }
  }
  const n = readyAgents.length
  $("start-agents").hidden = !setupRows.length // not looked up yet
  $("start-agents").querySelector("summary")!.textContent = n ? `${n} agent${n === 1 ? "" : "s"} can start on this computer` : "No agent can start on this computer yet"
  $("start-agents").querySelector("p")!.textContent = readyAgents.join(", ")
  // What the chosen agent will do, said where it is chosen: on the start page.
  $("start-agent-note").textContent = !setupRows.length
    ? `${name} starts when you open a project.`
    : readyAgents.includes(name)
      ? `${name} will start when you open a project.`
      : `${name} can't start on this computer yet — what it needs is below.`
}
// The start page shows what this computer has: looked up when it shows, and again when the
// writer comes back to the window (from installing something, say).
const checkForStart = () => {
  if (!root) send({ type: "check_setup", quiet: true })
}
addEventListener("focus", checkForStart)
$("setup-rows").onclick = $("start-rows").onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button")
  if (b?.dataset.copy)
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      b.textContent = "Copied"
      setTimeout(() => {
        if (b.textContent === "Copied") b.textContent = "Copy" // back, unless copied again or re-rendered
      }, 1500)
    })
  else if (b?.dataset.run)
    startSetupRun(b.dataset.run, b.dataset.fix ?? "", (b.closest(".setup-row")?.querySelector("b")?.textContent ?? "").trim())
  else if (b?.hasAttribute("data-stop")) send({ type: "stop_setup_run" })
  else if (b?.hasAttribute("data-start")) send({ type: "set_agent", id: agentId })
}
// The answer to a setup's question (an API key, say): kept as it is typed, and Enter sends it.
const keepDraft = (e: Event) => {
  if ((e.target as HTMLElement).classList?.contains("setup-input")) setupDraft = (e.target as HTMLInputElement).value
}
const answerSetup = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement
  if (!el.classList?.contains("setup-input") || e.key !== "Enter" || e.isComposing) return
  e.preventDefault()
  const said = setupDraft.trim()
  if (said) send({ type: "setup_input", text: said })
  setupDraft = ""
  renderSetup()
}
for (const rows of [$("setup-rows"), $("start-rows")]) {
  rows.addEventListener("input", keepDraft)
  rows.addEventListener("keydown", answerSetup)
}
$("setup-again").onclick = () => send({ type: "check_setup" })
$("setup-troubleshooting").onclick = (e) => {
  e.preventDefault()
  send({ type: "troubleshooting" })
}

const isModel = (o: any) => o.category === "model" || o.id === "model"
const isModelOrEffort = (o: any) =>
  isModel(o) || o.category === "thought_level" || ["effort", "reasoning_effort", "thought_level"].includes(o.id)

function renderOptions(target: HTMLElement, kind: string, options: any[], only?: (o: any) => boolean) {
  const stacked = target.classList.contains("stacked")
  target.replaceChildren(
    ...options.filter((o) => !only || only(o)).map((o) => {
      if (o.type === "boolean") {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "toggle-opt"
        b.textContent = o.name
        b.setAttribute("aria-pressed", String(!!o.currentValue))
        b.onclick = () => send({ type: "set_option", kind, id: o.id, value: b.getAttribute("aria-pressed") !== "true" })
        return b
      }
      const sel = document.createElement("select")
      sel.className = stacked ? "" : "ghost-select"
      sel.title = o.name
      const prefix = !stacked && !isModel(o) ? `${o.name}: ` : ""
      for (const entry of o.options ?? []) {
        for (const opt of entry.options ?? [entry]) sel.append(new Option(prefix + (opt.name ?? opt.value), opt.value))
      }
      sel.value = o.currentValue
      sel.onchange = () => send({ type: "set_option", kind, id: o.id, value: sel.value })
      if (!stacked) return sel
      const label = document.createElement("label")
      label.append(o.name, sel)
      return label
    }),
  )
}

// The agent is chosen in the chat, in the autocomplete, suggestions or edits settings, or on
// the start page: there is one agent for all of them. On the start page the choice is only
// remembered — it starts when a project opens.
const agentSelects = ["agent", "ac-agent", "ck-agent", "ed-agent", "start-agent"].map((id) => $<HTMLSelectElement>(id))
for (const sel of agentSelects) {
  sel.onchange = () => {
    for (const other of agentSelects) other.value = sel.value
    send({ type: "set_agent", id: sel.value })
  }
}

// ---------- autocomplete (grey text after the caret) ----------

const acToggle = $<HTMLInputElement>("ac-toggle")
acToggle.checked = store.get("autocomplete") !== "off"
let acModel = ""
let acBusy = false
let acError = ""
let ghost: { pos: number; text: string } | null = null

// Whether Apple's on-device model can answer here. The app says so on macOS only; elsewhere
// it is never offered.
let apple = { supported: false, available: false, why: "" }
const APPLE_NOTE = "Apple's model answers on this Mac: your text is not sent anywhere. It reads about 3,000 words at a time, so it suits short tasks best."

// What a request names as its model: an API's details or Apple's model. None is the agent.
type Model = { source: "api"; kind: string; url: string; key: string; model: string } | { source: "apple" }

// Autocomplete, suggestions, edits and the chat each ask a model of their own: the agent
// (ACP), an API that talks like OpenAI's (Groq, Ollama, ...) or like Anthropic's, or Apple's
// on-device model. `p` names its fields and stored settings; some have instructions too.
function modelSettings(p: string, defaultPrompt: string, changed: () => void) {
  const sources = [...document.querySelectorAll<HTMLInputElement>(`input[name=${p}-source]`)]
  const fields = {
    kind: $<HTMLSelectElement>(`${p}-kind`),
    url: $<HTMLInputElement>(`${p}-url`),
    key: $<HTMLInputElement>(`${p}-key`),
    model: $<HTMLInputElement>(`${p}-model`),
  }
  /** The model to ask, or null for the agent. */
  const api = (): Model | null => {
    const source = store.get(`${p}.source`)
    if (source === "apple") return { source }
    if (source !== "api") return null
    const { kind, url, key, model } = fields
    return { source, kind: kind.value, url: url.value.trim(), key: key.value.trim(), model: model.value.trim() }
  }
  /** Why an API or Apple's model cannot be asked now, or "". */
  const problem = () => {
    const a = api()
    if (a?.source === "apple") return apple.available ? "" : apple.why || "Apple's model is not available here."
    return a && !a.url ? "Fill in the address." : a && !a.model ? "Fill in the model." : ""
  }
  const ready = () => (api() ? !problem() : agentState === "ready" || agentState === "working")
  /** Its short name for the status bar: "" for the agent. */
  const label = () => {
    const a = api()
    return a?.source === "apple" ? "Apple" : (a?.model ?? "")
  }
  const show = () => {
    const source = api()?.source ?? "acp"
    for (const r of sources) r.checked = r.value === source
    $(`${p}-acp`).hidden = source !== "acp"
    $(`${p}-api`).hidden = source !== "api"
    $(`${p}-apple`).hidden = source !== "apple"
    fields.url.placeholder = fields.kind.value === "anthropic" ? "https://api.anthropic.com" : "https://api.groq.com/openai/v1"
    changed()
  }
  for (const [name, field] of Object.entries(fields)) {
    field.value = store.get(`${p}.${name}`) ?? field.value
    field.oninput = () => {
      store.set(`${p}.${name}`, field.value.trim())
      show()
    }
  }
  for (const r of sources) {
    r.onchange = () => {
      store.set(`${p}.source`, r.value)
      show()
    }
  }
  // The writer may change the instructions; only changed ones are kept, so the others get a
  // better default when one comes.
  const prompt = document.getElementById(`${p}-prompt`) as HTMLTextAreaElement | null
  if (prompt) {
    prompt.value = store.get(`${p}.prompt`) ?? defaultPrompt
    prompt.oninput = () => {
      const text = prompt.value.trim()
      if (text && text !== defaultPrompt) store.set(`${p}.prompt`, text)
      else store.del(`${p}.prompt`)
    }
    prompt.onchange = () => {
      if (!prompt.value.trim()) prompt.value = defaultPrompt
      changed()
    }
  }
  return { api, show, problem, ready, label, prompt: () => prompt?.value.trim() || defaultPrompt }
}

// A settings dialog: Apple's model may have become available since the last one.
function openSettings(id: string) {
  send({ type: "apple_status" })
  $<HTMLDialogElement>(id).showModal()
}

function renderApple() {
  for (const el of document.querySelectorAll<HTMLElement>(".apple-choice")) el.hidden = !apple.supported
  for (const el of document.querySelectorAll<HTMLElement>(".apple-note")) el.textContent = apple.available ? APPLE_NOTE : apple.why
  renderAcStatus()
  renderCkStatus()
  renderEdStatus()
  renderChatModel()
  scheduleCheck()
}

// What the model is told before the text around the cursor.
const AC_PROMPT =
  "You are the autocomplete of a {language} editor. Continue the text at <CURSOR>.\n" +
  "Reply with ONLY the text to insert: a few words, at most one sentence. Start with a space if one is needed.\n" +
  "No explanation, no quotes, no code fences. Do not use any tools."
const { api: acApi, show: renderAcSource, prompt: acPrompt, problem: acProblem, ready: acReady, label: acLabel } = modelSettings("ac", AC_PROMPT, () => {
  clearGhost()
  acError = ""
  renderAcStatus()
})

function renderAcStatus() {
  const on = acToggle.checked
  const api = acApi()
  const model = api ? acLabel() : acModel
  const error = acProblem() || acError
  $("sb-ac").innerHTML =
    `${icon(acBusy ? "loading" : on && error ? "warning" : "sparkle", acBusy ? "codicon-modifier-spin" : "")} ` +
    `<span>${on ? `Autocomplete${model ? ` · ${esc(model)}` : ""}` : "Autocomplete off"}</span>`
  $("sb-ac").style.opacity = on ? "" : "0.75"
  $("ac-error").textContent = error
  $("ac-error").hidden = !error
  const from = !api ? "Your agent (ACP)" : api.source === "apple" ? "Apple's model, on this Mac" : `An API (${api.kind === "anthropic" ? "Anthropic" : "OpenAI"}-compatible)`
  $("start-ac").textContent = on ? `${from}${model ? ` · ${model}` : ""}` : "Off"
}

// The suggestion is drawn in the colored layer as a copy of the caret's line with the grey
// text inserted. It covers that line until it is accepted or dismissed — and never more:
// the added words can wrap past the line's own height, and uncovered they would hide the
// lines below it, so what the writer selects there is not what they see.
function placeGhost() {
  hl.querySelector(".ghost-line")?.remove()
  if (!ghost || mode !== "edit") return
  const line = lineOf(ghost.pos)
  const div = hl.children[line] as HTMLElement | undefined
  if (!div) return
  const text = lineText(line)
  const col = ghost.pos - lineStarts[line]
  const el = document.createElement("div")
  el.className = "ghost-line"
  el.style.top = `${div.offsetTop}px`
  el.style.left = `${div.offsetLeft}px`
  el.style.width = `${div.clientWidth}px`
  el.style.maxHeight = `${div.offsetHeight}px`
  el.innerHTML = highlightHTML(text.slice(0, col), lang) + `<span class="ghost-text">${esc(ghost.text)}</span>` + highlightHTML(text.slice(col), lang)
  hl.append(el)
}

function clearGhost() {
  ghost = null
  hl.querySelector(".ghost-line")?.remove()
}

acToggle.onchange = () => {
  store.set("autocomplete", acToggle.checked ? "on" : "off")
  if (acToggle.checked) send({ type: "warm", kind: "complete" })
  else clearGhost()
  renderAcStatus()
}
$("sb-ac").onclick = $("start-ac-settings").onclick = () => openSettings("ac-settings")

let acTimer = 0
let reqSeq = 0 // shared by autocomplete and inline, so errors reach the right place
let acWant: { req: number; pos: number; version: number } | null = null

function scheduleComplete() {
  clearTimeout(acTimer)
  const api = acApi()
  if (!acToggle.checked || !acReady()) return
  acTimer = window.setTimeout(() => {
    if (ta.selectionStart !== ta.selectionEnd || mode !== "edit") return
    const pos = ta.selectionStart
    const doc = ta.value
    acWant = { req: ++reqSeq, pos, version: docVersion }
    send({ type: "complete", req: acWant.req, path: current, before: doc.slice(Math.max(0, pos - 2000), pos), after: doc.slice(pos, pos + 500), prompt: acPrompt(), ...api })
    acBusy = true
    renderAcStatus()
    // An API answers in a fraction of a second, so it is asked after a shorter pause. Every
    // pause is a request: a shorter one reaches a free plan's limit sooner.
  }, api ? 300 : 600)
}

function showCompletion(req: number, text: string) {
  if (!acWant || req !== acWant.req) return
  acBusy = false
  acError = ""
  renderAcStatus()
  const w = acWant
  acWant = null
  if (!text || docVersion !== w.version || ta.selectionStart !== w.pos || ta.selectionEnd !== w.pos) return
  // ponytail: models often drop the leading space; this guess is wrong for mid-word completions.
  if (/[\p{L}\p{N}.,;:!?)]$/u.test(ta.value.slice(w.pos - 1, w.pos)) && /^[\p{L}\p{N}(]/u.test(text)) text = " " + text
  ghost = { pos: w.pos, text }
  placeGhost()
}

// ---------- suggestions (mistakes underlined in red) ----------

const ckToggle = $<HTMLInputElement>("ck-toggle")
// Off until the writer turns it on: it sends the whole file.
ckToggle.checked = store.get("suggestions") === "on"
let ckError = ""
const CK_PROMPT =
  "You proofread a {language} document. Find spelling, grammar and punctuation mistakes, and wrong words.\n" +
  "Leave style, meaning and correct text alone. Never change markup, commands, math, code, citations or labels."
const { api: ckApi, show: renderCkSource, prompt: ckPrompt, problem: ckProblem, ready: ckReady } = modelSettings("ck", CK_PROMPT, () => {
  ckError = ""
  checked.clear() // another model or other instructions: check everything again
  warmCheck()
  paintIssues()
  scheduleCheck()
})
const warmCheck = () => ckToggle.checked && !ckApi() && send({ type: "warm", kind: "check" })

// The fixes by paragraph text: a paragraph is sent once, and again only once it changes. Undo
// brings its fixes back with it.
// ponytail: kept until the app quits or the settings change; a long session only costs memory.
const checked = new Map<string, Fix[]>()
type Mark = { from: number; to: number; para: string; fix: Fix }
let marks: Mark[] = [] // the open file's, in order
let ckWant: { req: number; paras: string[] } | null = null
let ckTimer = 0
// The underlines are a highlight (the browser's own) over the colored layer's text. An older
// web view has none: then there are no suggestions, rather than no editor.
const issues = typeof Highlight === "function" ? new Highlight() : null
if (issues) CSS.highlights.set("issue", issues)
else {
  ckToggle.checked = false
  ckToggle.disabled = true
  ckToggle.parentElement!.title = "Suggestions need a newer system web view."
}

function scheduleCheck(wait = 1500) {
  clearTimeout(ckTimer)
  ckTimer = window.setTimeout(runCheck, wait)
}

// Send the paragraphs not checked yet, the nearest to the cursor first, a few at a time. The
// next few go when these come back. Nothing goes while the writer types.
// ponytail: markup-only paragraphs (a preamble, code) are sent too; the instructions leave them be.
function runCheck() {
  if (ckWant || !ckToggle.checked || !ckReady() || !current || mode !== "edit") return
  if (Date.now() - lastTyped < 1000) return scheduleCheck()
  const caret = ta.selectionStart
  const todo = paragraphs(ta.value).filter((p) => !checked.has(p.text) && /\p{L}/u.test(p.text))
  todo.sort((a, b) => Math.abs(a.from - caret) - Math.abs(b.from - caret))
  const paras: string[] = []
  let size = 0
  for (const p of todo) {
    if (size && size + p.text.length > 4000) break
    if (!paras.includes(p.text)) paras.push(p.text)
    size += p.text.length
  }
  if (!paras.length) return
  ckWant = { req: ++reqSeq, paras }
  send({ type: "check", req: ckWant.req, path: current, text: paras.join("\n\n"), prompt: ckPrompt(), ...ckApi() })
  renderCkStatus()
}

function onChecked(req: number, reply: string) {
  const w = ckWant
  if (!w || w.req !== req) return
  ckWant = null
  const fixes = readFixes(reply, w.paras)
  if (!fixes) {
    ckError = "The model did not answer with a list of fixes. Try another model."
    return renderCkStatus()
  }
  ckError = ""
  w.paras.forEach((p, i) => checked.set(p, fixes[i]))
  paintIssues()
  runCheck()
}

// Underline the open file's fixes.
// Math, code, comments, labels and strings are not prose: a fix there is the model touching
// markup, which it was told not to.
const NOT_PROSE = ".tk-comment, .tk-func, .tk-keyword, .tk-label, .tk-math, .tk-raw, .tk-string"
const inCode = (pos: number) => !!nodeAt(pos)?.[0].parentElement?.closest(NOT_PROSE)

function paintIssues() {
  const found: Mark[] = []
  issues?.clear()
  if (ckToggle.checked && mode === "edit") {
    for (const p of paragraphs(ta.value)) {
      for (const fix of checked.get(p.text) ?? []) found.push({ from: p.from + fix.at, to: p.from + fix.at + fix.len, para: p.text, fix })
    }
  }
  // Its first and last characters: at an edge, nodeAt gives the text before it.
  marks = found.filter((m) => !inCode(m.from + 1) && !inCode(m.to))
  for (const m of marks) {
    const [from, to] = [nodeAt(m.from), nodeAt(m.to)]
    if (!from || !to) continue
    const r = document.createRange()
    r.setStart(...from)
    r.setEnd(...to)
    issues?.add(r)
  }
  renderCkStatus()
}

let ckShown = ""
function renderCkStatus() {
  const on = ckToggle.checked
  const error = ckProblem() || ckError
  const n = marks.length
  const html =
    `${icon(ckWant ? "loading" : on && error ? "warning" : "lightbulb", ckWant ? "codicon-modifier-spin" : "")} ` +
    `<span>${on ? `${n} suggestion${n === 1 ? "" : "s"}` : "Suggestions off"}</span>`
  if (html !== ckShown) $("sb-ck").innerHTML = ckShown = html // every keystroke: keep the spinner turning
  $("sb-ck").style.opacity = on ? "" : "0.75"
  $("sb-ck").title = on && error ? `Suggestions: ${error}` : "Suggestions settings"
  $("ck-error").textContent = error
  $("ck-error").hidden = !error
}

ckToggle.onchange = () => {
  store.set("suggestions", ckToggle.checked ? "on" : "off")
  ckError = ""
  warmCheck()
  paintIssues()
  scheduleCheck(0)
}
$("sb-ck").onclick = () => openSettings("ck-settings")

// The card with a fix: a click on an underline, or Cmd+. with the cursor on one.
const card = $("fix-card")
let cardMark: Mark | null = null

function openCard(focus: boolean) {
  const pos = ta.selectionStart
  const m = ta.selectionEnd === pos ? marks.find((m) => m.from <= pos && pos <= m.to) : null
  if (!m) return
  cardMark = m
  $("fix-why").textContent = m.fix.why || "Suggestion"
  $("fix-apply").textContent = m.fix.fix || `Delete “${ta.value.slice(m.from, m.to)}”`
  card.hidden = false
  floatAt(card, m.from, m.from)
  if (focus) $("fix-apply").focus()
}

function closeCard() {
  card.hidden = true
  cardMark = null
}

$("fix-apply").onclick = () => {
  const m = cardMark!
  closeCard()
  // The paragraph's other fixes move to its new text, so they stay without asking again.
  const { at, len, fix } = m.fix
  const rest = checked.get(m.para)!.filter((f) => f.at + f.len <= at || f.at >= at + len)
  const moved = rest.map((f) => (f.at < at ? f : { ...f, at: f.at + fix.length - len }))
  checked.set(m.para.slice(0, at) + fix + m.para.slice(at + len), moved)
  edit(m.from, m.to, fix)
}
$("fix-dismiss").onclick = () => {
  const m = cardMark!
  closeCard()
  checked.set(m.para, checked.get(m.para)!.filter((f) => f !== m.fix))
  paintIssues()
  ta.focus()
}
card.onkeydown = (e) => {
  if (e.key !== "Escape") return
  closeCard()
  ta.focus()
}
ta.addEventListener("click", () => openCard(false))
document.addEventListener("mousedown", (e) => {
  if (cardMark && !card.contains(e.target as Node) && e.target !== ta) closeCard()
})

// ---------- edits: Cmd+K and the rewrite menu ask this model ----------

const { api: edApi, show: renderEdSource, problem: edProblem, label: edLabel } = modelSettings("ed", "", () => renderEdStatus())

function renderEdStatus() {
  const error = edProblem()
  $("sb-ed").innerHTML = `${icon(error ? "warning" : "edit")} <span>Edits${edLabel() ? ` · ${esc(edLabel())}` : ""}</span>`
  $("sb-ed").title = error ? `Edits: ${error}` : "Edits settings: Cmd+K and the rewrite menu"
  $("ed-error").textContent = error
  $("ed-error").hidden = !error
}
$("sb-ed").onclick = () => openSettings("ed-settings")

/** Why an edit cannot be asked for now, or "". */
function edWhy() {
  if (edApi()) return edProblem()
  if (agentState === "starting") return "The agent is still starting. Try again in a moment."
  return agentState === "none" ? "The agent is not running. Click it in the status bar to start it." : ""
}

// ---------- the chat's model: with an API or Apple's, the chat only answers ----------

const { api: chApi, show: renderChSource, problem: chProblem, ready: chReady } = modelSettings("ch", "", () => renderChatModel())

function renderChatModel() {
  const api = chApi()
  $("chat-source").textContent = !api ? "Agent" : api.source === "apple" ? "Apple model" : api.model || "API"
  $("agent").hidden = $("chat-options").hidden = !!api // the agent's own choices
  $<HTMLTextAreaElement>("chat-input").placeholder = api ? "Ask about your writing (answers only, no file changes)" : "Ask the agent to write or change something"
  const error = chProblem()
  $("ch-error").textContent = error
  $("ch-error").hidden = !error
  renderAgentStatus() // whether the chat can send
}
$("chat-source").onclick = () => openSettings("ch-settings")

// ---------- rewrite the selection: a menu over it, then the new text to accept or not ----------

// What the agent is asked for each button. "Other" asks the writer.
const STYLES: Record<string, string> = {
  formal: "Paraphrase it in a formal tone.",
  scientific: "Paraphrase it in a precise, scientific style, as in a research paper.",
  friendly: "Paraphrase it in a friendly, conversational tone.",
  standard: "Paraphrase it in plain, clear language.",
}
const KEEP = " Keep its meaning and its language. Keep markup, math, citations and labels as they are."
const menu = $("rewrite-menu")
const rwCard = $("rewrite-card")
const rwAsk = $<HTMLTextAreaElement>("rewrite-ask")
let rw: { from: number; to: number; selected: string; req: number; text: string } | null = null
let menuTimer = 0
let jumpSel: [number, number] | null = null // a selection made by goTo: the writer did not ask for the menu

// The menu shows under a selection once it stops changing.
function scheduleMenu() {
  clearTimeout(menuTimer)
  menu.hidden = true
  if (!findBox.hidden) return
  if (jumpSel && ta.selectionStart === jumpSel[0] && ta.selectionEnd === jumpSel[1]) return
  jumpSel = null
  menuTimer = window.setTimeout(placeMenu, 250)
}

function placeMenu() {
  const [from, to] = [ta.selectionStart, ta.selectionEnd]
  if (from === to || mode !== "edit" || !current || !rwCard.hidden || !box.hidden || !/\p{L}/u.test(ta.value.slice(from, to))) return false
  menu.hidden = false
  floatAt(menu, from, to)
  return true
}

// Buttons take no focus from the text on a click, so the selection stays.
menu.onmousedown = (e) => e.preventDefault()
menu.onclick = (e) => {
  const style = (e.target as HTMLElement).closest("button")?.dataset.style
  if (!style) return
  const [from, to] = [ta.selectionStart, ta.selectionEnd]
  menu.hidden = true
  rw = { from, to, selected: ta.value.slice(from, to), req: 0, text: "" }
  $("rewrite-title").textContent = style === "other" ? "Rewrite" : `Rewrite: ${(e.target as HTMLElement).textContent}`
  $("rewrite-text").replaceChildren()
  $("rewrite-apply").hidden = true
  rwAsk.hidden = style !== "other"
  rwCard.hidden = false
  if (style === "other") {
    rwAsk.value = ""
    rwStatus("Enter to send, Esc to close.")
    rwAsk.focus()
  } else rewrite(STYLES[style] + KEEP)
  floatAt(rwCard, from, to)
}
menu.onkeydown = (e) => {
  if (e.key !== "Escape") return
  menu.hidden = true
  ta.focus()
}
menu.addEventListener("focusout", (e) => {
  if (!menu.contains(e.relatedTarget as Node) && e.relatedTarget !== ta) menu.hidden = true
})
ta.addEventListener("blur", (e) => {
  if (!menu.contains(e.relatedTarget as Node)) menu.hidden = true
})

function rewrite(instruction: string) {
  const w = rw!
  const why = edWhy()
  if (why) return rwStatus(why, "error")
  const doc = ta.value
  w.req = ++reqSeq
  send({ type: "inline", req: w.req, path: current, instruction, selected: w.selected, before: doc.slice(Math.max(0, w.from - 3000), w.from), after: doc.slice(w.to, w.to + 1000), ...edApi() })
  rwStatus("Rewriting\u2026", "busy")
}

function rwStatus(text: string, kind: "" | "busy" | "error" = "") {
  const el = $("rewrite-status")
  el.className = kind === "error" ? "error" : ""
  el.innerHTML = kind === "busy" ? `${icon("loading", "codicon-modifier-spin")} ${esc(text)}` : esc(text)
}

// The new text, its changed words marked.
function showRewrite(req: number, text: string) {
  const w = rw
  if (!w || w.req !== req) return
  w.text = keepSpaces(w.selected, text)
  let html = ""
  let at = 0
  for (const f of changes(w.selected, w.text, "")) {
    html += esc(w.selected.slice(at, f.at)) + (f.fix ? `<ins>${esc(f.fix)}</ins>` : "")
    at = f.at + f.len
  }
  $("rewrite-text").innerHTML = html + esc(w.selected.slice(at))
  rwStatus(w.text === w.selected ? "The agent changed nothing." : "")
  rwAsk.hidden = true
  $("rewrite-apply").hidden = w.text === w.selected
  floatAt(rwCard, w.from, w.to)
  ;($("rewrite-apply").hidden ? $("rewrite-discard") : $("rewrite-apply")).focus()
}

function closeRewrite() {
  rwCard.hidden = true
  rw = null
}

rwAsk.onkeydown = (e) => {
  if (e.key === "Escape") {
    closeRewrite()
    return ta.focus()
  }
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || !rwAsk.value.trim()) return
  e.preventDefault()
  rewrite(rwAsk.value.trim())
}
$("rewrite-apply").onclick = () => {
  const w = rw
  if (!w?.text) return // no new text yet
  if (ta.value.slice(w.from, w.to) !== w.selected) return rwStatus("The text changed meanwhile. Select it again and retry.", "error")
  closeRewrite()
  edit(w.from, w.to, w.text)
}
$("rewrite-discard").onclick = () => {
  closeRewrite()
  ta.focus()
}
rwCard.onkeydown = (e) => {
  if (e.key !== "Escape" || e.target === rwAsk) return
  closeRewrite()
  ta.focus()
}
document.addEventListener("mousedown", (e) => {
  if (rw && !rwCard.contains(e.target as Node)) closeRewrite()
})

// ---------- inline edit (Cmd+K) ----------

const box = $("inline-box")
const inlineInput = $<HTMLTextAreaElement>("inline-input")
let inlineWant: { req: number; from: number; to: number; selected: string } | null = null

// Where a text offset is in the colored layer (it mirrors the text field): a text node and
// the offset in it. None on an empty line.
function nodeAt(pos: number): [Node, number] | null {
  const line = lineOf(pos)
  const div = hl.children[line]
  if (!div) return null
  let rest = pos - lineStarts[line]
  const walk = document.createTreeWalker(div, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const len = node.textContent!.length
    if (rest <= len) return [node, rest]
    rest -= len
  }
  return null
}

// ---------- find and replace: native textarea selection and undo, mirrored highlights ----------

const findBox = $("find-box")
const findQuery = $<HTMLInputElement>("find-query")
const findReplacement = $<HTMLInputElement>("find-replacement")
let findList: Match[] = []
let findIndex = -1
let findSource = ""
let findTimer = 0
let findPaintQueued = false
const findMarks = typeof Highlight === "function" ? new Highlight() : null
const findCurrent = typeof Highlight === "function" ? new Highlight() : null
if (findMarks && findCurrent) {
  CSS.highlights.set("find-match", findMarks)
  CSS.highlights.set("find-current", findCurrent)
}

function findCount() {
  const n = findList.length
  $("find-count").textContent = !findQuery.value ? "" : n ? `${findIndex + 1} of ${n > 1000 ? "1000+" : n}` : "No results"
  $("find-count").title = n ? `${n.toLocaleString()} matches` : ""
  for (const id of ["find-prev", "find-next", "find-replace-one", "find-replace-all"]) $<HTMLButtonElement>(id).disabled = !n
}

function refreshFind(selectMatch = false, at = ta.selectionStart) {
  clearTimeout(findTimer)
  findTimer = 0
  if (findBox.hidden) return
  findSource = ta.value
  findList = findMatches(findSource, findQuery.value, $("find-case").getAttribute("aria-pressed") === "true", $("find-word").getAttribute("aria-pressed") === "true")
  findIndex = findList.findIndex((m) => m.from >= at)
  if (findIndex < 0 && findList.length) findIndex = 0
  findCount()
  if (selectMatch) selectFind(findIndex)
  queueFindPaint()
}

function scheduleFind(selectMatch = false) {
  if (findBox.hidden) return
  clearTimeout(findTimer)
  findTimer = window.setTimeout(() => refreshFind(selectMatch), 150)
}

function queueFindPaint() {
  if (findBox.hidden || findPaintQueued) return
  findPaintQueued = true
  requestAnimationFrame(() => { findPaintQueued = false; paintFind() })
}

function paintFind() {
  // Keep the last result until the new match list is ready; typing never builds ranges.
  if (findBox.hidden || findSource !== ta.value) return
  const top = ta.scrollTop - ta.clientHeight / 2, bottom = ta.scrollTop + ta.clientHeight * 1.5
  const firstVisible = (y: number) => {
    let lo = 0, hi = hl.children.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const line = hl.children[mid] as HTMLElement
      if (line.offsetTop + line.offsetHeight < y) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const from = lineStarts[firstVisible(top)] ?? findSource.length
  const to = lineStarts[firstVisible(bottom) + 1] ?? findSource.length
  findMarks?.clear()
  findCurrent?.clear()
  const addRange = (m: Match, target: Highlight | null) => {
    if (!target) return
    const start = nodeAt(m.from), end = nodeAt(m.to)
    if (!start || !end) return
    const r = document.createRange()
    r.setStart(...start)
    r.setEnd(...end)
    target.add(r)
  }
  let lo = 0, hi = findList.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (findList[mid].to < from) lo = mid + 1
    else hi = mid
  }
  let painted = 0
  for (let i = lo; i < findList.length; i++) {
    const m = findList[i]
    if (m.from > to || painted >= 500) break
    addRange(m, findMarks)
    painted++
  }
  const active = findList[findIndex]
  if (active && active.to >= from && active.from <= to) addRange(active, findCurrent)
}

function selectFind(index: number) {
  const m = findList[index]
  if (!m) return
  findIndex = index
  ta.setSelectionRange(m.from, m.to)
  const r = coordsAt(m.from), bounds = ta.getBoundingClientRect()
  const top = bounds.top + findBox.offsetHeight + 12, bottom = bounds.bottom - 24
  if (r.top < top || r.bottom > bottom) ta.scrollTop += r.top - (top + bottom) / 2
  hl.scrollTop = ta.scrollTop
  findCount()
  queueFindPaint()
}

function openFind(replace = false) {
  if (!current) return
  clearTimeout(menuTimer)
  menu.hidden = true
  if (mode === "review") setMode("edit")
  const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd)
  if (selected && selected.length <= 200 && !/[\r\n]/.test(selected)) findQuery.value = selected
  findBox.hidden = false
  if (replace) toggleFindReplace(true)
  refreshFind(true)
  if (replace && findQuery.value) { findReplacement.focus(); findReplacement.select() } // the query is there: next is the replacement
  else { findQuery.focus(); findQuery.select() }
}

function closeFind(focus = true) {
  clearTimeout(findTimer)
  findTimer = 0
  findBox.hidden = true
  findList = []
  findIndex = -1
  findMarks?.clear()
  findCurrent?.clear()
  if (focus && current) ta.focus({ preventScroll: true })
}

function toggleFindReplace(show = $("find-replace-row").hidden) {
  $("find-replace-row").hidden = !show
  $("find-toggle-replace").setAttribute("aria-expanded", String(show))
  $("find-toggle-replace").innerHTML = icon(show ? "chevron-down" : "chevron-right")
}

function stepFind(direction: number) {
  if (findBox.hidden) openFind()
  if (findSource !== ta.value || findTimer) refreshFind()
  if (findList.length) selectFind((findIndex + direction + findList.length) % findList.length)
}

function replaceFind(all: boolean) {
  refreshFind()
  const match = findList[findIndex]
  if (!match) return
  const change = all ? replacementEdit(ta.value, findList, findReplacement.value)! : { ...match, insert: findReplacement.value }
  // Keep replacement in the textarea's native undo history, without changing the review baseline.
  findQuery.focus({ preventScroll: true })
  edit(change.from, change.to, change.insert)
  refreshFind(false, all ? change.from : change.from + change.insert.length)
  selectFind(findIndex)
  ta.focus({ preventScroll: true })
}

$("open-find").onclick = () => openFind()
findQuery.oninput = () => scheduleFind(true)
for (const id of ["find-case", "find-word"]) $(id).onclick = () => {
  $(id).setAttribute("aria-pressed", String($(id).getAttribute("aria-pressed") !== "true"))
  refreshFind(true)
}
$("find-toggle-replace").onclick = () => { toggleFindReplace(); findQuery.focus() }
$("find-prev").onclick = () => stepFind(-1)
$("find-next").onclick = () => stepFind(1)
$("find-close").onclick = () => closeFind()
$("find-replace-one").onclick = () => replaceFind(false)
$("find-replace-all").onclick = () => replaceFind(true)
document.addEventListener("keydown", (e) => {
  if (e.isComposing || !current || !$("editor-group").contains(document.activeElement)) return
  const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase()
  if (mod && (key === "f" || e.code === "KeyF") && !e.shiftKey) openFind(e.altKey)
  else if (mod && key === "g" && !e.altKey) stepFind(e.shiftKey ? -1 : 1)
  else if (!findBox.hidden && !refOpen && e.key === "Escape") closeFind() // an open reference list closes first
  else if (e.key === "Tab" && !$("find-replace-row").hidden && !findBox.hidden && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === (e.shiftKey ? findReplacement : findQuery)) (e.shiftKey ? findQuery : findReplacement).focus()
  else if (!findBox.hidden && (e.target === findQuery || e.target === findReplacement) && e.key === "Enter") {
    if (e.target === findReplacement && !e.shiftKey) replaceFind(false)
    else stepFind(e.shiftKey ? -1 : 1)
  } else return
  e.preventDefault()
  e.stopPropagation()
}, true)

// Screen position of a text offset, measured on the colored layer.
function coordsAt(pos: number): DOMRect {
  const at = nodeAt(pos)
  if (at) {
    const r = document.createRange()
    r.setStart(...at)
    r.collapse(true)
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect()
    if (rect.height) return rect
  }
  return hl.children[lineOf(pos)].getBoundingClientRect()
}

// Put a floating box under the text from..to, or over it when there is no room below.
function floatAt(el: HTMLElement, from: number, to: number) {
  const [top, bottom] = [coordsAt(from), coordsAt(to)]
  const below = bottom.bottom + el.offsetHeight + 8 < innerHeight
  el.style.left = `${Math.max(8, Math.min(top.left - 10, innerWidth - el.offsetWidth - 8))}px`
  el.style.top = below ? `${bottom.bottom + 6}px` : `${Math.max(8, top.top - el.offsetHeight - 6)}px`
}

// Agents trim the spaces and blank lines around a selection: put them back.
function keepSpaces(selected: string, text: string) {
  return selected.trim() ? selected.match(/^\s*/)![0] + text.trim() + selected.match(/\s*$/)![0] : text
}

function inlineStatus(text: string, kind: "" | "busy" | "error" = "") {
  const el = $("inline-status")
  el.className = kind === "error" ? "error" : ""
  el.innerHTML = kind === "busy" ? `${icon("loading", "codicon-modifier-spin")} ${esc(text)}` : esc(text)
}

// The same box asks the agent for an edit, or takes a DOI or arXiv ID to cite.
let inlineKind: "edit" | "cite" = "edit"

function openInline(kind: "edit" | "cite" = "edit") {
  if (!current || mode !== "edit") return
  inlineKind = kind
  render() // make sure the colored layer matches before measuring
  const empty = ta.selectionStart === ta.selectionEnd
  const at = coordsAt(ta.selectionStart)
  const below = at.bottom + 110 < innerHeight
  box.style.left = `${Math.max(8, Math.min(at.left - 12, innerWidth - 492))}px`
  box.style.top = below ? `${at.bottom + 6}px` : `${at.top - 96}px`
  box.hidden = false
  $("inline-icon").className = `codicon codicon-${kind === "cite" ? "library" : "sparkle"}`
  if (kind === "cite") {
    inlineInput.placeholder = "DOI or arXiv ID"
    inlineStatus(`The paper goes into your .bib file, and ${syntax()?.cite ?? "@key"} into the text.`)
  } else {
    inlineInput.placeholder = empty ? "Write at the cursor" : "Edit selection"
    inlineStatus(empty ? "Nothing selected: the text goes in at the cursor." : "")
  }
  inlineInput.value = ""
  inlineInput.focus()
}

function closeInline() {
  box.hidden = true
  inlineWant = null
  ta.focus()
}

inlineInput.oninput = () => {
  inlineInput.style.height = "auto"
  inlineInput.style.height = `${inlineInput.scrollHeight}px`
}
inlineInput.onkeydown = (e) => {
  if (e.key === "Escape") return closeInline()
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || !inlineInput.value.trim()) return
  e.preventDefault()
  const from = ta.selectionStart
  const to = ta.selectionEnd
  const doc = ta.value
  inlineWant = { req: ++reqSeq, from, to, selected: doc.slice(from, to) }
  if (inlineKind === "cite") {
    send({ type: "cite", req: inlineWant.req, id: inlineInput.value.trim(), path: current })
    return inlineStatus("Looking it up…", "busy")
  }
  const why = edWhy()
  if (why) return inlineStatus(why, "error")
  send({
    ...edApi(),
    type: "inline",
    req: inlineWant.req,
    path: current,
    instruction: inlineInput.value.trim(),
    selected: inlineWant.selected,
    before: doc.slice(Math.max(0, from - 3000), from),
    after: doc.slice(to, to + 1000),
  })
  inlineStatus("Generating…", "busy")
}

function applyInline(req: number, text: string) {
  const w = inlineWant
  if (!w || w.req !== req) return
  if (ta.value.slice(w.from, w.to) !== w.selected) {
    inlineStatus("The text changed while the agent was working. Select it again and retry.", "error")
    return
  }
  text = keepSpaces(w.selected, text)
  // The edit becomes a change to review, like any agent change.
  if (baseline == null) baseline = ta.value
  box.hidden = true
  inlineWant = null
  edit(w.from, w.to, text)
  render()
  focusChunk = Math.max(0, chunks.findIndex((c) => c.toB >= w.from))
  setMode("review")
  goToChunk(0)
}

function applyCite(msg: { req: number; key: string; bib: string; linked: boolean; added: boolean }) {
  if (inlineWant?.req !== msg.req) return
  box.hidden = true
  inlineWant = null
  insertAt((syntax()?.cite ?? "@key").replace("key", msg.key), msg.key)
  select(ta.selectionEnd, ta.selectionEnd)
  const bib = current?.includes("/") ? `/${msg.bib}` : msg.bib // relative to the file; "/" is the project folder
  const link = {
    typst: `Add #bibliography("${bib}") where the reference list should go.`,
    latex: `Add \\bibliography{${msg.bib.replace(/\.bib$/, "")}} where the reference list should go.`,
    quarto: `Add "bibliography: ${msg.bib}" to the YAML header.`,
    markdown: `Add "bibliography: ${msg.bib}" to the YAML header.`,
    text: "",
  }[lang]
  toast((msg.added ? `Added ${msg.key} to ${msg.bib}.` : `${msg.key} is already in ${msg.bib}.`) + (msg.linked ? "" : ` ${link}`), "info")
}

// ---------- export: the whole document as PDF, Word or another format ----------

const EXPORTS: [string, string][] = [
  ["pdf", "PDF"],
  ["docx", "Word (.docx)"],
  ["-", ""],
  ["odt", "OpenDocument (.odt)"],
  ["html", "Web page (.html)"],
  ["epub", "E-book (.epub)"],
  ["-", ""],
  ["md", "Markdown"],
  ["tex", "LaTeX"],
  ["typ", "Typst"],
]
const OWN_FORMAT: Partial<Record<Lang, string>> = { typst: "typ", latex: "tex", markdown: "md" }

$("export").onclick = () => {
  const r = $("export").getBoundingClientRect()
  const items: MenuItem[] = EXPORTS.filter(([to]) => to !== OWN_FORMAT[lang]).map(([to, label]) =>
    to === "-" ? "-" : { label, run: () => exportAs(to) },
  )
  showMenu(r.right - 200, r.bottom + 4, items)
}

async function exportAs(to: string) {
  const path = current
  if (!path) return
  // The export reads the saved file.
  if (isDirty() && !autosave) {
    const answer = await ask(`Save ${baseName(path)} before exporting?`, "The export uses the saved file.", "Save and Export")
    if (answer !== "save") return
  }
  // A failed save exports nothing: its notice says why, and the old text is not exported as new.
  if (isDirty() && (await flushSave())) return
  // Problems the page already knows: the writer can fix them first or export anyway.
  const problems = gatherProblems(path, compileMain, compileDiagnostics, document.body.classList.contains("errors-pending"), nowhere)
  if (problems.length) {
    const lines = problemLines(path, problems)
    const choice = problems.map((p) => p.nowhere && keyChoices(p.nowhere)[0])
    choice.slice(0, lines.length).forEach((k, i) => { if (k) lines[i] += `. Did you mean ${k}?` })
    const errFixes = problems.map((p) => (p.diag ? errorFix(p.diag) : null))
    errFixes.slice(0, lines.length).forEach((f, i) => { if (f) lines[i] += ` ${f.label}${f.label.endsWith("?") ? "" : "."}` })
    const more = elsewhere(path, compileMain, nowhere)
    if (more) lines.push(`${more} more reference${more > 1 ? "s" : ""} point${more > 1 ? "" : "s"} nowhere in other files (see Labels).`)
    const n = problems.length
    const fix = choice[0] // the first problem is a broken key with a likely fix: offer it where "Go to first problem" would be
    const errFix = errFixes[0]
    const answer = await ask(`${baseName(path)} has ${n} problem${n > 1 ? "s" : ""}`, lines.join("\n"), "Export anyway", undefined, fix ? `Fix ${problems[0].nowhere!.key} to ${fix}` : errFix ? errFix.label : "Go to first problem")
    if (answer === "extra") fix ? applyKeyFix(problems[0].nowhere!, fix) : errFix ? applyErrorFix(errFix) : goTo(problems[0].path, problems[0].line, problems[0].col, problems[0].utf16)
    if (answer !== "save") return
  }
  send({ type: "export", req: ++reqSeq, path, to })
}

const toolErrors = new Map<string, HTMLElement>() // missing-tool notices still on screen, by tool
let exporting: HTMLElement | null = null // the "Exporting…" notice

function exported(path: string | null) {
  exporting?.remove()
  if (!path) return // the writer closed the save dialog
  toast(`Exported ${baseName(path)}.`, "info", [
    { label: "Open", run: () => send({ type: "reveal", path }) },
    { label: "Show in Finder", run: () => send({ type: "reveal", path, finder: true }) },
  ])
}

// ---------- previews we draw ourselves: Markdown from the text as typed, and the built PDF, Word and web page ----------

let previewKind = "" // live (tinymist, Quarto), markdown, pdf, docx or html

// The preview shows the document as a PDF, as Word shows it or as a web page: what the export
// of that format makes. Each language keeps its own choice; Typst and LaTeX start as PDF,
// Quarto and Markdown as a web page.
const PREVIEW_AS: Record<string, string> = { pdf: "PDF", docx: "Word (.docx)", html: "web page (.html)" }
const previewAs = (l: Lang) => store.get(`preview.${l}`) ?? (l === "quarto" || l === "markdown" ? "html" : "pdf")
const requestPreview = (path: string) => send({ type: "preview", path, to: previewAs(langOf(path)) })
function renderPreviewAs() {
  const as = previewAs(langOf(previewing ?? current ?? ""))
  for (const b of document.querySelectorAll<HTMLElement>("[data-as]")) b.setAttribute("aria-pressed", String(b.dataset.as === as))
  $("export-preview").title = `Export as ${PREVIEW_AS[as]}`
}
for (const b of document.querySelectorAll<HTMLElement>("[data-as]")) {
  b.onclick = () => {
    const l = langOf(previewing ?? current ?? "")
    if (previewAs(l) === b.dataset.as) return
    store.set(`preview.${l}`, b.dataset.as!)
    renderPreviewAs()
    if (previewing) requestPreview(previewing)
  }
}
// The document in the format the preview shows, made again by the export.
$("export-preview").onclick = () => exportAs(previewAs(langOf(previewing ?? current ?? "")))
renderPreviewAs()
// ---------- quick input: files and existing commands, with the keyboard kept in one place ----------

const palette = $<HTMLDialogElement>("quick-input")
const paletteQuery = $<HTMLInputElement>("quick-query")
const paletteList = $("quick-list")
type QuickItem = { id: string; label: string; dir?: string; indent?: number; score?: number; here?: boolean; detail?: string; keys?: string; positions?: number[]; run: () => void }
let quickItems: QuickItem[] = []
let quickIndex = 0
// ---------- search in the project ----------

type SearchHit = { path: string; line: number; col: number; len: number; before: string; hit: string; after: string }
const searchQuery = $("search-query") as HTMLInputElement
const searchCase = $("search-case"), searchWord = $("search-word")
let searchReq = 0 // the newest search: an older answer that comes later is dropped
let searchHits: SearchHit[] = []
let searchMore = false
let searchSel = 0
let searchTimer = 0
let searchKeep = "" // path:line:col of the row to stay on when a refreshed search answers
let refreshTimer = 0

// The project changed under an open Search view: ask again, so a row never points at a moved line.
function refreshSearch() {
  clearTimeout(refreshTimer)
  if (!sidebar.classList.contains("searching") || !isOpen("sidebar") || !searchQuery.value) return
  refreshTimer = window.setTimeout(() => {
    const h = searchHits[searchSel]
    searchKeep = h ? `${h.path}:${h.line}:${h.col}` : ""
    runSearch()
  }, 300)
}

function openSearch() {
  if (!root) return
  setPanel("sidebar", true)
  sidebar.classList.add("searching")
  $("pane-name").textContent = "Search"
  $("act-explorer").classList.remove("active")
  $("act-search").classList.add("active")
  const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd)
  if (picked && !picked.includes("\n") && document.activeElement === ta) searchQuery.value = picked
  searchQuery.focus()
  searchQuery.select()
  runSearch()
}

function runSearch() {
  clearTimeout(searchTimer)
  if (!searchQuery.value) return showSearch(++searchReq, [], false)
  if (!searchQuery.value) searchKeep = ""
  const msg: Record<string, unknown> = { type: "search", req: ++searchReq, query: searchQuery.value, case: searchCase.getAttribute("aria-pressed") === "true", word: searchWord.getAttribute("aria-pressed") === "true" }
  if (current) { msg.path = current; msg.content = ta.value } // the text as typed, not as last sent
  searchAsked = { query: searchQuery.value, case: msg.case as boolean, word: msg.word as boolean }
  send(msg)
}

function showSearch(req: number, hits: SearchHit[], more: boolean) {
  if (req !== searchReq) return
  searchHits = hits
  searchMore = more
  searchShown = searchAsked
  searchSel = Math.max(0, hits.findIndex((h) => `${h.path}:${h.line}:${h.col}` === searchKeep))
  searchKeep = ""
  const files = new Set(hits.map((h) => h.path)).size
  const q = searchQuery.value
  $("search-count").textContent = !q ? "" : !hits.length ? `No results for "${q}"`
    : more ? `${hits.length}+ results: refine the search`
    : `${hits.length} result${hits.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
  let html = "", last = ""
  hits.forEach((h, i) => {
    if (h.path !== last) {
      last = h.path
      const n = hits.filter((x) => x.path === h.path).length
      html += `<div class="search-file" title="${esc(h.path)}"><span>${esc(h.path)}</span><em>${n}</em><button data-replace="${esc(h.path)}" title="Replace in this file only" aria-label="Replace in ${esc(h.path)}">Replace</button></div>`
    }
    html += `<button class="search-hit" role="option" tabindex="-1" data-i="${i}" aria-selected="${i === searchSel}">${esc(h.before.length > 24 ? "…" + h.before.slice(-24) : h.before.trimStart())}<mark>${esc(h.hit)}</mark>${esc(h.after)}</button>`
  })
  $("search-results").innerHTML = html
  renderReplace()
}

// Replace across the project: the file counts the view shows go to the app as `expected`, and
// the app writes nothing unless the text still gives those counts.
const searchReplace = $("search-replace") as HTMLInputElement
const replaceAll = $<HTMLButtonElement>("search-replace-all")
let searchShown = { query: "", case: false, word: false } // what the rows on screen were searched with
let searchAsked = searchShown // what the newest search asked
let replacing = false

function renderReplace() {
  replaceAll.disabled = !searchHits.length || searchMore || replacing
  replaceAll.title = `Replace all${searchHits.length ? ` ${searchHits.length}` : ""} (Cmd+Enter in the Replace box)`
}

async function replaceInProject(only?: string) {
  if (replacing || !searchHits.length || searchMore) return
  const counts = new Map<string, number>()
  for (const h of searchHits) if (!only || h.path === only) counts.set(h.path, (counts.get(h.path) ?? 0) + 1)
  const shown = { ...searchShown }
  replacing = true
  renderReplace()
  // The open text goes to disk first, and typing waits until the app answers.
  holdTyping(true)
  const error = await flushSave(true)
  if (error) {
    holdTyping(false)
    replacing = false
    renderReplace()
    toast(`Nothing was replaced: ${baseName(current!)} could not be saved first.`)
    return
  }
  send({ type: "replace_in_project", req: (leaving = ++reqSeq), query: shown.query, case: shown.case, word: shown.word, replacement: searchReplace.value, expected: [...counts].map(([path, count]) => ({ path, count })) })
}

// The app answered (or failed): typing is free again and the results are asked for afresh.
function replaced(r: { ok: boolean; files: number; places: number; error: string; op: number; paths: string[] }) {
  replacing = false
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
  if (r.ok) opToast = toast(`Replaced ${n(r.places, "place")} in ${n(r.files, "file")}. Review the changes.`, "info", offerUndo("replace", r))
  else toast(r.error)
  runSearch()
}

replaceAll.onclick = () => replaceInProject()
searchReplace.addEventListener("keydown", (e) => {
  if (e.isComposing) return
  if (e.key === "Enter") { if (e.metaKey || e.ctrlKey) replaceInProject(); e.preventDefault() } // plain Enter does nothing
  else if (e.key === "Escape") { if (current) ta.focus({ preventScroll: true }); e.preventDefault() }
})
// Tab from the query goes straight to the Replace box.
searchQuery.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.isComposing) { searchReplace.focus(); e.preventDefault() }
})

function selectHit(i: number) {
  if (!searchHits.length) return
  searchSel = (i + searchHits.length) % searchHits.length
  for (const el of $("search-results").querySelectorAll<HTMLElement>(".search-hit")) {
    const on = Number(el.dataset.i) === searchSel
    el.setAttribute("aria-selected", String(on))
    if (on) el.scrollIntoView({ block: "nearest" })
  }
}

function openHit(i = searchSel) {
  const h = searchHits[i]
  if (h) goTo(h.path, h.line, h.col, true, h.len)
}

searchQuery.oninput = () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(runSearch, 150) }
for (const b of [searchCase, searchWord]) b.onclick = () => { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); runSearch(); searchQuery.focus() }
searchQuery.addEventListener("keydown", (e) => {
  if (e.isComposing) return
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { selectHit(searchSel + (e.key === "ArrowDown" ? 1 : -1)); e.preventDefault() }
  else if (e.key === "Enter") { clearTimeout(searchTimer); if (searchReq && searchHits.length) openHit(); e.preventDefault() }
  else if (e.key === "Escape") { if (current) ta.focus({ preventScroll: true }); e.preventDefault() }
})
$("search-results").onmousedown = (e) => e.preventDefault()
$("search-results").onclick = (e) => {
  const file = (e.target as HTMLElement).closest<HTMLElement>("[data-replace]")
  if (file) return void replaceInProject(file.dataset.replace)
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")
  if (row) { selectHit(Number(row.dataset.i)); openHit() }
}

let quickOpener: HTMLElement | null = null
let quickOpenerPath: string | undefined
const mac = /Mac/i.test(navigator.platform)
const kc = (id: string) => { const s = shortcutFor(id); return s ? keyText(s, mac) : keysForCommand(id, mac) ?? "" }

function recentFiles(): string[] {
  try {
    const list: unknown = JSON.parse(store.get(`file-recent.${root}`) ?? "[]")
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []
  } catch { return [] }
}
function rememberFile(path: string) {
  if (root) store.set(`file-recent.${root}`, JSON.stringify([path, ...recentFiles().filter((p) => p !== path)].slice(0, 30)))
}

function quickCommands(): QuickItem[] {
  const click = (id: string) => () => $(id).click()
  const commands: QuickItem[] = [
    { id: "shortcuts", label: "Keyboard shortcuts", keys: kc("shortcuts"), run: openShortcuts },
    { id: "open-project", label: "Open project…", run: click("open-folder") },
    { id: "new-project", label: "New project…", run: click("new-project") },
    { id: "sidebar", label: "Toggle explorer", keys: kc("sidebar"), run: click("toggle-sidebar") },
    { id: "focus", label: "Toggle focus mode", keys: kc("focus"), run: toggleFocus },
    { id: "chat", label: "Toggle chat", keys: kc("chat"), run: () => { if (isOpen("chat")) setPanel("chat", false); else openChat() } },
    { id: "setup", label: "Check Setup…", run: () => send({ type: "check_setup" }) },
    { id: "autocomplete", label: "Turn autocomplete " + (acToggle.checked ? "off" : "on"), run: () => acToggle.click() },
    { id: "ac-settings", label: "Autocomplete settings…", run: click("sb-ac") },
    { id: "ck-settings", label: "Suggestions settings…", run: click("sb-ck") },
    { id: "ed-settings", label: "Edits settings…", run: click("sb-ed") },
    { id: "ch-settings", label: "Chat settings…", run: click("chat-source") },
    { id: "autosave", label: "Turn auto save " + (autosave ? "off" : "on"), run: click("sb-autosave") },
    { id: "zoom-in", label: "Zoom in", keys: kc("zoom-in"), run: () => setZoom(zoom + 0.1) },
    { id: "zoom-out", label: "Zoom out", keys: kc("zoom-out"), run: () => setZoom(zoom - 0.1) },
    { id: "zoom-reset", label: "Reset zoom", keys: kc("zoom-reset"), run: () => setZoom(1) },
    { id: "theme-system", label: "Color theme: Follow system", run: () => { store.del("theme"); applyTheme() } },
    ...THEMES.flatMap((t) => t === "-" ? [] : [{ id: "theme-" + t[0], label: "Color theme: " + t[1], run: () => { store.set("theme", t[0]); applyTheme() } }]),
  ]
  if (root) commands.push(
    { id: "search", label: "Search in project…", keys: kc("search"), run: openSearch },
    { id: "preview", label: "Toggle preview", keys: kc("preview"), run: click("toggle-preview") },
    { id: "new-file", label: "New file…", run: click("new-file") },
    { id: "new-folder", label: "New folder…", run: click("new-folder") },
  )
  if (selected && [...files, ...dirs].includes(selected)) {
    const path = selected
    commands.push({ id: "move", label: `Move ${baseName(path)} to a folder…`, run: () => openPalette(MOVE, path) })
  }
  if (current) commands.push(
    { id: "goal", label: "Set writing goal…", run: () => { goalAsk = true; openPalette() } },
    { id: "back", label: "Go back", keys: kc("back"), run: () => goPlace("back") },
    { id: "forward", label: "Go forward", keys: kc("forward"), run: () => goPlace("forward") },
    { id: "find", label: "Find in file", keys: kc("find"), run: click("open-find") },
    { id: "save", label: "Save file", keys: kc("save"), run: () => flushSave(true) },
    { id: "history", label: "File history…", run: () => openHistory() },
  )
  if (current && syntax()) commands.push({ id: "sections", label: "Go to section…", keys: kc("sections"), run: () => openPalette("@") })
  if (root) commands.push({ id: "labels", label: "Go to label…", run: () => openPalette("#") })
  if (root && labels.length) commands.push({ id: "rename-label", label: "Rename label…", keys: kc("rename-label"), run: () => { if (!renameLabelAtCaret()) { renamePick = true; openPalette("#") } } })
  if (current && syntax()) commands.push({ id: "export", label: "Export document…", run: click("export") })
  if (previewing && files.includes(previewing)) for (const [as, label] of Object.entries(PREVIEW_AS)) commands.push({
    id: "preview-" + as, label: "Preview as " + label,
    run: () => { setPanel("preview", true); document.querySelector<HTMLElement>('[data-as="' + as + '"]')!.click() },
  })
  if (compileDiagnostics[0]?.path && files.includes(compileDiagnostics[0].path)) commands.push({ id: "first-error", label: "Go to first error", run: () => jumpToDiagnostic() })
  if (root) commands.push( // last, so "Go to" still lists sections and labels first
    { id: "problems", label: "Show problems", run: openProblems },
    { id: "next-problem", label: "Go to next problem", keys: kc("next-problem"), run: () => stepProblems(1) },
    { id: "prev-problem", label: "Go to previous problem", keys: kc("prev-problem"), run: () => stepProblems(-1) },
  )
  return commands
}

function markedText(text: string, positions: number[], offset = 0) {
  const matched = new Set(positions)
  let at = offset
  return Array.from(text, (c) => { const mark = matched.has(at); at += c.length; return mark ? "<mark>" + esc(c) + "</mark>" : esc(c) }).join("")
}

type QuickKind = "files" | "commands" | "sections" | "labels" | "goal" | "folders"
let quickKind: QuickKind = "files"
let moveAsk: string | null = null // the list picks the folder this path moves into
const MOVE = ""
let goalAsk = false // the list asks for a word goal instead of listing files
let renamePick = false // the "#" list picks the label to rename instead of going to it
const QUICK = {
  files: { title: "Open a file", aria: "Search project files", noun: "file", icon: (id: string) => fileIcon(id) },
  commands: { title: "Run a command", aria: "Search commands", noun: "command", icon: () => icon("chevron-right") },
  sections: { title: "Go to a section", aria: "Search sections of this file", noun: "section", icon: () => icon("list-tree") },
  folders: { title: "Move to a folder", aria: "Search folders", noun: "folder", icon: () => icon("folder") },
  goal: { title: "Set a writing goal", aria: "Words to write in this file", noun: "goal", icon: () => icon("target") },
  labels: { title: "Go to a label", aria: "Search labels in the project", noun: "label", icon: () => icon("tag") },
}
const QUICK_EMPTY: Record<QuickKind, () => string> = {
  files: () => !root ? "Open a project to find its files. Type > for commands." : "No matching files. Try a file name or folder name.",
  commands: () => "No matching commands. Try a different word.",
  sections: () => !current || !syntax() ? "Open a Typst, LaTeX or Markdown file to see its sections." : "No matching sections. Try a word from the heading.",
  folders: () => "No other folder to move it to. Create a folder first, or try another name.",
  goal: () => paletteQuery.value.trim() ? `Type a whole number from 1 to ${MAX_GOAL.toLocaleString()}, for example 500.` : "Type how many words you want to add to this file, for example 500.",
  labels: () => !root ? "Open a project to see its labels." : labels.length ? "No matching labels. Try a different word." : "No labels in this project yet. " + LABEL_HINT[lang],
}

// The text up to the first character picks the list: > commands, @ sections of this file,
// # labels of the project, anything else files.
function quickMode(raw: string): [QuickKind, string] {
  if (goalAsk) return ["goal", raw]
  if (moveAsk !== null) return ["folders", raw]
  const q = raw.trimStart()
  const kind = ({ ">": "commands", "@": "sections", "#": "labels" } as Record<string, QuickKind>)[q[0]] ?? "files"
  return [kind, kind === "files" ? raw : q.slice(1).trimStart()]
}

function renderPalette() {
  if (!palette.open) return
  const [kind, query] = quickMode(paletteQuery.value)
  quickKind = kind
  const q = QUICK[kind]
  $("quick-title").textContent = kind === "labels" && renamePick ? "Rename a label" : q.title
  paletteQuery.setAttribute("aria-label", q.aria)
  if (kind === "goal") {
    const n = parseGoal(query)
    quickItems = n ? [{ id: "goal-" + n, label: `Add ${n.toLocaleString()} words to this file`, run: () => setGoal(n) }] : []
  } else if (kind === "folders") {
    const from = moveAsk!
    quickItems = ["", ...dirs].filter((d) => canMoveTo(from, d)).flatMap((d) => {
      const label = d || "Top level of the project"
      const match = fuzzyMatch(label, query)
      return match ? [{ id: "folder-" + d, label, positions: match.positions, score: match.score, run: () => moveInto(from, d) }] : []
    })
  } else if (kind === "commands") quickItems = quickCommands().flatMap((c) => {
    const match = fuzzyMatch(c.label, query)
    return match ? [{ ...c, ...match }] : []
  }).sort((a, b) => b.score - a.score)
  else if (kind === "sections") {
    const heads = current && syntax() ? outline(ta.value, lang, syntax()!.headingOf) : []
    const caret = lineOf(ta.selectionStart)
    const here = heads.filter((h) => h.line <= caret).length - 1
    const items = heads.flatMap((h, i) => {
      const title = headingTitle(lang, h.title)
      const match = fuzzyMatch(title, query)
      return match ? [{ id: "section-" + h.line, label: title, indent: h.level - 1, detail: i === here ? "Current" : "Line " + (h.line + 1), score: match.score, positions: match.positions, run: () => goTo(current!, h.line, 0), here: i === here }] : []
    })
    quickItems = query.trim() ? items.sort((a, b) => b.score - a.score) : items // document order when nothing is typed
    if (!query.trim() && quickIndex === 0) quickIndex = Math.max(0, items.findIndex((i) => i.here))
  } else if (kind === "labels") {
    const broken = renamePick ? [] : nowhere.flatMap((n) => {
      const match = fuzzyMatch(n.key, query)
      return match ? [{ id: "missing-" + n.path + ":" + n.line + ":" + n.col, label: n.key, dir: n.path, detail: "points nowhere", score: match.score, positions: match.positions, run: () => goTo(n.path, n.line, n.col) }] : []
    })
    const pick = renamePick
    quickItems = labels.flatMap((l) => {
      const match = fuzzyMatch(l.name, query)
      return match ? [{ id: "label-" + l.path + ":" + l.line + ":" + l.name, label: l.name, dir: l.path, detail: l.refs ? `${l.refs} use${l.refs > 1 ? "s" : ""}` : "unused", score: match.score, positions: match.positions, run: () => pick ? startLabelRename(l.name, l.path) : goTo(l.path, l.line, l.col) }] : []
    })
    if (query.trim()) {
      quickItems.push(...broken)
      quickItems.sort((a, b) => b.score! - a.score!)
    } else quickItems.unshift(...broken) // broken keys first when nothing is typed
  } else {
    const recent = recentFiles()
    const folder = root
    quickItems = rankFiles(files, query, recent).map((m) => ({
      id: m.path, label: m.path, positions: m.positions,
      detail: m.path === current ? "Open" : recent.includes(m.path) ? "Recent" : "",
      run: async () => {
        if (m.path === current) { if (mode === "edit") ta.focus(); return }
        if (root !== folder || !files.includes(m.path)) return
        ta.focus({ preventScroll: true })
        leaveThen({ type: "open_file", path: m.path })
      },
    }))
  }
  quickIndex = Math.min(quickIndex, Math.max(0, quickItems.length - 1))
  paletteList.innerHTML = quickItems.map((item, i) => {
    const isFile = kind === "files"
    const start = isFile ? item.label.lastIndexOf("/") + 1 : 0
    const name = markedText(item.label.slice(start), item.positions ?? [], start)
    const directory = isFile ? (start ? markedText(item.label.slice(0, start - 1), item.positions ?? []) : "") : esc(item.dir ?? "")
    return '<div id="quick-option-' + i + '" role="option" aria-selected="' + (i === quickIndex) + '" data-index="' + i + '" class="quick-row" title="' + esc(item.dir ? item.label + " in " + item.dir : item.label) + '"' +
      (item.indent ? ' style="padding-left:' + (8 + item.indent * 14) + 'px"' : "") + '>' +
      q.icon(item.id) + '<span class="quick-name">' + name + '</span>' +
      (directory ? '<span class="quick-path">' + directory + '</span>' : "") + '<span class="quick-detail">' + esc(item.keys ?? item.detail ?? "") + '</span></div>'
  }).join("")
  $("quick-empty").hidden = !!quickItems.length
  $("quick-empty").textContent = QUICK_EMPTY[kind]()
  $("quick-count").textContent = `${quickItems.length} ${q.noun}${quickItems.length === 1 ? "" : "s"}`
  selectQuickItem(quickIndex)
}

function selectQuickItem(index: number) {
  quickIndex = index
  for (const row of paletteList.children) row.setAttribute("aria-selected", String(Number((row as HTMLElement).dataset.index) === index))
  const active = paletteList.children[index] as HTMLElement | undefined
  if (active) {
    paletteQuery.setAttribute("aria-activedescendant", active.id)
    active.scrollIntoView({ block: "nearest" })
  } else paletteQuery.removeAttribute("aria-activedescendant")
}

function placePalette() {
  if (!palette.open) return
  const editor = $("editor-group").getBoundingClientRect()
  const width = Math.min(560, innerWidth - 16, editor.width > 320 ? editor.width - 24 : innerWidth - 16)
  const centre = editor.width > 320 ? editor.left + editor.width / 2 : innerWidth / 2
  palette.style.width = width + "px"
  palette.style.left = Math.max(8, Math.min(centre - width / 2, innerWidth - width - 8)) + "px"
  palette.style.top = $("titlebar").getBoundingClientRect().bottom + 8 + "px"
  placePreview()
}

function openPalette(prefix = "", moving: string | null = null) {
  moveAsk = moving
  if (document.querySelector("dialog[open]") && !palette.open) return
  if (!palette.open) {
    quickOpener = document.activeElement as HTMLElement | null
    quickOpenerPath = quickOpener?.dataset.path
    clearTimeout(menuTimer)
    menu.hidden = true
    hideMenu()
    $("diagnostic-card").hidden = true
    palette.showModal()
  }
  paletteQuery.value = prefix
  quickIndex = 0
  renderPalette()
  placePalette()
  paletteQuery.focus()
}

function closePalette(restore = true) {
  if (!palette.open) return
  renamePick = false // the list's rows already know whether they rename
  goalAsk = false
  moveAsk = null
  palette.close()
  if (restore) {
    const opener = quickOpener?.isConnected ? quickOpener : [...$("tree").querySelectorAll<HTMLElement>("[data-path]")].find((el) => el.dataset.path === quickOpenerPath)
    const target = opener ?? ta
    target.focus({ preventScroll: true })
  }
  placePreview()
}
function runQuickItem(index = quickIndex) {
  const item = quickItems[index]
  if (!item) return
  const commands = quickKind === "commands"
  closePalette()
  // Recheck availability: a file or build result may have changed while the list was open.
  if (commands) quickCommands().find((c) => c.id === item.id)?.run()
  else item.run()
}
paletteQuery.oninput = () => { quickIndex = 0; renderPalette() }
palette.addEventListener("cancel", (e) => { e.preventDefault(); closePalette() })
palette.addEventListener("click", (e) => {
  const r = palette.getBoundingClientRect()
  if (e.target === palette && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) closePalette()
})
paletteList.onmousedown = (e) => e.preventDefault()
paletteList.onclick = (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]")
  if (row) runQuickItem(Number(row.dataset.index))
}
$("quick-close").onclick = () => closePalette()
$("open-quick").onclick = () => openPalette()
palette.addEventListener("keydown", (e) => {
  if (e.isComposing) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") openPalette(e.shiftKey ? ">" : "")
  else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") openPalette("@")
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (quickItems.length) selectQuickItem((quickIndex + (e.key === "ArrowDown" ? 1 : -1) + quickItems.length) % quickItems.length)
  } else if (e.key === "Enter" && e.target === paletteQuery) runQuickItem()
  else if (e.key === "Tab") (document.activeElement === paletteQuery ? $("quick-close") : paletteQuery).focus()
  else return
  e.preventDefault()
  e.stopPropagation()
})
new ResizeObserver(placePalette).observe($("editor-group"))
addEventListener("resize", placePalette)
addEventListener("blur", () => closePalette(false))

// ---------- the preview's own web view (preview.ts): a long document drawing there never holds up typing here ----------

const toPreview = (msg: object) => tauri.event.emit("to-preview", msg)
let previewUrl = ""
function showPreview(url: string) {
  if (url === previewUrl) return
  previewUrl = url
  if (url) $("preview").dataset.url = url
  else delete $("preview").dataset.url
  toPreview({ src: url })
}
// ---------- the shortcut sheet: every key in one searchable list, built from shortcuts.ts ----------

const sheet = $<HTMLDialogElement>("keys-sheet"), sheetQuery = $<HTMLInputElement>("keys-query")
let sheetOpener: HTMLElement | null = null
const capsHtml = (s: Shortcut) => keyCaps(s, mac).map((c) => `<kbd>${esc(c)}</kbd>`).join("")
function renderSheet() {
  const rows = filterShortcuts(sheetQuery.value, mac)
  let group = ""
  $("keys-list").innerHTML = rows.map((s) => {
    const head = s.group === group ? "" : `<h3>${esc((group = s.group))}</h3>`
    return `${head}<div class="keys-row"><span>${esc(s.action)}</span><span class="keys-caps">${capsHtml(s)}</span></div>`
  }).join("")
  $("keys-empty").hidden = rows.length > 0
}
function openShortcuts() {
  if (sheet.open) return sheetQuery.focus()
  if (document.querySelector("dialog[open]")) return
  sheetOpener = document.activeElement as HTMLElement | null
  hideMenu()
  sheetQuery.value = ""
  renderSheet()
  sheet.showModal()
  const editor = $("editor-group").getBoundingClientRect()
  const width = Math.min(520, innerWidth - 16)
  const centre = editor.width > 320 ? editor.left + editor.width / 2 : innerWidth / 2
  sheet.style.width = width + "px"
  sheet.style.left = Math.max(8, Math.min(centre - width / 2, innerWidth - width - 8)) + "px"
  sheet.style.top = $("titlebar").getBoundingClientRect().bottom + 8 + "px"
  sheetQuery.focus()
  placePreview()
}
function closeShortcuts() {
  if (!sheet.open) return
  sheet.close()
  ;(sheetOpener?.isConnected ? sheetOpener : ta).focus({ preventScroll: true })
  placePreview()
}
sheetQuery.oninput = renderSheet
sheet.addEventListener("cancel", (e) => { e.preventDefault(); closeShortcuts() })
$("keys-close").onclick = closeShortcuts
$("sb-keys").onclick = openShortcuts

// ---------- file history: earlier versions of the open file, and restoring one ----------
const hist = $<HTMLDialogElement>("history-sheet")
let historyFor: string | null = null // a file to show the history of once it is open
let historyReq = 0
let historyRows: { at: number; text: string; lines?: Line[]; coarse?: boolean }[] = []
let historyAt = 0
let historyOpener: HTMLElement | null = null

function openHistory(path = current) {
  if (!root || !path) return
  if (document.querySelector("dialog[open]")) return
  if (path !== current) {
    historyFor = path
    leaveThen({ type: "open_file", path }).then((ok) => { if (!ok) historyFor = null })
    return
  }
  historyFor = null
  historyOpener = document.activeElement as HTMLElement | null
  send({ type: "list_history", req: (historyReq = ++reqSeq), path })
}
function showHistory(req: number, path: string, versions: { at: number; text: string }[]) {
  if (req !== historyReq || path !== current) return
  const now = Date.now()
  historyRows = versions.map((v) => ({ ...v })) // compared with the text now only when needed
  historyAt = 0
  $("history-title").textContent = `File history: ${baseName(path)}`
  $("history-empty").hidden = historyRows.length > 0
  $("history-body").hidden = historyRows.length === 0
  $("history-list").innerHTML = historyRows.map((r, i) => `<button class="history-row" role="option" data-i="${i}"><span>${esc(whenText(r.at, now))}</span><span class="history-count"></span></button>`).join("")
  hist.showModal()
  const editor = $("editor-group").getBoundingClientRect()
  const width = Math.min(620, innerWidth - 16)
  const centre = editor.width > 320 ? editor.left + editor.width / 2 : innerWidth / 2
  hist.style.width = width + "px"
  hist.style.left = Math.max(8, Math.min(centre - width / 2, innerWidth - width - 8)) + "px"
  hist.style.top = $("titlebar").getBoundingClientRect().bottom + 8 + "px"
  if (historyRows.length) pickVersion(0)
  else $("history-close").focus()
  placePreview()
  fillCounts(req)
}
// The first version is compared at once; the other rows get their +/- counts one at a time while the writer reads,
// so a long file with many versions opens without waiting for all of them.
function compared(i: number) {
  const r = historyRows[i]
  if (!r.lines) Object.assign(r, diffLines(ta.value, r.text))
  return r as typeof r & { lines: Line[]; coarse: boolean }
}
function countCell(i: number) {
  const c = changeCount(compared(i).lines)
  $("history-list").children[i].querySelector(".history-count")!.innerHTML = `<b class="add">+${c.added}</b> <b class="del">\u2212${c.removed}</b>`
}
async function fillCounts(req: number) {
  for (let i = 0; i < historyRows.length; i++) {
    await new Promise((r) => setTimeout(r, 0))
    if (req !== historyReq || !hist.open) return
    countCell(i)
  }
}
function pickVersion(i: number) {
  historyAt = Math.max(0, Math.min(i, historyRows.length - 1))
  const r = compared(historyAt)
  countCell(historyAt)
  const rows = [...$("history-list").children] as HTMLElement[]
  rows.forEach((el, n) => { el.classList.toggle("on", n === historyAt); el.setAttribute("aria-selected", String(n === historyAt)) })
  rows[historyAt].scrollIntoView({ block: "nearest" })
  rows[historyAt].focus({ preventScroll: true })
  // Only the lines that differ, with two lines around each change.
  const show = r.lines.map((l, n) => l.op !== " " || r.lines.slice(Math.max(0, n - 2), n + 3).some((m) => m.op !== " "))
  let html = "", gap = false
  r.lines.forEach((l, n) => {
    if (!show[n]) return void (gap = true)
    if (gap && html) html += `<div class="dl gap">\u2026</div>`
    gap = false
    html += `<div class="dl ${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}"><i>${l.op === " " ? "" : l.op === "+" ? "+" : "\u2212"}</i>${esc(l.text) || " "}</div>`
  })
  const same = r.lines.every((l) => l.op === " ")
  $("history-diff").innerHTML = same ? `<p class="history-same">This version is the same as the text now.</p>` : html
  $("history-note").textContent = r.coarse
    ? "This file changed too much to compare line by line: the text now is shown removed and this version added."
    : "Restoring adds the green lines and removes the red ones. One Undo brings the text now back."
  $<HTMLButtonElement>("history-restore").disabled = same
}
function closeHistory() {
  if (!hist.open) return
  hist.close()
  ;(historyOpener?.isConnected ? historyOpener : ta).focus({ preventScroll: true })
  placePreview()
}
function restoreVersion() {
  const r = historyRows[historyAt]
  if (!r || !current) return
  if (ta.readOnly) return void toast("Quire is still saving. Wait a moment, then try again.", "info")
  send({ type: "snapshot", path: current, content: ta.value }) // the text now stays in the history
  const when = whenText(r.at, Date.now())
  closeHistory() // first: the editor is out of reach while the dialog is open, and its undo would not see the edit
  edit(0, ta.value.length, r.text)
  flushSave(true)
  toast(`Restored the version from ${when}. Press Undo to bring back the text from before.`, "info")
}
$("history-list").onclick = (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".history-row")
  if (row) pickVersion(Number(row.dataset.i))
}
$("history-list").onkeydown = (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  e.preventDefault()
  pickVersion(historyAt + (e.key === "ArrowDown" ? 1 : -1))
}
$("history-restore").onclick = restoreVersion
$("history-close").onclick = closeHistory
hist.addEventListener("cancel", (e) => { e.preventDefault(); closeHistory() })
$("welcome-keys").onclick = openShortcuts
$("shortcuts").innerHTML = HINTS.map((id) => {
  const s = shortcutFor(id)!
  return `<dt>${esc(s.action)}</dt><dd>${capsHtml(s)}</dd>`
}).join("")


// The web view sits over #preview. A native view covers whatever the page floats over it, so
// it steps aside while a dialog or menu would sit under it, and notices go to its left.
const floating = ["quick-input", "keys-sheet", "history-sheet", "ask", "new-project-ask", "setup", "ac-settings", "ck-settings", "ed-settings", "ch-settings", "inline-box", "fix-card", "diagnostic-card", "rewrite-menu", "rewrite-card", "ref-list", "ctx-menu", "problems", "toasts", "sidebar", "chat"].map((id) => $(id))
let placing = 0
let placed = "" // the place last sent
let bgSent = "" // the theme's preview background last sent: the web view shows it while a preview loads
function placePreview() {
  cancelAnimationFrame(placing)
  placing = requestAnimationFrame(() => {
    const el = $("preview")
    const r = el.getBoundingClientRect()
    const right = r.width && r.left > 240 ? `${innerWidth - r.left + 12}px` : ""
    if ($("toasts").style.getPropertyValue("--toasts-right") !== right) $("toasts").style.setProperty("--toasts-right", right)
    const over = (o: DOMRect) => o.width > 0 && o.height > 0 && o.left < r.right - 1 && o.right > r.left + 1 && o.top < r.bottom - 1 && o.bottom > r.top + 1
    const shown = r.width > 0 && r.height > 0 && !floating.some((f) => over(f.getBoundingClientRect()))
    // In window points: the page's pixels are zoomed.
    const frame = shown ? { x: r.left * zoom, y: r.top * zoom, w: r.width * zoom, h: r.height * zoom, shown: innerHeight * zoom, zoom } : {}
    const bg = getComputedStyle(el).backgroundColor
    if (bg !== bgSent) toPreview({ bg: (bgSent = bg) })
    if (JSON.stringify(frame) === placed) return
    placed = JSON.stringify(frame)
    send({ type: "preview_frame", ...frame })
  })
}
new ResizeObserver(placePreview).observe($("preview"))
addEventListener("resize", placePreview)
const watched = { attributes: true, attributeFilter: ["open", "hidden", "class", "style", "data-theme", "data-url"], childList: true }
for (const el of [document.documentElement, app, $("preview"), ...floating]) new MutationObserver(placePreview).observe(el, watched)
tauri.event.listen("from-preview", ({ payload }: { payload: string }) => {
  if (payload === "ready") return sendMarkdown()
  // The web view (re)started: it knows nothing yet.
  toPreview({ src: previewUrl })
  placed = bgSent = ""
  placePreview()
})
let markdownTimer = 0
function sendMarkdown() {
  clearTimeout(markdownTimer)
  markdownTimer = window.setTimeout(() => {
    if (previewKind === "markdown" && current && current === previewing) toPreview({ markdown: ta.value, dir: parentOf(current) })
  }, 150)
}
// The live Typst preview shows the text as typed: it need not wait for auto save to write it.
// It goes at once, as in VS Code; tinymist takes the keys that come while it compiles together.
let typedSent = "" // path and text last sent
function sendTyped() {
  if (!previewing || !["typst", "latex"].includes(langOf(previewing)) || !current) return
  const key = `${previewing}\n${current}\n${diagnosticGeneration}\n${ta.value}`
  if (key === typedSent) return
  typedSent = key
  send({ type: "typed", path: current, content: ta.value, main: previewing, generation: diagnosticGeneration })
}

// ---------- compile errors: the same colored layer as suggestions, never the text field ----------

let diagnosticGeneration = 0
let compileMain: string | null = null
let compileDiagnostics: Diagnostic[] = []
let compileLog = ""
let compileTool = "" // the message of a build that could not run because a program is missing
const compiledMains = new Set<string>() // previews that have shown a good version since this folder opened
const compileMarks = typeof Highlight === "function" ? new Highlight() : null
if (compileMarks) CSS.highlights.set("compile-error", compileMarks)

function invalidateDiagnostics() {
  diagnosticGeneration++ // immediately, before the next render sends the new text
  compileDiagnostics = []
  compileLog = ""
  renderDiagnostics()
}

// While the writer types, the errors stay (moved along with the edit, dimmed) until the next result:
// hiding them on every key made the banner blink and the preview jump by its height.
let diagnosticAt: { path: string; text: string } | null = null // the file and text the errors were placed on
function shiftDiagnosticsForTyping() {
  if (!compileDiagnostics.length || !current || diagnosticAt?.path !== current) return invalidateDiagnostics()
  diagnosticGeneration++
  compileDiagnostics = shiftDiagnostics(diagnosticAt.text, minimalChange(diagnosticAt.text, ta.value), current, compileDiagnostics)
  diagnosticAt.text = ta.value
  if (!compileDiagnostics.length) compileLog = ""
  renderDiagnostics(true)
}

function receiveDiagnostics(batch: DiagnosticBatch, log = "", tool = "") {
  if (!isCurrentDiagnostic(batch, root, previewing, diagnosticGeneration, current, ta.value)) return false
  diagnosticAt = current ? { path: current, text: ta.value } : null
  compileMain = batch.main
  compileTool = tool
  if (!batch.diagnostics.length && !tool) compiledMains.add(batch.main)
  compileDiagnostics = batch.diagnostics
  compileLog = log
  renderDiagnostics()
  return true
}

function jumpToDiagnostic(d = compileDiagnostics[0]) {
  if (d?.path) goTo(d.path, d.line, d.col, true)
}
$("sb-errors").onclick = () => ($("problems").hidden ? openProblems() : closeProblems())
$("compile-jump").onclick = () => jumpToDiagnostic()
$("compile-setup").onclick = () => send({ type: "check_setup" })

function renderDiagnostics(pending = false) {
  document.body.classList.toggle("errors-pending", pending)
  const first = compileDiagnostics[0]
  renderProblems()
  $("compile-banner").hidden = !first && !compileTool
  $("compile-setup").hidden = !compileTool
  $("compile-note").textContent = compileMain && compiledMains.has(compileMain)
    ? "The preview shows the last version that compiled."
    : "Nothing has compiled yet, so there is no preview."
  if (first || compileTool) {
    const jump = $("compile-jump") as HTMLButtonElement
    jump.textContent = compileTool ? compileTool : first.path
      ? `The document has an error in ${first.path} on line ${first.line + 1}: ${first.message}`
      : first.message
    jump.disabled = !first?.path
    jump.title = first?.path ? "Go to this error" : ""
  }
  $("compile-log").hidden = !compileLog
  $("compile-log-text").textContent = compileLog
  if (!compileLog) $("compile-log").removeAttribute("open")
  paintDiagnostics()
}

// Every problem in the project: compile errors and keys that point nowhere. The status bar counts them, the
// list under it shows them, and F8 steps through them in the same order.
function problemList(): Problem[] {
  return projectProblems(compileDiagnostics, document.body.classList.contains("errors-pending"), nowhere)
}

function renderProblems() {
  const list = problemList()
  const n = list.length, errors = errorCount(compileDiagnostics)
  const status = $("sb-errors") as HTMLButtonElement
  const open = !$("problems").hidden
  status.hidden = !n && !open
  const noun = n === errors ? "error" : "problem"
  status.innerHTML = `${icon("error")} <span>${n} ${noun}${n === 1 ? "" : "s"}</span>`
  status.title = n ? "Show the problems" : "No problems"
  status.setAttribute("aria-expanded", String(open))
  if (!open) return
  const box = $("problems")
  const had = box.contains(document.activeElement) ? [...box.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement) : -1
  let html = n ? "" : `<p class="muted problems-empty">No problems.</p>`
  let file = ""
  list.forEach((p, i) => {
    if (p.path !== file) html += `<div class="problems-file">${esc(p.path)}</div>`
    file = p.path
    const fix = p.diag ? errorFix(p.diag) : null
    const key = p.nowhere ? keyChoices(p.nowhere)[0] : undefined
    html += `<div class="problems-item"><button type="button" class="problems-row" data-i="${i}" title="Go to this problem"><span class="problems-line">Line ${p.line + 1}</span> ${esc(p.text)}</button>` +
      (fix ? `<button type="button" class="fix" data-i="${i}" data-fix="1">${esc(fix.label)}</button>` : key ? `<button type="button" class="fix" data-i="${i}" data-fix="1">Did you mean ${esc(key)}?</button>` : "") + "</div>"
  })
  box.innerHTML = html
  if (had >= 0) (box.querySelectorAll("button")[Math.min(had, box.querySelectorAll("button").length - 1)] as HTMLElement | undefined)?.focus()
  placeProblems()
}

// Above the status bar, under the item that opened it.
function placeProblems() {
  const box = $("problems"), r = $("sb-errors").getBoundingClientRect()
  box.style.left = `${Math.max(4, Math.min(r.left, innerWidth - box.offsetWidth - 4))}px`
  box.style.bottom = `${innerHeight - r.top + 4}px`
}

function openProblems() {
  $("problems").hidden = false
  renderProblems()
  ;($("problems").querySelector(".problems-row") as HTMLElement | null)?.focus()
}

function closeProblems(focusEditor = true) {
  if ($("problems").hidden) return
  $("problems").hidden = true
  renderProblems()
  if (focusEditor && mode === "edit" && current) ta.focus({ preventScroll: true })
}

$("problems").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button")
  const p = b && problemList()[Number(b.dataset.i)]
  if (!p) return
  closeProblems(false)
  if (!b.dataset.fix) return void goTo(p.path, p.line, p.col, p.utf16)
  const fix = p.diag && errorFix(p.diag)
  const key = p.nowhere && keyChoices(p.nowhere)[0]
  if (fix) applyErrorFix(fix)
  else if (p.nowhere && key) applyKeyFix(p.nowhere, key)
})
$("problems").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeProblems(); return }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  const rows = [...$("problems").querySelectorAll<HTMLElement>(".problems-row")]
  const i = rows.indexOf((document.activeElement as HTMLElement).closest(".problems-item")?.querySelector(".problems-row") as HTMLElement)
  e.preventDefault()
  rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus()
})
document.addEventListener("mousedown", (e) => {
  if (!$("problems").hidden && !$("problems").contains(e.target as Node) && !$("sb-errors").contains(e.target as Node)) closeProblems(false)
})

// F8 and Shift+F8: the next or previous problem after the caret, across files. At the end it wraps and says so.
function stepProblems(dir: 1 | -1) {
  const list = problemList()
  if (!list.length) return void toast("No problems.", "info")
  const r = stepProblem(list, { path: current ?? "", line: current ? lineOf(ta.selectionStart) : -1 }, dir)!
  closeProblems(false)
  if (r.wrapped) toast(dir === 1 ? "Back to the first problem." : "Back to the last problem.", "info")
  goTo(r.problem.path, r.problem.line, r.problem.col, r.problem.utf16)
}

function paintDiagnostics() {
  compileMarks?.clear()
  for (const line of hl.querySelectorAll(".compile-error-line")) line.classList.remove("compile-error-line")
  for (const d of compileDiagnostics.filter((d) => d.path === current).slice(0, 20)) {
    const offsets = diagnosticRange(ta.value, d)
    if (!offsets) continue
    hl.children[d.line]?.classList.add("compile-error-line")
    const from = nodeAt(offsets.from), to = nodeAt(offsets.to)
    if (!from || !to) continue
    const range = document.createRange()
    range.setStart(...from)
    range.setEnd(...to)
    compileMarks?.add(range)
  }
  showDiagnosticAtCaret()
}

function showDiagnosticAtCaret() {
  const card = $("diagnostic-card")
  const d = document.activeElement === ta && mode === "edit" && compileDiagnostics.find((d) => d.path === current && d.line === lineOf(ta.selectionStart))
  card.hidden = !d
  if (!d) {
    ta.removeAttribute("aria-describedby")
    return
  }
  const fix = errorFix(d)
  const html = `<strong>${esc(d.message)}</strong>${(fix ? [] : d.hints).map((h) => `<p>${esc(h)}</p>`).join("")}` +
    (fix ? `<button type="button" class="btn secondary sm errfix" title="Alt+Enter">${esc(fix.label)}</button>` : "")
  if (card.innerHTML !== html) card.innerHTML = html
  ta.setAttribute("aria-describedby", "diagnostic-card")
  floatAt(card, ta.selectionStart, ta.selectionStart)
}
ta.addEventListener("blur", () => { $("diagnostic-card").hidden = true })
// The card floats over the text: a press on its button must not take the caret out of the field, or the card would close first.
$("diagnostic-card").addEventListener("mousedown", (e) => e.preventDefault())
$("diagnostic-card").addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".errfix")) return
  const d = compileDiagnostics.find((d) => d.path === current && d.line === lineOf(ta.selectionStart))
  const fix = d && errorFix(d)
  if (fix) applyErrorFix(fix)
})
ta.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing || mode !== "edit") return
  const d = compileDiagnostics.find((d) => d.path === current && d.line === lineOf(ta.selectionStart))
  const fix = d && errorFix(d)
  if (!fix) return
  e.preventDefault()
  applyErrorFix(fix)
})
ta.addEventListener("keydown", (e) => { if (e.key === "Escape") $("diagnostic-card").hidden = true })
ta.addEventListener("keydown", (e) => { if (e.key === "F2" && !e.isComposing && renameLabelAtCaret()) e.preventDefault() })

// ---------- preview sync: a click in the preview shows that text; the preview follows the caret ----------

let pendingJump: { path: string; line: number; col: number; utf16?: boolean; len?: number; track?: boolean } | null = null
let followed = "" // the caret line the preview last scrolled to
let followTimer = 0

// ---------- places: where the caret was in each file, and Back / Forward between jumps ----------

let trail = newTrail()
type Spot = { line: number; col: number; top: number } // top: the first line in view
const here = (): Place => {
  const line = lineOf(ta.selectionStart)
  return { path: current!, line, col: ta.selectionStart - lineStarts[line] }
}
const posKey = () => `pos.${root}`
function loadPos(): Record<string, Spot> {
  try {
    const o: unknown = JSON.parse(store.get(posKey()) ?? "{}")
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, Spot>) : {}
  } catch { return {} }
}
function savePosAll(all: Record<string, Spot>) {
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete all[k]
  store.set(posKey(), JSON.stringify(all))
}
function topLine() {
  let lo = 0
  let hi = hl.children.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((hl.children[mid] as HTMLElement).offsetTop <= ta.scrollTop) lo = mid
    else hi = mid - 1
  }
  return lo
}
// The 30 most recent files are kept. Called when the caret settles and when the file is left. Most recent last.
function savePos() {
  if (!root || !current || mode !== "edit" || !files.includes(current)) return
  const all = loadPos()
  delete all[current]
  all[current] = { ...here(), top: topLine() }
  savePosAll(all)
}
let posTimer = 0
const settle = () => { clearTimeout(posTimer); posTimer = window.setTimeout(savePos, 400) }
document.addEventListener("selectionchange", () => { if (document.activeElement === ta) settle() })
ta.addEventListener("scroll", settle)
addEventListener("pagehide", savePos)
// Put the caret and the view back, clamped to a text that may have changed since.
function restorePos(s: Spot) {
  const num = (n: unknown) => (Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0)
  const line = Math.min(num(s.line), lineStarts.length - 1)
  const end = (l: number) => (l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : ta.value.length)
  const pos = Math.min(lineStarts[line] + num(s.col), end(line))
  ta.setSelectionRange(pos, pos)
  const top = hl.children[Math.min(num(s.top), hl.children.length - 1)] as HTMLElement | undefined
  ta.scrollTop = top ? top.offsetTop : 0
  hl.scrollTop = ta.scrollTop
}
function goPlace(dir: "back" | "forward") {
  if (!current) return void toast("Open a file first.")
  const before = { back: [...trail.back], fwd: [...trail.fwd] }
  const p = (dir === "back" ? goBack : goForward)(trail, here(), (path) => files.includes(path))
  if (!p) return void toast(dir === "back" ? "Nothing to go back to." : "Nothing to go forward to.")
  goTo(p.path, p.line, p.col, true, 0, false).then((ok) => {
    if (!ok) { trail.back = before.back; trail.fwd = before.fwd } // the save question was cancelled: the stop stays
  })
}

// tinymist counts columns in characters; the text field counts UTF-16 units.
// track: the jump is a place to come Back to (false for Back and Forward themselves, and for the second half
// of a jump that opened its file, which openFile has already recorded).
async function goTo(path: string, line: number, col: number, utf16 = false, len = 0, track = true): Promise<boolean> {
  if (path !== current) {
    pendingJump = { path, line, col, utf16, len, track }
    const ok = await leaveThen({ type: "open_file", path })
    if (!ok && pendingJump?.path === path) pendingJump = null
    return ok
  }
  pendingJump = null
  if (track) leave(trail, here(), { path, line, col })
  if (mode === "review") setMode("edit")
  const l = Math.min(line, lineStarts.length - 1)
  const text = lineText(l)
  const pos = lineStarts[l] + (utf16 ? Math.min(col, text.length) : [...text].slice(0, col).join("").length)
  ta.focus({ preventScroll: true })
  jumpSel = len ? [pos, pos + len] : null
  ta.setSelectionRange(pos, pos + len) // a search result selects the match
  const div = hl.children[l] as HTMLElement | undefined
  if (div) ta.scrollTop = Math.max(0, div.offsetTop - ta.clientHeight / 3)
  showDiagnosticAtCaret()
  return true
}

// Replace a key that points nowhere with the one the writer picked, as one undo step. In another file the file
// opens first (the same save question as any file change) and the key is replaced once it is open; the page never
// writes to a file it has not opened.
let pendingFix: { path: string; run: () => void } | null = null
function applyKeyFix(n: Nowhere, key: string) {
  if (!n) return
  if (n.path !== current) {
    pendingFix = { path: n.path, run: () => applyKeyFix(n, key) }
    pendingJump = { path: n.path, line: n.line, col: n.col }
    leaveThen({ type: "open_file", path: n.path }).then((ok) => { if (!ok) pendingFix = null })
    return
  }
  if (ta.readOnly) return void toast("Wait a moment, then try again.")
  if (mode === "review") setMode("edit")
  const span = n.line < lineStarts.length ? keySpan(lineText(n.line), n.col, n.key) : null
  if (!span) return void toast(`${n.key} has moved. Open it to fix by hand.`)
  const at = lineStarts[n.line] + span.from
  edit(at, lineStarts[n.line] + span.to, key)
  ta.setSelectionRange(at, at + key.length)
}

// The fix for a compile error, if one is certain. Command names the project defines come from the open file only.
function errorFix(d: Diagnostic): ErrorFix | null {
  const custom = d.path === current ? [...ta.value.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)|\\def\\([A-Za-z@]+)/g)].map((m) => m[1] ?? m[2]) : []
  return fixFor(d, { main: compileMain, files, custom, suggest: suggestKeys })
}

// Apply a fix as one undo step. The file it belongs to opens first (the same save question as any file change) and the
// text is read only once it is open; a stale position edits nothing.
async function applyErrorFix(fix: ErrorFix) {
  const target = fix.kind === "package" ? compileMain : fix.at.path
  if (!target) return
  if (target !== current) {
    pendingFix = { path: target, run: () => applyErrorFix(fix) }
    leaveThen({ type: "open_file", path: target }).then((ok) => { if (!ok) pendingFix = null })
    return
  }
  if (ta.readOnly || leaving) return void toast("Wait a moment, then try again.")
  if (mode === "review") setMode("edit")
  if (fix.kind === "path" && fix.to === undefined) {
    const r = await askPicture({ type: "pick_image" })
    if (r.cancelled) return
    if (r.error) return void toast(r.error)
    if (current !== target || ta.readOnly) return void toast("You changed file, so the path was not replaced.")
    fix = { ...fix, to: r.rel }
  }
  const c = planEdit(fix, ta.value)
  if (!c) return void toast(fix.kind === "package" ? `${fix.pkg} is already loaded, or the preamble is not in ${baseName(target)}. Add it by hand.` : "That line has changed. Open it to fix by hand.")
  edit(c.from, c.to, c.insert)
  ta.setSelectionRange(c.from, c.from + c.insert.length)
}

function followCaret() {
  clearTimeout(followTimer)
  followTimer = window.setTimeout(() => {
    if (!current?.endsWith(".typ") || !previewing || !isOpen("preview")) return
    const l = lineOf(ta.selectionStart)
    if (followed === `${current}:${l}`) return // only when the caret moves to another line
    followed = `${current}:${l}`
    // tinymist finds only text, not markup or labels: aim at the last letter before the caret.
    const start = Math.max(0, ta.selectionStart - 500)
    const before = ta.value.slice(start, ta.selectionStart).replace(/<[\w:.-]*>?\s*$/, "")
    const m = /[\p{L}\p{N}][^\p{L}\p{N}]*$/u.exec(before)
    const at = m ? start + m.index : ta.selectionStart
    const al = lineOf(at)
    send({ type: "scroll_preview", path: current, line: al, col: [...ta.value.slice(lineStarts[al], at)].length })
  }, 300)
}

// ---------- start ----------

// The Figure button asks for the picture when a project is open; without one it keeps the placeholder.
connectEditor(edit, () => openInline("cite"), () => {
  if (!root || !current || !syntax()) return false
  addPictures([{ type: "pick_image" }], ta.selectionEnd)
  return true
})
connectChat({
  send: (msg: any) => send(msg.type === "prompt" ? { ...msg, ...chApi() } : msg),
  context: () => ({ path: current, selection: ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null }),
  save: flushSave,
  working: (busy) => {
    // A turn with an API or Apple's model leaves the agent as it was.
    if (busy ? !chApi() : agentState === "working") agentState = busy ? "working" : "ready"
    renderAgentStatus()
  },
  show: () => setPanel("chat", true),
})

for (const p of Object.keys(panels) as Panel[]) {
  const saved = store.get(`panel.${p}`)
  // Narrow windows start with only the editor; the panels open over it.
  const narrow = (p === "preview" && innerWidth < 900) || (p === "sidebar" && innerWidth < 640)
  setPanel(p, saved == null ? defaults[p] && !narrow : saved === "1")
}
for (const k of ["sidebar-w", "chat-w", "preview-fr"]) {
  const v = store.get(k)
  if (v) app.style.setProperty(`--${k}`, v)
}
$("app-name").textContent = APP_NAME
$("welcome-mark").textContent = $("start-title").textContent = APP_NAME
function renderAutosave() {
  $("sb-autosave").innerHTML = `${icon("save")} <span>${autosave ? "Auto save" : "Auto save off"}</span>`
  $("sb-autosave").style.opacity = autosave ? "" : "0.75"
  $("sb-autosave").title = autosave
    ? "Saving as you type. Click to save only with Cmd+S."
    : "Saving only with Cmd+S. Click to save as you type."
}
$("sb-autosave").onclick = () => {
  autosave = !autosave
  store.set("autosave", autosave ? "on" : "off")
  if (autosave && isDirty() && !holdSave) flushSave()
  renderAutosave()
  updateDirty()
}
renderAutosave()
window.addEventListener("beforeunload", (e) => {
  // The page reloads: save now when it can be; otherwise ask to stay.
  if (autosave && !holdSave) return void flushSave()
  if (isDirty()) {
    e.preventDefault()
    e.returnValue = ""
  }
})
// Before the app quits or restarts: the text is on disk, or the writer chose Don't Save.
async function readyToQuit() {
  const ok = await leaveCurrent()
  holdTyping(false) // nothing replaces the text: the window closes, or the writer stays
  return ok
}
// Closing the window sends no "beforeunload", so it asks here instead.
tauri.window.getCurrentWindow().onCloseRequested(async (e: Event) => {
  if (!(await readyToQuit())) e.preventDefault()
})
render()
renderTree()
renderLabels()
renderOutline()
renderTab()
renderAgentStatus()
renderAcSource()
renderCkSource()
renderEdSource()
renderChSource()

// ---------- pictures: drop or paste to add a figure ----------

const PICTURE = /\.(png|jpe?g|gif|svg|webp|pdf)$/i
const MAX_PICTURE = 20_000_000
const pictureReplies = new Map<number, (reply: any) => void>()
let addingPicture = false

// The app copies the picture into figures/ (or finds it in the project) and says how this file writes its path.
const askPicture = (msg: object) =>
  new Promise<any>((done) => {
    const req = ++reqSeq
    pictureReplies.set(req, done)
    tauri.core.invoke("message", { msg: { ...msg, req, path: current, root } }).catch((e: unknown) => {
      pictureReplies.delete(req)
      done({ error: String(e) })
    })
  })

// The text position under a screen point, read from the highlight copy of the text behind the field.
function posAtPoint(x: number, y: number): number {
  ta.style.pointerEvents = "none"
  const range = document.caretRangeFromPoint?.(x, y)
  ta.style.pointerEvents = ""
  const div = range && hl.contains(range.startContainer) ? ([...hl.children].find((d) => d.contains(range.startContainer)) as Element | undefined) : undefined
  if (!range || !div) return ta.selectionEnd
  const before = document.createRange()
  before.setStart(div, 0)
  before.setEnd(range.startContainer, range.startOffset)
  return Math.min(lineStarts[[...hl.children].indexOf(div)] + before.toString().length, ta.value.length)
}

// One figure block per picture, after the line at `at`, as one undoable edit. Typing waits meanwhile,
// so no reply lands in the middle of new typing.
async function addPictures(adds: object[], at: number) {
  if (!current || !syntax() || addingPicture || leaving) {
    toast(!current || !syntax() ? "Open a Typst, LaTeX, Markdown or Quarto file to add a picture." : "Wait a moment, then try again.")
    return
  }
  const path = current
  addingPicture = true
  ta.readOnly = true
  const blocks: string[] = []
  const said: string[] = []
  for (const add of adds) {
    const r = await askPicture(add)
    if (r.cancelled) continue // Cancel: nothing to say, nothing to insert
    if (r.error) toast(r.error)
    else {
      blocks.push(figureSnippet(syntax()!.figure, r.rel, lang))
      said.push(r.copied ? `${r.path}` : `${r.path} (already in the project)`)
    }
  }
  addingPicture = false
  if (!leaving) ta.readOnly = false
  if (!blocks.length) return
  if (current !== path || ta.readOnly) {
    toast(`${said.join(", ")} was added, but the figure was not inserted because you changed file. Use the Figure button to insert it.`)
    return
  }
  const t = ta.value
  const nl = t.indexOf("\n", Math.min(at, t.length))
  const end = nl < 0 ? t.length : nl
  const lineStart = t.lastIndexOf("\n", end - 1) + 1
  const text = (t.slice(lineStart, end).trim() ? "\n\n" : "") + blocks.join("\n\n")
  edit(end, end, text)
  const i = end + text.indexOf("Caption")
  select(i, i + "Caption".length)
  toast(`Added ${said.join(", ")}. Undo removes the figure from the text; the picture stays in the project.`, "info")
}

ta.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/") || f.type === "application/pdf")
  if (!file) return // plain text pastes as always
  e.preventDefault()
  if (file.size > MAX_PICTURE) return void toast("That picture is larger than 20 MB, so it was not added. Shrink it and try again.")
  const reader = new FileReader()
  reader.onload = () => addPictures([{ type: "paste_image", name: file.name, mime: file.type, data: String(reader.result).split(",")[1] ?? "" }], ta.selectionEnd)
  reader.readAsDataURL(file)
})

// Files dragged in from Finder reach the page as Tauri events with paths, not as HTML drop events.
const overEditor = (p: { x: number; y: number }) => {
  const b = ta.getBoundingClientRect()
  const [x, y] = [p.x / devicePixelRatio, p.y / devicePixelRatio]
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom ? [x, y] : null
}
const dropCue = (on: boolean) => $("editor").classList.toggle("dropping", on)
tauri.event.listen("tauri://drag-over", ({ payload }: { payload: any }) => dropCue(!!overEditor(payload.position)))
tauri.event.listen("tauri://drag-leave", () => dropCue(false))
tauri.event.listen("tauri://drag-drop", ({ payload }: { payload: any }) => {
  dropCue(false)
  const at = overEditor(payload.position)
  if (!at) return
  const paths: string[] = payload.paths ?? []
  const pictures = paths.filter((p) => PICTURE.test(p))
  if (pictures.length < paths.length) {
    const n = paths.length - pictures.length
    toast(`${n === 1 ? "That file is" : `${n} files are`} not a picture Quire can add. Use PNG, JPG, GIF, SVG, WebP or PDF.`)
  }
  if (pictures.length) addPictures(pictures.map((from) => ({ type: "import_image", from })), posAtPoint(at[0], at[1]))
})

// ---------- messages from the app ----------

// Listen first, then ask for the state: nothing sent in between is missed.
tauri.event.listen("message", (e: { payload: any }) => onMessage(e.payload)).then(() => send({ type: "hello" }))

function onMessage(msg: any) {
  switch (msg.type) {
    case "hello":
      agents = msg.agents
      agentId = msg.agent
      for (const sel of agentSelects) {
        sel.replaceChildren(...agents.map((a) => new Option(a.name, a.id)))
        sel.value = agentId
      }
      if (acToggle.checked) send({ type: "warm", kind: "complete" })
      warmCheck()
      renderAgentStatus()
      break
    case "folder":
      // Another folder is open: the old text was saved or dropped first, and the agent may
      // still be starting (the request's "done" waits for it).
      if (msg.root !== root) holdTyping(false)
      if (root && msg.root && msg.root !== root) resetForFolder(msg.root)
      if (msg.root && msg.root !== root) renderRecent([msg.root, ...recent().filter((p) => p !== msg.root)].slice(0, 8))
      if (msg.root) opening = ""
      root = msg.root
      checkForStart()
      files = msg.files
      renderPalette()
      dirs = msg.dirs ?? []
      changed = new Set(msg.changed)
      labels = msg.labels ?? []
      cites = msg.cites ?? []
      nowhere = msg.missing ?? []
      renderProblems()
      if (selected && !files.includes(selected) && !dirs.includes(selected)) selected = null
      renderTree()
      renderLabels()
      refreshSearch()
      renderTab()
      renderReviewStatus()
      renderAgentStatus()
      if (root && !current) {
        const first =
          ["main.typ", "main.tex", "index.qmd", "main.md", "README.md"].find((f) => files.includes(f)) ??
          files.find((f) => langOf(f) !== "text")
        if (first) send({ type: "open_file", path: first })
      }
      break
    case "file":
      openFile(msg.path, msg.content, msg.baseline)
      break
    case "update_ready":
      toast(`${APP_NAME} ${msg.version} is installed. It opens the next time you start ${APP_NAME}.`, "info", [
        { label: "Restart now", run: async () => (await readyToQuit()) && send({ type: "restart" }) },
      ])
      break
    case "notice":
      toast(msg.message, msg.kind)
      break
    case "file_changed":
      if (msg.path === current) {
        if (msg.deleted) closeFile(`${msg.path} was deleted.`)
        else onDiskChange(msg.content, msg.baseline)
      }
      if (msg.baseline != null) changed.add(msg.path)
      else changed.delete(msg.path)
      renderTree()
      renderReviewStatus()
      break
    case "preview": {
      if (compileMain !== msg.path) {
        compileDiagnostics = []
        compileLog = ""
        compileTool = ""
        compileMain = msg.path
        renderDiagnostics()
      }
      previewing = msg.path
      previewKind = msg.kind
      $("preview-name").textContent = `Preview ${baseName(msg.path)}`
      renderPreviewAs()
      // The Markdown and PDF viewers stay loaded (and keep their scroll) from file to file.
      showPreview(new URL(msg.url).href)
      if (previewKind === "markdown") sendMarkdown()
      typedSent = "" // a new preview knows only the disk
      sendTyped()
      break
    }
    case "diagnostics":
      receiveDiagnostics(msg)
      break
    case "build": {
      if (msg.main && (msg.root !== root || msg.main !== previewing)) break
      if (Array.isArray(msg.diagnostics)) {
        const tool = msg.ok ? "" : missingTool(msg.log)
        if (!msg.ok && !tool && !msg.diagnostics.length) msg.diagnostics = [{ path: null, line: 0, col: 0, end_line: 0, end_col: 0,
          message: "LaTeX could not compile this document. Show log has the details; Check Setup can check your TeX installation.", hints: [] }]
        if (!receiveDiagnostics(msg, tool ? "" : msg.log ?? "", tool)) break
        // The main page shows the readable error and offers the log on request.
        if (previewKind === "pdf") toPreview({ ...msg, log: "", structured: true })
        else toPreview(msg)
      } else if (["pdf", "docx", "html"].includes(previewKind)) toPreview(msg)
      break
    }
    case "exporting":
      exporting = toast(`Exporting ${msg.name}…`, "info")
      break
    case "exported":
      exported(msg.path)
      break
    case "saved": {
      // Only this save's text is on disk: a later save may still fail. Not ok: the disk had
      // another program's text first, and file_changed already brought it here.
      const s = saving.get(msg.req)
      if (!s) break
      saving.delete(msg.req)
      if (msg.ok && s.path === current) {
        saved = s.text
        saveError?.remove()
        updateDirty()
      }
      s.done("")
      break
    }
    case "image_added":
      pictureReplies.get(msg.req)?.(msg)
      pictureReplies.delete(msg.req)
      break
    case "done":
      if (msg.req === leaving) holdTyping(false)
      if (pendingFix && !ta.readOnly) { // the file a fix waits for is open and typing is free again
        const fix = pendingFix
        pendingFix = null
        if (fix.path === current) fix.run()
      }
      break
    case "label_renamed": {
      if (msg.req === leaving) holdTyping(false)
      const p = pendingRename
      pendingRename = null
      const r = msg.result
      const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
      if (r.ok) opToast = toast(`Renamed ${msg.from} to ${msg.to} in ${n(r.files, "file")} (${n(r.places, "place")}). Review the changes.`, "info", offerUndo("rename", r))
      else if (p) startLabelRename(p.name, p.path, p.to, r.error)
      else toast(r.error)
      break
    }
    case "operation_undone":
      if (msg.req === leaving) holdTyping(false)
      undone(msg.result, lastOp?.kind ?? "change")
      break
    case "replace_result":
      if (msg.req === leaving) holdTyping(false)
      replaced(msg.result)
      break
    case "renamed": {
      lastName = null
      if (msg.req && msg.req === leaving) holdTyping(false)
      invalidateDiagnostics()
      const move = (p: string) => (within(p, msg.from) ? msg.to + p.slice(msg.from.length) : p)
      renameTrail(trail, msg.from, msg.to)
      savePosAll(Object.fromEntries(Object.entries(loadPos()).map(([p, v]) => [move(p), v])))
      if (current && within(current, msg.from)) {
        current = move(current)
        lang = langOf(current) // x.txt renamed to x.md is Markdown now
        resetLayer()
        render()
        renderTab()
        updateInfo()
      }
      if (selected) selected = move(selected)
      for (const c of [...collapsed]) {
        collapsed.delete(c)
        collapsed.add(move(c))
      }
      changed = new Set([...changed].map(move))
      if (previewing && within(previewing, msg.from)) {
        previewing = move(previewing)
        $("preview-name").textContent = `Preview ${baseName(previewing)}`
        requestPreview(previewing)
      }
      sendTyped()
      renderTree()
      renameNotice(msg)
      break
    }
    case "deleted":
      invalidateDiagnostics()
      if (current && within(current, msg.path)) closeFile(`${baseName(msg.path)} was moved to the Trash.`)
      if (previewing && within(previewing, msg.path)) {
        previewing = null
        showPreview("")
      }
      if (selected && within(selected, msg.path)) selected = null
      sendTyped()
      renderTree()
      break
    case "agent":
      agentId = msg.id
      for (const sel of agentSelects) sel.value = msg.id
      agentState = msg.ready ? "ready" : "none"
      agentError = msg.error ?? ""
      agentFix = msg.fix ?? ""
      renderAgentStatus(msg.error && "Agent failed to start")
      checkForStart() // another agent may need another starter
      if (msg.ready && acToggle.checked) send({ type: "warm", kind: "complete" })
      if (msg.ready) {
        warmCheck()
        scheduleCheck(0)
      }
      break
    case "setup": {
      setupRows = msg.rows
      readyAgents = msg.ready ?? []
      $("setup-log").textContent = msg.log ? `The full log is in ${msg.log}.` : ""
      renderSetup()
      const d = $<HTMLDialogElement>("setup")
      if (!msg.quiet && !d.open) d.showModal()
      break
    }
    case "setup_run":
      // A line of what the install says, as it says it. The setup running in the app comes
      // in pieces of its own (a prompt has no line end), so those join as they are.
      if (setupRun != null && setupRun.id === msg.id) {
        const sep = msg.partial ? "" : "\n"
        const text = `${setupRun.text ?? ""}${setupRun.text ? sep : ""}${msg.text}`.split("\n").slice(-400).join("\n")
        setupRun.text = text
        renderSetup()
      }
      break
    case "setup_run_done":
      if (setupRun != null && setupRun.id === msg.id) {
        if (msg.ok) {
          setupRun = null
          toast(
            msg.id === "agent" ? (msg.external ? "A terminal window opened: finish the setup there." : "Setup finished. Checking this computer again…") : "Installed. Checking this computer again…",
            "info",
          )
        } else {
          setupRun.failed = true
          setupRun.done = true
          renderSetup()
        }
      }
      break
    case "options":
      if (msg.kind === "chat") {
        renderOptions($("chat-options"), "chat", msg.options)
        if (agentState === "none" || agentState === "starting") agentState = "ready"
        renderAgentStatus()
      }
      if (msg.kind === "complete") {
        renderOptions($("complete-options"), "complete", msg.options, isModelOrEffort)
        const m = msg.options.find(isModel)
        const opt = m?.options?.flatMap((e: any) => e.options ?? [e]).find((o: any) => o.value === m.currentValue)
        acModel = opt?.name ?? m?.currentValue ?? ""
        renderAcStatus()
      }
      if (msg.kind === "check") renderOptions($("check-options"), "check", msg.options, isModelOrEffort)
      break
    case "status":
      agentState = "starting"
      renderAgentStatus(msg.text)
      break
    case "update":
      onUpdate(msg.update)
      break
    case "permission":
      onPermission(msg)
      break
    case "turn_start":
      onTurnStart(msg.turn, msg.text)
      break
    case "turn_end":
      onTurnEnd(msg.turn, msg.stop, msg.plain)
      break
    case "apple":
      apple = { supported: true, available: msg.available, why: msg.why }
      renderApple()
      break
    case "inline_result":
      applyInline(msg.req, msg.text)
      showRewrite(msg.req, msg.text)
      break
    case "complete_result":
      showCompletion(msg.req, msg.text)
      break
    case "check_result":
      onChecked(msg.req, msg.text)
      break
    case "cite_result":
      applyCite(msg)
      break
    case "history":
      showHistory(msg.req, msg.path, msg.versions ?? [])
      break
    case "search_result":
      showSearch(msg.req, msg.hits ?? [], !!msg.more)
      break
    case "jump":
      followed = `${msg.path}:${msg.line}` // the preview is already there
      goTo(msg.path, msg.line, msg.col)
      break
    case "error":
      if (pictureReplies.has(msg.req)) {
        // A picture import that failed: addPictures releases the editor and says it once.
        pictureReplies.get(msg.req)!({ error: msg.message })
        pictureReplies.delete(msg.req)
        return
      }
      if (msg.req && msg.req === leaving) {
        holdTyping(false) // the open text stays, and the writer can type again
        pendingFix = null // the file a fix waited for did not open: nothing is applied later without a click
      }
      if (msg.op === "replace_in_project") {
        replaced({ ok: false, files: 0, places: 0, error: msg.message, op: 0, paths: [] })
        return
      }
      if (msg.op === "undo_operation") {
        undoing = false
        toast(`Nothing was undone. ${msg.message}`)
        return
      }
      if (msg.op === "export") exporting?.remove()
      if (msg.op === "open_folder" && opening) {
        // A recent project that is gone or cannot be read: do not offer it again.
        const gone = opening
        renderRecent(recent().filter((p) => p !== gone))
        opening = ""
        toast(
          /^Not a folder/.test(msg.message)
            ? `This project folder was moved or deleted: ${gone}. It was removed from Recent projects.`
            : `Could not open the project ${baseName(gone.replace(/\/$/, ""))}: ${msg.message} It was removed from Recent projects.`,
        )
        return
      }
      if ((msg.op === "create" || msg.op === "rename") && lastName) {
        // The app refused a name the page accepted: the box comes back with what was typed.
        naming = lastName.n
        nameDraft = lastName.name
        nameError = msg.message
        lastName = null
        renderTree()
        return
      }
      const tool = msg.op === "preview" || msg.op === "export" ? /\b(tinymist|TeX|LaTeX|Quarto|Pandoc|tectonic|latexmk)\b/.exec(String(msg.message).split("\n")[0]) : null
      if (tool && /needs|not found|not installed|install|could not show a preview/i.test(msg.message)) {
        // One notice per missing tool, however often the writer tries again.
        const old = toolErrors.get(tool[1])
        if (!old?.isConnected)
          toolErrors.set(tool[1], toast(msg.message, "error", [{ label: "Check Setup", run: () => send({ type: "check_setup" }) }]))
        return
      }
      if (msg.op === "save") {
        const s = saving.get(msg.req)
        saving.delete(msg.req)
        // One notice at a time, however often auto save tries again.
        if (s?.path === current && !saveError?.isConnected) {
          saveError = toast(`${baseName(s.path)} was not saved. ${msg.message} Your text is still here.`, "error", [
            { label: "Try again", run: () => flushSave(true) },
          ])
        }
        s?.done(msg.message)
      } else if (msg.op === "warm" && msg.kind === "check") {
        ckError = msg.message
        renderCkStatus()
      } else if (msg.op === "warm") {
        // Autocomplete could not start yet: say so where it lives, without a notice.
        $("sb-ac").title = `Autocomplete is not ready: ${msg.message}`
      } else if (msg.req && rw?.req === msg.req) {
        rwStatus(msg.message, "error")
      } else if (msg.req && ckWant?.req === msg.req) {
        // A wrong key or model fails on every paragraph: said once, in the suggestions settings.
        ckWant = null
        ckError = msg.message
        renderCkStatus()
      } else if (msg.op === "check") {
        // Nobody waits for it any more.
      } else if (msg.req && inlineWant?.req === msg.req) inlineStatus(msg.message, "error")
      else if (msg.req && acWant?.req === msg.req) {
        acWant = null
        acBusy = false
        // A wrong key or model would fail on every pause: say it once, in the autocomplete settings.
        if (acApi()) acError = msg.message
        renderAcStatus()
      } else if (msg.op === "complete") {
        // A suggestion nobody waits for any more: its error is not news.
      } else {
        // A file's error is about that file: not the chat's, and not why the agent did not start.
        const agent = !["open_file", "typed", "review", "create", "rename", "delete", "preview", "restore", "cite", "export", "reveal"].includes(msg.op)
        // The agent's own errors (no op) go to the chat too, as when it stopped and starts again.
        if (agent && (running || !msg.op)) add("chat-error", `${icon("error")}<span>${esc(msg.message)}</span>`)
        const what: Record<string, string> = {
          delete: `Could not move ${baseName(lastTrashed)} to the Trash: `,
          export: `Could not export ${baseName(current ?? "the file")}: `,
          reveal: "Could not show the exported file: ",
          rename: "Nothing was moved. ",
        }
        toast((what[msg.op] ?? "") + msg.message)
        if (agent && agentState === "starting") {
          agentState = "none"
          agentError = msg.message
          renderAgentStatus("Agent failed to start")
        }
      }
      break
  }
}
