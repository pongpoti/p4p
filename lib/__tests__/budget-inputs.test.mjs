import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const bi = require(resolve(repoRoot, "process/budget-inputs"))

test("FORMULA.md: Aug 2569 row is read, a month with no row (2569_10) is empty", () => {
  const file = resolve(repoRoot, "process/FORMULA.md")
  assert.deepEqual(bi.loadBudgetInput("2569_08", file), { budget: 2189874.33, per_p4p: 9562.77 })
  assert.deepEqual(bi.loadBudgetInput("2569_10", file), { budget: null, per_p4p: null })
})

test("blank cells stay empty; blank perP4P falls back to Budget ÷ N", () => {
  const md = [
    "## Monthly Budget Inputs", "",
    "| Month | Budget | N | perP4P |", "|---|---|---|---|",
    "| 2569_10 |  |  |  |",
    "| 2569_11 | 2,000,000 | 210 |  |",
    "| 2569_12 |  | 210 | 9,500.5 |",
    "", "## Next",
    "| 2570_01 | 1 | 1 | 1 |",
  ].join("\n")
  const t = bi.parseBudgetTable(md)
  assert.deepEqual(t.get("2569_10"), { budget: null, per_p4p: null })
  assert.deepEqual(t.get("2569_11"), { budget: 2000000, per_p4p: 9523.81 })
  assert.deepEqual(t.get("2569_12"), { budget: null, per_p4p: 9500.5 })
  assert.equal(t.has("2570_01"), false)
})

test("missing file leaves both empty", () => {
  assert.deepEqual(bi.loadBudgetInput("2569_08", "/nonexistent/FORMULA.md"), { budget: null, per_p4p: null })
})
