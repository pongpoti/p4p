import { test } from "node:test";
import assert   from "node:assert/strict";
import { isMonthComplete } from "../scripts/score-tracker.js";

// A dept status is `{ complete, missing, total }` (as getDeptStatus returns)
// or `null` when that department has no rows in the month.
const complete   = (total = 5)          => ({ complete: true,  missing: 0,       total });
const incomplete = (missing = 2, total = 5) => ({ complete: false, missing, total });

test("every department complete → month complete", () => {
  assert.equal(isMonthComplete([complete(), complete(), complete()]), true);
});

test("one incomplete department among complete ones → month NOT complete", () => {
  assert.equal(isMonthComplete([complete(), incomplete(), complete()]), false);
});

test("null (no-data) departments are ignored; the rest complete → month complete", () => {
  assert.equal(isMonthComplete([null, complete(), null]), true);
});

test("all departments null (no data at all) → NOT complete (nothing to send)", () => {
  assert.equal(isMonthComplete([null, null]), false);
});

test("empty input → NOT complete", () => {
  assert.equal(isMonthComplete([]), false);
});

test("single complete department → complete", () => {
  assert.equal(isMonthComplete([complete()]), true);
});

test("single incomplete department → NOT complete", () => {
  assert.equal(isMonthComplete([incomplete()]), false);
});

test("mix of complete + null + incomplete → NOT complete (the incomplete one gates)", () => {
  assert.equal(isMonthComplete([complete(), null, incomplete(1, 4)]), false);
});
