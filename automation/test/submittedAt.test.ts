// The punctuality timestamp (submitted_at) is Gmail's receive time, never the sender-written Date
// header: saveScore only moves submitted_at earlier, so a backdated header would stick for good.
// Supabase and Telegram are the in-memory fakes of fakeBackends.ts; nothing leaves the box.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { processBuffer, submissionTime, forgetSavedSubmissionTimes } = await import("../index.js");

const SENDER = "doctor.test@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

async function report(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function backends() {
  // Each test saves the same row afresh; an earlier test's newer save must not hold this one back.
  forgetSavedSubmissionTimes();
  return installFakeBackends({
    "2569_10"        : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians       : [{ email: SENDER, full_name: NAME, department: "ทดสอบ", active: true }],
    p4p_submissions  : [],
  });
}

async function send(ctx: Record<string, unknown>) {
  const sent: { to: string; subject: string }[] = [];
  const gmail = { sendMessage: async (o: { to: string; subject: string }) => { sent.push(o); return {}; } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return { outcome: await processBuffer(await report(), {
      subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`,
      replyTo: SENDER, messageId: "m1", gmail, workbookCount: 1, ...ctx,
    } as never), sent };
  } finally {
    Object.assign(console, orig);
  }
}

test("submissionTime prefers Gmail's receive time, then the fallback, then now", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  assert.equal(submissionTime("2026-11-07T03:00:00.000Z", "Sun, 1 Nov 2026 07:00:00 +0700", now).toISOString(), "2026-11-07T03:00:00.000Z");
  assert.equal(submissionTime(undefined, "Sun, 1 Nov 2026 07:00:00 +0700", now).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(submissionTime("garbage", "also garbage", now), now);
  assert.equal(submissionTime(null, null, now), now);
});

test("a backdated Date header does not become submitted_at — Gmail's receive time does", async () => {
  const be = backends();
  const r = await send({ emailDate: "Sun, 1 Nov 2026 07:00:00 +0700", gmailReceivedAt: "2026-11-07T03:00:00.000Z" });
  assert.equal(r.outcome, true);
  const stamp = be.patches.find((p) => "submitted_at" in p.body);
  assert.ok(stamp, "submitted_at was written");
  assert.equal(stamp!.body.submitted_at, "2026-11-07T03:00:00.000Z");
  const logged = be.inserts.find((i) => i.table === "p4p_submissions")?.body as { submitted_at?: string } | undefined;
  assert.equal(logged?.submitted_at, "2026-11-07T03:00:00.000Z");
});

test("with no Gmail receive time the header is still used, as before", async () => {
  const be = backends();
  await send({ emailDate: "Sun, 1 Nov 2026 07:00:00 +0700" });
  assert.equal(be.patches.find((p) => "submitted_at" in p.body)?.body.submitted_at, "2026-11-01T00:00:00.000Z");
});
