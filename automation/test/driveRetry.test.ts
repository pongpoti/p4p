// A Drive upload that failed for a temporary reason (5xx, 429, a network error) leaves the email for the
// bounded retry: nothing saved, nothing sent. A permanent one (a permission error, a missing folder) is
// answered as before. Drive is a fake client passed in; Supabase and Telegram are fakeBackends.ts.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { processBuffer } = await import("../index.js");
const { RetryLaterError } = await import("../inbound-triage.js");
const { isTransientDriveError } = await import("../drive-client.js");

const SENDER = "doctor.drive@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

test("temporary Drive errors are told apart from permanent ones", () => {
  for (const e of [
    { status: 503 }, { status: 500 }, { response: { status: 429 } }, { status: 408 }, { code: "502" },
    { code: "ECONNRESET" }, { code: "ETIMEDOUT" }, { code: "EAI_AGAIN" },
    { status: 403, errors: [{ reason: "userRateLimitExceeded" }] },
    { status: 403, response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } },
    new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
    new Error("socket hang up"),
  ]) assert.equal(isTransientDriveError(e), true, JSON.stringify(e));
  for (const e of [
    { status: 403, errors: [{ reason: "insufficientFilePermissions" }] }, { status: 404 }, { status: 400 }, { status: 401 },
    new Error(`Month folder "10 - ตุลาคม" not found inside "2569"`), new Error("Missing Google credentials in .env"),
    null, undefined, "503",
  ]) assert.equal(isTransientDriveError(e), false, JSON.stringify(e));
});

async function report(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function submit(driveError: unknown) {
  const be = installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
  const sent: { subject: string }[] = [];
  const gmail = { sendMessage: async (o: { subject: string }) => { sent.push(o); return {}; } };
  const drive = {
    uploadFile: async () => { throw driveError; },
    listMonthFiles: async () => new Map<string, string>(),
  };
  const file = await report();
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    const outcome = await processBuffer(file, {
      subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo: SENDER, messageId: "m1", gmail,
      gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1, drive,
    } as never).catch((e: unknown) => e);
    return { outcome, sent, be };
  } finally {
    Object.assign(console, orig);
  }
}

test("a Drive 503 leaves the submission for a retry: nothing saved, nothing sent", async () => {
  const { outcome, sent, be } = await submit(Object.assign(new Error("Backend Error"), { status: 503 }));
  assert.ok(outcome instanceof RetryLaterError, "a retryable failure, so the email stays unread");
  assert.match((outcome as Error).message, /Drive upload failed \(temporary\)/);
  assert.equal(sent.length, 0);
  assert.equal(be.patches.length, 0);
});

test("a network error on the Drive upload is retried too", async () => {
  const { outcome, sent } = await submit(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  assert.ok(outcome instanceof RetryLaterError);
  assert.equal(sent.length, 0);
});

test("a Drive permission error is answered as before and not retried", async () => {
  const { outcome, sent, be } = await submit(Object.assign(new Error("The user does not have sufficient permissions"), { status: 403, errors: [{ reason: "insufficientFilePermissions" }] }));
  assert.equal(outcome, "replied");
  assert.equal(sent.length, 1, "the sender gets the alert");
  assert.equal(be.patches.length, 0, "no score saved");
  assert.ok(be.telegrams.some((t) => t.includes("Drive upload failed")));
});
