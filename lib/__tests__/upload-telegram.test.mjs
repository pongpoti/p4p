/**
 * The admin's Telegram alert as `/upload/score` sends it (design §7.6).
 *
 * The layout itself is already pinned twice over — automation/test's own
 * suite asserts it against the canonical module, and parity.test.mjs ties
 * this copy to that one character for character. What is NOT covered there is
 * the property this file exists for: the send must never be able to turn a
 * saved score into an error the physician sees. It sits inside the request,
 * in front of the receipt, so every failure mode has to come back as `false`.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const tg = require(resolve(repoRoot, "lib/telegram-notify.js"))

// The context /upload/score builds: identity and month both came from a
// verified session, and roster_index was non-null or the row would have been
// deferred — hence "exact" rather than a similarity percentage.
const CTX = {
  source: "LINE upload",
  accountName: "สมชาย ใจดี",
  email: "somchai@example.com",
  monthKey: "2569_06",
  rosterMatch: "exact",
}

test("a scored upload reports the account, the roster hit and the chosen month", () => {
  assert.equal(
    tg.formatResultMessage({ matchedName: "สมชาย ใจดี", score: "1842.50", saved: true }, "P4P_มิย69.xlsx", CTX),
    [
      "📋 P4P Workload Report",
      "",
      "📥 Source   : LINE upload",
      "👤 Account  : สมชาย ใจดี <somchai@example.com>",
      "🔗 Roster   : สมชาย ใจดี (exact)",
      "📅 Month    : 2569_06 (เลือกเอง)",
      "🏅 Score    : 1842.50",
      "💾 ✅ Score saved to DB",
      "",
      "📎 File: P4P_มิย69.xlsx",
    ].join("\n")
  )
})

test("a rejection names the type and the month the file disagreed with", () => {
  const msg = tg.formatErrorMessage(
    "ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06",
    "P4P_พค69.xlsx",
    { ...CTX, errorType: "month_mismatch", monthInFile: "2569_05" }
  )
  assert.equal(
    msg,
    [
      "❌ P4P Upload Error",
      "",
      "📥 Source : LINE upload",
      "👤 Account: สมชาย ใจดี <somchai@example.com>",
      "📅 Month  : 2569_06",
      "🚫 Type   : month_mismatch",
      "💬 Error  : ไฟล์ระบุเดือน 2569_05 แต่เลือกส่งเดือน 2569_06",
      "⚠️ Month in file: 2569_05 (≠ 2569_06 selected)",
      "",
      "📎 File: P4P_พค69.xlsx",
    ].join("\n")
  )
})

test("no attempt counter on this path, which does not retry", () => {
  // "🔁 Attempt: n/3" is the worker's line: a rejection here is terminal on
  // the first try, and printing "1/3" would promise a retry that never comes.
  const msg = tg.formatErrorMessage("boom", "f.xlsx", { ...CTX, errorType: "other" })
  assert.ok(!msg.includes("Attempt"), msg)
})

test("a deployment with no Telegram credentials skips the send instead of throwing", async (t) => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  // The warn is deliberate and would otherwise print mid-suite.
  const warn = console.warn
  console.warn = () => {}
  t.after(() => {
    console.warn = warn
    if (token !== undefined) process.env.TELEGRAM_BOT_TOKEN = token
    if (chat !== undefined) process.env.TELEGRAM_CHAT_ID = chat
  })

  assert.equal(await tg.sendTelegram("anything"), false)
})
