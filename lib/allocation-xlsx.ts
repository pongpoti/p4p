/**
 * lib/allocation-xlsx.ts
 *
 * The ตรวจสอบ tab's per-person allocation list (Pong, 2026-11-17): once a
 * month is approved, the tab offers "รายละเอียดการจัดสรรเงินรายบุคคล
 * องค์กรแพทย์ เดือน<month> <BE year>.xlsx", laid out like the June 2569 file
 * the hospital fills by hand (sheet "องค์กรแพทย์ (มิ.ย69)"):
 *
 *   row 1   the title, merged A:K
 *   row 2   the headers, on the month's own colour (MONTH_COLORS)
 *   row 3+  one row per doctor: SK03's staff sheet in its order, then its
 *           intern sheet, read from the approved round's own SK03 copy
 *
 *   A No                      "ID-<yy>-<MM>-" + a running number of 4 digits, 0001 for
 *                             the first row down to the last intern (Pong, 2026-11-20:
 *                             "number automatically with 4 digits zero leading start
 *                             with 0001"; the hospital's เอกสารจัดสรร is not in any
 *                             name order, so its numbers are no longer used)
 *   B เลขที่บัตรประชาชน         left empty (the app never holds ID numbers)
 *   C ชื่อ - สกุล               SK03 B (the roster's prefix, นพ./พญ.) + C, two spaces, D
 *   D หน่วยงาน P4P             "องค์กรแพทย์ (กลุ่มงาน<department>)", "องค์กรแพทย์ (INTERN)"
 *   E ตำแหน่ง                  SK03 E
 *   F ประเภทการจ้าง             SK03 G
 *   G ค่าตอบแทนด้านบริหาร        SK03 M (blank when 0)
 *   H ค่าตอบแทนตามสัดส่วนวิชาชีพ  SK03 N
 *   I รวมยอดเงินที่จ่าย           =G+H
 *   J รวมยอดหน่วยงาน            left empty (Pong); the total is the sum row under I
 *   K หมายเหตุ                  left empty
 *
 * Font and cell format as on SK03's staff sheet (Pong, 2026-11-17: "same
 * font and format exactly same as SK03"): TH SarabunPSK in black, data at
 * 16 pt on rows 30 high, money as ###,##0.00 on the right, text on the
 * left, every cell middle-aligned in thin lines; bold centred headers at
 * SK03's sizes; the title bold 18; A4 landscape, one page wide, centred.
 * Two things are Pong's own and stay: the month's header colour and the
 * green sum row under I. Each column is as wide as its widest cell, header
 * included (Pong, 2026-11-17: "Each column should fits its content"),
 * measured with the font's own character widths
 * (lib/th-sarabun-widths.ts). The department is the roster's
 * (review_build_people, by the person's SK03 row): SK03's department sheet
 * titles are cut to 31 characters by the .xlsx export.
 *
 * No network here: lib/review-server.ts fetches the files and sends the
 * result; lib/__tests__/allocation-xlsx.test.mjs checks the layout.
 */

import type { Workbook, Worksheet, Borders, Fill } from "exceljs"
const fontTable = require("./th-sarabun-widths") as typeof import("./th-sarabun-widths")

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]
const TH_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]

/**
 * One header colour per month, so the twelve files tell apart at a glance
 * (Pong). มิ.ย. keeps the green of the hand-made June file; the others go
 * round the colour wheel at a similar depth. Header text is black, as on SK03.
 */
export const MONTH_COLORS: readonly string[] = [
  "5B9BD5", // ม.ค.  sky blue
  "E58AB8", // ก.พ.  pink
  "F28E5C", // มี.ค.  coral
  "F2C14E", // เม.ย.  marigold
  "B39DDB", // พ.ค.  lavender
  "209823", // มิ.ย.  green (the June file's own)
  "4DB6AC", // ก.ค.  teal
  "7E8CE0", // ส.ค.  periwinkle
  "E57373", // ก.ย.  rose red
  "D9A066", // ต.ค.  caramel
  "4FC3F7", // พ.ย.  light cyan
  "AED581", // ธ.ค.  lime
]

// SK03's own: font, black text, money format, the sum row's green (Pong's).
const FONT = "TH SarabunPSK"
const BLACK = "FF000000"
const MONEY = "###,##0.00"
const TOTAL_FILL = "FF92D050"   // the sum row's I, the June file's green (Pong)
const FIRST_ROW = 3
const SK03_FIRST_ROW = 8

