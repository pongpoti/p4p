// A name that fits two or more roster rows equally well is never given to the first of them: the
// submission is held for the admin (Telegram) and the sender gets a polite notice naming no one.
// Supabase and Telegram are the in-memory fakes of fakeBackends.ts.
import { FAKE_SUPABASE_URL, installFakeBackends, type FakeRow } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { processBuffer } = await import("../index.js");
const { pickRosterMatch, matchName } = await import("../supabase-client.js");
const { ADMIN_REVIEW_REPLY_SUBJECT, ADMIN_REVIEW_ERROR_TYPE } = await import("../admin-review.js");
const { RetryLaterError } = await import("../inbound-triage.js");
const { errorText } = await import("../templates/line-receipt.js");

const roster = (...names: [string, string, string?][]) =>
  names.map(([firstname, lastname, department], i) => ({ index: i + 1, firstname, lastname, prefix: "นพ.", department: department ?? "ทดสอบ" }));

// ── the picker ────────────────────────────────────────────────────────────

test("a partial name that fits two physicians equally is ambiguous, not the first row", () => {
  const r = pickRosterMatch("อนันต์ สุข", roster(["อนันต์", "สุขสวัสดิ์"], ["อนันต์", "สุขใจ"]));
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.kind === "ambiguous" && r.candidates.map((c) => c.index), [1, 2]);
});

test("the same name twice in the roster is ambiguous, whichever way it is spelled in", () => {
  const rows = roster(["สมชาย", "ใจดี", "ก"], ["สมชาย", "ใจดี", "ข"], ["วิชัย", "สุขดี"]);
  assert.equal(pickRosterMatch("สมชาย ใจดี", rows).kind, "ambiguous");
  assert.equal(pickRosterMatch("สมชาย  ใจด", rows).kind, "ambiguous");
});

test("an exact name on one row is still that row, even beside a near one", () => {
  const r = pickRosterMatch("สมชาย ใจดี", roster(["สมชาย", "ใจดีมาก"], ["สมชาย", "ใจดี"]));
  assert.equal(r.kind, "match");
  assert.equal(r.kind === "match" && r.match.index, 2);
  assert.equal(r.kind === "match" && r.match.similarity, 1);
});

test("a clear fuzzy win is still taken", () => {
  const r = pickRosterMatch("สมชาย ใจด", roster(["วิชัย", "สุขดี"], ["สมชาย", "ใจดี"]));
  assert.equal(r.kind, "match");
  assert.equal(r.kind === "match" && r.match.index, 2);
});

test("a runner-up within the margin makes a fuzzy match ambiguous; one well behind does not", () => {
  const name = "abcdefghijklmnopqrst";   // 20 characters, one token
  const two = "abcdefghijklmnopqrXY", three = "abcdefghijklmnopqXYZ", four = "abcdefghijklmnopWXYZ";
  // 2 vs 4 substitutions: 0.90 vs 0.80 — a clear win
  const clear = pickRosterMatch(name, roster([two, ""], [four, ""]));
  assert.equal(clear.kind, "match");
  assert.equal(clear.kind === "match" && clear.match.similarity, 0.9);
  // 2 vs 3 substitutions: 0.90 vs 0.85 — within 0.05
  const close = pickRosterMatch(name, roster([two, ""], [three, ""]));
  assert.equal(close.kind, "ambiguous");
  // the same distance to both: a tie
  assert.equal(pickRosterMatch(name, roster([two, ""], ["abcdefghijklmnopqrYX", ""])).kind, "ambiguous");
});

test("a first name alone: one row is that row, two rows are ambiguous", () => {
  assert.equal(pickRosterMatch("วิชัย", roster(["วิชัย", "สุขดี"], ["สมชาย", "ใจดี"])).kind, "match");
  assert.equal(pickRosterMatch("สมชาย", roster(["สมชาย", "ใจดี"], ["สมชาย", "รักดี"])).kind, "ambiguous");
});

test("nothing close enough is none", () => {
  assert.equal(pickRosterMatch("ทดสอบ ตัวอย่าง", roster(["วิชัย", "สุขดี"])).kind, "none");
});

test("matchName (the scripts' lookup) returns null for an ambiguous name", async () => {
  installFakeBackends({ "2569_10": roster(["สมชาย", "ใจดี"], ["สมชาย", "ใจดี"]) as FakeRow[] });
  assert.equal(await matchName("สมชาย ใจดี", "2569_10"), null);
});

