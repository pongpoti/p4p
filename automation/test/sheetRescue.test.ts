import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { firstSheetToRows, guessingBetweenTabs } from "../index.js";
import { pickReportBesideExample, isExampleTabName, filenameConfirms, reportSaysAnotherPeriod, type TabInfo } from "../sheet-rescue.js";

// The rescue only ever turns a month_not_found refusal into an acceptance, and
// only with the file's OWN NAME confirming the month. The rows that must stay
// refused are the point of this file.

const none = { month: null, beYear: null };
const tab = (name: string, over: Partial<TabInfo> = {}): TabInfo =>
  ({ name, filled: true, score: 0, nameHit: none, titleHit: none, titleText: "", visible: true, ...over });

const REPORT  = tab("Form-Intern");                                              // title row left blank
const EXAMPLE = tab("Ex-Placeholder", { titleHit: { month: 1, beYear: 2568 } });   // frozen at another period

function pick(tabs: TabInfo[], filename: string, over: Record<string, unknown> = {}) {
  return pickReportBesideExample({ tabs, matched: false, targetMonth: 8, targetYear: 2569, filename, ...over } as never);
}

test("what counts as an example tab", () => {
  for (const n of ["Ex-Placeholder", "Ex_1", "Ex 2", "Ex", "ex-foo", "Example 1", "Sample", "ตัวอย่าง 1"]) assert.equal(isExampleTabName(n), true, n);
  for (const n of ["Excel", "Exp", "Form-Intern", "Sheet1", "ส.ค.69", "Next"]) assert.equal(isExampleTabName(n), false, n);
});

test("report + example, and the file name confirms the month: read the report", () => {
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Aug.xlsx"), "Form-Intern");
  assert.equal(pick([EXAMPLE, REPORT], "P4P สิงหาคม 2569.xlsx"), "Form-Intern", "tab order does not matter");
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Intern_aug_X.xlsx"), "Form-Intern", "a Latin month word beside an underscore confirms too");
});

test("a silent file name is NOT confirmation (the reader's blind spots must fail closed)", () => {
  assert.equal(pick([REPORT, EXAMPLE], "P4P.xlsx"), null);
  assert.equal(pick([REPORT, EXAMPLE], "Book1.xlsx"), null);
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Intern+Ex_08.xlsx"), null, "…a numeric month is one the readers cannot place, so it is not a month");
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Intern+Ex_Sep_69.xlsx"), null, "…and a month the readers CAN place, but that is not the target, is a refusal");
});

test("a file name that names another month or year keeps the refusal", () => {
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Sep.xlsx"), null, "stale subject: the file is September's");
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Aug-2568.xlsx"), null, "right month, last year");
  assert.equal(pick([REPORT, EXAMPLE], "P4P ส.ค.68.xlsx"), null, "two-digit year of last year");
  assert.equal(pick([REPORT, EXAMPLE], "P4P ส.ค. ก.ย..xlsx"), null, "two months in one name");
});

test("a report whose own name or title says another period keeps the refusal (the stale-title shape)", () => {
  assert.equal(pick([tab("Form-Intern", { titleHit: { month: 7, beYear: 2569 } }), EXAMPLE], "P4P-Aug.xlsx"), null, "title says July");
  assert.equal(pick([tab("Form-Intern", { nameHit: { month: 9, beYear: null } }), EXAMPLE], "P4P-Aug.xlsx"), null, "tab name says September");
  assert.equal(pick([tab("Form-Intern", { titleHit: { month: 8, beYear: 2568 } }), EXAMPLE], "P4P-Aug.xlsx"), null, "title says August of another year");
});