const HEADERS = ["No", "เลขที่บัตรประชาชน", "ชื่อ - สกุล", "หน่วยงาน P4P", "ตำแหน่ง", "ประเภทการจ้าง",
  "ค่าตอบแทน\nด้านบริหาร", "ค่าตอบแทนตาม\nสัดส่วนวิชาชีพ", "รวมยอดเงิน\nที่จ่าย", "รวมยอดหน่วยงาน", "หมายเหตุ"]
// SK03's header sizes: 18 for ที่, ชื่อ-สกุล and ตำแหน่ง, 12 for ประเภท, 14
// for the money columns, 13 for หมายเหตุ. G..I go on two lines, broken at
// a word here, so the money columns stay as narrow as their numbers in
// every app (none breaks Thai the same way).
const HEAD_SIZES = [18, 18, 18, 18, 18, 12, 14, 14, 14, 14, 13]
const HEAD_HEIGHT = 40   // two lines of 14 pt
const BODY_SIZE = 16
const BODY_HEIGHT = 30   // SK03's data rows
const TITLE_SIZE = 18
const TITLE_HEIGHT = 21  // SK03's title rows, a line each

export interface AllocationRow {
  prefix: string
  firstname: string
  lastname: string
  position: string
  type: string
  admin: number | null
  pay: number | null
  department: string
  intern: boolean
}

/** "2569_08" → { be: 2569, m: 8 }, or null. */
function parseKey(month: string): { be: number; m: number } | null {
  const x = /^(\d{4})_(\d{2})$/.exec(String(month ?? ""))
  if (!x) return null
  const m = Number(x[2])
  return m >= 1 && m <= 12 ? { be: Number(x[1]), m } : null
}

/** "2569_08" → "รายละเอียดการจัดสรรเงินรายบุคคล องค์กรแพทย์ เดือนสิงหาคม 2569.xlsx" */
export function allocationFileName(month: string): string | null {
  const k = parseKey(month)
  return k ? "รายละเอียดการจัดสรรเงินรายบุคคล องค์กรแพทย์ เดือน" + TH_MONTHS[k.m - 1] + " " + k.be + ".xlsx" : null
}

/** The i-th row's running number (from 0): "0001", "0002", … */
export const runNo = (i: number): string => String(i + 1).padStart(4, "0")

/** "2569_08" → "ID-69-08-": the month's own year, two digits, and month. */
export function allocationId(month: string): string {
  const k = parseKey(month)
  if (!k) throw new Error("bad month " + month)
  return "ID-" + String(k.be % 100).padStart(2, "0") + "-" + String(k.m).padStart(2, "0") + "-"
}

/** "2569_06" → "องค์กรแพทย์ (มิ.ย69)", as the June file names its sheet. */
export function allocationSheetName(month: string): string {
  const k = parseKey(month)
  if (!k) throw new Error("bad month " + month)
  return "องค์กรแพทย์ (" + TH_MONTHS_SHORT[k.m - 1].replace(/\.$/, "") + String(k.be % 100).padStart(2, "0") + ")"
}

export function allocationTitle(month: string): string {
  const k = parseKey(month)
  if (!k) throw new Error("bad month " + month)
  return "รายละเอียดรายบุคคลของการจัดสรรเงินเพื่อจ่ายเป็นค่าตอบแทนตามผลการปฏิบัติงานโรงพยาบาลสมุทรสาคร ประจำเดือน" +
    TH_MONTHS[k.m - 1] + " " + k.be
}

/** The month's header colour, "RRGGBB". */
export function headerColor(month: string): string {
  const k = parseKey(month)
  if (!k) throw new Error("bad month " + month)
  return MONTH_COLORS[k.m - 1]
}

const squash = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim()

/** "พญ." + "ทดสอบ" + "ตัวอย่าง" → "พญ.ทดสอบ  ตัวอย่าง" (the June file's spacing). */
export function personName(r: Pick<AllocationRow, "prefix" | "firstname" | "lastname">): string {
  return (squash(r.prefix) + squash(r.firstname) + "  " + squash(r.lastname)).trim()
}

/** "กุมารเวชกรรม" → "องค์กรแพทย์ (กลุ่มงานกุมารเวชกรรม)"; INTERN stays as it is. */
export function unitName(department: string, intern: boolean): string {
  const d = squash(department)
  if (intern || d.toUpperCase() === "INTERN") return "องค์กรแพทย์ (INTERN)"
  if (!d) return "องค์กรแพทย์"
  return "องค์กรแพทย์ (" + (d.startsWith("กลุ่มงาน") ? d : "กลุ่มงาน" + d) + ")"
}

