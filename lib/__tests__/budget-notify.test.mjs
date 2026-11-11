/**
 * process/budget-notify.ts: the Telegram Pong gets once workflow 2.2 has
 * built a month's SK03 with the budget and N saved on the overview page.
 * Sent once per save (tg_pending), only when the build used the numbers
 * saved now, never throwing.
 */
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const bn = require(resolve(repoRoot, "process/budget-notify"))

// review_inputs as PostgREST returns it: numeric columns come back as strings.
const fakeSupabase = (row, { readError = null, clearError = null } = {}) => {
  const log = { updates: [] }
  const from = (table) => {
    assert.equal(table, "review_inputs")
    const filters = []
    const q = {
      select() { return q },
      eq(k, v) { filters.push([k, v]); return q },
      async maybeSingle() { return readError ? { data: null, error: readError } : { data: row, error: null } },
      update(patch) {
        const u = { patch, filters: [] }
        log.updates.push(u)
        const w = {
          eq(k, v) { u.filters.push([k, v]); return w },
          then(ok, bad) { return Promise.resolve({ error: clearError }).then(ok, bad) },
        }
        return w
      },
    }
    return q
  }
  return { client: { from }, log }
}

let sent = []
let reply = { ok: true }
const realFetch = globalThis.fetch
beforeEach(() => {
  sent = []
  reply = { ok: true }
  process.env.TELEGRAM_BOT_TOKEN = "t0ken"
  process.env.TELEGRAM_CHAT_ID = "-100"
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) })
    return { status: reply.ok ? 200 : 400, json: async () => reply }
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
})

test("the message: Thai month, budget, N, per P4P and the SK03 link", () => {
  assert.equal(bn.monthName("2569_09"), "กันยายน 2569")
  assert.equal(bn.monthName("2568_12"), "ธันวาคม 2568")
  assert.equal(bn.monthName("2569_13"), "2569_13")
  assert.equal(bn.formatBudgetBuilt("2569_09", { budget: 2210764, per_p4p: 9570.41, doctors: 231 }, "abc123"),
    "✅ SK03 กันยายน 2569 สร้างเสร็จแล้ว\nงบ 2,210,764 · N 231 · per P4P 9,570.41\nhttps://docs.google.com/spreadsheets/d/abc123")
  // An older month saved with satang, and one with no N.
  assert.match(bn.formatBudgetBuilt("2569_07", { budget: 2158709.06, per_p4p: 9551.81, doctors: null }, "x"),
    /งบ 2,158,709\.06 · N – · per P4P 9,551\.81/)
})

test("a save waiting for this build: sent once, then cleared", async () => {
  const { client, log } = fakeSupabase({ budget: "2210764.00", per_p4p: "9570.41", doctors: 231, tg_pending: true })
  assert.equal(await bn.notifyBudgetBuilt(client, "2569_09", { budget: 2210764, per_p4p: 9570.41 }, "ss1"), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, "https://api.telegram.org/bott0ken/sendMessage")
  assert.equal(sent[0].body.chat_id, "-100")
  assert.equal(sent[0].body.parse_mode, undefined)
  assert.match(sent[0].body.text, /^✅ SK03 กันยายน 2569/)
  // Cleared only for the numbers it reported (a newer save stays pending).
  assert.deepEqual(log.updates, [{ patch: { tg_pending: false },
    filters: [["month", "2569_09"], ["budget", "2210764.00"], ["per_p4p", "9570.41"]] }])
})

test("nothing to say: not pending, saved again since, no budget used, no row", async () => {
  let f = fakeSupabase({ budget: "2210764", per_p4p: "9570.41", doctors: 231, tg_pending: false })
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 2210764, per_p4p: 9570.41 }, "ss1"), false)
  // This build read other numbers: the build the new save queued reports.
  f = fakeSupabase({ budget: "2300000", per_p4p: "9956.71", doctors: 231, tg_pending: true })
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 2210764, per_p4p: 9570.41 }, "ss1"), false)
  assert.equal(f.log.updates.length, 0)
  f = fakeSupabase(null)
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 1, per_p4p: 1 }, "ss1"), false)
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", null, "ss1"), false)
  assert.equal(sent.length, 0)
})

test("never throws, and stays pending when the message did not go", async () => {
  // PART 2 not run: no tg_pending column.
  let f = fakeSupabase(null, { readError: { code: "42703", message: "column review_inputs.tg_pending does not exist" } })
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 1, per_p4p: 1 }, "ss1"), false)
  const row = { budget: "100", per_p4p: "10", doctors: 10, tg_pending: true }
  reply = { ok: false, description: "Bad Request: chat not found" }
  f = fakeSupabase(row)
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 100, per_p4p: 10 }, "ss1"), false)
  assert.equal(f.log.updates.length, 0)
  globalThis.fetch = async () => { throw new Error("network down") }
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 100, per_p4p: 10 }, "ss1"), false)
  delete process.env.TELEGRAM_BOT_TOKEN
  assert.equal(await bn.notifyBudgetBuilt(f.client, "2569_09", { budget: 100, per_p4p: 10 }, "ss1"), false)
  assert.equal(f.log.updates.length, 0)
})
