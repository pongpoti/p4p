import { test } from "node:test";
import assert   from "node:assert/strict";
import {
  isAutomatedSender, decideNoXlsx, isHandled, normalizeSubject,
  isSupersededBy, findSupersedingPeer, shouldSendHeldAlert, distinctiveRemainder, settleHeldAlerts, messageRanToCompletion, withRetry, type TriageMessage,
} from "../inbound-triage.js";

// Everything here can only REMOVE an alert reply. The cases worth pinning are
// the ones where removing it would leave a sender uninformed about something
// that really was not received.

// ── automated senders ────────────────────────────────────────────────────

test("no-reply style addresses are automated", () => {
  for (const a of [
    "noreply@example.com", "no-reply@example.com", "no_reply@example.com", "do-not-reply@example.com",
    "donotreply@example.com", "drive-shares-dm-noreply@google.com", "mailer-daemon@example.com",
    "postmaster@example.com", "NoReply@Example.com", "  noreply@example.com  ",
  ]) assert.equal(isAutomatedSender(a), true, a);
});

test("people, lookalikes and malformed addresses are not automated", () => {
  for (const a of [
    "somebody@example.com", "replyto@example.com", "noreplyfan@example.com", "bernoreply@example.com",
    "reply@example.com", "user+noreply@example.com", "", "noreply", "@example.com", null, undefined,
  ]) assert.equal(isAutomatedSender(a as string), false, String(a));
});

// ── what to do with a message that has no xlsx ───────────────────────────

test("a person who sends a link or a foreign file is still told, link first", () => {
  assert.equal(decideNoXlsx({ fromEmail: "a@example.com", hasCloudLink: true,  hasOtherAtts: false }), "alert_file_link");
  assert.equal(decideNoXlsx({ fromEmail: "a@example.com", hasCloudLink: false, hasOtherAtts: true  }), "alert_wrong_extension");
  assert.equal(decideNoXlsx({ fromEmail: "a@example.com", hasCloudLink: true,  hasOtherAtts: true  }), "alert_file_link");
});

test("an automated sender is not replied to, but the message still counts as handled", () => {
  const a = decideNoXlsx({ fromEmail: "drive-shares-dm-noreply@google.com", hasCloudLink: true, hasOtherAtts: false });
  assert.equal(a, "skip_automated");
  assert.equal(isHandled(a), true, "unmarked, the next hourly run would fetch it again");
});

test("nothing actionable stays unhandled, automated sender or not", () => {
  for (const from of ["a@example.com", "noreply@example.com"]) {
    const a = decideNoXlsx({ fromEmail: from, hasCloudLink: false, hasOtherAtts: false });
    assert.equal(a, "skip_nothing");
    assert.equal(isHandled(a), false);
  }
  assert.equal(isHandled("alert_file_link"), true);
  assert.equal(isHandled("alert_wrong_extension"), true);
});

// ── a link-only message the sender already re-sent as a real file ───────

const T0 = Date.UTC(2026, 9, 4, 9, 1, 25);   // an arbitrary instant
const min = (n: number) => n * 60 * 1000;

function msg(over: Partial<TriageMessage>): TriageMessage {
  return {
    id: "m1", fromEmail: "sender@example.com", subject: "P4P กันยายน", body: "",
    dateMs: T0, attachmentNames: [], xlsxNames: [], ...over,
  };
}
const NAME = "P4P_Somchai_Sep69.xlsx";
const link = (over: Partial<TriageMessage> = {}) =>
  msg({ id: "link", body: `ส่งไฟล์ ${NAME} <https://docs.google.com/file/d/AbC123>`, ...over });
const real = (over: Partial<TriageMessage> = {}) =>
  msg({ id: "real", dateMs: T0 + min(2), attachmentNames: [NAME], xlsxNames: [NAME], ...over });

test("the Oct-4 shape: link-only message, the real xlsx two minutes later", () => {
  assert.equal(isSupersededBy(link(), real()), true);
  assert.equal(findSupersedingPeer(link(), [msg({ id: "other", fromEmail: "x@example.com" }), real()])?.id, "real");
});

