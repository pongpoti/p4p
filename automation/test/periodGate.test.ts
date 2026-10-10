import { test } from "node:test";
import assert   from "node:assert/strict";
import { statedPeriods } from "../claude-analyst.js";
import {
  sendDate, plausibleYear, senderOwnText, collapseYearlessPeriods,
  periodsInFilenameLoose, ownPeriodOfFile, decideMultiMonthFile, decideStatedPeriod, decideStrict,
} from "../period-gate.js";

// What these readings must NEVER do is move a score to a month or year the
// sender did not write. Most cases below are inputs that would — several are
// counterexamples found by reviewing an earlier version of this code.

const OCT_2026 = "2026-10-02T06:00:00Z";       // Oct 2026 = BE 2569, month 10
const JAN_2027 = "2027-01-10T06:00:00Z";       // Jan 2027 = BE 2570, month 1
const OCT_2569 = sendDate(OCT_2026)!;
const JAN_2570 = sendDate(JAN_2027)!;

function decide(o: { subject?: string; body?: string; filename?: string; workbookCount?: number; siblings?: string[]; emailDate?: string }) {
  const subject = o.subject ?? "", body = o.body ?? "", filename = o.filename ?? "x.xlsx";
  return decideStatedPeriod({
    stated: statedPeriods(filename, subject, body), subject, body, filename,
    workbookCount: o.workbookCount ?? 1, siblingFilenames: o.siblings ?? [filename], emailDate: o.emailDate ?? OCT_2026,
  });
}
const ok = (month: number, beYear: number | null, via: string) => ({ kind: "ok", month, beYear, via });
/**
 * Quoted history must never decide. Depending on how much of the quote the strict reader itself blanks out,
 * the answer is a refusal (the quote's month leaked into the pool) or the sender's OWN month routed as an
 * ordinary single period — but never the quote's month, nor a year taken from the quote.
 */
const neverTheQuote = (r: ReturnType<typeof decide>, own: { month: number; beYear: number | null }) =>
  r.kind === "ambiguous" || (r.kind === "ok" && r.via === "single" && r.month === own.month && r.beYear === own.beYear);

// ── send date ────────────────────────────────────────────────────────────

test("the send date is the Bangkok date, not the host's", () => {
  assert.deepEqual(sendDate("2026-12-31T20:00:00Z"), { beYear: 2570, month: 1 });   // already 1 Jan in Bangkok
  assert.deepEqual(sendDate(OCT_2026), { beYear: 2569, month: 10 });
  assert.equal(sendDate(null), null);
  assert.equal(sendDate("not a date"), null);
});

test("a year is plausible only for a month that has happened, or last year's December-style carry-over", () => {
  assert.equal(plausibleYear(9, 2569, OCT_2569), true,  "this year, an earlier month");
  assert.equal(plausibleYear(10, 2569, OCT_2569), true, "this year, this month");
  assert.equal(plausibleYear(12, 2569, OCT_2569), false, "a month that has not happened yet");
  assert.equal(plausibleYear(9, 2568, OCT_2569), false, "LAST year's September, quoted in an October mail");
  assert.equal(plausibleYear(9, 2570, OCT_2569), false, "next year");
  assert.equal(plausibleYear(12, 2569, JAN_2570), true,  "December reported in January");
  assert.equal(plausibleYear(1, 2570, JAN_2570), true);
  assert.equal(plausibleYear(12, 2570, JAN_2570), false);
  assert.equal(plausibleYear(9, 2569, JAN_2570), true,  "a late September, sent in January: still within the last 12 months");
  assert.equal(plausibleYear(1, 2569, JAN_2570), false, "a year-old January");
});

// ── nothing that is accepted today may change ────────────────────────────

test("an input the strict rules accept is returned unchanged — even when the new readings would also apply", () => {
  // Pooled periods are [Dec 2569, Dec year-less] (a collapse candidate) AND the file names its own month:
  // today the file's own month wins. It must still.
  const r = decide({ subject: "P4P ธันวาคม พ.ศ. 2569", body: "ส่งผลงานเดือนธ.ค.", filename: "P4P-Intern_สิงหาคม_X.xlsx", workbookCount: 2 });
  assert.deepEqual(r, ok(8, null, "own_file"));
  const s = decide({ subject: "ส่งผลงานเดือนสค 2568 กับ", body: "ส่งผลงานเดือนส.ค.", filename: "P4P-Sep-2026.xlsx", workbookCount: 2 });
  assert.deepEqual(s, ok(9, 2569, "own_file"));
  // a plain single stated period
  assert.deepEqual(decide({ subject: "P4P ก.ค. 2569" }), ok(7, 2569, "single"));
  assert.deepEqual(decide({ subject: "ส่งไฟล์", filename: "P4P สิงหาคม.xlsx" }), ok(8, null, "single"), "filename-only period");
});

test("property: whenever the strict rules accept, the decision is exactly the strict one", () => {
  // Seeded, deterministic. Fragments cover Thai/Latin months, years in several formats, quotes, counts.
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = <T>(xs: T[]) => xs[rnd(xs.length)]!;
  const months = ["มกราคม", "ก.พ.", "มีนาคม", "เม.ย.", "พ.ค.", "มิถุนายน", "กรกฎาคม", "ส.ค.", "กันยายน", "ต.ค.", "พ.ย.", "ธันวาคม", "Aug", "Sep", "December", ""];
  const years = ["", " 2569", " 2568", " 69", " 68", " ๒๕๖๙", " 2026", " 2570"];
  const frag = () => `${pick(["P4P ", "ส่ง ", "Re: ", "เดือน", ""])}${pick(months)}${pick(years)}`;
  const quote = () => pick(["", "\n> ", "\n\nOn Monday, X wrote:\n> ", "\n________________________________\nFrom: a <a@example.com>\n", "\nBegin forwarded message:\n"]);
  const files = ["x.xlsx", "P4P สิงหาคม.xlsx", "P4P-Sep-2026.xlsx", "P4P-Intern_sep_X.xlsx", "P4P_aug_X.xlsx", "P4P กย 69.xlsx", "P4P-Aug.xlsx", "Book1.xlsx"];
  let accepted = 0, flips = 0;
  for (let i = 0; i < 4000; i++) {
    const subject = frag() + (rnd(2) ? ` ${frag()}` : "");
    const body = frag() + quote() + (rnd(2) ? frag() : "");
    const filename = pick(files);
    const workbookCount = 1 + rnd(3);
    const siblings = Array.from({ length: workbookCount }, (_, k) => (k === 0 ? filename : pick(files)));
    const emailDate = pick([OCT_2026, JAN_2027, "2026-09-15T10:00:00Z"]);
    const stated = statedPeriods(filename, subject, body);
    const strict = decideStrict(stated.periods, workbookCount, filename);
    const got = decideStatedPeriod({ stated, subject, body, filename, workbookCount, siblingFilenames: siblings, emailDate });
    if (strict.kind !== "ambiguous") {
      assert.deepEqual(got, strict, `strict accepted/declined but the decision changed: ${JSON.stringify({ subject, body, filename, workbookCount })}`);
      accepted++;
    } else if (got.kind === "ok") {
      flips++;
      assert.ok(["collapsed", "own_file_latin"].includes(got.via), "a flip is only ever one of the two new readings");
    } else {
      assert.deepEqual(got, strict, "a refusal that stays a refusal is reported exactly as before");
    }
  }
  assert.ok(accepted > 500, `the corpus must exercise the strict-accept path (${accepted})`);
  assert.ok(flips > 0, `…and at least one flip (${flips})`);
});

// ── 1. the same month with and without a year ────────────────────────────

test("September without a year in the subject, September 2569 in the body, is one period (the Oct-2 incident)", () => {
  const subject = "P4P เดือนกันยายน", body = "ส่งตาราง P4P ของเดือนกันยายน 2569 ครับ";
  assert.equal(statedPeriods("x.xlsx", subject, body).periods.length, 2, "precondition: today this is two periods");
  assert.deepEqual(decide({ subject, body }), ok(9, 2569, "collapsed"));
  assert.deepEqual(decide({ subject: "P4P กันยายน 2569", body: "ส่งตาราง P4P ของเดือนกันยายน ครับ" }), ok(9, 2569, "collapsed"), "year in the subject instead");
});

