// Markdown preview: draws the text the editor sends, with math. HTML written in the text is
// shown as text, never run: a document's code must not run inside the app.
import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import "katex/dist/katex.min.css"

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

marked.use(markedKatex({ throwOnError: false, nonStandard: true }), {
  renderer: { html: ({ text }) => escape(text) },
})

const doc = document.getElementById("doc")!
const base = document.querySelector("base")!

window.addEventListener("message", (e) => {
  if (e.source !== parent || typeof e.data?.markdown !== "string") return
  // Images are relative to the file's folder.
  base.href = `/file/${e.data.dir ? `${e.data.dir.split("/").map(encodeURIComponent).join("/")}/` : ""}`
  const text = e.data.markdown.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\n/, "") // front matter
  doc.innerHTML = marked.parse(text) as string
})

// Links stay in the editor's preview: no page may replace this one.
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest("a")) e.preventDefault()
})

parent.postMessage("ready", "*")
