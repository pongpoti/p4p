/**
 * period-gate.ts
 *
 * The email path's answer to "which month is this submission for?", as ONE
 * pure decision (decideStatedPeriod) that processBuffer calls and logs.
 *
 * The structure is the point. The decision first runs exactly what the
 * processor has always done (decideStrict). If that ACCEPTS, it is the answer —
 * nothing below can change an outcome that was already an acceptance. Only when
 * the strict rules REFUSE are two further readings tried, each a pure function
 * of what the sender wrote and never of a workbook's contents:
 *
 *   1. collapseYearlessPeriods — "กันยายน" in the subject and "กันยายน 2569" in
 *      the body is ONE period, September 2569, not two.
 *   2. a Latin month word in a filename ("P4P-Intern_sep_<name>.xlsx"), for a
 *      multi-month mail with several workbooks, where each file has to say which
 *      month is its own and the strict reader (word boundaries; "_" is not one)
 *      could not see it.
 *
 * The invariant these keep is the one processBuffer states: the processor never
 * GUESSES a period. Every rule either reads something written down or leaves the
 * refusal exactly as it was; every unmet condition falls back to the refusal.
 */

import { periodsInText, resolveBeYear } from "./claude-analyst.js";
import { bangkokNow } from "./bangkok-date.js";
import type { Period, StatedPeriods } from "./types.js";

// ── When the mail was sent ────────────────────────────────────────────────

export interface SendDate {
  /** Buddhist-era year, Asia/Bangkok. */
  beYear: number;
  /** 1–12, Asia/Bangkok. */
  month: number;
}

/**
 * The Bangkok send date of a mail, or null when the Date header is missing or
 * unparseable. It only ever VETOES or supplies a year that no text gave — it
 * never chooses a month.
 */
export function sendDate(emailDate: string | null | undefined): SendDate | null {
  if (!emailDate) return null;
  const d = new Date(emailDate);
  if (Number.isNaN(d.getTime())) return null;
  const { ceYear, month } = bangkokNow(d);
  return { beYear: ceYear + 543, month };
}

/**
 * Whether a month/year can be what a mail sent on `send` is reporting: this
 * year's month at or before the send month, or — a December report sent in
 * January — LAST year's month after it. Last September's mail quoted in a reply,
 * or a month that has not happened yet, is neither.
 */
export function plausibleYear(month: number, beYear: number, send: SendDate): boolean {
  return (beYear === send.beYear && month <= send.month)
      || (beYear === send.beYear - 1 && month > send.month);
}

// ── 1. The same month, with and without a year ────────────────────────────

