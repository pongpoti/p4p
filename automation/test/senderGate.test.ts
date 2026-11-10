// Who may change a physician's score by email (sender-gate.ts), unit-tested and then driven through
// the real processBuffer / readSubmissionEmails with in-memory Supabase, Telegram and Gmail fakes.
// All data is made up; nothing leaves the box.
import { FAKE_SUPABASE_URL, installFakeBackends, type FakeRow } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.GOOGLE_CLIENT_ID = "test"; process.env.GOOGLE_CLIENT_SECRET = "test"; process.env.GOOGLE_REFRESH_TOKEN = "test";
process.env.SKIP_SENDERS = "relay@example.org,inbox@example.org"; process.env.THREAD_RELAY_SENDERS = "relay@example.org";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import type { PhysicianAccount } from "../sender-gate.js";
import { fakeGmail, XLSX_MIME } from "./fakeGmail.js";

// Imported only after the env above is set: config.ts reads SKIP_SENDERS when it is first evaluated.
const { processBuffer, readSubmissionEmails } = await import("../index.js");
const { sameRosterName, isKnownSender, decideSenderGate, holdReplyBody, HOLD_REPLY_SUBJECT } = await import("../sender-gate.js");
const { MAX_THROWN_PASSES } = await import("../inbound-triage.js");

const NAME   = "ทดสอบ ตัวอย่าง";
const OWNER  = "owner.test@example.com";
const OTHER  = "someone.else@example.net";

// ── unit ──────────────────────────────────────────────────────────────────

test("names compare after trimming and collapsing whitespace, and an empty name matches nothing", () => {
  assert.equal(sameRosterName(" ทดสอบ   ตัวอย่าง ", NAME), true);
  assert.equal(sameRosterName("ทดสอบ ตัวอย่าง", NAME), true);
  assert.equal(sameRosterName("ทดสอบ ตัวอย่างอื่น", NAME), false);
  assert.equal(sameRosterName("", ""), false);
  assert.equal(sameRosterName(null, null), false);
});

test("only an ACTIVE physicians row with the roster name is the physician's own address", () => {
  const acct = (fullName: string, active = true): PhysicianAccount => ({ email: OWNER, fullName, active });
  assert.equal(isKnownSender(acct(NAME), NAME), true);
  assert.equal(isKnownSender(acct(NAME, false), NAME), false, "revoked");
  assert.equal(isKnownSender(acct("อื่น ๆ คนอื่น"), NAME), false, "another physician's address");
  assert.equal(isKnownSender(null, NAME), false);
});

test("the gate: known, new address on an unscored row, held on a scored one; relays are nobody", async () => {
  const calls: string[] = [];
  const deps = (account: PhysicianAccount | null, score: number | null) => ({
    lookupAccount: async (e: string) => { calls.push(`acct ${e}`); return account; },
    lookupScore  : async (m: string, i: number | string) => { calls.push(`score ${m} ${i}`); return score; },
    relaySenders : new Set(["relay@example.org"]),
  });
  const mine = { email: OWNER, fullName: NAME, active: true };

  assert.equal((await decideSenderGate(" Owner.Test@Example.com ", NAME, "2569_10", 7, deps(mine, 1500))).gate, "known");
  assert.deepEqual(calls, [`acct ${OWNER}`], "address lower-cased; a known sender needs no score lookup");

  calls.length = 0;
  assert.equal((await decideSenderGate(OTHER, NAME, "2569_10", 7, deps(null, null))).gate, "new_unscored");
  const held = await decideSenderGate(OTHER, NAME, "2569_10", 7, deps(null, 1500));
  assert.equal(held.gate, "hold");
  assert.equal(held.rosterScore, 1500);
  assert.equal((await decideSenderGate(OTHER, NAME, "2569_10", 7, deps(null, 0))).gate, "hold", "a saved 0 is still a score");

  calls.length = 0;
  const relay = await decideSenderGate("relay@example.org", NAME, "2569_10", 7, deps(mine, 1500));
  assert.equal(relay.gate, "hold", "a relay mailbox is never the physician, whatever physicians says");
  assert.deepEqual(calls, ["score 2569_10 7"], "a relay address is not even looked up");

  await assert.rejects(decideSenderGate(OTHER, NAME, "2569_10", 7, {
    ...deps(null, null), lookupAccount: async () => { throw new Error("physicians lookup error: boom"); },
  }), /physicians lookup error/, "a failed lookup is never read as 'unknown'");
});

