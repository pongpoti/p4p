/**
 * lib/alloc-ids.ts
 *
 * เอกสารจัดสรร (Pong, 2026-11-18): the hospital sends, for each month and in
 * advance, its list of everyone paid that month. Its first column, No, is
 * "ID-<yy>-<MM>-<4 digits>" (sheet "เดือนกรกฎาคม 2569": row 2 the headers
 * No | ชื่อสกุล | หน่วยงาน P4P | ตำแหน่ง | ..., one person a row from row 3).
 * The owner uploads it from the month card's ข้อมูล button; the app keeps
 * only the 4 digits of each doctor in the month's roster, and the
 * allocation sheet (lib/allocation-xlsx.ts) writes them after
 * "ID-<yy>-<MM>-" in its No column.
 *
 * The file has the whole hospital (about 2,500 people) and other sheets,
 * hidden ones with ID card numbers among them. Only the rows of the
 * month's own No are read, only the name, unit and position of each, and
 * the file is never stored.
 *
 * Matching (Pong: the roster is a subset of the sheet; ignore the rest):
 * the sheet writes a name as "<title><first>  <last>" (นาย, นาง, นางสาว,
 * ranks such as ว่าที่ร้อยตรี or ร.ต.ท.หญิง), the roster has prefix
 * (นพ./พญ.), firstname and lastname apart. A roster person matches a sheet
 * row when the last names are the same and the sheet's first word is a
 * title followed by the first name, spaces ignored. Two or more rows for
 * one person: the doctors' ones (หน่วยงาน P4P องค์กรแพทย์, or a ตำแหน่ง
 * with แพทย์ that is not แพทย์แผนไทย) are kept; if they still disagree on
 * the digits the person is ambiguous and gets none.
 *
 * No network here: lib/review-server.ts reads the roster, saves the result
 * and answers the page; lib/__tests__/alloc-ids.test.mjs checks it.
 */

import type { Workbook, Worksheet } from "exceljs"

export interface SheetRow {
  no4: string
  name: string
  unit: string
  position: string
}

export interface RosterPerson {
  index: string
  prefix?: string | null
  firstname?: string | null
  lastname?: string | null
  department?: string | null
}

export interface MatchResult {
  /** how: exact (same name), close (a doctor's row spelled 1-2 letters apart). */
  matched: { index: string; no4: string; how: "exact" | "close" }[]
  /** Close matches, both spellings, for the page to show. */
  close: { index: string; name: string; sheetName: string; no4: string }[]
  /** Not found; suggest: the one unused doctor's row with the same first or last name. */
  missing: { index: string; name: string; department: string; suggest: { no4: string; sheetName: string } | null }[]
  ambiguous: { index: string; name: string; department: string; nos: string[] }[]
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

/**
 * Thai text as compared: NFC, no zero-width characters, nikhahit + sara aa
 * written as sara am, every run of spaces one space, trimmed.
 */
export function normThai(v: unknown): string {
  const x = cellValue(v)
  if (x === null || x === undefined) return ""
  return String(x).normalize("NFC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/ํา/g, "ำ")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
}
const squeeze = (s: string): string => normThai(s).replace(/ /g, "")

const TITLES = new Set(["", "นาย", "นาง", "นางสาว", "น.ส.", "นพ.", "พญ.", "นายแพทย์", "แพทย์หญิง", "ดร.", "mr.", "mrs.", "ms.", "miss"])

/**
 * Whether what comes before the first name on the sheet is a title: one of
 * the common ones, an abbreviated rank (ร.ต., พ.ต.ท.หญิง), or a rank
 * written out (ว่าที่ร้อยตรี, ร้อยตำรวจเอกหญิง, จ่าสิบเอก, ...).
 */
export function isTitle(p: string): boolean {
  const t = p.replace(/ /g, "").toLowerCase()
  if (TITLES.has(t)) return true
  if (/^(ว่าที่)?([ก-ฮ]{1,3}\.){1,4}(หญิง)?(นาย|นาง|นางสาว)?$/.test(t)) return true
  if (/^(ว่าที่)?(ร้อย|พัน|นาวา|เรือ|จ่า|สิบ|พล|พันจ่า|นาย)(ตรี|โท|เอก|ตำรวจ|อากาศ|เรือ|จัตวา|ตรีหญิง|โทหญิง|เอกหญิง)*(หญิง)?$/.test(t) && t.length > 3) return true
  return false
}

/** "2569_07" → "69-07", the part of No between "ID-" and the digits. */
export function idMonth(month: string): string | null {
  const m = /^(\d{4})_(\d{2})$/.exec(month)
  return m ? m[1].slice(2) + "-" + m[2] : null
}

const NO_RE = /^ID-(\d{2})-(\d{2})-(\d{4})$/

interface Found { ws: Worksheet; head: number; cols: { no: number; name: number; unit: number; position: number } }

/** Each sheet's header row (A is "No", a column with ชื่อ) in its first 10 rows. */
function headerOf(ws: Worksheet): Found | null {
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r)
    if (normThai(row.getCell(1).value).toLowerCase() !== "no") continue
    const cols = { no: 1, name: 0, unit: 0, position: 0 }
    for (let c = 2; c <= Math.min(30, Math.max(ws.columnCount, 2)); c++) {
      const h = squeeze(normThai(row.getCell(c).value))
      if (!cols.name && h.startsWith("ชื่อ")) cols.name = c
      else if (h === "หน่วยงานP4P") cols.unit = c
      else if (!cols.position && h === "ตำแหน่ง") cols.position = c
    }
    if (cols.name) return { ws, head: r, cols }
  }
  return null
}