test("different months, or two explicit years, stay refused", () => {
  assert.equal(decide({ subject: "P4P สิงหาคม", body: "ส่ง กันยายน 2569" }).kind, "ambiguous");
  assert.equal(decide({ subject: "P4P กันยายน 2568", body: "ส่ง กันยายน 2569" }).kind, "ambiguous");
});

test("last year's mail quoted in a reply is not this year's statement (the 2568-in-October shape)", () => {
  // The explicit year is plausible-looking (one year off) — plausibility alone must not let it through.
  assert.equal(decide({ subject: "P4P เดือนกันยายน", body: "ส่ง กันยายน 2568" }).kind, "ambiguous", "last year's September, sent in October");
  assert.equal(decide({ subject: "P4P เดือนกันยายน", body: "ส่ง กันยายน 2570" }).kind, "ambiguous", "next year");
  assert.equal(decide({ subject: "P4P เดือนธันวาคม", body: "ส่ง ธันวาคม 2569" }).kind, "ambiguous", "December has not happened yet in October");
  assert.deepEqual(decide({ subject: "P4P เดือนธันวาคม", body: "ส่ง ธันวาคม 2569", emailDate: JAN_2027 }), ok(12, 2569, "collapsed"), "…but is fine in January");
});

test("quoted history, reply headers and forwarded blocks are not the sender's own words", () => {
  const cases: [string, string][] = [
    ["Outlook", "ส่งใหม่ครับ\n\n________________________________\nFrom: Dr X <x@example.com>\nSent: Monday\nSubject: P4P กันยายน 2569"],
    ["Outlook, Thai headers", "ส่งใหม่ครับ\n\n________________________________\nจาก: Dr X <x@example.com>\nส่ง: จันทร์\nเรื่อง: P4P กันยายน 2569"],
    ["Apple Mail forward", "ส่งต่อครับ\n\nBegin forwarded message:\n\nFrom: X <x@example.com>\nSubject: P4P กันยายน 2569"],
    ["Gmail forward", "ส่งต่อครับ\n\n---------- Forwarded message ---------\nFrom: X <x@example.com>\nSubject: P4P กันยายน 2569"],
    ["Gmail reply", "ส่งใหม่ครับ\n\nOn Monday, Someone <someone@example.com> wrote:\n> ส่ง P4P เดือนกันยายน 2569 ครับ"],
    ["Gmail reply, attribution wrapped", "ส่งใหม่ครับ\n\nOn Monday, a very long attribution line that wraps,\nSomeone <someone@example.com> wrote:\nส่ง P4P เดือนกันยายน 2569"],
    ["Thai Gmail reply", "ส่งใหม่ครับ\n\nในวัน จันทร์ที่ 5 Someone <someone@example.com> เขียนว่า:\nส่ง P4P เดือนกันยายน 2569"],
    ["plain >-quote", "ส่งใหม่ครับ\n> ส่ง P4P เดือนกันยายน 2569"],
  ];
  for (const [name, body] of cases) {
    // 2569 is the plausible year here, so ONLY the quote handling can keep these refused.
    assert.ok(neverTheQuote(decide({ subject: "Re: P4P เดือนกันยายน", body }), { month: 9, beYear: null }), name);
  }
  assert.equal(senderOwnText("a\n> quoted\nb"), "a\nb");
  assert.equal(senderOwnText("hi\n-----Original Message-----\nold 2568"), "hi");
});

test("a year written in ANY format on the year-less mention's line is a year", () => {
  assert.equal(decide({ subject: "P4P ก.ย. 69", body: "ส่ง กันยายน 2569" }).kind, "ambiguous", "two-digit year");
  assert.equal(decide({ subject: "P4P ก.ย. ๖๙", body: "ส่ง กันยายน 2569" }).kind, "ambiguous", "Thai digits, two-digit");
  assert.equal(decide({ subject: "P4P ก.ย. ๒๕๖๘", body: "ส่ง กันยายน 2569" }).kind, "ambiguous", "Thai digits, four-digit");
  assert.equal(decide({ subject: "P4P ก.ย. (1)", body: "ส่ง กันยายน 2569" }).kind, "ambiguous", "any digit on that line: fail closed");
  assert.deepEqual(decide({ subject: "P4P ก.ย.", body: "ส่ง ก.ย. 25" }), ok(9, null, "single"), "no 4-digit year anywhere: one period, as always (nothing to collapse)");
});

test("collapse needs a send date and mail-sourced periods", () => {
  const subject = "P4P เดือนกันยายน", body = "ส่ง กันยายน 2569";
  const stated = statedPeriods("x.xlsx", subject, body);
  assert.equal(collapseYearlessPeriods(stated.periods, "email", subject, body, null).length, 2);
  assert.equal(collapseYearlessPeriods(stated.periods, "filename", subject, body, OCT_2569).length, 2);
  assert.equal(decide({ subject, body, emailDate: "garbage" }).kind, "ambiguous");
});

// ── 2. a multi-month mail: which month is this file? ─────────────────────

test("Latin month words are read next to underscores and digits, but not inside other words", () => {
  assert.deepEqual(periodsInFilenameLoose("P4P-Intern_sep_Name.xlsx"), [{ month: 9, beYear: null }]);
  assert.deepEqual(periodsInFilenameLoose("p4p_Sep69.xlsx"), [{ month: 9, beYear: null }]);
  assert.deepEqual(periodsInFilenameLoose("P4P_sep_2569.xlsx"), [{ month: 9, beYear: 2569 }]);
  assert.deepEqual(periodsInFilenameLoose("Maybe_later.xlsx"), [], "May inside Maybe");
  assert.deepEqual(periodsInFilenameLoose("Decision_Oct.xlsx"), [{ month: 10, beYear: null }], "Dec inside Decision is not December");
  assert.deepEqual(periodsInFilenameLoose("P4P_aug_sep.xlsx").map((p) => p.month), [8, 9]);
  assert.deepEqual(periodsInFilenameLoose("P4P.xlsx"), []);
});

test("month words that are also nicknames, and day-number stamps, are not read as the file's month", () => {
  // "May"/"Jun"/"Jan"/"Mar"/"Apr" are given names; a stamp like 01Sep2569 is the day a file was saved.
  for (const f of ["P4P_Jun_Somsri.xlsx", "Dr.May_P4P.xlsx", "P4P_Jun-ya.xlsx", "P4P_Mar.xlsx", "P4P_Jan_Somchai.xlsx", "P4P_April_Aom.xlsx"]) {
    assert.deepEqual(periodsInFilenameLoose(f), [], f);
  }
  // …unless "month"/"เดือน" precedes the word. A year beside it is NOT enough: "Dr.Jun_2569" is a person and a year.
  assert.deepEqual(periodsInFilenameLoose("P4P_month_Mar_X.xlsx"), [{ month: 3, beYear: null }]);
  assert.deepEqual(periodsInFilenameLoose("P4P_เดือน_May_2569.xlsx"), [{ month: 5, beYear: 2569 }]);
  for (const f of ["P4P_May_2569.xlsx", "Dr.Jun_2569_P4P.xlsx", "P4P_2569_Jun_Somsri.xlsx", "March_Somsri.xlsx"]) {
    assert.deepEqual(periodsInFilenameLoose(f), [], f);
  }
  // a day stamp: a day number before the word, or a single digit right after it
  for (const f of ["P4P_Somchai_01Sep2569.xlsx", "P4P_Sep_1_2569.xlsx", "P4P_1-Sep_X.xlsx", "P4P_15_Aug_X.xlsx", "P4P_Oct1.xlsx", "P4P_Sep_5.xlsx", "P4P_Sep3_v2.xlsx", "P4P_Sep.2.xlsx"]) {
    assert.deepEqual(periodsInFilenameLoose(f), [], f);
  }
  // an untrusted token spoils the whole reading: it is a refusal, not a word to skip
  assert.deepEqual(periodsInFilenameLoose("P4P_Jun_Somsri_Sep.xlsx"), []);
});

const AUG_SEP_MAIL = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน Intern", workbookCount: 2 };

