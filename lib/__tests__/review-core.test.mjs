/**
 * The ตรวจสอบ tab's shared rules (lib/review-core.ts): which cell is a
 * doctor's stated total, the two automatic checks, the W9 rate and which
 * build an uploaded file is. The nightly build and the Vercel app both use
 * these, so a change here changes what the auditor is shown.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const core = require(resolve(repoRoot, "lib/review-core"))

test("cell names", () => {
  assert.equal(core.cellName(0, 0), "A1")
  assert.equal(core.cellName(14, 4), "E15")
  assert.equal(core.colName(25), "Z")
  assert.equal(core.colName(26), "AA")
  assert.equal(core.colName(36), "AK")
})

test("stated total: the grand-total row's saved value, with its cell", () => {
  const grid = [
    ["แบบบันทึก P4P", null, null, null, null],
    ["งาน", "แต้ม", "วัน 1", "วัน 2", "รวม"],
    ["ตรวจผู้ป่วยนอก", 2, 10, 12, 44],
    ["เวรบ่าย", 1.5, 3, 4, 10.5],
    ["รวมแต้มทั้งหมด", null, null, null, 54.5],
  ]
  assert.deepEqual(core.statedTotal(grid), { value: 54.5, cell: "E5", how: "grand-total" })
})

test("stated total: never recalculated, even when the doctor added it up wrong", () => {
  const grid = [
    ["งาน", "รวม"],
    ["ก", 100],
    ["ข", 200],
    ["รวมทั้งหมด", 250],
  ]
  assert.equal(core.statedTotal(grid).value, 250)
})

test("stated total: a total formula with no saved value is reported, not rebuilt", () => {
  const grid = [
    ["งาน", "รวม"],
    ["ก", 100],
    ["รวมทั้งหมด", null],
  ]
  assert.deepEqual(core.statedTotal(grid, new Set(["B3"])), { value: null, cell: null, how: "uncached" })
})

test("stated total: the number may sit inside the label text", () => {
  const grid = [["รวมแต้มทั้งหมด 3,260 แต้ม"]]
  assert.deepEqual(core.statedTotal(grid), { value: 3260, cell: "A1", how: "grand-total" })
})

test("stated total: years and dates are never a total", () => {
  const grid = [["รวมทั้งหมด", 2569, "2026-10-31", 1840]]
  assert.equal(core.statedTotal(grid).value, 1840)
})

test("stated total: sub-total rows when there is no grand-total row", () => {
  const grid = [["งาน", "แต้ม"], ["ก", 20], ["รวม", 30]]
  assert.deepEqual(core.statedTotal(grid), { value: 30, cell: "B3", how: "sub-total" })
  // Same as the pipeline: a bigger number elsewhere wins over a sub-total.
  const grid2 = [["งาน", "แต้ม"], ["ก", 900], ["รวม", 30]]
  assert.deepEqual(core.statedTotal(grid2), { value: 900, cell: "B2", how: "largest-over-sub-total" })
})

test("stated total: nothing labelled means missing, never a guess", () => {
  assert.deepEqual(core.statedTotal([["งาน", 5], ["ข", 7]]), { value: null, cell: null, how: "none" })
})

test("score and money checks", () => {
  assert.equal(core.scoreCheck(2310, 2310.001), "match")
  assert.equal(core.scoreCheck(2310, 2560), "mismatch")
  assert.equal(core.scoreCheck(2310, null), "missing")
  assert.equal(core.moneyCheck(10720, 10720), "match")
  assert.equal(core.moneyCheck(10720, 10270), "mismatch")
  assert.equal(core.moneyCheck(10720, undefined), "missing")
})

test("W9 rate", () => {
  assert.equal(core.w9Rate("=W10*9551.81"), 9551.81)
  assert.equal(core.w9Rate("= W10 * 9906"), 9906)
  assert.equal(core.w9Rate("=W10*0"), 0)
  assert.equal(core.w9Rate("=W10*A1"), null)
  assert.equal(core.w9Rate(229243.44), null)
})

test("upload match", () => {
  const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64), d = "d".repeat(64)
  const builds = [
    { id: "new", built_at: "2026-11-09T01:52:00Z", sk03_sha256: a, merged_sha256: b },
    { id: "old", built_at: "2026-11-08T17:37:00Z", sk03_sha256: c, merged_sha256: d },
  ]
  assert.deepEqual(core.uploadMatch("sk03", a, builds), { result: "latest", build: builds[0] })
  assert.deepEqual(core.uploadMatch("merged", d, builds), { result: "older", build: builds[1] })
  assert.deepEqual(core.uploadMatch("sk03", b, builds), { result: "other_kind", build: builds[0] })
  assert.deepEqual(core.uploadMatch("sk03", "e".repeat(64), builds), { result: "unknown", build: null })
})

test("month and money input", () => {
  assert.deepEqual(core.parseMonth("2569_10"), { be: 2569, month: 10 })
  assert.equal(core.parseMonth("2569_13"), null)
  assert.equal(core.parseMonth("2569-10"), null)
  assert.equal(core.parseMoney("2,158,709.06", 1e11), 2158709.06)
  assert.equal(core.parseMoney("9551.81", 1e7), 9551.81)
  assert.equal(core.parseMoney("9551.815", 1e7), null)
  assert.equal(core.parseMoney("0", 1e7), null)
  assert.equal(core.parseMoney("-5", 1e7), null)
  assert.equal(core.parseMoney("abc", 1e7), null)
})