test("the hold notice to an unconfirmed sender names no physician and no score", () => {
  const body = holdReplyBody();
  assert.match(body, /ได้รับไฟล์ P4P/);
  assert.match(body, /รอผู้ดูแลระบบยืนยันอีเมลผู้ส่ง/);
  assert.doesNotMatch(body, /\d{2,}/, "no score, month or year");
});

// ── through processBuffer ───────────────────────────────────────────────────

async function report(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of [["B5", "ประเภทงาน"], ["C5", 10], ["C6", 11], ["A10", "รวมทั้งหมด"], ["C10", 1234.5]] as [string, string | number][]) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function backends({ score = null as number | null, physicians = [] as FakeRow[] } = {}) {
  return installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score, submitted_at: score === null ? null : "2026-11-03T02:00:00.000Z" }],
    physicians     : physicians,
    p4p_submissions: [],
  });
}

async function submit(replyTo: string) {
  const sent: { to: string; subject: string; body?: string; html?: string }[] = [];
  const gmail = { sendMessage: async (o: { to: string; subject: string; body?: string; html?: string }) => { sent.push(o); return {}; } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    const outcome = await processBuffer(await report(), {
      subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: `P4P_${NAME}.xlsx`, replyTo, messageId: "msg-1", gmail,
      emailDate: "2026-11-07T03:00:00Z", gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1,
    } as never).catch((e: Error) => `THROW ${e.message}`);
    return { outcome, sent };
  } finally {
    Object.assign(console, orig);
  }
}

const scoreWrites = (be: ReturnType<typeof backends>) => be.patches.filter((p) => "score" in p.body);

test("a known sender is processed exactly as before", async () => {
  const be = backends({ score: 999, physicians: [{ email: OWNER, full_name: NAME, active: true }] });
  const r = await submit(OWNER);
  assert.equal(r.outcome, true);
  assert.deepEqual(scoreWrites(be).map((p) => p.body.score), [1234.5], "the existing score is replaced, as before");
  assert.equal(r.sent.length, 1);
  assert.notEqual(r.sent[0]!.subject, HOLD_REPLY_SUBJECT, "a confirmation, not a hold notice");
  assert.equal(be.telegrams.length, 1, "only the usual result message");
});

test("an unknown sender for a physician with no score yet is accepted, and the admin is told", async () => {
  const be = backends({ score: null });
  const r = await submit(OTHER);
  assert.equal(r.outcome, true);
  assert.deepEqual(scoreWrites(be).map((p) => p.body.score), [1234.5]);
  assert.equal(r.sent.length, 1, "the usual confirmation");
  assert.ok(be.rpcs.some((c) => c.fn === "bump_sender_match" && c.args.p_sender_email === OTHER), "the address is recorded for an access request");
  const alert = be.telegrams.find((t) => t.includes("อีเมลผู้ส่งใหม่"));
  assert.ok(alert, "new-sender alert sent");
  assert.match(alert!, new RegExp(OTHER.replace(/\./g, "\\.")));
  assert.match(alert!, new RegExp(NAME));
  assert.match(alert!, /2569_10/);
  assert.match(alert!, /รออนุมัติในคำขอเข้าใช้/);
});