test("the Oct-8 incident: two files, each carrying its month as a Latin word", () => {
  const siblings = ["P4P-Intern_sep_X.xlsx", "P4P-Intern_aug_X.xlsx"];
  assert.deepEqual(decide({ ...AUG_SEP_MAIL, filename: siblings[0], siblings }), ok(9, 2569, "own_file_latin"));
  assert.deepEqual(decide({ ...AUG_SEP_MAIL, filename: siblings[1], siblings }), ok(8, 2569, "own_file_latin"));
});

test("refused: a month the mail did not name, a nickname that collides, a duplicate month", () => {
  const nick = ["P4P_May_1.xlsx", "P4P_May_2.xlsx"];
  for (const f of nick) assert.equal(decide({ subject: "ส่ง P4P เดือนพฤษภาคม มิถุนายน", workbookCount: 2, filename: f, siblings: nick }).kind, "ambiguous", f);
  const dup = ["P4P_aug_X.xlsx", "P4P_aug_X (1).xlsx"];
  for (const f of dup) assert.equal(decide({ ...AUG_SEP_MAIL, filename: f, siblings: dup }).kind, "ambiguous", f);
  const notNamed = ["P4P_May_X.xlsx", "P4P_sep_X.xlsx"];
  assert.equal(decide({ ...AUG_SEP_MAIL, filename: notNamed[0], siblings: notNamed }).kind, "ambiguous");
  const mixed = ["P4P สิงหาคม.xlsx", "x_aug_y.xlsx"];
  assert.equal(decide({ ...AUG_SEP_MAIL, filename: mixed[1], siblings: mixed }).kind, "ambiguous", "Latin file colliding with a Thai-named one");
  assert.deepEqual(decide({ ...AUG_SEP_MAIL, filename: mixed[0], siblings: mixed }), ok(8, null, "own_file"), "the Thai-named one is unchanged");
});

test("a two-digit year in the file or mail means the year is NOT silently supplied from the send date", () => {
  const files = ["P4P_jul_68_X.xlsx", "P4P_aug_68_Y.xlsx"];
  assert.equal(decide({ subject: "ส่ง P4P เดือนกรกฎาคม สิงหาคม", workbookCount: 2, filename: files[0], siblings: files }).kind, "ambiguous");
  // …while the same mail with no year signal anywhere still resolves
  const clean = ["P4P_jul_X.xlsx", "P4P_aug_Y.xlsx"];
  assert.deepEqual(decide({ subject: "ส่ง P4P เดือนกรกฎาคม สิงหาคม", workbookCount: 2, filename: clean[0], siblings: clean }), ok(7, 2569, "own_file_latin"));
});

test("the year comes from the file or the mail; a disagreement refuses; Dec/Jan needs the mail's years", () => {
  const mail = [{ month: 8, beYear: 2569 }, { month: 9, beYear: 2569 }];
  assert.deepEqual(ownPeriodOfFile("P4P_sep_X.xlsx", mail, OCT_2569), { month: 9, beYear: 2569, loose: true });
  assert.equal(ownPeriodOfFile("P4P_sep_X.xlsx", mail, null), null, "without a send date no year can be checked");
  assert.equal(ownPeriodOfFile("P4P_sep_2568.xlsx", mail, OCT_2569), null);
  const decJan = [{ month: 12, beYear: null }, { month: 1, beYear: null }];
  assert.equal(ownPeriodOfFile("P4P_dec_X.xlsx", decJan, JAN_2570), null, "December sent in January: whose year?");
  assert.equal(ownPeriodOfFile("P4P_jan_X.xlsx", decJan, JAN_2570), null, "…and a bare 'jan' could be a nickname");
  const janFeb = [{ month: 1, beYear: null }, { month: 2, beYear: null }];
  const FEB_2570 = sendDate("2027-02-10T06:00:00Z")!;
  assert.deepEqual(ownPeriodOfFile("P4P_feb_X.xlsx", janFeb, FEB_2570), { month: 2, beYear: 2570, loose: true, guessed: true }, "no year anywhere: the send year, marked as a guess");
  const withYears = [{ month: 12, beYear: 2569 }, { month: 1, beYear: 2570 }];
  assert.deepEqual(ownPeriodOfFile("P4P_dec_X.xlsx", withYears, JAN_2570), { month: 12, beYear: 2569, loose: true });
  assert.equal(ownPeriodOfFile("P4P_sep_X.xlsx", [{ month: 8, beYear: null }, { month: 9, beYear: null }], null), null, "no year and no send date");
});

test("strict files are untouched; a lone sibling list is the file itself", () => {
  assert.deepEqual(ownPeriodOfFile("P4P ก.ค. 2569.xlsx", [{ month: 8, beYear: null }, { month: 9, beYear: null }], OCT_2569), { month: 7, beYear: 2569, loose: false });
  assert.equal(ownPeriodOfFile("P4P สิงหาคม กันยายน.xlsx", [{ month: 8, beYear: null }, { month: 9, beYear: null }], OCT_2569), null);
  assert.equal(decideMultiMonthFile("P4P_aug_X.xlsx", [{ month: 8, beYear: null }, { month: 9, beYear: null }], [], OCT_2569).ok, true);
});

test("no month anywhere is still no_period, and an untouched ambiguity names the periods as pooled", () => {
  assert.deepEqual(decide({ subject: "ส่งไฟล์ครับ" }), { kind: "none" });
  const r = decide({ subject: "P4P สิงหาคม กันยายน", workbookCount: 1 });
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual((r as { named: unknown }).named, statedPeriods("x.xlsx", "P4P สิงหาคม กันยายน", "").periods);
});

test("a year that only the filename gave must fit the send date", () => {
  const mail = [{ month: 8, beYear: null }, { month: 9, beYear: null }];
  assert.deepEqual(ownPeriodOfFile("P4P_sep_2569.xlsx", mail, OCT_2569), { month: 9, beYear: 2569, loose: true });
  assert.equal(ownPeriodOfFile("P4P_sep_2570.xlsx", mail, OCT_2569), null, "next year");
  assert.equal(ownPeriodOfFile("P4P_sep_2568.xlsx", mail, OCT_2569), null, "last year's September");
  assert.equal(ownPeriodOfFile("P4P_sep_2569.xlsx", mail, null), null, "no send date to check it against");
  const dated = [{ month: 8, beYear: 2568 }, { month: 9, beYear: 2568 }];
  assert.equal(ownPeriodOfFile("P4P_sep_2568.xlsx", dated, OCT_2569), null, "…and a year the MAIL wrote is checked too: last September is not an October report");
  const datedOk = [{ month: 8, beYear: 2569 }, { month: 9, beYear: 2569 }];
  assert.deepEqual(ownPeriodOfFile("P4P_sep_2569.xlsx", datedOk, OCT_2569), { month: 9, beYear: 2569, loose: true });
});

test("a month or year that only quoted history states does not unlock a Latin filename month", () => {
  const siblings = ["P4P-Intern_sep_X.xlsx", "P4P-Intern_aug_X.xlsx"];
  // Today's pooled reading sees Aug + Sep (so the strict rules refuse); the September ONLY appears in the quote.
  const quoted = decide({ subject: "Re: P4P เดือนสิงหาคม", body: "แนบไฟล์ครับ\n\nOn Monday, X <x@example.com> wrote:\n> ส่ง P4P กันยายน 2568", workbookCount: 2, filename: siblings[0], siblings });
  assert.ok(neverTheQuote(quoted, { month: 8, beYear: null }), "September lives only in the quote");
  // A year that only the quote gives is never borrowed for a month the sender did name — and its presence
  // makes the year unreadable, so the answer is a refusal rather than a silent fall-back to the send year.
  const yearQuoted = decide({ subject: "Re: P4P เดือนสิงหาคม กันยายน", body: "แนบไฟล์ครับ\n\nOn Monday, X <x@example.com> wrote:\n> ส่ง P4P กันยายน 2568", workbookCount: 2, filename: siblings[0], siblings });
  assert.equal(yearQuoted.kind, "ambiguous");
  // control: the same mail with nothing year-like in the quote resolves, on the send year
  const clean = decide({ subject: "Re: P4P เดือนสิงหาคม กันยายน", body: "แนบไฟล์ครับ\n\nOn Monday, X <x@example.com> wrote:\n> ส่ง P4P กันยายน", workbookCount: 2, filename: siblings[0], siblings });
  assert.deepEqual(clean, ok(9, 2569, "own_file_latin"));
});

