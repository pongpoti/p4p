/**
 * sheet-rescue.ts
 *
 * The hospital's intern template ships TWO filled tabs: the report itself and a
 * worked-example tab ("Ex-<name>") frozen at one fixed period, identical in
 * every sender's file. firstSheetToRows counts the example as a second report,
 * so when the report's own title row names no month (an unfilled template
 * placeholder) the workbook looks like "two tabs, none identify the month" and
 * the email path refuses it as month_not_found — although the sender said the
 * month in the subject AND in the file's name.
 *
 * This reads such a workbook as the one-report file it is, under rules that
 * only ever turn a refusal into an acceptance when the file's own name
 * confirms the month — never when the file is merely silent:
 *
 *   • the other tab must call itself an example (its NAME says so) AND state a
 *     period of its own in its title, so it is documentation, not a report;
 *   • exactly one tab remains;
 *   • that tab does not say another month/year anywhere in its name or opening
 *     rows — read PERMISSIVELY (any other month word, numeric date or different
 *     year, glued or not): a stale title and a wrong attachment look the same
 *     from the file alone, so a contradiction keeps the refusal;
 *   • the FILENAME names the target month (and does not name another year):
 *     positive evidence, because every reader here has blind spots and "no
 *     contradiction detected" is not the same as "the month is right".
 *
 * Pure: index.ts supplies the per-tab facts and does the re-read.
 */

import { periodsInText, resolveBeYear } from "./claude-analyst.js";
import { periodsInFilenameLoose, latinMonthsIn, thaiMonthsIn, toArabicDigits, plainText, yearsAfterMonthToken, shortYear } from "./period-gate.js";
import type { MonthYear } from "./types.js";

export interface TabInfo {
  name: string;
  /** Holds 3+ non-empty cells — the only tabs a report could be on. */
  filled: boolean;
  /** sheetMatchScore against the target month/year; 0 = does not identify it. */
  score: number;
  /** The month/year the tab NAME states, if any. */
  nameHit: MonthYear;
  /** The first month/year the tab's opening rows state, if any. */
  titleHit: MonthYear;
  /** The text of the tab's opening rows (see titleTextOf in index.ts) — scanned permissively by the veto below. */
  titleText: string;
  /** Shown in Excel. A hidden or very-hidden tab is machinery, never "the report". */
  visible: boolean;
}

// "Ex-Name", "Ex_1", "Ex 2", "Ex", "Example 1", "Sample", "ตัวอย่าง…". Not "Excel", not "Exp".
const EXAMPLE_NAME_RE = /^\s*(?:ex(?:$|[\s._-])|example\b|sample\b|ตัวอย่าง)/i;

export function isExampleTabName(name: string): boolean {
  return EXAMPLE_NAME_RE.test(name);
}

const NUMERIC_DATE_RE = /(?<!\d)(?:0?[1-9]|1[0-2])\s*[/.\-]\s*(?:25\d{2}|20\d{2}|\d{2})(?!\d)|(?<!\d)\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4}(?!\d)/;
// A Date cell reaches us as an ISO timestamp ("2026-08-03T00:00:00.000Z").
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
// "month 7", "เดือนที่ 7", "ประจำเดือน 07": a month given as a number (matched with whitespace removed).
const MONTH_NUMBER_RE = /(?:เดือน(?:ที่)?|months?|mth)[\s:.\-]{0,3}(\d{1,2})(?!\d)/gi;
// "ปี 68", "พ.ศ. 69", "year 25": a year given as two digits.
const SHORT_YEAR_LABEL_RE = /(?:ปี|พ\.?ศ\.?|ค\.?ศ\.?|year)\.?(\d{2})(?!\d)/gi;
// A report for a quarter or half-year is not a monthly report at all.
const NOT_MONTHLY_RE = /ไตรมาส|ครึ่งปี|quarter|half[\s-]?year|(?<![A-Za-z])Q[1-4](?![A-Za-z0-9])/i;

/**
 * Whether a report tab's name or opening rows say ANYTHING that disagrees with the target period, read
 * permissively: any other month word (Thai by substring with whitespace ignored, so "ก. ค. 68", "กรกฎา",
 * "กค68" all count; any Latin month word), a month given as a number, a two-digit year after a month or a
 * "ปี" label, a quarter, any numeric date, any four-digit year other than the target's — in Thai or
 * Arabic digits. A Date cell is read as the date it is: it vetoes only when it falls outside the target
 * month. Anything the strict readers missed ends up here, so this errs towards vetoing; a veto only ever
 * keeps the refusal.
 */
