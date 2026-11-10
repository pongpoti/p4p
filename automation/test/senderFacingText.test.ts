// What a failure tells the SENDER: only fixed Thai copy, never the raw exception text behind it
// (ExcelJS, Claude, Supabase, Drive). The raw text is the admin's (Telegram). Drives the real
// processBuffer with a fake Gmail client; every network endpoint points at a closed local port
// BEFORE index.ts is imported, so nothing leaves the box.
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = "http://127.0.0.1:9"; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = ""; process.env.TELEGRAM_CHAT_ID = "";

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";

const { processBuffer, SENDER_DETAIL } = await import("../index.js");

async function book(cells: [string, string | number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of cells) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function run(buf: Buffer, ctx: Record<string, unknown>) {
  const sent: { subject: string; html?: string; body?: string }[] = [];
  const gmail = { sendMessage: async (o: { subject: string; html?: string; body?: string }) => { sent.push(o); } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  let outcome: unknown;
  try {
    outcome = await processBuffer(buf, { replyTo: "sender@example.com", messageId: "m1", gmail, emailDate: "2026-11-02T04:00:00Z", workbookCount: 1, ...ctx } as never);
  } finally {
    Object.assign(console, orig);
  }
  return { outcome, sent };
}

const escaped = (s: string) => s.replace(/"/g, "&quot;");

test("a workbook ExcelJS cannot read gets the fixed 'cannot read' copy, not the parser's message", async () => {
  // A real zip, but not a workbook: ExcelJS throws its own technical message on it.
  const zip = new JSZip();
  zip.file("hello.txt", "not a workbook");
  const notAWorkbook = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  const r = await run(notAWorkbook, { subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: "x.xlsx" });
  assert.equal(r.outcome, "replied");
  assert.equal(r.sent.length, 1);
  assert.ok(r.sent[0]!.html!.includes(escaped(SENDER_DETAIL.unreadable)));
  assert.doesNotMatch(r.sent[0]!.html!, /ไม่สามารถอ่านไฟล์ได้:/, "no raw error after the label");
});

test("a failed analysis gets the fixed analysis copy, not the Claude/SDK error", async () => {
  // No name anywhere a pre-scan can find one, so the pipeline asks Claude — whose endpoint is a closed port.
  const buf = await book([["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["C7", 12]]);
  const r = await run(buf, { subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: "x.xlsx" });
  assert.equal(r.outcome, "replied");
  assert.equal(r.sent.length, 1);
  const html = r.sent[0]!.html!;
  assert.ok(html.includes(escaped(SENDER_DETAIL.analysis)));
  assert.doesNotMatch(html, /connect|ECONNREFUSED|Connection error|Claude|anthropic/i);
});

test("the upload path's failure detail (shown in the LINE bubble) is the fixed copy, not the Supabase error", async () => {
  // Name (file name) and score (total row) both pre-scan, so no Claude call; the roster lookup then
  // hits the closed Supabase port.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ต.ค. 2569");
  for (const [a, v] of [["A1", "รายงาน P4P เดือน ตุลาคม 2569"], ["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const failures: { errorType: string; detail: string }[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  let outcome: unknown;
  try {
    outcome = await processBuffer(buf, {
      filename: "P4P_ทดสอบ ตัวอย่าง.xlsx", subject: "P4P", body: "", emailDate: "2026-11-02T04:00:00Z", source: "line-upload", monthKey: "2569_10",
      identity: { email: "doc@example.com", fullName: "ทดสอบ ตัวอย่าง", department: null, rosterIndex: 1, lineUserId: "U0", attempt: 1 },
      notify: { fail: (errorType: string, detail: string) => { failures.push({ errorType, detail }); } },
    } as never);
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(outcome, "replied");
  assert.deepEqual(failures, [{ errorType: "other", detail: SENDER_DETAIL.rosterLookup }]);
});
