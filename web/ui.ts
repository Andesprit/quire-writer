// Page helpers with no app state: elements, escaping, icons, questions and notices.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
export const icon = (name: string, extra = "") => `<i class="codicon codicon-${name} ${extra}"></i>`

// With `ok`, a yes/no question whose yes button says `ok` (answer "save").
export function ask(title: string, body: string, ok?: string): Promise<string> {
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

export function toast(message: string, kind: "error" | "info" = "error", actions: { label: string; run: () => void }[] = []): HTMLElement {
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
  return el
}

export function fileIcon(path: string) {
  const ext = path.split(".").pop()!.toLowerCase()
  if (ext === "typ") return icon("file-text", "ft-typ")
  if (ext === "bib") return icon("book", "ft-bib")
  if (["yml", "yaml", "toml", "json"].includes(ext)) return icon("json", "ft-data")
  if (ext === "md" || ext === "qmd") return icon("markdown", "ft-other")
  if (ext === "csv") return icon("table", "ft-data")
  if (ext === "tex") return icon("file-code", "ft-other")
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return icon("file-media", "ft-data")
  if (ext === "pdf") return icon("file-pdf", "ft-other")
  return icon("file", "ft-other")
}
