/**
 * lib/allocation-xlsx.ts: the per-person allocation list an approved month
 * offers (Pong, 2026-11-17), laid out like the hospital's June 2569 file.
 * Built here from a made-up SK03 (staff and intern sheets, data from row 8)
 * and read back: the order, the columns Pong set, the month's colour, SK03's
 * font and cell format, and the totals.
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
  // The No's prefix; the running number goes after the last dash.
  assert.equal(A.allocationId("2569_08"), "ID-69-08-")
  assert.equal(A.allocationId("2570_12"), "ID-70-12-")
  assert.deepEqual([0, 1, 9, 99, 999, 1999].map(A.runNo), ["0001", "0002", "0010", "0100", "1000", "2000"])
  assert.equal(A.allocationSheetName("2569_06"), "องค์กรแพทย์ (มิ.ย69)")
  assert.equal(A.allocationTitle("2569_06"),
    "รายละเอียดรายบุคคลของการจัดสรรเงินเพื่อจ่ายเป็นค่าตอบแทนตามผลการปฏิบัติงานโรงพยาบาลสมุทรสาคร ประจำเดือนมิถุนายน 2569")
  assert.equal(A.MONTH_COLORS.length, 12)
  assert.equal(new Set(A.MONTH_COLORS).size, 12)
  assert.ok(A.MONTH_COLORS.every((c) => /^[0-9A-F]{6}$/.test(c)))
  assert.equal(A.headerColor("2569_06"), "209823")   // the June file's own green
  assert.equal(A.headerColor("2570_06"), "209823")
  assert.notEqual(A.headerColor("2569_07"), A.headerColor("2569_08"))
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

test("the workbook: June file layout, Pong's columns, SK03's format, totals", async () => {
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
  // Headers: the month's colour (Pong), SK03's bold black type at SK03's sizes, centred, thin lines.
  const SIZES = [18, 18, 18, 18, 18, 12, 14, 14, 14, 14, 13]
  for (let c = 1; c <= 11; c++) {
    const h = ws.getRow(2).getCell(c)
    assert.equal(h.fill.fgColor.argb, "FF" + A.headerColor("2569_08"))
    assert.deepEqual(h.font, { name: "TH SarabunPSK", size: SIZES[c - 1], bold: true, color: { argb: "FF000000" } }, "header " + c)
    assert.deepEqual(h.alignment, { horizontal: "center", vertical: "middle", wrapText: true })
    assert.deepEqual(Object.keys(h.border).sort(), ["bottom", "left", "right", "top"])
    assert.ok(Object.values(h.border).every((b) => b.style === "thin"))
  }
  assert.deepEqual(ws.getCell("A1").font, { name: "TH SarabunPSK", size: 18, bold: true, color: { argb: "FF000000" } })
  // Frozen above row 3, a filter on the table; SK03's page: A4 landscape, one page wide, centred.
  assert.equal(ws.views[0].state, "frozen")
  assert.equal(ws.views[0].ySplit, 2)
  assert.notEqual(ws.views[0].showGridLines, false)
  assert.equal(ws.pageSetup.orientation, "landscape")
  assert.equal(ws.pageSetup.paperSize, 9)
  assert.equal(ws.pageSetup.fitToWidth, 1)
  assert.equal(ws.pageSetup.horizontalCentered, true)
  assert.equal(ws.pageSetup.printTitlesRow, "1:2")
  assert.ok(ws.autoFilter)

  const cell = (a) => ws.getCell(a).value
  // One row per person, the four in order, from row 3.
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("C" + r)),
    ["พญ.ทดสอบหนึ่ง  ตัวอย่าง", "นพ.ทดสอบ สอง  ตัวอย่าง", "พญ.ทดสอบสาม  ตัวอย่าง", "นพ.ทดสอบสี่  ตัวอย่าง"])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("D" + r)), ["องค์กรแพทย์ (กลุ่มงานกุมารเวชกรรม)",
    "องค์กรแพทย์ (กลุ่มงานเทคนิคการแพทย์และพยาธิวิทยาคลินิก)", "องค์กรแพทย์ (กลุ่มงานอายุรกรรม)", "องค์กรแพทย์ (INTERN)"])
  assert.equal(cell("A7"), null)
  // The sum row: only I, =SUM on green; the rest of the row has no value and no format.
  assert.equal(cell("I7").formula, "SUM(I3:I6)")
  assert.equal(cell("I7").result, 10244 + 13268 + 10300.5 + 9491)
  assert.equal(ws.getCell("I7").fill.fgColor.argb, "FF92D050")
  assert.equal(ws.getCell("I7").numFmt, "###,##0.00")
  assert.equal(ws.getCell("I7").font.bold, true)
  for (const c of "ABCDEFGHJK") {
    assert.equal(cell(c + "7"), null, c)
    assert.equal(ws.getCell(c + "7").fill, undefined, c)
    assert.equal(ws.getCell(c + "7").border, undefined, c)
  }
  for (let r = 3; r <= 6; r++) {
    // No: 0001 on the first row, one up each row, staff then interns (Pong, 2026-11-20).
    assert.equal(cell("A" + r), "ID-69-08-000" + (r - 2))
    assert.equal(cell("B" + r), null)   // เลขที่บัตรประชาชน: empty (Pong)
    assert.equal(cell("K" + r), null)   // หมายเหตุ: empty (Pong)
    assert.equal(cell("E" + r), "นายแพทย์")
    assert.deepEqual(cell("I" + r).formula, `G${r}+H${r}`)
    // SK03's data cells: 16 pt regular black, middle, thin lines, no fill; rows 30 high.
    assert.equal(ws.getRow(r).height, 30)
    for (let c = 1; c <= 11; c++) {
      const x = ws.getRow(r).getCell(c)
      assert.deepEqual(x.font, { name: "TH SarabunPSK", size: 16, color: { argb: "FF000000" } }, `${r}/${c}`)
      assert.equal(x.alignment.vertical, "middle")
      assert.ok(Object.values(x.border).every((b) => b.style === "thin"))
      assert.equal(Object.keys(x.border).length, 4)
      assert.notEqual(x.fill?.pattern, "solid", `${r}/${c}`)
      // Money as ###,##0.00 on the right; text left (No centred, หมายเหตุ right as on SK03), wrapping, with no number format.
      if (c >= 7 && c <= 9) {
        assert.equal(x.numFmt, "###,##0.00")
        assert.equal(x.alignment.horizontal, "right")
      } else {
        assert.equal(x.numFmt, undefined, `${r}/${c}`)
        assert.equal(x.alignment.horizontal, c === 1 ? "center" : c === 11 ? "right" : "left")
        assert.equal(x.alignment.wrapText, true)
      }
    }
  }
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("F" + r)), ["ข้าราชการ", "ข้าราชการ", "ลูกจ้างเงินบำรุง(รายวัน)", "พนักงานมหาวิทยาลัย"])
  // ค่าตอบแทนด้านบริหาร is blank when 0, as on the June file.
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("G" + r)), [null, 3000, 800, null])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("H" + r)), [10244, 10268, 9500.5, 9491])
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("I" + r).result), [10244, 13268, 10300.5, 9491])
  // รวมยอดหน่วยงาน: empty and plain; the total is in the sum row (Pong).
  assert.deepEqual([3, 4, 5, 6].map((r) => cell("J" + r)), [null, null, null, null])
  for (const c of ["A1", "A2", "H3", "J6"]) assert.equal(ws.getCell(c).font.name, "TH SarabunPSK", c)

  // Another month: its own colour and id.
  const jan = new ExcelJS.Workbook()
  await jan.xlsx.load(await A.buildAllocationXlsx("2570_01", rows, ExcelJS))
  assert.equal(jan.worksheets[0].getCell("A2").fill.fgColor.argb, "FF" + A.headerColor("2570_01"))
  assert.equal(jan.worksheets[0].getCell("A3").value, "ID-70-01-0001")
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
  assert.equal(A.moneyText(10268), "10,268.00")
  assert.equal(A.moneyText(2250182.5), "2,250,182.50")
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
  const fit = (s) => A.fitWidth(A.textPx(s, 16))
  const head = (s, pt) => A.fitWidth(Math.max(...s.split("\n").map((t) => A.textPx(t, pt, true))) + 32)
  // Header only: B, J and K are always empty, G's values are shorter than its header.
  assert.equal(w[1], head("เลขที่บัตรประชาชน", 18))
  assert.equal(w[10], head("หมายเหตุ", 13))
  assert.equal(w[6], head("ค่าตอบแทน\nด้านบริหาร", 14))
  assert.equal(w[9], head("รวมยอดหน่วยงาน", 14))
  // The widest value: the longest name, department and type.
  assert.equal(w[2], fit("นพ.ทดสอบ สอง  ตัวอย่าง"))
  assert.equal(w[3], fit("องค์กรแพทย์ (กลุ่มงานเทคนิคการแพทย์และพยาธิวิทยาคลินิก)"))
  assert.equal(w[5], fit("ลูกจ้างเงินบำรุง(รายวัน)"))
  // Every value fits its column.
  for (let r = 3; r <= 6; r++) {
    for (let c = 1; c <= 11; c++) {
      const v = ws.getRow(r).getCell(c).value
      const x = v && typeof v === "object" ? v.result : v
      if (x === null || x === undefined) continue
      const s = c >= 7 && c <= 9 ? A.moneyText(x) : String(x)
      assert.ok(A.fitWidth(A.textPx(s, 16)) <= w[c - 1], `row ${r} col ${c}`)
    }
  }
  // The sum fits under I.
  assert.ok(A.fitWidth(A.textPx(A.moneyText(10244 + 13268 + 10300.5 + 9491), 16)) <= w[8])
  // A longer name widens ชื่อ - สกุล only.
  const long = rows.map((r, i) => (i === 2 ? { ...r, firstname: "ทดสอบยาวมากเป็นพิเศษ", lastname: "ตัวอย่างนามสกุลยาวมาก" } : r))
  const w2 = (await widths(long)).w
  assert.ok(w2[2] > w[2])
  assert.deepEqual(w2.filter((_, i) => i !== 2), w.filter((_, i) => i !== 2))
  // The header row holds two lines of 14 pt; the title takes SK03's 21 a line.
  assert.equal(ws.getRow(1).height % 21, 0)
  assert.equal(ws.getRow(2).height, 40)
  // No rows: the headers alone set the widths.
  const empty = (await widths([])).w
  assert.equal(empty[2], head("ชื่อ - สกุล", 18))
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
