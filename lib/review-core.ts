/**
 * lib/review-core.ts
 *
 * Pure helpers for the /dashboard/ ตรวจสอบ (review) tab, shared by the nightly
 * build (process/review-build.ts, in GitHub Actions) and the Vercel app
 * (lib/review-server.ts). No network, no dependencies, so the root tests can
 * hold both sides to the same rules (lib/__tests__/review-core.test.mjs).
 *
 *   statedTotal   the total a doctor wrote on their own sheet, read the way
 *                 the submission pipeline reads it (grand-total label rows
 *                 first, then sub-total label rows), from the saved values
 *                 only. Never recalculated: a total formula with no saved
 *                 value is reported as missing, not rebuilt from the days.
 *   scoreCheck    SK03 score (staff/intern sheet K) vs that stated total
 *   moneyCheck    staff/intern pay (N) vs the department sheet (F, ตามสัดส่วนวิชาชีพ)
 *   w9Rate        the per P4P typed into the intern W9 formula (=W10*rate)
 *   uploadMatch   which build, if any, an uploaded file is byte-for-byte
 */

// Same label lists as process/process.ts and automation/claude-analyst.ts.
const GRAND_TOTAL_LABELS = [
  "รวมแต้มทั้งหมด", "รวมคะแนนทั้งหมด", "รวมทั้งสิ้น", "ยอดรวมทั้งหมด",
  "รวมทั้งหมด", "คะแนนรวมทั้งหมด",
]
const SUBTOTAL_LABELS = ["รวมคะแนน", "รวมแต้ม", "คะแนนรวม", "ผลรวม", "รวม"]

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

function numsFromText(val: unknown): number[] {
  const s = String(val ?? "").replace(/,/g, "")
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => !isNaN(n) && n > 0 && !isYearLike(n))
}

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
  /** grand-total · sub-total · largest-over-sub-total · uncached · none */
  how: string
}

interface Candidate { n: number; r: number; c: number }

/**
 * The doctor's stated total. `grid[r][c]` is the saved value of each cell
 * (a formula's cached result; null for a formula Excel never saved a value
 * for), 0-based. `uncached` lists the cells that are formulas with no saved
 * value, so a grand-total row that only holds such a formula is reported as
 * "uncached" instead of falling through to a guess.
 */
function statedTotal(grid: unknown[][], uncached: Set<string> = new Set()): StatedTotal {
  const best = (cands: Candidate[]): Candidate =>
    cands.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.r > a.r) ? b : a))
  const rowNums = (row: unknown[], r: number): Candidate[] => {
    const out: Candidate[] = []
    row.forEach((v, c) => {
      const n = toNum(v)
      if (!isNaN(n) && n > 0 && !isYearLike(n)) out.push({ n, r, c })
    })
    return out
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
    row.forEach((v, c) => { if (GRAND_TOTAL_LABELS.some((l) => String(v ?? "").includes(l))) labels.push(c) })
    if (!labels.length) return
    const nums = rowNums(row, r)
    for (const c of labels) for (const n of numsFromText(row[c])) nums.push({ n, r, c })
    if (nums.length) grand.push(...nums)
    else if (uncachedRows.has(String(r + 1))) grandRowUncached = true
  })
  if (grand.length) {
    const b = best(grand)
    return { value: b.n, cell: cellName(b.r, b.c), how: "grand-total" }
  }
  if (grandRowUncached) return { value: null, cell: null, how: "uncached" }

  // Pass 2: sub-total labels in the first three columns.
  const sub: Candidate[] = []
  grid.forEach((row, r) => {
    if (!row) return
    if (row.slice(0, 3).some((v) => SUBTOTAL_LABELS.some((l) => String(v ?? "").includes(l)))) sub.push(...rowNums(row, r))
  })
  if (sub.length) {
    const s = best(sub)
    const all: Candidate[] = []
    grid.forEach((row, r) => { if (row) all.push(...rowNums(row, r)) })
    const m = best(all)
    if (m.n > s.n) return { value: m.n, cell: cellName(m.r, m.c), how: "largest-over-sub-total" }
    return { value: s.n, cell: cellName(s.r, s.c), how: "sub-total" }
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

export interface BuildFiles {
  id: string
  built_at: string
  sk03_sha256: string
  merged_sha256: string
}

/**
 * Which build an uploaded file is, by its SHA-256. `builds` newest first.
 * latest: the newest build's file of that kind · older: an earlier build's ·
 * other_kind: the other file of some build (SK03 picked as the merged file,
 * or the reverse) · unknown: not a file the system built (edited, or from
 * somewhere else).
 */
function uploadMatch(kind: "sk03" | "merged", sha: string, builds: BuildFiles[]):
  { result: "latest" | "older" | "other_kind" | "unknown"; build: BuildFiles | null } {
  const own = (b: BuildFiles): string => (kind === "sk03" ? b.sk03_sha256 : b.merged_sha256)
  const other = (b: BuildFiles): string => (kind === "sk03" ? b.merged_sha256 : b.sk03_sha256)
  const i = builds.findIndex((b) => own(b) === sha)
  if (i === 0) return { result: "latest", build: builds[0] }
  if (i > 0) return { result: "older", build: builds[i] }
  const j = builds.find((b) => other(b) === sha)
  if (j) return { result: "other_kind", build: j }
  return { result: "unknown", build: null }
}

/** "2569_10" → { be: 2569, month: 10 } or null. */
function parseMonth(key: unknown): { be: number; month: number } | null {
  const m = /^(\d{4})_(\d{2})$/.exec(String(key ?? ""))
  if (!m) return null
  const month = parseInt(m[2], 10)
  if (month < 1 || month > 12) return null
  return { be: parseInt(m[1], 10), month }
}

/** Budget and per P4P as typed: up to 2 decimals, commas allowed. */
function parseMoney(v: unknown, max: number): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = parseFloat(s)
  return n > 0 && n < max ? n : null
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
  uploadMatch,
  parseMonth,
  parseMoney,
}
