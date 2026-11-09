/**
 * lib/review-core.ts
 *
 * Pure helpers for the /dashboard/ ตรวจสอบ (review) tab, shared by the nightly
 * build (process/review-build.ts, in GitHub Actions) and the Vercel app
 * (lib/review-server.ts). No network, no dependencies, so the root tests can
 * hold both sides to the same rules (lib/__tests__/review-core.test.mjs).
 *
 *   statedTotal   the total a doctor wrote on their own sheet, read with the
 *                 submission pipeline's rule (lib/p4p-score.ts
 *                 extractScoreFromRows, the rule that put the score in SK03
 *                 K): grand-total label rows, then a free-text summary line,
 *                 then sub-total label rows. Only the passes that read a
 *                 number the doctor wrote: never the pipeline's guesses or
 *                 recalculations, and a total formula with no saved value is
 *                 reported as uncached, not rebuilt from the days.
 *   scoreCheck    SK03 score (staff/intern sheet K) vs that stated total
 *   moneyCheck    staff/intern pay (N) vs the department sheet (F, ตามสัดส่วนวิชาชีพ)
 *   w9Rate        the per P4P written into the intern W9 formula (=W10*rate)
 *   perP4p        per P4P = budget ÷ N, to the satang (what the SQL stores)
 *   scoreFlag     a score of 30,000 or more, or under 2,200: sending waits
 *                 until it is edited (scripts/review-tab-2026-11-auditee.sql)
 */

// Ported from lib/p4p-score.ts (itself a byte-faithful port of
// automation/claude-analyst.ts): the same label lists, number reading and
// passes, so the review checks a doctor's total with the rule that wrote
// their score. Not imported: this file stays dependency-free for both the
// Vercel app and the Actions build. Keep the two in step
// (lib/__tests__/review-core.test.mjs compares them).
const GRAND_TOTAL_LABELS = [
  "รวมแต้มทั้งหมด", "รวมคะแนนทั้งหมด", "รวมทั้งสิ้น", "ยอดรวมทั้งหมด",
  "รวมทั้งหมด", "คะแนนรวมทั้งหมด",
]
const SUBTOTAL_LABELS = ["รวมคะแนน", "รวมแต้ม", "คะแนนรวม", "ผลรวม", "รวม"]
// A header row cell naming the total-points column (p4p-score findScoreColumn).
const SCORE_COLUMN_LABELS = ["รวมแต้ม", "รวมคะแนน", "คะแนนรวม", "แต้มรวม"]

const stripSpace = (s: string): string => s.replace(/\s+/g, "")
const includesLabel = (text: string, label: string): boolean => stripSpace(text).includes(stripSpace(label))

function isYearLike(n: number): boolean {
  if (n >= 1900 && n <= 2099) return true
  if (n >= 2400 && n <= 2699 && Number.isInteger(n)) return true
  return false
}

function toNum(val: unknown): number {
  if (val === null || val === undefined || val === "") return NaN
  if (typeof val === "number") return val
  if (typeof val === "boolean") return NaN
  const s = String(val).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN
  return parseFloat(s.replace(/,/g, ""))
}

function numsFromText(val: unknown, skipYearFilter = false): number[] {
  const s = String(val ?? "").replace(/,/g, "")
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => !isNaN(n) && n > 0 && (skipYearFilter || !isYearLike(n)))
}

// A total typed as text: "รวม = 3260", "คะแนนรวม: 1,940.5", "รวม 3260".
const SUMMARY_LABEL = "(?:รวม|ผลรวม|คะแนนรวม|ยอดรวม)"
const SUMMARY_WITH_SEP = new RegExp(`${SUMMARY_LABEL}[^=:\\d]*[=:]\\s*([\\d,]+(?:\\.\\d+)?)`, "g")
const SUMMARY_BARE = new RegExp(`^${SUMMARY_LABEL}[^\\d]*?\\s+([\\d,]+(?:\\.\\d+)?)$`)

