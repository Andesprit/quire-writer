import assert from "node:assert/strict"
import { goalProgress, parseGoal, readGoal } from "./goal.ts"

assert.equal(parseGoal("500"), 500)
assert.equal(parseGoal(" 1,500 words "), 1500)
for (const bad of ["", "0", "-5", "12.5", "abc", "100001", "5 apples"]) assert.equal(parseGoal(bad), null, bad)

assert.deepEqual(goalProgress(1000, 1250, 500), { done: 250, reached: false })
assert.deepEqual(goalProgress(1000, 1500, 500), { done: 500, reached: true })
assert.deepEqual(goalProgress(1000, 700, 500), { done: 0, reached: false }) // deleted text never counts below zero

assert.deepEqual(readGoal('{"goal":500,"start":12}'), { goal: 500, start: 12 })
for (const bad of [null, "", "x", "{}", '{"goal":0,"start":1}', '{"goal":5,"start":-1}']) assert.equal(readGoal(bad), null)
console.log("goal ok")
