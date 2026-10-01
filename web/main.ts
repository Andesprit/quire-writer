import "@vscode/codicons/dist/codicon.css"
import "@fontsource/ia-writer-quattro/400.css"
import "@fontsource/ia-writer-quattro/400-italic.css"
import "@fontsource/ia-writer-quattro/700.css"
import "@fontsource/ia-writer-quattro/700-italic.css"
import { Text } from "@codemirror/state"
import { Chunk } from "@codemirror/merge"
import { highlightHTML, highlightLine, startState, sameState, type State } from "./typst"
import { minimalChange, rebase } from "./merge"

// The product name is not decided yet: change it here only.
const APP_NAME = "Typst Writer"

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const app = $("app")
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} },
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const icon = (name: string, extra = "") => `<i class="codicon codicon-${name} ${extra}"></i>`

// ---------- socket ----------

const ws = new WebSocket(`ws://${location.host}/ws`)
// Every message names the folder this page shows; the helper refuses file changes for any other.
const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...msg, root }))
ws.onclose = () => toast("Lost the connection to the local helper. Start it again, then reload this page.")

// ---------- theme ----------

const systemLight = matchMedia("(prefers-color-scheme: light)")
const applyTheme = () => {
  document.documentElement.dataset.theme = store.get("theme") ?? (systemLight.matches ? "light" : "dark")
}
applyTheme()
systemLight.addEventListener("change", applyTheme)
$("theme").onclick = () => {
  store.set("theme", document.documentElement.dataset.theme === "light" ? "dark" : "light")
  applyTheme()
}

// ---------- layout: panels, sashes, shortcuts ----------

const panels = { sidebar: "no-sidebar", preview: "no-preview", chat: "no-chat" } as const
type Panel = keyof typeof panels
const defaults: Record<Panel, boolean> = { sidebar: true, preview: true, chat: false }

function setPanel(p: Panel, open: boolean) {
  app.classList.toggle(panels[p], !open)
  store.set(`panel.${p}`, open ? "1" : "0")
  $(`toggle-${p}`).setAttribute("aria-pressed", String(open))
  if (p === "sidebar") $("act-explorer").classList.toggle("active", open)
  if (p === "chat") $("act-chat").classList.toggle("active", open)
  scheduleRender() // the text column may have changed width
}
const isOpen = (p: Panel) => !app.classList.contains(panels[p])
const togglePanel = (p: Panel) => setPanel(p, !isOpen(p))

function openChat() {
  setPanel("chat", true)
  $("chat-input").focus()
}
$("toggle-sidebar").onclick = $("act-explorer").onclick = () => togglePanel("sidebar")
$("toggle-preview").onclick = $("open-preview-side").onclick = () => togglePanel("preview")
$("close-preview").onclick = () => setPanel("preview", false)
$("toggle-chat").onclick = $("act-chat").onclick = $("close-chat").onclick = () => togglePanel("chat")
$("sb-agent").onclick = openChat

document.addEventListener(
  "keydown",
  (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    const key = e.key.toLowerCase()
    // Cmd+B and Cmd+I are bold and italic in the text; Chrome keeps Cmd+L for itself.
    if (key === "s" && !e.shiftKey) flushSave()
    else if (key === "e" && e.shiftKey) togglePanel("sidebar")
    else if (key === "\\") togglePanel("preview")
    else if (key === "j" && !e.shiftKey) {
      if (isOpen("chat") && document.activeElement === $("chat-input")) {
        setPanel("chat", false)
        ta.focus()
      } else openChat()
    } else return
    e.preventDefault()
    e.stopPropagation()
  },
  true,
)

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
let baseline: string | null = null // the text before unreviewed changes
let chunks: readonly Chunk[] = []
let mode: "edit" | "review" = "edit"
let focusChunk = 0
let lineStarts: number[] = [0]
let docVersion = 0
let programmatic = false // an edit made by the app, not by typing
let fromDisk = false // an edit that came from the agent or another program
let lastTyped = 0
let saveTimer = 0
let saved = "" // the text as it is on disk
let pendingSave: string | null = null // sent, waiting for the helper to confirm
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
    html.push(`<div class="ln">${highlightLine(next[i], st) || "<br>"}</div>`)
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
  chunks = baseline == null ? [] : Chunk.build(Text.of(baseline.split("\n")), Text.of(next))
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
  if (mode === "review") renderReview()
  updateReviewUI()
  updateInfo()
}

function markActive() {
  const active = lineOf(ta.selectionStart)
  hl.querySelector(".ln.active")?.classList.remove("active")
  hl.children[active]?.classList.add("active")
}