// ── the Latin path never routes on a year that something else contradicts ──

test("a year in Thai digits, in two-digit form, or in a date-like number blocks the Latin reading", () => {
  const sib = ["P4P_sep_X.xlsx", "P4P_aug_Y.xlsx"];
  const run = (subject: string, files = sib) => decide({ subject, workbookCount: 2, filename: files[0], siblings: files });
  assert.deepEqual(run("ส่ง P4P เดือนสิงหาคม กันยายน"), ok(9, 2569, "own_file_latin"), "control: no year signal at all");
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน ๒๕๖๘").kind, "ambiguous", "Thai-digit 2568");
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน ๖๘").kind, "ambiguous", "Thai-digit short 68");
  assert.equal(run("ส่ง P4P เดือนสิงหาคม ก.ย. 68").kind, "ambiguous", "short 68");
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน 2568").kind, "ambiguous", "last year");
  // a file that spells its own year differently from the mail's
  const f2 = ["P4P_sep_2569_X.xlsx", "P4P_aug_Y.xlsx"];
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน ๒๕๖๘", f2).kind, "ambiguous", "file says 2569, mail (Thai digits) says 2568");
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน 68", f2).kind, "ambiguous", "file says 2569, mail says 68");
  // a date-like run in the file name is a second year reading
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน", ["P4P_sep_09.69_X.xlsx", "P4P_aug_Y.xlsx"]).kind, "ambiguous");
  // a file name year in Thai digits is read as a year, too
  assert.equal(periodsInFilenameLoose("P4P_sep_๒๕๖๙.xlsx")[0]?.beYear, 2569);
  assert.equal(run("ส่ง P4P เดือนสิงหาคม กันยายน 2569", ["P4P_sep_๒๕๖๘.xlsx", "P4P_aug_Y.xlsx"]).kind, "ambiguous");
});

test("a December report sent in January: the January file is not filed under last year", () => {
  const JAN_2026 = "2026-01-10T06:00:00Z";                         // BE 2569, month 1
  const sib = ["P4P_dec_X.xlsx", "P4P_jan_2569.xlsx"];
  const subject = "ส่ง P4P ธ.ค. 2568 และ ม.ค.";
  const dec = decide({ subject, workbookCount: 2, filename: sib[0], siblings: sib, emailDate: JAN_2026 });
  assert.deepEqual(dec, ok(12, 2568, "own_file_latin"), "December carries the year the mail wrote for it");
  const jan = decide({ subject, workbookCount: 2, filename: sib[1], siblings: sib, emailDate: JAN_2026 });
  assert.equal(jan.kind, "ambiguous", "the file says 2569, the mail says 2568 for the other month: not guessable");
});

test("a year the MAIL wrote must be plausible for the send date too", () => {
  const sib = ["P4P_sep_X.xlsx", "P4P_aug_Y.xlsx"];
  // both months explicitly 2568, sent in October 2569: a year late is not something to file silently
  assert.equal(decide({ subject: "ส่ง P4P สิงหาคม 2568 กันยายน 2568", workbookCount: 2, filename: sib[0], siblings: sib }).kind, "ambiguous");
  // a month that has not happened yet
  assert.equal(decide({ subject: "ส่ง P4P สิงหาคม 2569 ธันวาคม 2569", workbookCount: 2, filename: "P4P_dec_X.xlsx", siblings: ["P4P_dec_X.xlsx", "P4P_aug_Y.xlsx"] }).kind, "ambiguous");
});

