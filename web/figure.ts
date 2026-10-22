// Pure helpers for dropping or pasting a picture: the path as the document writes it, and the
// figure snippet that points at it. No DOM, so figure.test.ts can import it.

// `target` as seen from the folder of `base` (both project paths, "/" separated): no leading "./".
export function relativePath(base: string, target: string): string {
  const from = base.split("/").slice(0, -1)
  const to = target.split("/")
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift()
    to.shift()
  }
  return [...from.map(() => ".."), ...to].join("/")
}

// The figure template of the language (format.ts) with the placeholder image and label replaced:
// the label is made from the file name ("figures/Results 2.png" -> fig:results-2; Quarto wants fig-).
export function figureSnippet(template: string, path: string, lang: string): string {
  const stem = (path.split("/").pop() ?? "").replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "image"
  const shown = lang === "markdown" || lang === "quarto" ? path.replace(/ /g, "%20") : path
  return template.replace("image.png", () => shown).replace("fig:name", () => `fig:${stem}`).replace("fig-name", () => `fig-${stem}`)
}