test("the Sep-30 shape: the xlsx, then a PDF export of it seconds later", () => {
  const pdf = msg({ id: "pdf", dateMs: T0 + 11_000, attachmentNames: ["รายงาน P4P ก.ย.69.xlsx.pdf"], body: "" });
  // (the PDF may also be saved under the workbook's stem: "<stem>.pdf")
  const xlsx = msg({ id: "x", dateMs: T0, attachmentNames: ["รายงาน P4P ก.ย.69.xlsx"], xlsxNames: ["รายงาน P4P ก.ย.69.xlsx"] });
  assert.equal(isSupersededBy(pdf, xlsx), true, "a rendition within 5 minutes is the same submission");
  assert.equal(isSupersededBy({ ...pdf, dateMs: T0 + min(6) }, xlsx), false, "…but not 6 minutes later");
  assert.equal(isSupersededBy({ ...pdf, attachmentNames: ["รายงาน P4P ก.ย.69.pdf"] }, xlsx), false, "<stem>.pdf of a generic name could be anyone's");
  const named = (ext: string) => msg({ id: "p", dateMs: T0 + 11_000, attachmentNames: [`${NAME.replace(/\.xlsx$/, "")}.${ext}`], body: "" });
  const file = msg({ id: "x", dateMs: T0, attachmentNames: [NAME], xlsxNames: [NAME] });
  assert.equal(isSupersededBy(named("pdf"), file), true, "<stem>.pdf of a name with a person in it is a rendition");
  for (const ext of ["xls", "xlsm", "ods", "csv", "zip", "exe", "docx"]) assert.equal(isSupersededBy(named(ext), file), false, `.${ext} is a different file, not a copy`);
  assert.equal(isSupersededBy({ ...pdf, attachmentNames: ["รายงาน P4P ก.ย.69.xlsx.pdf", "ใบลา.pdf"] }, xlsx), false, "…but every attachment must be one");
});

test("never suppresses across senders, or when nothing real was attached", () => {
  assert.equal(isSupersededBy(link(), real({ fromEmail: "other@example.com" })), false);
  assert.equal(isSupersededBy(link(), real({ attachmentNames: [], xlsxNames: [] })), false);
  assert.equal(isSupersededBy(link({ fromEmail: "" }), real({ fromEmail: "" })), false);
  assert.equal(isSupersededBy(link(), link({ id: "link2" })), false);
  assert.equal(isSupersededBy(link(), { ...link(), id: "link" }), false, "a message is not its own replacement");
});

test("an empty or '(no subject)' subject proves nothing", () => {
  assert.equal(isSupersededBy(link({ subject: "" }), real({ subject: "" })), false);
  assert.equal(isSupersededBy(link({ subject: "(no subject)" }), real({ subject: "(no subject)" })), false);
  assert.equal(normalizeSubject("Re: Fwd:  P4P  กันยายน "), "p4p กันยายน");
  assert.equal(isSupersededBy(link({ subject: "Re: P4P กันยายน" }), real()), true, "reply prefixes do not change the subject");
  assert.equal(isSupersededBy(link({ subject: "P4P สิงหาคม" }), real()), false, "different subject");
});

test("a later link, hours after the file, may be a correction and is still answered", () => {
  assert.equal(isSupersededBy(link({ dateMs: T0 + min(180) }), real()), false);
  assert.equal(isSupersededBy(link({ dateMs: T0 + min(45) }), real()), false, "outside the 30-minute window");
  assert.equal(isSupersededBy(link({ dateMs: T0 + min(10) }), real()), false, "newer than the file and not a rendition of it");
  assert.equal(isSupersededBy(link({ dateMs: null }), real()), false, "an unparseable Date header proves nothing");
});

test("the link must name the same file, as a whole token", () => {
  assert.equal(isSupersededBy(link({ body: "ส่งไฟล์ <https://docs.google.com/file/d/AbC123>" }), real()), false, "no file name at all");
  assert.equal(isSupersededBy(link({ body: `old_${NAME} <https://docs.google.com/x>` }), real()), false, "a different file ending the same way");
  assert.equal(isSupersededBy(link({ body: `${NAME}2 <https://docs.google.com/x>` }), real()), false, "…or continuing the same way (right boundary)");
  assert.equal(isSupersededBy(link({ body: `Folder/${NAME} <https://docs.google.com/x>` }), real()), false, "a path is another file");
  assert.equal(isSupersededBy(link({ body: "11.xlsx <https://docs.google.com/x>" }), real({ attachmentNames: ["1.xlsx"], xlsxNames: ["1.xlsx"] })), false, "too short to be evidence");
  assert.equal(isSupersededBy(link({ body: `"${NAME}" https://docs.google.com/x` }), real()), true, "a quote is a boundary");
  assert.equal(isSupersededBy(link({ body: `${NAME}\n<https://drive.google.com/file/d/AbC/view?usp=drive_web>` }), real()), true, "Gmail's chip text: name, newline, link");
});

