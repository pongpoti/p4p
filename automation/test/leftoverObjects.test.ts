// The drain deletes the uploaded objects of queue rows nothing will claim again (superseded by a newer
// upload, or failed as stuck in processing), then stamps object_deleted_at so each row is done once.
// Supabase REST and Storage are faked through global fetch; nothing leaves the box.
process.env.SUPABASE_URL = "http://supabase.test"; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";

import { test } from "node:test";
import assert   from "node:assert/strict";

const { sweepLeftoverObjects } = await import("../scripts/drain-uploads.js");

interface Seen { method: string; path: string; query: string; body: unknown }

function fake({ rows = [] as unknown[], readStatus = 200, storageStatus = 200 } = {}) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    seen.push({ method, path: url.pathname, query: decodeURIComponent(url.search), body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/rest/v1/p4p_upload_queue" && method === "GET") {
      return readStatus === 200 ? json(200, rows) : json(readStatus, { message: "column p4p_upload_queue.object_deleted_at does not exist", code: "42703" });
    }
    if (url.pathname === "/rest/v1/p4p_upload_queue" && method === "PATCH") return json(200, []);
    if (url.pathname.startsWith("/storage/v1/object/p4p-uploads")) {
      return storageStatus === 200 ? json(200, []) : json(storageStatus, { statusCode: String(storageStatus), error: "fail", message: "storage down" });
    }
    throw new TypeError(`fetch failed (no network in tests): ${method} ${url.href}`);
  }) as typeof fetch;
  return seen;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

test("superseded and stuck rows lose their object, and are stamped once it is gone", async () => {
  const seen = fake({ rows: [{ id: "q1", object_path: "uid/a.xlsx" }, { id: "q2", object_path: "uid/b.xlsx" }] });
  assert.equal(await quiet(() => sweepLeftoverObjects()), 2);

  const read = seen.find((s) => s.method === "GET")!;
  assert.match(read.query, /object_deleted_at=is\.null/);
  assert.match(read.query, /or=\(archive_status\.eq\.superseded,and\(status\.eq\.failed,error_type\.eq\.stuck_processing\)\)/);

  const del = seen.find((s) => s.path.startsWith("/storage/"))!;
  assert.deepEqual((del.body as { prefixes: string[] }).prefixes, ["uid/a.xlsx", "uid/b.xlsx"]);

  const stamp = seen.find((s) => s.method === "PATCH")!;
  assert.match(stamp.query, /id=in\.\(q1,q2\)/);
  assert.ok((stamp.body as { object_deleted_at?: string }).object_deleted_at);
  assert.ok(seen.indexOf(del) < seen.indexOf(stamp), "deleted before stamped");
});

test("nothing to do: no storage call", async () => {
  const seen = fake({ rows: [] });
  assert.equal(await quiet(() => sweepLeftoverObjects()), 0);
  assert.equal(seen.filter((s) => s.path.startsWith("/storage/")).length, 0);
});

test("a read error (the column not added yet) is skipped quietly", async () => {
  const seen = fake({ readStatus: 400 });
  assert.equal(await quiet(() => sweepLeftoverObjects()), 0);
  assert.equal(seen.filter((s) => s.method !== "GET").length, 0);
});

test("a storage error leaves the rows unstamped for the next run", async () => {
  const seen = fake({ rows: [{ id: "q1", object_path: "uid/a.xlsx" }], storageStatus: 500 });
  assert.equal(await quiet(() => sweepLeftoverObjects()), 0);
  assert.equal(seen.filter((s) => s.method === "PATCH").length, 0);
});
