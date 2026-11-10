// An older submission never writes its score over a newer one that is already saved. A retried email
// (its save or Drive upload failed for a temporary reason, so it stayed unread) can come round again after
// a corrected file was saved, by email in the same relay run or by a LINE upload that /upload/score
// scored at once. Supabase and Telegram are the in-memory fakes of fakeBackends.ts.
import { FAKE_SUPABASE_URL, installFakeBackends, type FakeRow } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.GOOGLE_CLIENT_ID = "test"; process.env.GOOGLE_CLIENT_SECRET = "test"; process.env.GOOGLE_REFRESH_TOKEN = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { fakeGmail, XLSX_MIME } from "./fakeGmail.js";

const { processBuffer, readSubmissionEmails, forgetSavedSubmissionTimes } = await import("../index.js");
const { ADMIN_REVIEW_REPLY_SUBJECT, ADMIN_REVIEW_ERROR_TYPE } = await import("../admin-review.js");

const SENDER = "doctor.stale@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

async function report(score: number, sheet = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", score]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function backends(queue?: FakeRow[]) {
  forgetSavedSubmissionTimes();
  return installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
    ...(queue ? { p4p_upload_queue: queue } : {}),
  });
}

/** Fail the next `n` score writes to 2569_10 (a short Supabase blip), on top of the fakes. */
function blipScoreWrites() {
  let left = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    if (left > 0 && (init?.method ?? "GET").toUpperCase() === "PATCH" && url.includes("/rest/v1/2569_10") && body.includes("\"score\"")) {
      left--;
      return new Response(JSON.stringify({ message: "blip" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as typeof fetch;
  return { next: (n: number) => { left = n; } };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

function mail(id: string, receivedAt: string, file: Buffer, labels: string[]) {
  return {
    msg: { id, threadId: `t-${id}`, subject: "ส่ง P4P ตุลาคม 2569", from: `Doc <${SENDER}>`, date: "Sat, 7 Nov 2026 10:00:00 +0700", receivedAt, body: "" },
    attachments: [{ attachmentId: "a1", filename: `P4P_${NAME}.xlsx`, mimeType: XLSX_MIME, size: file.length }],
    files: { a1: file },
    labels: new Set(labels),
  };
}

test("a retried older email does not overwrite the newer score saved while it waited", async () => {
  const be = backends();
  const blip = blipScoreWrites();
  const mA = mail("mA", "2026-11-07T03:00:00.000Z", await report(80), ["INBOX", "UNREAD"]);
  const mB = mail("mB", "2026-11-07T03:01:30.000Z", await report(85), []);   // not arrived yet
  const gmail = fakeGmail([mA, mB]);

  blip.next(1);                                       // poll 1: A's save blips
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.equal(be.tables["2569_10"]![0]!.score, null);
  mB.labels.add("INBOX"); mB.labels.add("UNREAD");    // the corrected file arrives
  blip.next(1);                                       // poll 2: A (oldest, first) blips again; B is saved
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.equal(be.tables["2569_10"]![0]!.score, 85);
  await quiet(() => readSubmissionEmails({ gmail: gmail as never }));   // poll 3: A comes round alone

  const row = be.tables["2569_10"]![0]!;
  assert.equal(row.score, 85, "the newer score stands");
  assert.equal(row.submitted_at, "2026-11-07T03:00:00.000Z", "A's receive time still counts for punctuality");
  assert.deepEqual(gmail.modified.map((m) => m.id).sort(), ["mA", "mB"], "both are handled");
  assert.equal(gmail.sent.filter((s) => s.subject !== ADMIN_REVIEW_REPLY_SUBJECT).length, 1, "one confirmation, for B");
  assert.equal(gmail.sent.filter((s) => s.subject === ADMIN_REVIEW_REPLY_SUBJECT).length, 1, "A's sender is told it is with the admin");
  assert.ok(be.telegrams.some((t) => t.includes("⏮️") && t.includes("mA")), "the admin is told about A");
});

const EMAIL_A = { subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo: SENDER, messageId: "mA", workbookCount: 1, gmailReceivedAt: "2026-11-07T03:00:00.000Z" };

async function emailA() {
  const sent: { subject: string }[] = [];
  const gmail = { sendMessage: async (o: { subject: string }) => { sent.push(o); return {}; } };
  const outcome = await quiet(async () => processBuffer(await report(80), { ...EMAIL_A, gmail } as never));
  return { outcome, sent };
}

test("an email older than a LINE upload already scored for the row is held, not saved", async () => {
  const be = backends([{ id: "q1", month_key: "2569_10", roster_index: 7, status: "done", received_at: "2026-11-07T03:05:00.000Z" }]);
  const { outcome, sent } = await emailA();
  assert.equal(outcome, "replied");
  assert.equal(be.tables["2569_10"]![0]!.score, null, "no score written");
  assert.equal(be.tables["2569_10"]![0]!.submitted_at, "2026-11-07T03:00:00.000Z");
  assert.deepEqual(sent.map((s) => s.subject), [ADMIN_REVIEW_REPLY_SUBJECT]);
});

test("an upload that is older, unscored or for another row does not hold the email", async () => {
  const be = backends([
    { id: "q1", month_key: "2569_10", roster_index: 7, status: "done",    received_at: "2026-11-07T02:00:00.000Z" },
    { id: "q2", month_key: "2569_10", roster_index: 7, status: "pending", received_at: "2026-11-07T03:05:00.000Z" },
    { id: "q3", month_key: "2569_10", roster_index: 8, status: "done",    received_at: "2026-11-07T03:05:00.000Z" },
    { id: "q4", month_key: "2569_09", roster_index: 7, status: "done",    received_at: "2026-11-07T03:05:00.000Z" },
  ]);
  const { outcome } = await emailA();
  assert.equal(outcome, true);
  assert.equal(be.tables["2569_10"]![0]!.score, 80);
});

test("a failed queue read does not stop the save", async () => {
  const be = backends([]);
  be.failingTables.add("p4p_upload_queue");
  const { outcome } = await emailA();
  assert.equal(outcome, true);
  assert.equal(be.tables["2569_10"]![0]!.score, 80);
});

test("LINE path: an older upload retried after a newer email was saved is held for the admin", async () => {
  const be = backends();
  const gmail = { sendMessage: async () => ({}) };
  await quiet(async () => processBuffer(await report(85), { ...EMAIL_A, messageId: "mB", gmailReceivedAt: "2026-11-07T03:10:00.000Z", gmail } as never));
  assert.equal(be.tables["2569_10"]![0]!.score, 85);

  const failed: string[] = [];
  let ok = 0;
  const outcome = await quiet(async () => processBuffer(await report(80, "ตุลาคม 2569"), {
    filename: `P4P_${NAME}.xlsx`, subject: "P4P ตุลาคม 2569", body: "", emailDate: "2026-11-07T03:00:00.000Z",
    source: "line-upload", monthKey: "2569_10",
    identity: { email: SENDER, fullName: NAME, department: "ทดสอบ", rosterIndex: 7, lineUserId: "U0", attempt: 2 },
    notify: { ok: () => { ok++; }, fail: (type: string) => { failed.push(type); } },
  } as never));
  assert.equal(outcome, "rejected");
  assert.equal(ok, 0);
  assert.deepEqual(failed, [ADMIN_REVIEW_ERROR_TYPE]);
  assert.equal(be.tables["2569_10"]![0]!.score, 85);
});
