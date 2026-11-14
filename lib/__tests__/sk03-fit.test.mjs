/**
 * process/sk03-fit.ts and process/text-width.ts: the SK03 column widths
 * workflow 2.2 sets once every sheet is built (Pong, 2026-11-13: each column
 * as wide as its longest value on one line; a header may wrap).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const tw = require(resolve(repoRoot, "process/text-width"))
const fit = require(resolve(repoRoot, "process/sk03-fit"))

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want}`)

test("text width matches Chrome's TH SarabunPSK measurement", () => {
  // Chromium canvas measureText at 16 pt, the same font files.
  near(tw.textWidthPx("นายแพทย์", 16), 58.4, 2, "นายแพทย์")
  near(tw.textWidthPx("ชำนาญการพิเศษ", 16), 95.0, 2, "ชำนาญการพิเศษ")
  near(tw.textWidthPx("2,200.00", 16), 53.2, 2, "2,200.00")
  // Thai marks take no width; bold is wider; size scales linearly.
  assert.equal(tw.textWidthPx("น", 16), tw.textWidthPx("นี่", 16))
  assert.ok(tw.textWidthPx("ข้าราชการ", 16, true) > tw.textWidthPx("ข้าราชการ", 16))
  near(tw.textWidthPx("ข้าราชการ", 32), 2 * tw.textWidthPx("ข้าราชการ", 16), 0.01, "scaling")
  // Invisible format characters add nothing.
  assert.equal(tw.textWidthPx("ก​ข", 16), tw.textWidthPx("กข", 16))
})

test("headers break between Thai words, punctuation stays on its word", () => {
  assert.deepEqual(fit.chunks("ประเภท (ข้าราชการ/พนักงานราชการ)"), ["ประเภท", "(ข้าราชการ/", "พนักงาน", "ราชการ)"])
  assert.deepEqual(fit.chunks("ค่าตอบแทนตามสัดส่วนวิชาชีพ"), ["ค่า", "ตอบแทน", "ตาม", "สัดส่วน", "วิชาชีพ"])
})

test("a column fits Sheets and the 1/8 narrower Excel copy", () => {
  for (const t of [10, 53.2, 84, 200]) {
    const px = fit.columnPx(t)
    assert.ok(px >= t + fit.PAD_X)
    assert.ok(((px + 1) / 8) * 7 >= t + 6, `Excel room for ${t}`)
    assert.ok(fit.textRoomPx(px) >= t - 0.001)
  }
})

// A small sheet: title row 0 merged A:C, header rows 1-2, body rows 3-5,
// a dotted signature line merged A:C on row 7.
function grid(cells, merges, colPx = [200, 200, 200], rowPx = 30) {
  const map = new Map(cells.map(([r, c, text, sizePt = 16, bold = false]) => [`${r},${c}`, { text, sizePt, bold }]))
  return {
    cell: (r, c) => map.get(`${r},${c}`) ?? null,
    merges: merges.map(([r1, c1, r2, c2]) => ({ r1, c1, r2, c2 })),
    colPx: (c) => colPx[c] ?? 100,
    rowPx: () => rowPx,
  }
}
const spec = (extra = {}) => ({ body: [{ rows: [3, 5], cols: [0, 1, 2] }], header: [1, 2], flexRow: 2, cols: [0, 1, 2], ...extra })

test("each column is as wide as its longest body value", () => {
  const g = grid(
    [[3, 0, "1"], [4, 0, "12"], [3, 1, "ข้าราชการ"], [4, 1, "พนักงานราชการ"], [3, 2, "2,200.00"], [5, 2, "12,345.00", 16, true]],
    [],
  )
  const { widths, heights } = fit.fitSheet(g, spec())
  assert.equal(widths.get(0), fit.columnPx(tw.textWidthPx("12", 16)))
  assert.equal(widths.get(1), fit.columnPx(tw.textWidthPx("พนักงานราชการ", 16)))
  assert.equal(widths.get(2), fit.columnPx(tw.textWidthPx("12,345.00", 16, true)))
  assert.equal(heights.size, 0)
})

test("merged body cells and columns outside the spec are left alone", () => {
  const g = grid([[3, 0, "a very long merged note that spans the row"], [4, 1, "ก"]], [[3, 0, 3, 2]])
  const { widths } = fit.fitSheet(g, spec({ cols: [1] }))
  assert.deepEqual([...widths.keys()], [1])
})

test("headers wrap but no column is narrower than a header word", () => {
  const g = grid([[1, 0, "ค่าตอบแทนตามสัดส่วนวิชาชีพ", 14, true], [3, 0, "1"]], [[1, 0, 2, 0]], [200, 200, 200], 60)
  const { widths, heights } = fit.fitSheet(g, spec({ cols: [0] }))
  const w = widths.get(0)
  assert.ok(w >= fit.columnPx(tw.textWidthPx("ตอบแทน", 14, true)))
  assert.ok(w < fit.columnPx(tw.textWidthPx("ค่าตอบแทนตามสัดส่วนวิชาชีพ", 14, true)), "the header wraps")
  assert.ok(fit.headerHeightPx({ text: "ค่าตอบแทนตามสัดส่วนวิชาชีพ", sizePt: 14, bold: true }, w) <= 120, "fits its two rows")
  assert.equal(heights.size, 0)
})

test("a header that needs more lines than its rows hold widens its column", () => {
  const cell = { text: "ค่าตอบแทนตามสัดส่วนวิชาชีพ", sizePt: 14, bold: true }
  const g = grid([[1, 0, cell.text, 14, true], [3, 0, "1"]], [[1, 0, 2, 0]], [200, 200, 200], 15)
  const { widths, heights } = fit.fitSheet(g, spec({ cols: [0] }))
  assert.ok(fit.headerHeightPx(cell, widths.get(0)) <= 30)
  assert.equal(heights.size, 0, "rows keep their height")
})

test("the signature column keeps its header on one line", () => {
  const g = grid([[1, 0, "ลายมือชื่อผู้รับเงิน"], [3, 0, " "]], [])
  const { widths } = fit.fitSheet(g, spec({ cols: [0], oneLineHeader: [0] }))
  assert.equal(widths.get(0), fit.columnPx(tw.textWidthPx("ลายมือชื่อผู้รับเงิน", 16)))
})

test("dotted signature lines are shortened to fit, never lengthened", () => {
  const long = ".".repeat(150) + "หัวหน้างาน"
  const short = ".".repeat(12) + "หัวหน้างาน"
  const g = grid([[3, 0, "พนักงานราชการ"], [3, 1, "พนักงานราชการ"], [3, 2, "พนักงานราชการ"], [7, 0, long, 16, true], [8, 0, short, 16, true]], [[7, 0, 7, 2], [8, 0, 8, 2]])
  const { widths, texts } = fit.fitSheet(g, spec({ dotRows: [7, 8] }))
  assert.equal(texts.length, 1)
  const total = widths.get(0) + widths.get(1) + widths.get(2)
  assert.ok(tw.textWidthPx(texts[0].text, 16, true) <= fit.textRoomPx(total))
  assert.match(texts[0].text, /^\.+หัวหน้างาน$/)
})

test("a title wider than the table wraps and its row grows", () => {
  const title = "งบสาขา = 10,000 × จำนวนแพทย์ + ส่วนเพิ่มต่อหน่วย × (จำนวนแพทย์ × น้ำหนักส่วนเพิ่ม)"
  const g = grid([[0, 0, title, 14], [3, 0, "1"], [3, 1, "ก"], [3, 2, "ข"]], [[0, 0, 0, 2]], [200, 200, 200], 21)
  const { wraps, heights } = fit.fitSheet(g, spec({ titleRows: [0] }))
  assert.deepEqual(wraps, [{ r: 0, c: 0 }])
  assert.ok(heights.get(0) > 21)
})

test("the SK03 specs point at the rows process.ts writes", () => {
  const staff = fit.overallSpec(false, 8, 190)
  assert.deepEqual(staff.body[0], { rows: [7, 189], cols: [...Array(22).keys()] })
  assert.deepEqual(staff.dotRows, [193, 194]) // signatures at total+4 and total+5
  const intern = fit.overallSpec(true, 8, 39)
  assert.deepEqual(intern.body[1].cols, [21, 22])
  const dept = fit.deptSpec(25)
  assert.deepEqual(dept.body[0].rows, [5, 24])
  assert.deepEqual(dept.dotRows, [27, 29]) // signatures at last+3 and last+5
  assert.deepEqual(fit.budgetSpec(6, 24).body[0].rows, [5, 23])
  // งบรายสาขา runs A..Q: the 15,000-cap columns O..Q are sized too.
  assert.deepEqual(fit.budgetSpec(6, 24).cols, [...Array(17).keys()])
})