test("the Latin reading needs every workbook of the message to be known", () => {
  const mail = [{ month: 8, beYear: null }, { month: 9, beYear: null }];
  assert.deepEqual(decideMultiMonthFile("P4P_aug_X.xlsx", mail, ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"], OCT_2569, [], 2), { ok: true, month: 8, beYear: 2569, loose: true });
  assert.deepEqual(decideMultiMonthFile("P4P_aug_X.xlsx", mail, ["P4P_aug_X.xlsx"], OCT_2569, [], 2), { ok: false, reason: "siblings_unknown" });
  assert.deepEqual(decideMultiMonthFile("P4P_aug_X.xlsx", mail, ["P4P_sep_X.xlsx", "P4P_oct_X.xlsx"], OCT_2569, [], 2), { ok: false, reason: "siblings_unknown" }, "the file itself must be among them");
});

test("a year taken from the send date collides with a same-month sibling of ANY year", () => {
  const mail = [{ month: 8, beYear: null }, { month: 9, beYear: null }];
  // loose sibling guessed Sep 2569; the other file is strict September of last year
  const r = decideMultiMonthFile("P4P_sep_X.xlsx", mail, ["P4P_sep_X.xlsx", "P4P ก.ย. 2568.xlsx"], OCT_2569, [], 2);
  assert.equal(r.ok, false);
  // …a sibling that merely states a different year, in another month, also contradicts a guessed one
  assert.deepEqual(decideMultiMonthFile("P4P_sep_X.xlsx", mail, ["P4P_sep_X.xlsx", "P4P_aug_2568_Y.xlsx"], OCT_2569, [], 2), { ok: false, reason: "sibling_year" });
});

test("a headerless Outlook block, a wrapped Thai attribution and an HTML quote are all cut from the sender's own text", () => {
  assert.equal(senderOwnText("ส่งแล้วครับ\nจาก: คุณสมชาย\nส่งเมื่อ: 4 กันยายน 2568\nถึง: เรา\nเรื่อง: P4P กันยายน 2568").trim(), "ส่งแล้วครับ");
  assert.equal(senderOwnText("ส่งแล้วครับ\nFrom: Dr X\nSent: Thursday, September 4, 2025\nSubject: P4P September 2568").trim(), "ส่งแล้วครับ");
  assert.equal(senderOwnText("ส่งแล้วครับ\nในวัน พฤ. 4 ก.ย. 2568\nเวลา 10:00 น. คุณสมชาย <x@y.com>\nเขียนว่า:\n> ข้อความเดิม").trim(), "ส่งแล้วครับ", "wrapped Thai attribution");
  assert.equal(senderOwnText('<div>ส่งแล้วครับ</div><div class="gmail_quote"><div>On Thu, X wrote:</div><blockquote>P4P กันยายน 2568</blockquote></div>').replace(/\s+/g, " ").trim(), "ส่งแล้วครับ");
  assert.equal(senderOwnText("<p>ส่งแล้วครับ</p><blockquote>P4P กันยายน 2568</blockquote><p>ขอบคุณ</p>").replace(/\s+/g, " ").trim(), "ส่งแล้วครับ ขอบคุณ");
  // an ordinary reply line "จาก:" in prose is not a header block
  assert.match(senderOwnText("จาก: เดือนนี้ส่งกันยายน"), /กันยายน/);
});

// ── the strict decision, frozen ──────────────────────────────────────────
// decideStrict is what processBuffer did before period-gate.ts existed (checked against that code
// with a fuzzer when it was written); these rows pin it so a later edit cannot drift unnoticed.

test("decideStrict: the processor's original period decision, as a table", () => {
  const P = (month: number, beYear: number | null) => ({ month, beYear });
  const rows: [string, ReturnType<typeof decideStrict>, ReturnType<typeof decideStrict>][] = [
    ["no period",                                      decideStrict([], 1, "x.xlsx"),                                  { kind: "none" }],
    ["one period, any workbook count",                 decideStrict([P(9, 2569)], 3, "x.xlsx"),                        ok(9, 2569, "single") as never],
    ["one yearless period",                            decideStrict([P(9, null)], 1, "x.xlsx"),                        ok(9, null, "single") as never],
    ["two periods, one workbook",                      decideStrict([P(8, 2569), P(9, 2569)], 1, "P4P ก.ย. 2569.xlsx"), { kind: "ambiguous", named: [P(8, 2569), P(9, 2569)] }],
    ["two periods, several workbooks, file names one", decideStrict([P(8, 2569), P(9, 2569)], 2, "P4P ก.ย. 2569.xlsx"), ok(9, 2569, "own_file") as never],
    ["two periods, several workbooks, file names none", decideStrict([P(8, 2569), P(9, 2569)], 2, "x.xlsx"),             { kind: "ambiguous", named: [P(8, 2569), P(9, 2569)] }],
    ["two periods, several workbooks, file names two", decideStrict([P(8, 2569), P(9, 2569)], 2, "P4P ส.ค. ก.ย..xlsx"), { kind: "ambiguous", named: [P(8, 2569), P(9, 2569)] }],
  ];
  for (const [label, actual, expected] of rows) assert.deepEqual(actual, expected, label);
});

// ── refusals the Latin path must keep, at the decision level ─────────────

test("the Latin reading refuses: two months in one file name, a month named twice, a single workbook, a CE year", () => {
  const mail = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน", workbookCount: 2 };
  const two = ["P4P_aug_sep.xlsx", "P4P_oct_X.xlsx"];
  assert.equal(decide({ ...mail, filename: two[0], siblings: two }).kind, "ambiguous", "two months in the name");
  const twice = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน 2568 และกันยายน 2569", workbookCount: 2 };
  const sib = ["P4P_sep_X.xlsx", "P4P_aug_Y.xlsx"];
  assert.equal(decide({ ...twice, filename: sib[0], siblings: sib }).kind, "ambiguous", "September stated for two different years: whose file is this?");
  assert.equal(decide({ ...mail, workbookCount: 1, filename: "P4P_sep_X.xlsx" }).kind, "ambiguous", "one workbook: nothing says which month it is");
  const ce = ["P4P_sep_2026_X.xlsx", "P4P_aug_Y.xlsx"];
  assert.deepEqual(decide({ ...mail, filename: ce[0], siblings: ce }), ok(9, 2569, "own_file_latin"), "CE 2026 is BE 2569: consistent");
  const ceOld = ["P4P_sep_2025_X.xlsx", "P4P_aug_Y.xlsx"];
  assert.equal(decide({ ...mail, filename: ceOld[0], siblings: ceOld }).kind, "ambiguous", "CE 2025 is BE 2568: last year's September");
});

test("a Thai attribution that wraps over lines is cut, so its quoted month is not the sender's", () => {
  const siblings = ["P4P-Intern_sep_X.xlsx", "P4P-Intern_aug_X.xlsx"];
  const body = "ส่งใหม่ครับ\nในวัน พฤ. 4 ก.ย. 2568\nเวลา 10:00 น. คุณสมชาย <x@y.com>\nเขียนว่า:\n> ส่ง P4P กันยายน 2568";
  const r = decide({ subject: "Re: P4P เดือนสิงหาคม", body, workbookCount: 2, filename: siblings[0], siblings });
  assert.equal(r.kind, "ambiguous", "September lives only in the quote");
});

test("senderOwnText stays linear on hostile bodies (any sender can mail us)", () => {
  const t0 = Date.now();
  senderOwnText("<div".repeat(60_000));                                    // tags that never close
  senderOwnText("<blockquote>".repeat(30_000) + " ส่ง P4P กันยายน");        // unclosed, nested
  senderOwnText("> quoted\n".repeat(150_000) + "ส่ง P4P กันยายน 2569");     // a very long quoted history
  senderOwnText(("From: x\n").repeat(100_000));                            // header lookalikes
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(senderOwnText("> quoted\n".repeat(5) + "ส่ง P4P กันยายน 2569").trim(), "ส่ง P4P กันยายน 2569");
});

test("HTML quote handling: nested blockquotes, an unclosed one, entities, Outlook web", () => {
  const flat = (b: string) => senderOwnText(b).replace(/\s+/g, " ").trim();
  assert.equal(flat("<p>ก่อน</p><blockquote>a<blockquote>b</blockquote>c</blockquote><p>หลัง</p>"), "ก่อน หลัง");
  assert.equal(flat("<p>ก่อน</p><blockquote>ไม่ปิด P4P กันยายน 2568"), "ก่อน");
  assert.equal(flat('<div>ส่งแล้ว</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: x<br>P4P กันยายน 2568</div>'), "ส่งแล้ว");
  assert.equal(flat("ส่ง&nbsp;P4P&nbsp;กันยายน&nbsp;2569<br>ขอบคุณ"), "ส่ง P4P กันยายน 2569 ขอบคุณ");
  assert.equal(flat("<p>ส่งแล้ว</p><p>&gt; P4P กันยายน 2568</p>"), "ส่งแล้ว", "a '>' that arrived as an entity is still a quote marker");
});

// ── round 3: what a year can hide behind ─────────────────────────────────

const LATIN_MAIL = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน", workbookCount: 2 };
const latin = (files: string[], over: Parameters<typeof decide>[0] = {}) =>
  decide({ ...LATIN_MAIL, filename: files[0], siblings: files, ...over });

test("a compact date stamp hides a year in one digit run — in the file name or in the mail", () => {
  const aug = "P4P_aug_X.xlsx";
  assert.deepEqual(latin(["P4P_sep_X.xlsx", aug]), ok(9, 2569, "own_file_latin"), "control");
  for (const f of ["P4P_sep_30092568.xlsx", "P4P_sep_20250930.xlsx", "P4P_sep_202509.xlsx", "P4P_sep_300925.xlsx", "P4P_sep_123.xlsx", "P4P_sep_12345.xlsx"]) {
    assert.equal(latin([f, aug]).kind, "ambiguous", f);
  }
  // the same stamps in the subject or body
  for (const stamp of ["30092568", "20250930", "202509", "300925"]) {
    assert.equal(latin(["P4P_sep_X.xlsx", aug], { subject: `${LATIN_MAIL.subject} ${stamp}` }).kind, "ambiguous", `subject ${stamp}`);
    assert.equal(latin(["P4P_sep_X.xlsx", aug], { body: `ไฟล์ IMG_${stamp}_x` }).kind, "ambiguous", `body ${stamp}`);
  }
  // a run of any other length (a phone number) is not a date stamp
  assert.deepEqual(latin(["P4P_sep_X.xlsx", aug], { body: "โทร 0812345678" }), ok(9, 2569, "own_file_latin"));
});

test("a year given as two digits beside a month in the BODY, or as d/m/yy or FY, blocks the Latin reading", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  for (const body of ["Aug 25, Sep 25 attached", "ส.ค. 25 ก.ย. 25", "ก.ย.'25", "Sep-25", "FY25", "30/9/25", "ส.ค. ปี 68"]) {
    assert.equal(latin(files, { body }).kind, "ambiguous", body);
  }
});

test("a sender who corrects, cancels or disowns a month is not simply naming it", () => {
  const files = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"];
  for (const subject of [
    "ส่งแก้ไข P4P ก.ย. (ส.ค. ผิด)", "P4P September (not August)", "Please ignore the Sep file P4P August",
    "ไฟล์ ส.ค. แนบมาผิด กรุณาข้ามไป ก.ย.", "P4P Aug Sep revised",
  ]) assert.equal(latin(files, { subject }).kind, "ambiguous", subject);
  assert.equal(latin(files, { subject: "ส่ง P4P ส.ค. ก.ย." }).kind, "ok", "control");
});

test("a year said in words — last year, ปีที่แล้ว — is a year no digit states", () => {
  const files = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"];
  for (const subject of ["ส่ง P4P เดือนสิงหาคม กันยายน ของปีที่แล้ว", "P4P Aug Sep of last year", "P4P สิงหาคม กันยายน ปีงบ"]) {
    assert.equal(latin(files, { subject }).kind, "ambiguous", subject);
  }
  // collapse too: the yearless side says "last year"
  assert.equal(decide({ subject: "Re: กันยายน 2026", body: "ส่ง September ปีที่แล้ว" }).kind, "ambiguous");
});

test("a Thai month glued into the file name that the strict reader skipped must not disagree with the Latin word", () => {
  const files = ["ผลงานกรกฎาคม_aug.xlsx", "ผลงานกรกฎาคมและ_sep.xlsx"];
  for (const f of files) assert.equal(latin(files, { filename: f }).kind, "ambiguous", f);
  assert.deepEqual(latin(["ผลงานกันยายน_sep.xlsx", "P4P_aug_X.xlsx"]), ok(9, 2569, "own_file_latin"), "the same month in both scripts agrees");
});

test("collapse for SEVERAL workbooks: no file name may say another month", () => {
  const mail = { subject: "P4P สิงหาคม", body: "ส่ง P4P ของเดือนสิงหาคม 2569 ครับ", workbookCount: 2 };
  const sibs = ["P4P-Intern_aug_ICU.xlsx", "P4P-Intern_sep_ICU.xlsx"];
  for (const f of sibs) assert.equal(decide({ ...mail, filename: f, siblings: sibs }).kind, "ambiguous", f);
  // the Latin 'Sept' the strict reader cannot see
  const sept = ["P4P_june_X.xlsx", "P4P_Sept_X.xlsx"];
  assert.equal(decide({ subject: "P4P มิถุนายน", body: "ส่ง P4P มิถุนายน 2569", workbookCount: 2, filename: sept[1], siblings: sept }).kind, "ambiguous");
  // files that are silent about the month, or all agree with it, take the mail's month — as a one-period mail always did
  const quiet = ["สมชาย.xlsx", "สมหญิง.xlsx"];
  assert.deepEqual(decide({ ...mail, filename: quiet[0], siblings: quiet }), ok(8, 2569, "collapsed"));
  // an unknown sibling is a refusal
  assert.equal(decide({ ...mail, filename: quiet[0], siblings: [quiet[0]] }).kind, "ambiguous");
});

test("quoted-history shapes that used to leak into the sender's own text", () => {
  const own = (b: string) => senderOwnText(b).replace(/\s+/g, " ").trim();
  assert.equal(own("ส่งไฟล์ ส.ค. ครับ\n---- On Thu, 01 Oct 2026 16:32:00 +0700 X<x@example.com> wrote ----\nP4P ตุลาคม"), "ส่งไฟล์ ส.ค. ครับ", "Zoho");
  assert.equal(own("ส่งแล้ว\nOn Thu, X <x@example.com> wrote:\u200E\n> P4P กันยายน 2568"), "ส่งแล้ว", "invisible mark after the colon");
  assert.equal(own("ส่งแล้ว\nOn Thu, X <x@example.com> wrote :\n> P4P กันยายน 2568"), "ส่งแล้ว", "space before the colon");
  assert.equal(own("ส่งแล้ว\nในวัน พฤ. คุณสมชาย <x@example.com> เขียนไว้ว่า:\n> P4P กันยายน 2568"), "ส่งแล้ว", "เขียนไว้ว่า");
  assert.equal(own("ส่งแล้ว\n-----ข้อความต้นฉบับ-----\nP4P กันยายน 2568"), "ส่งแล้ว");
  assert.equal(own("ส่งแล้ว\nคุณสมชาย <x@example.com> 4 ก.ย. 2568 10:00\nP4P กันยายน 2568"), "ส่งแล้ว", "an address beside a date");
  assert.equal(own('<div>ส่งแล้ว</div><div class="yahoo_quoted"><div>P4P กันยายน 2568</div></div>'), "ส่งแล้ว", "yahoo_quoted");
});

test("the generous readings are skipped for an enormous body, and stay fast for a long one", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  assert.equal(latin(files, { body: "x\n".repeat(20_000) }).kind, "ok", "a long body (40k characters) is read");
  assert.equal(latin(files, { body: "x".repeat(60_000) }).kind, "ambiguous", "an enormous one is not");
  const t0 = Date.now();
  decide({ subject: "P4P เดือนกันยายน 2569", body: "ส่ง กันยายน" + "\nx".repeat(24_000) });
  assert.ok(Date.now() - t0 < 3000, `collapse took ${Date.now() - t0} ms`);
});

