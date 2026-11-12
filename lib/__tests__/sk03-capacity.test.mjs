/**
 * Department capacity tiers by month (process/sk03-formula.ts): months up to
 * 2569_08 keep the first tier table; from 2569_09 the tiers come from the
 * staffing sheet แพทย์ 27-8-69 (process/FORMULA.md).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const f = require(resolve(repoRoot, "process/sk03-formula"))

const tiers = (monthKey) => {
  const out = { 1.15: [], 1.0: [], 0.85: [] }
  for (const d of f.deptCapacity(monthKey)) out[d.cap].push(d.code)
  return out
}

test("months up to 2569_08 keep the first tier table (6 per tier)", () => {
  for (const m of ["2568_05", "2569_07", "2569_08"]) {
    const t = tiers(m)
    assert.deepEqual(t[1.15], ["FOR", "ANS", "RHB", "OBG", "OCM", "MED"])
    assert.deepEqual(t[1.0], ["EYE", "PSY", "RAD", "SUR", "ORT", "ENT"])
    assert.deepEqual(t[0.85], ["PED", "CPT", "OPD", "PAT", "SOC", "EMR"])
  }
})

test("from 2569_09 the 27-8-69 staffing tiers apply (5 / 6 / 7)", () => {
  for (const m of ["2569_09", "2569_12", "2570_01"]) {
    const t = tiers(m)
    assert.deepEqual(t[1.15], ["FOR", "ANS", "RHB", "SOC", "OCM"])
    assert.deepEqual(t[1.0], ["EYE", "SUR", "ORT", "OBG", "ENT", "MED"])
    assert.deepEqual(t[0.85], ["PED", "PSY", "CPT", "OPD", "PAT", "RAD", "EMR"])
  }
})

test("the department list itself is not changed by a lookup", () => {
  f.deptCapacity("2569_09")
  assert.equal(f.DEPT_CAPACITY.find((d) => d.code === "MED").cap, 1.15)
  assert.equal(f.deptCapacity("2569_09").length, f.DEPT_CAPACITY.length)
})

test("the งบรายสาขา sheet writes the month's tier label and bonus weight", () => {
  const row = (monthKey, code) => {
    const cells = f.budgetSheet("staff", 8, 200, "label", monthKey)
    const body = cells.find((c) => c.range === `A${f.BUDGET_FIRST}:N${f.BUDGET_LAST}`)
    return body.values.find((r) => r[2] === code)
  }
  assert.deepEqual(row("2569_08", "MED").slice(3, 5), ["สาขาขาดแคลน", 1.5])
  assert.deepEqual(row("2569_09", "MED").slice(3, 5), ["สาขากึ่งขาดแคลน", 1])
  assert.deepEqual(row("2569_08", "SOC").slice(3, 5), ["สาขาเต็มศักยภาพ", 0.5])
  assert.deepEqual(row("2569_09", "SOC").slice(3, 5), ["สาขาขาดแคลน", 1.5])
  assert.deepEqual(row("2569_09", "PSY").slice(3, 5), ["สาขาเต็มศักยภาพ", 0.5])
})
