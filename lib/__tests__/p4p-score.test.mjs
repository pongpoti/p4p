/**
 * lib/p4p-score.ts rules that decide what a doctor is paid on and whether an
 * upload is refused:
 *   • the score is the total on the LAST total row of the form, never the
 *     largest number across rows or in the sheet, and never recalculated;
 *   • only a labelled grand total or a total typed as text is trusted
 *     without a person (isHighConfidence).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const score = require(resolve(repoRoot, "lib/p4p-score"))

const GRAND = "grand-total label row (all columns)"
const SUB = "sub-total label row (col_1-3)"

test("an earlier, bigger grand-total row does not beat the last one", () => {
  // Last month's total left above this month's real one.
  const rows = [
    { col_1: "งาน", col_2: "แต้ม" },
    { col_1: "รวมทั้งหมด (เดือนก่อน)", col_2: 2500 },
    { col_1: "ตรวจผู้ป่วยนอก", col_2: 120 },
    { col_1: "เวร", col_2: 80 },
    { col_1: "รวมทั้งหมด", col_2: 200 },
  ]
  assert.deepEqual(score.extractScoreFromRows(rows), { score: 200, method: GRAND })
  assert.deepEqual(score.resolveScore(rows), { score: 200, method: GRAND })
  assert.equal(score.isHighConfidence(score.resolveScore(rows).method), true)
})

test("a stray big number never beats two sub-total rows", () => {
  const rows = [
    { col_1: "เลขใบประกอบ", col_2: 34567 },
    { col_1: "งาน", col_2: "แต้ม" },
    { col_1: "ก", col_2: 200 },
    { col_1: "รวม", col_2: 200 },
    { col_1: "ข", col_2: 300 },
    { col_1: "รวม", col_2: 300 },
  ]
  const r = score.resolveScore(rows)
  assert.notEqual(r.score, 34567)
  assert.deepEqual(r, { score: 300, method: SUB })
  // A sub-total is not a stated total: never saved without a person.
  assert.equal(score.isHighConfidence(r.method), false)
})

test("the bottom-most sub-total row, even when an earlier one is bigger", () => {
  const rows = [
    { col_1: "รวมคะแนน", col_2: 900 },
    { col_1: "ก", col_2: 5 },
    { col_1: "รวมคะแนน", col_2: 400 },
  ]
  assert.deepEqual(score.extractScoreFromRows(rows), { score: 400, method: SUB })
})

test("the last total typed as text, not the biggest", () => {
  const rows = [
    { col_1: "งานบริการ", col_2: 120 },
    { col_1: "รวม = 2500" },
    { col_1: "รวม = 200" },
  ]
  assert.deepEqual(score.extractScoreFromRows(rows), { score: 200, method: "free-text summary line" })
})

test("within the last total row the count beside the total is not the total", () => {
  // Real form shape: "รวมทั้งหมด | 74 | 1840" (count, then points).
  const rows = [
    { col_1: "งาน", col_2: "จำนวน" },
    { col_1: "ก", col_2: 37 },
    { col_1: "รวมทั้งหมด", col_2: 74, col_3: 1840 },
  ]
  assert.deepEqual(score.extractScoreFromRows(rows), { score: 1840, method: GRAND })
})

test("a total row added up wrong is still the score: never recalculated", () => {
  const rows = [
    { col_1: "งาน", col_2: "แต้ม" },
    { col_1: "ก", col_2: 100 },
    { col_1: "ข", col_2: 200 },
    { col_1: "รวมทั้งหมด", col_2: 250 },
  ]
  assert.deepEqual(score.resolveScore(rows), { score: 250, method: GRAND })
})

test("a label repeated on an empty row below does not hide the total", () => {
  // A label merged down over two rows comes through on both; only the top
  // one holds the number.
  const rows = [
    { col_1: "ก", col_2: 100 },
    { col_1: "รวมทั้งหมด", col_2: 1840 },
    { col_1: "รวมทั้งหมด" },
  ]
  assert.deepEqual(score.extractScoreFromRows(rows), { score: 1840, method: GRAND })
})

test("a whole-sheet guess only when no labelled row holds a number, and never trusted", () => {
  const guessed = score.resolveScore([
    { col_1: "งาน", col_2: 12 },
    { col_1: "งาน", col_2: 980 },
  ])
  assert.deepEqual(guessed, { score: 980, method: "largest in sheet" })
  assert.equal(score.isHighConfidence(guessed.method), false)
  for (const method of [
    "largest in sheet",
    "largest in sheet (year-like fallback)",
    "largest in sheet (exceeds sub-total label rows)",
    "weight × day-count computation",
    "sum of sub-total rows (grand-total formula uncached)",
    "sum of score-column data rows (sub-totals partially uncached)",
    "reconstructed from daily cells × rate (sub-totals also uncached)",
    SUB,
    "some method this file has never heard of",
  ]) {
    assert.equal(score.isHighConfidence(method), false, method)
  }
})
