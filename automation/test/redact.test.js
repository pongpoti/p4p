import { test }  from "node:test";
import assert    from "node:assert/strict";
import { redactPII } from "../redact.js";

const TAG = /#[0-9a-f]{4}/;

test("masks a Thai physician name", () => {
  const out = redactPII("✅  Physician : สมชาย ใจดี");
  assert.ok(!out.includes("สมชาย"), "given name leaked");
  assert.ok(!out.includes("ใจดี"),  "surname leaked");
  assert.match(out, /«ชื่อ#[0-9a-f]{4}»/);
  assert.ok(out.startsWith("✅  Physician : "), "non-PII prefix should survive");
});

test("masks a given+surname pair as one unit, not two", () => {
  assert.equal((redactPII("สมชาย ใจดี").match(/«ชื่อ#/g) ?? []).length, 1);
});

test("masks an email but keeps the domain", () => {
  const out = redactPII("original sender: somchai.jaidee@example.com");
  assert.ok(!out.includes("somchai.jaidee"), "local part leaked");
  assert.ok(out.includes("@example.com"), "domain should survive for routing debug");
  assert.match(out, TAG);
});

test("the same value tags identically within one process", () => {
  assert.equal(redactPII("สมชาย ใจดี"), redactPII("สมชาย ใจดี"));
  assert.equal(redactPII("a@b.com"),     redactPII("a@b.com"));
});

test("different values tag differently", () => {
  assert.notEqual(redactPII("สมชาย ใจดี"), redactPII("กานดา มีสุข"));
});

test("leaves non-personal output untouched", () => {
  for (const s of [
    "Drive upload: 2569_03.xlsx (new file)",
    "Total missing : 12 physician-month entries",
    "[INFO] 2026-09-11T00:00:00.000Z Processing started",
    "Roster row #14 — fuzzy 92%",
  ]) assert.equal(redactPII(s), s);
});

test("handles null/undefined/empty without throwing", () => {
  assert.equal(redactPII(null), null);
  assert.equal(redactPII(undefined), undefined);
  assert.equal(redactPII(""), "");
});

test("masks names embedded in a Drive filename", () => {
  const out = redactPII('Uploading as "สมชาย ใจดี_2569_03.xlsx"…');
  assert.ok(!out.includes("สมชาย"));
  assert.ok(out.includes(".xlsx"), "extension should survive");
});

test("masks inside a multi-line block", () => {
  const out = redactPII("line1 สมชาย ใจดี\nline2 b@c.com\nline3 ok");
  assert.ok(!out.includes("สมชาย"));
  assert.ok(!out.includes("b@c.com"));
  assert.ok(out.includes("line3 ok"));
});
