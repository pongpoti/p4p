/**
 * The month window, the deadline, and the picker's file checks.
 *
 * The deadline is the piece with the most copies — the enqueue RPC's SQL,
 * `assets/shared.js` (the page's banner) and `main.ts` (the authoritative
 * `is_late` in /upload/score's response) each compute it, because none of the
 * three can import either of the others. The SQL copy was checked against
 * deadlineISO()'s own documented cases when it was written; these tests hold
 * the two JavaScript copies to the same instant, and to each other, for every
 * month of the year rather than for one example.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import ts from "typescript"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** assets/shared.js is an IIFE over `window`; run it and take what it published. */
function loadShared() {
  const source = readFileSync(resolve(repoRoot, "assets/shared.js"), "utf8")
  const fakeWindow = {}
  new Function("window", source)(fakeWindow)
  if (!fakeWindow.P4P) throw new Error("assets/shared.js did not define window.P4P")
  return fakeWindow.P4P
}

/**
 * main.ts's copy of the same rule. Lifted out of the source rather than
 * exported from the module: the file is an Express app whose exports are the
 * app itself, and adding a test-only export to it would be the tail wagging
 * the dog. The extracted snippet is real TypeScript (a typed parameter and
 * return type) now, so it goes through `ts.transpileModule` before
 * `new Function()` — a plain string of TS syntax is not valid JS.
 */
function loadServerDeadline() {
  const source = readFileSync(resolve(repoRoot, "main.ts"), "utf8")
  const start = source.indexOf("function monthDeadlineMs")
  if (start === -1) throw new Error("main.ts no longer defines monthDeadlineMs — re-point this test")
  const open = source.indexOf("{", source.indexOf(")", start))
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) {
      const snippet = source.slice(start, i + 1)
      const { outputText } = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
      return new Function(`${outputText}; return monthDeadlineMs`)()
    }
  }
  throw new Error("unbalanced braces while reading monthDeadlineMs")
}

const P4P = loadShared()
const monthDeadlineMs = loadServerDeadline()
const receipt = require(resolve(repoRoot, "lib/line-receipt-flex"))

// ── Deadline ──────────────────────────────────────────────────────────────

test("the deadline is the 10th of the following month, 23:59:59 +07:00", () => {
  // The two cases web/lib/months.ts's deadlineISO() documents for itself, and
  // that scripts/line-upload-2026-09.sql was verified against.
  assert.equal(
    P4P.deadlineDate("2569_04").toISOString(),
    new Date("2026-05-10T23:59:59+07:00").toISOString()
  )
  assert.equal(
    P4P.deadlineDate("2569_12").toISOString(),
    new Date("2027-01-10T23:59:59+07:00").toISOString(),
    "December must roll into the next calendar year"
  )
})

test("main.ts and assets/shared.js agree on every month of two years", () => {
  for (const beYear of [2568, 2569]) {
    for (let m = 1; m <= 12; m++) {
      const key = `${beYear}_${String(m).padStart(2, "0")}`
      assert.equal(
        monthDeadlineMs(key),
        P4P.deadlineDate(key).getTime(),
        `${key}: the page's banner and the server's is_late disagree`
      )
    }
  }
})

test("lateness is decided by when the file was handed over", () => {
  // One second either side of the June 2569 deadline. A file handed over at
  // 23:55 on the 10th and drained at 00:05 must still count as on time (§9),
  // which is why this compares received_at and not "now".
  const deadline = P4P.deadlineDate("2569_06").getTime()
  assert.equal(P4P.isLateFor("2569_06", new Date(deadline - 1000)), false)
  assert.equal(P4P.isLateFor("2569_06", new Date(deadline + 1000)), true)
})

test("the deadline renders in Bangkok time regardless of the device clock", () => {
  assert.equal(P4P.deadlineDisplay("2569_06"), "10 ก.ค. 23:59")
})

test("the กำหนดส่ง label shows the due date without the time", () => {
  assert.equal(P4P.deadlineDueDisplay("2569_06"), "ภายใน 10 ก.ค.")
})

// ── Month window ──────────────────────────────────────────────────────────

test("the six-month window matches src/constants.ts's MONTH_ITERATOR", () => {
  const { MONTH_ITERATOR } = require(resolve(repoRoot, "src/constants"))
  for (let m = 0; m < 12; m++) {
    const now = new Date(Date.UTC(2026, m, 15))
    const fromShared = P4P.recentMonthKeys(6, now)
    const fromIterator = MONTH_ITERATOR[m].map(([monthIndex, yearOffset]) =>
      `${2026 + 543 + yearOffset}_${String(monthIndex + 1).padStart(2, "0")}`
    )
    assert.deepEqual(fromShared, fromIterator, `starting month index ${m}`)
  }
})

