/**
 * The confirmation email, now shared by the email path and the LINE upload
 * path. Its text is what physicians have been receiving for months, so the
 * plain-text part is pinned exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationEmail, sendUploadConfirmation, CONFIRMATION_SUBJECT } from "../confirmation-email.js";
import type { GmailClient } from "../gmail-client.js";

const DATA = {
  prefix: "นพ.",
  matchedName: "สมชาย ใจดี",
  department: "อายุรกรรม",
  monthKey: "2569_06",
  score: 1842.5,
};

test("subject and plain text match the email path's reply", () => {
  const mail = buildConfirmationEmail(DATA);
  assert.equal(mail.subject, CONFIRMATION_SUBJECT);
  assert.equal(
    mail.body,
    "เรียน นพ. สมชาย  ใจดี\n\nองค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว\n\n" +
      "ชื่อแพทย์: นพ. สมชาย  ใจดี\nเดือน/ปี: มิถุนายน 2569\nคะแนนรวม: 1842.50\n\nขอบคุณที่ให้ความร่วมมือเป็นอย่างดี"
  );
  assert.match(mail.html, /อายุรกรรม/);
  assert.match(mail.html, /มิถุนายน 2569/);
});

test("the HTML part escapes the name", () => {
  const mail = buildConfirmationEmail({ ...DATA, matchedName: "<b>x</b> y" });
  assert.doesNotMatch(mail.html, /<b>x<\/b>/);
});

function fakeGmail(opts: { failSend?: boolean } = {}) {
  const calls: { sent: unknown[]; labelled: [string, string[], string[]][]; ensured: string[] } = { sent: [], labelled: [], ensured: [] };
  const gmail = {
    async sendMessage(m: unknown) {
      if (opts.failSend) throw new Error("boom");
      calls.sent.push(m);
      return { id: "sent-1" };
    },
    async ensureLabel(name: string) { calls.ensured.push(name); return "Label_P4P"; },
    async modifyMessage(id: string, add: string[] = [], remove: string[] = []) {
      calls.labelled.push([id, add, remove]);
      return {};
    },
  } as unknown as GmailClient;
  return { gmail, calls };
}

test("a LINE upload confirmation is sent as a new message and filed under เอกสาร P4P", async () => {
  const { gmail, calls } = fakeGmail();
  assert.equal(await sendUploadConfirmation(gmail, "dr@example.com", DATA), true);
  assert.equal(calls.sent.length, 1);
  const sent = calls.sent[0] as { to: string; replyToMessageId?: string; subject: string };
  assert.equal(sent.to, "dr@example.com");
  assert.equal(sent.replyToMessageId, undefined);
  assert.equal(sent.subject, CONFIRMATION_SUBJECT);
  assert.deepEqual(calls.ensured, ["เอกสาร P4P"]);
  assert.deepEqual(calls.labelled, [["sent-1", ["Label_P4P"], ["INBOX"]]]);
});

test("a failed send never throws and labels nothing", async () => {
  const { gmail, calls } = fakeGmail({ failSend: true });
  assert.equal(await sendUploadConfirmation(gmail, "dr@example.com", DATA), false);
  assert.equal(calls.labelled.length, 0);
});

test("no address, no email", async () => {
  const { gmail, calls } = fakeGmail();
  assert.equal(await sendUploadConfirmation(gmail, "", DATA), false);
  assert.equal(calls.sent.length, 0);
});
