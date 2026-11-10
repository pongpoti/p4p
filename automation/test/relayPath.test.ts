// The relay path of readSubmissionEmails(): a relay sender's message whose thread holds the original
// sender's workbook. An outcome that already answered the sender ("replied"/"rejected") must mark the
// relay message handled, like the other two paths do, or the always-on relay re-answers it every minute.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.GOOGLE_CLIENT_ID = "test"; process.env.GOOGLE_CLIENT_SECRET = "test"; process.env.GOOGLE_REFRESH_TOKEN = "test";
process.env.SKIP_SENDERS = "relay@example.org"; process.env.THREAD_RELAY_SENDERS = "relay@example.org";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { fakeGmail, XLSX_MIME, type FakeMessage } from "./fakeGmail.js";

const { readSubmissionEmails } = await import("../index.js");

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function relayThread(subject: string): Promise<FakeMessage[]> {
  const file = await workbook();
  return [
    {
      msg: { id: "orig1", threadId: "t1", subject, from: "Doc <doc@example.com>", date: "Mon, 2 Nov 2026 08:00:00 +0700", receivedAt: "2026-11-02T01:00:00.000Z", body: "" },
      attachments: [{ attachmentId: "a1", filename: "x.xlsx", mimeType: XLSX_MIME, size: file.length }],
      files: { a1: file },
      labels: new Set(["SENT"]),
    },
    {
      msg: { id: "relay1", threadId: "t1", subject: `Fwd: ${subject}`, from: "Relay <relay@example.org>", date: "Mon, 2 Nov 2026 09:00:00 +0700", receivedAt: "2026-11-02T02:00:00.000Z", body: "" },
      attachments: [],
      labels: new Set(["INBOX", "UNREAD"]),
    },
  ];
}

async function poll(gmail: ReturnType<typeof fakeGmail>): Promise<void> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { await readSubmissionEmails({ gmail: gmail as never }); } finally { Object.assign(console, orig); }
}

test("a relayed workbook that was answered with an alert marks the relay message handled — once", async () => {
  installFakeBackends({});
  // No month anywhere: a no_period rejection, which already emails the original sender.
  const gmail = fakeGmail(await relayThread("ส่ง P4P"));
  await poll(gmail);
  assert.equal(gmail.sent.length, 1, "the original sender is answered");
  assert.equal(gmail.sent[0]!.to, "doc@example.com");
  assert.deepEqual(gmail.modified, [{ id: "relay1", add: ["LBL_P4P"], remove: ["UNREAD", "INBOX"] }]);

  await poll(gmail);   // the next minute's poll
  assert.equal(gmail.sent.length, 1, "not answered again a minute later");
});