export type ReadResult =
  | { ok: true; sheet: string; rows: SheetRow[]; other: number }
  | { ok: false; error: "no_sheet" }
  | { ok: false; error: "wrong_month"; found: string | null }

/**
 * The month's rows of the uploaded file: from the sheet (visible ones
 * first) with the most No of this month. `other` counts rows whose No is
 * of another month (left out). wrong_month: no row of this month, with the
 * month most rows have ("69-05"), if any.
 */
export function readAllocSheet(wb: Workbook, month: string): ReadResult {
  const want = idMonth(month)
  const sheets = [...wb.worksheets].sort((a, b) => Number(a.state !== "visible") - Number(b.state !== "visible"))
  let best: { f: Found; rows: SheetRow[]; other: number } | null = null
  const elsewhere = new Map<string, number>()
  let anySheet = false
  for (const ws of sheets) {
    const f = headerOf(ws)
    if (!f) continue
    anySheet = true
    const rows: SheetRow[] = []
    let other = 0
    for (let r = f.head + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const m = NO_RE.exec(normThai(row.getCell(f.cols.no).value).replace(/ /g, ""))
      if (!m) continue
      if (m[1] + "-" + m[2] !== want) { other++; elsewhere.set(m[1] + "-" + m[2], (elsewhere.get(m[1] + "-" + m[2]) || 0) + 1); continue }
      rows.push({
        no4: m[3],
        name: normThai(row.getCell(f.cols.name).value),
        unit: f.cols.unit ? normThai(row.getCell(f.cols.unit).value) : "",
        position: f.cols.position ? normThai(row.getCell(f.cols.position).value) : "",
      })
    }
    if (rows.length && (!best || rows.length > best.rows.length)) best = { f, rows, other }
  }
  if (best) return { ok: true, sheet: best.f.ws.name, rows: best.rows, other: best.other }
  if (!anySheet) return { ok: false, error: "no_sheet" }
  const found = [...elsewhere].sort((a, b) => b[1] - a[1])[0]
  return { ok: false, error: "wrong_month", found: found ? found[0] : null }
}

/** A doctor's row on the sheet: the medical staff unit, or a doctor's post. */
const isDoctorRow = (r: SheetRow): boolean =>
  r.unit.startsWith("องค์กรแพทย์") || (/แพทย์/.test(r.position) && !/แผนไทย/.test(r.position))

/** "นพ.สมชาย  ใจดี" as the roster writes it, for the lists on the page. */
export const rosterName = (p: RosterPerson): string =>
  ((normThai(p.prefix) + normThai(p.firstname)) + " " + normThai(p.lastname)).trim()

// A Thai vowel or tone mark cannot begin a name: "นางสาวิตรี" is นาง + สาวิตรี.
const MARK_START = /^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/