test("what the strict readers cannot see still vetoes: a year-only title, a glued month, a numeric date, Thai digits", () => {
  // Each of these shapes slipped past an earlier version that trusted the strict month/year reader alone.
  const titled = (titleText: string, name = "Form-Intern") => [tab(name, { titleText }), EXAMPLE];
  assert.equal(pick(titled("ประจำเดือน ........ พ.ศ. 2568"), "P4P-Aug.xlsx"), null, "year-only title, last year");
  assert.equal(pick(titled("x", "แบบฟอร์ม ปี 2568"), "P4P-Aug.xlsx"), null, "year-only tab NAME");
  assert.equal(pick(titled("แบบประเมินประจำเดือนกรกฎาคมพ.ศ.2569"), "P4P-Aug.xlsx"), null, "July glued to the next word");
  assert.equal(pick(titled("ประจำเดือน 07/2569"), "P4P-Aug.xlsx"), null, "numeric month");
  assert.equal(pick(titled("ประจำเดือน ๐๗/๒๕๖๙"), "P4P-Aug.xlsx"), null, "numeric month, Thai digits");
  assert.equal(pick(titled("ปี ๒๕๖๘"), "P4P-Aug.xlsx"), null, "year in Thai digits");
  assert.equal(pick(titled("1/7/69"), "P4P-Aug.xlsx"), null, "a full numeric date");
  assert.equal(pick(titled("Period: July"), "P4P-Aug.xlsx"), null, "Latin month word");
  // …and what must NOT veto: nothing period-like, the target month itself, the target year, plain Latin words
  assert.equal(pick(titled("แบบประเมินผลงาน ประจำเดือน ........"), "P4P-Aug.xlsx"), "Form-Intern");
  assert.equal(pick(titled("ประจำเดือนสิงหาคมพ.ศ.2569"), "P4P-Aug.xlsx"), "Form-Intern", "the target month, glued: consistent");
  assert.equal(pick(titled("Decision form, Market data"), "P4P-Aug.xlsx"), "Form-Intern", "Dec/Mar inside other words");
  assert.equal(reportSaysAnotherPeriod("พ.ศ. 2569", 8, 2569), false);
  assert.equal(reportSaysAnotherPeriod("2026", 8, 2569), false, "CE 2026 = BE 2569");
  assert.equal(reportSaysAnotherPeriod("2025", 8, 2569), true, "CE 2025 = BE 2568");
});

test("more shapes that must veto: a bare month number, a dotted abbreviation, a glued abbreviation, a quarter", () => {
  const titled = (titleText: string) => [tab("Form-Intern", { titleText }), EXAMPLE];
  for (const title of [
    "07/69", "รายงานประจำเดือนที่ 7", "Monthly report - month 7", "ประจำเดือนที่ ๗", "ผลงานก.ค 68", "ผลงานกค68", "ผลงาน สค 2568 ", "ไตรมาสที่ 3",
    "Q3 report", "ครึ่งปีแรก", "เดือน 12",
  ]) assert.equal(pick(titled(title), "P4P-Aug.xlsx"), null, title);
  // …and what the same words do NOT veto when they are about the target month
  for (const title of ["รายงานประจำเดือนที่ 8", "ผลงาน ส.ค 69", "month 08", "ผลงานสค69"]) {
    assert.equal(pick(titled(title), "P4P-Aug.xlsx"), "Form-Intern", title);
  }
});

test("a Date cell is read as the date it is, not as an ISO string full of numbers", () => {
  const titled = (titleText: string) => [tab("Form-Intern", { titleText }), EXAMPLE];
  assert.equal(pick(titled("2026-08-03T00:00:00.000Z"), "P4P-Aug.xlsx"), "Form-Intern", "3 Aug 2026 is inside August 2569");
  assert.equal(pick(titled("2026-07-31T00:00:00.000Z"), "P4P-Aug.xlsx"), null, "31 Jul 2026 is not");
  assert.equal(pick(titled("2025-08-03T00:00:00.000Z"), "P4P-Aug.xlsx"), null, "August, but a year earlier");
});

