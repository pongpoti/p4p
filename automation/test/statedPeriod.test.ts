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

test("a forwarded mail's own \"Date:\" line is not a stated period", () => {
  // Real forward from a recurring sender: she mailed herself from Yahoo,
  // then forwarded that mail from Gmail three minutes later. Gmail's own
  // "---------- Forwarded message ---------" block quotes the original
  // headers verbatim, including "Date: ส. 12 ก.ย. 2026 11:10" — the
  // timestamp of the quoted mail, not a second period — and reading it as
  // one turned an unambiguous July submission into an ambiguous_period
  // rejection.
  const body = [
    "---------- Forwarded message ---------",
    "จาก: Chatdao Sutjarit <sender@example.com>",
    "Date: ส. 12 ก.ย. 2026 11:10",
    "Subject: p4pฉัตรดาว ก.ค.69",
    "To: recipient@example.com <recipient@example.com>",
  ].join("\n");
  assert.deepEqual(periodsInText(body), [{ month: 7, beYear: null }]);
  assert.deepEqual(
    statedPeriods("ฉัตรดาว สุจริต ก.ค.69.xlsx", "Fwd: p4pฉัตรดาว ก.ค.69", body),
    { periods: [{ month: 7, beYear: null }], source: "email" },
  );

  // Outlook's own forward header uses "Sent:" instead of "Date:" for the
  // same field — same failure mode, same fix.
  assert.deepEqual(
    periodsInText("From: A\nSent: 12 กันยายน 2026\nSubject: p4p ก.ค. 69"),
    [{ month: 7, beYear: null }],
  );
});

test("a reply's \"On <date> … wrote:\" attribution line is not a stated period", () => {
  // Real reply from a recurring sender (2026-10-06): his Aug+Sep send of
  // 1 Oct got an auto-reply, and he answered the same thread with a July
  // correction — "แก้ไข P4P 7/69", file "…ก.ค.69.xlsx". Gmail's attribution
  // line carries the quoted mail's send date, "Oct 1, 2026", and the body
  // reader took "Oct" as the sender naming October. The body outranks the
  // filename, so the July file was filed — and scored — under 2569_10.
  // Gmail wraps the line at ~72 chars, leaving "wrote:" on its own line.
  const body = [
    "แก้ไข P4P 7/69 พ.สมชาย",
    "",
    "On Thu, Oct 1, 2026 at 5:53 PM Somchai Jaidee-Example <somchai@example.com>",
    "wrote:",
    "",
    ">",
    ">",
  ].join("\n");
  assert.deepEqual(periodsInText(body), []);
  assert.deepEqual(
    statedPeriods("P4P สมชาย อายุรกรรม ก.ค.69.xlsx", "Re: P4P สมชาย 8-9/69", body),
    { periods: [{ month: 7, beYear: null }], source: "filename" },
  );

  // Same line, unwrapped (a shorter name keeps it on one line).
  assert.deepEqual(
    periodsInText("ส่งแล้วครับ\n\nOn Tue, Sep 29, 2026 at 11:14 AM P4P <p4p@example.com> wrote:"),
    [],
  );

  // Thai-locale Gmail words the same line differently — and it is real: this
  // is the attribution on a reply received in this mailbox.
  assert.deepEqual(
    periodsInText("ขอบคุณมากค่ะ\n\nในวันที่ อังคาร 29 ก.ย. 2026 เวลา 11:14 Samut Sakhon Medical Staff Organization <sakhonmso@gmail.com> เขียนว่า:"),
    [],
  );

  // Blanking the attribution must not swallow what the sender actually wrote
  // above it: a stated month in their own words still routes.
  assert.deepEqual(
    periodsInText("ส่ง P4P เดือน ก.ค. 2569\n\nOn Thu, Oct 1, 2026 at 5:53 PM A B <a@b.c> wrote:"),
    [{ month: 7, beYear: 2569 }],
  );
});

test("a conjunction typed flush against a month does not hide that month", () => {
  // Real subject from a recurring sender, two workbooks attached (สค and
  // กันยา): "และ" ("and") is glued straight onto กันยายน with no space, so the
  // boundary check read it as the tail of a longer word, the subject stated
  // August alone, and BOTH files were routed as August.
  assert.deepEqual(periodsInText("ส่ง P4P สิงหาคม และกันยายน 2569 พ.ภัทราวดี ปิ่นสุข"), [
    { month: 8, beYear: 2569 },
    { month: 9, beYear: 2569 },
  ]);
  // The conjunction can sit on either side of the first month too.
  assert.deepEqual(periodsInText("ส่ง P4P สิงหาคมและกันยายน 2569"), [
    { month: 8, beYear: 2569 },
    { month: 9, beYear: 2569 },
  ]);
  assert.deepEqual(periodsInText("ส่ง P4P เดือนสิงหาคมและเดือนกันยายน 2569"), [
    { month: 8, beYear: 2569 },
    { month: 9, beYear: 2569 },
  ]);
  // Abbreviations take the same joiners.
  assert.deepEqual(periodsInText("p4p สค.และกย. 69"), [
    { month: 8, beYear: null },
    { month: 9, beYear: null },
  ]);
  assert.deepEqual(periodsInText("p4p สคและกย 69"), [
    { month: 8, beYear: null },
    { month: 9, beYear: null },
  ]);
  assert.deepEqual(periodsInText("ส่ง P4P กรกฎาคมถึงสิงหาคม 2569"), [
    { month: 7, beYear: 2569 },
    { month: 8, beYear: 2569 },
  ]);
  assert.deepEqual(periodsInText("ส่ง P4P กรกฎาคมกับสิงหาคม 2569"), [
    { month: 7, beYear: 2569 },
    { month: 8, beYear: 2569 },
  ]);

  // The mail now names two periods, so each file's own name is what decides
  // — and each of these filenames already resolves to exactly one.
  const subject = "ส่ง P4P สิงหาคม และกันยายน 2569 พ.ภัทราวดี ปิ่นสุข";
  assert.equal(statedPeriods("", subject, "").periods.length, 2);
  assert.deepEqual(periodsInText("P4P สค 69 ภัทราวดี ปิ่นสุข .xlsx"), [{ month: 8, beYear: null }]);
  assert.deepEqual(periodsInText("P4P กันยา 69 ภัทราวดี ปิ่นสุข .xlsx"), [{ month: 9, beYear: null }]);
});

test("allowing joiner words beside a month does not reopen the name collision", () => {
  // Same guards as the "ณัฐกันย์" tests above, now with the joiners in play:
  // a month abbreviation buried in a name is still not a stated month, with
  // or without a conjunction elsewhere in the line.
  assert.deepEqual(periodsInText("ณัฐกันย์ลิมปวิทยากุล"), []);
  assert.deepEqual(periodsInText("p4p ณัฐกันย์ ลิมปวิทยากุล และ ส.ค. 69"), [
    { month: 8, beYear: null },
  ]);
  assert.deepEqual(periodsInText("ส่งคะแนนและรวมคะแนน 850 คะแนน"), [], "'มค' inside 'รวมคะแนน' is still not January");
  // A joiner only counts as the edge of a month word when it is a whole,
  // adjacent word — a month token in the middle of other Thai text is not.
  assert.deepEqual(periodsInText("ส่งกันยามเฝ้าระวัง"), [], "'กันยา' as the start of กันยาม is not September");
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