/** The sheet's first word without its title: the longest title that leaves a name. */
export function stripTitle(word: string): string {
  for (let k = word.length - 1; k >= 0; k--) {
    const rest = word.slice(k)
    if (isTitle(word.slice(0, k)) && rest && !MARK_START.test(rest)) return rest
  }
  return word
}

/** Letters to add, drop or change to turn a into b. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b)
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[y.length]
}

/** Each roster person's 4 digits from the sheet's rows (see the top). */
export function matchRoster(rows: SheetRow[], roster: RosterPerson[]): MatchResult {
  // The sheet by last name, spaces ignored, so each person looks at a few rows.
  const byLast = new Map<string, { first: string; whole: string; row: SheetRow }[]>()
  const wholeRows: { whole: string; row: SheetRow }[] = []
  // The doctors' rows with the name in two parts, for the second pass.
  const doctorRows: { first: string; last: string; row: SheetRow }[] = []
  for (const row of rows) {
    const parts = row.name.split(" ")
    const whole = squeeze(row.name)
    wholeRows.push({ whole, row })
    if (parts.length < 2) continue
    const last = parts.slice(1).join("")
    const list = byLast.get(last) || []
    list.push({ first: parts[0], whole, row })
    byLast.set(last, list)
    if (isDoctorRow(row)) doctorRows.push({ first: stripTitle(parts[0]), last, row })
  }
  const out: MatchResult = { matched: [], close: [], missing: [], ambiguous: [] }
  const used = new Set<SheetRow>()
  const left: { p: RosterPerson; first: string; last: string; name: string; department: string }[] = []
  for (const p of roster) {
    const first = squeeze(normThai(p.firstname))
    const last = squeeze(normThai(p.lastname))
    const name = rosterName(p)
    const department = normThai(p.department)
    if (!first || !last) { out.missing.push({ index: p.index, name, department, suggest: null }); continue }
    let hits = (byLast.get(last) || [])
      .filter((x) => x.first.endsWith(first) && isTitle(x.first.slice(0, x.first.length - first.length)))
      .map((x) => x.row)
    // Spaces in other places (none between the names, or inside a last
    // name): the whole name, spaces ignored, is a title then first + last.
    if (!hits.length) {
      const fl = first + last
      hits = wholeRows.filter((x) => x.whole.endsWith(fl) && isTitle(x.whole.slice(0, x.whole.length - fl.length))).map((x) => x.row)
    }
    if (hits.length > 1) {
      const doctors = hits.filter(isDoctorRow)
      if (doctors.length) hits = doctors
    }
    const nos = [...new Set(hits.map((h) => h.no4))]
    if (nos.length === 1) {
      out.matched.push({ index: p.index, no4: nos[0], how: "exact" })
      for (const h of hits) used.add(h)
    } else if (nos.length > 1) out.ambiguous.push({ index: p.index, name, department, nos: nos.sort() })
    else left.push({ p, first, last, name, department })
  }
  // Second pass, doctors' rows nobody took: a spelling 1-2 letters apart
  // (ฎ for ฏ, a dropped า; one letter when a name is under 4 letters) is
  // taken when one row is clearly nearest; otherwise the one row with the
  // same first name, or the same last name, is offered on the page.
  for (const x of left) {
    const free = doctorRows.filter((d) => !used.has(d.row))
    const scored = free.map((d) => ({ d, n: editDistance(x.first, d.first) + editDistance(x.last, d.last) })).sort((a, b) => a.n - b.n)
    const best = scored[0]
    const limit = Math.min(x.first.length, x.last.length) < 4 ? 1 : 2
    if (best && best.n <= limit && (scored.length < 2 || scored[1].n > best.n)) {
      used.add(best.d.row)
      out.matched.push({ index: x.p.index, no4: best.d.row.no4, how: "close" })
      out.close.push({ index: x.p.index, name: x.name, sheetName: best.d.row.name, no4: best.d.row.no4 })
      continue
    }
    const sameFirst = free.filter((d) => d.first === x.first)
    const sameLast = free.filter((d) => d.last === x.last)
    const one = sameFirst.length === 1 ? sameFirst[0] : sameLast.length === 1 ? sameLast[0] : null
    out.missing.push({ index: x.p.index, name: x.name, department: x.department, suggest: one ? { no4: one.row.no4, sheetName: one.row.name } : null })
  }
  return out
}
