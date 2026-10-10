// Drives the REAL processBuffer through its period and sheet gates (the wiring period-gate.ts,
// sheet-rescue.ts and inbound-triage.ts are plugged into), with a fake Gmail client. Every network
// endpoint is pointed at a closed local port BEFORE index.ts is imported, so nothing leaves the box:
// a submission the gates accept simply fails later, at the analysis call — which is all these tests
// need to see. The assertions are about which gate spoke, not about what happens after it.
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = "http://127.0.0.1:9"; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = ""; process.env.TELEGRAM_CHAT_ID = "";

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { processBuffer } = await import("../index.js");

type CellValue = string | number;
async function book(sheets: { name: string; cells: [string, CellValue][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) { const ws = wb.addWorksheet(s.name); for (const [a, v] of s.cells) ws.getCell(a).value = v; }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const body = (m: number): [string, CellValue][] => [["B5", "ประเภทงาน"], ["C5", m], ["C6", m + 1], ["C7", m + 2]];
const oneTab = await book([{ name: "Sheet1", cells: body(10) }]);
const reportPlusExample = await book([
  { name: "Form-Intern", cells: body(10) },
  { name: "Ex-Placeholder", cells: [["A1", "เดือน มกราคม พ.ศ. 2568"], ...body(900)] },
]);

const SEND = "2026-10-02T04:32:34Z";                 // Oct 2026 = BE 2569

async function run(buf: Buffer, ctx: Record<string, unknown>) {
  const log: string[] = [];
  const sent: string[] = [];
  const gmail = { sendMessage: async (o: { subject: string }) => { sent.push(o.subject); } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => { log.push(a.join(" ")); };
  let outcome: unknown;
  try { outcome = await processBuffer(buf, { replyTo: "sender@example.com", messageId: "m1", gmail, emailDate: SEND, workbookCount: 1, ...ctx } as never); }
  catch (e) { outcome = `THROW ${(e as Error).message}`; }
  Object.assign(console, orig);
  return { outcome, sent, text: log.join("\n") };
}
const REFUSAL = /ambiguous_period:|no_period:|month_not_found:/;

test("the same month with and without a year is one period (the Oct-2 incident shape)", async () => {
  const r = await run(oneTab, { subject: "P4P เดือนกันยายน", body: "ส่งตาราง P4P ของเดือนกันยายน 2569 ครับ", filename: "x.xlsx" });
  assert.doesNotMatch(r.text, REFUSAL);
  assert.match(r.text, /Same month stated with and without a year .* read as 2569_09/);
});

test("…but not when the send date makes that year implausible, or a two-digit year disagrees", async () => {
  for (const ctx of [
    { subject: "P4P เดือนกันยายน", body: "ส่งตาราง P4P ของเดือนกันยายน 2569 ครับ", emailDate: "2021-10-02T04:32:34Z" },
    { subject: "P4P ก.ย. 69", body: "ส่ง P4P กันยายน 2568 ครับ" },
  ]) {
    const r = await run(oneTab, { filename: "x.xlsx", ...ctx });
    assert.equal(r.outcome, "rejected");
    assert.match(r.text, /ambiguous_period:/);
  }
});

test("a Latin month word in a file's own name routes a multi-month mail; collisions and strangers do not", async () => {
  const mail = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน Intern", body: "" };
  const ok = await run(oneTab, { ...mail, filename: "P4P-Intern_sep_X.xlsx", workbookCount: 2, siblingFilenames: ["P4P-Intern_sep_X.xlsx", "P4P-Intern_aug_X.xlsx"] });
  assert.doesNotMatch(ok.text, REFUSAL);
  assert.match(ok.text, /this file names 2569_09 \(Latin month word in its file name\)/);

  for (const [filename, siblingFilenames] of [
    ["P4P_aug_X.xlsx", ["P4P_aug_X.xlsx", "P4P_aug_X (1).xlsx"]],          // two files claim August
    ["P4P_May_X.xlsx", ["P4P_May_X.xlsx", "P4P_sep_X.xlsx"]],              // May is not a month the mail named
    ["P4P_Jun_Somsri.xlsx", ["P4P_Jun_Somsri.xlsx", "P4P_aug_X.xlsx"]],    // "Jun" is a nickname unless something says otherwise
    ["P4P_sep_X.xlsx", ["P4P_sep_X.xlsx"]],                                // a sibling the processor was not told about
  ] as [string, string[]][]) {
    const r = await run(oneTab, { ...mail, filename, workbookCount: 2, siblingFilenames });
    assert.equal(r.outcome, "rejected", filename);
    assert.match(r.text, /ambiguous_period:/, filename);
  }
});

test("a year the Latin path cannot place — Thai digits, two digits — is a refusal", async () => {
  for (const subject of ["ส่ง P4P เดือนสิงหาคม กันยายน ๒๕๖๘", "ส่ง P4P เดือนสิงหาคม ก.ย. 68"]) {
    const r = await run(oneTab, { subject, body: "", filename: "P4P_sep_X.xlsx", workbookCount: 2, siblingFilenames: ["P4P_sep_X.xlsx", "P4P_aug_Y.xlsx"] });
    assert.equal(r.outcome, "rejected", subject);
    assert.match(r.text, /ambiguous_period:/, subject);
  }
});

test("a report beside the template's example tab is read only when the file name confirms the month", async () => {
  const mail = { subject: "P4P สิงหาคม 2569", body: "" };
  const ok = await run(reportPlusExample, { ...mail, filename: "P4P-Aug.xlsx" });
  assert.doesNotMatch(ok.text, /month_not_found:/);
  assert.match(ok.text, /Report tab "Form-Intern" beside a template example tab/);
  for (const filename of ["P4P.xlsx", "P4P-Sep.xlsx"]) {
    const r = await run(reportPlusExample, { ...mail, filename });
    assert.equal(r.outcome, "rejected", filename);
    assert.match(r.text, /month_not_found:/, filename);
  }
});

test("an alert addressed to a no-reply sender is never sent, whatever the rejection", async () => {
  const r = await run(oneTab, { replyTo: "drive-shares-dm-noreply@google.com", subject: "P4P", body: "", filename: "x.xlsx" });
  assert.equal(r.outcome, "rejected");
  assert.match(r.text, /no_period:/);
  assert.deepEqual(r.sent, []);
  assert.match(r.text, /automated no-reply address/);
  // control: the same rejection to a person is sent
  const person = await run(oneTab, { subject: "P4P", body: "", filename: "x.xlsx" });
  assert.equal(person.sent.length, 1);
});

// ── the decision reaches the sheet that is read ──────────────────────────

const twoMonths = await book([
  { name: "ส.ค. 2569", cells: body(100) },
  { name: "ก.ย. 2569", cells: body(200) },
]);
const exampleFirst = await book([
  { name: "Ex-Placeholder", cells: [["A1", "เดือน มกราคม พ.ศ. 2568"], ...body(900)] },
  { name: "Form-Intern", cells: body(10) },
]);
const usedSheet = (text: string) => text.match(/Using sheet: "([^"]*)"/)?.[1];

test("the month a file's own name gives is the month whose tab is read", async () => {
  const mail = { subject: "ส่ง P4P เดือนสิงหาคม กันยายน Intern", body: "", workbookCount: 2 };
  const sib = ["P4P-Intern_sep_X.xlsx", "P4P-Intern_aug_X.xlsx"];
  const sep = await run(twoMonths, { ...mail, filename: sib[0], siblingFilenames: sib });
  assert.equal(usedSheet(sep.text), "ก.ย. 2569", "the September file reads September's tab");
  const aug = await run(twoMonths, { ...mail, filename: sib[1], siblingFilenames: sib });
  assert.equal(usedSheet(aug.text), "ส.ค. 2569", "the August file reads August's tab");
});

test("the example tab is never the one read, whatever its position", async () => {
  const r = await run(exampleFirst, { subject: "P4P สิงหาคม 2569", body: "", filename: "P4P-Aug.xlsx" });
  assert.equal(usedSheet(r.text), "Form-Intern");
  assert.match(r.text, /reading "Form-Intern"/);
});

test("one mail-wide month does not carry a file whose name says another month", async () => {
  const mail = { subject: "P4P สิงหาคม", body: "ส่ง P4P ของเดือนสิงหาคม 2569 ครับ", workbookCount: 2 };
  const sib = ["P4P-Intern_aug_ICU.xlsx", "P4P-Intern_sep_ICU.xlsx"];
  for (const filename of sib) {
    const r = await run(twoMonths, { ...mail, filename, siblingFilenames: sib });
    assert.equal(r.outcome, "rejected", filename);
    assert.match(r.text, /ambiguous_period:/, filename);
  }
  // …while the same mail with files that are silent about the month is read as August, as a one-period mail always was
  const quiet = ["สมชาย.xlsx", "สมหญิง.xlsx"];
  const ok = await run(twoMonths, { ...mail, filename: quiet[0], siblingFilenames: quiet });
  assert.doesNotMatch(ok.text, REFUSAL);
  assert.equal(usedSheet(ok.text), "ส.ค. 2569");
});