// ── the remaining Latin-reading conditions, one test each ────────────────

test("two files claiming the same month refuse each other, with years stated or not", () => {
  const dup = ["P4P_aug_X.xlsx", "P4P_aug_Y.xlsx"];
  for (const f of dup) {
    assert.equal(decide({ subject: "ส่ง P4P สิงหาคม 2569 กันยายน 2569", workbookCount: 2, filename: f, siblings: dup }).kind, "ambiguous", `years stated: ${f}`);
    assert.equal(decide({ subject: "ส่ง P4P สิงหาคม กันยายน", workbookCount: 2, filename: f, siblings: dup }).kind, "ambiguous", `years guessed: ${f}`);
  }
  // an Excel owner file attached beside the real one is not a second claim — and does not make one workbook "several"
  const withLock = ["P4P_aug_X.xlsx", "~$P4P_aug_X.xlsx"];
  assert.equal(decide({ subject: "ส่ง P4P สิงหาคม กันยายน", workbookCount: 2, filename: withLock[0], siblings: withLock }).kind, "ambiguous");
  const threeWithLock = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx", "~$P4P_aug_X.xlsx"];
  assert.deepEqual(decide({ subject: "ส่ง P4P สิงหาคม กันยายน", workbookCount: 3, filename: threeWithLock[0], siblings: threeWithLock }), ok(8, 2569, "own_file_latin"), "…but two real ones beside it are");
});

test("a month that only a quote names, with no year in it, does not unlock a file", () => {
  const sib = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  const r = decide({ subject: "Re: P4P เดือนสิงหาคม", body: "แนบไฟล์ครับ\n\nOn Monday, X <x@example.com> wrote:\n> ส่ง P4P กันยายน", workbookCount: 2, filename: sib[0], siblings: sib });
  assert.ok(neverTheQuote(r, { month: 8, beYear: null }));
});

test("the word reader's edges", () => {
  const sib = (f: string) => [f, "P4P_aug_Z.xlsx"];
  const d = (f: string) => latin(sib(f), { filename: f });
  assert.equal(d("P4P สิงหาคม กันยายน_sep.xlsx").kind, "ambiguous", "the strict reader already finds two months: nothing for the Latin one to do");
  assert.equal(d("P4P_Thansep_X.xlsx").kind, "ambiguous", "a letter before the word: not a word");
  assert.equal(d("P4P_june_X.xlsx").kind, "ambiguous", "name-like word without a marker");
  assert.deepEqual(d("P4P_Sept_X.xlsx"), ok(9, 2569, "own_file_latin"), "'Sept' is September");
  assert.equal(d("P4P_sep_26_X.xlsx").kind, "ambiguous", "a short year with no stated year to check it against is not placed");
  const dated = (f: string) => latin(sib(f), { filename: f, subject: `${LATIN_MAIL.subject} 2569` });
  assert.deepEqual(dated("P4P_sep_26_X.xlsx"), ok(9, 2569, "own_file_latin"), "…but one that agrees with the stated year is fine (26 = 2026 = 2569)");
  assert.equal(dated("P4P_sep_25_X.xlsx").kind, "ambiguous", "…and one that does not is not (25 = 2025 = 2568)");
});

// ── round 4 ──────────────────────────────────────────────────────────────

test("padded text cannot make the scan slow (a 3 KB mail used to hang the run for minutes)", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  const t0 = Date.now();
  for (const body of [
    "wrote" + " ".repeat(20_000) + "x", "Sep" + " ".repeat(20_000) + "x", "ก.ย." + " ".repeat(20_000) + "x",
    "Aug" + "\t".repeat(20_000) + "x", "From:" + " ".repeat(20_000), ("wrote" + " ".repeat(300) + "\n").repeat(100),
    "Sep" + " \n".repeat(10_000) + "25",
  ]) latin(files, { body });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("what the sender typed BELOW a quote or a header block still counts for the vetoes", () => {
  const files = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"];
  const quote = "On Mon, A <a@example.com> wrote:\n> กรุณาส่ง P4P\n";
  assert.equal(latin(files, { body: `${quote}ส่งแล้วครับ ไม่ใช่ของสิงหาคม ยกเลิกไฟล์ aug` }).kind, "ambiguous", "negation below the quote");
  assert.equal(latin(files, { body: `${quote}ส่งของปีที่แล้วครับ` }).kind, "ambiguous", "relative year below the quote");
  assert.equal(latin(files, { body: "จาก: x\nถึง: y\nเรื่อง: z\nขอยกเลิกไฟล์เดือนสิงหาคม ไม่ใช่เดือนนี้" }).kind, "ambiguous", "below a memo block");
  assert.equal(latin(files, { body: `${quote}ส่งแล้วครับ` }).kind, "ok", "control: a plain bottom-posted reply");
});

test("the vocabularies of correction and of relative years", () => {
  const files = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"];
  const sub = (extra: string) => latin(files, { subject: `${LATIN_MAIL.subject} ${extra}` }).kind;
  for (const x of ["มิใช่สิงหาคม", "isn't สิงหาคม", "ไม่ได้ส่งสิงหาคม", "เปลี่ยนไฟล์", "อัพเดท", "อัปเดต", "re-send", "ไฟล์ใหม่", "amended", "fixed", "void", "ลบไฟล์เก่า",
    "ไม่เอา", "ยกเว้น", "excluding Aug", "except Aug", "ไม่รวม", "ที่ถูกต้อง", "ขออภัย", "ปีกลาย", "ปีที่เเล้ว", "last Sep", "a year ago", "year before", "ปีเก่า", "ปี\u200Bที่แล้ว"]) {
    assert.equal(sub(x), "ambiguous", x);
  }
  assert.equal(sub(""), "ok", "control");
  assert.equal(sub("Intern ICU"), "ok", "'Intern' is not 'n't'");
});

test("a two-digit CE year written in the BODY, however it is labelled", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  for (const body of ["ปี 25", "ปี25", "(09/25)", "9/25", "'25", "ค.ศ. 25", "พ.ศ. 25", "year 25", "Q3/25"]) {
    assert.equal(latin(files, { body }).kind, "ambiguous", body);
  }
});

