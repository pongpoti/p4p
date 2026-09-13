import { test } from "node:test";
import assert   from "node:assert/strict";
import { buildHtmlErrorReply } from "../templates/error-reply.js";

const strip = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("month_mismatch names both months, so the physician can fix it unaided", () => {
  const text = strip(buildHtmlErrorReply({
    safeFilename: "P4P.xlsx",
    errorType   : "month_mismatch",
    statedDate  : "กรกฎาคม 2569",
    detectedDate: "มิถุนายน 2569",
  }));
  assert.match(text, /เดือนที่ระบุไม่ตรงกับไฟล์/, "banner names the actual problem");
  assert.match(text, /เดือนที่ท่านระบุ กรกฎาคม 2569/);
  assert.match(text, /เดือนที่พบในไฟล์ มิถุนายน 2569/);
  assert.doesNotMatch(text, /เกิดข้อผิดพลาดในการประมวลผล/, "must not fall back to the generic copy");
});

test("the detected-date row keeps its old label when there is nothing to compare against", () => {
  const text = strip(buildHtmlErrorReply({
    errorType   : "wrong_date",
    detectedDate: "2570_13",
  }));
  assert.match(text, /วันที่ที่ตรวจพบ 2570_13/);
});

test("no_period and ambiguous_period each say what to do next", () => {
  const noPeriod = strip(buildHtmlErrorReply({ errorType: "no_period" }));
  assert.match(noPeriod, /ไม่ได้ระบุเดือนที่ส่ง/);
  assert.match(noPeriod, /ก\.ค\. 2569/, "gives a concrete example to copy");

  const ambiguous = strip(buildHtmlErrorReply({ errorType: "ambiguous_period" }));
  assert.match(ambiguous, /ระบุหลายเดือนในอีเมลเดียว/);
  assert.match(ambiguous, /ส่งแยกอีเมลละหนึ่งเดือน/);
});

test("an unknown error type still renders the generic copy rather than blank", () => {
  const text = strip(buildHtmlErrorReply({ errorType: "something_new" }));
  assert.match(text, /เกิดข้อผิดพลาดในการประมวลผล/);
});

test("month_not_found has its own copy instead of falling back to the generic error", () => {
  const text = strip(buildHtmlErrorReply({ errorType: "month_not_found" }));
  assert.match(text, /ไม่พบชีตของเดือนที่ระบุ/, "banner names the actual problem");
  assert.match(text, /ตั้งชื่อชีต/, "tells the sender how to fix it — rename the tab");
  assert.doesNotMatch(text, /เกิดข้อผิดพลาดในการประมวลผล/, "must not fall back to the generic copy");
});

test("detail carries the specific per-submission explanation into the reply", () => {
  // month_not_found's CONTENT copy is generic on purpose (no per-file facts);
  // `detail` is how the exact month/sheet list the rejection computed
  // actually reaches the sender instead of staying Telegram-only.
  const text = strip(buildHtmlErrorReply({
    errorType: "month_not_found",
    detail   : "ไฟล์มีหลายชีต แต่ไม่มีชีตใดระบุเดือน สิงหาคม 2569 กรุณาตั้งชื่อชีตให้ระบุเดือน หรือส่งเฉพาะชีตที่ต้องการ",
  }));
  assert.match(text, /รายละเอียด ไฟล์มีหลายชีต แต่ไม่มีชีตใดระบุเดือน สิงหาคม 2569/);
});

test("detail is HTML-escaped like every other user-influenced field", () => {
  const text = buildHtmlErrorReply({ errorType: "month_not_found", detail: "<script>x</script> & \"quoted\"" });
  assert.doesNotMatch(text, /<script>x<\/script>/);
  assert.match(text, /&lt;script&gt;x&lt;\/script&gt;/);
});
