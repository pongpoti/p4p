import { test } from "node:test";
import assert   from "node:assert/strict";
import { periodsInText, statedPeriods, resolveBeMonth } from "../claude-analyst.js";

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

test("a month abbreviation embedded in a person's name is not a stated month", () => {
  // "ณัฐกันย์" (a real given name) contains "กันย" — the abbreviation for
  // กันยายน (September) — as a plain substring, with no space around it.
  // Reading that as a stated September turned a real, unambiguous August
  // submission into an "ambiguous_period" rejection.
  assert.deepEqual(periodsInText("p4p ณัฐกันย์ ลิมปวิทยากุล ส.ค. 69"), [
    { month: 8, beYear: null },
  ]);
  assert.deepEqual(
    statedPeriods("ณัฐกันย์ ลิมปวิทยากุล p4p 69 (1).xlsx", "p4p ณัฐกันย์ ลิมปวิทยากุล ส.ค. 69", ""),
    { periods: [{ month: 8, beYear: null }], source: "email" },
  );
  // Same collision, different reader: the upload path's month cross-check
  // (index.js) reads the filename alone through resolveBeMonth, and this
  // exact filename would otherwise read as September and reject a correct
  // August upload as a month_mismatch.
  assert.equal(resolveBeMonth("ณัฐกันย์ ลิมปวิทยากุล p4p 69 (1).xlsx", "", ""), null);
});

test("a month glued straight onto a name, with no space anywhere, still resolves when a bare two-digit year follows it", () => {
  // Real subjects from a recurring sender: the month abbreviation butts
  // straight against his name with no separator, and the mail body is
  // empty — so this was the ONLY source that could name a period, and it
  // was rejected as "no_period" despite stating one plainly.
  assert.deepEqual(periodsInText("p4pพ.ประพันธ์สค69"), [{ month: 8, beYear: null }]);
  assert.deepEqual(periodsInText("p4pพใประพันธ์กค69"), [{ month: 7, beYear: null }]);
  assert.deepEqual(
    statedPeriods("P4P พ ประพันธ์.xlsx", "p4pพ.ประพันธ์สค69", ""),
    { periods: [{ month: 8, beYear: null }], source: "email" },
  );

  // The name-collision guard this exception sits beside must still hold:
  // "กันย" glued inside "ณัฐกันย์" has no digits after it, so it must not
  // start resolving to September just because SOME glued token now can.
  assert.deepEqual(periodsInText("ณัฐกันย์ลิมปวิทยากุล"), []);
});

test("the เดือน<month> compound (no space) still resolves, despite the boundary check above", () => {
  // The fix for the name collision above must not re-break this: "เดือน"
  // ("month") directly against a month name, with no space, is how subjects
  // and filenames actually write it — e.g. "P4P ศุภศรัณย์ เดือนมกราคม 2569.xlsx".
  assert.deepEqual(periodsInText("P4P ศุภศรัณย์ เดือนมกราคม 2569.xlsx"), [
    { month: 1, beYear: 2569 },
  ]);
  assert.equal(resolveBeMonth("P4P ศุภศรัณย์ เดือนมกราคม 2569.xlsx", "", ""), 1);
});