test("the window is most-recent-first, so [1] is the month people submit for", () => {
  const keys = P4P.recentMonthKeys(6, new Date(Date.UTC(2026, 6, 3))) // July 2026
  assert.equal(keys[0], "2569_07", "the current month leads the list")
  assert.equal(keys[1], "2569_06", "…and the page defaults to the one before it")
})

// ── Picker validation ─────────────────────────────────────────────────────

test("only .xlsx gets through the picker", () => {
  for (const name of ["p4p.xls", "p4p.pdf", "photo.jpg", "p4p.xlsx.pdf"]) {
    const r = P4P.validateUploadFile({ name, size: 1000 })
    assert.equal(r.ok, false, `${name} should be refused`)
    assert.equal(r.error, "wrong_extension")
  }
  assert.equal(P4P.validateUploadFile({ name: "P4P มิถุนายน.xlsx", size: 40_000 }).ok, true)
  assert.equal(P4P.validateUploadFile({ name: "P4P.XLSX", size: 40_000 }).ok, true)
})

test("Excel's ~$ lock file is caught in the picker, not twenty minutes later", () => {
  const r = P4P.validateUploadFile({ name: "~$P4P มิถุนายน.xlsx", size: 400 })
  assert.equal(r.ok, false)
  assert.equal(r.error, "temp_file")
})

test("the 5 MB bucket cap is enforced before the round trip", () => {
  assert.equal(P4P.validateUploadFile({ name: "p4p.xlsx", size: P4P.MAX_UPLOAD_BYTES }).ok, true)
  const over = P4P.validateUploadFile({ name: "p4p.xlsx", size: P4P.MAX_UPLOAD_BYTES + 1 })
  assert.equal(over.ok, false)
  assert.equal(over.error, "oversize")
})

test("an empty file is refused", () => {
  assert.equal(P4P.validateUploadFile({ name: "p4p.xlsx", size: 0 }).ok, false)
  assert.equal(P4P.validateUploadFile(null).ok, false)
})

// ── Receipt formatting ────────────────────────────────────────────────────

test("the short Thai month names have not drifted from assets/shared.js", () => {
  assert.deepEqual(receipt.THAI_MONTHS_SHORT, P4P.THAI_MONTHS_SHORT)
})

test("the score reads the same in the chat as it does in the email", () => {
  // buildHtmlReply() sends toFixed(2); the receipt adds thousands separators
  // on top. The two must never disagree about the number itself.
  assert.equal(receipt.formatScore(1842.5), "1,842.50")
  assert.equal(receipt.formatScore(0.5), "0.50")
  assert.equal(receipt.formatScore(1234567.891), "1,234,567.89")
})

test("the receipt names the month the physician chose", () => {
  assert.equal(receipt.displayMonth("2569_06"), "มิถุนายน 2569")
  assert.equal(receipt.displayMonth("2569_12"), "ธันวาคม 2569")
})

test("a retryable failure offers a retry, an unretryable one offers a human", () => {
  const retryable = receipt.buildFailureBubble({
    monthKey: "2569_06", errorType: "month_mismatch", uploadLiffUrl: "https://liff.line.me/x",
  })
  assert.equal(retryable.contents.footer.contents[0].action.label, "ส่งไฟล์อีกครั้ง")

  const not = receipt.buildFailureBubble({
    monthKey: "2569_06", errorType: "not_in_roster", uploadLiffUrl: "https://liff.line.me/x",
  })
  assert.equal(not.contents.footer.contents[0].action.label, "ติดต่อผู้ดูแล")

  // No LIFF id configured yet (Phase 0 not run): degrade to the contact
  // button rather than shipping a button that goes nowhere.
  const noLiff = receipt.buildFailureBubble({ monthKey: "2569_06", errorType: "zero_score", uploadLiffUrl: "" })
  assert.equal(noLiff.contents.footer.contents[0].action.label, "ติดต่อผู้ดูแล")
})

test("the pending bubble carries the queue id the postback needs", () => {
  const bubble = receipt.buildPendingBubble({ monthKey: "2569_06", queueId: "3fae1c9e-0000-4000-8000-000000000000", ack: true })
  const action = bubble.contents.footer.contents[0].action
  assert.equal(action.type, "postback")
  assert.equal(action.data, "p4p_result=3fae1c9e-0000-4000-8000-000000000000")
})