/** Thai (๐-๙), full-width (０-９) and Arabic-Indic (٠-٩ ۰-۹) digits -> 0-9, so a year written in them is still seen as a year. */
export function toArabicDigits(s: string): string {
  return s
    .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

// ── Month words, read by SUBSTRING ────────────────────────────────────────
// The strict reader (claude-analyst) needs word boundaries, which Thai does not have and "_" is not.
// These tables are for the places that only ever VETO or refuse on what they find, so a month glued to
// other letters ("เดือนกรกฎาคมพ.ศ.2569", "ผลงานกรกฎาคม_aug") is exactly what they must still see. The dotted
// abbreviations are listed WITHOUT the final dot; truncated names ("กรกฎา") count; the two-consonant
// abbreviations sit inside ordinary words, so they count only when a digit follows ("กค68").
export const THAI_MONTH_WORDS: [number, string[]][] = [
  [1, ["มกรา", "ม.ค"]], [2, ["กุมภา", "ก.พ"]], [3, ["มีนา", "มี.ค"]],
  [4, ["เมษา", "เมศา", "เม.ย"]], [5, ["พฤษภา", "พฤศภา", "พ.ค"]], [6, ["มิถุนา", "มิ.ย"]],
  [7, ["กรกฎา", "กรกฏา", "กรกฎ", "กรกฏ", "ก.ค"]], [8, ["สิงหา", "ส.ค"]], [9, ["กันยา", "ก.ย"]],
  [10, ["ตุลาค", "ต.ค"]], [11, ["พฤศจิกา", "พฤษจิกา", "พ.ย"]], [12, ["ธันวา", "ธ.ค"]],
];
const THAI_GLUED_ABBREV: [number, string][] = [
  [1, "มค"], [2, "กพ"], [3, "มีค"], [4, "เมย"], [5, "พค"], [6, "มิย"],
  [7, "กค"], [8, "สค"], [9, "กย"], [10, "ตค"], [11, "พย"], [12, "ธค"],
];

/** Invisible and bidi marks that can hide inside a word ("ปี" + U+200B + "ที่แล้ว"). */
const INVISIBLE_RE = /[\p{Cf}\u034F\u180E\uFE0F]/gu;

/** Runs of horizontal whitespace -> one space. Keeps every regex below linear on padded text. */
function squeeze(s: string): string {
  return s.replace(/[ \t\u00A0\u3000]{2,}/g, " ");
}

/**
 * The form a text is READ in for vetoes: invisible marks gone, the doubled sara-e some keyboards produce
 * ("เเ") as one "แ", whitespace squeezed. Digits are left alone (toArabicDigits does that where needed).
 */
export function plainText(s: string | null | undefined): string {
  return squeeze(String(s ?? "").replace(INVISIBLE_RE, "").replace(/เเ/g, "แ"));
}

/** Months (1-12) a text names in Thai by substring, whitespace ignored ("ก. ค. 68" counts). */
export function thaiMonthsIn(text: string | null | undefined): number[] {
  const t = toArabicDigits(String(text ?? "")).replace(/\s+/g, "");
  const out = new Set<number>();
  for (const [month, words] of THAI_MONTH_WORDS) if (words.some((w) => t.includes(w))) out.add(month);
  for (const [month, w] of THAI_GLUED_ABBREV) if (new RegExp(`${w}[\\d.]|(?<=\\d)${w}`).test(t)) out.add(month);
  return [...out].sort((a, b) => a - b);
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const THAI_MONTH_ALT = THAI_MONTH_WORDS.flatMap(([, ws]) => ws).map(escapeRe).join("|");

/** A two-digit number directly after a month word ("Sep 25", "ก.ย.'69", "ส.ค. ปี 68") -> the BE year it would mean. */
export function yearsAfterMonthToken(t: string): number[] {
  const out: number[] = [];
  const tail = `[\\s'’./-]{0,4}(?:ปี ?)?(\\d{2})(?!\\d)`;
  const thai  = new RegExp(`(?:${THAI_MONTH_ALT})${tail}`, "g");
  const latin = new RegExp(`(?<![A-Za-z])(?:jan|feb|mar|apr|may|june?|july?|aug|sep|sept|oct|nov|dec)[a-z]*${tail}`, "gi");
  for (const re of [thai, latin]) for (const m of t.matchAll(re)) out.push(shortYear(m[1]!));
  return out;
}

export function shortYear(yy: string): number {
  const n = parseInt(yy, 10);
  return n >= 43 ? 2500 + n : 2543 + n;
}

/**
 * Words that disown, replace, cancel or re-date what a mail says — a month named in such a mail may be the
 * one being disowned, so none of the generous readings is applied to it. A deliberately wide net: a
 * reading that is skipped only leaves the old refusal in place.
 */
export const CORRECTION_RE = new RegExp([
  "ไม่", "มิใช่", "ผิด", "แก้", "แทน", "ยกเลิก", "ข้าม", "ใหม่", "เปลี่ยน", "อัป?เดท|อัพเดท|อัปเดต|ปรับปรุง", "ลบ", "ยกเว้น",
  "ถูกต้อง", "ขออภัย", "อีกครั้ง", "ล่าสุด", "เก่า", "เดิม", "ฉบับ", "ซ้ำ", "ตัดออก", "งดเว้น",
  "สลับ", "อย่า", "ห้าม", "ทิ้ง", "ถอน", "งด", "ทดสอบ", "ชื่อไฟล์", "ตั้งใจ", "ควรเป็น", "น่าจะเป็น",
  "[a-z]n['’]t", "(?<![a-z])(?:not|no|wrong|ignore[ds]?|instead|replac\\w*|cancel\\w*|mistake\\w*|mistaken|re-?send|resent|revis\\w*|correct\\w*|disregard\\w*|skip\\w*|latest|updat\\w*|obsolete|supersed\\w*|amend\\w*|fix\\w*|void|exclud\\w*|except|remov\\w*|delet\\w*|sorry|typo|old|older|previous|earlier|final|duplicate|again|new\\s+(?:file|version)|v\\d|incorrect|invalid|error|chang\\w*|swap\\w*|meant|should|rather|apolog\\w*|mislabel\\w*|draft|test|file\\s*name|filename|withdr\\w*|retract\\w*|undo|redo|discard\\w*)(?![a-z])",
].join("|"), "i");

/** A year no digit states ("last year", "ปีที่แล้ว", "ปีกลาย", "ปีงบ", "a year ago"): nothing below may supply one. */
const RELATIVE_YEAR_RE = /lastyear|nextyear|prevyear|previousyear|oldyear|ปี\s*(?:ที่\s*แล้ว|กลาย|ก่อน|หน้า|นี้|เก่า|ที่\s*ผ่าน)|ปีงบ|ปีการศึกษา|(?<![a-z])(?:last|previous|prior|next|this|fiscal|past|earlier|a)\s+(?:year|yr)|(?<![a-z])(?:years?|yrs?)\s+(?:ago|before|earlier|prior)|(?<![a-z])FY(?![a-z])|(?<![a-z])ago(?![a-z])/i;
/**
 * ANY year-ish word at all. Used where a year would have to come from the send date because no digit
 * anywhere writes one: if the mail talks about years in words, the send date is not the year it means.
 */
const YEARISH_RE = /lastyear|nextyear|prevyear|previousyear|oldyear|ปี|กลาย|เก่า|ที่แล้ว|ที่ผ่าน|ค\.?\s?ศ|พ\.?\s?ศ|(?<![a-z])(?:years?|yrs?|fy\d*|ago|previous|prior|last|next|past|earlier|before)(?![a-z])/i;

// Where quoted history / a forwarded block / a reply header begins.
const CUT_LINE_RES: RegExp[] = [
  /^\s*_{5,}\s*$/,                                                   // Outlook's separator rule
  /^\s*-{2,}\s*(?:original message|forwarded message|ข้อความ(?:เดิม|ต้นฉบับ|ที่ส่งต่อ)|ต้นฉบับ)/i,
  /^\s*begin forwarded message\s*:?\s*$/i,                           // Apple Mail
  /^[\s*_]*(?:from|จาก)[\s*_]*:[\s*_]*\S.*@/i,                       // a pasted header block with an address
];
// A header block WITHOUT an address ("From: Dr X" then "Sent:" / "Subject:" …): the opening line plus
// one of its companions within the next three lines.
const HEADER_OPEN_RE      = /^[\s*_]*(?:from|จาก)[\s*_]*:[\s*_]*\S/i;
const HEADER_COMPANION_RE = /^[\s*_]*(?:sent|to|cc|subject|date|ส่งเมื่อ|ส่ง|ถึง|เรื่อง|หัวเรื่อง|วันที่)[\s*_]*:/i;
// "wrote:", "schrieb:", "a écrit :", "เขียนไว้ว่า:" and "wrote ----" — every quantifier bounded, matched against the line's END.
const ATTRIBUTION_END_RE   = /(?:wrote|schrieb|a écrit|escribió|scritto|escreveu|написал|เขียน(?:ไว้)?(?:ว่า)?)[ \t]{0,8}:?[ \t]{0,8}[-–—_]{0,40}[ \t]{0,8}$/i;
// An address in angle brackets beside a date or a time is a header or an attribution, whatever its wording.
const ADDRESS_DATE_LINE_RE = /^(?=.*<[^<>\s@]+@[^<>\s]+>)(?=.*(?:\d{4}|\d{1,2}:\d{2})).*$/;
// JS \b does not see Thai letters, so the Thai starters are anchored by "start of line" instead.
const ATTRIBUTION_START_RE = /^\s*(?:on\b|ในวัน|เมื่อ)/i;

// A complete tag, bounded in length so a hostile body of "<div<div<div…" cannot make the scan quadratic.
const HTML_TAG_RE = /<(\/?)([a-z][a-z0-9]*)\b([^<>]{0,4000})>/gi;
const HTML_QUOTE_CONTAINER_RE = /class\s*=\s*["']?[^"'<>]{0,200}?(?:gmail_quote|yahoo_quoted|moz-cite-prefix|zmail_extra|OutlookMessageHeader)|id\s*=\s*["']?(?:appendonsend|divRplyFwdMsg|yahoo_quoted)/i;
const HTML_BLOCK_TAGS = new Set(["br", "div", "p", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Mail that carries only an HTML part reaches us as raw markup: no ">" quote prefixes and "wrote:" is
 * followed by a tag, not a newline. One linear pass: drop every <blockquote> (nested or unclosed — an
 * unclosed one swallows the rest), stop at a Gmail / Outlook-web quote container, turn block tags into
 * line breaks and the rest into spaces.
 */
function htmlToQuotedFreeText(body: string): string {
  let out = "", last = 0, depth = 0;
  const flush = (end: number) => { if (depth === 0) out += body.slice(last, end); last = end; };
  const named: Record<string, string> = {
    nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", gt: ">", lt: "<", amp: "&", quot: '"', apos: "'",
    rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", shy: "", zwnj: "", zwj: "",
  };
  const decode = (t: string) => t
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => { const c = parseInt(h, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : " "; })
    .replace(/&#(\d{1,7});/g, (_m, d: string) => { const c = parseInt(d, 10); return c <= 0x10ffff ? String.fromCodePoint(c) : " "; })
    .replace(/&([a-z]{2,8});/gi, (m, n: string) => named[n.toLowerCase()] ?? m);

  for (const m of body.matchAll(HTML_TAG_RE)) {
    const [tag, slash, name, attrs] = m as unknown as [string, string, string, string];
    const lname = name.toLowerCase();
    flush(m.index!);
    last = m.index! + tag.length;
    if (!slash && lname === "div" && HTML_QUOTE_CONTAINER_RE.test(attrs)) return decode(out);   // the rest is quoted history
    if (lname === "blockquote") {
      if (!slash) depth++; else if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += HTML_BLOCK_TAGS.has(lname) ? "\n" : " ";
  }
  flush(body.length);
  return decode(out);
}

// Longer than this and a line is not prose: the patterns look at its two ends only.
const LINE_PROBE = 2000;

/** The body as text, markup reduced, with only the lines a mail client marks as quoted ("> …", "| …") dropped. */
function bodyLines(body: string | null | undefined): string[] {
  let raw = squeeze(String(body ?? "").replace(INVISIBLE_RE, ""));
  if (/<\/?(?:div|br|p|blockquote|html|body|span|table)\b/i.test(raw)) raw = squeeze(htmlToQuotedFreeText(raw));
  return raw.split(/\r?\n/).filter((line) => !/^\s*[>|]/.test(line));
}

/**
 * Everything the sender typed that is not marked as a quotation — INCLUDING what sits below a quote or a
 * header block (bottom-posting). For vetoes, which must see every word the sender wrote; senderOwnText
 * below is for deciding which months and years are the sender's.
 */
export function unquotedText(body: string | null | undefined): string {
  return bodyLines(body).join("\n");
}

/**
 * A mail body with quoted history and reply/forward headers cut off — what the
 * sender wrote THIS time. A year that only appears in the quoted copy of an
 * older mail is not the sender's statement about this submission. Errs towards
 * cutting too much: anything lost can only make a rule below refuse.
 */
export function senderOwnText(body: string | null | undefined): string {
  const lines = bodyLines(body);
  const startOfAttribution = (i: number): number => {
    for (let j = i; j >= Math.max(0, i - 3); j--) if (ATTRIBUTION_START_RE.test(lines[j]!.slice(0, LINE_PROBE))) return j;
    return i;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const head = line.slice(0, LINE_PROBE);
    if (CUT_LINE_RES.some((re) => re.test(head))) return lines.slice(0, i).join("\n");
    if (ADDRESS_DATE_LINE_RE.test(head)) return lines.slice(0, startOfAttribution(i)).join("\n");
    if (HEADER_OPEN_RE.test(head) && lines.slice(i + 1, i + 9).some((l) => HEADER_COMPANION_RE.test(l.slice(0, LINE_PROBE)))) {
      return lines.slice(0, i).join("\n");
    }
    if (ATTRIBUTION_END_RE.test(line.slice(-LINE_PROBE).trimEnd())) return lines.slice(0, startOfAttribution(i)).join("\n");
  }
  return lines.join("\n");
}

/** True when any line that states month `month` also carries a digit (a year in any format). */
const MONTHISH_RE = new RegExp(`${THAI_MONTH_ALT}|${THAI_GLUED_ABBREV.map(([, w]) => w).join("|")}|(?<![A-Za-z])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)`, "i");
function monthLineHasDigits(text: string, month: number): boolean {
  return toArabicDigits(text).split(/\r?\n/).some((line) => {
    const probe = line.slice(0, LINE_PROBE);
    return /\d/.test(probe.replace(/p4p/gi, "")) && MONTHISH_RE.test(probe) && periodsInText(probe).some((p) => p.month === month);
  });
}

/**
 * statedPeriods() pools subject and body, so "กันยายน" (subject) plus
 * "กันยายน 2569" (body) comes out as two periods and the mail is refused as
 * ambiguous — although it names one month twice. Collapse them when, and
 * only when, all of this holds for a month M:
 *
 *   • exactly one (M, no year) and exactly one (M, Y) — no other entries for M;
 *   • (M, Y) is stated in the sender's OWN text (subject or un-quoted body);
 *   • every own line that mentions M without a year carries no digit at all
 *     (a "ก.ย. 69" or "๖๘" beside "2568" is a contradiction, not a repeat) and
 *     its text states no year anywhere;
 *   • Y is plausible for when the mail was sent (plausibleYear): never last
 *     year's September in an October mail, never a month that has not happened.
 *
 * No send date, or periods that did not come from the mail itself, leaves the
 * list untouched.
 */
export function collapseYearlessPeriods(
  periods: Period[],
  source: StatedPeriods["source"],
  subject: string | null | undefined,
  body: string | null | undefined,
  send: SendDate | null,
): Period[] {
  if (source !== "email" || periods.length < 2 || !send) return periods;

  const subjectText = String(subject ?? "");
  const bodyText    = senderOwnText(body);
  const owns = [
    { text: subjectText, periods: periodsInText(subjectText), yearIn: () => resolveBeYear("", toArabicDigits(subjectText), "") },
    { text: bodyText,    periods: periodsInText(bodyText),    yearIn: () => resolveBeYear("", "", toArabicDigits(bodyText)) },
  ];

  let result = periods;
  for (const month of new Set(periods.map((p) => p.month))) {
    const ofMonth  = periods.filter((p) => p.month === month);
    const yearless = ofMonth.filter((p) => p.beYear === null);
    const dated    = ofMonth.filter((p) => p.beYear !== null);
    if (yearless.length !== 1 || dated.length !== 1) continue;
    const year = dated[0]!.beYear!;

    if (!owns.some((o) => o.periods.some((p) => p.month === month && p.beYear === year))) continue;

    const yearlessSources = owns.filter((o) => o.periods.some((p) => p.month === month && p.beYear === null));
    if (yearlessSources.length === 0) continue;
    if (yearlessSources.some((o) => o.yearIn() !== null || monthLineHasDigits(o.text, month))) continue;

    if (!plausibleYear(month, year, send)) continue;
    // No year reading of ANY shape in the sender's own words may differ from the one merged into.
    if ([...yearReadings(subjectText, true), ...yearReadings(bodyText, false)].some((y) => y !== year)) continue;

    const merged: Period = { month, beYear: year };
    let placed = false;
    result = result.flatMap((p) => {
      if (p.month !== month) return [p];
      if (placed) return [];
      placed = true;
      return [merged];
    });
  }
  return result;
}

// ── 2. A multi-month mail: which month is THIS file? ──────────────────────

// Latin month words. A word is a run of letters, so "Intern" never hits and
// "Maybe" is not May; underscores, digits and hyphens around the word are fine
// (that is the whole point).
const LATIN_MONTHS: [number, string][] = [
  [1, "jan(?:uary)?"], [2, "feb(?:ruary)?"], [3, "mar(?:ch)?"], [4, "apr(?:il)?"],
  [5, "may"], [6, "june?"], [7, "july?"], [8, "aug(?:ust)?"],
  [9, "sep(?:t(?:ember)?)?"], [10, "oct(?:ober)?"], [11, "nov(?:ember)?"], [12, "dec(?:ember)?"],
];

// Month words that are also common given names / nicknames ("May", "Jun", "June", "Jan", "Mar", "March",
// "Apr"). In a file name such a word is read as a month only when "month"/"เดือน" comes right before it —
// a year beside it is not enough ("Dr.Jun_2569_P4P" is a person and a year).
const NAME_LIKE_MONTHS = new Set(["jan", "mar", "march", "may", "jun", "june", "apr", "april"]);

function fourDigitYear(text: string): number | null {
  const be = text.match(/(?<!\d)(25\d{2})(?!\d)/);
  if (be) return parseInt(be[1]!, 10);
  const ce = text.match(/(?<!\d)(20\d{2})(?!\d)/);
  return ce ? parseInt(ce[1]!, 10) + 543 : null;
}

/**
 * Every year a text appears to state, in any format, as a BE year — for REFUSING on, never for routing:
 * 4-digit BE and CE, and the two-digit forms ("68", "26") that no router here trusts but that plainly
 * contradict a different year. Thai digits are read as Arabic. `shortCe` (00–42) is off for mail bodies,
 * where such numbers are mostly day-of-month.
 */
function yearReadings(text: string | null | undefined, shortCe: boolean): number[] {
  const t = squeeze(toArabicDigits(plainText(text))).replace(/\s{2,}/g, " ");
  const out: number[] = [];
  for (const m of t.matchAll(/(?<!\d)(25\d{2})(?!\d)/g)) out.push(parseInt(m[1]!, 10));
  for (const m of t.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) out.push(parseInt(m[1]!, 10) + 543);
  for (const m of t.matchAll(/(?<!\d)(4[3-9]|[5-9]\d)(?!\d)/g)) out.push(2500 + parseInt(m[1]!, 10));
  if (shortCe) for (const m of t.matchAll(/(?<!\d)([0-3]\d|4[0-2])(?!\d)/g)) out.push(2543 + parseInt(m[1]!, 10));

  // A compact date stamp hides its year inside one digit run: 30092568, 20250930, 202509, 300925.
  for (const m of t.matchAll(/\d+/g)) {
    const run = m[0];
    if (![6, 8, 12, 14].includes(run.length)) continue;
    for (let i = 0; i + 4 <= run.length; i++) {
      const w = run.slice(i, i + 4);
      if (/^(?:25|20)\d{2}$/.test(w)) out.push(w.startsWith("25") ? parseInt(w, 10) : parseInt(w, 10) + 543);
    }
    if (run.length === 6) out.push(shortYear(run.slice(0, 2)), shortYear(run.slice(4)));   // YYMMDD and DDMMYY
  }
  // d/m/yy and m/yy, a year label with two digits ("ปี 25", "year 25", "ค.ศ. 25", "'25"), "Q3/25", "FY25",
  // and a two-digit number straight after a month word.
  for (const m of t.matchAll(/(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](\d{2})(?!\d)/g)) out.push(shortYear(m[1]!));
  for (const m of t.matchAll(/(?<!\d)\d{1,2}[/-](\d{2})(?!\d)/g)) out.push(shortYear(m[1]!));
  for (const m of t.matchAll(/(?:ปี|year|yr|ค\.? ?ศ\.?|พ\.? ?ศ\.?)[ .]{0,2}['’]?(\d{2})(?!\d)/gi)) out.push(shortYear(m[1]!));
  for (const m of t.matchAll(/(?<![\w])['’](\d{2})(?!\d)/g)) out.push(shortYear(m[1]!));
  for (const m of t.matchAll(/(?<![A-Za-z])Q[1-4][ /-]{0,2}['’]?(\d{2})(?!\d)/gi)) out.push(shortYear(m[1]!));
  for (const m of t.matchAll(/(?<![A-Za-z])FY\s*['’]?(\d{2})(?!\d)/gi)) out.push(shortYear(m[1]!));
  out.push(...yearsAfterMonthToken(t));
  return out;
}

/**
 * Whether every run of digits in a file-name stem is one this reader understands: a single digit ("P4P"),
 * two digits (a year, which yearReadings then checks) or a four-digit 20xx/25xx year. Anything else — a
 * three- or five-digit run, a compact date — is a stamp or a code whose meaning cannot be read here.
 */
function digitRunsReadable(stem: string): boolean {
  return [...toArabicDigits(stem).matchAll(/\d+/g)].every(([run]) =>
    run.length <= 2 || (run.length === 4 && /^(?:20|25)\d{2}$/.test(run)));
}

/** Months (1-12) named by a Latin word anywhere in `text` — no boundary tricks, letters only. */
export function latinMonthsIn(text: string | null | undefined): number[] {
  const t = String(text ?? "");
  return LATIN_MONTHS
    .filter(([, pattern]) => new RegExp(`(?<![A-Za-z])(?:${pattern})(?![A-Za-z])`, "i").test(t))
    .map(([month]) => month);
}

interface LatinToken { month: number; trusted: boolean }

/**
 * Latin month words in a file-name stem, each marked trusted or not. Not trusted: a day-number stamp
 * ("01Sep2569", "Sep_1_2569" — the date a file was saved, not the month it reports), and a name-like
 * word ("May", "Jun") with no year beside it and no "month"/"เดือน" before it.
 */
function latinTokensIn(base: string): LatinToken[] {
  const out: LatinToken[] = [];
  for (const [month, pattern] of LATIN_MONTHS) {
    for (const m of base.matchAll(new RegExp(`(?<![A-Za-z])(${pattern})(?![A-Za-z])`, "gi"))) {
      const before = base.slice(0, m.index!);
      const after  = base.slice(m.index! + m[0].length);
      // a day number before the word ("01Sep", "1-Sep"), or a single digit right after it ("Sep3", "Oct_3",
      // "Sep_1_2569"), is the day a file was saved, not the month it reports
      const dayStamp = /(?<!\d)\d{1,2}(?:st|nd|rd|th)?[\s._-]?$/i.test(before)
                    || /^[\s._,/()–—-]?\d(?!\d)/.test(after)
                    || /^[\s._-]?\d{1,2}(?!\d)[\s._,/()-]{0,2}(?:25|20)\d{2}(?!\d)/.test(after);
      let trusted = !dayStamp;
      if (trusted && NAME_LIKE_MONTHS.has(m[1]!.toLowerCase())) trusted = /(?:(?<![a-z])(?:month|mth)|เดือน)[\s._-]?$/i.test(before);
      out.push({ month, trusted });
    }
  }
  return out;
}

/**
 * Latin month words in a filename (extension dropped), one entry per month found. A word that cannot be
 * trusted as a month (see latinTokensIn) makes the whole reading empty: an unreadable token is a
 * refusal, not a word to skip.
 */
export function periodsInFilenameLoose(filename: string | null | undefined): Period[] {
  const base = toArabicDigits(String(filename ?? "")).replace(/\.xlsx$/i, "");
  const tokens = latinTokensIn(base);
  if (tokens.some((t) => !t.trusted)) return [];
  const year = fourDigitYear(base);
  return [...new Set(tokens.map((t) => t.month))].sort((x, y) => x - y).map((month) => ({ month, beYear: year }));
}

export interface OwnPeriod extends Period {
  /** true when only the Latin-month reader found it (the strict reader found nothing). */
  loose: boolean;
  /** true (only ever present when true) when the year is the send date's, because nothing wrote one. */
  guessed?: true;
}

/**
 * The one period a file's own name states, given the periods the mail named.
 *
 *   strict  : exactly one period by the existing reader -> unchanged behaviour.
 *   loose   : the strict reader found nothing, and the name carries exactly one
 *             trusted Latin month word for a month the mail named exactly once.
 *             The year is the file's own 4-digit year or the mail's year for that
 *             month (they must agree); with neither, the send year — only for a
 *             month that cannot belong to the previous year (month <= send month),
 *             so a "Dec + Jan" mail sent in January stays refused. Whatever year
 *             is used must be plausible for the send date, and NO year reading
 *             anywhere (`mailYears` plus the file name's own — Thai digits and
 *             two-digit forms included) may differ from it. Without a send date
 *             the year cannot be checked, so the answer is a refusal.
 */
export function ownPeriodOfFile(filename: string, mailPeriods: Period[], send: SendDate | null, mailYears: number[] = [], mailYearWords = false): OwnPeriod | null {
  const strict = periodsInText(filename);
  if (strict.length === 1) return { ...strict[0]!, loose: false };
  if (strict.length > 1) return null;

  const found = periodsInFilenameLoose(filename);
  if (found.length !== 1 || !send) return null;
  const hit = found[0]!;

  // What the strict reader skipped must not contradict the Latin word: a Thai month glued to other letters
  // ("ผลงานกรกฎาคม_aug"), and digit runs that are stamps or codes rather than a year.
  const stem = plainText(String(filename).replace(/\.xlsx$/i, ""));
  if (thaiMonthsIn(stem).some((m) => m !== hit.month)) return null;
  if (!digitRunsReadable(stem)) return null;
  // The file name is evidence too, so it must not be correcting, replacing or re-dating anything either.
  if (CORRECTION_RE.test(stem) || RELATIVE_YEAR_RE.test(stem)) return null;

  const named = mailPeriods.filter((p) => p.month === hit.month);
  if (named.length !== 1) return null;
  const mailYear = named[0]!.beYear;
  if (hit.beYear !== null && mailYear !== null && hit.beYear !== mailYear) return null;

  const years = [...mailYears, ...yearReadings(stem, true)];
  let beYear = hit.beYear ?? mailYear;
  let guessed = false;
  if (beYear === null) {
    if (years.length > 0 || hit.month > send.month) return null;   // a year this reader cannot place / Dec in January
    // No digit writes a year anywhere, so the year would be the send date's. Not if the mail or the file
    // name talks about years in words ("last year", "ปีกลาย", "ปี…"): then it is not that year.
    if (mailYearWords || YEARISH_RE.test(stem)) return null;
    beYear = send.beYear;
    guessed = true;
  }
  if (!plausibleYear(hit.month, beYear, send)) return null;
  if (years.some((y) => y !== beYear)) return null;
  return { month: hit.month, beYear, loose: true, ...(guessed ? { guessed: true as const } : {}) };
}

/**
 * A file read by the LOOSE reader is refused when any workbook of the message,
 * itself included, resolves to the same month: the pipeline saves and uploads
 * each file independently and overwrites unconditionally, so two files filed
 * under one month would leave only the last writer's score — and we could not
 * tell which one was meant. It is also refused unless EVERY workbook of the
 * message is known (`workbookCount`), since "no other file claims this month"
 * cannot be shown otherwise. Files the strict reader accepts behave as always.
 */
export function decideMultiMonthFile(
  filename: string,
  mailPeriods: Period[],
  siblings: string[],
  send: SendDate | null,
  mailYears: number[] = [],
  workbookCount?: number,
  mailYearWords = false,
): { ok: true; month: number; beYear: number | null; loose: boolean } | { ok: false; reason: "no_own_period" | "sibling_collision" | "siblings_unknown" | "sibling_year" | "sibling_wording" } {
  const own = ownPeriodOfFile(filename, mailPeriods, send, mailYears, mailYearWords);
  if (!own) return { ok: false, reason: "no_own_period" };

  if (own.loose) {
    const all = siblings.length > 0 ? siblings : [filename];
    if (all.length < (workbookCount ?? all.length) || !all.includes(filename)) return { ok: false, reason: "siblings_unknown" };
    // A sibling whose name corrects, replaces or re-dates something puts the whole mail in that light.
    if (all.some((name) => CORRECTION_RE.test(plainText(name.replace(/\.xlsx$/i, ""))))) return { ok: false, reason: "sibling_wording" };
    // A year taken from the send date is a guess, and a sibling that WRITES a different year — or talks about
    // years in words — is evidence against it.
    if (own.guessed === true && all.some((name) => {
      const stem = plainText(name.replace(/\.xlsx$/i, ""));
      return yearReadings(stem, true).some((y) => y !== own.beYear) || RELATIVE_YEAR_RE.test(stem) || YEARISH_RE.test(stem);
    })) {
      return { ok: false, reason: "sibling_year" };
    }
    // Excel's "~$name.xlsx" owner file is attached by some clients but never processed: it cannot collide.
    const sameMonth = all.filter((name) => !/(?:^|[\\/])~\$/.test(name)).filter((name) => {
      const o = ownPeriodOfFile(name, mailPeriods, send, mailYears, mailYearWords);
      if (o === null || o.month !== own.month) return false;
      // A year taken from the send date is a guess: any sibling in that month, whatever year it states, collides.
      return own.guessed === true || o.guessed === true || o.beYear === null || own.beYear === null || o.beYear === own.beYear;
    }).length;
    if (sameMonth > 1) return { ok: false, reason: "sibling_collision" };
  }
  return { ok: true, month: own.month, beYear: own.beYear, loose: own.loose };
}

const MONTH_NAMES: [number, string][] = [
  [1, "january"], [2, "february"], [3, "march"], [4, "april"], [5, "may"], [6, "june"], [7, "july"], [8, "august"],
  [9, "september"], [10, "october"], [11, "november"], [12, "december"],
];
const MONTH_ABBREVS: [number, string][] = [
  [1, "jan"], [2, "feb"], [3, "mar"], [4, "apr"], [6, "jun"], [7, "jul"], [8, "aug"], [9, "sep"], [9, "sept"],
  [10, "oct"], [11, "nov"], [12, "dec"],
];

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = keep;
    }
  }
  return prev[b.length]!;
}

/** Months a Latin word in `text` is, or is a prefix of, or is a typo of ("Octo", "Augest", "Decmber"). */
function latinMonthsLike(text: string): number[] {
  const out = new Set<number>();
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    for (const [month, name] of MONTH_NAMES) {
      if (name.startsWith(w) || editDistance(w, name) <= (name.length >= 6 ? 2 : 1)) out.add(month);
    }
    for (const [month, abbr] of MONTH_ABBREVS) if (w === abbr || (w.length <= 4 && editDistance(w, abbr) <= 1)) out.add(month);
  }
  return [...out];
}

/** Months named by a two-consonant Thai abbreviation that ENDS a token of the stem ("ผลงานสค", "ตค_นพ"). */
function thaiShortMonthTokens(stem: string): number[] {
  const out = new Set<number>();
  for (const token of stem.split(/[\s._()\-+]+/)) {
    for (const [month, w] of THAI_GLUED_ABBREV) if (token.endsWith(w)) out.add(month);
  }
  return [...out];
}

/** Months whose 3-letter abbreviation sits anywhere inside the Latin letters of `text` ("AugSep", "OctNov"). Over-refuses on purpose. */
function latinMonthSubstrings(text: string): number[] {
  const out = new Set<number>();
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    for (const [month, abbr] of MONTH_ABBREVS) if (w.includes(abbr)) out.add(month);
    if (w.includes("may")) out.add(5);
  }
  return [...out];
}

/** A file-name stem whose digits are all a clean 4-digit 20xx/25xx year or a 2-digit number — no lone digits, no 3 or 5+ runs. */
function digitRunsClean(stem: string): boolean {
  return [...toArabicDigits(stem).matchAll(/\d+/g)].every(([run]) =>
    run.length === 2 || (run.length === 4 && /^(?:20|25)\d{2}$/.test(run)));
}

/**
 * Whether ONE mail-wide month and year may be applied to all of the mail's workbooks: every workbook is
 * known, and no non-"~$" file name says anything else about the period — no other month (strict reader,
 * Thai substring, any Latin word that is, extends or misspells a month), no numeric month or stamp (a lone
 * digit, "08", "Q2", a 3- or 5-digit run), no year other than `beYear` (4-digit, 2-digit, CE or BE), and no
 * correction wording. A file whose name says another month must keep its refusal.
 */
function filenamesAllowMonth(month: number, beYear: number | null, siblings: string[], filename: string, workbookCount: number): boolean {
  const all = siblings.length > 0 ? siblings : [filename];
  if (all.length < workbookCount || !all.includes(filename)) return false;
  return all.filter((name) => !/(?:^|[\\/])~\$/.test(name)).every((name) => {
    const stem = plainText(name.replace(/\.xlsx$/i, ""));
    const bare = stem.replace(/p4p/gi, " ");
    if (CORRECTION_RE.test(stem) || RELATIVE_YEAR_RE.test(stem)) return false;
    if (periodsInText(name).some((p) => p.month !== month)) return false;
    if (thaiMonthsIn(plainText(name)).some((m) => m !== month)) return false;     // the dot of ".xlsx" ends "สค."
    if (thaiShortMonthTokens(stem).some((m) => m !== month)) return false;
    if (latinMonthsIn(stem).some((m) => m !== month)) return false;
    if (latinMonthsLike(bare).some((m) => m !== month)) return false;
    if (latinMonthSubstrings(bare).some((m) => m !== month)) return false;
    if (!digitRunsClean(bare)) return false;
    return beYear === null || yearReadings(bare, true).every((y) => y === beYear);
  });
}

/** The periods the sender's OWN words (subject + un-quoted body) state, with a year-less/dated repeat of one month merged. */
const LATIN_MONTH_ALT = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
/**
 * "2 ตุลาคม 2569", "02 Oct", "Oct 2": a month that is part of a day-number date is the day something
 * happened (often the send date), not the month being reported.
 */
function withoutDatedDays(text: string): string {
  return squeeze(toArabicDigits(text))
    .replace(new RegExp(`(?<!\\d)\\d{1,2} ?(?:${THAI_MONTH_ALT})[^\\s\\d,;]*`, "g"), " ")
    .replace(new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)? ?(?:${LATIN_MONTH_ALT})[a-z]*\\.?`, "gi"), " ")
    .replace(new RegExp(`(?<![A-Za-z])(?:${LATIN_MONTH_ALT})[a-z]*\\.? ?\\d{1,2}(?:st|nd|rd|th)?(?![\\d])`, "gi"), " ");
}

function ownMailPeriods(subject: string, body: string, send: SendDate | null): Period[] {
  const seen = new Set<string>();
  const merged = [...periodsInText(withoutDatedDays(subject)), ...periodsInText(withoutDatedDays(senderOwnText(body)))].filter((p) => {
    const key = `${p.month}_${p.beYear}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return collapseYearlessPeriods(merged, "email", subject, body, send);
}

// ── The whole decision ────────────────────────────────────────────────────

export type PeriodDecision =
  | { kind: "none" }
  | { kind: "ambiguous"; named: Period[] }
  | {
      kind: "ok";
      month: number;
      beYear: number | null;
      /** How it was decided — for the log line only. */
      via: "single" | "own_file" | "collapsed" | "own_file_latin";
    };

// A body longer than this is never read for the generous readings (50k characters is already not a note
// from a colleague); the strict decision above is unaffected.
const MAX_BODY_FOR_LOOSENING = 50_000;
// Gmail's receive time and the sender-written Date header may differ by a timezone or a queue, not by days.
const SEND_DATE_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;

/** Exactly what the processor has always done with a list of stated periods. */
export function decideStrict(periods: Period[], workbookCount: number, filename: string): PeriodDecision {
  if (periods.length === 0) return { kind: "none" };
  if (periods.length === 1) return { kind: "ok", month: periods[0]!.month, beYear: periods[0]!.beYear, via: "single" };
  // More than one period named: with one workbook nothing says which this file is;
  // with several, only a period in the file's OWN name does.
  const own = workbookCount > 1 ? periodsInText(filename) : [];
  if (own.length === 1) return { kind: "ok", month: own[0]!.month, beYear: own[0]!.beYear, via: "own_file" };
  return { kind: "ambiguous", named: periods };
}

/**
 * Which month an emailed submission is for, from what the sender wrote.
 *
 * `stated` is statedPeriods(filename, subject, body). Anything the strict rules
 * accept is returned unchanged; the new readings are tried only for what they
 * would refuse, and a refusal they cannot lift is returned as the same
 * `ambiguous` (naming the periods as originally pooled) it always was.
 */
export function decideStatedPeriod(a: {
  stated: StatedPeriods;
  subject: string;
  body: string;
  filename: string;
  workbookCount: number;
  siblingFilenames: string[];
  emailDate: string | null | undefined;
  /** When Gmail received the message (its own clock). A Date header that disagrees with it by days is not trusted. */
  receivedDate?: string | null;
}): PeriodDecision {
  const pooled = a.stated.periods;
  const strict = decideStrict(pooled, a.workbookCount, a.filename);
  if (strict.kind !== "ambiguous") return strict;

  // The readings below are for ordinary mail. A body this large is not one, and every line of it would be
  // read; keep the refusal.
  if (a.body.length > MAX_BODY_FOR_LOOSENING) return { kind: "ambiguous", named: pooled };

  const subject = plainText(a.subject);
  const body    = String(a.body ?? "");

  // The send date: the Date header, unless Gmail's own receive time says it cannot be right.
  let send = sendDate(a.emailDate);
  if (send && a.receivedDate) {
    const header = new Date(a.emailDate!).getTime(), received = new Date(a.receivedDate).getTime();
    if (Number.isFinite(received) && Math.abs(header - received) > SEND_DATE_TOLERANCE_MS) send = null;
  }

  // Every word the sender typed that is not marked as a quotation — below a quote included.
  const typed = plainText(`${subject}\n${unquotedText(body)}`);
  const relativeYear = RELATIVE_YEAR_RE.test(typed);

  // Workbooks that will actually be processed: Excel's "~$" owner file is attached by some clients but is
  // not one, and a lone workbook beside its owner file must not look like several.
  const lockFiles = a.siblingFilenames.filter((n) => /(?:^|[\\/])~\$/.test(n)).length;
  const workbooks = a.workbookCount - lockFiles;

  const wording = CORRECTION_RE.test(typed);
  const collapsed = relativeYear || wording ? pooled : collapseYearlessPeriods(pooled, a.stated.source, subject, body, send);
  if (collapsed.length < pooled.length) {
    const again = decideStrict(collapsed, a.workbookCount, a.filename);
    // One mail-wide month for SEVERAL workbooks: none of their names may say anything else about the period.
    if (again.kind === "ok" && (workbooks <= 1 || filenamesAllowMonth(again.month, again.beYear, a.siblingFilenames, a.filename, a.workbookCount))) {
      return { ...again, via: "collapsed" };
    }
  }

  // A Latin month word in a filename is only ever read against what the sender wrote THIS time:
  // a month — or a year — that appears only in quoted history is not their statement. And not when the
  // sender is correcting, cancelling or re-dating something: a month named in such a mail may be the
  // one being disowned.
  if (!relativeYear && !wording && workbooks > 1 && (collapsed.length < pooled.length ? collapsed : pooled).length > 1) {
    const ownMail = ownMailPeriods(subject, body, send);
    // Any year the mail mentions anywhere (quoted history and Thai digits included) must agree with the one routed on.
    const mailYears = [...yearReadings(subject, true), ...yearReadings(body, false)];
    const own = decideMultiMonthFile(a.filename, ownMail, a.siblingFilenames, send, mailYears, a.workbookCount, YEARISH_RE.test(typed));
    if (own.ok) return { kind: "ok", month: own.month, beYear: own.beYear, via: "own_file_latin" };
  }

  return { kind: "ambiguous", named: pooled };
}
