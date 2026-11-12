/**
 * lib/review-server.ts with its helpers faked: only the owner gets in, the
 * months start at ส.ค. 69 and must be roster tables, the overview's budget
 * box checks budget and N (per P4P = budget ÷ N and the build come from the
 * SQL), a score edit is logged as a roster edit, and the SQL
 * functions' refusals come back in Thai. A missing or older install is
 * { installed: false } on the two loads and a 503 everywhere else.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const express = require("express")
const { mountReview } = require(resolve(repoRoot, "lib/review-server"))

const OWNER = "Uowner", OTHER = "Uother", AUDITEE = "Uauditee"
const calls = []
let rpcs = []
const fresh = () => ({ v: 2, rounds: [], live: null, inputs: null })
let state = fresh()
let submitError = null
const rpcErrors = {}
let pdfRound = null
let scoreOut = null

let getError = null
let emailRows = []
const PGRST202 = (fn) => ({ code: "PGRST202", message: "Could not find the function public." + fn + " without parameters in the schema cache" })
const OUTAGE = { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }
const budgets = {}
const completeMonths = new Set(["2569_10"])
const pgFail = (data) => { const e = new Error("x"); e.response = { data }; return e }

const fakeAxios = {
  async post(url, body) {
    calls.push(["post", url, body])
    if (url.includes("/object/sign/")) return { data: { signedURL: "/object/sign/review-files/x?token=t" } }
    return { data: null }
  },
  async get(url) {
    calls.push(["get", url])
    if (getError && url.includes(getError.at)) throw pgFail(getError.data)
    if (url.includes("review_rounds?select=round_no,pdf_status,pdf_path")) return { data: pdfRound ? [pdfRound] : [] }
    if (url.includes("review_build_people?select=name")) return { data: [{ name: "นพ. ทดสอบ" }] }
    if (url.includes("review_emails?select=")) return { data: emailRows }
    return { data: [] }
  },
  async delete(url, opts) { calls.push(["delete", url, opts.data]); return { data: null } },
  async patch(url, body) { calls.push(["patch", url, body]); return { data: null } },
}

const app = express()
mountReview({
  app, express, axios: fakeAxios,
  supabaseUrl: "https://db.example",
  serviceHeaders: () => ({ apikey: "k" }),
  async callServiceRpc(fn, args) {
    rpcs.push([fn, args])
    // A string is a refusal raised by the SQL function; an object is PostgREST's whole answer.
    if (rpcErrors[fn]) throw pgFail(typeof rpcErrors[fn] === "string" ? { code: "P0001", message: rpcErrors[fn] } : rpcErrors[fn])
    if (fn === "review_state") return state
    if (fn === "review_months") return [{ month: "2569_10" }]
    if (fn === "review_request_build") return { id: 9, status: "queued" }
    // As budget_save does it: per P4P = round(budget ÷ N, 2), the row
    // before the save, and a build queued only when the roster is complete.
    if (fn === "budget_save") {
      const was = budgets[args.p_month]
      const per = Math.round(Math.round(args.p_budget * 100) / args.p_doctors) / 100
      const after = { month: args.p_month, budget: args.p_budget, per_p4p: per, doctors: args.p_doctors,
        updated_at: "2026-11-11T16:30:00+00:00", updated_by: args.p_actor, tg_pending: true }
      budgets[args.p_month] = after
      const complete = completeMonths.has(args.p_month)
      return { before: was ?? null, after, complete, request: complete ? { id: 9, month: args.p_month, status: "queued" } : null }
    }
    if (fn === "review_edit_score") return scoreOut
    if (fn === "review_auditee_people") return { build_id: "b2", people: [] }
    if (fn === "review_people") return { round: { round_no: args.p_round || 1 }, people: [] }
    if (fn === "review_add_issue") return { id: 4 }
    if (fn === "review_reopen_round") return { round_no: 2, old_pdf: "pdf/2569_10/round-2-1.pdf" }
    if (fn === "review_retry_pdf") return { round_no: 2 }
    if (fn === "review_email_queue") return { id: 5, round_no: 1, status: "queued" }
    if (fn === "review_approve_all") return 205
    if (fn === "review_return_round" || fn === "review_approve_round" || fn === "review_unreturn_round") return { round_no: 1 }
    if (fn === "review_submit_round") {
      if (submitError) { const e = new Error("x"); e.response = { data: { code: "P0001", message: submitError } }; throw e }
      return { round_no: 1 }
    }
    return null
  },
  listRosterTables: async () => ["2569_10", "2569_07", "2569_09", "management_stipends"],
  dashSession: (req) => (req.headers["x-who"] ? { sub: String(req.headers["x-who"]), name: "Pong", exp: 1 } : null),
  isDashOwner: (sub) => sub === OWNER,
  isReviewAuditee: (sub) => sub === AUDITEE,
  audit: async (req, actor, action, target) => { calls.push(["audit", action, target]) },
})
const server = app.listen(0)
const base = "http://127.0.0.1:" + server.address().port
after(() => server.close())
const call = (path, { who = OWNER, method = "GET", body } = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(who ? { "x-who": who } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
})

test("owner only, months from ส.ค. 69 in time order", async () => {
  assert.equal((await call("/dashboard/api/review/months", { who: null })).status, 401)
  assert.equal((await call("/dashboard/api/review/months", { who: OTHER })).status, 404)
  const r = await (await call("/dashboard/api/review/months")).json()
  assert.deepEqual(rpcs.at(-1), ["review_months", { p_months: ["2569_09", "2569_10"] }])
  assert.equal(r.installed, true)
  assert.equal((await call("/dashboard/api/review/2569_11")).status, 404)
  // A roster table before ส.ค. 69 is not a review month.
  assert.equal((await call("/dashboard/api/review/2569_07")).status, 404)
  const st = await call("/dashboard/api/review/2569_10")
  assert.equal(st.status, 200)
  assert.equal((await st.json()).installed, true)
  // Only the first SQL file run: review_state has no v 2 yet.
  state = { rounds: [], live: null, inputs: null }
  assert.deepEqual(await (await call("/dashboard/api/review/2569_10")).json(), { installed: false })
  state = fresh()
})

test("budget box: owner only, checked, per P4P from the SQL, a build when the roster is complete", async () => {
  const put = (month, body, who) => call("/dashboard/api/budget/" + month, { method: "PUT", body, who })
  assert.equal((await put("2569_10", { budget: "1", doctors: "1" }, null)).status, 401)
  assert.equal((await put("2569_10", { budget: "1", doctors: "1" }, OTHER)).status, 404)
  for (const month of ["2569_13", "abc", "2569_1"]) assert.equal((await put(month, { budget: "1", doctors: "1" })).status, 404, month)
  let r
  // Whole baht (Pong, 2026-11-10): decimals are refused, not rounded.
  for (const budget of ["abc", "2,158,709.06", "2158709.5", "0", ""]) {
    r = await put("2569_10", { budget, doctors: "226" })
    assert.equal(r.status, 400, budget)
    assert.equal((await r.json()).field, "budget")
  }
  for (const doctors of ["0", "2.5", "abc", "", "-3"]) {
    r = await put("2569_10", { budget: "100", doctors })
    assert.equal(r.status, 400, doctors)
    assert.equal((await r.json()).field, "doctors")
  }
  assert.ok(!rpcs.some((x) => x[0] === "budget_save"))

  // Everyone has sent: saved, and a build of the month is queued.
  rpcs = []
  r = await put("2569_10", { budget: "2,158,709", doctors: "226" })
  assert.equal(r.status, 200)
  let out = await r.json()
  assert.deepEqual(out.budget, { budget: 2158709, per_p4p: 9551.81, doctors: 226, updated_at: "2026-11-11T16:30:00+00:00", updated_by: "Pong" })
  assert.equal(out.complete, true)
  assert.equal(out.request.status, "queued")
  assert.deepEqual(rpcs, [["budget_save", { p_month: "2569_10", p_budget: 2158709, p_doctors: 226, p_actor: "Pong" }]])
  let logged = calls.filter((c) => c[0] === "audit" && c[1] === "budget.save").at(-1)
  assert.deepEqual(logged[2], { month: "2569_10", budget: 2158709, doctors: 226, per_p4p: 9551.81, before: null, build: true })
  // Saved again: the row before is in History. Not tied to the ตรวจสอบ
  // rounds: no review_state read, whatever the round's state.
  state = { ...fresh(), rounds: [{ round_no: 1, status: "submitted" }], live: 1 }
  r = await put("2569_10", { budget: "2189874", doctors: "229" })
  assert.equal(r.status, 200)
  logged = calls.filter((c) => c[0] === "audit" && c[1] === "budget.save").at(-1)
  assert.deepEqual(logged[2].before, { budget: 2158709, per_p4p: 9551.81, doctors: 226 })
  assert.equal(logged[2].per_p4p, 9562.77)
  assert.ok(!rpcs.some((x) => x[0] === "review_state"))
  state = fresh()

  // Any month, also one before the ตรวจสอบ tab's and one with no roster
  // table yet; not complete, so no build (the next one picks it up).
  for (const month of ["2569_05", "2569_11"]) {
    r = await put(month, { budget: "2139791", doctors: "216" })
    assert.equal(r.status, 200, month)
    out = await r.json()
    assert.equal(out.complete, false)
    assert.equal(out.request, null)
    assert.equal(calls.filter((c) => c[0] === "audit" && c[1] === "budget.save").at(-1)[2].build, false)
  }

  // The SQL's own refusal, in Thai.
  rpcErrors.budget_save = "budget: per P4P out of range"
  r = await put("2569_10", { budget: "1", doctors: "3" })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /per P4P/)
  // PART 2 not run yet: says which file, and nothing is logged.
  const before = calls.length
  rpcErrors.budget_save = PGRST202("budget_save")
  r = await put("2569_10", { budget: "100", doctors: "10" })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /budget-inputs-2026-11\.sql/)
  rpcErrors.budget_save = OUTAGE
  r = await put("2569_10", { budget: "100", doctors: "10" })
  assert.equal(r.status, 500)
  assert.ok(!calls.slice(before).some((c) => c[0] === "audit"))
  delete rpcErrors.budget_save

  // The ตรวจสอบ tab no longer saves them.
  assert.equal((await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "1", doctors: "1" } })).status, 404)
})

test("no download or upload routes any more: the files are in Drive", async () => {
  assert.equal((await call("/dashboard/api/review/2569_10/file/b2222222-2222-4222-8222-222222222222/sk03")).status, 404)
  assert.equal((await call("/dashboard/api/review/2569_10/uploads", { method: "POST", body: { kind: "sk03", fileName: "SK03.xlsx", bytes: 1 } })).status, 404)
})

test("score edit: checked, written by the SQL, logged with the รายชื่อ tab's edits", async () => {
  const path = "/dashboard/api/review/2569_10/scores/"
  const IDX2 = "d4444444-4444-4444-8444-444444444444"
  assert.equal((await call(path + "not-a-uuid", { method: "PUT", body: { score: "2400" } })).status, 404)
  for (const score of ["abc", "2480.123", "-1", "", "1000000"]) {
    const r = await call(path + IDX2, { method: "PUT", body: { score } })
    assert.equal(r.status, 400, score)
  }
  assert.equal((await call(path + IDX2, { method: "PUT", body: { score: "2400", note: "x".repeat(501) } })).status, 400)
  scoreOut = { changed: true, edit: { name: "นพ. ทดสอบ หนึ่ง", old_score: 2310, new_score: 2480 }, request: { id: 10, status: "queued", reason: "score" } }
  rpcs = []
  let r = await call(path + IDX2, { method: "PUT", body: { score: "2,480.00", note: " บันทึกผิด " } })
  assert.equal(r.status, 200)
  const out = await r.json()
  assert.equal(out.changed, true)
  assert.equal(out.request.reason, "score")
  assert.deepEqual(rpcs.at(-1), ["review_edit_score", { p_month: "2569_10", p_index: IDX2, p_score: 2480, p_note: "บันทึกผิด", p_actor: "Pong" }])
  const logged = calls.filter((c) => c[0] === "audit" && c[1] === "roster.edit").at(-1)
  assert.deepEqual(logged[2], { month: "2569_10", index: IDX2, physician: "นพ. ทดสอบ หนึ่ง", via: "review", changes: { score: [2310, 2480] }, note: "บันทึกผิด" })
  // The same score again: nothing logged.
  const n = calls.filter((c) => c[0] === "audit" && c[1] === "roster.edit").length
  scoreOut = { changed: false, edit: null, request: null }
  r = await call(path + IDX2, { method: "PUT", body: { score: "2480" } })
  assert.deepEqual(await r.json(), { ok: true, changed: false, edit: null, request: null })
  assert.equal(calls.filter((c) => c[0] === "audit" && c[1] === "roster.edit").length, n)
  for (const [msg, status] of [["review: not the auditee's turn", 409], ["review: not on the roster", 404]]) {
    rpcErrors.review_edit_score = msg
    assert.equal((await call(path + IDX2, { method: "PUT", body: { score: "2480" } })).status, status, msg)
  }
  delete rpcErrors.review_edit_score
  scoreOut = null
})

test("list: everyone in the newest build", async () => {
  rpcs = []
  const r = await call("/dashboard/api/review/2569_10/list")
  assert.deepEqual(await r.json(), { build_id: "b2", people: [] })
  assert.deepEqual(rpcs.at(-1), ["review_auditee_people", { p_month: "2569_10" }])
})

test("send: no files to pick, the SQL checks, its refusals in Thai", async () => {
  rpcs = []
  let r = await call("/dashboard/api/review/2569_10/rounds", { method: "POST" })
  assert.equal(r.status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_submit_round", { p_month: "2569_10", p_actor: "Pong" }])
  for (const [msg, re] of [["review: a score is out of range", /คะแนนผิดปกติ/], ["review: the build is out of date", /กดสร้างใหม่/],
    ["review: a build is on its way", /รอสร้างไฟล์ใหม่/], ["review: no budget yet", /งบประมาณและจำนวนแพทย์/]]) {
    submitError = msg
    r = await call("/dashboard/api/review/2569_10/rounds", { method: "POST" })
    assert.equal(r.status, 409, msg)
    assert.match((await r.json()).error, re)
  }
  submitError = null
})

test("email to the auditor: the state carries the month's emails, ส่งอีเมล goes through the SQL", async () => {
  emailRows = [{ id: 3, round_id: 7, round_no: 1, status: "sent", test: false, attempts: 1, fix_no: 0, sent_at: "2026-11-12T05:00:00Z", error: "", created_at: "2026-11-12T04:59:00Z" }]
  let r = await call("/dashboard/api/review/2569_10")
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).emails, emailRows)
  const get = calls.filter((c) => c[0] === "get" && c[1].includes("review_emails?")).at(-1)
  assert.match(get[1], /month=eq\.2569_10&order=id\.desc/)
  // The email SQL not run yet, or a failed read: emails null, the month still loads.
  for (const data of [{ code: "PGRST205", message: "Could not find the table 'public.review_emails' in the schema cache" }, OUTAGE]) {
    getError = { at: "review_emails?", data }
    r = await call("/dashboard/api/review/2569_10")
    assert.equal(r.status, 200)
    const st = await r.json()
    assert.equal(st.installed, true)
    assert.equal(st.emails, null)
  }
  getError = null
  emailRows = []

  rpcs = []
  r = await call("/dashboard/api/review/2569_10/email", { method: "POST" })
  assert.equal(r.status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_email_queue", { p_month: "2569_10", p_actor: "Pong" }])
  assert.deepEqual(calls.filter((c) => c[0] === "audit").at(-1), ["audit", "review.email", { month: "2569_10", round: 1 }])
  for (const [msg, re] of [["review: already emailed", /ไปแล้ว/], ["review: an email is on its way", /กำลังจะส่ง/],
    ["review: no round to email", /ยังไม่มีรอบ/]]) {
    rpcErrors.review_email_queue = msg
    r = await call("/dashboard/api/review/2569_10/email", { method: "POST" })
    assert.equal(r.status, 409, msg)
    assert.match((await r.json()).error, re)
  }
  rpcErrors.review_email_queue = PGRST202("review_email_queue")
  r = await call("/dashboard/api/review/2569_10/email", { method: "POST" })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /review-email-2026-11\.sql/)
  delete rpcErrors.review_email_queue
  assert.equal((await call("/dashboard/api/review/2569_10/email", { method: "POST", who: OTHER })).status, 404)
})

test("อนุมัติทุกคนที่รอตรวจ: the round on screen, the SQL checks, one History line", async () => {
  rpcs = []
  for (const body of [undefined, {}, { round: "1" }, { round: 0 }, { round: 1.5 }, { round: 10000 }]) {
    const r = await call("/dashboard/api/review/2569_10/approve-all", { method: "POST", body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal(rpcs.length, 0)
  let r = await call("/dashboard/api/review/2569_10/approve-all", { method: "POST", body: { round: 2 } })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, approved: 205 })
  assert.deepEqual(rpcs.at(-1), ["review_approve_all", { p_month: "2569_10", p_round: 2, p_actor: "Pong" }])
  assert.deepEqual(calls.filter((c) => c[0] === "audit").at(-1), ["audit", "review.approve_all", { month: "2569_10", round: 2, count: 205 }])
  for (const [msg, re] of [["review: a check is not a match", /ไม่ตรงกันหรือไม่พบ/], ["review: another round", /เปลี่ยนแล้ว/],
    ["review: nobody to approve", /ไม่มีคนที่รอตรวจ/], ["review: not the auditor's turn", /ยังไม่ใช่คิวผู้ตรวจสอบ/]]) {
    rpcErrors.review_approve_all = msg
    r = await call("/dashboard/api/review/2569_10/approve-all", { method: "POST", body: { round: 2 } })
    assert.equal(r.status, 409, msg)
    assert.match((await r.json()).error, re)
  }
  rpcErrors.review_approve_all = PGRST202("review_approve_all")
  r = await call("/dashboard/api/review/2569_10/approve-all", { method: "POST", body: { round: 2 } })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /review-approve-all-2026-11\.sql/)
  delete rpcErrors.review_approve_all
  assert.equal((await call("/dashboard/api/review/2569_10/approve-all", { method: "POST", body: { round: 2 }, who: OTHER })).status, 404)
})

const IDX = "c3333333-3333-4333-8333-333333333333"
const audits = () => calls.filter((c) => c[0] === "audit").map((c) => c[1])

test("auditor: approve or fix with a remark, each logged", async () => {
  const at = "/dashboard/api/review/2569_10/decisions/" + IDX
  assert.equal((await call(at, { method: "PUT", body: { decision: "maybe" } })).status, 400)
  assert.equal((await call("/dashboard/api/review/2569_10/decisions/not-a-uuid", { method: "PUT", body: { decision: "approve" } })).status, 400)
  assert.equal((await call(at, { method: "PUT", body: { decision: "fix", remark: "  " } })).status, 400)
  assert.equal((await call(at, { method: "PUT", body: { decision: "fix", remark: "x".repeat(1001) } })).status, 400)
  rpcs = []
  assert.equal((await call(at, { method: "PUT", body: { decision: "approve", remark: "ignored" } })).status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_decide", { p_month: "2569_10", p_index: IDX, p_decision: "approve", p_remark: "", p_actor: "Pong" }])
  assert.equal((await call(at, { method: "PUT", body: { decision: "fix", remark: " คะแนนไม่ตรง " } })).status, 200)
  assert.equal(rpcs.at(-1)[1].p_remark, "คะแนนไม่ตรง")
  assert.equal((await call(at, { method: "PUT", body: { decision: null } })).status, 200)
  assert.equal(rpcs.at(-1)[1].p_decision, null)
  assert.equal(audits().filter((a) => a === "review.decide").length, 3)
  // The database decides whose turn it is.
  rpcErrors.review_decide = "review: not the auditor's turn"
  const r = await call(at, { method: "PUT", body: { decision: "approve" } })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /ยังไม่ใช่คิวผู้ตรวจสอบ/)
  delete rpcErrors.review_decide
})

test("auditor: return, approve and take back go through the SQL checks", async () => {
  rpcs = []
  assert.equal((await call("/dashboard/api/review/2569_10/return", { method: "POST" })).status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_return_round", { p_month: "2569_10", p_actor: "Pong" }])
  rpcErrors.review_approve_round = "review: not everyone is approved"
  let r = await call("/dashboard/api/review/2569_10/approve", { method: "POST" })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /ยังอนุมัติไม่ครบ/)
  delete rpcErrors.review_approve_round
  rpcErrors.review_unreturn_round = "review: the auditee has started"
  r = await call("/dashboard/api/review/2569_10/unreturn", { method: "POST" })
  assert.equal(r.status, 409)
  delete rpcErrors.review_unreturn_round
  assert.equal((await call("/dashboard/api/review/2569_10/approve", { method: "POST" })).status, 200)
  assert.ok(audits().includes("review.return") && audits().includes("review.approve"))
  assert.equal((await call("/dashboard/api/review/2569_10/return", { method: "POST", who: OTHER })).status, 404)
})

test("people, person and opened: inputs checked before the database", async () => {
  rpcs = []
  await call("/dashboard/api/review/2569_10/people?round=2")
  assert.deepEqual(rpcs.at(-1), ["review_people", { p_month: "2569_10", p_round: 2 }])
  await call("/dashboard/api/review/2569_10/people?round=x")
  assert.deepEqual(rpcs.at(-1), ["review_people", { p_month: "2569_10", p_round: null }])
  assert.equal((await call("/dashboard/api/review/2569_10/person/0/" + IDX)).status, 404)
  assert.equal((await call("/dashboard/api/review/2569_10/person/1/abc")).status, 404)
  assert.equal((await call("/dashboard/api/review/2569_10/opened", { method: "POST", body: { role: "boss" } })).status, 400)
  assert.equal((await call("/dashboard/api/review/2569_10/opened", { method: "POST", body: { role: "auditee" } })).status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_mark_opened", { p_month: "2569_10", p_role: "auditee" }])
})

test("problems list: add, reply as either side, close", async () => {
  assert.equal((await call("/dashboard/api/review/2569_10/issues", { method: "POST", body: { body: "" } })).status, 400)
  assert.equal((await call("/dashboard/api/review/2569_10/issues", { method: "POST", body: { body: "x", index: "nope" } })).status, 400)
  rpcs = []
  let r = await call("/dashboard/api/review/2569_10/issues", { method: "POST", body: { body: "ชีตยังไม่มีลายเซ็น" } })
  assert.equal((await r.json()).issue.id, 4)
  assert.deepEqual(rpcs.at(-1), ["review_add_issue", { p_month: "2569_10", p_index: null, p_body: "ชีตยังไม่มีลายเซ็น", p_actor: "Pong" }])
  assert.equal((await call("/dashboard/api/review/2569_10/issues/4/replies", { method: "POST", body: { role: "boss", body: "x" } })).status, 400)
  assert.equal((await call("/dashboard/api/review/2569_10/issues/4/replies", { method: "POST", body: { role: "auditee", body: "เซ็นแล้ว" } })).status, 200)
  assert.deepEqual(rpcs.at(-1)[1], { p_month: "2569_10", p_issue: 4, p_role: "auditee", p_body: "เซ็นแล้ว", p_actor: "Pong" })
  assert.equal((await call("/dashboard/api/review/2569_10/issues/x/status", { method: "POST", body: { open: false } })).status, 404)
  assert.equal((await call("/dashboard/api/review/2569_10/issues/4/status", { method: "POST", body: { open: false } })).status, 200)
  assert.equal(rpcs.at(-1)[1].p_open, false)
  assert.ok(audits().includes("review.issue_close"))
})

test("approval PDF: download only when ready, retry, reopen with a reason", async () => {
  pdfRound = { round_no: 2, pdf_status: "building", pdf_path: null }
  assert.equal((await call("/dashboard/api/review/2569_10/pdf")).status, 404)
  pdfRound = { round_no: 2, pdf_status: "ready", pdf_path: "pdf/2569_10/round-2-1.pdf" }
  let r = await call("/dashboard/api/review/2569_10/pdf")
  assert.equal(r.status, 302)
  // Opens in the browser's viewer; ?download=1 saves it under its name.
  assert.equal(r.headers.get("location"), "https://db.example/storage/v1/object/sign/review-files/x?token=t")
  r = await call("/dashboard/api/review/2569_10/pdf?download=1")
  assert.match(r.headers.get("location"), /download=P4P_2569_10_approved\.pdf$/)
  assert.ok(calls.some((c) => c[0] === "post" && c[1].endsWith("/object/sign/review-files/pdf/2569_10/round-2-1.pdf")))
  assert.ok(calls.some((c) => c[0] === "audit" && c[1] === "review.download" && c[2].kind === "pdf"))

  rpcs = []
  assert.equal((await call("/dashboard/api/review/2569_10/pdf/retry", { method: "POST" })).status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_retry_pdf", { p_month: "2569_10", p_actor: "Pong" }])
  rpcErrors.review_retry_pdf = "review: the document has not failed"
  assert.equal((await call("/dashboard/api/review/2569_10/pdf/retry", { method: "POST" })).status, 409)
  delete rpcErrors.review_retry_pdf

  assert.equal((await call("/dashboard/api/review/2569_10/reopen", { method: "POST", body: { reason: "   " } })).status, 400)
  r = await call("/dashboard/api/review/2569_10/reopen", { method: "POST", body: { reason: " งบประมาณผิด " } })
  assert.equal(r.status, 200)
  assert.deepEqual(rpcs.at(-1), ["review_reopen_round", { p_month: "2569_10", p_reason: "งบประมาณผิด", p_actor: "Pong" }])
  const del = calls.find((c) => c[0] === "delete")
  assert.equal(del[1], "https://db.example/storage/v1/object/review-files")
  assert.deepEqual(del[2], { prefixes: ["pdf/2569_10/round-2-1.pdf"] })
  const a = calls.filter((c) => c[0] === "audit" && c[1] === "review.reopen").at(-1)
  assert.deepEqual(a[2], { month: "2569_10", round: 2, reason: "งบประมาณผิด" })
  assert.equal((await call("/dashboard/api/review/2569_10/reopen", { method: "POST", who: OTHER, body: { reason: "x" } })).status, 404)
})

test("History gets the person's name with each decision", async () => {
  await call("/dashboard/api/review/2569_10/decisions/" + IDX, { method: "PUT", body: { decision: "approve" } })
  const a = calls.filter((c) => c[0] === "audit" && c[1] === "review.decide").at(-1)
  assert.equal(a[2].physician, "นพ. ทดสอบ")
})


test("not set up: the two loads say so, every other route fails", async () => {
  rpcErrors.review_months = PGRST202("review_months")
  let r = await call("/dashboard/api/review/months")
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { installed: false })
  delete rpcErrors.review_months
  for (const missing of [PGRST202("review_state"), { code: "42703", message: "column r.pdf_status does not exist" },
    { message: 'relation "public.review_builds" does not exist' }]) {
    rpcErrors.review_state = missing
    r = await call("/dashboard/api/review/2569_10")
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { installed: false })
  }
  delete rpcErrors.review_state

  // The browser only checks r.ok: a 200 here would read as done.
  const before = calls.length
  const routes = [
    ["review_reopen_round", "/reopen", "POST", { reason: "งบประมาณผิด" }],
    ["review_retry_pdf", "/pdf/retry", "POST"],
    ["review_decide", "/decisions/" + IDX, "PUT", { decision: "approve" }],
    ["review_approve_round", "/approve", "POST"],
    ["review_people", "/people?round=1", "GET"],
    ["review_person", "/person/1/" + IDX, "GET"],
    ["review_issue_list", "/issues", "GET"],
    ["review_edit_score", "/scores/" + IDX, "PUT", { score: "2400" }],
    ["review_auditee_people", "/list", "GET"],
    ["review_submit_round", "/rounds", "POST"],
  ]
  for (const [fn, path, method, body] of routes) {
    rpcErrors[fn] = PGRST202(fn)
    r = await call("/dashboard/api/review/2569_10" + path, { method, body })
    assert.equal(r.status, 503, path)
    const out = await r.json()
    assert.equal(out.installed, false)
    assert.match(out.error, /ยังไม่ได้ติดตั้ง.*review-tab-2026-11\.sql.*review-tab-2026-11-auditee\.sql/)
    delete rpcErrors[fn]
  }
  // Nothing was done or logged as done.
  assert.ok(!calls.slice(before).some((c) => c[0] === "delete" || c[0] === "audit"))
  // Part 3 not run: review_rounds has no pdf columns yet.
  getError = { at: "review_rounds?select=round_no,pdf_status", data: { code: "42703", message: "column review_rounds.pdf_status does not exist" } }
  assert.equal((await call("/dashboard/api/review/2569_10/pdf")).status, 503)
  getError = null
})

test("a database outage is an error, not 'not set up'", async () => {
  for (const [fn, path, method, body] of [["review_months", "/months", "GET"], ["review_state", "/2569_10", "GET"],
    ["review_reopen_round", "/2569_10/reopen", "POST", { reason: "x" }], ["review_people", "/2569_10/people", "GET"]]) {
    rpcErrors[fn] = OUTAGE
    const r = await call("/dashboard/api/review" + path, { method, body })
    assert.equal(r.status, 500, path)
    const out = await r.json()
    assert.equal(out.installed, undefined)
    assert.match(out.error, /ลองใหม่อีกครั้ง/)
    delete rpcErrors[fn]
  }
  // Other "does not exist" wording with its own code is not a missing install either.
  rpcErrors.review_state = { code: "42704", message: 'role "x" does not exist' }
  assert.equal((await call("/dashboard/api/review/2569_10")).status, 500)
  delete rpcErrors.review_state
})

test("ผู้จัดทำ only (Dada): the auditee side and the budget box, never the auditor's", async () => {
  const as = (path, opts = {}) => call(path, { ...opts, who: AUDITEE })
  state = fresh()
  // Their side: months, the month, the list, a score, build, send, take back, email, budget.
  assert.equal((await as("/dashboard/api/review/months")).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10")).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10/list")).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10/rebuild", { method: "POST" })).status !== 404, true)
  assert.equal((await as("/dashboard/api/review/2569_10/rounds", { method: "POST" })).status, 200)
  assert.notEqual((await as("/dashboard/api/review/2569_10/rounds/withdraw", { method: "POST" })).status, 404)
  assert.notEqual((await as("/dashboard/api/review/2569_10/email", { method: "POST" })).status, 404)
  assert.equal((await as("/dashboard/api/budget/2569_10", { method: "PUT", body: { budget: "2158709", doctors: "226" } })).status, 200)
  // A returned round: read it and answer.
  assert.equal((await as("/dashboard/api/review/2569_10/people?round=1")).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10/issues")).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10/opened", { method: "POST", body: { role: "auditee" } })).status, 200)
  assert.equal((await as("/dashboard/api/review/2569_10/issues/4/replies", { method: "POST", body: { role: "auditee", body: "แก้แล้ว" } })).status, 200)
  // The auditor's side is not there for them.
  rpcs = []
  for (const [path, method, body] of [
    ["/dashboard/api/review/2569_10/decisions/" + IDX, "PUT", { decision: "approve", remark: "" }],
    ["/dashboard/api/review/2569_10/approve-all", "POST", { round: 1 }],
    ["/dashboard/api/review/2569_10/return", "POST"],
    ["/dashboard/api/review/2569_10/unreturn", "POST"],
    ["/dashboard/api/review/2569_10/approve", "POST"],
    ["/dashboard/api/review/2569_10/reopen", "POST", { reason: "x" }],
    ["/dashboard/api/review/2569_10/issues", "POST", { body: "x" }],
    ["/dashboard/api/review/2569_10/issues/4/status", "POST", { open: false }],
    ["/dashboard/api/review/2569_10/opened", "POST", { role: "auditor" }],
    ["/dashboard/api/review/2569_10/issues/4/replies", "POST", { role: "auditor", body: "x" }],
  ]) assert.equal((await as(path, { method, body })).status, 404, path)
  assert.deepEqual(rpcs, [])
  // Anyone else still gets nothing.
  assert.equal((await call("/dashboard/api/review/2569_10", { who: OTHER })).status, 404)
})
