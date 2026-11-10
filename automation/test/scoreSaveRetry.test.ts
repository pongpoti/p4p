// A score that could not be written is never confirmed to the physician. The email stays unread for the
// bounded retry and the admin is told when it gives up; the LINE drain never closes a queue row as done
// with an unsaved score. Supabase and Telegram are the in-memory fakes of fakeBackends.ts.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.GOOGLE_CLIENT_ID = "test"; process.env.GOOGLE_CLIENT_SECRET = "test"; process.env.GOOGLE_REFRESH_TOKEN = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { fakeGmail, XLSX_MIME } from "./fakeGmail.js";

const { processBuffer, readSubmissionEmails } = await import("../index.js");
const { MAX_THROWN_PASSES, RetryLaterError, thrownReasons } = await import("../inbound-triage.js");
const { scoreNotSaved } = await import("../scripts/drain-uploads.js");

const SENDER = "doctor.retry@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

async function report(sheet = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function backends() {
  return installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: 900, submitted_at: null }],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

test("email path: a failed score write throws for a retry and sends the sender nothing", async () => {
  const be = backends();
  be.failingWrites.add("2569_10");
  const sent: unknown[] = [];
  const gmail = { sendMessage: async (o: unknown) => { sent.push(o); return {}; } };
  const file = await report();
  const err = await quiet(() => processBuffer(file, {
    subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo: SENDER, messageId: "m1", gmail,
    gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1,
  } as never).then(() => null, (e: unknown) => e));
  assert.ok(err instanceof RetryLaterError, "a retryable failure");
  assert.match((err as Error).message, /score not saved .*2569_10.*#7/);
  assert.equal(sent.length, 0, "no confirmation of a score that was not saved");
  assert.equal(be.tables["2569_10"]![0]!.score, 900, "the old score is still there");
  assert.equal(be.inserts.filter((i) => i.table === "p4p_submissions").length, 0, "no submission logged");
});

test("LINE path: a failed score write throws, so notify.ok never reports it", async () => {
  const be = backends();
  be.failingWrites.add("2569_10");
  let ok = 0;
  const file = await report("ตุลาคม 2569");   // the LINE path needs the file to name the month picked
  const err = await quiet(() => processBuffer(file, {
    filename: `P4P_${NAME}.xlsx`, subject: "P4P ตุลาคม 2569", body: "", emailDate: "2026-11-07T03:00:00.000Z",
    source: "line-upload", monthKey: "2569_10",
    identity: { email: SENDER, fullName: NAME, department: "ทดสอบ", rosterIndex: 7, lineUserId: "U0", attempt: 1 },
    notify: { ok: () => { ok++; }, fail: () => {} },
  } as never).then(() => null, (e: unknown) => e));
  assert.ok(err instanceof RetryLaterError);
  assert.equal(ok, 0);
});

test("the drain never takes an unsaved score as done", () => {
  const payload = { matchedName: NAME, prefix: "", department: "", monthKey: "2569_10", score: 1, receivedAt: "" };
  assert.equal(scoreNotSaved(true, { ...payload, scoreSaved: false }), true);
  assert.equal(scoreNotSaved(true, { ...payload, scoreSaved: true }), false);
  assert.equal(scoreNotSaved("replied", null), false);
  assert.equal(scoreNotSaved(true, null), false);
});

function mailbox(file: Buffer, id: string) {
  return fakeGmail([{
    msg: { id, threadId: `t-${id}`, subject: "ส่ง P4P ตุลาคม 2569", from: `Doc <${SENDER}>`, date: "Sat, 7 Nov 2026 10:00:00 +0700", receivedAt: "2026-11-07T03:00:00.000Z", body: "" },
    attachments: [{ attachmentId: "a1", filename: `P4P_${NAME}.xlsx`, mimeType: XLSX_MIME, size: file.length }],
    files: { a1: file },
    labels: new Set(["INBOX", "UNREAD"]),
  }]);
}

test("a save that keeps failing leaves the email unread for a bounded number of polls, then the admin is told", async () => {
  const be = backends();
  be.failingWrites.add("2569_10");
  const gmail = mailbox(await report(), "m-save-fails");
  await quiet(async () => {
    for (let i = 1; i < MAX_THROWN_PASSES; i++) {
      await readSubmissionEmails({ gmail: gmail as never });
      assert.equal(gmail.modified.length, 0, `still unread after poll ${i}`);
    }
    await readSubmissionEmails({ gmail: gmail as never });
  });
  assert.deepEqual(gmail.modified.map((m) => m.id), ["m-save-fails"], "set aside after the last pass");
  assert.equal(gmail.sent.length, 0, "the physician was never told it succeeded");
  const alert = be.telegrams.find((t) => t.includes("m-save-fails"));
  assert.ok(alert, "the admin is told");
  assert.match(alert!, /score not saved/);
});

test("a save that fails once is saved and confirmed on the next poll", async () => {
  const be = backends();
  be.failingWrites.add("2569_10");
  const gmail = mailbox(await report(), "m-save-recovers");
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.equal(gmail.modified.length, 0);
  assert.equal(gmail.sent.length, 0);
  be.failingWrites.clear();
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.equal(be.tables["2569_10"]![0]!.score, 1234.5);
  assert.equal(gmail.sent.length, 1, "one confirmation, after the score is saved");
  assert.deepEqual(gmail.modified.map((m) => m.id), ["m-save-recovers"]);
});

test("thrownReasons lists only the workbooks that threw, cut short", () => {
  const results: PromiseSettledResult<unknown>[] = [
    { status: "fulfilled", value: true },
    { status: "rejected", reason: new RetryLaterError("x".repeat(400)) },
    { status: "rejected", reason: "plain" },
  ];
  const r = thrownReasons(results);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.length, 301);
  assert.equal(r[1], "plain");
});

test("a workbook that threw beside one that was answered is not retried, and the admin is told", async () => {
  const be = backends();
  be.failingWrites.add("2569_10");
  const file = await report();
  const gmail = fakeGmail([{
    msg: { id: "m-mixed", threadId: "t-mixed", subject: "ส่ง P4P ตุลาคม 2569", from: `Doc <${SENDER}>`, date: "Sat, 7 Nov 2026 10:00:00 +0700", receivedAt: "2026-11-07T03:00:00.000Z", body: "" },
    attachments: [
      { attachmentId: "a1", filename: `P4P_${NAME}.xlsx`, mimeType: XLSX_MIME, size: file.length },
      // Excel's lock file: answered with the temp_file alert, so the message counts as handled
      { attachmentId: "a2", filename: `~$P4P_${NAME}.xlsx`, mimeType: XLSX_MIME, size: 165 },
    ],
    files: { a1: file },
    labels: new Set(["INBOX", "UNREAD"]),
  }]);
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.deepEqual(gmail.modified.map((m) => m.id), ["m-mixed"]);
  const alert = be.telegrams.find((t) => t.includes("m-mixed"));
  assert.ok(alert, "the admin hears about the workbook that will not be retried");
  assert.match(alert!, /score not saved/);
  assert.equal(be.tables["2569_10"]![0]!.score, 900);
});