// ── through processBuffer ───────────────────────────────────────────────

const NAME = "ทดสอบ ตัวอย่าง";
const SENDER = "doctor.twin@example.com";

async function report(sheet = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function twins() {
  return installFakeBackends({
    "2569_10": [
      { index: 3, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ศัลยกรรม", score: null, submitted_at: null },
      { index: 9, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "พญ.", department: "อายุรกรรม", score: 500, submitted_at: null },
    ],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

async function email() {
  const sent: { to: string; subject: string; body?: string }[] = [];
  const gmail = { sendMessage: async (o: { to: string; subject: string; body?: string }) => { sent.push(o); return {}; } };
  const file = await report();
  const outcome = await quiet(() => processBuffer(file, {
    subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo: SENDER, messageId: "msg-twin", gmail,
    gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1, receipt: { answered: true },
  } as never).catch((e: unknown) => e));
  return { outcome, sent };
}

test("email: a name on two roster rows is held for the admin — nothing saved, the sender told politely", async () => {
  const be = twins();
  const { outcome, sent } = await email();
  assert.equal(outcome, "replied", "answered, so the message is marked handled");
  assert.equal(be.patches.length, 0, "no score written to either row");
  assert.equal(be.tables["2569_10"]![1]!.score, 500);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, SENDER);
  assert.equal(sent[0]!.subject, ADMIN_REVIEW_REPLY_SUBJECT);
  assert.doesNotMatch(sent[0]!.body ?? "", new RegExp(NAME), "names no physician");
  assert.doesNotMatch(sent[0]!.body ?? "", /1234/, "and no score");
  assert.match(sent[0]!.body ?? "", /ไม่ต้องส่งไฟล์ใหม่/);
  assert.doesNotMatch(sent[0]!.subject, /ไม่พบชื่อแพทย์/, "not a 'physician not found' alert");

  const alert = be.telegrams.find((t) => t.includes("มากกว่าหนึ่งคน"));
  assert.ok(alert, "the admin is told");
  for (const needle of ["#3", "#9", "ศัลยกรรม", "อายุรกรรม", "msg-twin", "1234.50", "2569_10", SENDER]) {
    assert.ok(alert!.includes(needle), `alert mentions ${needle}`);
  }
});

test("email: if the admin cannot be told, nothing is sent and it is retried", async () => {
  const be = twins();
  be.telegramDown = true;
  const { outcome, sent } = await email();
  assert.ok(outcome instanceof RetryLaterError);
  assert.equal(sent.length, 0);
  assert.equal(be.patches.length, 0);
});

test("LINE: an account whose name fits two rows is held for the admin, not written to the first", async () => {
  const be = twins();
  const fails: { type: string; detail: string }[] = [];
  let ok = 0;
  const file = await report("ตุลาคม 2569");
  const outcome = await quiet(() => processBuffer(file, {
    filename: `P4P_${NAME}.xlsx`, subject: "P4P ตุลาคม 2569", body: "", emailDate: "2026-11-07T03:00:00.000Z",
    source: "line-upload", monthKey: "2569_10",
    identity: { email: SENDER, fullName: NAME, department: "ศัลยกรรม", rosterIndex: null, lineUserId: "U0", attempt: 1, queueId: "q-123" },
    notify: { ok: () => { ok++; }, fail: (type: string, detail: string) => { fails.push({ type, detail }); } },
  } as never));
  assert.equal(outcome, "rejected", "terminal: retrying cannot tell the rows apart");
  assert.equal(ok, 0);
  assert.equal(be.patches.length, 0);
  assert.deepEqual(fails.map((f) => f.type), [ADMIN_REVIEW_ERROR_TYPE]);
  assert.match(fails[0]!.detail, /ไม่ต้องส่งไฟล์ใหม่/);
  assert.doesNotMatch(errorText(ADMIN_REVIEW_ERROR_TYPE), /ส่งใหม่$/, "the LINE bubble does not ask for a resend");
  const alert = be.telegrams.find((t) => t.includes("มากกว่าหนึ่งคน"));
  assert.ok(alert);
  assert.ok(alert!.includes("q-123") && alert!.includes("roster_index"), "the admin is told how to re-run the queue row");
});
