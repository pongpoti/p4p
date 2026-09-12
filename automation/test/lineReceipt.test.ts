/**
 * The worker's LINE failure bubble.
 *
 * This is the only message the worker ever pushes (design §7.2/§7.4): the
 * instant tier's receipt is sent by the page, and a deferred success is
 * pulled by the physician tapping the button they already have. So what
 * matters here is that a failure says something the physician can act on, and
 * that the button matches whether they can actually act on it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildFailureBubble, errorText, displayMonth } from "../templates/line-receipt.js";

test("every error_type the queue can hold has Thai text", () => {
  // The taxonomy in design §10 — error_type is written by three different
  // places (the enqueue RPC, /upload/score, this worker), so an unmapped key
  // would surface to a physician as the fallback message with no clue.
  for (const type of [
    "wrong_extension", "temp_file", "file_link", "zero_score", "wrong_date",
    "month_mismatch", "not_in_roster", "physician_not_found", "oversize", "other",
  ]) {
    const text = errorText(type);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 10, `${type} has no usable Thai text`);
  }
});

test("an unknown error_type degrades to the generic message", () => {
  assert.equal(errorText("something_new"), errorText("other"));
  assert.equal(errorText(undefined), errorText("other"));
});

test("a fixable failure offers the upload page again", () => {
  const bubble = buildFailureBubble({
    monthKey: "2569_06",
    errorType: "month_mismatch",
    detail: "ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06",
    uploadLiffUrl: "https://liff.line.me/1234-abcd",
  });
  const button = bubble.contents.footer.contents[0];
  assert.equal(button.action.label, "ส่งไฟล์อีกครั้ง");
  assert.equal(button.action.uri, "https://liff.line.me/1234-abcd");
  // Both months named, in the bubble, not just in the log.
  assert.match(JSON.stringify(bubble), /2569_05/);
});

test("a failure the physician cannot fix does not pretend they can", () => {
  // A retry button on an unretryable error is worse than no button.
  for (const type of ["not_in_roster", "physician_not_found", "other"]) {
    const bubble = buildFailureBubble({
      monthKey: "2569_06", errorType: type, uploadLiffUrl: "https://liff.line.me/1234-abcd",
    });
    assert.equal(bubble.contents.footer.contents[0].action.label, "ติดต่อผู้ดูแล", type);
  }
});

test("no configured LIFF app means no dead button", () => {
  const bubble = buildFailureBubble({ monthKey: "2569_06", errorType: "zero_score", uploadLiffUrl: "" });
  assert.equal(bubble.contents.footer.contents[0].action.label, "ติดต่อผู้ดูแล");
});

test("the bubble is a valid Flex message with the month in its altText", () => {
  const bubble = buildFailureBubble({ monthKey: "2569_06", errorType: "zero_score" });
  assert.equal(bubble.type, "flex");
  assert.equal(bubble.contents.type, "bubble");
  assert.ok(bubble.altText.length > 0, "altText is what shows in the chat list and push notification");
  assert.equal(displayMonth("2569_06"), "มิถุนายน 2569");
});

test("the header colour marks failure, and the hero takes the month's accent", () => {
  const bubble = buildFailureBubble({ monthKey: "2569_06", errorType: "other" });
  assert.equal(bubble.contents.header.backgroundColor, "#B03A2E");
  // June = index 5 in COLOR_ARRAY — the same accent as the month tab the
  // physician will land on from /status/.
  assert.equal(bubble.contents.hero.backgroundColor, "#46ecd5");
});