test("one mail-wide month for several files: numeric months, typos and codes in the other file names", () => {
  const mail = { subject: "P4P กันยายน", body: "ส่ง กันยายน 2569 ครับ", workbookCount: 2 };
  const pairs: [string, string][] = [
    ["P4P_Dr1_sep.xlsx", "P4P_2569_08.xlsx"], ["P4P_Dr1_sep.xlsx", "P4P_Dr1_08.xlsx"], ["P4P_Dr1_sep.xlsx", "P4P_08-2569.xlsx"], ["P4P_Dr1_sep.xlsx", "P4P_Q2.xlsx"],
    ["สมชาย.xlsx", "Augest.xlsx"], ["สมชาย.xlsx", "Agust.xlsx"], ["สมชาย.xlsx", "Febuary.xlsx"], ["สมชาย.xlsx", "Octo.xlsx"], ["สมชาย.xlsx", "Decmber.xlsx"],
    ["สมชาย.xlsx", "Novembr.xlsx"], ["สมชาย.xlsx", "สมหญิง_แก้ไข.xlsx"], ["สมชาย.xlsx", "สมหญิง_2568.xlsx"], ["สมชาย.xlsx", "สมหญิง_68.xlsx"], ["สมชาย.xlsx", "สมหญิง_123.xlsx"],
    ["สมชาย.xlsx", "สมหญิง_กค.xlsx"],
  ];
  for (const sibs of pairs) assert.equal(decide({ ...mail, filename: sibs[0], siblings: sibs }).kind, "ambiguous", sibs.join(" + "));
  const quiet = ["สมชาย.xlsx", "สมหญิง_2569.xlsx"];
  assert.deepEqual(decide({ ...mail, filename: quiet[0], siblings: quiet }), ok(9, 2569, "collapsed"), "silent file names, or ones that agree, are fine");
});

test("quoted history that used to leak into the sender's own text", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  const own = "ส่งของสิงหาคมครับ";
  const quoted = "กรุณาส่ง P4P กันยายน";
  const cases: [string, string][] = [
    ["blockquote with a very long attribute", `<div>${own}</div><blockquote ${'data-x="' + "a".repeat(3000) + '"'}>${quoted}</blockquote>`],
    ["gmail_quote class without quotes", `<div>${own}</div><div class=gmail_quote><div>${quoted}</div></div>`],
    ["Outlook block with blank lines", `${own}\n\nFrom: A\n\n\n\n\nSent: Monday\nSubject: x\n${quoted}`],
    ["pipe-quoted", `${own}\n| ${quoted}`],
    ["German attribution", `${own}\nAm Mo., 5. Okt. 2026 schrieb A <a@example.com>:\n${quoted}`],
  ];
  for (const [label, body] of cases) assert.equal(latin(files, { subject: "Re: P4P สิงหาคม", body }).kind, "ambiguous", label);
});

test("a save date in the sender's own text is not a month they are reporting", () => {
  const files = ["P4P_oct_Z.xlsx", "P4P_sep_Q.xlsx"];
  const r = decide({ subject: "ส่ง P4P เดือนกันยายน", body: "ส่งเมื่อวันที่ 2 ตุลาคม 2569 ครับ", workbookCount: 2, filename: files[0], siblings: files });
  assert.equal(r.kind, "ambiguous");
});

test("correction or year words in a file name are evidence too", () => {
  for (const f of ["P4P_sep_ปีที่แล้ว.xlsx", "P4P_sep_lastyear.xlsx", "P4P_sep_old.xlsx", "P4P_sep_แก้ไข.xlsx", "P4P_sep_revised.xlsx", "P4P_sep_ปีก่อน.xlsx"]) {
    assert.equal(latin([f, "P4P_aug_X.xlsx"]).kind, "ambiguous", f);
  }
  assert.equal(latin(["P4P_sep_X.xlsx", "P4P_aug_แก้ไข.xlsx"]).kind, "ambiguous", "…and a sibling's too");
});

test("Gmail's own receive time overrules a Date header that is days off", () => {
  const files = ["P4P_sep_X.xlsx", "P4P_aug_X.xlsx"];
  const base = { ...LATIN_MAIL, filename: files[0], siblings: files };
  const call = (receivedDate: string | null) => decideStatedPeriod({
    stated: statedPeriods(files[0]!, LATIN_MAIL.subject, ""), subject: LATIN_MAIL.subject, body: "", filename: files[0]!,
    workbookCount: 2, siblingFilenames: files, emailDate: OCT_2026, receivedDate,
  }).kind;
  void base;
  assert.equal(call("2026-10-02T09:00:00Z"), "ok", "within hours: fine");
  assert.equal(call("2026-10-20T09:00:00Z"), "ambiguous", "received 18 days later: the header's date is not trusted");
  assert.equal(call(null), "ok", "no receive time: the header alone, as before");
});

// ── round 5 ──────────────────────────────────────────────────────────────

test("the same-month collapse is stopped by correction wording and by any other year reading", () => {
  const collapse = (subject: string, body: string) => decide({ subject, body }).kind;
  assert.equal(collapse("P4P กันยายน 2569", "ส่งเดือนกันยายน"), "ok", "control");
  for (const body of ["ไม่ใช่เดือนกันยายน", "ขออภัยครับ ส่งผิดเดือนกันยายน", "Please ignore the September file", "this is NOT the September report", "Sorry, wrong file - not for September"]) {
    assert.equal(collapse("Re: P4P กันยายน 2569", body), "ambiguous", body);
  }
  for (const line of ["ข้อมูลปี 25", "Q3/25", "9/25", "09-25", "'25", "ค.ศ. 25", "ref 25680930", "พ.ศ. 68"]) {
    assert.equal(collapse("P4P กันยายน 2569", `ส่งเดือนกันยายน\n${line}`), "ambiguous", line);
  }
});

test("more correction wording, and the characters that hide it", () => {
  const files = ["P4P_sep_A.xlsx", "P4P_aug_B.xlsx"];
  const body = (b: string) => latin(files, { body: b }).kind;
  for (const b of ["Please change the Sep file to Aug", "the Sep file name is incorrect", "ชื่อไฟล์สลับกัน", "swap them", "I meant Aug", "should be August", "rather than September",
    "อย่าใช้ไฟล์ sep", "ห้ามใช้", "ถอนไฟล์ sep", "draft only", "ทดสอบ", "mislabeled", "wr­ong file", "⁦not⁩ this one", "ไ­ม่ใช่", "เเก้ไข"]) {
    assert.equal(body(b), "ambiguous", JSON.stringify(b));
  }
  assert.equal(body("<div>These aren&#39;t the right names</div>"), "ambiguous", "an HTML apostrophe entity");
  assert.equal(body("<div>These aren&rsquo;t the right names</div>"), "ambiguous");
  assert.equal(body("<div>แนบไฟล์ครับ</div>"), "ok", "control");
});