/** A cell's value as written or as a formula's saved result. */
function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v !== "object") return v
  if (v instanceof Date) return v
  const o = v as Record<string, unknown>
  if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("")
  if ("result" in o || "formula" in o || "sharedFormula" in o) return cellValue(o.result)
  if ("text" in o) return o.text
  return null
}
const num = (v: unknown): number | null => {
  const x = cellValue(v)
  if (typeof x === "number" && isFinite(x)) return x
  if (typeof x === "string" && x.trim() !== "" && isFinite(Number(x.replace(/,/g, "")))) return Number(x.replace(/,/g, ""))
  return null
}
const text = (v: unknown): string => squash(cellValue(v))

/** SK03's staff and intern sheets: by name, else the first two. */
export function overallSheets(wb: Workbook): { staff: Worksheet; intern: Worksheet } {
  const list = wb.worksheets
  const staff = list.find((w) => / - staff$/i.test(w.name)) ?? list[0]
  const intern = list.find((w) => / - intern$/i.test(w.name)) ?? list[1]
  if (!staff || !intern) throw new Error("SK03 has no staff and intern sheets")
  return { staff, intern }
}

/**
 * The rows of SK03's staff sheet in order, then its intern sheet, from row
 * 8 down to the totals row (A not a number). `deptOf` gives the roster's
 * department for a sheet row (null: not known).
 */
export function allocationRows(wb: Workbook, deptOf: (intern: boolean, row: number) => string | null): AllocationRow[] {
  const { staff, intern } = overallSheets(wb)
  const out: AllocationRow[] = []
  for (const [ws, isIntern] of [[staff, false], [intern, true]] as [Worksheet, boolean][]) {
    for (let r = SK03_FIRST_ROW; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      if (num(row.getCell(1).value) === null) break
      out.push({
        prefix: text(row.getCell(2).value),
        firstname: text(row.getCell(3).value),
        lastname: text(row.getCell(4).value),
        position: text(row.getCell(5).value),
        type: text(row.getCell(7).value),
        admin: num(row.getCell(13).value),
        pay: num(row.getCell(14).value),
        department: deptOf(isIntern, r) ?? (isIntern ? "INTERN" : ""),
        intern: isIntern,
      })
    }
  }
  return out
}

// Thin lines on every side of every table cell, as on SK03.
const thin = { style: "thin" } as Borders["top"]
const GRID: Partial<Borders> = { top: thin, left: thin, bottom: thin, right: thin }
const solid = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } })

// SK03's alignment: ที่ centred, text on the left, money and หมายเหตุ on
// the right. J (รวมยอดหน่วยงาน) is empty and has no number format (Pong).
const isMoney = (j: number): boolean => j >= 6 && j <= 8
const ALIGN: ("center" | "left" | "right")[] = ["center", "left", "left", "left", "left", "left", "right", "right", "right", "left", "right"]

/** How wide TH SarabunPSK draws `s` at `pt` points, in px at 96 dpi. */
export function textPx(s: string, pt: number, bold = false): number {
  const table = bold ? fontTable.PX_PER_PT.bold : fontTable.PX_PER_PT.regular
  let w = 0
  for (const ch of String(s ?? "")) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) continue   // zero-width
    w += table.get(cp === 0xa0 ? 0x20 : cp) ?? fontTable.FALLBACK_PX_PER_PT
  }
  return w * pt
}

// Excel's column unit is the default font's digit, 7 px (Calibri 11, which
// ExcelJS writes as the workbook default). A column gets its widest text
// plus 5% (screens round each letter's width) and 14 px for the cell's own
// margins, to the next 1/8 of a unit.
const PX_PER_UNIT = 7
const FIT_SLACK = 1.05
const FIT_PAD_PX = 14
export function fitWidth(px: number): number {
  return Math.ceil(((px * FIT_SLACK + FIT_PAD_PX) / PX_PER_UNIT) * 8) / 8
}

