// Compile locations use zero-based UTF-16 coordinates, matching a plain textarea.
export interface Diagnostic {
  path: string | null
  line: number
  col: number
  end_line: number
  end_col: number
  message: string
  hints: string[]
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
