import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { texCause, packageInsert } from './errorfix.ts'

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
assert.equal(packageInsert('\\usepackage{a}\\usepackage{b}\r\n\\begin{document}\r\n', 'c')?.at, 29, 'CRLF: lands after the CR, before the LF')
console.log('errorfix ok')
