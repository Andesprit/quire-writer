// File history: a line diff between two texts, and how a version's time reads.

export type Line = { op: " " | "+" | "-"; text: string }

// Cells of the line-by-line table above which the middle of the diff is shown as replaced
// as a whole (2000 lines against 2000 lines): the dialog stays fast on very long files.
const LIMIT = 4_000_000

// What turns `from` into `to`, line by line. Lines both texts start or end with are trimmed
// first, so a small edit in a long file costs little. `coarse`: the changed middle was too
// big to compare, so it shows as all removed, then all added.
export function diffLines(from: string, to: string): { lines: Line[]; coarse: boolean } {
  const a = from.split("\n"), b = to.split("\n")
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ma = a.slice(head, a.length - tail), mb = b.slice(head, b.length - tail)
  const out: Line[] = a.slice(0, head).map((text) => ({ op: " ", text }))
  const coarse = ma.length * mb.length > LIMIT
  if (coarse) {
    out.push(...ma.map((text): Line => ({ op: "-", text })), ...mb.map((text): Line => ({ op: "+", text })))
  } else {
    // Longest common subsequence of the middle, from the end so the walk below goes forward.
    const w = mb.length + 1
    const t = new Uint32Array((ma.length + 1) * w)
    for (let i = ma.length - 1; i >= 0; i--) {
      for (let j = mb.length - 1; j >= 0; j--) {
        t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
      }
    }
    let i = 0, j = 0
    while (i < ma.length || j < mb.length) {
      if (i < ma.length && j < mb.length && ma[i] === mb[j]) out.push({ op: " ", text: ma[i++] }), j++
      else if (i < ma.length && (j === mb.length || t[(i + 1) * w + j] >= t[i * w + j + 1])) out.push({ op: "-", text: ma[i++] })
      else out.push({ op: "+", text: mb[j++] })
    }
  }
  out.push(...a.slice(a.length - tail).map((text): Line => ({ op: " ", text })))
  return { lines: out, coarse }
}

export function changeCount(lines: Line[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length }
}

const UNITS: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]]

// "Today 14:02 · 2 hours ago". `now` and the clock are the caller's, so a test can fix them.
export function whenText(at: number, now: number): string {
  const d = new Date(at), n = new Date(now)
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000)
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en", { month: "short", day: "numeric" })
  const ago = now - at
  const unit = UNITS.find(([ms]) => ago >= ms)
  const rel = unit ? `${Math.floor(ago / unit[0])} ${unit[1]}${Math.floor(ago / unit[0]) === 1 ? "" : "s"} ago` : "just now"
  return `${day} ${hhmm} · ${rel}`
}