test("a generic file name is not evidence of the same file (P4P.xlsx is everyone's)", () => {
  const generic = { attachmentNames: ["P4P.xlsx"], xlsxNames: ["P4P.xlsx"] };
  assert.equal(isSupersededBy(link({ subject: "P4P", body: "P4P.xlsx <https://docs.google.com/x>" }), real({ subject: "P4P", ...generic })), false);
  assert.equal(isSupersededBy(link({ subject: "P4P", body: "Book1.xlsx <https://docs.google.com/x>" }), real({ subject: "P4P", attachmentNames: ["Book1.xlsx"], xlsxNames: ["Book1.xlsx"] })), false);
});

test("a generic file name is not evidence of the same file — even with a month in the (identical) subject", () => {
  // The subjects of the two messages are identical by construction, so a month in them proves nothing about the FILE.
  for (const generic of ["P4P-Intern.xlsx", "template.xlsx", "P4P_form.xlsx", "P4P_Final.xlsx", "P4P ส.ค. 2569.xlsx", "P4P_Sep69.xlsx", "รายงาน P4P ก.ย.69.xlsx"]) {
    const l = link({ subject: "P4P สิงหาคม 2569", body: `${generic} <https://docs.google.com/x>` });
    const r = real({ subject: "P4P สิงหาคม 2569", attachmentNames: [generic], xlsxNames: [generic] });
    assert.equal(isSupersededBy(l, r), false, generic);
  }
  assert.equal(isSupersededBy(link(), real()), true, "control: a name that has a person in it");
  assert.equal(distinctiveRemainder("P4P_Somchai_Sep69"), "somchai");
  assert.equal(distinctiveRemainder("P4P ส.ค. 2569"), "");
  assert.equal(distinctiveRemainder("template"), "");
  assert.ok(distinctiveRemainder("สมชาย ใจดี P4P ก.ย.").length >= 5, "a Thai name");
  // generic Thai month tails, dotless abbreviations and hospital words must not pass for a person
  for (const generic of ["P4P กุมภาพันธ์ 2569", "รพ.สค. P4P สิงหาคม 2569", "P4P_Medicine_Aug", "อายุรกรรม P4P กันยายน", "โรงพยาบาลสมุทรสาคร P4P"]) {
    assert.ok(distinctiveRemainder(generic).length < 5, `${generic} -> ${distinctiveRemainder(generic)}`);
  }
});

test("each threshold is its own condition", () => {
  assert.equal(isSupersededBy(link({ dateMs: T0 - min(25) }), real()), true, "a link 27 minutes before the file");
  assert.equal(isSupersededBy(link({ dateMs: T0 - min(45) }), real()), false, "…45 minutes before is outside the window");
  assert.equal(isSupersededBy(link({ subject: "ส่งงาน" }), real({ subject: "ไฟล์ล่าสุด" })), false, "different subjects");
  // a rendition has no distinctiveness requirement, but its name still needs a stem of 8 characters
  const pdf = (stem: string, over: Partial<TriageMessage> = {}) => msg({ id: "pdf", dateMs: T0 + 20_000, attachmentNames: [`${stem}.xlsx.pdf`], ...over });
  const xl = (stem: string) => msg({ id: "x", attachmentNames: [`${stem}.xlsx`], xlsxNames: [`${stem}.xlsx`] });
  assert.equal(isSupersededBy(pdf("12345678"), xl("12345678")), true, "8-character stem");
  assert.equal(isSupersededBy(pdf("12345"), xl("12345")), false, "5-character stem");
  assert.equal(isSupersededBy(pdf("123"), xl("123")), false, "3-character stem");
});

test("correction wording in either message keeps the alert", () => {
  for (const text of ["ไฟล์เก่า ใช้ฉบับใหม่แทน", "corrected version", "old version", "แก้ไขแล้ว", "please ignore the earlier one"]) {
    assert.equal(isSupersededBy(link({ body: `${NAME} <https://docs.google.com/x> ${text}` }), real()), false, `link: ${text}`);
    assert.equal(isSupersededBy(link(), real({ body: text })), false, `workbook message: ${text}`);
  }
  const pdf = msg({ id: "pdf", dateMs: T0 + min(2), attachmentNames: [`${NAME}.pdf`], body: "ไฟล์ที่ส่งไปก่อนหน้านี้ผิด ใช้ไฟล์นี้แทน (corrected version)" });
  assert.equal(isSupersededBy(pdf, real({ dateMs: T0 })), false, "a later PDF that says it replaces the file");
});