test("anything that is not exactly one report beside a self-declared example stays refused", () => {
  assert.equal(pick([REPORT, tab("ใบ p4p (2)"), EXAMPLE], "P4P-Aug.xlsx"), null, "two candidates is a real guess");
  assert.equal(pick([REPORT, tab("Sheet2")], "P4P-Aug.xlsx"), null, "no example at all");
  assert.equal(pick([REPORT, tab("Ex-Placeholder")], "P4P-Aug.xlsx"), null, "an example-named tab that states no period of its own is not proven to be one");
  assert.equal(pick([REPORT, tab("Excel", { titleHit: { month: 1, beYear: 2568 } })], "P4P-Aug.xlsx"), null, "'Excel' is not an example");
  assert.equal(pick([EXAMPLE, tab("Ex-Other", { titleHit: { month: 2, beYear: 2568 } })], "P4P-Aug.xlsx"), null, "nothing but examples");
  assert.equal(pick([REPORT, EXAMPLE], "P4P-Aug.xlsx", { matched: true }), null, "a tab already identified the month");
  assert.equal(pick([REPORT, tab("Ex-Empty", { filled: false })], "P4P-Aug.xlsx"), null, "one filled tab is not this rule's business");
  assert.equal(pick([REPORT, tab("Ex-Placeholder", { score: 2, titleHit: { month: 8, beYear: 2569 } })], "P4P-Aug.xlsx"), null, "an example that states the target month would have matched");
});

test("filenameConfirms", () => {
  assert.equal(filenameConfirms("P4P-Aug.xlsx", 8, 2569), true);
  assert.equal(filenameConfirms("P4P-Aug-2569.xlsx", 8, 2569), true);
  assert.equal(filenameConfirms("P4P-Aug-2569.xlsx", 8, null), true);
  assert.equal(filenameConfirms("P4P-Aug-2568.xlsx", 8, 2569), false);
  assert.equal(filenameConfirms("P4P.xlsx", 8, 2569), false);
});

// ── the real sheet-selection path ────────────────────────────────────────

