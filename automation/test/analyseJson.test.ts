import { test } from "node:test";
import assert   from "node:assert/strict";
import { analyseJson } from "../claude-analyst.js";

// analyseJson's period is never a question: the caller resolves it
// deterministically (from the sender's own subject/body, or their explicit
// LIFF selection) before calling in, and this file asserts that value is
// never revisited. It used to also ask Claude to re-derive the month/year
// from the same free text and reject on disagreement — the check that once
// misread "ประพันธ์สค69" (a name run straight into "August 69" with no
// space) as December and bounced a plain, correct submission.

const GRAND_TOTAL_ROWS = [
  { col_1: "ชื่อแพทย์", col_2: "กิจกรรม", col_5: "รวมแต้ม" },
  { col_1: null, col_2: "ตรวจผู้ป่วย", col_5: 100 },
  { col_1: "รวมแต้มทั้งหมด", col_5: 11011.5 },
];

test("a submission fully resolved by JS (name + score both pre-scanned) never calls the AI", async () => {
  const result = await analyseJson({
    _source_file   : "P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx",
    _email_subject : "",
    _email_body    : "",
    _selected_sheet: "Sheet1",
    _date_key      : "2569_01",
    rows           : GRAND_TOTAL_ROWS,
  });
  // No ANTHROPIC_API_KEY is set in this test environment — a call that
  // actually reached the AI would throw "Missing ANTHROPIC_API_KEY", not
  // return. Getting a result back at all proves the AI was skipped.
  assert.deepEqual(result, { name: "ศุภศรัณย์", date: "2569_01", score: 11011.5 });
});

test("the date on a fully-resolved submission is exactly the caller-supplied key, not re-derived", async () => {
  // Subject glued straight onto a month abbreviation with no space at all —
  // the exact shape that once fed Claude an ambiguous read. Name and score
  // still come from the workbook/filename, so this must resolve to the
  // caller's dateKey regardless of what the subject looks like.
  const result = await analyseJson({
    _source_file   : "P4P พ ศุภศรัณย์ เดือนมกราคม 2569.xlsx",
    _email_subject : "p4pพ.ประพันธ์สค69",
    _email_body    : "",
    _selected_sheet: "Sheet1",
    _date_key      : "2569_08",
    rows           : GRAND_TOTAL_ROWS,
  });
  assert.equal(result.date, "2569_08");
});

test("requires an already-resolved _date_key — refuses to guess one itself", async () => {
  await assert.rejects(
    () => analyseJson({ _source_file: "x.xlsx", rows: GRAND_TOTAL_ROWS, _date_key: undefined }),
    /requires a resolved _date_key/,
  );
  await assert.rejects(
    () => analyseJson({ _source_file: "x.xlsx", rows: GRAND_TOTAL_ROWS, _date_key: "2569-01" }),
    /requires a resolved _date_key/,
  );
});

test("falls through to the AI only when JS could not pin down name or score — never for date", async () => {
  // Nothing names a physician anywhere, so the JS name pre-scan comes up
  // empty and this has to fall through to the (here, unreachable) AI path.
  // No ANTHROPIC_API_KEY is configured in this test environment, so reaching
  // getClient() throws — proving the fallback path is still attempted, not
  // silently skipped, when JS genuinely cannot resolve name or score.
  await assert.rejects(
    () => analyseJson({
      _source_file   : "P4P.xlsx",
      _email_subject : "",
      _email_body    : "",
      _selected_sheet: "Sheet1",
      _date_key      : "2569_01",
      rows           : GRAND_TOTAL_ROWS,
    }),
    /ANTHROPIC_API_KEY/,
  );
});
