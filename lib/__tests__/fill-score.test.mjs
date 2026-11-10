/**
 * The nightly build's Step 4.5 (process/fill-score.ts): a missing roster
 * score is read from the doctor's Drive workbook with the submission
 * pipeline's own extractor (lib/p4p-score.ts), and saved only when the
 * workbook states its total. Skips when process/'s dependencies are not
 * installed.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
let fill = null, ExcelJS = null
try {
  fill = require(resolve(repoRoot, "process/fill-score"))
  ExcelJS = require("exceljs")
} catch {
  fill = null
}
const p4p = require(resolve(repoRoot, "lib/p4p-score"))
const skip = fill ? false : "process/ dependencies not installed"

const GRAND = "grand-total label row (all columns)"

/** A workbook buffer: one entry per sheet, [name, rows]. */
async function book(...sheets) {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name)
    for (const r of rows) ws.addRow(r)
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

test("a grand-total row is saved, read as the pipeline reads it", { skip }, async () => {
  // Cases the old copy in process.ts read differently from the pipeline:
  // a label with a space in it, and an integer total in the year range.
  for (const [label, total] of [["รวม ทั้งหมด", 1800], ["รวมทั้งหมด", 2450], ["รวมแต้มทั้งหมด", 1940.5]]) {
    const buf = await book(["P4P", [["งาน", "แต้ม"], ["ก", 150], ["ข", 20], [label, total]]])
    assert.deepEqual(await fill.statedScoreFromWorkbook(buf), { score: total, method: GRAND, write: true }, label)
    // The same extractor as /upload/score, on the same cells.
    assert.equal(p4p.resolveScore((await p4p.parseWorkbookRows(buf)).rows).score, total, label)
  }
})

test("a formula total is read from its saved value, never recalculated", { skip }, async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("P4P")
  ws.addRow(["งาน", "แต้ม"])
  ws.addRow(["ก", 120])
  ws.addRow(["ข", 80])
  ws.addRow(["รวมทั้งหมด", { formula: "B2+B3", result: 210 }]) // added up wrong on purpose
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  assert.deepEqual(await fill.statedScoreFromWorkbook(buf), { score: 210, method: GRAND, write: true })
})

test("whatever the pipeline's extractor saves, Step 4.5 saves too", { skip }, async () => {
  for (const rows of [
    [["งาน", "แต้ม"], ["ก", 200], ["รวม", 200], ["ข", 300], ["รวม", 300]],
    [["งาน", "แต้ม"], ["ก", 150], ["ข", 980]],
  ]) {
    const buf = await book(["P4P", rows])
    const piped = p4p.resolveScore((await p4p.parseWorkbookRows(buf)).rows)
    const got = await fill.statedScoreFromWorkbook(buf)
    assert.equal(got.score, piped.score)
    assert.equal(got.method, piped.method)
    assert.equal(got.write, true)
  }
})

test("an empty file is left empty; with several data sheets the first is read", { skip }, async () => {
  assert.deepEqual(await fill.statedScoreFromWorkbook(await book(["P4P", [["หัวเรื่อง"]]])),
    { score: null, method: "no sheet with data", write: false })
  const body = [["งาน", "แต้ม"], ["ก", 5], ["รวมทั้งหมด", 700]]
  const other = [["งาน", "แต้ม"], ["ก", 5], ["รวมทั้งหมด", 650]]
  assert.deepEqual(await fill.statedScoreFromWorkbook(await book(["ก.ย.", body], ["ต.ค.", other])),
    { score: 700, method: GRAND, write: true })
  // A blank cover tab is skipped.
  assert.deepEqual(await fill.statedScoreFromWorkbook(await book(["ปก", [["P4P"]]], ["ต.ค.", body])),
    { score: 700, method: GRAND, write: true })
})
