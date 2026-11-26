/**
 * ตรวจสอบ, ผู้จัดทำ side: the missing national ID alert and its form
 * (Pong, 2026-11-26). GET /national-ids lists who on the month's roster has
 * no valid number, with the last 4 digits of the month before's for the same
 * name; PUT fills them in, typed or copied (the copy is made on the server,
 * so the browser never gets a whole number), only for people with none,
 * never a number someone else has that month. History gets names and
 * counts, no digits.
 *
 * Every name and number here is made up: the numbers start with 0, which no
 * Thai ID does, and pass the check digit only because the test computes it.
 */
import { test, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const express = require("express")
const { mountReview } = require(resolve(repoRoot, "lib/review-server"))

const OWNER = "Uowner", AUDITEE = "Uauditee", AUDITOR = "Uauditor", OTHER = "Uother"
// 12 digits and the check digit.
const withCheck = (d12) => {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (13 - i)
  return d12 + String((11 - (sum % 11)) % 10)
}
const ID = (n) => withCheck("0" + String(n).padStart(11, "0"))
const uid = (n) => "9d0c0000-0000-4000-8000-" + String(n).padStart(12, "0")
const person = (n, first, last, department, national_id) =>
  ({ index: uid(n), prefix: "นพ.", firstname: first, lastname: last, department, national_id })

// The month (2569_10) and the month before (2569_09), as PostgREST gives them.
let tables = {}
let calls = []
let patchFail = null
const reset = () => {
  tables = {
    "2569_10": [
      person(1, "กิตติ", "ทดลอง", "ศัลยกรรม", ID(1)),
      person(2, "ชลธิชา", "สมมุติ", "กุมารเวชกรรม", null),
      person(3, "ธนกร", "ตัวอย่าง", "อายุรกรรม", "12345"),
      person(4, "นันทนา", "ใจสมมุติ", "จักษุวิทยา", ""),
      person(5, "ปกรณ์", "ทดสอบยิ่ง", "ศัลยกรรม", null),
    ],
    "2569_09": [
      person(11, "ชลธิชา", "สมมุติ", "กุมารเวชกรรม", ID(2)),
      // The same name twice the month before: not used.
      person(12, "นันทนา", "ใจสมมุติ", "จักษุวิทยา", ID(4)),
      person(13, "นันทนา", "ใจสมมุติ", "รังสีวิทยา", ID(5)),
      // Already someone else's this month: not offered.
      person(14, "ปกรณ์", "ทดสอบยิ่ง", "ศัลยกรรม", ID(1)),
    ],
  }
  calls = []
  patchFail = null
}
reset()
beforeEach(reset)

const pgFail = (data) => { const e = new Error("x"); e.response = { data }; return e }
const fakeAxios = {
  async get(url) {
    calls.push(["get", url])
    const m = /\/rest\/v1\/([0-9]{4}_[0-9]{2})\?select=index,prefix,firstname,lastname,department,national_id$/.exec(url)
    if (m) {
      const rows = tables[m[1]]
      if (rows === "missing") throw pgFail({ code: "42703", message: "column national_id does not exist" })
      return { data: rows || [] }
    }
    return { data: [] }
  },
  async patch(url, body, opts) {
    calls.push(["patch", url, body, opts.headers.Prefer])
    if (patchFail && url.includes(patchFail)) throw pgFail({ code: "XX000", message: "made-up failure" })
    const m = /\/rest\/v1\/([0-9]{4}_[0-9]{2})\?index=eq\.(.+)$/.exec(url)
    const row = m && Array.isArray(tables[m[1]]) ? tables[m[1]].find((r) => r.index === m[2]) : null
    if (row) row.national_id = body.national_id
    return { data: null }
  },
  async post() { return { data: null } },
  async delete() { return { data: null } },
}

const app = express()
mountReview({
  app, express, axios: fakeAxios,
  supabaseUrl: "https://db.example",
  serviceHeaders: () => ({ apikey: "k" }),
  async callServiceRpc() { return null },
  listRosterTables: async () => ["2569_10", "2569_09", "2569_11"],
  dashSession: (req) => (req.headers["x-who"] ? { sub: String(req.headers["x-who"]), name: "ปองสิทธิ์", exp: 1 } : null),
  isDashOwner: (sub) => sub === OWNER,
  isReviewAuditee: (sub) => sub === AUDITEE,
  isReviewAuditor: (sub) => sub === AUDITOR,
  audit: async (req, actor, action, target) => { calls.push(["audit", action, target, actor.name]) },
})
const server = app.listen(0)
const base = "http://127.0.0.1:" + server.address().port
after(() => server.close())
const call = (path, { who = AUDITEE, method = "GET", body } = {}) => fetch(base + "/dashboard/api/review/" + path, {
  method,
  headers: { ...(who ? { "x-who": who } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})
const put = (body, who) => call("2569_10/national-ids", { method: "PUT", body, who })

test("only the ผู้จัดทำ side (and the owner), only review months", async () => {
  assert.equal((await call("2569_10/national-ids", { who: null })).status, 401)
  assert.equal((await call("2569_10/national-ids", { who: AUDITOR })).status, 404)
  assert.equal((await call("2569_10/national-ids", { who: OTHER })).status, 404)
  assert.equal((await put({ ids: [{ index: uid(2), id: ID(9) }] }, AUDITOR)).status, 404)
  assert.equal((await call("2569_10/national-ids", { who: OWNER })).status, 200)
  assert.equal((await call("2569_10/national-ids")).status, 200)
  // Not a review month, or not a roster table.
  assert.equal((await call("2569_07/national-ids")).status, 404)
  assert.equal((await call("2569_12/national-ids")).status, 404)
  assert.ok(!calls.some((c) => c[0] === "patch"))
})

test("GET: who has none or a bad one, with the month before's last 4 digits only", async () => {
  const r = await call("2569_10/national-ids")
  assert.equal(r.headers.get("cache-control"), "no-store")
  const out = await r.json()
  assert.equal(out.column, true)
  assert.equal(out.total, 5)
  assert.equal(out.prevMonth, "2569_09")
  // By department, then name; the one with a valid number is left out.
  assert.deepEqual(out.missing, [
    { index: uid(2), name: "นพ.ชลธิชา สมมุติ", department: "กุมารเวชกรรม", bad: false, prev: ID(2).slice(-4) },
    { index: uid(4), name: "นพ.นันทนา ใจสมมุติ", department: "จักษุวิทยา", bad: false, prev: null },
    { index: uid(5), name: "นพ.ปกรณ์ ทดสอบยิ่ง", department: "ศัลยกรรม", bad: false, prev: null },
    { index: uid(3), name: "นพ.ธนกร ตัวอย่าง", department: "อายุรกรรม", bad: true, prev: null },
  ])
  // No whole number reaches the browser.
  const text = JSON.stringify(out)
  for (const n of [1, 2, 4, 5]) assert.ok(!text.includes(ID(n)), "no whole ID " + n)
})

test("GET: everyone filled, no column, no month before", async () => {
  tables["2569_10"] = [person(1, "กิตติ", "ทดลอง", "ศัลยกรรม", ID(1))]
  let out = await (await call("2569_10/national-ids")).json()
  assert.deepEqual(out, { column: true, total: 1, missing: [], prevMonth: null })
  // All filled: the month before is not even read.
  assert.ok(!calls.some((c) => c[1].includes("/2569_09?")))

  tables["2569_10"] = "missing"
  out = await (await call("2569_10/national-ids")).json()
  assert.deepEqual(out, { column: false, total: 0, missing: [], prevMonth: null })

  // 2569_11's month before is 2569_10, which has no column: no hints, still a list.
  tables["2569_11"] = [person(21, "ชลธิชา", "สมมุติ", "กุมารเวชกรรม", null)]
  out = await (await call("2569_11/national-ids")).json()
  assert.equal(out.missing.length, 1)
  assert.equal(out.missing[0].prev, null)
  assert.equal(out.prevMonth, null)
})

test("PUT: typed and copied numbers are saved, history has names and counts, no digits", async () => {
  const r = await put({ ids: [{ index: uid(3), id: "0-0000-00000-03-" + ID(3).slice(-1) }, { index: uid(4), id: ID(4) }], copy: [uid(2)] })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, saved: 3, skipped: 0 })
  const patches = calls.filter((c) => c[0] === "patch")
  assert.deepEqual(patches.map((c) => [c[1], c[2], c[3]]).sort(), [
    ["https://db.example/rest/v1/2569_10?index=eq." + uid(2), { national_id: ID(2) }, "return=minimal"],
    ["https://db.example/rest/v1/2569_10?index=eq." + uid(3), { national_id: ID(3) }, "return=minimal"],
    ["https://db.example/rest/v1/2569_10?index=eq." + uid(4), { national_id: ID(4) }, "return=minimal"],
  ])
  const audit = calls.find((c) => c[0] === "audit")
  assert.equal(audit[1], "review.ids")
  assert.equal(audit[3], "ปองสิทธิ์")
  assert.equal(audit[2].month, "2569_10")
  assert.equal(audit[2].typed, 2)
  assert.equal(audit[2].copied, 1)
  assert.deepEqual(audit[2].people.slice().sort(), ["นพ.ชลธิชา สมมุติ", "นพ.ธนกร ตัวอย่าง", "นพ.นันทนา ใจสมมุติ"].sort())
  assert.ok(!/[0-9]{6,}/.test(JSON.stringify(audit[2])), "no ID digits in History")
  // Now only ปกรณ์ is left.
  const out = await (await call("2569_10/national-ids")).json()
  assert.deepEqual(out.missing.map((x) => x.index), [uid(5)])
})

test("PUT: refused before anything is written", async () => {
  const no = async (body, status, re) => {
    const r = await put(body)
    assert.equal(r.status, status, JSON.stringify(body))
    if (re) assert.match((await r.json()).error, re)
  }
  await no({}, 400, /ยังไม่ได้กรอก/)
  await no({ ids: [], copy: [] }, 400)
  await no({ ids: Array.from({ length: 1001 }, (_, i) => ({ index: uid(i), id: ID(i) })) }, 400, /1,000/)
  // Not on the month's roster, or not an index at all.
  await no({ ids: [{ index: uid(99), id: ID(9) }] }, 404)
  await no({ ids: [{ index: "1 or 1=1", id: ID(9) }] }, 404)
  await no({ copy: [uid(99)] }, 404)
  // Not 13 digits, or a wrong check digit.
  await no({ ids: [{ index: uid(2), id: "12345" }] }, 400, /ชลธิชา.*13 หลัก/)
  const wrong = ID(9).slice(0, 12) + String((Number(ID(9)[12]) + 1) % 10)
  await no({ ids: [{ index: uid(2), id: wrong }] }, 400, /13 หลัก/)
  // Someone else's this month, or the same one typed for two people.
  await no({ ids: [{ index: uid(2), id: ID(1) }] }, 409, /ชลธิชา.*ซ้ำกับ.*กิตติ/)
  await no({ ids: [{ index: uid(2), id: ID(9) }, { index: uid(3), id: ID(9) }] }, 409, /ธนกร.*ซ้ำกับ.*ชลธิชา/)
  // No usable number the month before (twice there, or someone else's now).
  await no({ copy: [uid(4)] }, 409, /นันทนา.*กรอกเอง/)
  await no({ copy: [uid(5)] }, 409, /ซ้ำกับ.*กิตติ/)
  // A typed one and a bad copy in the same save: nothing written.
  await no({ ids: [{ index: uid(3), id: ID(3) }], copy: [uid(4)] }, 409)
  assert.ok(!calls.some((c) => c[0] === "patch" || c[0] === "audit"))
  // A roster without the column.
  tables["2569_10"] = "missing"
  await no({ ids: [{ index: uid(2), id: ID(9) }] }, 409, /ยังไม่มีช่อง/)
})

test("PUT: someone with a valid number is left as it is; typed beats copied", async () => {
  const r = await put({ ids: [{ index: uid(1), id: ID(8) }, { index: uid(2), id: ID(7) }], copy: [uid(1), uid(2)] })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, saved: 1, skipped: 1 })
  const patches = calls.filter((c) => c[0] === "patch")
  assert.deepEqual(patches.map((c) => [c[1].split("eq.")[1], c[2].national_id]), [[uid(2), ID(7)]])
  assert.equal(tables["2569_10"][0].national_id, ID(1))
  const audit = calls.find((c) => c[0] === "audit")
  assert.deepEqual([audit[2].typed, audit[2].copied], [1, 0])
  // Only people who already have one: nothing written, no History line.
  calls = []
  const r2 = await put({ ids: [{ index: uid(1), id: ID(8) }] })
  assert.deepEqual(await r2.json(), { ok: true, saved: 0, skipped: 1 })
  assert.ok(!calls.some((c) => c[0] === "patch" || c[0] === "audit"))
})

test("PUT: a write that fails says how many were saved, and History has those", async () => {
  patchFail = "eq." + uid(4)
  const r = await put({ ids: [{ index: uid(3), id: ID(3) }, { index: uid(4), id: ID(4) }] })
  assert.equal(r.status, 500)
  const out = await r.json()
  assert.match(out.error, /บันทึกได้ 1 จาก 2 คน/)
  assert.equal(out.saved, 1)
  const audit = calls.find((c) => c[0] === "audit")
  assert.deepEqual(audit[2].people, ["นพ.ธนกร ตัวอย่าง"])
})