test("a message sent at or after the file is only ever a bare rendition", () => {
  const pdf = (over: Partial<TriageMessage> = {}) => msg({ id: "pdf", dateMs: T0 + min(1), attachmentNames: [`${NAME}.pdf`], body: "", ...over });
  const file = real({ dateMs: T0 });
  assert.equal(isSupersededBy(pdf(), file), true);
  assert.equal(isSupersededBy(pdf({ dateMs: T0 }), file), true, "equal Date headers: a rendition is still fine…");
  assert.equal(isSupersededBy(link({ dateMs: T0 }), file), false, "…but a link with equal Date headers is treated as the later message, not the earlier");
  assert.equal(isSupersededBy(pdf({ body: "ส่งรายงานผลงานประจำเดือนฉบับสมบูรณ์พร้อมรายละเอียดเพิ่มเติมตามที่ได้ตกลงกันไว้ในที่ประชุม" }), file), false, "a message with text of its own is answered");
  assert.equal(isSupersededBy(pdf({ body: "ขอบคุณค่ะ" }), file), true, "a thank-you is not text of its own");
});

test("a message that offers anything besides the file is still answered", () => {
  // a second link that is not the file's
  assert.equal(isSupersededBy(link({ body: `${NAME} <https://docs.google.com/file/d/AbC123>\nและ https://drive.google.com/file/d/Other/view` }), real()), false);
  // a link that merely follows the name somewhere else in the text
  assert.equal(isSupersededBy(link({ body: `ส่ง ${NAME} แล้ว ส่วนไฟล์ใหม่ดูที่ <https://docs.google.com/file/d/Other>` }), real()), false);
  // a URL on any other host (a tenant SharePoint, www.dropbox, a shortener) is some other file
  for (const url of ["https://contoso.sharepoint.com/:x:/g/abc", "https://www.dropbox.com/s/abc", "https://we.tl/t-abc", "https://bit.ly/abc"]) {
    assert.equal(isSupersededBy(link({ body: `${NAME} <https://docs.google.com/file/d/AbC123> และอีกไฟล์ ${url}` }), real()), false, url);
  }
  // a foreign attachment that is not a copy of the file
  assert.equal(isSupersededBy(link({ attachmentNames: ["ใบลา.pdf"] }), real()), false);
  // a later bare PDF export is fine, a later message that also links is not
  const pdf = msg({ id: "pdf", dateMs: T0 + min(3), attachmentNames: [`${NAME}.pdf`], body: "" });
  assert.equal(isSupersededBy(pdf, real({ dateMs: T0 })), true);
  assert.equal(isSupersededBy({ ...pdf, body: `${NAME} <https://docs.google.com/x>` }, real({ dateMs: T0 })), false);
});

test("a link stating a different month than the real file is a second submission", () => {
  const sub = "P4P สิงหาคม 2569";
  const name = "P4P_Somchai_Nattaya.xlsx";                      // a name that itself says no month
  const l = (text: string) => link({ subject: sub, body: `${text} ${name} <https://docs.google.com/x>` });
  const sep = real({ subject: sub, body: "ส่ง P4P เดือน ส.ค. 2569", attachmentNames: [name], xlsxNames: [name] });
  assert.equal(isSupersededBy(l("ส่ง P4P เดือน ก.ย. 2569"), sep), false);
  assert.equal(isSupersededBy(l("ส่ง P4P เดือน ส.ค. 2569"), sep), true, "same month agrees");
  assert.equal(isSupersededBy(l("ส่ง P4P เดือน ส.ค. 2568"), sep), false, "same month, different year");
  assert.equal(isSupersededBy(l(""), sep), true, "stating no month in the body is not a conflict (the subject says it)");
  // the month by any reading, not only the strict one
  for (const body of ["เดือน 9", "09/2569", "Sept", "เดือนที่ ๙", "ก.ย", "กย68"]) assert.equal(isSupersededBy(l(body), sep), false, body);
});

test("a subject that states no month proves nothing about which month the file is", () => {
  // identical subjects, but neither says anything about the period: a link for September's file with the
  // same name as August's attachment must still be answered
  const l = link({ subject: "ส่งงาน P4P", body: `${NAME} <https://docs.google.com/x>` });
  const r = real({ subject: "ส่งงาน P4P", body: "เดือนสิงหาคม 2569" });
  assert.equal(isSupersededBy(l, r), false);
});

