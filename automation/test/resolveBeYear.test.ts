import { test } from "node:test";
import assert   from "node:assert/strict";
import { resolveBeYear, resolveBeYearByPriority } from "../claude-analyst.js";

test("full BE year in filename", () => {
  assert.equal(resolveBeYear("P4P_2569_02.xlsx", "", ""), 2569);
});

test("full CE year converted to BE", () => {
  assert.equal(resolveBeYear("report_2026.xlsx", "", ""), 2569);
});

test("short BE year (69 → 2569)", () => {
  assert.equal(resolveBeYear("P4P 69.xlsx", "", ""), 2569);
});

test("short CE year in subject (26 → 2026 → 2569)", () => {
  assert.equal(resolveBeYear("report.xlsx", "ส่ง P4P เดือน 26", ""), 2569);
});

test("body day number does not pollute result", () => {
  // Body has day number 28 — should not be read as short CE year
  // Filename has no year, subject has no year — resolves null
  assert.equal(resolveBeYear("report.xlsx", "", "วันที่ 28 มีนาคม"), null);
});

test("unambiguous full-BE match still outranks a lower-confidence CE match", () => {
  // Filename: BE 2568 (Tier 1, unambiguous). Subject: CE 2026 → BE 2569 (Tier 2).
  // Tier 1 always wins over Tier 2 regardless of value — only within the
  // same tier does "newest wins" apply (see next test).
  assert.equal(resolveBeYear("P4P_2568.xlsx", "2026", ""), 2568);
});

test("within the same tier, newest year across sources wins, not first source", () => {
  // Both filename (2568) and subject (2569) are Tier-1 full-BE matches —
  // the newer one must win, not whichever source is scanned first.
  assert.equal(resolveBeYear("P4P_2568.xlsx", "2569", ""), 2569);
});

test("stale year in subject does not shadow newer year in filename (ธงชัย case)", () => {
  // Reproduces the real bug: subject carries a stale "2566" (copy-pasted
  // from a previous email) while the filename has the correct "2569".
  // Both are Tier-1 full-BE matches — the newer one must win.
  assert.equal(
    resolveBeYear(
      "ธงชัย สวัสดิ์มงคลกุล  กรกฏาคม 2569.xlsx",
      "P4P กรกฏาคม 2566",
      "ขอบคุณ\n\n นพ.ธงชัย สวัสดิ์มงคลกุล"
    ),
    2569
  );
});

test("returns null when no year found", () => {
  assert.equal(resolveBeYear("", "", ""), null);
});

test("falls back to email received date when no year found anywhere", () => {
  // Reproduces a real reported case: name/month present in the body but no
  // year in subject, body, filename, or sheet. (The submitter's address used
  // to be named here; removed — this repository is public.)
  assert.equal(
    resolveBeYear("P4P-Intern.xlsx", "P4P Int", "เดือน มิถุนายน", "2026-07-01T17:08:15+07:00"),
    2569
  );
});

test("email date fallback is not used when a text year is present", () => {
  // Filename has an explicit year — must win over the email date fallback.
  assert.equal(
    resolveBeYear("P4P_2568.xlsx", "", "", "2026-07-01T17:08:15+07:00"),
    2568
  );
});

test("email date fallback ignored when unparseable", () => {
  assert.equal(resolveBeYear("", "", "", "not-a-date"), null);
});

// ── Tier 3/4 boundary (bug: regexes didn't match their own doc comments —
// tier 3 said "43–99" but matched 40–99, tier 4 said "00–42" but matched
// 00–39, so a bare 40/41/42 resolved via the wrong tier) ────────────────────
test("boundary: 43 resolves as short BE (tier 3), not short CE", () => {
  assert.equal(resolveBeYear("report.xlsx", "43", ""), 2543);
});

test("boundary: 42 resolves as short CE (tier 4), not short BE", () => {
  assert.equal(resolveBeYear("report.xlsx", "42", ""), 2585);
});

test("boundary: 40 resolves as short CE (tier 4)", () => {
  assert.equal(resolveBeYear("report.xlsx", "40", ""), 2583);
});

// ── Source priority ───────────────────────────────────────────────────────
// What the sender wrote outranks the filename. resolveBeYear alone cannot
// express this: it tiers by year FORMAT and takes the best match across all
// three sources at once, so the filename's 2569 beats the subject's 2568.

test("resolveBeYear alone takes the max across sources, not the first source", () => {
  assert.equal(resolveBeYear("P4P_2569.xlsx", "ส่งงานเดือน ก.ค. 2568", ""), 2569);
});

test("by priority, the subject wins over the filename", () => {
  assert.equal(resolveBeYearByPriority("P4P_2569.xlsx", "ส่งงานเดือน ก.ค. 2568", ""), 2568);
});

test("by priority, the body wins over the filename", () => {
  assert.equal(resolveBeYearByPriority("P4P_2569.xlsx", "", "ผลงานประจำเดือน ก.ค. 2568"), 2568);
});

test("by priority, the filename is used when the mail says nothing", () => {
  assert.equal(resolveBeYearByPriority("P4P_2569.xlsx", "ส่งไฟล์ครับ", ""), 2569);
});

test("by priority, a two-digit year in the subject still outranks the filename", () => {
  assert.equal(resolveBeYearByPriority("P4P_2568.xlsx", "P4P ก.ค. 69", ""), 2569);
});

test("by priority, nothing anywhere is null — never the email's own send date", () => {
  assert.equal(resolveBeYearByPriority("report.xlsx", "ส่งไฟล์ครับ", ""), null);
});
