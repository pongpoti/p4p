/**
 * lib/alloc-ids.ts: เอกสารจัดสรร (Pong, 2026-11-18). The month's rows are
 * read from the right sheet (not a hidden one of another month), and each
 * roster doctor is found by name: titles and ranks before the first name,
 * spaces anywhere, doctor rows first when a name is there twice, a close
 * spelling only among doctor rows nobody took. Every name here is made up.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const A = require(resolve(repoRoot, "lib/alloc-ids"))
const ExcelJS = require("exceljs")

const DOC = "องค์กรแพทย์ (กลุ่มงานอายุรกรรม)"
// One sheet row: the digits, then "<title><first>  <last>" as the hospital writes it.
const row = (no4, title, first, last, unit = DOC, position = "นายแพทย์") =>
  ({ no4, name: A.normThai(title + first + "  " + last), unit, position })
// One roster person, as the month's table has them.
let n = 0
const person = (prefix, first, last, department = "อายุรกรรม") =>
  ({ index: "00000000-0000-4000-8000-" + String(++n).padStart(12, "0"), prefix, firstname: first, lastname: last, department })

test("small parts: the month in No, titles and ranks, a title taken off a first word", () => {
  assert.equal(A.idMonth("2569_07"), "69-07")
  assert.equal(A.idMonth("2569_7"), null)
  for (const t of ["นาย", "นาง", "นางสาว", "น.ส.", "นพ.", "พญ.", "ร.ต.", "พ.ต.ท.หญิง", "ว่าที่ร้อยตรี", "ร้อยตำรวจเอกหญิง"]) assert.ok(A.isTitle(t), t)
  for (const t of ["จ่าสิบเอก", "พันจ่าอากาศเอก", "นาวาอากาศโทหญิง", "จ่าสิบตำรวจ", "ว่าที่นาย"]) assert.ok(A.isTitle(t), t)
  // Not titles: a first name's start after นาย, or a second grade.
  for (const t of ["สม", "แพทย์", "กอไก่", "นายเอก", "นายพล", "ร้อยตรีเอก", "ร้อย", "ว่าที่"]) assert.ok(!A.isTitle(t), t)
  // A vowel cannot begin a name: นาง + สาวิตรี, not นางสาว + ิตรี.
  assert.equal(A.stripTitle("นางสาวิตรี"), "สาวิตรี")
  assert.equal(A.stripTitle("นางสาวกมลา"), "กมลา")
  assert.equal(A.stripTitle("ว่าที่ร้อยตรีชาญ"), "ชาญ")
  assert.equal(A.editDistance("ปฏิภาณ", "ปฎิภาณ"), 1)
  // The spaces and marks the sheet has: two spaces, a no-break space, ํ + า.
  assert.equal(A.normThai("นายก  ข​"), "นายก ข")
  assert.equal(A.normThai("คํา"), "คำ")
})

async function book(sheets) {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { state: s.hidden ? "hidden" : "visible" })
    ws.getRow(1).getCell(1).value = "รายละเอียดการจัดสรร"
    ;["No", "ชื่อสกุล", "หน่วยงาน P4P", "ตำแหน่ง", "ประเภทการจ้าง"].forEach((h, j) => { ws.getRow(2).getCell(j + 1).value = h })
    s.rows.forEach((r, i) => { r.forEach((v, j) => { ws.getRow(3 + i).getCell(j + 1).value = v }) })
  }
  // Read back as an upload would be.
  const out = new ExcelJS.Workbook()
  await out.xlsx.load(await wb.xlsx.writeBuffer())
  return out
}

test("the sheet: this month's rows only, visible sheets first, wrong month and no table refused", async () => {
  const wb = await book([
    // A hidden sheet of another month, longer: never read.
    { name: "รายละเอียด1", hidden: true, rows: Array.from({ length: 5 }, (_, i) => ["ID-69-05-000" + i, "นายหนึ่ง  สอง", DOC, "นายแพทย์"]) },
    { name: "เดือนกรกฎาคม 2569", rows: [
      ["ID-69-07-0001", "นายสมมติ  ทดลองใจ", DOC, "นายแพทย์"],
      [" ID-69-07-0002 ", "นางสาวกมลา  ปลอมนาม", "กลุ่มงานการพยาบาล", "พยาบาลวิชาชีพ"],
      ["ID-69-06-0003", "นายเก่า  เดือนก่อน", DOC, "นายแพทย์"],
      ["รวม", "", "", ""],
    ] },
  ])
  const r = A.readAllocSheet(wb, "2569_07")
  assert.equal(r.ok, true)
  assert.equal(r.sheet, "เดือนกรกฎาคม 2569")
  assert.deepEqual(r.rows.map((x) => x.no4), ["0001", "0002"])
  assert.deepEqual(r.rows[1], { no4: "0002", name: "นางสาวกมลา ปลอมนาม", unit: "กลุ่มงานการพยาบาล", position: "พยาบาลวิชาชีพ" })
  assert.equal(r.other, 1)
  // Another month's file: says which month it is.
  assert.deepEqual(A.readAllocSheet(wb, "2569_08"), { ok: false, error: "wrong_month", found: "69-05" })
  const none = await book([])
  none.addWorksheet("Sheet1").getCell("A1").value = "อื่น ๆ"
  assert.deepEqual(A.readAllocSheet(none, "2569_07"), { ok: false, error: "no_sheet" })
})

test("matching: titles, ranks and spaces; doctor rows first; two different digits is ambiguous", () => {
  const p = {
    plain: person("นพ.", "สมมติ", "ทดลองใจ"),
    rank: person("นพ.", "ชาญ", "สมมุติชัย"),
    miss: person("พญ.", "สาวิตรี", "ปลอมนาม"),
    nospace: person("พญ.", "กมลา", "นามสมมุติ"),
    twice: person("นพ.", "ซ้ำ", "สองแถวนะ"),
    split: person("พญ.", "สองเลข", "ไม่ตรงกัน"),
    gone: person("นพ.", "ไม่อยู่", "ในไฟล์เลย"),
    blank: person("นพ.", "", "ไม่มีชื่อต้น"),
  }
  const rows = [
    row("0001", "นาย", "สมมติ", "ทดลองใจ"),
    row("0002", "ว่าที่ร้อยตรี", "ชาญ", "สมมุติชัย"),
    row("0003", "นาง", "สาวิตรี", "ปลอมนาม"),
    { no4: "0004", name: "แพทย์หญิงกมลานามสมมุติ", unit: DOC, position: "แพทย์หญิง" },
    // The same name twice: a nurse's row and a doctor's; the doctor's is kept.
    row("0005", "นาย", "ซ้ำ", "สองแถวนะ", "กลุ่มงานการพยาบาล", "พยาบาลวิชาชีพ"),
    row("0006", "นาย", "ซ้ำ", "สองแถวนะ"),
    row("0007", "นาง", "สองเลข", "ไม่ตรงกัน"),
    row("0008", "นาง", "สองเลข", "ไม่ตรงกัน"),
    // Someone else entirely (most of the sheet).
    row("0009", "นาย", "คนอื่น", "นอกรายชื่อ", "กลุ่มงานเภสัชกรรม", "เภสัชกร"),
  ]
  const m = A.matchRoster(rows, Object.values(p))
  const got = Object.fromEntries(m.matched.map((x) => [x.index, x.no4 + " " + x.how]))
  assert.equal(got[p.plain.index], "0001 exact")
  assert.equal(got[p.rank.index], "0002 exact")
  assert.equal(got[p.miss.index], "0003 exact")
  assert.equal(got[p.nospace.index], "0004 exact")
  assert.equal(got[p.twice.index], "0006 exact")
  assert.deepEqual(m.ambiguous, [{ index: p.split.index, name: "พญ.สองเลข ไม่ตรงกัน", department: "อายุรกรรม", nos: ["0007", "0008"] }])
  assert.deepEqual(m.missing.map((x) => x.index).sort(), [p.gone.index, p.blank.index].sort())
  assert.deepEqual(m.close, [])
})

test("second pass: a close spelling among unused doctor rows, else a suggestion, never a guess", () => {
  const close = person("นพ.", "ปฏิภาณ", "ตัวอย่างดี")
  const short = person("นพ.", "ชล", "ทดลอง")
  const firstOnly = person("พญ.", "วรรณา", "สกุลใหม่")
  const tie = person("นพ.", "ประเสริฐ", "ทดสอบ")
  const rows = [
    // ฎ for ฏ: one letter, a doctor's row nobody took.
    row("0101", "นาย", "ปฎิภาณ", "ตัวอย่างดี"),
    // Short name: one letter allowed; this is two away.
    row("0102", "นาย", "ชาล", "ทดลา"),
    // Same first name, other last name (a married name): offered, not taken.
    row("0103", "นาง", "วรรณา", "สกุลเดิม"),
    // Two rows equally close: neither is taken.
    row("0104", "นาย", "ประเสริฐ", "ทดสอข"),
    row("0105", "นาย", "ประเสริฐ", "ทดสอค"),
    // A close spelling, but not a doctor's row: never taken.
    row("0106", "นาย", "ปฏิภาน", "ตัวอย่างดี", "กลุ่มงานพัสดุ", "เจ้าพนักงานพัสดุ"),
  ]
  const m = A.matchRoster(rows, [close, short, firstOnly, tie])
  assert.deepEqual(m.matched, [{ index: close.index, no4: "0101", how: "close" }])
  assert.deepEqual(m.close, [{ index: close.index, name: "นพ.ปฏิภาณ ตัวอย่างดี", sheetName: "นายปฎิภาณ ตัวอย่างดี", no4: "0101" }])
  const miss = Object.fromEntries(m.missing.map((x) => [x.index, x.suggest]))
  assert.equal(miss[short.index], null)
  assert.deepEqual(miss[firstOnly.index], { no4: "0103", sheetName: "นางวรรณา สกุลเดิม" })
  assert.equal(miss[tie.index], null)
})

test("a relative's row is never a doctor's: นายเอกภพ is not นาย + เอก + ภพ", () => {
  const doc = person("นพ.", "ภพ", "ญาติกันดี")
  // The doctor's father (or brother): another person with the same last name.
  const m = A.matchRoster([row("0301", "นาย", "เอกภพ", "ญาติกันดี", "กลุ่มงานการเงิน", "นักวิชาการเงินและบัญชี")], [doc])
  assert.deepEqual(m.matched, [])
  assert.deepEqual(m.missing.map((x) => x.index), [doc.index])
})

test("second pass: who gets a close spelling does not hang on the roster's order", () => {
  // Only ธนพร has a row, spelled ศรีสุก. ธนกร is two letters from it, ธนพร one.
  const a = person("นพ.", "ธนกร", "ศรีสุข")
  const b = person("พญ.", "ธนพร", "ศรีสุข")
  const rows = [row("0401", "นางสาว", "ธนพร", "ศรีสุก")]
  for (const roster of [[a, b], [b, a]]) {
    const m = A.matchRoster(rows, roster)
    assert.deepEqual(m.matched, [{ index: b.index, no4: "0401", how: "close" }])
    assert.deepEqual(m.missing.map((x) => [x.index, x.suggest]), [[a.index, null]])
  }
  // Two people equally near one row: neither gets it.
  const c = person("นพ.", "สมชาย", "ทดลองก")
  const d = person("นพ.", "สมชาย", "ทดลองข")
  const m = A.matchRoster([row("0402", "นาย", "สมชาย", "ทดลองค")], [c, d])
  assert.deepEqual(m.matched, [])
  // A row someone took is not offered to anyone else.
  const e = person("พญ.", "วิภา", "สุขดีมาก")
  const f = person("พญ.", "วิภา", "นามอื่นไกล")
  const m2 = A.matchRoster([row("0403", "นาง", "วิภา", "สุขดีมาย")], [f, e])
  assert.deepEqual(m2.matched, [{ index: e.index, no4: "0403", how: "close" }])
  assert.deepEqual(m2.missing.map((x) => [x.index, x.suggest]), [[f.index, null]])
})

test("rows with an ambiguous person's own name are not given away by close spelling", () => {
  const split = person("พญ.", "สองเลข", "ไม่ตรงกัน")
  const near = person("พญ.", "สองเลก", "ไม่ตรงกัน")
  const m = A.matchRoster([row("0501", "นาง", "สองเลข", "ไม่ตรงกัน"), row("0502", "นาง", "สองเลข", "ไม่ตรงกัน")], [split, near])
  assert.deepEqual(m.ambiguous.map((x) => x.index), [split.index])
  assert.deepEqual(m.matched, [])
})