// Replace a range the way typing would, so the browser's undo still works.
function edit(from: number, to: number, text: string, disk = false) {
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
  ghost = null
  scheduleRender()
  if (!fromDisk) scheduleSave()
  if (!programmatic) {
    lastTyped = Date.now()
    if ((e as InputEvent).inputType?.startsWith("insert")) scheduleComplete()
  }
})
ta.addEventListener("scroll", () => {
  hl.scrollTop = ta.scrollTop
})
const onCaret = () => {
  if (ghost && (ta.selectionStart !== ghost.pos || ta.selectionEnd !== ghost.pos)) clearGhost()
  markActive()
  scheduleInfo()
  followCaret()
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === ta) onCaret()
})
ta.addEventListener("select", onCaret)
ta.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  const heading = /^Digit[0-4]$/.test(e.code) ? Number(e.code.slice(5)) : -1
  if (mod && !e.shiftKey && !e.altKey && FORMAT_KEYS[key]) {
    e.preventDefault()
    FORMAT_KEYS[key]()
  } else if (mod && e.altKey && heading >= 0) {
    e.preventDefault()
    setHeading(heading)
  } else if (mod && key === "k") {
    e.preventDefault()
    openInline()
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

function flushSave() {
  clearTimeout(saveTimer)
  holdSave = false
  if (!current) return
  pendingSave = ta.value
  send({ type: "save", path: current, content: ta.value, baseline })
}

const sendReview = () => current && send({ type: "review", path: current, baseline })
const isDirty = () => !!current && ta.value !== saved
let baseTitle = APP_NAME

function updateDirty() {
  const dirty = !autosave && isDirty()
  $("tab").classList.toggle("dirty", dirty)
  document.title = (dirty ? "\u25cf " : "") + baseTitle
}

// Before another file replaces the open one. False means the writer cancelled.
async function leaveCurrent(): Promise<boolean> {
  if (!current || !isDirty()) return true
  if (autosave) {
    flushSave()
    return true
  }
  const answer = await ask(`Save changes to ${baseName(current)}?`, "If you don't save, your changes since the last save are lost.")
  if (answer === "save") flushSave()
  else if (answer === "discard") {
    clearTimeout(saveTimer)
    ta.value = saved
    render()
    updateDirty()
  }
  return answer === "save" || answer === "discard"
}

// With `ok`, a yes/no question whose yes button says `ok` (answer "save").
function ask(title: string, body: string, ok?: string): Promise<string> {
  const d = $<HTMLDialogElement>("ask")
  d.querySelector(".ask-title")!.textContent = title
  d.querySelector(".ask-body")!.textContent = body
  d.querySelector<HTMLElement>('button[value="discard"]')!.hidden = !!ok
  const primary = d.querySelector<HTMLElement>('button[value="save"]')!
  primary.textContent = ok ?? "Save"
  d.returnValue = ""
  d.showModal()
  primary.focus()
  return new Promise((done) => d.addEventListener("close", () => done(d.returnValue), { once: true }))
}

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
    if (base == null) baseline = null
    else if (baseline == null) baseline = base
    edit(change.from, change.to, change.insert, true)
    saved = content
    if (baseline != null && Date.now() - lastTyped > 2000) setMode("review")
    scheduleRender()
    return scheduleSave()
  }
  // Same place: the writer decides. Nothing is saved until then.
  clearTimeout(saveTimer)
  holdSave = true
  const name = baseName(current!)
  toast(`${name} changed on disk where you have unsaved changes.`, "error", [
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
        if (autosave) flushSave()
        updateDirty()
      },
    },
  ])
}

// New content from disk. With a baseline, the difference becomes changes to review.
function applyContent(content: string, base: string | null) {
  if (base == null) baseline = null
  else if (baseline == null) baseline = base
  const c = minimalChange(ta.value, content)
  if (c.from !== c.to || c.insert) edit(c.from, c.to, c.insert, true)
  // Open the review view, unless the writer is typing right now.
  if (baseline != null && Date.now() - lastTyped > 2000) setMode("review")
  scheduleRender()
}

function openFile(path: string, content: string, base: string | null) {
  if (autosave) flushSave()
  current = path
  baseline = base
  ghost = null
  holdSave = false
  ta.value = content // a new file starts a fresh undo history
  resetLayer()
  saved = content
  pendingSave = null
  ta.setSelectionRange(0, 0)
  ta.scrollTop = 0
  setMode(base != null ? "review" : "edit")
  render()
  renderTree()
  renderTab()
  // Take the keyboard only if the writer is not typing somewhere else (a name box, the chat).
  const busy = document.activeElement?.matches("input, textarea, select") && document.activeElement !== ta
  if (mode === "edit" && !busy) ta.focus({ preventScroll: true })
  const main = files.includes("main.typ") ? "main.typ" : path.endsWith(".typ") ? path : null
  if (main && main !== previewing) {
    previewing = main
    $("preview-name").textContent = `Preview ${main.split("/").pop()}`
    send({ type: "preview", path: main })
  }
  if (pendingJump?.path === path) goTo(path, pendingJump.line, pendingJump.col)
}

function closeFile(message?: string) {
  current = null
  baseline = null
  ta.value = ""
  saved = ""
  setMode("edit")
  render()
  renderTab()
  if (message) toast(message, "info")
}

// ---------- track changes: review view ----------

function setMode(m: "edit" | "review") {
  if (m === "review" && baseline == null) m = "edit"
  mode = m
  rv.hidden = m !== "review"
  for (const c of $("format-bar").querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) c.disabled = m === "review"
  if (m === "review") {
    clearGhost()
    renderReview()
  }
  updateReviewUI()
}