test("sibling names that talk about years veto a guessed year", () => {
  for (const sib of ["P4P_aug_ปีที่แล้ว.xlsx", "P4P_aug_lastyear.xlsx", "P4P_aug_ปีก่อน.xlsx", "P4P_aug_ปีงบ.xlsx", "P4P_aug_FY.xlsx", "P4P_aug_ค.ศ.xlsx"]) {
    assert.equal(latin(["P4P_sep.xlsx", sib]).kind, "ambiguous", sib);
  }
});

test("glued month words in the other file names stop one month being applied to all", () => {
  const mail = { subject: "P4P กันยายน 2569", body: "ส่งเดือนกันยายน", workbookCount: 2 };
  for (const other of ["ผลงานสค.xlsx", "ผลงานตค_นพ.xlsx", "AugSep.xlsx", "P4P_OctNov_X.xlsx"]) {
    const sibs = ["สมชาย.xlsx", other];
    assert.equal(decide({ ...mail, filename: sibs[0], siblings: sibs }).kind, "ambiguous", other);
  }
});

test("day stamps with ordinals or a comma, and a 'month' marker that is really part of a longer word", () => {
  for (const f of ["P4P_1st_Sep.xlsx", "P4P_Sep_26,2569.xlsx"]) assert.deepEqual(periodsInFilenameLoose(f), [], f);
  for (const f of ["P4P_smth_may.xlsx", "P4P_Bimonth_May.xlsx"]) assert.deepEqual(periodsInFilenameLoose(f), [], f);
  assert.deepEqual(periodsInFilenameLoose("P4P_month_May.xlsx"), [{ month: 5, beYear: null }]);
});

test("a quote introduced with markdown or an incomplete Thai attribution is still cut", () => {
  const own = (b: string) => senderOwnText(b).replace(/\s+/g, " ").trim();
  assert.equal(own("ส่ง P4P เดือนสิงหาคม\n*From:* Admin <admin@example.com>\n*Sent:* Monday\n\nกรุณาส่ง P4P เดือนกันยายน"), "ส่ง P4P เดือนสิงหาคม");
  assert.equal(own("ส่ง P4P เดือนสิงหาคม\n**From:** Admin\n**Sent:** Monday\n\nกรุณาส่ง P4P เดือนกันยายน"), "ส่ง P4P เดือนสิงหาคม");
  assert.equal(own("ส่ง P4P เดือนสิงหาคม\nเมื่อ 5 ต.ค. 2569 Admin เขียน:\nกรุณาส่ง P4P เดือนกันยายน"), "ส่ง P4P เดือนสิงหาคม");
});

test("a numeric body does not make the scan slow", () => {
  const t0 = Date.now();
  decide({ subject: "P4P กันยายน 2569", body: "ส่งเดือนก.ย." + "\n1".repeat(24_000) });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

// ── every quote-cutting pattern, pinned on its own ───────────────────────
// (each input is built so that ONLY the pattern under test can cut it)

test("senderOwnText: each plain-text cut pattern works alone", () => {
  const cuts: [string, string][] = [
    ["Outlook's rule",              "__________"],
    ["Apple's forwarded header",    "Begin forwarded message:"],
    ["From: with an address",       "From: Dr X <x@example.com>"],
    ["wrote:",                      "On Mon, Dr X wrote:"],
    ["schrieb",                     "Dr X schrieb:"],
    ["a écrit",                     "Le lun. Dr X a écrit :"],
    ["escribió",                    "El lun. Dr X escribió:"],
    ["scritto",                     "Il lun. Dr X ha scritto:"],
    ["escreveu",                    "Em seg. Dr X escreveu:"],
    ["написал",                     "Dr X написал:"],
    ["เขียนว่า",                      "ในวัน จันทร์ Dr X เขียนว่า:"],
    ["เขียนไว้ว่า",                    "ในวัน จันทร์ Dr X เขียนไว้ว่า:"],
    ["original message",            "-----Original Message-----"],
    ["ข้อความต้นฉบับ",                 "-----ข้อความต้นฉบับ-----"],
  ];
  for (const [label, line] of cuts) {
    const out = senderOwnText(`ส่งไฟล์ครับ\n${line}\nQUOTEDTEXT กันยายน`);
    assert.ok(out.includes("ส่งไฟล์"), `${label}: own text kept`);
    assert.ok(!out.includes("QUOTEDTEXT"), `${label}: quote cut`);
  }
});

test("senderOwnText: each HTML quote container works alone", () => {
  for (const attrs of ['class="gmail_quote"', 'class="yahoo_quoted"', 'class="moz-cite-prefix"', 'class="zmail_extra"', 'class="OutlookMessageHeader"', 'id="appendonsend"', 'id="divRplyFwdMsg"', "class=gmail_quote"]) {
    const out = senderOwnText(`<div>ส่งไฟล์ครับ</div><div ${attrs}><div>header</div></div><div>QUOTEDTEXT</div>`);
    assert.ok(out.includes("ส่งไฟล์"), `${attrs}: own text kept`);
    assert.ok(!out.includes("QUOTEDTEXT"), `${attrs}: quote cut`);
  }
});

// ── conditions that no test used to protect ──────────────────────────────

test("collapse: two different dated years, or a yearless mention only in a quote, are not merged", () => {
  assert.equal(decide({ subject: "P4P กันยายน", body: "ส่ง กันยายน 2568 และ กันยายน 2569" }).kind, "ambiguous", "two dated years for the month");
  assert.ok(neverTheQuote(decide({ subject: "P4P กันยายน 2569", body: "ส่งแล้วครับ\n\nOn Mon, A <a@example.com> wrote:\n> กันยายน" }), { month: 9, beYear: 2569 }), "the year-less side exists only in the quote");
});

test("collapse with several workbooks: a '~$' owner file and 'P4P' in names are not reasons to refuse", () => {
  const mail = { subject: "P4P กันยายน", body: "ส่ง กันยายน 2569 ครับ" };
  const withLock = ["สมชาย.xlsx", "สมหญิง.xlsx", "~$P4P_aug.xlsx"];
  assert.deepEqual(decide({ ...mail, workbookCount: 3, filename: withLock[0], siblings: withLock }), ok(9, 2569, "collapsed"), "a lock file naming another month is not a workbook");
  const p4p = ["P4P_สมชาย.xlsx", "P4P_สมหญิง.xlsx"];
  assert.deepEqual(decide({ ...mail, workbookCount: 2, filename: p4p[0], siblings: p4p }), ok(9, 2569, "collapsed"), "'P4P' alone is not a lone digit");
  const shortYear = ["สมชาย.xlsx", "สมหญิง_25.xlsx"];
  assert.equal(decide({ ...mail, workbookCount: 2, filename: shortYear[0], siblings: shortYear }).kind, "ambiguous", "a 2-digit 00–42 number in a sibling's name is a year (25 = 2025 = 2568)");
  // one real workbook beside its owner file is one workbook: the mail's month applies, as for any one-period mail
  const oneReal = ["P4P_aug.xlsx", "~$P4P_aug.xlsx"];
  assert.deepEqual(decide({ ...mail, workbookCount: 2, filename: oneReal[0], siblings: oneReal }), ok(9, 2569, "collapsed"));
});

test("a strict year-less sibling of the same month still collides with a Latin-named file that has a year", () => {
  const sibs = ["P4P ก.ย.xlsx", "x_sep_y.xlsx"];
  const mail = { subject: "ส่ง P4P สิงหาคม 2569 กันยายน 2569", workbookCount: 2 };
  assert.equal(decide({ ...mail, filename: sibs[1], siblings: sibs }).kind, "ambiguous");
});

test("the Latin reading: relative-year words refuse even when the mail also writes a year; day numbers in the body do not", () => {
  const files = ["P4P_aug_X.xlsx", "P4P_sep_X.xlsx"];
  assert.equal(latin(files, { subject: "ส่ง P4P สิงหาคม 2569 กันยายน 2569 ของปีที่แล้ว" }).kind, "ambiguous", "says 2569 and 'last year'");
  assert.equal(latin(files, { body: "ติดต่อกลับภายใน 15 นาที ห้อง 22" }).kind, "ok", "plain numbers in the body are not years");
});