test("an unknown sender for a physician who already has a score is held: nothing saved, sender and admin told", async () => {
  const be = backends({ score: 999, physicians: [{ email: OTHER, full_name: "คนอื่น นามสมมติ", active: true }] });
  const r = await submit(OTHER);
  assert.equal(r.outcome, "replied", "replied = the message is marked handled, not re-read every minute");
  assert.deepEqual(scoreWrites(be), [], "score not saved");
  assert.equal(be.patches.length, 0, "submitted_at untouched too");
  assert.equal(be.inserts.filter((i) => i.table === "p4p_submissions").length, 0);
  assert.equal(be.tables["2569_10"]![0]!.score, 999);

  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.to, OTHER);
  assert.equal(r.sent[0]!.subject, HOLD_REPLY_SUBJECT);
  assert.doesNotMatch(r.sent[0]!.body ?? "", new RegExp(NAME), "the sender is not told who the file matched");
  assert.doesNotMatch(r.sent[0]!.body ?? "", /1234/, "nor the score");

  assert.ok(be.rpcs.some((c) => c.fn === "bump_sender_match"), "an access request can be approved to release it");
  assert.equal(be.telegrams.length, 1);
  const alert = be.telegrams[0]!;
  for (const needle of [OTHER, NAME, "2569_10", "1234.50", "999.00", "msg-1", "แท็บ Roster", "ยังไม่อ่าน", "เอกสาร P4P", "ลงทะเบียนเป็นชื่อ"]) {
    assert.ok(alert.includes(needle), `hold alert mentions ${needle}`);
  }
});

test("a held submission whose admin alert cannot be sent is not answered or marked: it throws for a retry", async () => {
  const be = backends({ score: 999 });
  be.telegramDown = true;
  const r = await submit(OTHER);
  assert.match(String(r.outcome), /^THROW held submission: admin alert not delivered/);
  assert.equal(r.sent.length, 0);
  assert.deepEqual(scoreWrites(be), []);
});

test("a relay mailbox is never accepted as the physician, even with a physicians row of that name", async () => {
  const be = backends({ score: 999, physicians: [{ email: "inbox@example.org", full_name: NAME, active: true }] });
  const r = await submit("inbox@example.org");
  assert.equal(r.outcome, "replied");
  assert.deepEqual(scoreWrites(be), []);
});

test("a revoked address is not the physician's", async () => {
  const be = backends({ score: 999, physicians: [{ email: OWNER, full_name: NAME, active: false }] });
  assert.equal((await submit(OWNER)).outcome, "replied");
  assert.deepEqual(scoreWrites(be), []);
  assert.match(be.telegrams[0]!, /ถูกปิดใช้งาน/);
});

// ── through readSubmissionEmails: a lookup that keeps failing is retried, then set aside ──────

test("a message whose sender lookup keeps failing is retried a bounded number of polls, then set aside", async () => {
  const be = backends({ score: 999 });
  be.failingTables.add("physicians");
  const file = await report();
  const gmail = fakeGmail([{
    msg: { id: "m-throws", threadId: "t9", subject: "ส่ง P4P ตุลาคม 2569", from: `Someone <${OTHER}>`, date: "Sat, 7 Nov 2026 10:00:00 +0700", receivedAt: "2026-11-07T03:00:00.000Z", body: "" },
    attachments: [{ attachmentId: "a1", filename: `P4P_${NAME}.xlsx`, mimeType: XLSX_MIME, size: file.length }],
    files: { a1: file },
    labels: new Set(["INBOX", "UNREAD"]),
  }]);
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    for (let i = 1; i < MAX_THROWN_PASSES; i++) {
      await readSubmissionEmails({ gmail: gmail as never });
      assert.equal(gmail.modified.length, 0, `still unread after poll ${i}`);
    }
    await readSubmissionEmails({ gmail: gmail as never });
    assert.deepEqual(gmail.modified.map((m) => m.id), ["m-throws"], "set aside after the last pass");
    await readSubmissionEmails({ gmail: gmail as never });
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(gmail.modified.length, 1, "and not fetched again");
  assert.deepEqual(scoreWrites(be), []);
  assert.equal(gmail.sent.length, 0, "the sender was never told anything wrong");
  assert.ok(be.telegrams.some((t) => t.includes("m-throws") && t.includes(`${MAX_THROWN_PASSES} รอบ`)), "the admin is told");
});
