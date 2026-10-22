// Fixes for compile errors that are certain enough to offer: pure text in, edit out.

/** What a TeX log says about the error at `line` (1-based): the command it stopped at, or the file it could not find. */
export function texCause(log: string, line: number): { command?: string; file?: string | null } | null {
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
 * Null when the package is already loaded, or the preamble holds neither a \usepackage nor a \documentclass.
 * The new line ends like the line it follows.
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
  const eol = text[after - 1] === '\r' ? '\r\n' : '\n'
  return { at: eol === '\r\n' ? after - 1 : after, insert: `${eol}\\usepackage{${pkg}}` + (after === text.length ? eol : '') }
}

// The package a command comes from, for the commands writers meet most. A command in two packages is left out.
const PACKAGES: Record<string, string[]> = {
  graphicx: ['includegraphics', 'rotatebox', 'scalebox', 'resizebox', 'graphicspath'],
  amsmath: ['dfrac', 'tfrac', 'binom', 'boldsymbol', 'operatorname', 'eqref', 'tag', 'substack', 'xrightarrow', 'xleftarrow', 'intertext', 'DeclareMathOperator', 'text'],
  amssymb: ['mathbb', 'mathfrak', 'therefore', 'because', 'leqslant', 'geqslant', 'varnothing', 'checkmark', 'blacksquare', 'square'],
  amsthm: ['theoremstyle', 'qedhere'],
  hyperref: ['href', 'url', 'hyperref', 'autoref', 'hypersetup'],
  booktabs: ['toprule', 'midrule', 'bottomrule', 'cmidrule', 'addlinespace'],
  siunitx: ['SI', 'si', 'num', 'SIrange', 'qty', 'ang', 'sisetup'],
  xcolor: ['textcolor', 'color', 'colorbox', 'definecolor', 'fcolorbox'],
  cleveref: ['cref', 'Cref'],
  listings: ['lstinline', 'lstset', 'lstinputlisting'],
  tikz: ['tikz', 'draw', 'node', 'usetikzlibrary'],
  caption: ['captionof', 'captionsetup'],
  subcaption: ['subcaption'],
  multirow: ['multirow'],
  enumitem: ['setlist'],
  csquotes: ['enquote'],
  todonotes: ['todo'],
  ulem: ['sout', 'uline'],
  setspace: ['doublespacing', 'onehalfspacing', 'singlespacing', 'setstretch'],
  fancyhdr: ['fancyhead', 'fancyfoot', 'fancyhf'],
  natbib: ['citep', 'citet'],
  biblatex: ['printbibliography', 'addbibresource', 'textcite', 'parencite', 'autocite'],
  pdfpages: ['includepdf'],
  xspace: ['xspace'],
  mathtools: ['coloneqq', 'mathclap'],
  lipsum: ['lipsum'],
}
const PACKAGE_OF = new Map(Object.entries(PACKAGES).flatMap(([pkg, cmds]) => cmds.map((c) => ['\\' + c, pkg] as const)))

// LaTeX commands that need no package, for "Did you mean" on a misspelling.
const STANDARD = ('textbf textit texttt textsc textrm textsf textsl textup emph underline footnote footnotemark footnotetext cite ref pageref label caption ' +
  'section subsection subsubsection paragraph subparagraph chapter part title author date maketitle tableofcontents listoffigures listoftables appendix ' +
  'begin end item centering raggedright raggedleft includeonly include input usepackage documentclass newcommand renewcommand newenvironment newtheorem ' +
  'frac sqrt sum prod int lim infty alpha beta gamma delta epsilon theta lambda mu pi sigma omega mathbf mathrm mathit mathcal mathsf mathtt left right ' +
  'hline cline multicolumn vspace hspace newline newpage clearpage linebreak pagebreak bibliography bibliographystyle thanks abstract quad qquad ' +
  'tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge bfseries itshape ttfamily rmfamily sffamily scshape noindent indent par ' +
  'today LaTeX TeX ldots cdots dots overline hat bar vec tilde dot ddot mbox makebox parbox framebox fbox rule bigskip medskip smallskip').split(' ')