test("correction wording hidden by a doubled sara-e or a zero-width mark is still wording", () => {
  const pdf = (body: string) => msg({ id: "pdf", dateMs: T0 + min(2), attachmentNames: [`${NAME}.xlsx.pdf`], body });
  assert.equal(isSupersededBy(pdf("แก้ไขแล้วครับ"), real({ dateMs: T0 })), false);
  for (const body of ["เเก้ไขแล้วครับ", "แ\u200Bก้ไขแล้วครับ", "corre\u200Bcted"]) assert.equal(isSupersededBy(pdf(body), real({ dateMs: T0 })), false, body);
});

test("messageRanToCompletion: every workbook clean, every reply sent", () => {
  const ok = { outcome: true };
  assert.equal(messageRanToCompletion({ processedAny: true, answered: true, workbooks: [ok, ok] }), true);
  assert.equal(messageRanToCompletion({ processedAny: true, answered: true, workbooks: [ok, { outcome: "rejected" }] }), false, "one workbook rejected");
  assert.equal(messageRanToCompletion({ processedAny: true, answered: true, workbooks: [ok, { outcome: "threw" }] }), false, "one workbook threw");
  assert.equal(messageRanToCompletion({ processedAny: true, answered: false, workbooks: [ok] }), false, "a reply owed to the sender was not sent");
  assert.equal(messageRanToCompletion({ processedAny: false, answered: true, workbooks: [] }), false, "nothing processed");
});

test("month-like letters inside a share URL are not read as a stated period", () => {
  assert.equal(
    isSupersededBy(link({ body: `${NAME} <https://docs.google.com/file/d/Sep-Aug-Dec-1IIZb>` }), real()),
    true,
  );
});

test("a held alert is dropped only for a peer that ran to completion", () => {
  assert.equal(shouldSendHeldAlert(true), false);
  assert.equal(shouldSendHeldAlert(false), true, "peer rejected / replied with an error");
  assert.equal(shouldSendHeldAlert(undefined), true, "peer never processed (threw, or not in this run)");
});

test("withRetry: stops at the first success, reports failures, gives up after the last attempt", async () => {
  let calls = 0;
  const failures: number[] = [];
  assert.equal(await withRetry(async () => { calls++; if (calls < 2) throw new Error("x"); }, 2, 0, (n) => failures.push(n)), true);
  assert.deepEqual([calls, failures], [2, [1]]);
  calls = 0; failures.length = 0;
  assert.equal(await withRetry(async () => { calls++; throw new Error("x"); }, 2, 0, (n) => failures.push(n)), false);
  assert.deepEqual([calls, failures], [2, [1, 2]]);
});

test("settleHeldAlerts: drop for a completed peer, resend otherwise, mark what was handled", async () => {
  type H = { id: string; peerId: string };
  const held: H[] = [{ id: "a", peerId: "ok" }, { id: "b", peerId: "rejected" }, { id: "c", peerId: "never-seen" }, { id: "d", peerId: "ok" }];
  const completed = new Map([["ok", true], ["rejected", false]]);
  const resent: string[] = [], marked: string[] = [], log: string[] = [], reported: string[] = [];
  await settleHeldAlerts(held, completed, {
    resend: async (h) => { resent.push(h.id); return true; },
    mark: async (h) => { marked.push(h.id); return true; },
    log: (l) => log.push(l),
    report: async (l) => { reported.push(l); },
  });
  assert.deepEqual(resent, ["b", "c"], "only the alerts whose peer did not run to completion");
  assert.deepEqual(marked, ["a", "b", "c", "d"], "every handled message is marked, exactly once");
  assert.deepEqual(reported, []);

  // an alert that could not be delivered (returned false, or threw) leaves its message unmarked for the next run
  for (const failing of [async () => false, async () => { throw new Error("boom"); }]) {
    const marked2: string[] = [];
    await settleHeldAlerts(held, completed, { resend: failing, mark: async (h) => { marked2.push(h.id); return true; }, log: () => {} });
    assert.deepEqual(marked2, ["a", "d"], "only the dropped alerts (peer completed) are marked");
  }

  // a mark that fails is reported to the admin
  const reports: string[] = [];
  await settleHeldAlerts(held.slice(0, 1), completed, { resend: async () => true, mark: async () => false, log: () => {}, report: async (l) => { reports.push(l); } });
  assert.equal(reports.length, 1);
});
