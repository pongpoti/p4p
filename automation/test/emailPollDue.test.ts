import { test } from "node:test";
import assert from "node:assert/strict";
import { emailPollDue } from "../scripts/drain-uploads.js";

const MIN = 60_000;
const until = 60 * MIN;

test("first pass runs straight away", () => {
  assert.equal(emailPollDue(0, null, until, MIN), true);
});

test("waits for the interval between passes", () => {
  assert.equal(emailPollDue(30_000, 0, until, MIN), false);
  assert.equal(emailPollDue(MIN, 0, until, MIN), true);
});

test("no new pass in the last five minutes of the run", () => {
  assert.equal(emailPollDue(56 * MIN, null, until, MIN), false);
  assert.equal(emailPollDue(54 * MIN, 50 * MIN, until, MIN), true);
});

test("an interval of 0 turns polling off", () => {
  assert.equal(emailPollDue(0, null, until, 0), false);
});
