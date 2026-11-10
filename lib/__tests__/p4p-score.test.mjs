/**
 * lib/p4p-score.ts rules that decide whether an upload is refused:
 *   • the LINE upload's filename year check reads only what is plainly a
 *     year (resolveFilenameYear).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const score = require(resolve(repoRoot, "lib/p4p-score"))


test("filename year: 4-digit BE and CE years", () => {
  assert.equal(score.resolveFilenameYear("P4P_2569_10.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P ตุลาคม 2569.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P_9_2026.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("2569-10 P4P.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P_2568.xlsx"), 2568)
})

test("filename year: two digits read only beside a month or in a date", () => {
  assert.equal(score.resolveFilenameYear("P4P ต.ค.69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P ต.ค. 69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P ตุลาคม 69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P_ตุลาคม_69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P ตค69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P เดือนตุลาคม ปี 69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("มัทวัน วรทล มิ.ย. 69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P Oct-69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P 10/69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P 10-69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P 31-10-69.xlsx"), 2569)
  assert.equal(score.resolveFilenameYear("P4P ก.ย.68.xlsx"), 2568)
})

test("filename year: a lone two-digit number is not a year", () => {
  // Each of these was refused as month_mismatch for 2569_10.
  for (const name of [
    "P4P_ตุลาคม_สมชาย_12.xlsx",
    "P4P_ตุลาคม_เวร 30 วัน.xlsx",
    "P4P ตุลาคม (85).xlsx",
    "P4P_10.xlsx",
    "P4P ward 12.xlsx",
    "สมชาย ใจดี v15.xlsx",
    "P4P 05.xlsx",
    "P4P ตุลาคม 1-15.xlsx",
    "P4P ตุลาคม 2.50 แต้ม.xlsx",
    // a day or shift count right after the month name (audit F11 follow-up)
    "P4P ตุลาคม 30 วัน.xlsx",
    "P4P ต.ค. 31วัน.xlsx",
    "P4P Oct 15 shifts.xlsx",
    "P4P มกราคม 15.xlsx",
    "P4P Oct 45 days.xlsx",
    "P4P ตุลาคม 45 เวร.xlsx",
    "P4P Oct 25.xlsx",
    "P4P.xlsx",
    "",
    null,
  ]) {
    assert.equal(score.resolveFilenameYear(name), null, String(name))
  }
  // A month name inside a longer Thai word is not a month either.
  assert.equal(score.resolveFilenameYear("ณัฐกันย์69.xlsx"), null)
})

test("single-sheet upload: a lone number in the filename does not make it another year", async () => {
  const ExcelJS = require("exceljs")
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("data")
  for (const r of [["ประเภทงาน", "แต้ม"], ["บริการ", 5], ["รวมทั้งหมด", 700]]) ws.addRow(r)
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  const at = async (filename) =>
    (await score.parseWorkbookRowsSafely(buffer, { targetMonth: 10, targetYear: 2569, filename })).matched

  assert.equal(await at("P4P_ตุลาคม_สมชาย_12.xlsx"), true)
  assert.equal(await at("P4P ตุลาคม (85).xlsx"), true)
  assert.equal(await at("P4P ตุลาคม 69.xlsx"), true)
  // A year that is plainly written and different still fails the check.
  assert.equal(await at("P4P ตุลาคม 68.xlsx"), false)
  assert.equal(await at("P4P ตุลาคม 2568.xlsx"), false)
})
