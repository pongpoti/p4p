/**
 * lib/allocation-xlsx.ts: the per-person allocation list an approved month
 * offers (Pong, 2026-11-17), laid out like the hospital's June 2569 file.
 * Built here from a made-up SK03 (staff and intern sheets, data from row 8)
 * and read back: the order, the columns Pong set, the month's colour, the
 * font, and the totals.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const ExcelJS = require("exceljs")
const A = require(resolve(repoRoot, "lib/allocation-xlsx"))

// A, B prefix, C first, D last, E position, F rank, G type, ... M admin, N pay
const STAFF = [
  [1, "พญ.", "ทดสอบหนึ่ง", "ตัวอย่าง", "นายแพทย์", "ชำนาญการ", "ข้าราชการ", 0, 10244],
  [2, "นพ.", " ทดสอบ  สอง ", "ตัวอย่าง", "นายแพทย์", "ชำนาญการ", "ข้าราชการ", 3000, 10268],
  [3, "พญ.", "ทดสอบสาม", "ตัวอย่าง", "นายแพทย์", "", "ลูกจ้างเงินบำรุง(รายวัน)", 800, 9500.5],
]
const INTERN = [
  [1, "นพ.", "ทดสอบสี่", "ตัวอย่าง", "นายแพทย์", "", "พนักงานมหาวิทยาลัย", 0, 9491],
]

/** A made-up SK03 as the build's .xlsx copy has it. */
async function fakeSk03() {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of [["ส.ค. 69 - staff", STAFF], ["ส.ค. 69 - intern", INTERN]]) {
    const ws = wb.addWorksheet(name)
    ws.getCell("A5").value = "ที่"
    rows.forEach((v, i) => {
      const r = ws.getRow(8 + i)
      ;[1, 2, 3, 4, 5, 6, 7].forEach((c, j) => { r.getCell(c).value = v[j] })
      r.getCell(13).value = v[7]
      r.getCell(14).value = { formula: "1+1", result: v[8] }
      r.getCell(15).value = { formula: `M${8 + i}+N${8 + i}`, result: v[7] + v[8] }
    })
    // The totals row under the data: A is blank, so the list stops there.
    ws.getRow(8 + rows.length).getCell(14).value = 99999
  }
  wb.addWorksheet("กุมารเวชกรรม")
  return wb
}

const DEPT = { s8: "กุมารเวชกรรม", s9: "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", s10: "อายุรกรรม", i8: "INTERN" }
const deptOf = (intern, row) => DEPT[(intern ? "i" : "s") + row] ?? null

test("names, ids and the month's colour", () => {
  assert.equal(A.allocationFileName("2569_08"), "รายละเอียดการจัดสรรเงินรายบุคคล องค์กรแพทย์ เดือนสิงหาคม 2569.xlsx")
  assert.equal(A.allocationFileName("2570_01"), "รายละเอียดการจัดสรรเงินรายบุคคล องค์กรแพทย์ เดือนมกราคม 2570.xlsx")
  assert.equal(A.allocationFileName("2569_13"), null)
  // No running number after the last dash (Pong).
  assert.equal(A.allocationId("2569_08"), "ID-69-08-")
  assert.equal(A.allocationId("2570_12"), "ID-70-12-")
  assert.equal(A.allocationSheetName("2569_06"), "องค์กรแพทย์ (มิ.ย69)")
  assert.equal(A.allocationTitle("2569_06"),
    "รายละเอียดรายบุคคลของการจัดสรรเงินเพื่อจ่ายเป็นค่าตอบแทนตามผลการปฏิบัติงานโรงพยาบาลสมุทรสาคร ประจำเดือนมิถุนายน 2569")
  assert.equal(A.MONTH_COLORS.length, 12)
  assert.equal(new Set(A.MONTH_COLORS).size, 12)
  assert.ok(A.MONTH_COLORS.every((c) => /^[0-9A-F]{6}$/.test(c)))
  assert.equal(A.headerColor("2569_06"), "209823")   // the June file's own green
  assert.equal(A.headerColor("2570_06"), "209823")
  assert.notEqual(A.headerColor("2569_07"), A.headerColor("2569_08"))
  assert.equal(A.tintColor("000000"), "999999")
  assert.equal(A.tintColor("FFFFFF"), "FFFFFF")
  // The pale A/D fill: June's own from the hand-made file, a shade of the header otherwise.
  assert.equal(A.lightColor("2569_06"), "C5E0B4")
  assert.equal(A.lightColor("2569_08"), A.tintColor(A.headerColor("2569_08")))
  assert.equal(A.personName({ prefix: "พญ.", firstname: " ทดสอบ ", lastname: "ตัวอย่าง" }), "พญ.ทดสอบ  ตัวอย่าง")
  assert.equal(A.unitName("กุมารเวชกรรม", false), "องค์กรแพทย์ (กลุ่มงานกุมารเวชกรรม)")
  assert.equal(A.unitName("INTERN", true), "องค์กรแพทย์ (INTERN)")
  assert.equal(A.unitName("", false), "องค์กรแพทย์")
})

