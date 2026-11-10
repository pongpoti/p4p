// The LINE drain runs the same zip-bomb guard as the email path before ExcelJS sees a queued upload:
// a workbook whose headers understate what it inflates to is refused for good, the physician gets the
// failure bubble and the object is deleted. Supabase, Storage, LINE and Telegram are in-memory fakes.
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
process.env.LINE_ACCESS_TOKEN = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import JSZip    from "jszip";

const { handleScoreFallback } = await import("../scripts/drain-uploads.js");
const { SENDER_DETAIL } = await import("../index.js");

/** A small zip whose one entry inflates to 60 MB while both headers declare 2000 bytes. */
async function lyingBomb(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml", Buffer.alloc(60 * 1024 * 1024, 0x20));
  const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }));
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(2000, cd + 24);   // central directory: uncompressed size
  buf.writeUInt32LE(2000, 22);        // local header: uncompressed size
  return buf;
}

test("a queued upload that would inflate past the limit is refused before parsing", async () => {
  const bomb = await lyingBomb();
  const be = installFakeBackends({ p4p_upload_queue: [{ id: "q1", status: "processing", attempts: 1 }] });
  const pushes: unknown[] = [];
  const deletes: unknown[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "https://api.line.me/v2/bot/message/push") {
      pushes.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    if (url.startsWith(`${FAKE_SUPABASE_URL}/storage/v1/object/`)) {
      if (method === "DELETE") { deletes.push(url); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }
      return new Response(bomb, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return inner(input, init);
  }) as typeof fetch;

  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    await handleScoreFallback({
      id: "q1", filename: "P4P.xlsx", month_key: "2569_10", full_name: "ทดสอบ ตัวอย่าง", email: "doctor.zip@example.com",
      department: null, roster_index: 7, line_user_id: "U-test", object_path: "uid/q1.xlsx", received_at: "2026-11-07T03:00:00.000Z",
      archive_attempts: 0, status: "processing", score: null, attempts: 1,
    });
  } finally {
    Object.assign(console, orig);
  }

  const row = be.tables["p4p_upload_queue"]![0]!;
  assert.equal(row.status, "rejected", "refused for good, not retried");
  assert.equal(row.error_detail, SENDER_DETAIL.zipTooBig);
  assert.equal(pushes.length, 1, "the physician gets the failure bubble");
  assert.equal(deletes.length, 1, "the object is deleted");
  assert.ok(be.telegrams.some((t) => t.includes("ZIP_TOO_LARGE")), "the admin is told");
});
