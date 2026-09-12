/**
 * Month keys, Buddhist-Era conversion, the month windows each page shows, and
 * submission deadlines.
 *
 * Ported from list/app.js, ranking/app.js, status/app.js and
 * ../../src/constants.ts, which each had their own partial copy of this.
 *
 * A "month key" is the name of a Supabase roster table: `BBBB_MM`, where BBBB
 * is a Buddhist-Era year and MM is a zero-padded 1-based month — e.g. 2569_04.
 */

/** Full Thai month names, index 0 = January. */
export const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
] as const

/** Abbreviated Thai month names, index 0 = January. */
export const THAI_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
] as const

export const BANGKOK_TZ = "Asia/Bangkok"

/**
 * Oldest month with a roster table. The ranking page walks backwards from the
 * current month and stops here rather than generating tabs for months that
 * never existed.
 */
export const EARLIEST_MONTH_KEY = "2569_04"

/** Gregorian year -> Buddhist Era. */
export function toBE(gregorianYear: number): number {
  return gregorianYear + 543
}

/** Buddhist Era -> Gregorian year. */
export function toGregorian(beYear: number): number {
  return beYear - 543
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** Build a month key from a BE year and a 1-based month. */
export function monthKey(beYear: number, month: number): string {
  return `${beYear}_${pad2(month)}`
}

/**
 * Is this a syntactically valid month key?
 *
 * status/app.js took `?sheetname=` straight off the URL and passed it to
 * `db.from()` with no check at all. Row Level Security is what actually keeps
 * the data safe, but an unvalidated identifier flowing from a query string into
 * a table name is not something to leave in place during a rewrite.
 * See ../../REACT_REWRITE_PLAN.md §8.
 */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}_(0[1-9]|1[0-2])$/.test(value)
}

export interface ParsedMonth {
  readonly beYear: number
  readonly month: number
}

/** Parse a month key, or null if it is not one. */
export function parseMonthKey(key: unknown): ParsedMonth | null {
  if (!isMonthKey(key)) return null
  const [beStr, moStr] = key.split("_") as [string, string]
  return { beYear: Number(beStr), month: Number(moStr) }
}

/** "มีนาคม 2569" */
export function thaiLabel(beYear: number, month: number): string {
  return `${THAI_MONTHS[month - 1] ?? ""} ${beYear}`.trim()
}

/** "มี.ค. 2569" */
export function thaiLabelShort(beYear: number, month: number): string {
  return `${THAI_MONTHS_SHORT[month - 1] ?? ""} ${beYear}`.trim()
}

/** "มีนาคม 2569" from a key, or null if the key is invalid. */
export function thaiLabelFromKey(key: unknown): string | null {
  const parsed = parseMonthKey(key)
  return parsed ? thaiLabel(parsed.beYear, parsed.month) : null
}

/**
 * The `count` most recent months, newest first, as month keys.
 *
 * Drives the /list/ month picker (6) and matches MONTH_ITERATOR in
 * src/constants.ts, which the LINE Flex month picker uses (also 6).
 */
export function recentMonthKeys(count: number, now: Date = new Date()): string[] {
  const keys: string[] = []
  let year = now.getFullYear()
  let month = now.getMonth() + 1 // 1-based

  for (let i = 0; i < count; i++) {
    keys.push(monthKey(toBE(year), month))
    month--
    if (month === 0) {
      month = 12
      year--
    }
  }
  return keys
}

export interface RankingMonth {
  readonly key: string
  /** Tab caption, e.g. "มี.ค. 2569". */
  readonly label: string
  /** True for the current month, whose submission window is still open. */
  readonly current: boolean
}

/**
 * Month tabs for /ranking/: newest first, at most `max`, stopping at
 * EARLIEST_MONTH_KEY.
 */
export function rankingMonths(now: Date = new Date(), max = 24): RankingMonth[] {
  const result: RankingMonth[] = []
  let year = now.getFullYear()
  let monthIndex = now.getMonth() // 0-based

  while (result.length < max) {
    const beYear = toBE(year)
    const key = monthKey(beYear, monthIndex + 1)
    result.push({
      key,
      label: thaiLabelShort(beYear, monthIndex + 1),
      current: result.length === 0,
    })
    if (key === EARLIEST_MONTH_KEY) break
    if (monthIndex-- === 0) {
      monthIndex = 11
      year--
    }
  }
  return result
}

/**
 * Submission deadline for a month: the 10th of the FOLLOWING month, 23:59:59
 * Bangkok time. The ranking page counts only submissions at or before this.
 */
export function deadlineISO(key: string): string {
  const parsed = parseMonthKey(key)
  if (!parsed) throw new Error(`deadlineISO: not a month key: ${String(key)}`)
  const ceYear = toGregorian(parsed.beYear)
  const nextMonth = parsed.month === 12 ? 1 : parsed.month + 1
  const nextYear = parsed.month === 12 ? ceYear + 1 : ceYear
  return `${nextYear}-${pad2(nextMonth)}-10T23:59:59+07:00`
}

/**
 * Render a submission timestamp as "5 ส.ค. · 14:32", always in Bangkok time.
 *
 * ranking/app.js used getDate()/getHours(), which read the DEVICE's timezone.
 * Every user is in Thailand so it is usually right, but a phone set to another
 * zone silently showed wrong times on a page whose whole purpose is ordering by
 * submission time. See ../../REACT_REWRITE_PLAN.md §8.
 */
export function formatBangkokTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TZ,
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    // h23 rather than hour12:false — the latter can yield "24" for midnight in
    // some ICU builds.
    hourCycle: "h23",
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ""

  // The day is unpadded ("5 ส.ค."), matching the original getDate(). Asking
  // Intl for `day: "numeric"` is not enough: requesting `hour: "2-digit"` in
  // the same formatter makes en-GB pad the day too ("05"), so strip it here
  // rather than trusting the locale's pattern.
  const day = String(Number(get("day")))
  const monthName = THAI_MONTHS_SHORT[Number(get("month")) - 1] ?? ""
  return `${day} ${monthName} · ${get("hour")}:${get("minute")}`
}
