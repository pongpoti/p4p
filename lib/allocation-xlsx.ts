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
 *   A No                      "ID-<yy>-<MM>-" (no running number)
 *   B เลขที่บัตรประชาชน         left empty (the app never holds ID numbers)
 *   C ชื่อ - สกุล               SK03 B (the roster's prefix, นพ./พญ.) + C, two spaces, D
 *   D หน่วยงาน P4P             "องค์กรแพทย์ (กลุ่มงาน<department>)", "องค์กรแพทย์ (INTERN)"
 *   E ตำแหน่ง                  SK03 E
 *   F ประเภทการจ้าง             SK03 G
 *   G ค่าตอบแทนด้านบริหาร        SK03 M (blank when 0)
 *   H ค่าตอบแทนตามสัดส่วนวิชาชีพ  SK03 N
 *   I รวมยอดเงินที่จ่าย           =G+H
 *   J รวมยอดหน่วยงาน            last row only: =SUM(I3:I<last>)
 *   K หมายเหตุ                  left empty
 *
 * TH SarabunPSK throughout, as on SK03. The department is the roster's
 * (review_build_people, by the person's SK03 row): SK03's department sheet
 * titles are cut to 31 characters by the .xlsx export.
 *
 * No network here: lib/review-server.ts fetches the files and sends the
 * result; lib/__tests__/allocation-xlsx.test.mjs checks the layout.
 */

import type { Workbook, Worksheet, Borders, Fill } from "exceljs"

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]
const TH_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]

/**
 * One header colour per month, so the twelve files tell apart at a glance.
 * มิ.ย. keeps the green of the hand-made June file; the others go round the
 * colour wheel at a similar depth. Header text is dark (#333333) on every one.
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

const FONT = "TH SarabunPSK"
const HEAD_TEXT = "FF333333"
const SUM_FILL = "FFFFCCFF"     // I: =G+H, as on the June file
const TOTAL_FILL = "FF92D050"   // J: the grand total, as on the June file
const MONEY = '_-" "* #,##0.00_-;\\-" "* #,##0.00_-;_-" "* "-"??_-;_-@_-'
const FIRST_ROW = 3
const SK03_FIRST_ROW = 8

const HEADERS = ["No", "เลขที่บัตรประชาชน", "ชื่อ - สกุล", "หน่วยงาน P4P", "ตำแหน่ง", "ประเภทการจ้าง",
  "ค่าตอบแทนด้านบริหาร", "ค่าตอบแทนตามสัดส่วนวิชาชีพ", "รวมยอดเงินที่จ่าย", "รวมยอดหน่วยงาน", "หมายเหตุ"]
// The June file's widths and header sizes (G..I are narrow, so smaller type).
const WIDTHS = [14.625, 17.75, 31.125, 65.375, 29.375, 24.375, 12.875, 12.875, 12.875, 16.25, 40.75]
const HEAD_SIZES = [16, 16, 16, 16, 16, 16, 10, 10, 12, 16, 16]

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

/** `hex` mixed 60% toward white (a plain RGB mix, not Excel's HSL tint). */
export function tintColor(hex: string, tint = 0.6): string {
  return [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16)
    return Math.round(c + (255 - c) * tint).toString(16).padStart(2, "0")
  }).join("").toUpperCase()
}

/**
 * The pale fill of the No (A) and หน่วยงาน (D) cells. มิ.ย. keeps the June
 * file's own C5E0B4; the other months take a pale shade of their header
 * colour so the two go together.
 */
export function lightColor(month: string): string {
  const k = parseKey(month)
  if (!k) throw new Error("bad month " + month)
  return k.m === 6 ? "C5E0B4" : tintColor(MONTH_COLORS[k.m - 1])
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

type Side = "thin" | "medium" | undefined
const line = (style: Side): Partial<Borders["top"]> | undefined => (style ? { style } : undefined)
function box(left: Side, right: Side, top: Side, bottom: Side): Partial<Borders> {
  const b: Partial<Borders> = {}
  if (left) b.left = line(left) as Borders["left"]
  if (right) b.right = line(right) as Borders["right"]
  if (top) b.top = line(top) as Borders["top"]
  if (bottom) b.bottom = line(bottom) as Borders["bottom"]
  return b
}
const solid = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } })

