import { test } from "node:test";
import assert   from "node:assert/strict";
import { periodsInText, statedPeriods } from "../claude-analyst.js";

// What a submission SAYS it is for. The email path refuses to route on
// anything else, so these cases are mostly about what must NOT be claimed.

test("every period in a line is found, each with the year written beside it", () => {
  assert.deepEqual(periodsInText("ส่ง ก.ค. 2569"), [{ month: 7, beYear: 2569 }]);
  assert.deepEqual(periodsInText("ส่งงานเดือน มิ.ย. และ ก.ค. 2569"), [
    { month: 6, beYear: 2569 },
    { month: 7, beYear: 2569 },
  ]);
});

test("a month and a year are never spliced out of two different dates", () => {
  // Read flatly this is "first month, first year" = January 2568, a period
  // the sender never wrote. Each month must keep its own year.
  assert.deepEqual(periodsInText("แนบไฟล์ ธ.ค. 2568 และ ม.ค. 2569"), [
    { month: 12, beYear: 2568 },
    { month: 1, beYear: 2569 },
  ]);
});

test("the same period written twice counts once", () => {
  assert.deepEqual(periodsInText("ก.ค. 2569 (กรกฎาคม 2569)"), [{ month: 7, beYear: 2569 }]);
});

test("text that names no month states no period", () => {
  assert.deepEqual(periodsInText("ส่งไฟล์ครับ"), []);
  assert.deepEqual(periodsInText("รวมคะแนน 850 คะแนน"), [], "'มค' inside 'รวมคะแนน' is not January");
  assert.deepEqual(periodsInText("ส่งคะแนน 85 แต้ม"), [], "a stray 85 is a score, not a year");
  assert.deepEqual(periodsInText(""), []);
});

test("the mail decides; the filename is consulted only when the mail is silent", () => {
  assert.deepEqual(
    statedPeriods("P4P_ม.ค._2569.xlsx", "ส่ง P4P ก.ค. 2569", ""),
    { periods: [{ month: 7, beYear: 2569 }], source: "email" },
  );
  assert.deepEqual(
    statedPeriods("P4P ก.ค. 2569.xlsx", "ส่งไฟล์ครับ", ""),
    { periods: [{ month: 7, beYear: 2569 }], source: "filename" },
  );
});

test("subject and body are pooled, so a mail naming two months shows both", () => {
  const { periods, source } = statedPeriods("P4P.xlsx", "ส่ง P4P ก.ค. 2569", "แนบ มิ.ย. 2569 มาด้วยครับ");
  assert.equal(source, "email");
  assert.deepEqual(periods, [{ month: 7, beYear: 2569 }, { month: 6, beYear: 2569 }]);
});

test("a submission that states nothing anywhere is reported as such", () => {
  assert.deepEqual(
    statedPeriods("P4P.xlsx", "ส่งไฟล์ครับ", ""),
    { periods: [], source: "none" },
  );
});
