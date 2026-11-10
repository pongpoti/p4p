// The always-on relay's console output is public while the repository is: no sender address or
// display name, subject, body text, physician name, file or sheet name, or score may reach it
// (log-safe.ts). Unit tests for the helpers, then whole inbox passes through readSubmissionEmails()
// with in-memory Gmail, Supabase and Telegram fakes, checking every line that was printed.
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
import { logTag, redactForLog } from "../log-safe.js";
import { fakeGmail, XLSX_MIME, type FakeMessage } from "./fakeGmail.js";

const { readSubmissionEmails } = await import("../index.js");

// ── helpers ─────────────────────────────────────────────────────────────────

test("logTag: short, stable for one value, different for another, and not the value itself", () => {
  const a = logTag("Someone@Example.com");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(logTag(" someone@example.com "), a, "case and spaces do not matter");
  assert.notEqual(logTag("other@example.com"), a);
  assert.equal(logTag(""), "-");
});

test("redactForLog keeps the technical part of an error and drops what could be personal", () => {
  assert.equal(redactForLog(`Claude returned non-JSON: the physician is Jane Doe`), "Claude returned non-JSON (model output withheld)");
  assert.equal(redactForLog(`Missing or empty "name": {"name": ""}`), `Missing or empty "name" (model output withheld)`);
  assert.match(redactForLog(`Could not determine score. Claude: "abc", JS scan: null (none). Row count: 9. Sample values: ["ทดสอบ ตัวอย่าง", 12]`),
    /^Could not determine score\. Claude: \(withheld\), JS scan: null \(none\)\. Row count: 9\. Sample values: \(withheld\)$/);
  assert.equal(redactForLog(`Supabase query error on table "2569_10": permission denied`), `Supabase query error on table "2569_10": permission denied`);
  assert.equal(redactForLog(`File not found: "P4P_Jane.xlsx" for x.y@example.com`), `File not found: "…" for <email>`);
  assert.equal(redactForLog(`upload failed for ทดสอบ ตัวอย่าง`), `upload failed for <th>`);
  assert.equal(redactForLog(new Error("boom")), "boom");
  assert.equal(redactForLog("x".repeat(400)).length, 301);
});

// ── whole passes ────────────────────────────────────────────────────────────

const FIRST = "ทดสอบ", LAST = "ตัวอย่าง", NAME = `${FIRST} ${LAST}`;
const OWNER = "owner.test@example.com", STRANGER = "stranger.test@example.net";
const DISPLAY = "Owner Testperson";
const SUBJECT = `ส่ง P4P ตุลาคม 2569 ${NAME}`;
const BODY = `เรียนเจ้าหน้าที่ ส่งไฟล์ P4P ของ ${NAME} ครับ hello-body-marker`;
const FILE = `P4P_${NAME}.xlsx`;

async function report(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${FIRST} ต.ค.`);   // a tab named after the physician, as some are
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function mail(from: string): Promise<FakeMessage> {
  const file = await report();
  return {
    msg: { id: "msg-a1", threadId: "thr-a1", subject: SUBJECT, from: `"${DISPLAY}" <${from}>`, date: "Sat, 7 Nov 2026 10:00:00 +0700", receivedAt: "2026-11-07T03:00:00.000Z", body: BODY },
    attachments: [{ attachmentId: "att1", filename: FILE, mimeType: XLSX_MIME, size: file.length }],
    files: { att1: file },
    labels: new Set(["INBOX", "UNREAD"]),
  };
}

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { await run(); } finally { Object.assign(console, orig); }
  return out.join("\n");
}

function assertNothingPersonal(text: string, sender: string) {
  for (const secret of [sender, DISPLAY, FIRST, LAST, "hello-body-marker", FILE, "1234.5", "1234.50"]) {
    assert.ok(!text.includes(secret), `the log must not contain ${JSON.stringify(secret)}`);
  }
  assert.ok(!text.includes("ตุลาคม 2569 " + FIRST), "nor the subject");
}

test("a processed submission prints ids, counts and tags only", async () => {
  const be = installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: FIRST, lastname: LAST, prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians     : [{ email: OWNER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
  const gmail = fakeGmail([await mail(OWNER)]);
  const text = await printed(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.equal(be.patches.filter((p) => "score" in p.body).length, 1, "the submission really ran through");
  assert.equal(gmail.sent.length, 1, "and was confirmed");
  assertNothingPersonal(text, OWNER);
  assert.match(text, /msg-a1/, "the Gmail message id is what identifies it");
  assert.match(text, /roster row #?7/);
  assert.match(text, new RegExp(`sender ${logTag(OWNER)}`));
});

test("a submission that replaces an existing score prints nothing personal either", async () => {
  const be = installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: FIRST, lastname: LAST, prefix: "นพ.", department: "ทดสอบ", score: 999, submitted_at: null }],
    physicians     : [],
    p4p_submissions: [],
  });
  const gmail = fakeGmail([await mail(STRANGER)]);
  const text = await printed(() => readSubmissionEmails({ gmail: gmail as never }));
  assert.ok(be.patches.length > 0, "saved (new senders are still accepted, as before)");
  assertNothingPersonal(text, STRANGER);
});
