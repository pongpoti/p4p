/**
 * lib/review-server.ts with its helpers faked: only the owner gets in, the
 * month must be a roster table, typed money is checked, a changed budget
 * asks for a build, an uploaded file is matched to a build by SHA-256, and
 * the SQL functions' refusals come back in Thai.
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

const fakeAxios = {
  async post(url, body) {
    calls.push(["post", url, body])
    if (url.includes("/object/sign/")) return { data: { signedURL: "/object/sign/review-files/x?token=t" } }
    if (url.includes("/object/upload/sign/")) return { data: { url: "/object/upload/sign/review-files/y?token=u" } }
    return { data: null }
  },
  async get(url) {
    calls.push(["get", url])
    if (url.includes("review_uploads?")) return { data: [{ id: "u1", kind: "sk03", path: "uploads/2569_10/u1.xlsx", file_name: "SK03.xlsx" }] }
    if (url.includes("/storage/v1/object/review-files/")) return { data: FILE }
    if (url.includes("review_builds?select=id,built_at")) return { data: [{ id: "b2", built_at: "2", sk03_sha256: SHA, merged_sha256: "m".repeat(64) }] }
    if (url.includes("review_builds?select=id,month")) return { data: [{ id: "b2", month: "2569_10", sk03_path: "builds/2569_10/b2/SK03_2569_10.xlsx" }] }
    return { data: [] }
  },
  async patch(url, body) { calls.push(["patch", url, body]); return { data: null } },
}

const app = express()
mountReview({
  app, express, axios: fakeAxios,
  supabaseUrl: "https://db.example",
  serviceHeaders: () => ({ apikey: "k" }),
  async callServiceRpc(fn, args) {
    rpcs.push([fn, args])
    if (fn === "review_state") return state
    if (fn === "review_months") return [{ month: "2569_10" }]
    if (fn === "review_request_build") return { id: 9, status: "queued" }
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
