import { test } from "node:test";
import assert   from "node:assert/strict";
import { statedPeriod } from "../claude-analyst.js";

// statedPeriod is what an emailed submission is ROUTED on and rejected
// against, so these cases are mostly about what it must NOT claim to know.

test("subject outranks body, body outranks filename", () => {
  assert.deepEqual(
    statedPeriod("P4P_2569_01.xlsx", "ส่งงาน ก.ค. 2569", "ผลงาน มิ.ย. 2569"),
    { month: 7, beYear: 2569 },
  );
  assert.deepEqual(
    statedPeriod("P4P_2569_01.xlsx", "", "ผลงานเดือน มิ.ย. 2569"),
    { month: 6, beYear: 2569 },
  );
  assert.deepEqual(
    statedPeriod("P4P_กค_2569.xlsx", "ส่งไฟล์ครับ", ""),
    { month: 7, beYear: 2569 },
  );
});

test("a body that merely says 'รวมคะแนน' does not state January", () => {
  // "รวมคะแนน" contains "มค". Reading it as January here would reject a
  // correct July file, so the strict cell-text matcher is used instead of
  // resolveBeMonth's plain substring search.
  assert.deepEqual(
    statedPeriod("P4P.xlsx", "ส่ง P4P ครับ", "รวมคะแนน 850 คะแนน"),
    { month: null, beYear: null },
  );
  assert.equal(statedPeriod("P4P.xlsx", "", "แต้มคะแนนเดือนนี้ 850").month, null);
});

test("a stray two-digit number is not a year", () => {
  // resolveBeYear's tier 3 would read "85" as 2585 and collide with
  // everything; only 4-digit years are firm enough to reject on.
  assert.deepEqual(
    statedPeriod("P4P_2569.xlsx", "ส่งคะแนน 85 แต้ม", ""),
    { month: null, beYear: 2569 },
  );
  assert.equal(statedPeriod("P4P.xlsx", "ส่งคะแนน 85 แต้ม", "").beYear, null);
});

test("a CE year is converted, and a month with no year stays year-less", () => {
  assert.deepEqual(statedPeriod("", "P4P July 2026", ""), { month: 7, beYear: 2569 });
  assert.deepEqual(statedPeriod("", "ส่ง ก.ค. ครับ", ""), { month: 7, beYear: null });
});

test("an email that states nothing states nothing", () => {
  assert.deepEqual(statedPeriod("P4P.xlsx", "ส่งไฟล์ครับ", ""), { month: null, beYear: null });
  assert.deepEqual(statedPeriod("", "", ""), { month: null, beYear: null });
});
