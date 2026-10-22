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