function renderReview() {
  const doc = ta.value
  const base = baseline ?? ""
  const scroll = rv.scrollTop
  const plain = (s: string) => highlightHTML(s.replace(/\n$/, ""))
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
      `<div class="chunk-text">${inner.replace(/\n$/, "")}</div></div>`
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
  focusChunk = Math.min(i, chunks.length - 2)
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
  focusChunk = Math.min(i, chunks.length - 2)
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

// ---------- formatting (Typst markup) ----------

const WORD = /[\p{L}\p{N}'’-]/u

// The selection, or the word under the caret when nothing is selected.
function target(): [number, number] {
  let from = ta.selectionStart
  let to = ta.selectionEnd
  if (from === to) {
    const t = ta.value
    while (from > 0 && WORD.test(t[from - 1])) from--
    while (to < t.length && WORD.test(t[to])) to++
  }
  return [from, to]
}

const hasSelection = () => ta.selectionEnd > ta.selectionStart

function select(from: number, to: number) {
  ta.setSelectionRange(from, to)
  ta.focus()
}

// Wrap the target in markup, or unwrap it when it is already wrapped.
function wrap(open: string, close: string, placeholder: string) {
  const t = ta.value
  const [from, to] = target()
  const inner = t.slice(from, to)
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    const bare = inner.slice(open.length, inner.length - close.length)
    edit(from, to, bare)
    return select(from, from + bare.length)
  }
  if (t.slice(from - open.length, from) === open && t.slice(to, to + close.length) === close) {
    edit(from - open.length, to + close.length, inner)
    return select(from - open.length, to - open.length)
  }
  const text = inner || placeholder
  edit(from, to, open + text + close)
  select(from + open.length, from + open.length + text.length)
}

// The whole lines the selection touches.
function lines(): [number, number] {
  const t = ta.value
  const end = ta.selectionEnd > ta.selectionStart && t[ta.selectionEnd - 1] === "\n" ? ta.selectionEnd - 1 : ta.selectionEnd
  const from = t.lastIndexOf("\n", ta.selectionStart - 1) + 1
  const nl = t.indexOf("\n", end)
  return [from, nl < 0 ? t.length : nl]
}

function mapLines(fn: (ls: string[]) => string[]) {
  const [from, to] = lines()
  const out = fn(ta.value.slice(from, to).split("\n")).join("\n")
  edit(from, to, out)
  select(from + out.length, from + out.length)
}

function setHeading(level: number) {
  mapLines((ls) => {
    const same = ls.every((l) => new RegExp(`^={${level}}\\s`).test(l))
    const lvl = same ? 0 : level
    return ls.map((l) => (lvl ? "=".repeat(lvl) + " " : "") + l.replace(/^=+\s*/, ""))
  })
}

function toggleLinePrefix(prefix: string, others: RegExp) {
  mapLines((ls) => {
    const filled = ls.filter((l) => l.trim())
    const on = filled.length > 0 && filled.every((l) => l.trimStart().startsWith(prefix))
    return ls.map((l) => {
      if (!l.trim()) return l
      const indent = l.match(/^\s*/)![0]
      const body = l.slice(indent.length)
      return on ? indent + body.slice(prefix.length) : indent + prefix + body.replace(others, "")
    })
  })
}

// Insert markup after the word at the caret and select the part the writer should replace.
function insertAt(text: string, pick: string, spaced = true) {
  const t = ta.value
  let pos = ta.selectionEnd
  while (pos < t.length && WORD.test(t[pos])) pos++
  const space = spaced && pos > 0 && !/\s/.test(t[pos - 1]) ? " " : ""
  edit(pos, pos, space + text)
  const i = pos + space.length + text.indexOf(pick)
  select(i, i + pick.length)
}

// Insert a block on its own lines, after the current line.
function insertBlock(block: string, pick: string) {
  const t = ta.value
  const nl = t.indexOf("\n", ta.selectionEnd)
  const end = nl < 0 ? t.length : nl
  const lineStart = t.lastIndexOf("\n", end - 1) + 1
  const text = (t.slice(lineStart, end).trim() ? "\n\n" : "") + block
  edit(end, end, text)
  const i = end + text.indexOf(pick)
  select(i, i + pick.length)
}

function link() {
  const [from, to] = target()
  const label = ta.value.slice(from, to) || "link text"
  const text = `#link("https://")[${label}]`
  edit(from, to, text)
  select(from + 7, from + 15)
}

const FIGURE = '#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n) <fig:name>'
const TABLE = "#figure(\n  table(\n    columns: 2,\n    [*Header*], [*Header*],\n    [Cell], [Cell],\n  ),\n  caption: [Caption],\n) <tab:name>"

type Fmt = { icon: string; label: string; keys?: string; run: () => void } | "|"
const FORMATS: Fmt[] = [
  { icon: "bold", label: "Bold", keys: "Cmd+B", run: () => wrap("*", "*", "bold text") },
  { icon: "italic", label: "Italic", keys: "Cmd+I", run: () => wrap("_", "_", "italic text") },
  { icon: "code", label: "Code", run: () => wrap("`", "`", "code") },
  "|",
  { icon: "symbol-operator", label: "Inline math", run: () => wrap("$", "$", "x") },
  { icon: "symbol-numeric", label: "Math block", run: () => insertBlock("$ x $", "x") },
  "|",
  { icon: "list-unordered", label: "Bullet list", run: () => toggleLinePrefix("- ", /^[-+]\s/) },
  { icon: "list-ordered", label: "Numbered list", run: () => toggleLinePrefix("+ ", /^[-+]\s/) },
  { icon: "quote", label: "Quote", run: () => (hasSelection() ? wrap("#quote(block: true)[", "]", "") : insertBlock("#quote(block: true)[\n  Quote\n]", "Quote")) },
  "|",
  { icon: "link", label: "Link", run: link },
  { icon: "mention", label: "Citation or reference (@key)", run: () => insertAt("@key", "key") },
  { icon: "library", label: "Cite by DOI or arXiv ID", run: () => openInline("cite") },
  { icon: "tag", label: "Label (<name>)", run: () => insertAt("<name>", "name") },
  { icon: "note", label: "Footnote", run: () => (hasSelection() ? wrap("#footnote[", "]", "") : insertAt("#footnote[Footnote text]", "Footnote text", false)) },
  "|",
  { icon: "file-media", label: "Figure", run: () => insertBlock(FIGURE, "image.png") },
  { icon: "table", label: "Table", run: () => insertBlock(TABLE, "Header") },
  { icon: "comment", label: "Comment out", keys: "Cmd+/", run: () => toggleLinePrefix("// ", /^$/) },
]
const FORMAT_KEYS: Record<string, () => void> = {
  b: () => wrap("*", "*", "bold text"),
  i: () => wrap("_", "_", "italic text"),
  "/": () => toggleLinePrefix("// ", /^$/),
}

function buildFormatBar() {
  const bar = $("format-bar")
  const heading = document.createElement("select")
  heading.id = "fmt-heading"
  heading.className = "ghost-select"
  heading.title = "Text style (Cmd+Option+0 to 4)"
  heading.append(new Option("Text", "0"), ...[1, 2, 3, 4].map((n) => new Option(`Heading ${n}`, String(n))))
  heading.onchange = () => setHeading(Number(heading.value))
  bar.append(heading, Object.assign(document.createElement("span"), { className: "sep" }))
  for (const f of FORMATS) {
    if (f === "|") {
      bar.append(Object.assign(document.createElement("span"), { className: "sep" }))
      continue
    }
    const b = document.createElement("button")
    b.className = "icon-btn"
    b.title = f.keys ? `${f.label} (${f.keys})` : f.label
    b.setAttribute("aria-label", f.label)
    b.innerHTML = icon(f.icon)
    b.onmousedown = (e) => e.preventDefault() // keep the text selection
    b.onclick = f.run
    bar.append(b)
  }
}

// ---------- explorer, tab, breadcrumbs, window title ----------

let root: string | null = null
let files: string[] = []
let dirs: string[] = []
let changed = new Set<string>()
let previewing: string | null = null
const collapsed = new Set<string>()
let selected: string | null = null // the row the explorer actions apply to
// A name box in the tree: a new file or folder inside `parent`, or a rename of `path`.
let naming: { kind: "file" | "folder"; parent: string } | { kind: "rename"; path: string } | null = null
let rendering = false

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1)
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const within = (p: string, dir: string) => p === dir || p.startsWith(dir + "/")
const isDir = (p: string) => dirs.includes(p)

