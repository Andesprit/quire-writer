import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { suggestKeys } from './suggestkeys.ts'
import { texCause, packageInsert, fixFor, planEdit } from './errorfix.ts'

const apply = (t: string, p: { at: number; insert: string } | null) => (p ? t.slice(0, p.at) + p.insert + t.slice(p.at) : null)

// real tectonic logs: web/fixtures/*.log, expected cause
const real: [string, object][] = [
  ['a', { command: '\\includegraphics' }], ['b', { command: '\\mathbb' }], ['c', { command: '\\SI' }],
  ['d', { command: '\\textbff' }], ['e', { file: 'missing.tex' }], ['f', { command: '\\foo' }],
]
for (const [n, want] of real) assert.deepEqual(texCause(readFileSync(new URL(`./fixtures/tectonic-${n}.log`, import.meta.url), 'utf8'), 3), want, n)
assert.equal(texCause('! Undefined control sequence.\nl.3 foo\n', 3), null)
assert.equal(texCause('! Undefined control sequence.\nl.3 \\a\n', 4), null)

const doc = '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n% \\usepackage{zzz}\n\\usepackage{a,b}\n\\begin{document}\nx\n\\end{document}\n'
assert.equal(apply(doc, packageInsert(doc, 'graphicx')), doc.replace('{a,b}\n', '{a,b}\n\\usepackage{graphicx}\n'))
assert.equal(packageInsert(doc, 'b'), null)
assert.ok(packageInsert(doc, 'zzz'), 'a commented-out load does not count')
assert.equal(apply('\\documentclass{article}\n\\begin{document}\n\\end{document}', packageInsert('\\documentclass{article}\n\\begin{document}\n\\end{document}', 'x')), '\\documentclass{article}\n\\usepackage{x}\n\\begin{document}\n\\end{document}')
assert.equal(packageInsert('\\chapter{A}\n\\usepackage{q}', 'x')?.insert, '\n\\usepackage{x}\n')
assert.equal(packageInsert('\\chapter{A}', 'x'), null, 'no documentclass, no preamble: not the main file')
assert.equal(packageInsert('\\usepackage{a}\\usepackage{b}\r\n\\begin{document}\r\n', 'c')?.at, 28, 'CRLF: the new line goes before the CR')
assert.equal(packageInsert('\\usepackage{a}\r\n\\begin{document}\r\n', 'c')?.insert, '\r\n\\usepackage{c}')

// fixes
const env = { main: 'main.tex', files: ['main.tex', 'ch/intro.tex', 'figs/pic.png', 'figs/graph.pdf', 'main.typ', 'refs.bib'], custom: ['mymacro'], suggest: suggestKeys }
const fix = (d: object) => fixFor({ path: 'main.tex', line: 0, ...d }, env)
assert.equal(fix({ command: '\\includegraphics' })?.label, 'Add \\usepackage{graphicx}')
assert.equal(fix({ command: '\\textbff' })?.label, 'Did you mean \\textbf?')
assert.equal(fix({ command: '\\mymacroo' })?.to, '\\mymacro')
assert.equal(fix({ command: '\\zzzzqq' }), null)
assert.equal(fixFor({ path: null, line: 0, command: '\\SI' }, env), null)
assert.equal(fixFor({ path: 'main.tex', line: 0, command: '\\SI' }, { ...env, main: null }), null)
const edit = (f: ReturnType<typeof fix>, text: string) => { const e = f && planEdit(f, text); return e && text.slice(0, e.from) + e.insert + text.slice(e.to) }
assert.equal(edit(fix({ command: '\\textbff' }), 'a\nHello \\textbff{x} \\textbfff\n'), null, 'line 0 holds no such command: stale')
assert.equal(edit(fix({ line: 1, command: '\\textbff' }), 'a\nHello \\textbfff \\textbff{x}\n'), 'a\nHello \\textbfff \\textbf{x}\n', 'whole command only')
assert.equal(edit(fix({ line: 1, command: '\\textbff' }), 'a\nnothing\n'), null, 'stale')
assert.equal(edit(fix({ command: '\\SI' }), '\\documentclass{a}\n\\begin{document}\n'), '\\documentclass{a}\n\\usepackage{siunitx}\n\\begin{document}\n')
// missing files: the closest existing one, written relative to where the compiler looks
assert.deepEqual(fix({ file: 'figs/pik.png' }), { label: 'Use figs/pic.png', at: { path: 'main.tex', line: 0 }, kind: 'path', from: 'figs/pik.png', to: 'figs/pic.png' })
assert.equal(edit(fix({ line: 1, file: 'figs/pik.png' }), 'x\n\\includegraphics[width=3cm]{figs/pik.png}\n'), 'x\n\\includegraphics[width=3cm]{figs/pic.png}\n')
assert.equal(fix({ file: 'chapters/intro.tex' })?.to, 'ch/intro.tex', 'the file by that name elsewhere in the project')
assert.equal(fix({ file: 'zzz/qqqqq.tex' }), null, 'nothing alike is not guessed')
assert.equal(edit(fix({ line: 0, file: 'ch/intr.tex' }), '\\input{ch/intr}'), '\\input{ch/intro}', 'a path written without .tex stays without it')
assert.equal(fix({ file: 'nothing.png' })?.label, 'Choose a picture…')
assert.equal(fix({ file: 'nothing.tex' }), null)
// a chapter's error: TeX paths are the main file's, Typst paths the including file's
const ch = { ...env, main: 'main.tex' }
assert.equal(fixFor({ path: 'ch/intro.tex', line: 0, file: 'figs/pik.png' }, ch)?.to, 'figs/pic.png')
const ty = { main: 'main.typ', files: ['main.typ', 'ch/intro.typ', 'ch/img/plot.png'], custom: [], suggest: suggestKeys }
assert.equal(fixFor({ path: 'ch/intro.typ', line: 0, file: 'img/plat.png' }, ty)?.to, 'img/plot.png')
assert.equal(fixFor({ path: 'ch/intro.typ', line: 0, file: '/ch/img/plat.png' }, ty)?.to, '/ch/img/plot.png')
assert.equal(fixFor({ path: 'main.typ', line: 0, file: 'intr.typ' }, ty)?.to, 'ch/intro.typ', 'a missing include goes to the nearest .typ')
assert.equal(edit(fixFor({ path: 'main.typ', line: 0, file: 'intro.typ' }, ty), '#include "intro.typ"'), '#include "ch/intro.typ"')
console.log('errorfix ok')