/** 0-based column index → letters (0 → A, 26 → AA). */
function colName(c: number): string {
  let s = ""
  let n = c + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** "E15" for row 14, column 4 (both 0-based). */
function cellName(r: number, c: number): string {
  return colName(c) + String(r + 1)
}

export interface StatedTotal {
  value: number | null
  cell: string | null
  /** grand-total · free-text · sub-total · largest-over-sub-total · uncached · none */
  how: string
}

interface Candidate { n: number; r: number; c: number }

/**
 * The column the sheet's own header row calls its total points, 0-based, or
 * null: the first row with three or more filled cells, none of them a
 * number, one of them exactly (spaces aside) a score-column label.
 */
function findScoreColumn(grid: unknown[][]): number | null {
  for (const row of grid) {
    if (!row) continue
    const entries: [number, unknown][] = []
    row.forEach((v, c) => { if (v !== null && v !== undefined && String(v).trim() !== "") entries.push([c, v]) })
    if (entries.length < 3) continue
    if (entries.some(([, v]) => !isNaN(toNum(v)))) continue
    const hit = entries.find(([, v]) => SCORE_COLUMN_LABELS.some((l) => stripSpace(String(v)) === stripSpace(l)))
    if (hit) return hit[0]
  }
  return null
}

/**
 * The doctor's stated total. `grid[r][c]` is each cell as the submission
 * pipeline reads it (a formula's saved result; null or absent for a formula
 * Excel never saved a value for), 0-based, and may be sparse. `uncached`
 * lists the cells that are formulas with no saved value, so a grand-total
 * row that only holds such a formula is reported as "uncached" instead of
 * falling through to a lesser pass.
 *
 * The passes and what each takes are lib/p4p-score.ts extractScoreFromRows'
 * first three: (1) grand-total label rows, any column: the declared score
 * column's number, else the row's non-year numbers (its year-like ones only
 * when it has no other), plus numbers inside the label cell; (2) a total
 * typed as text; (3) sub-total labels in the first three columns (declared
 * column first), where a bigger number anywhere in the sheet wins, as it
 * does in the pipeline. The largest of a pass is the total; `cell` is where
 * it is (for text, the cell holding the text).
 */
function statedTotal(grid: unknown[][], uncached: Set<string> = new Set()): StatedTotal {
  const best = (cands: Candidate[]): Candidate =>
    cands.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.r > a.r) ? b : a))
  const found = (b: Candidate, how: string): StatedTotal => ({ value: b.n, cell: cellName(b.r, b.c), how })
  const rowNums = (row: unknown[], r: number, skipYearFilter = false): Candidate[] => {
    const out: Candidate[] = []
    row.forEach((v, c) => {
      const n = toNum(v)
      if (!isNaN(n) && n > 0 && (skipYearFilter || !isYearLike(n))) out.push({ n, r, c })
    })
    return out
  }
  const scoreCol = findScoreColumn(grid)
  const declared = (row: unknown[], r: number): Candidate | null => {
    if (scoreCol === null) return null
    const n = toNum(row[scoreCol])
    return !isNaN(n) && n > 0 ? { n, r, c: scoreCol } : null
  }

  // Rows (1-based) holding a formula with no saved value. The grid can be
  // sparse, so this cannot be found by walking a row's cells.
  const uncachedRows = new Set([...uncached].map((n) => /(\d+)$/.exec(n)?.[1]))

  // Pass 1: rows with a grand-total label anywhere in the row.
  const grand: Candidate[] = []
  let grandRowUncached = false
  grid.forEach((row, r) => {
    if (!row) return
    const labels: number[] = []
    row.forEach((v, c) => { if (GRAND_TOTAL_LABELS.some((l) => includesLabel(String(v ?? ""), l))) labels.push(c) })
    if (!labels.length) return
    const d = declared(row, r)
    if (d) { grand.push(d); return }
    const nonYear = rowNums(row, r)
    const nums = nonYear.length ? nonYear : rowNums(row, r, true)
    for (const c of labels) for (const n of numsFromText(row[c], true)) nums.push({ n, r, c })
    if (nums.length) grand.push(...nums)
    else if (uncachedRows.has(String(r + 1))) grandRowUncached = true
  })
  if (grand.length) return found(best(grand), "grand-total")
  if (grandRowUncached) return { value: null, cell: null, how: "uncached" }

  // Pass 2: a total typed as text, in any cell.
  const text: Candidate[] = []
  grid.forEach((row, r) => {
    if (!row) return
    row.forEach((v, c) => {
      if (typeof v !== "string") return
      const s = v.replace(/\s+/g, " ").trim()
      if (!s) return
      const withSep = [...s.matchAll(SUMMARY_WITH_SEP)]
        .map((m) => parseFloat(m[1].replace(/,/g, "")))
        .filter((n) => !isNaN(n) && n > 0)
      if (withSep.length) { for (const n of withSep) text.push({ n, r, c }); return }
      const bare = SUMMARY_BARE.exec(s)
      if (!bare) return
      const n = parseFloat(bare[1].replace(/,/g, ""))
      if (!isNaN(n) && n > 0 && !isYearLike(n)) text.push({ n, r, c })
    })
  })
  if (text.length) return found(best(text), "free-text")

  // Pass 3: sub-total labels in the first three columns.
  const sub: Candidate[] = []
  grid.forEach((row, r) => {
    if (!row) return
    if (![0, 1, 2].some((c) => SUBTOTAL_LABELS.some((l) => includesLabel(String(row[c] ?? ""), l)))) return
    const d = declared(row, r)
    if (d) sub.push(d)
    else sub.push(...rowNums(row, r))
  })
  if (sub.length) {
    const s = best(sub)
    const all: Candidate[] = []
    grid.forEach((row, r) => { if (row) all.push(...rowNums(row, r)) })
    const m = all.length ? best(all) : s
    if (m.n > s.n) return found(m, "largest-over-sub-total")
    return found(s, "sub-total")
  }
  return { value: null, cell: null, how: "none" }
}

