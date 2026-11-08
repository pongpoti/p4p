/**
 * lib/review-server.ts with its helpers faked: only the owner gets in, the
 * month must be a roster table, typed money is checked, a changed budget
 * asks for a build, an uploaded file is matched to a build by SHA-256, and
 * the SQL functions' refusals come back in Thai. A missing install is
 * { installed: false } on the two loads and a 503 everywhere else.
 */
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createHash } from "node:crypto"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const express = require("express")
const { mountReview } = require(resolve(repoRoot, "lib/review-server"))

const OWNER = "Uowner", OTHER = "Uother"
const FILE = Buffer.from("the built SK03")
const SHA = createHash("sha256").update(FILE).digest("hex")
const calls = []
let rpcs = []
let state = { rounds: [], live: null, inputs: null }
let submitError = null
const rpcErrors = {}
let pdfRound = null

let getError = null
const pgFail = (data) => { const e = new Error("x"); e.response = { data }; return e }

const fakeAxios = {
  async post(url, body) {
    calls.push(["post", url, body])
    // The saved numbers, as the next review_state would show them.
    if (url.includes("review_inputs")) state = { ...state, inputs: { budget: body.budget, per_p4p: body.per_p4p, updated_at: body.updated_at } }
    if (url.includes("/object/sign/")) return { data: { signedURL: "/object/sign/review-files/x?token=t" } }
    if (url.includes("/object/upload/sign/")) return { data: { url: "/object/upload/sign/review-files/y?token=u" } }
    return { data: null }
  },
  async get(url) {
    calls.push(["get", url])
    if (getError && url.includes(getError.at)) throw pgFail(getError.data)
    if (url.includes("review_uploads?")) return { data: [{ id: "u1", kind: "sk03", path: "uploads/2569_10/u1.xlsx", file_name: "SK03.xlsx" }] }
    if (url.includes("/storage/v1/object/review-files/")) return { data: FILE }
    if (url.includes("review_builds?select=id,built_at")) return { data: [{ id: "b2", built_at: "2", sk03_sha256: SHA, merged_sha256: "m".repeat(64) }] }
    if (url.includes("review_builds?select=id,month")) return { data: [{ id: "b2", month: "2569_10", sk03_path: "builds/2569_10/b2/SK03_2569_10.xlsx" }] }
    if (url.includes("review_rounds?select=round_no,pdf_status,pdf_path")) return { data: pdfRound ? [pdfRound] : [] }
    if (url.includes("review_build_people?select=name")) return { data: [{ name: "นพ. ทดสอบ" }] }
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
    if (fn === "review_people") return { round: { round_no: args.p_round || 1 }, people: [] }
    if (fn === "review_add_issue") return { id: 4 }
    if (fn === "review_reopen_round") return { round_no: 2, old_pdf: "pdf/2569_10/round-2-1.pdf" }
    if (fn === "review_retry_pdf") return { round_no: 2 }
    if (fn === "review_return_round" || fn === "review_approve_round" || fn === "review_unreturn_round") return { round_no: 1 }
    if (fn === "review_submit_round") {
      if (submitError) { const e = new Error("x"); e.response = { data: { code: "P0001", message: submitError } }; throw e }
      return { round_no: 1 }
    }
    return null
  },
  listRosterTables: async () => ["2569_10", "2569_09", "management_stipends"],
  dashSession: (req) => (req.headers["x-who"] ? { sub: String(req.headers["x-who"]), name: "Pong", exp: 1 } : null),
  isDashOwner: (sub) => sub === OWNER,
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

test("owner only, real months only", async () => {
  assert.equal((await call("/dashboard/api/review/months", { who: null })).status, 401)
  assert.equal((await call("/dashboard/api/review/months", { who: OTHER })).status, 404)
  const r = await (await call("/dashboard/api/review/months")).json()
  assert.deepEqual(rpcs.at(-1), ["review_months", { p_months: ["2569_10", "2569_09"] }])
  assert.equal(r.installed, true)
  assert.equal((await call("/dashboard/api/review/2569_11")).status, 404)
  assert.equal((await call("/dashboard/api/review/2569_10")).status, 200)
})

test("budget: checked, saved, and a changed one asks for a build", async () => {
  let r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "abc", per_p4p: "1" } })
  assert.equal(r.status, 400)
  rpcs = []
  r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "2,158,709.06", per_p4p: "9551.81" } })
  assert.equal(r.status, 200)
  const saved = calls.find((c) => c[0] === "post" && c[1].includes("review_inputs"))
  assert.equal(saved[2].budget, 2158709.06)
  assert.equal(saved[2].per_p4p, 9551.81)
  assert.deepEqual(rpcs.at(-1), ["review_request_build", { p_month: "2569_10", p_reason: "inputs", p_actor: "Pong" }])
  // Locked while the auditor has the round.
  state = { ...state, rounds: [{ round_no: 1, status: "submitted" }], live: 1 }
  r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "1", per_p4p: "1" } })
  assert.equal(r.status, 409)
  state = { rounds: [], live: null, inputs: null }
})

test("download: a short signed link to the build's own file", async () => {
  const r = await call("/dashboard/api/review/2569_10/file/b2222222-2222-4222-8222-222222222222/sk03")
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), "https://db.example/storage/v1/object/sign/review-files/x?token=t&download=SK03_2569_10.xlsx")
  assert.equal((await call("/dashboard/api/review/2569_10/file/b2222222-2222-4222-8222-222222222222/pdf")).status, 404)
})

