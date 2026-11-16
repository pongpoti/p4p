/**
 * lib/staffing-server.ts with its helpers faked: every dashboard user reads
 * the อัตรากำลัง list, only the owner saves (404 for anyone else), each
 * number is checked before staffing_save is called, the save is logged with
 * the numbers and multiplier before and after, and a missing install is the
 * starting numbers with installed: false on the list and a 503 on a save.
 */
import { test, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const express = require("express")
const { mountStaffing } = require(resolve(repoRoot, "lib/staffing-server"))
const staffing = require(resolve(repoRoot, "lib/dept-staffing"))

const OWNER = "Uowner", OTHER = "Uother"
let calls = [], rpcs = [], audits = []
let rows = []
let getError = null, rpcError = null
const pgFail = (data) => { const e = new Error("x"); e.response = { data }; return e }

const fakeAxios = {
  async get(url, opts) {
    calls.push([url, opts])
    if (getError) throw getError
    return { data: rows }
  },
}

const app = express()
mountStaffing({
  app, express, axios: fakeAxios,
  supabaseUrl: "https://db.example",
  serviceHeaders: () => ({ apikey: "k" }),
  async callServiceRpc(fn, args) {
    rpcs.push([fn, args])
    if (rpcError) throw rpcError
    // As staffing_save does it: the row before (null: none yet) and after.
    const was = rows.find((r) => r.code === args.p_code) || null
    const after = { code: args.p_code, fte: args.p_fte, staff: args.p_staff, daily: args.p_daily,
      updated_at: "2026-11-16T15:00:00+00:00", updated_by: args.p_actor }
    rows = [...rows.filter((r) => r.code !== args.p_code), after]
    return { before: was, after }
  },
  dashSession: (req) => (req.headers["x-who"] ? { sub: String(req.headers["x-who"]), name: "Pong", exp: 1 } : null),
  isDashOwner: (sub) => sub === OWNER,
  audit: async (req, actor, action, target) => { audits.push([actor.sub, action, target]) },
})
const server = app.listen(0)
const base = "http://127.0.0.1:" + server.address().port
after(() => server.close())
const call = (path, { who = OWNER, method = "GET", body, raw } = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(who ? { "x-who": who } : {}), ...(body || raw ? { "Content-Type": "application/json" } : {}) },
  body: raw ?? (body ? JSON.stringify(body) : undefined),
})
beforeEach(() => { calls = []; rpcs = []; audits = []; rows = []; getError = null; rpcError = null })

test("signed-in users only; everyone sees the list, only the owner can edit", async () => {
  assert.equal((await call("/dashboard/api/staffing", { who: null })).status, 401)
  for (const [who, canEdit] of [[OWNER, true], [OTHER, false]]) {
    const r = await call("/dashboard/api/staffing", { who })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get("cache-control"), "no-store")
    const j = await r.json()
    assert.equal(j.canEdit, canEdit, who)
    assert.equal(j.installed, true)
    assert.equal(j.k, 5)
    assert.equal(j.source, "อัตรากำลัง 13-11-69")
    assert.deepEqual(j.depts.map((d) => d.code), staffing.DEPT_STAFFING_DEFAULTS.map((d) => d.code))
  }
  assert.match(calls[0][0], /^https:\/\/db\.example\/rest\/v1\/dept_staffing\?select=code,fte,staff,daily,updated_at,updated_by$/)
  assert.deepEqual(calls[0][1].headers, { apikey: "k" })
  assert.equal(audits.length, 0, "no ?view=1, nothing logged")
})

test("the list carries each department's lack and multiplier, saved numbers first", async () => {
  rows = [{ code: "SOC", fte: 10, staff: 4, daily: 0, updated_at: "2026-11-16T09:00:00+00:00", updated_by: "Pong" }]
  const j = await (await call("/dashboard/api/staffing?view=1", { who: OTHER })).json()
  const soc = j.depts.find((d) => d.code === "SOC")
  assert.deepEqual([soc.fte, soc.staff, soc.daily, soc.lack, soc.multiplier, soc.updated_by], [10, 4, 0, 0.6, 4, "Pong"])
  const med = j.depts.find((d) => d.code === "MED")
  assert.deepEqual([med.lack, med.multiplier, med.updated_at], [0.1277, 1.6383, null])
  assert.deepEqual(audits, [[OTHER, "view.staffing", undefined]])
})

