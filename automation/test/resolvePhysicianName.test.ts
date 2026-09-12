import { test } from "node:test";
import assert   from "node:assert/strict";
import {
  resolvePhysicianName,
  resolvePhysicianNameCandidates,
  resolvePhysicianNameFromSheet,
} from "../claude-analyst.js";

// ── Compound เดือน<month> should not be treated as a lastname ────────────────

test("เดือนมกราคม compound is not extracted as lastname", () => {
  // Filename: "P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx"
  // "เดือนมกราคม" = "month January" — not a lastname.
  // Expected: firstname-only "ศุภศรัณย์" (single-token for Supabase lookup)
  assert.equal(
    resolvePhysicianName("P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

test("each Thai month compound returns firstname only", () => {
  const months = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
  ];
  for (const month of months) {
    const result = resolvePhysicianName(`P4P พ ศุภศรัณย์ เดือน${month} 2569.xlsx`, "", "");
    assert.equal(result, "ศุภศรัณย์", `failed for เดือน${month}`);
  }
});

// ── Bare month name (no เดือน prefix) still rejected as lastname ─────────────

test("bare month name after firstname returns firstname only", () => {
  // "ศุภศรัณย์ มกราคม" — month is a separate token, not a lastname
  assert.equal(
    resolvePhysicianName("P4P ศุภศรัณย์ มกราคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

// ── Normal two-word names still work ─────────────────────────────────────────

test("normal firstname lastname still extracted", () => {
  assert.equal(
    resolvePhysicianName("P4P นพ.สมชาย ใจดี มกราคม 2569.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

test("two-word name without title still extracted", () => {
  assert.equal(
    resolvePhysicianName("P4P_สมชาย_ใจดี_2569.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

// ── Firstname-only with title (Pattern 1 single-token) ───────────────────────

test("title prefix with firstname only and month discards month", () => {
  assert.equal(
    resolvePhysicianName("P4P นพ.ศุภศรัณย์ มีนาคม 2569.xlsx", "", ""),
    "ศุภศรัณย์"
  );
});

// ── Department name in filename is not treated as a lastname ──────────────────
// Real case: sender named the file "P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx",
// putting the department ("อายุรกรรม") where the surname should go.

test("department word after firstname returns firstname only", () => {
  assert.equal(
    resolvePhysicianName("P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx", "", ""),
    "วราวุธ"
  );
});

// ── Title prefixes typed with a comma instead of a dot ───────────────────────
// Real case (run #389): the attachment was named "พ,แพร จันทรรังสรรค์ กค.69.xlsx"
// and the subject read "พ.แพร จันทรรังสรรค์ p4p กค. 69".  "," and "." are
// adjacent keys, so this slip is common.

test("one-letter prefix with a comma is stripped from the filename", () => {
  assert.equal(
    resolvePhysicianName("พ,แพร จันทรรังสรรค์ กค.69.xlsx", "", ""),
    "แพร จันทรรังสรรค์"
  );
});

test("one-letter prefix with a dot is not welded onto the firstname", () => {
  // Regression: the Pattern-2 dot-collapse used to turn "พ.แพร" into "พแพร",
  // which matched no physician in the database.
  assert.equal(
    resolvePhysicianName("", "พ.แพร จันทรรังสรรค์ p4p กค. 69", ""),
    "แพร จันทรรังสรรค์"
  );
});

test("multi-char title with a comma still resolves", () => {
  assert.equal(
    resolvePhysicianName("P4P นพ,สมชาย ใจดี มกราคม 2569.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

test("comma between firstname and lastname is a separator", () => {
  assert.equal(
    resolvePhysicianName("P4P แพร,จันทรรังสรรค์ กค.69.xlsx", "", ""),
    "แพร จันทรรังสรรค์"
  );
});

test("พ.ค. month abbreviation is not mistaken for a one-letter prefix", () => {
  assert.equal(
    resolvePhysicianName("P4P สมชาย ใจดี พ.ค. 69.xlsx", "", ""),
    "สมชาย ใจดี"
  );
});

// ── "ณ"-compound surnames ─────────────────────────────────────────────────────
// Real case (run on 2026-08-18): "P4P-Intern อภิษฎา ณ  สงขลา _ กรกฎาคม.xlsx"
// resolved to just "สงขลา" — the single-character "ณ" was invisible to the
// {2,}-char word matchers, so "สงขลา" paired with the trailing month instead
// of joining "อภิษฎา ณ" as the surname. That truncated name then failed to
// fuzzy-match the roster and triggered a false "physician not found" alert.

test("ณ-compound surname is extracted whole from a filename", () => {
  assert.equal(
    resolvePhysicianName("P4P-Intern อภิษฎา ณ  สงขลา _ กรกฎาคม.xlsx", "", ""),
    "อภิษฎา ณ สงขลา"
  );
});

test("ณ-compound surname is extracted whole from a subject line", () => {
  assert.equal(
    resolvePhysicianName("", "P4P Int อภิษฎา ณ สงขลา July", ""),
    "อภิษฎา ณ สงขลา"
  );
});

test("ณ-compound surname with a non-name firstname is rejected", () => {
  // "ผลงาน" (a NON_NAME_THAI word) must not be accepted as a firstname just
  // because "ณ" follows it, e.g. "ส่งผลงาน ณ วันที่ 15" style phrasing.
  assert.equal(resolvePhysicianName("", "", "ส่งผลงาน ณ วันที่ 15 กค"), null);
});

// ── Multi-source candidates ──────────────────────────────────────────────────

test("subject name is kept as a candidate when the filename differs", () => {
  // The filename yields only a firstname (department where the surname belongs);
  // the subject spells the full name out.  Both must survive so the caller can
  // retry the second one when the first misses in the database.
  const got = resolvePhysicianNameCandidates(
    "P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx",
    "P4P นพ.วราวุธ เมธีศิริวัฒน์ เมษายน 2569",
    ""
  );
  assert.deepEqual(got, ["วราวุธ", "วราวุธ เมธีศิริวัฒน์"]);
});

test("candidates are de-duplicated and filename stays first", () => {
  const got = resolvePhysicianNameCandidates(
    "P4P สมชาย ใจดี 2569.xlsx",
    "P4P สมชาย ใจดี มกราคม 2569",
    ""
  );
  assert.deepEqual(got, ["สมชาย ใจดี"]);
});

test("resolvePhysicianName returns the first candidate", () => {
  const filename = "P4P วราวุธ อายุรกรรม เม.ย. 69.xlsx";
  const subject  = "P4P นพ.วราวุธ เมธีศิริวัฒน์ เมษายน 2569";
  assert.equal(
    resolvePhysicianName(filename, subject, ""),
    resolvePhysicianNameCandidates(filename, subject, "")[0]
  );
});

test("no name anywhere yields an empty candidate list", () => {
  assert.deepEqual(resolvePhysicianNameCandidates("report.xlsx", "", ""), []);
});

// ── Sheet-based fallback resolver ────────────────────────────────────────────

test("recovers titled name from a ชื่อแพทย์ header cell", () => {
  // Real case: filename mis-named, but the cell holds the correct name.
  const rows = [{ col_1: "ชื่อแพทย์ นพ. วราวุธ เมธีศิริวัฒน์" }];
  const got = resolvePhysicianNameFromSheet(rows, "รายงานP4Pสำหรับแพทย์");
  assert.ok(got.includes("วราวุธ เมธีศิริวัฒน์"), `got ${JSON.stringify(got)}`);
});

test("recovers name from the worksheet tab name", () => {
  // Real case: cell label is just dotted placeholder; name is the sheet tab.
  const rows = [{ col_1: "ชื่อแพทย์........................." }];
  const got = resolvePhysicianNameFromSheet(rows, "ปัทมิกา เจียรวุฒิสาร เมย.69");
  assert.ok(got.includes("ปัทมิกา เจียรวุฒิสาร"), `got ${JSON.stringify(got)}`);
});

test("dotted ชื่อแพทย์ placeholder yields no junk candidate", () => {
  // The label word itself must never become a candidate name.
  const rows = [{ col_1: "ชื่อแพทย์........................." }];
  const got = resolvePhysicianNameFromSheet(rows, "Sheet1");
  assert.ok(!got.includes("ชื่อแพทย์"), `got ${JSON.stringify(got)}`);
});
