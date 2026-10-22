// What is wrong with a name typed in the explorer, in words for the writer; "" when it is fine.
// `to` is the full path the name would make; `taken` are the paths already in the project.
// `self` is the path being renamed, so keeping it (or changing only its case) is not a clash.
export function nameProblem(name: string, to: string, taken: string[], self?: string): string {
  if (!name) return "Type a name."
  const parts = name.split("/")
  if (parts.some((p) => p === "." || p === ".." || p === "")) return `"${name}" is not a valid name. Use letters, numbers and dots, with no "." or ".." parts.`
  if (/[\0:]/.test(name)) return `A name cannot contain ":". Choose another name.`
  const low = to.toLowerCase()
  const clash = taken.find((t) => t !== self && t.toLowerCase() === low)
  if (clash) return `A file or folder named "${clash.slice(clash.lastIndexOf("/") + 1)}" already exists here. Choose another name.`
  return ""
}

// What is wrong with a new label name, in words for the writer; "" when it is fine. The rules
// match the app's: Typst and Quarto keys are word characters with : . -, Quarto starts with a
// letter, LaTeX takes anything but spaces and { } % , \. `taken` are the other labels of the language.
export function labelProblem(name: string, from: string, lang: string, taken: string[]): string {
  if (!name) return "Type a name."
  if (name === from) return "That is already its name."
  const ok = lang === "latex" ? /^[^\s{}%,\\]+$/ : lang === "quarto" ? /^[A-Za-z][\w:.-]*$/ : /^[\w:.-]+$/
  if (!ok.test(name)) {
    return lang === "latex" ? `"${name}" is not a valid label name. Do not use spaces or { } % , \\.`
      : `"${name}" is not a valid label name. Use letters, digits, - _ : and . without spaces${lang === "quarto" ? ", starting with a letter" : ""}.`
  }
  return taken.includes(name) ? `A label called "${name}" already exists. Choose another name.` : ""
}

// The label name under the caret, if it is one of `known`: a definition or a use, in a list of
// keys too. Names are letters, digits and - _ : . (a sentence's final dot is not part of one).
export function labelAt(text: string, pos: number, known: string[]): string | null {
  const word = /[\w:.-]/
  let a = pos, b = pos
  while (a > 0 && word.test(text[a - 1])) a--
  while (b < text.length && word.test(text[b])) b++
  for (let end = b; end > a; end--) {
    const name = text.slice(a, end)
    if (known.includes(name)) return name
  }
  return null
}