type CellValue = string | number | Date;
async function build(sheets: { name: string; cells: [string, CellValue][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const [addr, value] of s.cells) ws.getCell(addr).value = value;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const body = (marker: number): [string, CellValue][] => [["B5", "ประเภทงาน"], ["C5", marker], ["C6", marker + 1]];
const reportTab  = (title: string | null, marker: number, extra: [string, CellValue][] = []) =>
  ({ name: "Form-Intern", cells: [...(title ? [["A1", title]] : []), ...body(marker), ...extra] as [string, CellValue][] });
const exampleTab = { name: "Ex-Placeholder", cells: [["A1", "เดือน มกราคม พ.ศ. 2568"], ...body(900)] as [string, CellValue][] };

test("report + example with a blank report title: refused today, read as the report once the file name confirms", async () => {
  for (const order of [[reportTab(null, 10), exampleTab], [exampleTab, reportTab(null, 10)]]) {
    const buf = await build(order);
    const first = await firstSheetToRows(buf, { targetMonth: 8, targetYear: 2569 });
    assert.equal(guessingBetweenTabs(first.filled, first.matched), true, "precondition: today this is month_not_found");
    assert.equal(first.tabs.find((t) => t.name === "Ex-Placeholder")!.titleHit.month, 1, "the example states its own (frozen) period");

    const report = pickReportBesideExample({ tabs: first.tabs, matched: first.matched, targetMonth: 8, targetYear: 2569, filename: "P4P-Aug.xlsx" });
    assert.equal(report, "Form-Intern");
    const forced = await firstSheetToRows(buf, { targetMonth: 8, targetYear: 2569, onlySheet: report });
    assert.equal(forced.chosenSheet, "Form-Intern");
    assert.ok(forced.rows.some((r) => Object.values(r).includes(10)), "rows come from the report tab");
    assert.ok(!forced.rows.some((r) => Object.values(r).includes(900)), "…never from the example");

    assert.equal(pickReportBesideExample({ tabs: first.tabs, matched: first.matched, targetMonth: 8, targetYear: 2569, filename: "P4P.xlsx" }), null, "silent file name: still refused");
  }
});

test("a report titled with another month stays refused even beside an example", async () => {
  const buf = await build([reportTab("เดือน กรกฎาคม พ.ศ. 2569", 10), exampleTab]);
  const first = await firstSheetToRows(buf, { targetMonth: 8, targetYear: 2569 });
  assert.equal(pickReportBesideExample({ tabs: first.tabs, matched: first.matched, targetMonth: 8, targetYear: 2569, filename: "P4P-Aug.xlsx" }), null);
});

test("a report titled with the target month needs no rescue at all", async () => {
  const buf = await build([reportTab("เดือน สิงหาคม พ.ศ. 2569", 10), exampleTab]);
  const first = await firstSheetToRows(buf, { targetMonth: 8, targetYear: 2569 });
  assert.equal(first.matched, true);
  assert.equal(first.chosenSheet, "Form-Intern");
  assert.equal(guessingBetweenTabs(first.filled, first.matched), false);
});

test("onlySheet names a tab that must exist", async () => {
  const buf = await build([reportTab(null, 10), exampleTab]);
  await assert.rejects(() => firstSheetToRows(buf, { targetMonth: 8, targetYear: 2569, onlySheet: "nope" }), /no sheet named/);
});

// The veto reads what the production path puts into titleText — pinned here with real workbooks.
async function rescued(sheets: Parameters<typeof build>[0], filename = "P4P-Aug.xlsx") {
  const first = await firstSheetToRows(await build(sheets), { targetMonth: 8, targetYear: 2569 });
  return pickReportBesideExample({ tabs: first.tabs, matched: first.matched, targetMonth: 8, targetYear: 2569, filename });
}

test("real workbooks: another period anywhere in the report's opening rows keeps the refusal", async () => {
  assert.equal(await rescued([reportTab(null, 10), exampleTab]), "Form-Intern", "control");
  assert.equal(await rescued([reportTab("รายงานประจำเดือนที่ 7", 10), exampleTab]), null, "month number");
  assert.equal(await rescued([reportTab("ผลงานก.ค 68", 10), exampleTab]), null, "dotted abbreviation without the final dot");
  assert.equal(await rescued([reportTab(null, 10, [["A2", "ประจำเดือน 07/2569"]]), exampleTab]), null, "second row");
  // a stale period stated well below the first rows (the 17th)
  const filler: [string, CellValue][] = Array.from({ length: 16 }, (_, i) => [`A${i + 2}`, `หัวข้อ ${i}`] as [string, CellValue]);
  assert.equal(await rescued([reportTab(null, 10, [...filler, ["A18", "ประจำเดือน กรกฎาคม 2568"]]), exampleTab]), null, "17th row");
  // a Date cell in the target month is consistent; one outside it is not
  assert.equal(await rescued([reportTab(null, 10, [["A2", new Date(Date.UTC(2026, 7, 3))]]), exampleTab]), "Form-Intern", "3 Aug 2026");
  assert.equal(await rescued([reportTab(null, 10, [["A2", new Date(Date.UTC(2026, 6, 31))]]), exampleTab]), null, "31 Jul 2026");
});

// ── the veto, table-driven ───────────────────────────────────────────────

test("every OTHER month vetoes, in every spelling the veto knows; the target month never does", () => {
  const MONTHS: [number, string, string, string][] = [   // number, full name, dotted without the final dot, glued two-consonant
    [1, "มกราคม", "ม.ค", "มค"], [2, "กุมภาพันธ์", "ก.พ", "กพ"], [3, "มีนาคม", "มี.ค", "มีค"], [4, "เมษายน", "เม.ย", "เมย"],
    [5, "พฤษภาคม", "พ.ค", "พค"], [6, "มิถุนายน", "มิ.ย", "มิย"], [7, "กรกฎาคม", "ก.ค", "กค"], [8, "สิงหาคม", "ส.ค", "สค"],
    [9, "กันยายน", "ก.ย", "กย"], [10, "ตุลาคม", "ต.ค", "ตค"], [11, "พฤศจิกายน", "พ.ย", "พย"], [12, "ธันวาคม", "ธ.ค", "ธค"],
  ];
  for (const [m, full, dotted, glued] of MONTHS) {
    for (const text of [`ประจำเดือน${full}`, `ประจำเดือน ${full}`, `ผลงาน ${dotted}. 2569`, `ผลงาน ${dotted} 69`, `ผลงาน${glued}69`, `ผลงาน ${glued} 2569`]) {
      assert.equal(reportSaysAnotherPeriod(text, 8, 2569), m !== 8, `${m}: ${text}`);
    }
  }
  assert.equal(reportSaysAnotherPeriod("ประจำเดือน กรกฎา", 8, 2569), true, "a truncated name");
  assert.equal(reportSaysAnotherPeriod("ตุลาการศาล", 8, 2569), false, "ตุลา + การ is not October");
});

test("spaced and short-year spellings of a stale title", () => {
  for (const text of ["รายงานประจำเดือน ก. ค. 68", "ก .ค. 68", "เดือน ที่ 7 ปี 68", "ประจำปี 68", "พ.ศ. 68", "year 25", "mth 7", "Quarter 3", "half-year report", "ครึ่งปีแรก"]) {
    assert.equal(reportSaysAnotherPeriod(text, 8, 2569), true, text);
  }
  assert.equal(reportSaysAnotherPeriod("ประจำปี 69", 8, 2569), false, "the target's own two-digit year");
});

test("'Ex' must start the tab name — 'Index' and 'Complex' are not examples", () => {
  for (const n of ["Index", "Complex", "Next", "Sex-ed"]) assert.equal(isExampleTabName(n), false, n);
});

test("real workbooks: ordinary numbers in the opening rows do not make the rescue decline", async () => {
  // a score cell of 3.25 reads as a date ("3/25") if numbers are stringified with the title text
  assert.equal(await rescued([reportTab(null, 10, [["D8", 3.25], ["D10", 85.5], ["D11", 0.25], ["D12", 1234]]), exampleTab]), "Form-Intern");
  // …but a whole number that reads as a year (20xx / 25xx) still counts — a stale one keeps the refusal
  assert.equal(await rescued([reportTab(null, 10, [["A2", 2568]]), exampleTab]), null);
  assert.equal(await rescued([reportTab(null, 10, [["A2", 2569]]), exampleTab]), "Form-Intern");
});

// ── round 4 ──────────────────────────────────────────────────────────────

test("an example-named or hidden tab is never 'the report'", () => {
  const ex2 = tab("Ex-2");                                                  // example-named, states no period of its own
  assert.equal(pick([EXAMPLE, ex2], "P4P-Aug.xlsx"), null, "Ex-1 + Ex-2: nothing but examples");
  assert.equal(pick([EXAMPLE, tab("Form-Intern", { visible: false })], "P4P-Aug.xlsx"), null, "a hidden tab");
  assert.equal(pick([EXAMPLE, REPORT], "P4P-Aug.xlsx"), "Form-Intern", "control");
});

test("year-first and compact stale periods veto", () => {
  for (const t of ["2568-07", "2025/07", "256807", "202507", "2569-07"]) assert.equal(reportSaysAnotherPeriod(t, 8, 2569), true, t);
  for (const t of ["2569-08", "256908", "2026-08", "202608"]) assert.equal(reportSaysAnotherPeriod(t, 8, 2569), false, t);
});

test("a month given as a NUMBER in the cell beside an 'เดือน' label is read", async () => {
  assert.equal(await rescued([reportTab(null, 10, [["A2", "เดือน"], ["B2", 7]]), exampleTab]), null, "July");
  assert.equal(await rescued([reportTab(null, 10, [["A2", "เดือน"], ["B2", 8]]), exampleTab]), "Form-Intern", "August");
  assert.equal(await rescued([reportTab(null, 10, [["A2", "จำนวน"], ["B2", 7]]), exampleTab]), "Form-Intern", "a 7 with no month label is just a 7");
  assert.equal(await rescued([reportTab(null, 10, [["D5", 2040]]), exampleTab]), "Form-Intern", "2040 is an ordinary number");
});
