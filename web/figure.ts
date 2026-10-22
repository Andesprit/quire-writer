// Pure helper for dropping or pasting a picture: the figure snippet that points at it (the app
// says how the open file writes the path). No DOM, so figure.test.ts can import it.

// The figure template of the language (format.ts) with the placeholder image and label replaced:
// the label is made from the file name ("figures/Results 2.png" -> fig:results-2; Quarto wants fig-).
export function figureSnippet(template: string, path: string, lang: string): string {
  const stem = (path.split("/").pop() ?? "").replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "image"
  const shown = lang === "markdown" || lang === "quarto" ? path.replace(/ /g, "%20") : path
  return template.replace("image.png", () => shown).replace("fig:name", () => `fig:${stem}`).replace("fig-name", () => `fig-${stem}`)
}
