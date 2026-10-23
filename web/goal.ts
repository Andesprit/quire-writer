export const MAX_GOAL = 100000

// "500", "1,500" or " 500 words" -> 500; anything else, zero or too large -> null.
export function parseGoal(text: string): number | null {
  const m = /^(\d[\d,]*)(\s*words?)?$/i.exec(text.trim())
  const n = m ? Number(m[1].replace(/,/g, "")) : NaN
  return Number.isInteger(n) && n >= 1 && n <= MAX_GOAL ? n : null
}

// Words added since the goal was set in this file; deleting below the start never goes negative.
export function goalProgress(start: number, now: number, goal: number) {
  const done = Math.max(0, now - start)
  return { done, reached: done >= goal }
}

export type Goal = { goal: number; start: number }
export function readGoal(raw: string | null): Goal | null {
  try {
    const g = JSON.parse(raw ?? "")
    return Number.isInteger(g?.goal) && g.goal >= 1 && Number.isInteger(g?.start) && g.start >= 0 ? { goal: g.goal, start: g.start } : null
  } catch { return null }
}