/** A number as ###,##0.00 draws it. */
export function moneyText(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A cell value as shown on screen, for measuring. */
function shown(v: unknown, money: boolean): string {
  const x = cellValue(v)
  if (x === null || x === undefined || x === "") return ""
  if (money && typeof x === "number") return moneyText(x)
  return String(x)
}

// The filter button covers the right end of each header cell; a centred
// header keeps clear of it with that much room on both sides. A header on
// two lines needs its longer line.
const FILTER_BUTTON_PX = 16

/**
 * The widths (Excel units) that fit each column to its widest cell: the
 * header's longer line at its own size, in bold, beside the filter button;
 * every data cell at 16 pt.
 */
export function columnWidths(cells: unknown[][]): number[] {
  return HEADERS.map((h, j) => {
    let px = Math.max(...h.split("\n").map((t) => textPx(t, HEAD_SIZES[j], true))) + 2 * FILTER_BUTTON_PX
    for (const row of cells) px = Math.max(px, textPx(shown(row[j], isMoney(j)), BODY_SIZE))
    return fitWidth(px)
  })
}

/** The .xlsx, as a Buffer. */
export async function buildAllocationXlsx(month: string, rows: AllocationRow[], ExcelJS: typeof import("exceljs")): Promise<Buffer> {
  const color = "FF" + headerColor(month)
  const id = allocationId(month)
  const last = FIRST_ROW + rows.length - 1
  const total = rows.reduce((s, x) => s + (x.admin || 0) + (x.pay ?? 0), 0)
  const cells: unknown[][] = rows.map((p, i) => {
    const r = FIRST_ROW + i
    const admin = p.admin && p.admin !== 0 ? p.admin : null
    return [
      id + runNo(i), null, personName(p), unitName(p.department, p.intern), p.position || null, p.type || null,
      admin, p.pay,
      { formula: `G${r}+H${r}`, result: (admin ?? 0) + (p.pay ?? 0) },
      null,
      null,
    ]
  })
  // The sum row under the table (Pong, 2026-11-17): only I, =SUM of I, on
  // green, bold like SK03's totals; every other cell of the row is plain.
  const sumRow = last + 1
  const widths = columnWidths(rows.length ? [...cells, [null, null, null, null, null, null, null, null, total, null, null]] : cells)

  const wb = new ExcelJS.Workbook()
  wb.creator = "P4P"
  wb.title = (allocationFileName(month) ?? "").replace(/\.xlsx$/, "")
  // SK03's page: A4 landscape, one page wide, centred, its margins. The
  // title and headers stay on screen and on every printed page.
  const ws = wb.addWorksheet(allocationSheetName(month), {
    views: [{ state: "frozen", ySplit: 2, topLeftCell: "A3" }],
    pageSetup: {
      paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.039, right: 0.039, top: 0.551, bottom: 0.551, header: 0, footer: 0 },
      printTitlesRow: "1:2",
    },
  })
  ws.columns = widths.map((width) => ({ width }))

  // The title spans A:K; when the fitted columns are narrower than it, it
  // wraps onto as many lines as it needs.
  ws.mergeCells("A1:K1")
  const title = ws.getCell("A1")
  title.value = allocationTitle(month)
  title.font = { name: FONT, size: TITLE_SIZE, bold: true, color: { argb: BLACK } }
  const spanPx = widths.reduce((s, w) => s + w * PX_PER_UNIT, 0)
  const titleLines = Math.max(1, Math.ceil((textPx(allocationTitle(month), TITLE_SIZE, true) * FIT_SLACK + FIT_PAD_PX) / spanPx))
  title.alignment = { horizontal: "center", vertical: "middle", wrapText: titleLines > 1 }
  ws.getRow(1).height = TITLE_HEIGHT * titleLines

  const head = ws.getRow(2)
  head.height = HEAD_HEIGHT
  HEADERS.forEach((h, i) => {
    const c = head.getCell(i + 1)
    c.value = h
    c.font = { name: FONT, size: HEAD_SIZES[i], bold: true, color: { argb: BLACK } }
    c.fill = solid(color)
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }
    c.border = GRID
  })

  cells.forEach((values, i) => {
    const r = FIRST_ROW + i
    const row = ws.getRow(r)
    row.height = BODY_HEIGHT
    values.forEach((v, j) => {
      const c = row.getCell(j + 1)
      if (v !== null && v !== undefined) c.value = v as never
      c.font = { name: FONT, size: BODY_SIZE, color: { argb: BLACK } }
      // Text wraps, as on SK03; money stays on its line.
      c.alignment = isMoney(j) ? { horizontal: "right", vertical: "middle" } : { horizontal: ALIGN[j], vertical: "middle", wrapText: true }
      c.border = GRID
      if (isMoney(j)) c.numFmt = MONEY
    })
  })

  if (rows.length) {
    const c = ws.getRow(sumRow).getCell(9)
    c.value = { formula: `SUM(I${FIRST_ROW}:I${last})`, result: total }
    c.font = { name: FONT, size: BODY_SIZE, bold: true, color: { argb: BLACK } }
    c.alignment = { horizontal: "right", vertical: "middle" }
    c.numFmt = MONEY
    c.fill = solid(TOTAL_FILL)
    ws.getRow(sumRow).height = BODY_HEIGHT
  }
  if (rows.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: last, column: 11 } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
