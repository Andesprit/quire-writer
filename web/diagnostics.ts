// Compile locations use zero-based UTF-16 coordinates, matching a plain textarea.
export interface Diagnostic {
  path: string | null
  line: number
  col: number
  end_line: number
  end_col: number
  message: string
  hints: string[]
  command?: string // LaTeX: the command an "Unknown command" error stopped at
  file?: string | null // a missing file: the path as the compiler names it
}
export interface DiagnosticBatch {
  root: string
  main: string
  generation: number
  diagnostics: Diagnostic[]
  sources?: Record<string, string>
}

export function isCurrentDiagnostic(batch: DiagnosticBatch, root: string | null, main: string | null, generation: number, path: string | null, text: string) {
  return batch.root === root && batch.main === main && batch.generation === generation &&
    (!path || batch.sources?.[path] === undefined || batch.sources[path] === text)
}

export const errorCount = (errors: Diagnostic[]) => new Set(errors.map((d) => `${d.path}:${d.line}`)).size

export function diagnosticRange(text: string, d: Diagnostic): { from: number; to: number } | null {
  const lines = text.split("\n")
  if (d.line < 0 || d.line >= lines.length) return null
  const offset = (line: number, col: number) => lines.slice(0, line).reduce((n, s) => n + s.length + 1, 0) + Math.min(Math.max(0, col), lines[line].length)
  let from = offset(d.line, d.col)
  const endLine = Math.min(Math.max(d.line, d.end_line), lines.length - 1)
  let to = Math.max(from, offset(endLine, d.end_col))
  // Missing delimiters can have a zero-width range at the end of a line.
  if (to === from) {
    if (d.col < lines[d.line].length) to++
    else if (lines[d.line].length) from--
  }
  return { from, to }
}

// A build that failed because a program is missing says so in its first log line. These are the
// words project.rs uses (run_latex, quarto_preview); diagnostics.test.ts checks they still are.
export const missingTool = (log = "") => /^(LaTeX preview needs TeX|Quarto preview needs Quarto)/.test(log) ? log.split("\n")[0] : ""

// Where the errors of `path` sit after the change `c` (as minimalChange gives it) is made to `before`: shifted by the edit,
// or dropped when the edit touched them. Errors in other files stay as they were.
export function shiftDiagnostics(before: string, c: { from: number; to: number; insert: string }, path: string | null, errors: Diagnostic[]): Diagnostic[] {
  const after = before.slice(0, c.from) + c.insert + before.slice(c.to)
  const delta = c.insert.length - (c.to - c.from)
  const starts = (t: string) => { const s = [0]; for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) s.push(i + 1); return s }
  const old = starts(before), now = starts(after)
  const at = (s: number[], t: string, line: number, col: number) => Math.min((s[Math.min(line, s.length - 1)] ?? 0) + col, t.length)
  const place = (o: number) => { let line = now.length - 1; while (now[line] > o) line--; return [line, o - now[line]] }
  return errors.flatMap((d) => {
    if (d.path !== path) return [d]
    const from = at(old, before, d.line, d.col), to = at(old, before, d.end_line, d.end_col)
    if (c.to <= from) { /* before the error: shift */ } else if (c.from >= to) return [d]
    else return []
    const [line, col] = place(from + delta), [end_line, end_col] = place(to + delta)
    return [{ ...d, line, col, end_line, end_col }]
  })
}
