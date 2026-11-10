// The LINE drain's crash path: a failed attempt puts the queue row back to pending (the claim then waits
// before taking it again), and the third one fails it for good with the same LINE failure bubble and
// object delete as a failure processBuffer answered. A temporary error (RetryLaterError) tells the admin
// only when it gives up. Supabase, Storage, LINE and Telegram are in-memory fakes.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.LINE_ACCESS_TOKEN = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";

const { handleScoreCrash } = await import("../scripts/drain-uploads.js");
const { RetryLaterError } = await import("../inbound-triage.js");

function row(attempts: number) {
  return {
    id: "q1", filename: "P4P.xlsx", month_key: "2569_10", full_name: "ทดสอบ ตัวอย่าง", email: "doctor.drain@example.com",
    department: null, roster_index: 7, line_user_id: "U-test", object_path: "uid/q1.xlsx", received_at: "2026-11-07T03:00:00.000Z",
    archive_attempts: 0, status: "processing", score: null, attempts,
  };
}

function setup(attempts: number) {
  const be = installFakeBackends({ p4p_upload_queue: [{ id: "q1", status: "processing", attempts }] });
  const pushes: unknown[] = [];
  const deletes: unknown[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.line.me/v2/bot/message/push") {
      pushes.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${FAKE_SUPABASE_URL}/storage/v1/object/`)) {
      deletes.push(JSON.parse(String(init?.body ?? "null")));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as typeof fetch;
  return { be, pushes, deletes, queued: () => be.tables["p4p_upload_queue"]![0]! };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

test("a temporary failure before the last attempt goes back to pending, quietly", async () => {
  const s = setup(1);
  await quiet(() => handleScoreCrash(row(1) as never, new RetryLaterError("Drive upload failed (temporary): 503")));
  assert.equal(s.queued().status, "pending");
  assert.equal(s.pushes.length, 0);
  assert.equal(s.deletes.length, 0, "the file is kept for the retry");
  assert.equal(s.be.telegrams.length, 0, "the admin is told only if it gives up");
});

test("a temporary failure on the last attempt fails the row, tells the physician and drops the file", async () => {
  const s = setup(3);
  await quiet(() => handleScoreCrash(row(3) as never, new RetryLaterError("Drive upload failed (temporary): 503")));
  assert.equal(s.queued().status, "failed");
  assert.equal(s.pushes.length, 1, "the failure bubble is pushed");
  assert.equal((s.pushes[0] as { to: string }).to, "U-test");
  assert.ok(s.queued().notified_at, "notified_at is set");
  assert.equal(s.deletes.length, 1, "the uploaded object is deleted");
  assert.equal(s.be.telegrams.length, 1);
  assert.match(s.be.telegrams[0]!, /Gave up after 3 attempts/);
});

test("any other crash tells the admin on every attempt, and fails for good on the last", async () => {
  const s1 = setup(1);
  await quiet(() => handleScoreCrash(row(1) as never, new Error("boom")));
  assert.equal(s1.queued().status, "pending");
  assert.equal(s1.be.telegrams.length, 1);
  assert.equal(s1.pushes.length, 0);

  const s3 = setup(3);
  await quiet(() => handleScoreCrash(row(3) as never, new Error("boom")));
  assert.equal(s3.queued().status, "failed");
  assert.equal(s3.pushes.length, 1);
  assert.equal(s3.deletes.length, 1);
});