test("upload: signed URL first, then matched to the newest build by SHA-256", async () => {
  let r = await call("/dashboard/api/review/2569_10/uploads", { method: "POST", body: { kind: "sk03", fileName: "SK03.xlsx", bytes: 1000 } })
  const up = await r.json()
  assert.equal(up.url, "https://db.example/storage/v1/object/upload/sign/review-files/y?token=u")
  assert.equal((await call("/dashboard/api/review/2569_10/uploads", { method: "POST", body: { kind: "sk03", fileName: "a.xls", bytes: 1 } })).status, 400)
  r = await call("/dashboard/api/review/2569_10/uploads/a1111111-1111-4111-8111-111111111111/verify", { method: "POST" })
  const v = await r.json()
  assert.equal(v.result, "latest")
  const patch = calls.find((c) => c[0] === "patch" && c[1].includes("review_uploads"))
  assert.equal(patch[2].sha256, SHA)
  assert.equal(patch[2].result, "latest")
})

test("send: the SQL function's refusal comes back in Thai", async () => {
  const ids = { sk03: "a1111111-1111-4111-8111-111111111111", merged: "a2222222-2222-4222-8222-222222222222" }
  let r = await call("/dashboard/api/review/2569_10/rounds", { method: "POST", body: ids })
  assert.equal(r.status, 200)
  submitError = "review: files are not the latest build"
  r = await call("/dashboard/api/review/2569_10/rounds", { method: "POST", body: ids })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /ไม่ใช่ไฟล์ล่าสุด/)
  submitError = null
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

const PGRST202 = (fn) => ({ code: "PGRST202", message: "Could not find the function public." + fn + " without parameters in the schema cache" })
const OUTAGE = { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }

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
    ["review_state", "/inputs", "PUT", { budget: "1", per_p4p: "1" }],
  ]
  for (const [fn, path, method, body] of routes) {
    rpcErrors[fn] = PGRST202(fn)
    r = await call("/dashboard/api/review/2569_10" + path, { method, body })
    assert.equal(r.status, 503, path)
    const out = await r.json()
    assert.equal(out.installed, false)
    assert.match(out.error, /ยังไม่ได้ติดตั้ง.*review-tab-2026-11\.sql/)
    delete rpcErrors[fn]
  }
  // Nothing was done or logged as done.
  assert.ok(!calls.slice(before).some((c) => c[0] === "delete" || c[0] === "audit"))
  assert.ok(!calls.slice(before).some((c) => c[0] === "post" && c[1].includes("review_inputs")))
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

test("inputs: logged once saved, even when the build request fails, and a retry still builds", async () => {
  const SAVED = "2026-11-08T03:00:00.000Z"
  state = { rounds: [], live: null, inputs: { budget: 100, per_p4p: 10, updated_at: SAVED },
    build: { id: "b1", budget: 100, per_p4p: 10 }, request: { id: 8, status: "done" } }
  rpcErrors.review_request_build = { code: "57014", message: "canceling statement due to statement timeout" }
  let r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "200", per_p4p: "10" } })
  assert.equal(r.status, 500)
  delete rpcErrors.review_request_build
  assert.equal(state.inputs.budget, 200) // the upsert went through
  const logged = calls.filter((c) => c[0] === "audit" && c[1] === "review.inputs").at(-1)
  assert.deepEqual(logged[2], { month: "2569_10", budget: 200, per_p4p: 10, before: { budget: 100, per_p4p: 10 } })

  // Same numbers again: the newest build still has 100, so ask again.
  rpcs = []
  r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "200", per_p4p: "10" } })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, changed: true, request: { id: 9, status: "queued" } })
  assert.deepEqual(rpcs.at(-1), ["review_request_build", { p_month: "2569_10", p_reason: "inputs", p_actor: "Pong" }])
  state = { rounds: [], live: null, inputs: null }
})

test("inputs retry: no second build while an open one will carry the numbers", async () => {
  const SAVED = "2026-11-08T03:00:00.000Z"
  const put = async (request, build = { id: "b1", budget: 100, per_p4p: 10 }) => {
    state = { rounds: [], live: null, inputs: { budget: 200, per_p4p: 10, updated_at: SAVED }, build, request }
    rpcs = []
    const r = await call("/dashboard/api/review/2569_10/inputs", { method: "PUT", body: { budget: "200", per_p4p: "10" } })
    assert.equal(r.status, 200)
    return { out: await r.json(), asked: rpcs.some((x) => x[0] === "review_request_build") }
  }
  let x = await put({ id: 7, status: "queued" })
  assert.equal(x.asked, false)
  assert.deepEqual(x.out, { ok: true, changed: true, request: { id: 7, status: "queued" } })
  assert.equal((await put({ id: 7, status: "dispatched" })).asked, false)
  // Running since after the save: it read 200.
  assert.equal((await put({ id: 7, status: "running", started_at: "2026-11-08T03:05:00+00:00" })).asked, false)
  // Running since before the save: it may have read 100, so one more.
  assert.equal((await put({ id: 7, status: "running", started_at: "2026-11-08T02:55:00+00:00" })).asked, true)
  // Gave up (review_state shows a dead run as failed): build again.
  assert.equal((await put({ id: 7, status: "failed", error: "timed out" })).asked, true)
  assert.equal((await put(null, null)).asked, true)
  // The newest build has the numbers: nothing to do.
  x = await put({ id: 7, status: "done" }, { id: "b2", budget: 200, per_p4p: 10 })
  assert.equal(x.asked, false)
  assert.deepEqual(x.out, { ok: true, changed: false, request: null })
  state = { rounds: [], live: null, inputs: null }
})
