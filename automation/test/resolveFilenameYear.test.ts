/**
 * resolveFilenameYear: the year an upload's file name plainly states, used by
 * the worker's LINE-upload month_mismatch check (index.ts processBuffer). It
 * must give the same answer as lib/p4p-score.ts's copy, which /upload/score
 * uses for the same check, so a file is never refused by one and accepted by
 * the other. Audit finding F11.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolveFilenameYear } from "../claude-analyst.js";

const require = createRequire(import.meta.url);
const lib = require("../../lib/p4p-score.ts") as { resolveFilenameYear(f?: string | null): number | null };

const STATED: Array<[string, number]> = [
  ["P4P_2569_10.xlsx", 2569],
  ["P4P_9_2026.xlsx", 2569],
  ["P4P ต.ค.69.xlsx", 2569],
  ["P4P ตุลาคม 69.xlsx", 2569],
  ["P4P Oct-69.xlsx", 2569],
  ["P4P 10/69.xlsx", 2569],
  ["P4P 31-10-69.xlsx", 2569],
  ["P4P ก.ย.68.xlsx", 2568],
];
const NOT_A_YEAR = [
  "P4P_ตุลาคม_ทดสอบ_12.xlsx",
  "P4P_ตุลาคม_เวร 30 วัน.xlsx",
  "P4P ตุลาคม (85).xlsx",
  "P4P_10.xlsx",
  "P4P ward 12.xlsx",
  "ทดสอบ v15.xlsx",
  "P4P 05.xlsx",
  "P4P ตุลาคม 1-15.xlsx",
  "P4P ตุลาคม 30 วัน.xlsx",
  "P4P ต.ค. 31วัน.xlsx",
  "P4P Oct 15 shifts.xlsx",
  "P4P มกราคม 15.xlsx",
  "P4P Oct 45 days.xlsx",
  "P4P ตุลาคม 45 เวร.xlsx",
  "",
];

test("a year the file name plainly states is read", () => {
  for (const [name, year] of STATED) assert.equal(resolveFilenameYear(name), year, name);
});

test("a lone two-digit number is not a year", () => {
  for (const name of NOT_A_YEAR) assert.equal(resolveFilenameYear(name), null, name);
  assert.equal(resolveFilenameYear(null), null);
});

test("same answer as lib/p4p-score.ts (used by /upload/score)", () => {
  for (const name of [...STATED.map(([n]) => n), ...NOT_A_YEAR]) {
    assert.equal(resolveFilenameYear(name), lib.resolveFilenameYear(name), name);
  }
});
