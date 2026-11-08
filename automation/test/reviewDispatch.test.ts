import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { reviewCheckDue, buildBusy, BUILD_WORKFLOW, PDF_WORKFLOW } from "../review-dispatch.js";

const workflows = resolve(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows");

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

test("starts workflows that exist, and 1.2 watches the PDF one", () => {
  // A renamed file would make every dispatch fail with 404.
  for (const f of [BUILD_WORKFLOW, PDF_WORKFLOW]) assert.ok(existsSync(resolve(workflows, f)), f);
  const pdf = readFileSync(resolve(workflows, PDF_WORKFLOW), "utf8");
  const name = /^name:\s*"([^"]+)"/m.exec(pdf)?.[1] ?? "";
  assert.ok(name, "2.8 has a name");
  assert.ok(readFileSync(resolve(workflows, "1-2-always-on-alert-failed-runs.yml"), "utf8").includes(`"${name}"`),
    "1.2's WATCH list has 2.8 by name");
});
