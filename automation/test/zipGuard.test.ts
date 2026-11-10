// The email path's zip-bomb guard (zip-guard.ts, which reuses lib/p4p-score.ts checkZipSafety):
// an attachment that would inflate past the limits is answered once and never reaches ExcelJS.
// Network endpoints point at a closed local port before index.ts is imported.
process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_URL = "http://127.0.0.1:9"; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = ""; process.env.TELEGRAM_CHAT_ID = "";

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";
import { zipProblem } from "../zip-guard.js";

const { processAttachment, SENDER_DETAIL } = await import("../index.js");

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1").getCell("A1").value = "P4P";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A ~60 KB zip whose one entry inflates to 51 MB of zeros. */
async function bomb(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml", Buffer.alloc(51 * 1024 * 1024));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }));
}

test("a real workbook passes", async () => {
  assert.equal(zipProblem(await workbook()), null);
});

test("bytes that are not a zip, an inflating bomb and a zip of too many entries are each refused", async () => {
  assert.equal(zipProblem(Buffer.from("<html>not a workbook</html>"))?.code, "NOT_A_ZIP");
  const b = await bomb();
  assert.ok(b.length < 1024 * 1024, "the bomb itself is small");
  assert.equal(zipProblem(b)?.code, "ZIP_TOO_LARGE");
  const many = new JSZip();
  for (let i = 0; i < 201; i++) many.file(`f${i}.xml`, "x");
  assert.equal(zipProblem(Buffer.from(await many.generateAsync({ type: "nodebuffer" })))?.code, "ZIP_TOO_MANY_ENTRIES");
});

test("on the email path a refused attachment is answered once and never parsed", async () => {
  const buf = await bomb();
  const sent: { html?: string }[] = [];
  const gmail = {
    downloadAttachment: async () => buf,
    sendMessage: async (o: { html?: string }) => { sent.push(o); },
  };
  const log: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => { log.push(a.join(" ")); };
  let outcome: unknown;
  try {
    outcome = await processAttachment(
      { attachmentId: "a1", filename: "x.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: buf.length },
      "m1",
      { replyTo: "sender@example.com", subject: "ส่ง P4P ตุลาคม 2569", body: "", emailDate: "2026-11-02T04:00:00Z" },
      gmail as never,
    );
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(outcome, "replied", "replied = the message is labelled and not fetched again");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.html!.includes(SENDER_DETAIL.zipTooBig));
  assert.match(log.join("\n"), /refused before parsing: ZIP_TOO_LARGE/);
  assert.doesNotMatch(log.join("\n"), /Using sheet|Failed to parse workbook/, "ExcelJS never ran");
});
