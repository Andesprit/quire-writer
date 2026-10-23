// Where the writer has been: a back stack and a forward stack of places, like a browser. Pure, so
// the rules (near places merge, a new jump clears Forward, missing files are skipped) are checked
// without the page.
export type Place = { path: string; line: number; col: number }
export type Trail = { back: Place[]; fwd: Place[] }

export const NEAR = 5 // lines: a jump this close in the same file is not worth a stop
export const LIMIT = 50

export const newTrail = (): Trail => ({ back: [], fwd: [] })

const near = (a: Place, b: Place) => a.path === b.path && Math.abs(a.line - b.line) <= NEAR

const keep = (stack: Place[], p: Place) => {
  if (stack.length && near(stack[stack.length - 1], p)) stack[stack.length - 1] = p
  else stack.push(p)
  if (stack.length > LIMIT) stack.shift()
}

// The writer leaves `from` for `to`: remember `from`, forget what Forward held.
export function leave(t: Trail, from: Place, to: Place) {
  if (near(from, to)) return
  keep(t.back, from)
  t.fwd.length = 0
}

function step(from: Place[], to: Place[], here: Place, exists: (path: string) => boolean): Place | undefined {
  let p: Place | undefined
  while ((p = from.pop()) && !exists(p.path)) p = undefined
  if (!p) return
  keep(to, here)
  return p
}

// The place to return to, or undefined when there is nothing (left) to go back to.
export const goBack = (t: Trail, here: Place, exists: (path: string) => boolean) => step(t.back, t.fwd, here, exists)
export const goForward = (t: Trail, here: Place, exists: (path: string) => boolean) => step(t.fwd, t.back, here, exists)

// A file or folder was renamed: places inside it follow.
export function rename(t: Trail, from: string, to: string) {
  for (const p of [...t.back, ...t.fwd]) {
    if (p.path === from) p.path = to
    else if (p.path.startsWith(from + "/")) p.path = to + p.path.slice(from.length)
  }
}
