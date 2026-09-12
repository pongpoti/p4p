/**
 * bangkok-date.js
 *
 * Shared Asia/Bangkok-safe date helpers.
 *
 * GitHub Actions runners run in UTC. Any cron job scheduled around a Bangkok
 * day/month boundary (e.g. "01:00 Asia/Bangkok on the 1st" is 18:00 UTC on
 * the LAST day of the previous month) must never derive "today"/"this month"
 * from a raw `new Date()` + getFullYear()/getMonth()/getDate() — those read
 * the HOST's local time (UTC on Actions runners), not Bangkok's, and will
 * resolve to the wrong day/month right at that boundary.
 *
 * This was previously reimplemented independently (and inconsistently) in
 * provision-next-month.mjs, score-tracker.mjs, resend-month.mjs, and
 * send-test-email.mjs — the latter three used raw `new Date()` and were
 * exposed to exactly the boundary bug this module exists to avoid. All four
 * now share this one implementation.
 */

const TH_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
  "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

export interface BangkokDate {
  ceYear: number;
  month: number;
  day: number;
}

export interface BangkokYearMonth {
  ceYear: number;
  month: number;
}

/**
 * "Now" in Asia/Bangkok (UTC+7, no DST), independent of the host timezone.
 * @param date defaults to the current instant.
 * @returns month/day are 1-based.
 */
export function bangkokNow(date: Date = new Date()): BangkokDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    ceYear: Number(parts.find((p) => p.type === "year")!.value),
    month : Number(parts.find((p) => p.type === "month")!.value),
    day   : Number(parts.find((p) => p.type === "day")!.value),
  };
}

/** Year/month only — kept as a separate export for callers that don't need the day. */
export function bangkokYearMonth(date: Date = new Date()): BangkokYearMonth {
  const { ceYear, month } = bangkokNow(date);
  return { ceYear, month };
}

/** Build a "BEYEAR_MM" key from a CE year + month (1–12). */
export function monthKey(ceYear: number, month: number): string {
  return `${ceYear + 543}_${String(month).padStart(2, "0")}`;
}

/** "<day> <Thai month> <BE year>" for the current Bangkok date, e.g. "5 กรกฎาคม 2569". */
export function todayThaiStr(date: Date = new Date()): string {
  const { ceYear, month, day } = bangkokNow(date);
  return `${day} ${TH_MONTHS[month]} ${ceYear + 543}`;
}
