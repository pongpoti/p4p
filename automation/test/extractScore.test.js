import { test } from "node:test";
import assert   from "node:assert/strict";
import { extractScoreFromRows, resolveScore } from "../claude-analyst.js";

test("returns null for empty rows", () => {
  const { score } = extractScoreFromRows([]);
  assert.equal(score, null);
});

test("finds score from grand-total label row", () => {
  const rows = [
    { col_1: "ชื่อแพทย์", col_2: "กิจกรรม", col_5: "รวมแต้ม" },
    { col_1: null, col_2: "ตรวจผู้ป่วย", col_5: 100 },
    { col_1: "รวมแต้มทั้งหมด", col_5: 11011.5 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("finds score from sub-total label in first 3 cols", () => {
  const rows = [
    { col_1: "รวมแต้ม", col_4: 500 },
    { col_1: "รวมแต้ม", col_4: 800 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 800);
});

test("falls back to largest number when no label", () => {
  const rows = [
    { col_1: 10, col_2: 20 },
    { col_1: 5,  col_2: 999 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 999);
  assert.match(method, /largest/);
});

test("ignores year-like numbers", () => {
  const rows = [
    { col_1: 2569, col_2: 150 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 150);
});

test("grand-total label beats sub-total", () => {
  const rows = [
    { col_1: "รวมแต้ม", col_4: 500 },
    { col_1: "รวมแต้มทั้งหมด", col_4: 11011.5 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("extracts score when label and number share one cell", () => {
  // Real-world case: cell V75 = "รวมทั้งหมด  = 11011.5"
  // Other row data includes unrelated numbers (2200 threshold, day numbers)
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น 2200 คะแนน" },
    { col_22: "รวมทั้งหมด  = 11011.5", col_3: "รับรองว่าผลถูกต้อง" },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 11011.5);
  assert.match(method, /grand-total/);
});

test("score in BE-year range (2400–2699) with decimals is not filtered as year-like", () => {
  // Bug: isYearLike(2408.56) was returning true because 2408 falls in the BE
  // range 2400–2699. But 2408.56 is a score (years are always integers).
  // The app was returning 2200 (threshold) instead of 2408.56.
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น", col_2: 2200, col_3: "คะแนน" },
    { col_1: "item A", col_5: 1200.5 },
    { col_1: "item B", col_5: 1208.06 },
    { col_1: "รวมทั้งหมด", col_5: 2408.56 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2408.56);
  assert.match(method, /grand-total/);
});

test("integer score in BE-year range on a grand-total label row is not filtered", () => {
  // Bug: 2607 is an integer in the BE range (2400–2699), so isYearLike(2607)
  // returned true and the grand-total row was ignored. The app fell back to 2200.
  // Fix: year filter is skipped when the row is a confirmed grand-total label row.
  const rows = [
    { col_1: "เกณฑ์ขั้นต้น", col_2: 2200, col_3: "คะแนน" },
    { col_1: "item A", col_5: 800 },
    { col_1: "item B", col_5: 1807 },
    { col_1: "รวมแต้มทั้งหมด", col_5: 2607 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2607);
  assert.match(method, /grand-total/);
});

test("a coincidental year value elsewhere in the grand-total row does not outrank the real (smaller) score", () => {
  // Bug: the grand-total row's year-filter used to be disabled for the WHOLE
  // row, not just the label cell. A stray "ปี 2568" note sharing the row with
  // the real (smaller) total let Math.max pick the year instead of the score.
  const rows = [
    { col_1: "item A", col_5: 400 },
    { col_1: "item B", col_5: 320 },
    { col_1: "รวมแต้มทั้งหมด", col_3: 2568, col_5: 720 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 720);
  assert.match(method, /grand-total/);
});

test("grand-total label with internal whitespace (merged cell) still matches", () => {
  // Bug: real-world file had the merged label cell "รวมคะแนน ทั้งหมด" (with a
  // space), which doesn't substring-match "รวมคะแนนทั้งหมด" in
  // GRAND_TOTAL_LABELS. The row fell through to the sub-total pass, where the
  // real total (2008) — landing in the 1900–2099 "year-like" range — was
  // discarded, leaving a smaller sub-total (1320) as the answer instead.
  const rows = [
    { col_1: "รวมคะแนน บริหาร", col_3: 1320 },
    { col_1: "รวมคะแนน หัตถการ", col_3: 505 },
    { col_1: "รวมคะแนน ทั้งหมด", col_2: "รวมคะแนน ทั้งหมด", col_3: 2008 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2008);
  assert.match(method, /grand-total/);
});

test("resolveScore doesn't mistake a year-like cached grand-total for an uncached formula", () => {
  // Bug: resolveScore's grandRowEmpty check excluded year-like numbers too,
  // so a real cached score of 2008 (in the 1900–2099 range) looked like an
  // empty/uncached =SUM() cell. That triggered the Tier 1/2 fallback, which
  // recomputed an unrelated (wrong) total from unrelated sub-total rows.
  const rows = [
    { col_1: "รวมคะแนน บริหาร", col_3: 1320 },
    { col_1: "รวมคะแนน หัตถการ", col_3: 505 },
    { col_1: "รวมคะแนน ทั้งหมด", col_2: "รวมคะแนน ทั้งหมด", col_3: 2008 },
  ];
  const { score, method } = resolveScore(rows);
  assert.equal(score, 2008);
  assert.match(method, /grand-total/);
});

test("whole-sheet fallback still finds a score when every number looks year-like", () => {
  // Bug: isYearLike unconditionally excludes 2400–2699, so a sheet with no
  // recognised label row and only year-range numbers had nothing left for
  // "largest in sheet" — it fell all the way to "no candidates found"
  // instead of recovering via the (score-preferring) year-like fallback.
  const rows = [
    { col_1: "item A", col_5: 2450 },
    { col_1: "item B", col_5: 2500 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2500);
  assert.match(method, /year-like fallback/);
});

test("total typed as a free-text summary line wins over line-item numbers", () => {
  // Real-world file (P4P มิย 69): the physician wrote the month's totals as
  // prose under the table instead of leaving them in numeric cells. Nothing
  // numeric held the real total, so "largest in sheet" returned 1320 — an
  // admin line-item weight — against a stated total of 3260. Note the service
  // subtotal (1940) is invisible to the numeric passes twice over: it shares
  // its row with a count (74), and 1940 is inside isYearLike's 1900–2099 range.
  const rows = [
    { col_2: "รวม ", col_4: 74, col_5: 1940 },
    { col_1: "งานบริหาร ", col_2: "หัวหน้ากลุ่มงาน", col_3: 1320 },
    { col_5: "สรุป  มิย 2569        งานบริการ = 1940" },
    { col_8: "        งานบริหาร =  1320" },
    { col_8: "         รวม =  3260" },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 3260);
  assert.match(method, /free-text summary/);
});

test("summary line with no separator (label + number only) is still read", () => {
  const rows = [
    { col_1: "item A", col_5: 40 },
    { col_1: "รวม  100" },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 100);
  assert.match(method, /free-text summary/);
});

test("a year sharing a summary cell is not read as the total", () => {
  // "สรุป" is not a total label, so the "= 1940" here must not match — and the
  // 2569 ahead of it must never become a candidate.
  const rows = [
    { col_5: "สรุป  มิย 2569        งานบริการ = 1940" },
    { col_1: "item A", col_5: 300 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 300);
});

test("a count that merely contains the word รวม is not read as a total", () => {
  // "จำนวนรวม 74" is a column count. The label does not start the cell, so the
  // no-separator tier must reject it.
  const rows = [
    { col_1: "จำนวนรวม 74" },
    { col_1: "item A", col_5: 300 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 300);
});

test("trailing text after the number blocks the no-separator tier", () => {
  const rows = [
    { col_1: "รวมแต้ม 30 วัน" },
    { col_1: "item A", col_5: 300 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 300);
});

test("bare year after a total label is rejected, but an explicit separator is honoured", () => {
  // "รวม 2569" is almost certainly a date stamp. With an "=" the same number is
  // a deliberate statement of the total, so it is accepted.
  const bare = extractScoreFromRows([
    { col_1: "รวม 2569" },
    { col_1: "item A", col_5: 300 },
  ]);
  assert.equal(bare.score, 300);

  const explicit = extractScoreFromRows([
    { col_1: "รวม = 2569" },
    { col_1: "item A", col_5: 300 },
  ]);
  assert.equal(explicit.score, 2569);
  assert.match(explicit.method, /free-text summary/);
});

test("year-like total in the sheet's declared score column is read, not discarded", () => {
  // Bug: isYearLike drops 1900–2099 wholesale, so a real total of 1940 sitting
  // in the "รวมแต้ม" column was thrown away — leaving the count in the same row
  // (74) as the only survivor. The header row declares which column holds the
  // points, so on a labelled total row that value needs no year guessing.
  const rows = [
    { col_1: "ประเภทงาน", col_2: "กิจกรรม", col_3: "แต้ม", col_4: "จำนวนรวม", col_5: "รวมแต้ม", col_6: "D1" },
    { col_2: "1. Plain film/ แผ่น", col_3: 2.5, col_4: 4, col_5: 10 },
    { col_2: "รวม ", col_4: 74, col_5: 1940 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 1940);
});

test("a data row is not mistaken for the header row when nominating the score column", () => {
  // Only an all-text row can be a header. Were the first row (label + number)
  // accepted, col_1 would be nominated as the score column, the total row's
  // col_1 would read as text, and the answer would fall back to 50.
  const rows = [
    { col_1: "รวมแต้ม", col_2: 999, col_3: "หมายเหตุ" },
    { col_1: "ประเภทงาน", col_2: "กิจกรรม", col_3: "รวมแต้ม" },
    { col_1: "รวม", col_2: 50, col_3: 1980 },
  ];
  const { score } = extractScoreFromRows(rows);
  assert.equal(score, 1980);
});

test("declared score column also settles the grand-total row", () => {
  const rows = [
    { col_1: "ประเภทงาน", col_2: "กิจกรรม", col_3: "แต้ม", col_4: "จำนวนรวม", col_5: "รวมแต้ม", col_6: "D1" },
    { col_2: "item A", col_3: 10, col_5: 400 },
    { col_1: "รวมแต้มทั้งหมด", col_3: 2568, col_5: 2050 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 2050);           // not 2568 (a year), not 400
  assert.match(method, /grand-total/);
});

test("reconstructs the total from daily cells when every formula in the sheet is uncached", () => {
  // Real-world case (พุฒิพงศ์ พร้อมคุณธรรม, มิ.ย./ก.ค. 2569): the workbook's
  // SUM formulas were uncached everywhere — not just the grand-total row
  // (Tier 1) or some sub-totals (Tier 2), but every line item's own
  // count/total cells too. Tiers 1/2 had nothing to sum, so resolveScore
  // fell back to extractScoreFromRows's "largest in sheet" — which returned
  // 1320, the flat per-position rate for an unfilled department-head role,
  // instead of the real total (8266 / 9279 in production). Only the daily
  // D1-D31 cells (typed by hand, never formulas) and the per-unit "แต้ม" rate
  // survive uncached — Tier 3 rebuilds each line's total from those.
  const rows = [
    { col_1: "ประเภทงาน", col_2: "กิจกรรม", col_3: "D1", col_4: "D2", col_5: "D3", col_6: "แต้ม", col_7: "จำนวนราย", col_8: "รวมแต้ม" },
    { col_2: "หัวหน้ากลุ่มงาน", col_6: 1320, col_7: 0, col_8: 0 },  // unfilled role — no days, must not count
    { col_2: "ตรวจผู้ป่วยนอก", col_3: 100, col_4: 100, col_5: 100, col_6: 5, col_7: null, col_8: null },
    { col_2: "รวม บริการ OPD", col_8: null },
    { col_2: "รวมแต้มทั้งหมด", col_8: null },
  ];
  const { score, method } = resolveScore(rows);
  assert.equal(score, 1500);   // 5 (แต้ม) × (100+100+100 days) — not the stray 1320 weight
  assert.match(method, /reconstructed from daily cells/);
});

test("sheets with no header row keep the previous behaviour", () => {
  // No row declares a score column, so nothing changes: the year filter still
  // governs, and the largest non-year number wins.
  const rows = [
    { col_1: "item A", col_5: 300 },
    { col_1: "item B", col_5: 450 },
  ];
  const { score, method } = extractScoreFromRows(rows);
  assert.equal(score, 450);
  assert.match(method, /largest in sheet/);
});
