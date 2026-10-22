import type { Diagnostic } from "./diagnostics.ts"

export interface Nowhere { kind: "ref" | "cite"; key: string; path: string; line: number; col: number }
export interface Problem { path: string; line: number; col: number; text: string; utf16: boolean } // utf16: compile errors count UTF-16 units, references count characters

// What the page already knows against the document about to be exported. Compile errors count when
// they belong to this document (it is the one compiled, so errors in files it pulls in break it too);
// references and citations that point nowhere count in the exported file itself.
// Errors still being moved along with typing are `pending`: they are said to be possibly outdated.
export function gatherProblems(path: string, compileMain: string | null, diagnostics: Diagnostic[], pending: boolean, nowhere: Nowhere[]): Problem[] {
  const seen = new Set<string>()
  const errors = compileMain === path
    ? diagnostics.flatMap((d) => {
        if (!d.path || seen.has(d.path + ":" + d.line)) return []
        seen.add(d.path + ":" + d.line)
        return [{ path: d.path, line: d.line, col: d.col, utf16: true, text: d.message + (pending ? " (possibly outdated)" : "") }]
      })
    : []
  const missing = nowhere
    .filter((n) => n.path === path)
    .map((n) => ({ path: n.path, line: n.line, col: n.col, utf16: false, text: `${n.kind === "cite" ? "Citation" : "Reference"} ${n.key} points nowhere` }))
  return [...errors, ...missing]
}

// One plain line per problem, at most `max`; the others are counted.
export function problemLines(path: string, problems: Problem[], max = 5): string[] {
  const lines = problems.slice(0, max).map((p) => `${p.path === path ? "" : p.path + ", "}Line ${p.line + 1}: ${p.text}`)
  if (problems.length > max) lines.push(`and ${problems.length - max} more`)
  return lines
}

// References that point nowhere in other files of the project, when `path` is the compiled main. Only counted, never listed.
export function elsewhere(path: string, compileMain: string | null, nowhere: Nowhere[]): number {
  const ext = (f: string) => f.split(".").pop()
  return compileMain === path ? nowhere.filter((n) => n.path !== path && ext(n.path) === ext(path)).length : 0
}
