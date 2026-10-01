// LaTeX preview: the PDF the app compiled, drawn with pdf.js. A new version replaces the
// old one in place, so the writer keeps their page.
import * as pdfjs from "pdfjs-dist"
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url"

pdfjs.GlobalWorkerOptions.workerSrc = worker

const pages = document.getElementById("pages")!
const note = document.getElementById("note")!
let latest = 0 // a newer load wins over an older one still running
// The document shown and the observer that draws its pages as they scroll in. Each document
// runs its own pdf.js worker, so an old one is destroyed once a new one replaces it.
let shown: pdfjs.PDFDocumentProxy | null = null
let seen: IntersectionObserver | null = null

function say(text: string, busy = false) {
  note.textContent = text
  note.className = busy ? "busy" : ""
}

async function draw(page: pdfjs.PDFPageProxy, canvas: HTMLCanvasElement, width: number) {
  const scale = width / page.getViewport({ scale: 1 }).width
  const viewport = page.getViewport({ scale: scale * devicePixelRatio })
  canvas.width = viewport.width
  canvas.height = viewport.height
  canvas.style.width = `${width}px`
  await page.render({ canvas, viewport }).promise
}

async function load() {
  const id = ++latest
  let doc: pdfjs.PDFDocumentProxy
  try {
    doc = await pdfjs.getDocument({ url: `/pdf?v=${Date.now()}` }).promise
  } catch {
    return // no PDF yet: the note says it is compiling
  }
  if (id !== latest) return doc.loadingTask.destroy()
  const width = Math.min(pages.clientWidth - 32, 1000)
  // Draw the pages in view first, then swap, so the new version appears without a blank.
  const old = [...pages.children].map((c) => c.getBoundingClientRect())
  const inView = old.flatMap((r, i) => (r.bottom > 0 && r.top < innerHeight ? [i] : []))
  const canvases: HTMLCanvasElement[] = []
  const later: [pdfjs.PDFPageProxy, HTMLCanvasElement][] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const canvas = document.createElement("canvas")
    const vp = page.getViewport({ scale: 1 })
    canvas.style.width = `${width}px`
    canvas.style.aspectRatio = `${vp.width} / ${vp.height}`
    canvases.push(canvas)
    if (inView.includes(n - 1) || (!old.length && n <= 2)) await draw(page, canvas, width)
    else later.push([page, canvas])
  }
  if (id !== latest) return doc.loadingTask.destroy()
  const y = scrollY
  pages.replaceChildren(...canvases)
  scrollTo(0, y)
  seen?.disconnect()
  shown?.loadingTask.destroy()
  shown = doc
  // The rest are drawn as they come into view.
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const item = later.find(([, c]) => c === e.target)
      if (e.isIntersecting && item) {
        observer.unobserve(e.target)
        draw(item[0], item[1], width)
      }
    }
  })
  for (const [, c] of later) observer.observe(c)
  seen = observer
}

// The editor passes on what the app reports about each compile.
window.addEventListener("message", (e) => {
  if (e.source !== parent) return
  const m = e.data
  if (m?.running) say("Compiling…", true)
  else if (m?.ok) {
    say("")
    load()
  } else if (m?.log) say(m.log)
})

let resized = 0
addEventListener("resize", () => {
  clearTimeout(resized)
  resized = window.setTimeout(load, 200)
})

load().then(() => pages.children.length && say(""))