export function reportSaysAnotherPeriod(text: string, targetMonth: number, targetYear: number | null): boolean {
  let t = toArabicDigits(plainText(text));

  let dateOutside = false;
  t = t.replace(ISO_DATE_RE, (_all, y: string, mo: string) => {
    if (parseInt(mo, 10) !== targetMonth || (targetYear !== null && parseInt(y, 10) + 543 !== targetYear)) dateOutside = true;
    return " ";
  });
  if (dateOutside) return true;

  if (thaiMonthsIn(t).some((m) => m !== targetMonth)) return true;
  if (latinMonthsIn(t).some((m) => m !== targetMonth)) return true;
  const tight = t.replace(/\s+/g, "");
  for (const m of t.matchAll(MONTH_NUMBER_RE)) {
    if (parseInt(m[1]!, 10) !== targetMonth) return true;
  }
  if (NOT_MONTHLY_RE.test(t)) return true;
  if (NUMERIC_DATE_RE.test(t)) return true;
  // day/month with no year ("30/07"): a different month vetoes
  for (const m of t.matchAll(/(?<![\d/])([0-3]?\d)\s*\/\s*(0?[1-9]|1[0-2])(?![\d/])/g)) {
    if (parseInt(m[2]!, 10) !== targetMonth) return true;
  }
  // Year first: "2568-07", "2025/07", "256807", "202507".
  for (const m of t.matchAll(/(?<!\d)(25\d{2}|20\d{2})[-/.]?(0[1-9]|1[0-2])(?!\d)/g)) {
    const y = parseInt(m[1]!, 10);
    if (parseInt(m[2]!, 10) !== targetMonth || (targetYear !== null && (y >= 2500 ? y : y + 543) !== targetYear)) return true;
  }
  if (targetYear !== null) {
    const years = [
      ...[...t.matchAll(/(?<!\d)(25\d{2}|20\d{2})(?!\d)/g)].map((m) => { const y = parseInt(m[1]!, 10); return y >= 2500 ? y : y + 543; }),
      ...yearsAfterMonthToken(t),
      ...[...tight.matchAll(SHORT_YEAR_LABEL_RE)].map((m) => shortYear(m[1]!)),
    ];
    if (years.some((y) => y !== targetYear)) return true;
  }
  return false;
}

function contradicts(hit: MonthYear, targetMonth: number, targetYear: number | null): boolean {
  if (hit.month === null) return false;
  if (hit.month !== targetMonth) return true;
  return hit.beYear !== null && targetYear !== null && hit.beYear !== targetYear;
}

/** True when the filename names the target month, once, and no other year. */
export function filenameConfirms(filename: string, targetMonth: number, targetYear: number | null): boolean {
  // The strict reader first; a Latin month word beside an underscore or digit only when it found nothing.
  let named = periodsInText(filename);
  if (named.length === 0) named = periodsInFilenameLoose(filename);
  if (named.length !== 1) return false;
  const p = named[0]!;
  if (p.month !== targetMonth) return false;
  if (p.beYear !== null && targetYear !== null && p.beYear !== targetYear) return false;
  // A two-digit year ("ส.ค.68") is too loose to route on but plenty to REFUSE on.
  const short = resolveBeYear(filename, "", "");
  if (short !== null && targetYear !== null && short !== targetYear) return false;
  return true;
}

/**
 * The name of the tab to read when `tabs` is one report plus example tab(s),
 * or null (keep the refusal / nothing to do).
 */
export function pickReportBesideExample(args: {
  tabs: TabInfo[];
  matched: boolean;
  targetMonth: number;
  targetYear: number | null;
  filename: string;
}): string | null {
  const { tabs, matched, targetMonth, targetYear, filename } = args;
  if (matched) return null;                                   // a tab already identifies the month

  const filled = tabs.filter((t) => t.filled);
  if (filled.length < 2) return null;

  const isExample = (t: TabInfo) => t.score === 0 && isExampleTabName(t.name) && t.titleHit.month !== null;
  const examples   = filled.filter(isExample);
  const candidates = filled.filter((t) => !isExample(t));
  if (examples.length === 0 || candidates.length !== 1) return null;

  const report = candidates[0]!;
  // A tab that calls itself an example is documentation even when its title states no period, and a hidden
  // one is never the report.
  if (isExampleTabName(report.name) || !report.visible) return null;
  if (contradicts(report.nameHit, targetMonth, targetYear)) return null;
  if (contradicts(report.titleHit, targetMonth, targetYear)) return null;
  if (reportSaysAnotherPeriod(`${report.name}\n${report.titleText}`, targetMonth, targetYear)) return null;
  if (!filenameConfirms(filename, targetMonth, targetYear)) return null;

  return report.name;
}
