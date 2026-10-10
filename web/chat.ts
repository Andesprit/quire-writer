// The chat with the agent: messages, tool calls, permission questions and turns, each turn
// with its "Restore files" button.
import { $, ask, esc, fileIcon, icon } from "./ui"

// What the chat needs from the rest of the page. main.ts connects it at start.
type Host = {
  send: (msg: object) => void
  context: () => { path: string | null; selection: string | null } // what the agent sees
  save: () => void // the open file, before the agent reads it
  working: (busy: boolean) => void // the agent status in the status bar
  show: () => void // open the chat panel
}
let host: Host
export function connectChat(h: Host) {
  host = h
}

const messages = $("messages")
const chatInput = $<HTMLTextAreaElement>("chat-input")
const toolEls = new Map<string, HTMLElement>()
let bubble: { el: HTMLElement; text: string } | null = null // agent message being streamed
export let running = false // a chat turn is going on

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

export function add(cls: string, html = "", tag = "div") {
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
  host.working(r)
}

let agentReady = false

// Whether the agent can take a message now (not still starting).
export function setAgentReady(ready: boolean) {
  agentReady = ready
  updateSendState()
}

function updateSendState() {
  $<HTMLButtonElement>("send").disabled = !chatInput.value.trim() || !agentReady
}

export function renderChips() {
  const { path, selection } = host.context()
  const chips: string[] = []
  if (path) chips.push(`<span class="chip" title="The agent sees this file">${fileIcon(path)}${esc(path.split("/").pop()!)}</span>`)
  if (path && selection) {
    const lines = selection.split("\n").length
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
// On some WebView2 builds the caret waits for the first keystroke: place it by hand as
// focus lands, so the box is ready to type into the moment it is clicked. A click then
// moves it where was clicked, as usual.
chatInput.onfocus = () => chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length)
$("composer").onsubmit = (e) => {
  e.preventDefault()
  const text = chatInput.value.trim()
  if (!text || running) return
  host.save()
  const { path, selection } = host.context()
  host.send({ type: "prompt", text, path, selection })
  chatInput.value = ""
  fitChatInput()
}
chatInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $<HTMLFormElement>("composer").requestSubmit()
  }
}
$("stop").onclick = () => host.send({ type: "cancel" })

export function onUpdate(u: any) {
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

export function onPermission(msg: any) {
  host.show()
  const el = add("permission")
  el.innerHTML = `<div class="title">${icon("shield")}<span>Allow the agent to: <strong>${esc(msg.toolCall?.title ?? "use a tool")}</strong>?</span></div><div class="actions"></div>`
  const row = el.querySelector(".actions")!
  msg.options.forEach((o: any, i: number) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = `btn ${o.kind?.startsWith("reject") ? "ghost" : i === 0 ? "primary" : "secondary"}`
    b.textContent = o.name
    b.onclick = () => {
      host.send({ type: "permission", id: msg.id, option: o.optionId })
      row.innerHTML = `<span class="answered">${icon("check")} ${esc(o.name)}</span>`
    }
    row.append(b)
  })
  row.querySelector<HTMLElement>("button")?.focus()
}

export function onTurnStart(turn: number, text: string) {
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
    ).then((a) => a === "save" && host.send({ type: "restore", turn }))
  }
  el.append(document.createElement("br"), restore)
  messages.scrollTop = messages.scrollHeight
}

export function onTurnEnd(turn: number, stop: string) {
  bubble = null
  setRunning(false)
  const r = messages.querySelector<HTMLElement>(`[data-turn="${turn}"] .restore`)
  if (r) r.hidden = false
  if (stop === "cancelled") add("chat-note", "Stopped.")
}

// Another folder was opened. The old folder's Restore buttons would change files in the new one.
export function onFolderOpened(name: string) {
  for (const r of messages.querySelectorAll(".restore")) r.remove()
  add("chat-note", `Opened ${esc(name)}. The agent now works in this folder.`)
}
