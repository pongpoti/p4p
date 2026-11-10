// Email path: a score read by a method that is not trusted on its own (anything but the sheet's own
// grand-total row) is still saved and confirmed, but the admin gets a Telegram naming the method so it is
// checked. Supabase and Telegram are the in-memory fakes of fakeBackends.ts.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { processBuffer } = await import("../index.js");

const SENDER = "doctor.gate@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

async function book(cells: [string, string | number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of cells) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function submit(file: Buffer) {
  const be = installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
  const sent: { subject: string }[] = [];
  const gmail = { sendMessage: async (o: { subject: string }) => { sent.push(o); return {}; } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    const outcome = await processBuffer(file, {
      subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo: SENDER, messageId: "msg-gate", gmail,
      gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1,
    } as never);
    return { outcome, sent, be };
  } finally {
    Object.assign(console, orig);
  }
}

test("a sub-total reading is saved and confirmed, and the admin is asked to check it, method named", async () => {
  const { outcome, sent, be } = await submit(await book([["A1", "รวมคะแนน"], ["B1", 400], ["A2", "รวมคะแนน"], ["B2", 250], ["A3", "หมายเหตุ"], ["B3", "ไม่มี"]]));
  assert.equal(outcome, true);
  assert.deepEqual(be.patches.filter((p) => "score" in p.body).map((p) => p.body.score), [400], "still saved");
  assert.equal(sent.length, 1, "still confirmed");
  const alert = be.telegrams.find((t) => t.includes("ต้องตรวจสอบ"));
  assert.ok(alert, "the admin is asked to check it");
  for (const needle of ["sub-total label row (col_1-3)", "400.00", "msg-gate", "#7", "2569_10"]) assert.ok(alert!.includes(needle), `alert mentions ${needle}`);
});

test("a grand-total reading needs no check", async () => {
  const { outcome, be } = await submit(await book([["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]]));
  assert.equal(outcome, true);
  assert.equal(be.telegrams.filter((t) => t.includes("ต้องตรวจสอบ")).length, 0);
});
