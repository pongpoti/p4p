// Claude's score never overrides the deterministic JS score: a high-confidence JS score wins outright, a
// disagreement with a low-confidence one is held for the admin, and Claude's number is used only when JS
// has none. Claude is a local HTTP stand-in on 127.0.0.1 (the SDK uses node-fetch, so it is a real
// socket on this machine and nothing else); Supabase and Telegram are the fakes of fakeBackends.ts.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FAKE_SUPABASE_URL, installFakeBackends } from "./fakeBackends.js";

let claudeAnswer: { name: string; score: string } = { name: "", score: "" };
let claudeCalls = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    claudeCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(claudeAnswer) }], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref();
process.env.ANTHROPIC_API_KEY = "test";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.SUPABASE_URL = FAKE_SUPABASE_URL; process.env.SUPABASE_KEY = "test";
process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_CHAT_ID = "test";
delete process.env.P4P_FOLDER_ID;

import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";

const { analyseJson, chooseScore, isHighConfidence, HIGH_CONFIDENCE_METHODS, CLAUDE_SCORE_METHOD } = await import("../claude-analyst.js");
const { processBuffer } = await import("../index.js");

const GRAND = "grand-total label row (all columns)";
const SUB   = "sub-total label row (col_1-3)";

test("chooseScore: JS wins when trusted, a disagreement with an untrusted JS score is a conflict", () => {
  assert.deepEqual(chooseScore(4000, 1800, GRAND), { kind: "score", score: 1800, method: GRAND });
  assert.deepEqual(chooseScore(650, 400, SUB), { kind: "conflict", claudeScore: 650, jsScore: 400, jsMethod: SUB });
  assert.deepEqual(chooseScore(400.004, 400, SUB), { kind: "score", score: 400, method: SUB }, "within the tolerance is agreement");
  assert.deepEqual(chooseScore(400.01, 400, SUB), { kind: "score", score: 400, method: SUB });
  assert.equal(chooseScore(400.02, 400, SUB).kind, "conflict");
  assert.deepEqual(chooseScore(null, 400, SUB), { kind: "score", score: 400, method: SUB }, "Claude had none");
  assert.deepEqual(chooseScore(0, 400, SUB), { kind: "score", score: 400, method: SUB });
  assert.deepEqual(chooseScore(512, null, "no candidates found"), { kind: "score", score: 512, method: CLAUDE_SCORE_METHOD }, "JS had none");
  assert.deepEqual(chooseScore(512, 0, "no candidates found"), { kind: "score", score: 512, method: CLAUDE_SCORE_METHOD });
  assert.deepEqual(chooseScore(null, null, "no candidates found"), { kind: "none" });
  assert.equal(isHighConfidence(CLAUDE_SCORE_METHOD), false);
  assert.equal(isHighConfidence(undefined), false);
});

test("the trusted methods are the same set /upload/score gates on (lib/p4p-score.ts)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "../../lib/p4p-score.ts"), "utf8");
  const block = src.match(/HIGH_CONFIDENCE_METHODS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "lib/p4p-score.ts still declares HIGH_CONFIDENCE_METHODS as a Set literal");
  const lib = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...HIGH_CONFIDENCE_METHODS].sort(), lib);
});

const NO_NAME = { _source_file: "P4P.xlsx", _email_subject: "", _email_body: "", _selected_sheet: "Sheet1", _date_key: "2569_10" };

test("analyseJson: a high-confidence JS total beats a different Claude answer", async () => {
  claudeAnswer = { name: "ทดสอบ ตัวอย่าง", score: "4000" };
  const r = await analyseJson({ ...NO_NAME, rows: [{ col_1: "งาน", col_2: 10 }, { col_1: "รวมทั้งหมด", col_3: 1800 }] });
  assert.equal(r.score, 1800);
  assert.equal(r.scoreMethod, GRAND);
  assert.equal(r.scoreConflict ?? null, null);
});

test("analyseJson: Claude disagreeing with a sub-total reading is a conflict, not Claude's number", async () => {
  claudeAnswer = { name: "ทดสอบ ตัวอย่าง", score: "650.00" };
  const r = await analyseJson({ ...NO_NAME, rows: [{ col_1: "รวมคะแนน", col_2: 400 }, { col_1: "รวมคะแนน", col_2: 250 }] });
  assert.deepEqual(r.scoreConflict, { claudeScore: 650, jsScore: 400, jsMethod: SUB });
  assert.notEqual(r.score, 650);
});