test("not installed: the starting numbers, and a save says what to run", async () => {
  for (const data of [
    { code: "PGRST205", message: "Could not find the table 'public.dept_staffing' in the schema cache" },
    { code: "42P01", message: "relation \"public.dept_staffing\" does not exist" },
  ]) {
    getError = pgFail(data)
    const j = await (await call("/dashboard/api/staffing")).json()
    assert.equal(j.installed, false)
    assert.equal(j.depts.find((d) => d.code === "SOC").daily, 15)
  }
  rpcError = pgFail({ code: "PGRST202", message: "Could not find the function public.staffing_save" })
  const r = await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, daily: 15 } })
  assert.equal(r.status, 503)
  const j = await r.json()
  assert.equal(j.installed, false)
  assert.match(j.error, /scripts\/dept-staffing-2026-11\.sql/)
  assert.equal(audits.length, 0)
})

test("any other read failure is a 500, not the starting numbers", async () => {
  getError = pgFail({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." })
  assert.equal((await call("/dashboard/api/staffing")).status, 500)
  getError = new Error("timeout of 8000ms exceeded")
  assert.equal((await call("/dashboard/api/staffing")).status, 500)
})

test("only the owner saves; anyone else gets 404", async () => {
  assert.equal((await call("/dashboard/api/staffing/SOC", { who: null, method: "PUT", body: { fte: 10, staff: 4, daily: 1 } })).status, 401)
  assert.equal((await call("/dashboard/api/staffing/SOC", { who: OTHER, method: "PUT", body: { fte: 10, staff: 4, daily: 1 } })).status, 404)
  assert.equal(rpcs.length, 0)
})

test("a save calls staffing_save and is logged with the numbers and multiplier before and after", async () => {
  const r = await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: "47", staff: 37, daily: "6" } })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(rpcs, [["staffing_save", { p_code: "MED", p_fte: 47, p_staff: 37, p_daily: 6, p_actor: "Pong" }]])
  assert.equal(j.ok, true)
  assert.deepEqual([j.dept.code, j.dept.name, j.dept.daily, j.dept.multiplier, j.dept.updated_by], ["MED", "อายุรกรรม", 6, 1.4255, "Pong"])
  assert.equal(j.dept.updated_at, "2026-11-16T15:00:00+00:00")
  // MED had no row yet: "before" is its starting numbers.
  assert.deepEqual(audits, [[OWNER, "staffing.save", {
    code: "MED", name: "อายุรกรรม",
    before: { fte: 47, staff: 37, daily: 4 }, after: { fte: 47, staff: 37, daily: 6 },
    multiplier_before: 1.6383, multiplier_after: 1.4255,
  }]])
  // Saved again: "before" is the saved row.
  audits = []
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 37, daily: 4 } })
  assert.deepEqual(audits[0][2].before, { fte: 47, staff: 37, daily: 6 })
  assert.equal(audits[0][2].multiplier_after, 1.6383)
})

test("each number is checked before the database is asked", async () => {
  for (const [body, field] of [
    [{ fte: 0, staff: 4, daily: 1 }, "fte"], [{ fte: 1000, staff: 4, daily: 1 }, "fte"], [{ staff: 4, daily: 1 }, "fte"],
    [{ fte: 10, staff: -1, daily: 1 }, "staff"], [{ fte: 10, staff: 1.5, daily: 1 }, "staff"], [{ fte: 10, staff: "4a", daily: 1 }, "staff"],
    [{ fte: 10, staff: 4, daily: null }, "daily"], [{ fte: 10, staff: 4, daily: "1e2" }, "daily"], [{ fte: 10, staff: 4, daily: [1] }, "daily"],
  ]) {
    const r = await call("/dashboard/api/staffing/SOC", { method: "PUT", body })
    assert.equal(r.status, 400, JSON.stringify(body))
    const j = await r.json()
    assert.equal(j.field, field, JSON.stringify(body))
    assert.match(j.error, /จำนวนเต็ม/)
  }
  // Not JSON or not an object: the first field is missing.
  assert.equal((await call("/dashboard/api/staffing/SOC", { method: "PUT", raw: "[1,2,3]" })).status, 400)
  assert.equal(rpcs.length, 0)
})

test("only the 18 department codes", async () => {
  for (const code of ["INT", "soc", "XYZ", "constructor", "__proto__"]) {
    assert.equal((await call("/dashboard/api/staffing/" + code, { method: "PUT", body: { fte: 1, staff: 1, daily: 1 } })).status, 404, code)
  }
  assert.equal(rpcs.length, 0)
})

test("a database refusal is a 500 and nothing is logged", async () => {
  rpcError = pgFail({ code: "P0001", message: "staffing: bad fte" })
  const r = await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, daily: 15 } })
  assert.equal(r.status, 500)
  assert.equal(audits.length, 0)
})
