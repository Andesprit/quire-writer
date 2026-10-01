// Grammarly test page: the same text in four kinds of field.
import "@vscode/codicons/dist/codicon.css"
import "@fontsource/ia-writer-quattro/400.css"
import "@fontsource/ia-writer-quattro/700.css"
import { highlightHTML } from "./typst"
import sample from "../sample/main.typ?raw"

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }

document.documentElement.dataset.theme = read("theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
// The app's test button hands over the open document; otherwise use the sample.
const text = read("plain-doc") || sample

// 1. Plain text field
$<HTMLTextAreaElement>("v1").value = text

// 2. Text field with a colored copy behind it
const front = $<HTMLTextAreaElement>("v2")
const behind = $("v2-hl")
const paint = () => {
  behind.innerHTML = highlightHTML(front.value) + "\n "
  behind.scrollTop = front.scrollTop
}
front.value = text
paint()
front.addEventListener("input", paint)
front.addEventListener("scroll", () => { behind.scrollTop = front.scrollTop })

// 3. Plain editable box
$("v3").textContent = text

// 4. Editable box with colors, repainted after a pause
const box = $("v4")
box.innerHTML = highlightHTML(text)
let timer = 0
box.addEventListener("input", () => {
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    const at = caretOffset(box)
    box.innerHTML = highlightHTML(box.textContent ?? "")
    if (at != null) placeCaret(box, at)
  }, 1000)
})

function caretOffset(el: HTMLElement): number | null {
  const sel = getSelection()
  if (!sel?.rangeCount || !el.contains(sel.anchorNode)) return null
  const r = document.createRange()
  r.selectNodeContents(el)
  r.setEnd(sel.anchorNode!, sel.anchorOffset)
  return r.toString().length
}

function placeCaret(el: HTMLElement, offset: number) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const len = node.textContent!.length
    if (offset <= len) {
      getSelection()!.collapse(node, offset)
      return
    }
    offset -= len
  }
}

// Best guess at the marks Grammarly leaves on a page. Your own eyes are the real test.
function detect() {
  const b = document.body
  const ext =
    b.hasAttribute("data-gr-ext-installed") ||
    b.hasAttribute("data-new-gr-c-s-check-loaded") ||
    !!document.querySelector("grammarly-extension, grammarly-popups, [data-grammarly-shadow-root]")
  const mac = !!document.querySelector("grammarly-desktop-integration")
  const item = (found: boolean, name: string) =>
    `<span class="${found ? "yes" : "muted"}"><i class="codicon codicon-${found ? "pass-filled" : "circle-large-outline"}"></i>${name}: ${found ? "seen on this page" : "not seen"}</span>`
  $("detect").innerHTML = item(ext, "Grammarly browser extension") + item(mac, "Grammarly for Mac")
}
detect()
setInterval(detect, 2000)