test("analyseJson: Claude agreeing with a sub-total reading keeps the JS score and its method", async () => {
  claudeAnswer = { name: "ทดสอบ ตัวอย่าง", score: "400.00" };
  const r = await analyseJson({ ...NO_NAME, rows: [{ col_1: "รวมคะแนน", col_2: 400 }, { col_1: "รวมคะแนน", col_2: 250 }] });
  assert.equal(r.score, 400);
  assert.equal(r.scoreMethod, SUB);
  assert.equal(r.scoreConflict ?? null, null);
});

test("analyseJson: Claude's score is used only when JS has none, and is marked as Claude's", async () => {
  claudeAnswer = { name: "ทดสอบ ตัวอย่าง", score: "512.25" };
  const r = await analyseJson({ ...NO_NAME, rows: [{ col_1: "ชื่อ", col_2: "ข้อความ" }, { col_1: "อื่น", col_2: "ไม่มีตัวเลข" }] });
  assert.equal(r.score, 512.25);
  assert.equal(r.scoreMethod, CLAUDE_SCORE_METHOD);
});

// ── through processBuffer ───────────────────────────────────────────────

const SENDER = "doctor.check@example.com";
const NAME   = "ทดสอบ ตัวอย่าง";

async function book(cells: [string, string | number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [a, v] of cells) ws.getCell(a).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function submit(file: Buffer) {
  const be = installFakeBackends({
    "2569_10"      : [{ index: 7, firstname: "ทดสอบ", lastname: "ตัวอย่าง", prefix: "นพ.", department: "ทดสอบ", score: null, submitted_at: null }],
    physicians     : [{ email: SENDER, full_name: NAME, active: true }],
    p4p_submissions: [],
  });
  const sent: { to: string; subject: string; body?: string; html?: string }[] = [];
  const gmail = { sendMessage: async (o: { to: string; subject: string; body?: string }) => { sent.push(o); return {}; } };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    // No name in the file name or the sheet, so Claude is asked
    const outcome = await processBuffer(file, {
      subject: "ส่ง P4P ตุลาคม 2569", body: "", filename: "P4P.xlsx", replyTo: SENDER, messageId: "msg-score", gmail,
      gmailReceivedAt: "2026-11-07T03:00:00.000Z", workbookCount: 1,
    } as never).catch((e: unknown) => e);
    return { outcome, sent, be };
  } finally {
    Object.assign(console, orig);
  }
}

const SUBTOTALS: [string, string | number][] = [["A1", "รวมคะแนน"], ["B1", 400], ["A2", "รวมคะแนน"], ["B2", 250], ["A3", "หมายเหตุ"], ["B3", "ไม่มี"]];

test("email: a Claude/JS disagreement on an untrusted reading is held — nothing saved, both numbers to the admin", async () => {
  claudeAnswer = { name: NAME, score: "4000" };
  const calls = claudeCalls;
  const { outcome, sent, be } = await submit(await book(SUBTOTALS));
  assert.equal(claudeCalls, calls + 1, "Claude was asked");
  assert.equal(outcome, "replied");
  assert.equal(be.patches.length, 0, "no score saved");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /รอเจ้าหน้าที่ตรวจสอบ/);
  assert.doesNotMatch(sent[0]!.body ?? "", /4000|400/, "the sender is not given either number");
  const alert = be.telegrams.find((t) => t.includes("⚖️"));
  assert.ok(alert, "the admin is told");
  for (const needle of ["4000.00", "400.00", SUB, "msg-score", NAME]) assert.ok(alert!.includes(needle), `alert mentions ${needle}`);
});

test("email: a high-confidence JS total is saved even when Claude says otherwise", async () => {
  claudeAnswer = { name: NAME, score: "4000" };
  const { outcome, be } = await submit(await book([["A1", "งาน"], ["B1", 10], ["A5", "รวมทั้งหมด"], ["C5", 1800]]));
  assert.equal(outcome, true);
  assert.deepEqual(be.patches.filter((p) => "score" in p.body).map((p) => p.body.score), [1800]);
});
