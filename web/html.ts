// Web page preview: the .html the app built, shown as a browser shows it. A new version
// replaces the old one at the same scroll position, so the writer keeps their place.
const page = document.getElementById("page") as HTMLIFrameElement
const note = document.getElementById("note")!
let latest = 0 // a newer load wins over an older one still running

function say(text: string, busy = false) {
  note.textContent = text
  note.className = busy ? "busy" : ""
}

async function load() {
  const id = ++latest
  const res = await fetch(`/html?v=${Date.now()}`)
  if (!res.ok || id !== latest) return // not built yet: the note says it is converting
  const html = await res.text()
  if (id !== latest) return
  const y = page.contentWindow?.scrollY ?? 0
  page.onload = () => page.contentWindow?.scrollTo(0, y)
  page.srcdoc = html
  say("")
}

// The editor passes on what the app reports about each build.
window.addEventListener("message", (e) => {
  if (e.source !== parent) return
  const m = e.data
  // A new build replaces the shown version without a word; only a first one says so.
  if (m?.running) {
    if (!page.srcdoc) say("Converting to a web page…", true)
  } else if (m?.ok) load()
  else if (m?.log) say(m.log)
})

load()