test("rows: SK03 staff in its order, then interns, to the totals row", async () => {
  const rows = A.allocationRows(await fakeSk03(), deptOf)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => [r.firstname, r.intern]),
    [["ทดสอบหนึ่ง", false], ["ทดสอบ สอง", false], ["ทดสอบสาม", false], ["ทดสอบสี่", true]])
  assert.deepEqual(rows[1], {
    prefix: "นพ.", firstname: "ทดสอบ สอง", lastname: "ตัวอย่าง", position: "นายแพทย์", type: "ข้าราชการ",
    admin: 3000, pay: 10268, department: "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", intern: false,
  })
  // A department nobody gave: an intern is still INTERN, staff is blank.
  const none = A.allocationRows(await fakeSk03(), () => null)
  assert.deepEqual(none.map((r) => r.department), ["", "", "", "INTERN"])
})

test("the workbook: June file layout, Pong's columns, totals", async () => {
  const rows = A.allocationRows(await fakeSk03(), deptOf)
  const buf = await A.buildAllocationXlsx("2569_08", rows, ExcelJS)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  assert.equal(wb.worksheets.length, 1)
  const ws = wb.worksheets[0]
  assert.equal(ws.name, "องค์กรแพทย์ (ส.ค69)")
  assert.equal(ws.getCell("A1").value, A.allocationTitle("2569_08"))
  assert.ok(ws.model.merges.includes("A1:K1"))
  // G..I: the June file's two-line headers, broken at a word.
  assert.deepEqual(ws.getRow(2).values.slice(1), ["No", "เลขที่บัตรประชาชน", "ชื่อ - สกุล", "หน่วยงาน P4P", "ตำแหน่ง",
    "ประเภทการจ้าง", "ค่าตอบแทน\nด้านบริหาร", "ค่าตอบแทนตาม\nสัดส่วนวิชาชีพ", "รวมยอดเงิน\nที่จ่าย", "รวมยอดหน่วยงาน", "หมายเหตุ"])
  for (let c = 1; c <= 11; c++) assert.equal(ws.getRow(2).getCell(c).fill.fgColor.argb, "FF" + A.headerColor("2569_08"))
  // Frozen above row 3, a filter on the table, A4 landscape with the top rows repeated.
  assert.equal(ws.views[0].state, "frozen")
  assert.equal(ws.views[0].ySplit, 2)
  assert.equal(ws.pageSetup.orientation, "landscape")
  assert.equal(ws.pageSetup.paperSize, 9)
  assert.equal(ws.pageSetup.printTitlesRow, "1:2")
  assert.ok(ws.autoFilter)

  const cell = (a) => ws.getCell(a).value
  // One row per person, the four in order, from row 3.
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("C" + r)),
    ["พญ.ทดสอบหนึ่ง  ตัวอย่าง", "นพ.ทดสอบ สอง  ตัวอย่าง", "พญ.ทดสอบสาม  ตัวอย่าง", "นพ.ทดสอบสี่  ตัวอย่าง"])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("D" + r)), ["องค์กรแพทย์ (กลุ่มงานกุมารเวชกรรม)",
    "องค์กรแพทย์ (กลุ่มงานเทคนิคการแพทย์และพยาธิวิทยาคลินิก)", "องค์กรแพทย์ (กลุ่มงานอายุรกรรม)", "องค์กรแพทย์ (INTERN)"])
  assert.equal(cell("A7"), null)
  for (let r = 3; r <= 6; r++) {
    assert.equal(cell("A" + r), "ID-69-08-")
    assert.equal(cell("B" + r), null)   // เลขที่บัตรประชาชน: empty (Pong)
    assert.equal(cell("K" + r), null)   // หมายเหตุ: empty (Pong)
    assert.equal(cell("E" + r), "นายแพทย์")
    assert.deepEqual(cell("I" + r).formula, `G${r}+H${r}`)
    assert.equal(ws.getCell("C" + r).font.name, "TH SarabunPSK")
    assert.equal(ws.getCell("A" + r).fill.fgColor.argb, "FF" + A.lightColor("2569_08"))
    assert.equal(ws.getCell("D" + r).fill.fgColor.argb, "FF" + A.lightColor("2569_08"))
  }
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("F" + r)), ["ข้าราชการ", "ข้าราชการ", "ลูกจ้างเงินบำรุง(รายวัน)", "พนักงานมหาวิทยาลัย"])
  // ค่าตอบแทนด้านบริหาร is blank when 0, as on the June file.
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("G" + r)), [null, 3000, 800, null])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("H" + r)), [10244, 10268, 9500.5, 9491])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("I" + r).result), [10244, 13268, 10300.5, 9491])
  // รวมยอดหน่วยงาน: the grand total on the last row only.
  assert.deepEqual([3, 4, 5].map((r) => cell("J" + r)), [null, null, null])
  assert.equal(cell("J6").formula, "SUM(I3:I6)")
  assert.equal(cell("J6").result, 10244 + 13268 + 10300.5 + 9491)
  for (const c of ["A1", "A2", "H3", "J6"]) assert.equal(ws.getCell(c).font.name, "TH SarabunPSK", c)

  // Another month: its own colour and id.
  const jan = new ExcelJS.Workbook()
  await jan.xlsx.load(await A.buildAllocationXlsx("2570_01", rows, ExcelJS))
  assert.equal(jan.worksheets[0].getCell("A2").fill.fgColor.argb, "FF" + A.headerColor("2570_01"))
  assert.equal(jan.worksheets[0].getCell("A3").value, "ID-70-01-")
})