/** What the writer can do about an error, shown on a button. `at` is where the error is. */
export interface Fix {
  label: string
  at: { path: string; line: number }
  kind: 'package' | 'command' | 'path'
  pkg?: string // package: added to the main file
  from?: string // command: the misspelt command; path: the path as the log names it
  to?: string // command: the right one; path: the path to write, absent when the writer picks a picture
}

// suggest: suggestKeys, passed in so this file imports nothing and runs under node as it is
export interface FixEnv { main: string | null; files: string[]; custom: string[]; suggest: (key: string, pool: string[]) => string[] }
interface Cause { path: string | null; line: number; command?: string; file?: string | null }

const dir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const ext = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase()
const stem = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '')
const IMAGE = ['png', 'jpg', 'jpeg', 'pdf', 'svg', 'gif', 'webp']
function join(base: string, rel: string) {
  const out: string[] = base ? base.split('/') : []
  for (const part of rel.split('/')) part === '..' ? out.pop() : part !== '.' && out.push(part)
  return out.join('/')
}
function relative(from: string, to: string) {
  const a = from ? from.split('/') : [], b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

/** The one fix to offer for an error, or null: an error with no certain fix keeps its plain message. */
export function fixFor(d: Cause, env: FixEnv): Fix | null {
  if (!d.path) return null
  const at = { path: d.path, line: d.line }
  if (d.command) {
    const pkg = PACKAGE_OF.get(d.command)
    if (pkg) return env.main ? { label: `Add \\usepackage{${pkg}}`, at, kind: 'package', pkg } : null
    const [near] = env.suggest(d.command.slice(1), [...STANDARD, ...env.custom])
    return near && near.length > 1 ? { label: `Did you mean \\${near}?`, at, kind: 'command', from: d.command, to: '\\' + near } : null
  }
  const file = d.file
  if (!file) return null
  const tex = d.path.endsWith('.tex') || d.path.endsWith('.sty') || d.path.endsWith('.cls')
  const base = tex ? dir(env.main ?? d.path) : dir(d.path) // TeX runs in the main file's folder
  const rooted = !tex && file.startsWith('/')
  const missing = rooted ? file.slice(1) : join(base, file)
  const kind = ext(file) || (tex ? 'tex' : '')
  const wanted = IMAGE.includes(kind) ? IMAGE : [kind]
  const pool = env.files.filter((f) => wanted.includes(ext(f)) && f !== d.path && f !== missing)
  const [near] = env.suggest(stem(file), pool.map(stem)) // suggest skips the same name, so that is tried first
  const same = pool.find((f) => stem(f) === stem(file))
  const target = same ?? (near === undefined ? undefined : pool.find((f) => stem(f) === near))
  if (target) {
    const written = rooted ? '/' + target : relative(base, target)
    return { label: `Use ${target}`, at, kind: 'path', from: file, to: written }
  }
  return IMAGE.includes(kind) ? { label: 'Choose a picture…', at, kind: 'path', from: file } : null
}

/**
 * The text change for `fix` in `text` (the file it applies to: the main file for a package, else the file of the error),
 * or null when the text no longer holds what the error was about: a stale fix edits nothing.
 */
export function planEdit(fix: Fix, text: string): { from: number; to: number; insert: string } | null {
  if (fix.kind === 'package') {
    const p = packageInsert(text, fix.pkg!)
    return p && { from: p.at, to: p.at, insert: p.insert }
  }
  const lines = text.split('\n')
  if (fix.at.line >= lines.length || fix.to === undefined) return null
  const start = lines.slice(0, fix.at.line).reduce((n, l) => n + l.length + 1, 0)
  const line = lines[fix.at.line]
  if (fix.kind === 'command') {
    const m = new RegExp(fix.from!.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '(?![A-Za-z@])').exec(line)
    return m && { from: start + m.index, to: start + m.index + m[0].length, insert: fix.to }
  }
  for (const name of [fix.from!, fix.from!.replace(/\.tex$/, '')]) {
    for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1))
      if (/["{,]/.test(line[i - 1] ?? '') && /["},]/.test(line[i + name.length] ?? '')) return { from: start + i, to: start + i + name.length, insert: name === fix.from ? fix.to : fix.to.replace(/\.tex$/, '') } // \input{ch} stays without .tex
  }
  return null
}