function fileIcon(path: string) {
  const ext = path.split(".").pop()!.toLowerCase()
  if (ext === "typ") return icon("file-text", "ft-typ")
  if (ext === "bib") return icon("book", "ft-bib")
  if (["yml", "yaml", "toml", "json"].includes(ext)) return icon("json", "ft-data")
  if (ext === "md") return icon("markdown", "ft-other")
  if (ext === "csv") return icon("table", "ft-data")
  if (ext === "tex") return icon("file-code", "ft-other")
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return icon("file-media", "ft-data")
  if (ext === "pdf") return icon("file-pdf", "ft-other")
  return icon("file", "ft-other")
}

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
  $("folder-name").textContent = root ? baseName(root.replace(/\/$/, "")) : "No folder opened"
  $("no-folder").hidden = !!root
  tree.hidden = !root
  // Keep what the writer is typing in a name box when the tree redraws.
  const prev = document.getElementById("tree-input") as HTMLInputElement | null
  const keep = prev && { value: prev.value, start: prev.selectionStart, end: prev.selectionEnd }

  const rows: string[] = []
  const nameBox = (depth: number, iconHtml: string, value: string) =>
    `<div class="row naming" style="--depth:${depth}"><span class="twist"></span>${iconHtml}` +
    `<input class="tree-input" id="tree-input" value="${esc(value)}" spellcheck="false" autocomplete="off" aria-label="Name"></div>`
  const newBox = (parent: string, depth: number) => {
    if (!naming || naming.kind === "rename" || naming.parent !== parent) return
    rows.push(nameBox(depth, naming.kind === "folder" ? icon("folder") : icon("file", "ft-other"), ""))
  }
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = !collapsed.has(n.path)
      const lead = n.dir ? icon(open ? "chevron-down" : "chevron-right") : `<span class="twist"></span>${fileIcon(n.path)}`
      if (naming?.kind === "rename" && naming.path === n.path) rows.push(nameBox(depth, lead.replace('<span class="twist"></span>', ""), n.name))
      else {
        const dirty = n.dir ? [...changed].some((c) => c.startsWith(n.path + "/")) : changed.has(n.path)
        rows.push(
          `<button class="row${n.dir ? " folder" : ""}${n.path === current ? " active" : ""}${n.path === selected ? " selected" : ""}${dirty ? " changed" : ""}" ` +
            `role="treeitem" data-path="${esc(n.path)}"${n.dir ? ` data-dir="1" aria-expanded="${open}"` : ""} style="--depth:${depth}" ` +
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
  setPanel("sidebar", true)
  renderTree()
}

function startRename(path: string) {
  naming = { kind: "rename", path }
  renderTree()
}

function commitName() {
  const input = document.getElementById("tree-input") as HTMLInputElement | null
  const n = naming
  naming = null
  const name = input?.value.trim().replace(/^\/+|\/+$/g, "") ?? ""
  if (n && name) {
    if (n.kind === "rename") {
      const to = joinPath(parentOf(n.path), name)
      if (to !== n.path) send({ type: "rename", from: n.path, to })
      selected = to
    } else {
      const path = joinPath(n.parent, name)
      // A new file opens, replacing the open one: ask first when that one has unsaved changes.
      const go = () => send({ type: "create", path, folder: n.kind === "folder" })
      if (n.kind === "folder") go()
      else leaveCurrent().then((ok) => ok && go())
      selected = path
    }
  }
  renderTree()
}

function trash(path: string) {
  const what = isDir(path) ? `the folder "${baseName(path)}" and everything in it` : `"${baseName(path)}"`
  // Not confirm(): the desktop app's window answers it with "no" without showing it.
  ask(`Move ${what} to the Trash?`, "You can get it back from the Trash.", "Move to Trash").then(
    (a) => a === "save" && send({ type: "delete", path }),
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
    leaveCurrent().then((ok) => {
      if (!ok) return
      send({ type: "open_file", path })
      if (innerWidth < 640) setPanel("sidebar", false)
    })
  }
}
$("tree").addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement
  if (el.id === "tree-input") {
    if (e.key === "Enter") {
      e.preventDefault()
      commitName()
    } else if (e.key === "Escape") {
      e.preventDefault()
      naming = null
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
  if ((e.target as HTMLElement).id === "tree-input" && naming && !rendering) commitName()
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
      { label: "Rename…", keys: "F2", run: () => startRename(path) },
      { label: "Move to Trash", keys: "⌘⌫", run: () => trash(path) },
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

function renderLabels() {
  const open = store.get("labels") !== "closed"
  const unused = labels.filter((l) => !l.refs).length
  $("labels-head").hidden = $("labels").hidden = !root
  $("labels-head").setAttribute("aria-expanded", String(open))
  $("labels-head").querySelector(".codicon")!.className = `codicon codicon-chevron-${open ? "down" : "right"}`
  $("labels-count").textContent = unused ? `${unused} unused` : ""
  $("labels").classList.toggle("closed", !open)
  $("labels").innerHTML = labels.length
    ? labels
        .map(
          (l, i) =>
            `<button class="row label${l.refs ? "" : " unused"}" role="listitem" data-i="${i}" ` +
            `title="${esc(`${l.path}, line ${l.line + 1}${l.refs ? "" : ". Nothing refers to this label."}`)}">` +
            `${icon("tag")}<span class="name">${esc(l.name)}</span>` +
            `<span class="refs">${l.refs ? `${l.refs} use${l.refs > 1 ? "s" : ""}` : "unused"}</span></button>`,
        )
        .join("")
    : `<p class="muted labels-empty">No labels yet. Put &lt;name&gt; after a heading, figure or equation, then refer to it with @name.</p>`
}

$("labels-head").onclick = () => {
  store.set("labels", store.get("labels") === "closed" ? "open" : "closed")
  renderLabels()
}
$("labels").onclick = (e) => {
  const l = labels[Number((e.target as HTMLElement).closest<HTMLElement>(".row[data-i]")?.dataset.i)]
  if (l) goTo(l.path, l.line, l.col)
}

$("open-folder").onclick = $("open-folder-2").onclick = async () => {
  // Unsaved typing belongs to the folder that is open now.
  if (await leaveCurrent()) send({ type: "open_folder" })
}

// Another folder was opened: nothing from the previous one may stay on screen.
function resetForFolder(newRoot: string) {
  clearTimeout(saveTimer)
  current = null
  baseline = null
  ghost = null
  ta.value = ""
  saved = ""
  setMode("edit")
  render()
  renderTab()
  previewing = null
  $("preview").removeAttribute("src")
  selected = null
  naming = null
  collapsed.clear()
  changed.clear()
  add("chat-note", `Opened ${baseName(newRoot.replace(/\/$/, ""))}. The agent now works in this folder.`)
}

function renderTab() {
  const has = !!current
  $("tab").hidden = !has
  $("welcome").hidden = has
  $("breadcrumbs").hidden = !has
  $("format-bar").hidden = !has
  if (current) {
    $("tab-name").textContent = current.split("/").pop()!
    $("tab").title = current
    $("tab-icon").outerHTML = fileIcon(current).replace("<i ", '<i id="tab-icon" ')
  }
  $("tab").classList.toggle("changed", !!current && changed.has(current))
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

const countWords = (s: string) =>
  (s.replace(/\/\/.*$/gm, "").replace(/\$[^$]*\$/g, " ").replace(/#[a-zA-Z_][\w.-]*/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

function currentHeading(): string | null {
  const text = ta.value
  for (let n = lineOf(ta.selectionStart); n >= 0; n--) {
    const m = /^(=+)\s+(.+)/.exec(text.slice(lineStarts[n], (lineStarts[n + 1] ?? text.length + 1) - 1))
    if (m) return m[2]
  }
  return null
}

let wordsTimer = 0
function updateInfo() {
  if (!current) {
    $("sb-pos").textContent = ""
    $("sb-words").textContent = ""
    $("sb-lang").hidden = true
    renderChips()
    return
  }
  $("sb-lang").hidden = false
  const head = ta.selectionStart
  const line = lineOf(head)
  $("sb-pos").textContent = `Ln ${line + 1}, Col ${head - lineStarts[line] + 1}`
  const level = /^(=+)\s/.exec(ta.value.slice(lineStarts[line], lineStarts[line] + 8))?.[1].length ?? 0
  $<HTMLSelectElement>("fmt-heading").value = String(Math.min(level, 4))
  clearTimeout(wordsTimer)
  wordsTimer = window.setTimeout(() => {
    const total = countWords(ta.value)
    const picked = ta.selectionEnd > ta.selectionStart ? countWords(ta.value.slice(ta.selectionStart, ta.selectionEnd)) : 0
    $("sb-words").textContent = `${total.toLocaleString()} words` + (picked ? ` (${picked.toLocaleString()} selected)` : "")
  }, 250)
  const crumbs = [...(root ? [root.split("/").filter(Boolean).pop()!] : []), ...current.split("/")]
  const heading = currentHeading()
  if (heading) crumbs.push(heading)
  $("breadcrumbs").innerHTML = crumbs
    .map((c, i) => (i ? icon("chevron-right") : "") + `<span class="crumb">${esc(c)}</span>`)
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
  if (next) leaveCurrent().then((ok) => ok && send({ type: "open_file", path: next }))
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
    { none: "Open a folder to start the agent", starting: `Starting ${name}…`, ready: name, working: `${name} is working…` }[agentState]
  $("sb-agent").innerHTML = `${icon(busy ? "loading" : "hubot", busy ? "codicon-modifier-spin" : "")} <span>${esc(label)}</span>`
  updateSendState()
}

const isModel = (o: any) => o.category === "model" || o.id === "model"
const isModelOrEffort = (o: any) =>
  isModel(o) || o.category === "thought_level" || ["effort", "reasoning_effort"].includes(o.id)

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

$<HTMLSelectElement>("agent").onchange = (e) => send({ type: "set_agent", id: (e.target as HTMLSelectElement).value })

// ---------- autocomplete (grey text after the caret) ----------

const acToggle = $<HTMLInputElement>("ac-toggle")
acToggle.checked = store.get("autocomplete") !== "off"
let acModel = ""
let acBusy = false
let ghost: { pos: number; text: string } | null = null

function renderAcStatus() {
  const on = acToggle.checked
  $("sb-ac").innerHTML =
    `${icon(acBusy ? "loading" : "sparkle", acBusy ? "codicon-modifier-spin" : "")} ` +
    `<span>${on ? `Autocomplete${acModel ? ` · ${esc(acModel)}` : ""}` : "Autocomplete off"}</span>`
  $("sb-ac").style.opacity = on ? "" : "0.75"
}

// The suggestion is drawn in the colored layer as a copy of the caret's line with the grey
// text inserted. It covers what lies under it until it is accepted or dismissed.
function placeGhost() {
  hl.querySelector(".ghost-line")?.remove()
  if (!ghost || mode !== "edit") return
  const line = lineOf(ghost.pos)
  const div = hl.children[line] as HTMLElement | undefined
  if (!div) return
  const text = ta.value.slice(lineStarts[line], (lineStarts[line + 1] ?? ta.value.length + 1) - 1)
  const col = ghost.pos - lineStarts[line]
  const el = document.createElement("div")
  el.className = "ghost-line"
  el.style.top = `${div.offsetTop}px`
  el.style.left = `${div.offsetLeft}px`
  el.style.width = `${div.clientWidth}px`
  el.innerHTML = highlightHTML(text.slice(0, col)) + `<span class="ghost-text">${esc(ghost.text)}</span>` + highlightHTML(text.slice(col))
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
$("sb-ac").onclick = (e) => {
  e.stopPropagation()
  $("ac-menu").hidden = !$("ac-menu").hidden
}
document.addEventListener("click", (e) => {
  if (!$("ac-menu").hidden && !$("ac-menu").contains(e.target as Node)) $("ac-menu").hidden = true
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("ac-menu").hidden) $("ac-menu").hidden = true
})

let acTimer = 0
let reqSeq = 0 // shared by autocomplete and inline, so errors reach the right place
let acWant: { req: number; pos: number; version: number } | null = null

function scheduleComplete() {
  clearTimeout(acTimer)
  if (!acToggle.checked || agentState === "none" || agentState === "starting") return
  acTimer = window.setTimeout(() => {
    if (ta.selectionStart !== ta.selectionEnd || mode !== "edit") return
    const pos = ta.selectionStart
    const doc = ta.value
    acWant = { req: ++reqSeq, pos, version: docVersion }
    send({ type: "complete", req: acWant.req, before: doc.slice(Math.max(0, pos - 2000), pos), after: doc.slice(pos, pos + 500) })
    acBusy = true
    renderAcStatus()
  }, 600)
}

function showCompletion(req: number, text: string) {
  if (!acWant || req !== acWant.req) return
  acBusy = false
  renderAcStatus()
  const w = acWant
  acWant = null
  if (!text || docVersion !== w.version || ta.selectionStart !== w.pos || ta.selectionEnd !== w.pos) return
  // ponytail: models often drop the leading space; this guess is wrong for mid-word completions.
  if (/[\p{L}\p{N}.,;:!?)]$/u.test(ta.value.slice(w.pos - 1, w.pos)) && /^[\p{L}\p{N}(]/u.test(text)) text = " " + text
  ghost = { pos: w.pos, text }
  placeGhost()
}

// ---------- inline edit (Cmd+K) ----------

const box = $("inline-box")
const inlineInput = $<HTMLTextAreaElement>("inline-input")
let inlineWant: { req: number; from: number; to: number; selected: string } | null = null

// Screen position of a text offset, measured on the colored layer (it mirrors the text field).
function coordsAt(pos: number): DOMRect {
  const line = lineOf(pos)
  const div = hl.children[line] as HTMLElement
  let rest = pos - lineStarts[line]
  const walk = document.createTreeWalker(div, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const len = node.textContent!.length
    if (rest <= len) {
      const r = document.createRange()
      r.setStart(node, rest)
      r.collapse(true)
      const rect = r.getClientRects()[0] ?? r.getBoundingClientRect()
      if (rect.height) return rect
      break
    }
    rest -= len
  }
  return div.getBoundingClientRect()
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
    inlineStatus("The paper goes into your .bib file, and @key into the text.")
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
    send({ type: "cite", req: inlineWant.req, id: inlineInput.value.trim() })
    return inlineStatus("Looking it up…", "busy")
  }
  send({
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
  if (w.selected.trim()) {
    // Keep the spaces and blank lines around the selection; agents trim them.
    text = w.selected.match(/^\s*/)![0] + text.trim() + w.selected.match(/\s*$/)![0]
  }
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
  insertAt(`@${msg.key}`, msg.key)
  select(ta.selectionEnd, ta.selectionEnd)
  const bib = current?.includes("/") ? `/${msg.bib}` : msg.bib // relative to the file; "/" is the project folder
  toast(
    (msg.added ? `Added ${msg.key} to ${msg.bib}.` : `${msg.key} is already in ${msg.bib}.`) +
      (msg.linked ? "" : ` Add #bibliography("${bib}") where the reference list should go.`),
    "info",
  )
}

// ---------- preview sync: a click in the preview shows that text; the preview follows the caret ----------

let pendingJump: { path: string; line: number; col: number } | null = null
let followed = "" // the caret line the preview last scrolled to
let followTimer = 0

// tinymist counts columns in characters; the text field counts UTF-16 units.
function goTo(path: string, line: number, col: number) {
  if (path !== current) {
    pendingJump = { path, line, col }
    leaveCurrent().then((ok) => ok && send({ type: "open_file", path }))
    return
  }
  pendingJump = null
  if (mode === "review") setMode("edit")
  const l = Math.min(line, lineStarts.length - 1)
  const pos = lineStarts[l] + [...ta.value.slice(lineStarts[l], lineStarts[l + 1] ?? ta.value.length)].slice(0, col).join("").length
  ta.focus({ preventScroll: true })
  ta.setSelectionRange(pos, pos)
  const div = hl.children[l] as HTMLElement | undefined
  if (div) ta.scrollTop = Math.max(0, div.offsetTop - ta.clientHeight / 3)
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

// ---------- chat ----------

const messages = $("messages")
const chatInput = $<HTMLTextAreaElement>("chat-input")
const toolEls = new Map<string, HTMLElement>()
let bubble: { el: HTMLElement; text: string } | null = null // agent message being streamed
let running = false

const TOOL_ICONS: Record<string, string> = {
  read: "file", edit: "edit", delete: "trash", move: "arrow-right", search: "search",
  execute: "terminal", think: "lightbulb", fetch: "globe", switch_mode: "arrow-swap",
}

// Small, safe Markdown for agent replies: text is escaped first, then styled.
function md(src: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
  const out: string[] = []
  src.split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2) {
      out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`)
      return
    }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split("\n").filter((l) => l.trim())
      if (!lines.length) continue
      if (lines.every((l) => /^\s*[-*]\s/.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s/, ""))}</li>`).join("")}</ul>`)
      else if (lines.every((l) => /^\s*\d+[.)]\s/.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s/, ""))}</li>`).join("")}</ol>`)
      else out.push(`<p>${lines.map((l) => (/^#{1,6}\s/.test(l) ? `<strong>${inline(l.replace(/^#+\s/, ""))}</strong>` : inline(l))).join("<br>")}</p>`)
    }
  })
  return out.join("")
}

function add(cls: string, html = "", tag = "div") {
  $("chat-empty").hidden = true
  const el = document.createElement(tag)
  el.className = cls
  el.innerHTML = html
  const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40
  messages.append(el)
  if (stick) messages.scrollTop = messages.scrollHeight
  return el
}

function setRunning(r: boolean) {
  running = r
  $("send").hidden = r
  $("stop").hidden = !r
  agentState = r ? "working" : agentState === "working" ? "ready" : agentState
  renderAgentStatus()
}

function updateSendState() {
  $<HTMLButtonElement>("send").disabled = !chatInput.value.trim() || agentState === "none" || agentState === "starting"
}

function renderChips() {
  const chips: string[] = []
  if (current) chips.push(`<span class="chip" title="The agent sees this file">${fileIcon(current)}${esc(current.split("/").pop()!)}</span>`)
  if (current && ta.selectionEnd > ta.selectionStart) {
    const lines = lineOf(ta.selectionEnd) - lineOf(ta.selectionStart) + 1
    chips.push(`<span class="chip" title="The selected text is sent with your message">${icon("selection")}Selection · ${lines} line${lines > 1 ? "s" : ""}</span>`)
  }
  $("chips").innerHTML = chips.join("")
}

function fitChatInput() {
  chatInput.style.height = "auto"
  chatInput.style.height = `${chatInput.scrollHeight}px`
  updateSendState()
}
chatInput.oninput = fitChatInput
$("composer").onsubmit = (e) => {
  e.preventDefault()
  const text = chatInput.value.trim()
  if (!text || running) return
  flushSave()
  const selected = ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null
  send({ type: "prompt", text, path: current, selection: selected })
  chatInput.value = ""
  fitChatInput()
}
chatInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $<HTMLFormElement>("composer").requestSubmit()
  }
}
$("stop").onclick = () => send({ type: "cancel" })

function onUpdate(u: any) {
  const kind = u.sessionUpdate
  if (kind === "agent_message_chunk" && u.content?.type === "text") {
    bubble ??= { el: add("msg agent"), text: "" }
    bubble.text += u.content.text
    const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
    bubble.el.innerHTML = md(bubble.text)
    if (stick) messages.scrollTop = messages.scrollHeight
    return
  }
  bubble = null
  if (kind === "agent_thought_chunk" && u.content?.type === "text") {
    const last = messages.lastElementChild as HTMLElement | null
    const el = last?.matches("details.thought")
      ? last
      : add("thought", `<summary>${icon("lightbulb")} Thinking</summary><div></div>`, "details")
    el.querySelector("div")!.textContent += u.content.text
  } else if (kind === "tool_call") {
    const el = add("tool")
    toolEls.set(u.toolCallId, el)
    renderTool(el, u)
  } else if (kind === "tool_call_update") {
    const el = toolEls.get(u.toolCallId)
    if (el) renderTool(el, { ...JSON.parse(el.dataset.u ?? "{}"), ...u })
  } else if (kind === "plan") {
    const items = u.entries
      .map((e: any) => `<li class="${esc(e.status)}">${icon(e.status === "completed" ? "pass-filled" : e.status === "in_progress" ? "circle-large-filled" : "circle-large-outline")}<span>${esc(e.content)}</span></li>`)
      .join("")
    const last = messages.lastElementChild
    if (last?.classList.contains("plan")) last.innerHTML = items
    else add("plan", items, "ul")
  }
}

function renderTool(el: HTMLElement, u: any) {
  el.dataset.u = JSON.stringify({ title: u.title, kind: u.kind, status: u.status })
  const status = u.status ?? "pending"
  const state =
    status === "completed" ? icon("check", "state completed") : status === "failed" ? icon("error", "state failed") : icon("loading", "state codicon-modifier-spin")
  el.innerHTML = `${icon(TOOL_ICONS[u.kind] ?? "tools")}<span class="name">${esc(u.title ?? "Tool")}</span>${state}`
}

function onPermission(msg: any) {
  if (!isOpen("chat")) setPanel("chat", true)
  const el = add("permission")
  el.innerHTML = `<div class="title">${icon("shield")}<span>Allow the agent to: <strong>${esc(msg.toolCall?.title ?? "use a tool")}</strong>?</span></div><div class="actions"></div>`
  const row = el.querySelector(".actions")!
  msg.options.forEach((o: any, i: number) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = `btn ${o.kind?.startsWith("reject") ? "ghost" : i === 0 ? "primary" : "secondary"}`
    b.textContent = o.name
    b.onclick = () => {
      send({ type: "permission", id: msg.id, option: o.optionId })
      row.innerHTML = `<span class="answered">${icon("check")} ${esc(o.name)}</span>`
    }
    row.append(b)
  })
  row.querySelector<HTMLElement>("button")?.focus()
}

function onTurnStart(turn: number, text: string) {
  bubble = null
  setRunning(true)
  const el = add("msg user")
  el.textContent = text
  el.dataset.turn = String(turn)
  const restore = document.createElement("button")
  restore.className = "restore"
  restore.hidden = true
  restore.title = "Put every file the agent changed back to how it was before this message"
  restore.innerHTML = `${icon("history")} Restore files`
  restore.onclick = () => {
    ask(
      "Restore files to before this message?",
      "Every file the agent changed goes back to how it was. Later edits to those files are lost.",
      "Restore",
    ).then((a) => a === "save" && send({ type: "restore", turn }))
  }
  el.append(document.createElement("br"), restore)
  messages.scrollTop = messages.scrollHeight
}

function onTurnEnd(turn: number, stop: string) {
  bubble = null
  setRunning(false)
  const r = messages.querySelector<HTMLElement>(`[data-turn="${turn}"] .restore`)
  if (r) r.hidden = false
  if (stop === "cancelled") add("chat-note", "Stopped.")
}

// ---------- notifications ----------

function toast(message: string, kind: "error" | "info" = "error", actions: { label: string; run: () => void }[] = []) {
  const el = document.createElement("div")
  el.className = "toast"
  el.innerHTML = `${icon(kind === "error" ? "error" : "info")}<div class="text"><span></span><div class="toast-actions"></div></div><button class="icon-btn small" title="Close">${icon("close")}</button>`
  el.querySelector(".text span")!.textContent = message
  for (const a of actions) {
    const b = document.createElement("button")
    b.className = "btn secondary sm"
    b.textContent = a.label
    b.onclick = () => {
      el.remove()
      a.run()
    }
    el.querySelector(".toast-actions")!.append(b)
  }
  el.querySelector<HTMLElement>(".icon-btn")!.onclick = () => el.remove()
  const list = $("toasts")
  list.append(el)
  while (list.children.length > 3) list.firstElementChild!.remove()
  if (kind === "info") setTimeout(() => el.remove(), 6000)
}

// ---------- start ----------

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
// Developer aid: compare Grammarly in several kinds of field. Shown only with ?dev in the URL.
$("plain").hidden = !new URLSearchParams(location.search).has("dev")
$("plain").onclick = () => {
  store.set("plain-doc", ta.value)
  window.open("/grammarly.html", "_blank")
}
buildFormatBar()
$("app-name").textContent = APP_NAME
$("welcome-mark").textContent = APP_NAME
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
  if (autosave) return flushSave()
  if (isDirty()) {
    e.preventDefault() // the browser asks before leaving with unsaved changes
    e.returnValue = ""
  }
})
// The desktop app closes its window without "beforeunload", so it asks here instead.
;(window as any).__TAURI__?.window.getCurrentWindow().onCloseRequested(async (e: Event) => {
  if (!(await leaveCurrent())) return e.preventDefault()
  for (let i = 0; i < 20 && pendingSave != null; i++) await new Promise((r) => setTimeout(r, 100)) // let the save land
})
render()
renderTree()
renderLabels()
renderTab()
renderAgentStatus()
renderAcStatus()

