import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  reviewCheckDue, buildBusy, missingTable, dispatchReviewBuild, dispatchReviewPdf, BUILD_WORKFLOW, PDF_WORKFLOW,
} from "../review-dispatch.js";

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

test("only a definite 'not installed' answer counts as missing tables", () => {
  // PostgREST 503 while it reloads its schema cache: passing, not "not installed".
  assert.equal(missingTable({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }), false);
  assert.equal(missingTable({ code: "PGRST000", message: "Database connection error. Retrying the connection." }), false);
  assert.equal(missingTable({ code: "PGRST001", message: "Database client error. Retrying the connection." }), false);
  assert.equal(missingTable({ code: "", message: "TypeError: fetch failed" }), false);
  assert.equal(missingTable({ message: "<html>502 Bad Gateway</html>" }), false);
  assert.equal(missingTable({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(missingTable(null), false);
  // Definitely not there.
  assert.equal(missingTable({ code: "PGRST205", message: "Could not find the table 'public.review_requests' in the schema cache" }), true);
  assert.equal(missingTable({ code: "PGRST202", message: "Could not find the function public.claim_review_request without parameters in the schema cache" }), true);
  assert.equal(missingTable({ code: "42P01", message: 'relation "public.review_requests" does not exist' }), true);
  assert.equal(missingTable({ code: "42883", message: "function public.claim_review_pdf() does not exist" }), true);
  assert.equal(missingTable({ code: "42703", message: "column review_rounds.pdf_status does not exist" }), true);
});

test("a PostgREST outage (PGRST002) backs off and retries; it never turns the relay off", async () => {
  // A stand-in for PostgREST: each table answers with what `answer` says.
  const answer: Record<string, { status: number; body: unknown }> = {};
  const hits: Record<string, number> = { review_requests: 0, review_rounds: 0 };
  const outage = { status: 503, body: { code: "PGRST002", details: null, hint: null, message: "Could not query the database for the schema cache. Retrying." } };
  const none = { status: 200, body: [] };
  const server = createServer((req, res) => {
    const table = /\/rest\/v1\/(\w+)/.exec(req.url ?? "")?.[1] ?? "";
    hits[table] = (hits[table] ?? 0) + 1;
    const a = answer[table] ?? { status: 404, body: { code: "PGRST205", message: "not found" } };
    res.writeHead(a.status, { "Content-Type": "application/json" }).end(JSON.stringify(a.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_KEY = "test-key";
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "example/not-a-repo";
  try {
    // PDFs: the outage waits 5 min, then the next look goes through.
    const t0 = 1_000_000_000;
    answer.review_rounds = outage;
    assert.equal(await dispatchReviewPdf(t0), false);
    assert.equal(hits.review_rounds, 1);
    assert.equal(await dispatchReviewPdf(t0 + 60_000), false, "backing off");
    assert.equal(hits.review_rounds, 1);
    answer.review_rounds = none;
    assert.equal(await dispatchReviewPdf(t0 + 5 * 60_000), false);
    assert.equal(hits.review_rounds, 2, "still on after the outage");

    // Builds: the outage is tried again on the next 30 s look.
    answer.review_requests = outage;
    assert.equal(await dispatchReviewBuild(), false);
    answer.review_requests = none;
    assert.equal(await dispatchReviewBuild(), false);
    assert.equal(hits.review_requests, 2, "still on after the outage");
    assert.equal(await dispatchReviewPdf(t0 + 6 * 60_000), false);
    assert.equal(hits.review_rounds, 3, "PDFs still on too");

    // Part 3 not installed (42703 on the PDF columns): PDFs off, builds stay on.
    answer.review_rounds = { status: 400, body: { code: "42703", details: null, hint: null, message: "column review_rounds.pdf_status does not exist" } };
    assert.equal(await dispatchReviewPdf(t0 + 7 * 60_000), false);
    assert.equal(await dispatchReviewPdf(t0 + 60 * 60_000), false);
    assert.equal(hits.review_rounds, 4, "PDFs off for the rest of the run");
    assert.equal(await dispatchReviewBuild(), false);
    assert.equal(hits.review_requests, 3, "builds still on");

    // The review tables are not installed at all: builds off too.
    answer.review_requests = { status: 404, body: { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.review_requests' in the schema cache" } };
    assert.equal(await dispatchReviewBuild(), false);
    assert.equal(await dispatchReviewBuild(), false);
    assert.equal(hits.review_requests, 4, "builds off for the rest of the run");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("2.2 closes its ตรวจสอบ tab request when the run stops early", () => {
  // Without this step a run that dies before process.ts ends (a failed
  // step, a cancel, the job time-out) leaves the request open.
  const yml = readFileSync(resolve(workflows, BUILD_WORKFLOW), "utf8");
  const at = yml.indexOf("- name: Close the ตรวจสอบ tab request if the run stopped");
  assert.ok(at > 0, "the step is there");
  const step = yml.slice(at, yml.indexOf("\n\n", at));
  assert.match(step, /if: \(failure\(\) \|\| cancelled\(\)\) && inputs\.request_id != ''/);
  assert.match(step, /\^\[0-9\]\{1,18\}\$/, "only a numeric id goes into the URL");
  assert.match(step, /status=in\.\(queued,dispatched,running\)/, "a request already closed keeps its own reason");
  assert.match(step, /-H @-/, "the key goes to curl on stdin");
  assert.doesNotMatch(step, /echo[^\n]*SUPABASE_KEY/, "the key is never printed");
});
