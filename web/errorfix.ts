// Fixes for compile errors that are certain enough to offer: pure text in, edit out.

/** What a TeX log says about the error at `line` (1-based): the command it stopped at, or the file it could not find. */
export function texCause(log: string, line: number): { command?: string; file?: string } | null {
  const lines = log.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const at = /^l\.(\d+) ?(.*)$/.exec(lines[i])
    if (!at || +at[1] !== line) continue
    const head = lines.slice(Math.max(0, i - 4), i).join('\n')
    if (/Undefined control sequence/.test(head)) {
      const cmd = /(\\[A-Za-z@]+)\s*$/.exec(at[2])
      return cmd ? { command: cmd[1] } : null
    }
    const missing = /File [`'](.+?)' not found/.exec(head)
    if (missing) return { file: missing[1] }
  }
  return null
}

const loaded = (text: string, pkg: string) =>
  [...text.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)].some((m) => m[1].split(',').some((p) => p.trim() === pkg))

/**
 * Where `\usepackage{pkg}` goes: on a new line after the last \usepackage in the preamble, else after \documentclass.
 * Null when the package is already loaded or the file has no \documentclass (not the main file).
 */
export function packageInsert(text: string, pkg: string): { at: number; insert: string } | null {
  if (loaded(text, pkg)) return null
  const body = text.search(/^[^%\n]*\\begin\{document\}/m)
  const preamble = body < 0 ? text : text.slice(0, body)
  const lineEnd = (from: number) => { const n = text.indexOf('\n', from); return n < 0 ? text.length : n }
  let after = -1
  for (const re of [/\\(?:usepackage|RequirePackage)\b/g, /\\documentclass\b/g]) {
    for (const m of preamble.matchAll(re)) {
      const start = text.lastIndexOf('\n', m.index) + 1
      if (!text.slice(start, m.index).includes('%')) after = lineEnd(m.index)
    }
    if (after >= 0) break
  }
  if (after < 0) return null
  return { at: after, insert: `\n\\usepackage{${pkg}}` + (after === text.length ? '\n' : '') }
}
