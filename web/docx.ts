// Word preview: the .docx the app built, drawn as Word lays it out (docx-preview). A new
// version replaces the old one in place, so the writer keeps their place.
import { renderAsync } from "docx-preview"

const pages = document.getElementById("pages")!
const note = document.getElementById("note")!
let latest = 0 // a newer load wins over an older one still running
let pageWidth = 0 // a Word page's own width, before it is scaled to the panel

function say(text: string, busy = false) {
  note.textContent = text
  note.className = busy ? "busy" : ""
}

// Word pages have a fixed width: scale them to the panel, as the PDF preview does.
function fit() {
  const zoom = String(Math.min(document.documentElement.clientWidth - 32, 1000) / pageWidth)
  for (const page of pages.querySelectorAll<HTMLElement>("section.docx")) page.style.zoom = zoom
}

async function load() {
  const id = ++latest
  const res = await fetch(`/docx?v=${Date.now()}`)
  if (!res.ok) return // not built yet: the note says it is converting
  const data = await res.blob()
  const next = document.createElement("div")
  await renderAsync(data, next)
  if (id !== latest) return
  // Word's bullets are characters of its Symbol and Wingdings fonts, which a Mac lacks:
  // draw the bullets they stand for.
  for (const s of next.querySelectorAll("style")) s.textContent = s.textContent!.replaceAll("\uf0b7", "•").replaceAll("\uf0a7", "▪")
  const y = scrollY
  pages.replaceChildren(...next.childNodes)
  pageWidth = pages.querySelector<HTMLElement>("section.docx")?.offsetWidth ?? 0
  if (pageWidth) fit()
  scrollTo(0, y)
}

// The editor passes on what the app reports about each build.
window.addEventListener("message", (e) => {
  if (e.source !== parent) return
  const m = e.data
  // A new build replaces the shown version without a word; only a first one says so.
  if (m?.running) {
    if (!pages.children.length) say("Converting to Word…", true)
  } else if (m?.ok) {
    say("")
    load()
  } else if (m?.log) say(m.log)
})

addEventListener("resize", () => pageWidth && fit())

load().then(() => pages.children.length && say(""))