type Check = "match" | "mismatch" | "missing"

const cents = (n: number): number => Math.round(n * 100)

function scoreCheck(sk03Score: number | null | undefined, stated: number | null | undefined): Check {
  if (sk03Score == null || stated == null || !isFinite(sk03Score) || !isFinite(stated)) return "missing"
  return cents(sk03Score) === cents(stated) ? "match" : "mismatch"
}

function moneyCheck(sk03Pay: number | null | undefined, deptPay: number | null | undefined): Check {
  if (sk03Pay == null || deptPay == null || !isFinite(sk03Pay) || !isFinite(deptPay)) return "missing"
  return cents(sk03Pay) === cents(deptPay) ? "match" : "mismatch"
}

/** "=W10*9551.81" → 9551.81; anything else → null. */
function w9Rate(formula: unknown): number | null {
  const m = /^=\s*W10\s*\*\s*([0-9]+(?:\.[0-9]+)?)\s*$/i.exec(String(formula ?? "").trim())
  return m ? parseFloat(m[1]) : null
}

/** "2569_10" → { be: 2569, month: 10 } or null. */
function parseMonth(key: unknown): { be: number; month: number } | null {
  const m = /^(\d{4})_(\d{2})$/.exec(String(key ?? ""))
  if (!m) return null
  const month = parseInt(m[2], 10)
  if (month < 1 || month > 12) return null
  return { be: parseInt(m[1], 10), month }
}

/** Budget as typed: up to 2 decimals, commas allowed. */
function parseMoney(v: unknown, max: number): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = parseFloat(s)
  return n > 0 && n < max ? n : null
}

/** N (จำนวนแพทย์) as typed: a whole number from 1, commas allowed. */
function parseCount(v: unknown, max: number): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim()
  if (!/^\d+$/.test(s)) return null
  const n = parseInt(s, 10)
  return n > 0 && n < max ? n : null
}

/** A score as typed in the tab: 0 or more, up to 2 decimals, commas allowed. */
function parseScore(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = parseFloat(s)
  return n < 1e6 ? n : null
}

/**
 * per P4P = budget ÷ N, rounded half up to the satang, in whole satang so
 * no float rounding creeps in: 2,158,709.06 ÷ 226 = 9,551.81. The same
 * number the SQL stores (round(budget / doctors, 2)).
 */
function perP4p(budget: number, doctors: number): number | null {
  if (!(budget > 0) || !Number.isInteger(doctors) || doctors <= 0) return null
  return Math.round(Math.round(budget * 100) / doctors) / 100
}

const SCORE_HIGH = 30000
const SCORE_LOW = 2200
/** "high" from 30,000, "low" under 2,200 (exactly 2,200 is fine), else null. */
function scoreFlag(score: number | null | undefined): "high" | "low" | null {
  if (score === null || score === undefined || !isFinite(score)) return null
  return score >= SCORE_HIGH ? "high" : score < SCORE_LOW ? "low" : null
}

;(module as NodeModule).exports = {
  GRAND_TOTAL_LABELS,
  SUBTOTAL_LABELS,
  colName,
  cellName,
  statedTotal,
  scoreCheck,
  moneyCheck,
  w9Rate,
  parseMonth,
  parseMoney,
  parseCount,
  parseScore,
  perP4p,
  SCORE_HIGH,
  SCORE_LOW,
  scoreFlag,
}
