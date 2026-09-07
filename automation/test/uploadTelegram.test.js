/**
 * The admin's Telegram message, on both paths.
 *
 * The email path's layout is load-bearing in a way tests usually aren't: the
 * admin has been reading the same shape for months and scans it, not reads
 * it. It now leads with a Source line — matching the upload path's own first
 * line — so the two are told apart by the same field instead of by the
 * absence of one (design §7.6).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatResultMessage, formatErrorMessage } from "../telegram.js";

const RESULT = {
  name: "สมชาย ใจดี",
  matchedName: "สมชาย ใจดี",
  similarity: 0.87,
  date: "2569_06",
  score: "1842.50",
  saved: true,
};

test("the email path's success message names its source", () => {
  assert.equal(
    formatResultMessage(RESULT, "P4P_มิย69.xlsx"),
    [
      "📋 P4P Workload Report",
      "",
      "📥 Source   : Email",
      "👤 Name     : สมชาย ใจดี",
      "🔗 Matched  : สมชาย ใจดี (87% match)",
      "📅 Date     : 2569_06",
      "🏅 Score    : 1842.50",
      "💾 ✅ Score saved to DB",
      "",
      "📎 File: P4P_มิย69.xlsx",
    ].join("\n")
  );
});

test("the email path's error message names its source", () => {
  assert.equal(
    formatErrorMessage("Workbook parse failed: boom", "P4P_มิย69.xlsx"),
    [
      "❌ P4P Processing Error",
      "",
      "📥 Source: Email",
      "📎 File  : P4P_มิย69.xlsx",
      "💬 Error : Workbook parse failed: boom",
    ].join("\n")
  );
});

test("an explicit null upload context is still the email layout", () => {
  // drain-uploads passes a context; index.js passes `uploadCtx`, which is
  // null on the email path. Both call sites go through the same parameter.
  assert.equal(
    formatResultMessage(RESULT, "f.xlsx", null),
    formatResultMessage(RESULT, "f.xlsx")
  );
});

const UPLOAD = {
  source: "LINE upload",
  accountName: "สมชาย ใจดี",
  email: "somchai@example.com",
  monthKey: "2569_06",
  rosterMatch: "exact",
};

test("the upload path answers the question the admin actually has", () => {
  // Not "did the fuzzy match pick the right person?" — identity came from a
  // verified session — but "did the file agree with what they claimed?".
  const msg = formatResultMessage(RESULT, "P4P_มิย69.xlsx", UPLOAD);
  assert.match(msg, /📥 Source {3}: LINE upload/);
  assert.match(msg, /👤 Account {2}: สมชาย ใจดี <somchai@example\.com>/);
  assert.match(msg, /🔗 Roster {3}: สมชาย ใจดี \(exact\)/);
  assert.match(msg, /📅 Month {4}: 2569_06 \(เลือกเอง\)/);
  assert.match(msg, /🏅 Score {4}: 1842\.50/);
  assert.equal(/👤 Name/.test(msg), false, "the email path's Name/Matched pair is replaced, not kept");
});

test("a deferred row reports the fuzzy match it fell back to", () => {
  const msg = formatResultMessage(RESULT, "f.xlsx", { ...UPLOAD, rosterMatch: "fuzzy 87%" });
  assert.match(msg, /🔗 Roster {3}: สมชาย ใจดี \(fuzzy 87%\)/);
});

test("a name in the file that isn't the account's is flagged, not hidden", () => {
  // Informational only: a physician can legitimately submit a workbook whose
  // header carries a colleague's name if they copied a template, and the
  // score still goes to the authenticated account.
  const msg = formatResultMessage(RESULT, "f.xlsx", { ...UPLOAD, nameInFile: "สมหญิง ใจดี" });
  assert.match(msg, /⚠️ Name in file : สมหญิง ใจดี \(≠ account\)/);
});

test("a month the file disagrees with is flagged with both months named", () => {
  const msg = formatErrorMessage("ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06", "f.xlsx", {
    ...UPLOAD,
    errorType: "month_mismatch",
    monthInFile: "2569_05",
    attempt: 1,
  });
  assert.match(msg, /❌ P4P Upload Error/);
  assert.match(msg, /🚫 Type {3}: month_mismatch/);
  assert.match(msg, /⚠️ Month in file: 2569_05 \(≠ 2569_06 selected\)/);
});

test("the attempt counter says whether this will come back", () => {
  const midway = formatErrorMessage("boom", "f.xlsx", { ...UPLOAD, errorType: "other", attempt: 1 });
  assert.match(midway, /🔁 Attempt: 1\/3$/m);
  assert.equal(/ยุติการลองใหม่/.test(midway), false);

  const final = formatErrorMessage("boom", "f.xlsx", { ...UPLOAD, errorType: "other", attempt: 3 });
  assert.match(final, /🔁 Attempt: 3\/3 — ยุติการลองใหม่/);
});

test("no attempt counter on the email path, which does not retry", () => {
  assert.equal(/🔁/.test(formatErrorMessage("boom", "f.xlsx")), false);
});