test("text widths: TH SarabunPSK's own, marks over the letter take no room", () => {
  // ก at 16 pt, regular and bold, as process/text-width.ts measures the font.
  assert.ok(Math.abs(A.textPx("ก", 16) - 8.23) < 0.01)
  assert.ok(A.textPx("ก", 16, true) > A.textPx("ก", 16))
  assert.equal(A.textPx("กิ่", 16), A.textPx("ก", 16))
  assert.equal(A.textPx("a\u200bb", 16), A.textPx("ab", 16))
  assert.equal(A.textPx("\u00a0", 16), A.textPx(" ", 16))
  assert.equal(A.textPx("一", 12), 16)   // not in the font's table: a full em
  assert.equal(A.textPx("", 16), 0)
  assert.equal(A.moneyText(10268), "-  10,268.00-")
  assert.equal(A.moneyText(2250182.5), "-  2,250,182.50-")
  // 7 px a unit, 5% and 14 px of room, up to the next 1/8.
  assert.equal(A.fitWidth(0), 2)
  assert.equal(A.fitWidth(100), 17)
})

test("each column fits its content (Pong, 2026-11-17)", async () => {
  const widths = async (rows) => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await A.buildAllocationXlsx("2569_08", rows, ExcelJS))
    const ws = wb.worksheets[0]
    return { ws, w: Array.from({ length: 11 }, (_, i) => ws.getColumn(i + 1).width) }
  }
  const rows = A.allocationRows(await fakeSk03(), deptOf)
  const { ws, w } = await widths(rows)
  const fit = (s, pt, bold) => A.fitWidth(A.textPx("  " + s, pt, bold))
  const fitMoney = (n) => A.fitWidth(A.textPx(A.moneyText(n), 16, false))
  const head = (s, pt) => A.fitWidth(Math.max(...s.split("\n").map((t) => A.textPx(t, pt, true))) + 32)
  // Header only: B and K are always empty, E and G's values are shorter than their headers.
  assert.equal(w[1], head("เลขที่บัตรประชาชน", 16))
  assert.equal(w[10], head("หมายเหตุ", 16))
  assert.equal(w[6], head("ค่าตอบแทน\nด้านบริหาร", 10))
  // The widest value: the longest name, department, type, and the total in J.
  assert.equal(w[2], fit("นพ.ทดสอบ สอง  ตัวอย่าง", 16, false))
  assert.equal(w[3], fit("องค์กรแพทย์ (กลุ่มงานเทคนิคการแพทย์และพยาธิวิทยาคลินิก)", 16, true))
  assert.equal(w[5], fit("ลูกจ้างเงินบำรุง(รายวัน)", 16, false))
  assert.equal(w[9], Math.max(head("รวมยอดหน่วยงาน", 16), fitMoney(43303.5)))
  // Every value fits its column.
  for (let r = 3; r <= 6; r++) {
    for (let c = 1; c <= 11; c++) {
      const v = ws.getRow(r).getCell(c).value
      const x = v && typeof v === "object" ? v.result : v
      if (x === null || x === undefined) continue
      const s = c >= 7 && c <= 10 ? A.moneyText(x) : "  " + String(x)
      assert.ok(A.fitWidth(A.textPx(s, 16, c === 1 || c === 4)) <= w[c - 1], `row ${r} col ${c}`)
    }
  }
  // Two spaces before every value (Pong): text "  "@, money with "  " after the sign.
  for (let c = 1; c <= 11; c++) {
    const f = ws.getRow(3).getCell(c).numFmt
    if (c >= 7 && c <= 10) assert.match(f, /^_-"  "\* #,##0\.00_-;.*-"  "\* #,##0\.00_-;_-"  "\* "-"\?\?_-;_-@_-$/, `col ${c}`)
    else assert.equal(f, '"  "@', `col ${c}`)
  }
  // A longer name widens ชื่อ - สกุล only.
  const long = rows.map((r, i) => (i === 2 ? { ...r, firstname: "ทดสอบยาวมากเป็นพิเศษ", lastname: "ตัวอย่างนามสกุลยาวมาก" } : r))
  const w2 = (await widths(long)).w
  assert.ok(w2[2] > w[2])
  assert.deepEqual(w2.filter((_, i) => i !== 2), w.filter((_, i) => i !== 2))
  // The title fits the table on one line; the header row holds two lines.
  assert.equal(ws.getRow(1).height, 24)
  assert.equal(ws.getRow(2).height, 32)
  // No rows: the headers alone set the widths.
  const empty = (await widths([])).w
  assert.equal(empty[2], head("ชื่อ - สกุล", 16))
})

test("the width table matches the font files (process/text-width.ts)", () => {
  const { textWidthPx } = require(resolve(repoRoot, "process/text-width.ts"))
  const T = require(resolve(repoRoot, "lib/th-sarabun-widths"))
  for (const bold of [false, true]) {
    for (const [a, b] of T.RANGES) {
      for (let c = a; c <= b; c++) {
        const ch = String.fromCodePoint(c)
        assert.ok(Math.abs(A.textPx(ch, 16, bold) - textWidthPx(ch, 16, bold)) < 0.001, `${c.toString(16)} ${bold}`)
      }
    }
  }
  for (const s of ["องค์กรแพทย์ (กลุ่มงานเทคนิคการแพทย์และพยาธิวิทยาคลินิก)", "ลูกจ้างเงินบำรุง(รายวัน)", "- 2,250,182.50-"]) {
    assert.ok(Math.abs(A.textPx(s, 16, true) - textWidthPx(s, 16, true)) < 0.05, s)
  }
})
