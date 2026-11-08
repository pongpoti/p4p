/**
 * The nightly build's side of the ตรวจสอบ tab (process/review-build.ts):
 * reading a doctor's own file (saved values only, the sheet merge.py copies)
 * and reading the built SK03's rows back. Skips when process/'s
 * dependencies are not installed.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
let rb = null, ExcelJS = null
try {
  rb = require(resolve(repoRoot, "process/review-build"))
  ExcelJS = require("exceljs")
} catch {
  rb = null
}
const skip = rb ? false : "process/ dependencies not installed"

test("saved values: a formula's cached result, never the formula", { skip }, () => {
  assert.deepEqual(rb.savedValue({ formula: "SUM(B2:B3)", result: 54.5 }), { value: 54.5, uncached: false })
  assert.deepEqual(rb.savedValue({ formula: "SUM(B2:B3)" }), { value: null, uncached: true })
  assert.deepEqual(rb.savedValue({ sharedFormula: "B2", result: 3 }), { value: 3, uncached: false })
  assert.deepEqual(rb.savedValue({ richText: [{ text: "รวม" }, { text: "ทั้งหมด" }] }), { value: "รวมทั้งหมด", uncached: false })
})

test("doctor's file: first sheet with data, stated total and snapshot", { skip }, async () => {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet("ว่าง").getCell("A1").value = "หัวเรื่องเท่านั้น"
  const ws = wb.addWorksheet("P4P")
  ws.addRow(["งาน", "แต้ม", "จำนวน", "รวม"])
  ws.addRow(["ตรวจผู้ป่วยนอก", 2, 10, { formula: "B2*C2", result: 20 }])
  ws.addRow(["เวร", 5, 3, { formula: "B3*C3", result: 15 }])
  ws.addRow(["รวมแต้มทั้งหมด", null, null, { formula: "D2+D3", result: 40 }]) // added up wrong on purpose
  ws.mergeCells("A1:B1")
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const a = await rb.analyseDoctorFile(buf)
  assert.deepEqual(a.stated, { value: 40, cell: "D4", how: "grand-total" })
  assert.equal(a.grid.sheet, "P4P")
  assert.equal(a.grid.rows, 4)
  assert.equal(a.grid.cols, 4)
  assert.ok(a.grid.cells.some(([r, c, v]) => r === 3 && c === 3 && v === 40))
  assert.deepEqual(a.grid.merges, ["A1:B1"])
  assert.match(a.sha256, /^[0-9a-f]{64}$/)
})

test("doctor's file: a total never saved by Excel is reported, not rebuilt", { skip }, async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("P4P")
  ws.addRow(["งาน", "รวม"])
  ws.addRow(["ก", 100])
  ws.addRow(["รวมทั้งหมด", { formula: "B2" }])
  const a = await rb.analyseDoctorFile(Buffer.from(await wb.xlsx.writeBuffer()))
  assert.deepEqual(a.stated, { value: null, cell: null, how: "uncached" })
})

test("SK03 rows read back: staff/intern and department sheets", { skip }, () => {
  const overall = rb.overallRows([
    [1, "นพ.", "สมชาย", "ใจดี", "นายแพทย์", "", "", 2200, 0, 3100, 3100, 900, 0, 11500, 11500],
    [2, "พญ.", "สมหญิง", " รักงาน", "นายแพทย์", "", "", 2200, 0, 2500, 2500, 300, 0, 10900, 10900],
    ["", "", "", "", "", "", "", "", "", "", "", "", 0, 22400, 22400],
  ], 8)
  assert.deepEqual(overall, [
    { row: 8, key: "สมชาย ใจดี", score: 3100, pay: 11500 },
    { row: 9, key: "สมหญิง รักงาน", score: 2500, pay: 10900 },
  ])
  const dept = rb.deptRows([
    ["แบบ สก.03"], ["ประจำเดือน"], ["หน่วยงาน อายุรกรรม"], ["ที่", "ชื่อ"], ["", ""],
    [1, "นพ. สมชาย  ใจดี", "นายแพทย์", "", 0, 11500, 11500],
    [2, "พญ. สมหญิง  รักงาน", "นายแพทย์", "", 1000, 10900, 11900],
    [],
    ["....หัวหน้างาน"],
  ])
  assert.equal(dept.length, 2)
  assert.deepEqual(dept.map((d) => [d.row, d.key, d.admin, d.pay, d.total]), [
    [6, "นพ. สมชาย ใจดี", 0, 11500, 11500],
    [7, "พญ. สมหญิง รักงาน", 1000, 10900, 11900],
  ])
})
