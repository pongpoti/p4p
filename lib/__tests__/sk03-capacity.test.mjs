/**
 * Department capacity tiers: process/sk03-formula.ts DEPT_CAPACITY must match
 * the "Departments and Capacity Multipliers" table in process/FORMULA.md,
 * and each tier must follow that table's own % (under 70% 1.15, 70% to
 * under 90% 1.00, 90% and over 0.85).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const f = require(resolve(repoRoot, "process/sk03-formula"))

const md = readFileSync(resolve(repoRoot, "process/FORMULA.md"), "utf8")
const section = md.slice(md.indexOf("## Departments and Capacity Multipliers"))
// | # | Department | Abbrev | FTE | On staff | % | tier | Multiplier | Bonus weight | Before |
const docRows = section
  .split("\n")
  .map((l) => l.split("|").map((c) => c.trim()))
  .filter((c) => /^\d+$/.test(c[1] ?? "") && /^[A-Z]{3}$/.test(c[3] ?? "") && c[3] !== "INT")
  .map((c) => ({ no: Number(c[1]), name: c[2], code: c[3], fte: Number(c[4]), staff: Number(c[5]), cap: Number(c[8]), weight: Number(c[9]) }))

test("FORMULA.md lists the same 18 departments, in the same order", () => {
  assert.equal(docRows.length, 18)
  assert.deepEqual(docRows.map((r) => [r.no, r.name, r.code]), f.DEPT_CAPACITY.map((d) => [d.no, d.name, d.code]))
})

test("each department's tier in code equals FORMULA.md", () => {
  for (const r of docRows) {
    const d = f.DEPT_CAPACITY.find((x) => x.code === r.code)
    assert.equal(d.cap, r.cap, r.code)
    assert.equal(f.BONUS_WEIGHT[d.cap.toFixed(2)], r.weight, r.code)
  }
})

test("each tier follows the 70% / 90% lines on on-staff ÷ FTE", () => {
  for (const r of docRows) {
    const pct = (100 * r.staff) / r.fte
    const want = pct < 70 ? 1.15 : pct < 90 ? 1.0 : 0.85
    assert.equal(r.cap, want, `${r.code} at ${pct.toFixed(1)}%`)
  }
})

test("the งบรายสาขา sheet writes each department's tier label and bonus weight", () => {
  const cells = f.budgetSheet("staff", 8, 200, "label")
  const body = cells.find((c) => c.range === `A${f.BUDGET_FIRST}:N${f.BUDGET_LAST}`)
  const byCode = Object.fromEntries(body.values.map((r) => [r[2], r.slice(3, 5)]))
  assert.deepEqual(byCode.SOC, ["สาขาขาดแคลน", 1.5])
  assert.deepEqual(byCode.MED, ["สาขากึ่งขาดแคลน", 1])
  assert.deepEqual(byCode.PSY, ["สาขาเต็มศักยภาพ", 0.5])
})