// ---------- messages from the helper ----------

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  switch (msg.type) {
    case "hello":
      agents = msg.agents
      agentId = msg.agent
      $<HTMLSelectElement>("agent").replaceChildren(...agents.map((a) => new Option(a.name, a.id)))
      $<HTMLSelectElement>("agent").value = agentId
      if (acToggle.checked) send({ type: "warm", kind: "complete" })
      renderAgentStatus()
      break
    case "folder":
      if (root && msg.root && msg.root !== root) resetForFolder(msg.root)
      root = msg.root
      files = msg.files
      dirs = msg.dirs ?? []
      changed = new Set(msg.changed)
      labels = msg.labels ?? []
      if (selected && !files.includes(selected) && !dirs.includes(selected)) selected = null
      if (root && agentState === "none") agentState = "starting"
      renderTree()
      renderLabels()
      renderTab()
      renderReviewStatus()
      renderAgentStatus()
      if (root && !current) {
        const first = files.find((f) => f === "main.typ") ?? files.find((f) => f.endsWith(".typ"))
        if (first) send({ type: "open_file", path: first })
      }
      break
    case "file":
      openFile(msg.path, msg.content, msg.baseline)
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
      // Load the preview from the other name of this computer (localhost vs 127.0.0.1). The
      // browser then treats it as another site and runs it in its own process, so redrawing
      // a long document never freezes typing in the editor.
      const url = new URL(msg.url)
      url.hostname = location.hostname === "localhost" ? "127.0.0.1" : "localhost"
      $<HTMLIFrameElement>("preview").src = url.href
      break
    }
    case "saved":
      if (msg.path === current && pendingSave != null) {
        saved = pendingSave
        pendingSave = null
        updateDirty()
      }
      break
    case "renamed": {
      const move = (p: string) => (within(p, msg.from) ? msg.to + p.slice(msg.from.length) : p)
      if (current && within(current, msg.from)) {
        current = move(current)
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
        send({ type: "preview", path: previewing })
      }
      renderTree()
      break
    }
    case "deleted":
      if (current && within(current, msg.path)) closeFile(`${baseName(msg.path)} was moved to the Trash.`)
      if (previewing && within(previewing, msg.path)) {
        previewing = null
        $("preview").removeAttribute("src")
      }
      if (selected && within(selected, msg.path)) selected = null
      renderTree()
      break
    case "agent":
      agentId = msg.id
      $<HTMLSelectElement>("agent").value = msg.id
      agentState = msg.ready ? "ready" : "none"
      renderAgentStatus()
      if (msg.ready && acToggle.checked) send({ type: "warm", kind: "complete" })
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
      onTurnEnd(msg.turn, msg.stop)
      break
    case "inline_result":
      applyInline(msg.req, msg.text)
      break
    case "complete_result":
      showCompletion(msg.req, msg.text)
      break
    case "cite_result":
      applyCite(msg)
      break
    case "jump":
      followed = `${msg.path}:${msg.line}` // the preview is already there
      goTo(msg.path, msg.line, msg.col)
      break
    case "error":
      if (msg.op === "warm") {
        // Autocomplete could not start yet: say so where it lives, without a notice.
        $("sb-ac").title = `Autocomplete is not ready: ${msg.message}`
      } else if (msg.req && inlineWant?.req === msg.req) inlineStatus(msg.message, "error")
      else if (msg.req && acWant?.req === msg.req) {
        acWant = null
        acBusy = false
        renderAcStatus()
      } else {
        if (running) add("chat-error", `${icon("error")}<span>${esc(msg.message)}</span>`)
        toast(msg.message)
        if (agentState === "starting") {
          agentState = "none"
          renderAgentStatus("Agent failed to start")
        }
      }
      break
  }
}
