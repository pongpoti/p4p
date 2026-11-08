import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCheckDue, buildBusy } from "../review-dispatch.js";

test("looks for ตรวจสอบ tab requests every 30 s", () => {
  assert.equal(reviewCheckDue(0, null), true);
  assert.equal(reviewCheckDue(29_000, 0), false);
  assert.equal(reviewCheckDue(30_000, 0), true);
  assert.equal(reviewCheckDue(0, null, 0), false);
});

test("waits while any 2.2 run is queued or running", () => {
  assert.equal(buildBusy([]), false);
  assert.equal(buildBusy([{ status: "completed" }, { status: "completed" }]), false);
  assert.equal(buildBusy([{ status: "queued" }, { status: "completed" }]), true);
  assert.equal(buildBusy([{ status: "completed" }, { status: "in_progress" }]), true);
  assert.equal(buildBusy([{ status: "waiting" }]), true);
});