// Left/right edges per column, as on the June file: heavy lines around No,
// ชื่อ - สกุล and หน่วยงาน, a heavy right edge on หมายเหตุ, thin between the rest.
const EDGES: [Side, Side][] = [
  ["medium", "medium"], [undefined, undefined], ["medium", "medium"], ["medium", "medium"], [undefined, "thin"],
  ["thin", "thin"], ["thin", undefined], ["thin", undefined], ["thin", undefined], ["thin", undefined], ["thin", "medium"],
]
const ALIGN: ("center" | "left")[] = ["center", "center", "left", "center", "left", "left", "center", "center", "center", "center", "left"]

/** The .xlsx, as a Buffer. */
export async function buildAllocationXlsx(month: string, rows: AllocationRow[], ExcelJS: typeof import("exceljs")): Promise<Buffer> {
  const color = "FF" + headerColor(month)
  const tint = "FF" + lightColor(month)
  const id = allocationId(month)
  const wb = new ExcelJS.Workbook()
  wb.creator = "P4P"
  wb.title = (allocationFileName(month) ?? "").replace(/\.xlsx$/, "")
  const ws = wb.addWorksheet(allocationSheetName(month), {
    views: [{ state: "frozen", ySplit: 2, topLeftCell: "A3", showGridLines: false, zoomScale: 90 }],
    pageSetup: {
      paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.118, right: 0.197, top: 0.276, bottom: 0.197, header: 0.315, footer: 0.315 },
      printTitlesRow: "1:2",
    },
  })
  ws.columns = WIDTHS.map((width) => ({ width }))

  ws.mergeCells("A1:K1")
  const title = ws.getCell("A1")
  title.value = allocationTitle(month)
  title.font = { name: FONT, size: 18, bold: true }
  title.alignment = { horizontal: "center", vertical: "middle" }
  ws.getRow(1).height = 24

  const head = ws.getRow(2)
  head.height = 30
  HEADERS.forEach((h, i) => {
    const c = head.getCell(i + 1)
    c.value = h
    c.font = { name: FONT, size: HEAD_SIZES[i], bold: true, color: { argb: HEAD_TEXT } }
    c.fill = solid(color)
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }
    c.border = box(EDGES[i][0], EDGES[i][1], "medium", "medium")
  })

  const last = FIRST_ROW + rows.length - 1
  rows.forEach((p, i) => {
    const r = FIRST_ROW + i
    const row = ws.getRow(r)
    row.height = 21
    const admin = p.admin && p.admin !== 0 ? p.admin : null
    const values: unknown[] = [
      id, null, personName(p), unitName(p.department, p.intern), p.position || null, p.type || null,
      admin, p.pay,
      { formula: `G${r}+H${r}`, result: (admin ?? 0) + (p.pay ?? 0) },
      r === last ? { formula: `SUM(I${FIRST_ROW}:I${last})`, result: rows.reduce((s, x) => s + (x.admin || 0) + (x.pay ?? 0), 0) } : null,
      null,
    ]
    values.forEach((v, j) => {
      const c = row.getCell(j + 1)
      if (v !== null && v !== undefined) c.value = v as never
      const bold = j === 0 || j === 3
      c.font = { name: FONT, size: 16, bold }
      c.alignment = { horizontal: ALIGN[j], vertical: "top", wrapText: true }
      c.border = box(EDGES[j][0], EDGES[j][1], j === 0 ? undefined : "thin", "thin")
      if (j >= 6 && j <= 9) c.numFmt = MONEY
      if (bold) c.fill = solid(tint)
      if (j === 8) c.fill = solid(SUM_FILL)
      if (j === 9 && r === last) c.fill = solid(TOTAL_FILL)
    })
  })

  if (rows.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: last, column: 11 } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
