/**
 * lib/staffing-server.ts with its helpers faked: every dashboard user reads
 * the อัตรากำลัง list, only the owner saves (404 for anyone else), each
 * number is checked before staffing_save is called, the save is logged with
 * the numbers and multiplier before and after and the months whose build it
 * queued, and a missing install is the starting numbers with installed:
 * false on the list and a 503 on a save. A table from before the monthly
 * column (2026-11-17) reads with monthly 0 and needsUpdate: true; one from
 * before the absent column (step 33, 2026-11-26) with the starting absent
 * and needsAbsent: true, and a save that sends absent then answers 503
 * naming scripts/dept-staffing-absent-2026-11.sql. Since 2026-11-28 the
 * multiplier counts on staff only (no monthly or daily hires), and the
 * staffing report PDF is downloaded by anyone who sees the tab and
 * uploaded by the owner only (a PDF, at most 4 MB, logged as
 * staffing.report, whose last row names the file).
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
let getError = null, rpcError = null, rebuildMonths = []
// The audit log's last staffing.report row (the report's name), and Storage.
let reportRows = [], reportError = null, posts = [], signError = null, uploadError = null
const pgFail = (data) => { const e = new Error("x"); e.response = { data }; return e }

const fakeAxios = {
  async get(url, opts) {
    if (url.includes("/rest/v1/dashboard_audit_log?")) {
      posts.push(["get", url, opts])
      if (reportError) throw reportError
      return { data: reportRows }
    }
    calls.push([url, opts])
    if (getError) throw getError
    return { data: rows }
  },
  async post(url, body, opts) {
    posts.push(["post", url, body, opts])
    if (url.includes("/object/sign/")) {
      if (signError) throw signError
      return { data: { signedURL: "/object/sign/review-files/staffing/report.pdf?token=t0k" } }
    }
    if (uploadError) throw uploadError
    return { data: { Key: "review-files/staffing/report.pdf" } }
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
    // absent: null keeps the saved number (a row without the column has none).
    const absent = "p_absent" in args ? { absent: args.p_absent } : was && "absent" in was ? { absent: was.absent } : {}
    const after = { code: args.p_code, fte: args.p_fte, staff: args.p_staff, monthly: args.p_monthly, daily: args.p_daily,
      ...absent, updated_at: "2026-11-16T15:00:00+00:00", updated_by: args.p_actor }
    rows = [...rows.filter((r) => r.code !== args.p_code), after]
    return { before: was, after, rebuild: rebuildMonths }
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
beforeEach(() => {
  calls = []; rpcs = []; audits = []; rows = []; getError = null; rpcError = null; rebuildMonths = []
  reportRows = []; reportError = null; posts = []; signError = null; uploadError = null
})

test("signed-in users only; everyone sees the list, only the owner can edit", async () => {
  assert.equal((await call("/dashboard/api/staffing", { who: null })).status, 401)
  for (const [who, canEdit] of [[OWNER, true], [OTHER, false]]) {
    const r = await call("/dashboard/api/staffing", { who })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get("cache-control"), "no-store")
    const j = await r.json()
    assert.equal(j.canEdit, canEdit, who)
    assert.equal(j.installed, true)
    assert.equal(j.needsUpdate, false)
    assert.equal(j.needsAbsent, false)
    assert.equal(j.k, 5)
    assert.equal(j.source, "อัตรากำลัง 25-11-69")
    assert.deepEqual(j.depts.map((d) => d.code), staffing.DEPT_STAFFING_DEFAULTS.map((d) => d.code))
  }
  assert.match(calls[0][0], /^https:\/\/db\.example\/rest\/v1\/dept_staffing\?select=\*$/)
  assert.deepEqual(calls[0][1].headers, { apikey: "k" })
  assert.equal(audits.length, 0, "no ?view=1, nothing logged")
})

test("the list carries each department's lack and multiplier, saved numbers first", async () => {
  rows = [{ code: "SOC", fte: 10, staff: 4, monthly: 0, daily: 0, absent: 2, updated_at: "2026-11-16T09:00:00+00:00", updated_by: "Pong" }]
  const j = await (await call("/dashboard/api/staffing?view=1", { who: OTHER })).json()
  const soc = j.depts.find((d) => d.code === "SOC")
  assert.deepEqual([soc.fte, soc.staff, soc.monthly, soc.daily, soc.absent, soc.lack, soc.multiplier, soc.updated_by], [10, 4, 0, 0, 2, 0.6, 4, "Pong"])
  const med = j.depts.find((d) => d.code === "MED")
  // ข้าราชการ only since 2026-11-28: MED 33 of 47 (its 4 daily hires are not counted).
  assert.deepEqual([med.staff, med.monthly, med.daily, med.absent, med.lack, med.multiplier, med.updated_at], [33, 0, 4, 4, 0.2979, 2.4894, null])
  const socAll = j.depts.find((d) => d.code === "SOC")
  assert.equal(socAll.daily, 0)
  assert.equal(j.needsUpdate, false)
  assert.equal(j.needsAbsent, false)
  assert.deepEqual(audits, [[OTHER, "view.staffing", undefined]])
})

test("a table from before the monthly column: monthly 0, and the owner is told to run the SQL again", async () => {
  rows = [{ code: "MED", fte: 47, staff: 37, daily: 4, updated_at: null, updated_by: null }]
  const j = await (await call("/dashboard/api/staffing")).json()
  assert.equal(j.installed, true)
  assert.equal(j.needsUpdate, true)
  const med = j.depts.find((d) => d.code === "MED")
  assert.deepEqual([med.staff, med.monthly, med.daily, med.multiplier], [37, 0, 4, 2.0638])
  // The save without monthly hires is gone once the SQL runs; until then the new one is missing: 503.
  rpcError = pgFail({ code: "42P01", message: "relation \"public.dept_staffing\" does not exist" })
  const r = await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 36, monthly: 1, daily: 4 } })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /scripts\/dept-staffing-2026-11\.sql/)
})

test("a table from before the absent column: the starting absent, and a save with it says to run step 33", async () => {
  rows = [{ code: "MED", fte: 47, staff: 33, monthly: 0, daily: 4, updated_at: null, updated_by: null }]
  const j = await (await call("/dashboard/api/staffing")).json()
  assert.equal(j.installed, true)
  assert.equal(j.needsUpdate, false)
  assert.equal(j.needsAbsent, true)
  const med = j.depts.find((d) => d.code === "MED")
  assert.deepEqual([med.staff, med.monthly, med.daily, med.absent, med.multiplier], [33, 0, 4, 4, 2.4894])
  rpcError = pgFail({ code: "PGRST202", message: "Could not find the function public.staffing_save(p_absent, p_actor, p_code, p_daily, p_fte, p_monthly, p_staff) in the schema cache" })
  const r = await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 33, monthly: 0, daily: 4, absent: 3 } })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /scripts\/dept-staffing-absent-2026-11\.sql/)
  assert.equal(audits.length, 0)
  // Without absent (a page from before it) the 6-argument save still runs.
  rpcError = null
  rpcs = []
  const k = await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 32, monthly: 0, daily: 4 } })
  assert.equal(k.status, 200)
  assert.deepEqual(rpcs, [["staffing_save", { p_code: "MED", p_fte: 47, p_staff: 32, p_monthly: 0, p_daily: 4, p_actor: "Pong" }]])
  assert.deepEqual([audits[0][2].before, audits[0][2].after],
    [{ fte: 47, staff: 33, monthly: 0, daily: 4, absent: 4 }, { fte: 47, staff: 32, monthly: 0, daily: 4, absent: 4 }])
  assert.equal((await k.json()).dept.absent, 4)
})

test("not installed: the starting numbers, and a save says what to run", async () => {
  for (const data of [
    { code: "PGRST205", message: "Could not find the table 'public.dept_staffing' in the schema cache" },
    { code: "42P01", message: "relation \"public.dept_staffing\" does not exist" },
  ]) {
    getError = pgFail(data)
    const j = await (await call("/dashboard/api/staffing")).json()
    assert.equal(j.installed, false)
    assert.equal(j.needsUpdate, false)
    assert.equal(j.depts.find((d) => d.code === "SOC").daily, 16)
    assert.equal(j.depts.find((d) => d.code === "EYE").monthly, 1)
  }
  rpcError = pgFail({ code: "PGRST205", message: "Could not find the table 'public.dept_staffing' in the schema cache" })
  const r = await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 15 } })
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
  assert.equal((await call("/dashboard/api/staffing/SOC", { who: null, method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 1 } })).status, 401)
  assert.equal((await call("/dashboard/api/staffing/SOC", { who: OTHER, method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 1 } })).status, 404)
  assert.equal(rpcs.length, 0)
})

test("a save calls staffing_save and is logged with the numbers and multiplier before and after", async () => {
  const r = await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: "47", staff: 36, monthly: "1", daily: "6", absent: "2" } })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(rpcs, [["staffing_save", { p_code: "MED", p_fte: 47, p_staff: 36, p_monthly: 1, p_daily: 6, p_actor: "Pong", p_absent: 2 }]])
  assert.equal(j.ok, true)
  assert.deepEqual([j.dept.code, j.dept.name, j.dept.monthly, j.dept.daily, j.dept.absent, j.dept.multiplier, j.dept.updated_by], ["MED", "อายุรกรรม", 1, 6, 2, 2.1702, "Pong"])
  assert.equal(j.dept.updated_at, "2026-11-16T15:00:00+00:00")
  // MED had no row yet: "before" is its starting numbers.
  assert.deepEqual(audits, [[OWNER, "staffing.save", {
    code: "MED", name: "อายุรกรรม",
    before: { fte: 47, staff: 33, monthly: 0, daily: 4, absent: 4 }, after: { fte: 47, staff: 36, monthly: 1, daily: 6, absent: 2 }, k: 5,
    multiplier_before: 2.4894, multiplier_after: 2.1702, rebuild: [],
  }]])
  assert.deepEqual(j.rebuild, [])
  // Saved again: "before" is the saved row.
  audits = []
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 36, monthly: 1, daily: 4, absent: 2 } })
  assert.deepEqual(audits[0][2].before, { fte: 47, staff: 36, monthly: 1, daily: 6, absent: 2 })
  assert.equal(audits[0][2].multiplier_after, 2.1702)
  // ไม่ได้ปฏิบัติงาน is not in the multiplier.
  audits = []
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 36, monthly: 1, daily: 4, absent: 9 } })
  assert.deepEqual([audits[0][2].before.absent, audits[0][2].after.absent], [2, 9])
  assert.deepEqual([audits[0][2].multiplier_before, audits[0][2].multiplier_after], [2.1702, 2.1702])
  // Hires are not in the multiplier (2026-11-28): changing them alone keeps it.
  audits = []
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 36, monthly: 0, daily: 9 } })
  assert.deepEqual([audits[0][2].multiplier_before, audits[0][2].multiplier_after], [2.1702, 2.1702])
  // One more doctor on staff: 37 of 47.
  audits = []
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 37, monthly: 0, daily: 9 } })
  assert.deepEqual([audits[0][2].multiplier_before, audits[0][2].multiplier_after], [2.1702, 2.0638])
})

test("a save logged against a row from before the monthly column counts it as 0", async () => {
  rows = [{ code: "MED", fte: 47, staff: 37, daily: 4, updated_at: null, updated_by: null }]
  await call("/dashboard/api/staffing/MED", { method: "PUT", body: { fte: 47, staff: 36, monthly: 1, daily: 4 } })
  assert.deepEqual(audits[0][2].before, { fte: 47, staff: 37, monthly: 0, daily: 4, absent: 4 })
  assert.deepEqual([audits[0][2].multiplier_before, audits[0][2].multiplier_after], [2.0638, 2.1702])
})

test("the months whose build a save queued are answered and logged", async () => {
  rebuildMonths = ["2569_08", "2569_10", "bad", 7, null]
  const j = await (await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 14 } })).json()
  assert.deepEqual(j.rebuild, ["2569_08", "2569_10"])
  assert.deepEqual(audits[0][2].rebuild, ["2569_08", "2569_10"])
  // An older staffing_save without rebuild: none.
  rebuildMonths = undefined
  const k = await (await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 15 } })).json()
  assert.deepEqual(k.rebuild, [])
})

test("each number is checked before the database is asked", async () => {
  for (const [body, field] of [
    [{ fte: 0, staff: 4, monthly: 0, daily: 1 }, "fte"], [{ fte: 1000, staff: 4, monthly: 0, daily: 1 }, "fte"],
    [{ staff: 4, monthly: 0, daily: 1 }, "fte"],
    [{ fte: 10, staff: -1, monthly: 0, daily: 1 }, "staff"], [{ fte: 10, staff: 1.5, monthly: 0, daily: 1 }, "staff"],
    [{ fte: 10, staff: "4a", monthly: 0, daily: 1 }, "staff"],
    // A page from before the monthly column sends none: refused, not saved as 0.
    [{ fte: 10, staff: 4, daily: 1 }, "monthly"], [{ fte: 10, staff: 4, monthly: -1, daily: 1 }, "monthly"],
    [{ fte: 10, staff: 4, monthly: "x", daily: 1 }, "monthly"],
    [{ fte: 10, staff: 4, monthly: 0, daily: null }, "daily"], [{ fte: 10, staff: 4, monthly: 0, daily: "1e2" }, "daily"],
    [{ fte: 10, staff: 4, monthly: 0, daily: [1] }, "daily"],
    // absent may be left out, but not sent wrong.
    [{ fte: 10, staff: 4, monthly: 0, daily: 1, absent: -1 }, "absent"], [{ fte: 10, staff: 4, monthly: 0, daily: 1, absent: null }, "absent"],
    [{ fte: 10, staff: 4, monthly: 0, daily: 1, absent: "2.5" }, "absent"], [{ fte: 10, staff: 4, monthly: 0, daily: 1, absent: 1000 }, "absent"],
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
    assert.equal((await call("/dashboard/api/staffing/" + code, { method: "PUT", body: { fte: 1, staff: 1, monthly: 0, daily: 1 } })).status, 404, code)
  }
  assert.equal(rpcs.length, 0)
})

test("a database refusal is a 500 and nothing is logged", async () => {
  rpcError = pgFail({ code: "P0001", message: "staffing: bad fte" })
  const r = await call("/dashboard/api/staffing/SOC", { method: "PUT", body: { fte: 10, staff: 4, monthly: 0, daily: 15 } })
  assert.equal(r.status, 500)
  assert.equal(audits.length, 0)
})

// ── The staffing report PDF (Pong, 2026-11-28) ─────────────────────────────
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 32), Buffer.from("%%EOF\n")])
const upload = (body, { who = OWNER, name } = {}) => fetch(base + "/dashboard/api/staffing/report", {
  method: "POST",
  headers: { ...(who ? { "x-who": who } : {}), "Content-Type": "application/pdf", ...(name !== undefined ? { "X-File-Name": name } : {}) },
  body,
})
const REPORT_ROW = { created_at: "2026-11-28T06:00:00+00:00", actor_name: "Pong", target: { name: "รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน พ.ย. 2569.pdf", bytes: 2007 } }

test("the list says which report there is (the last staffing.report row), or none", async () => {
  let j = await (await call("/dashboard/api/staffing", { who: OTHER })).json()
  assert.equal(j.report, null)
  const read = posts.find((p) => p[0] === "get")
  assert.equal(read[1], "https://db.example/rest/v1/dashboard_audit_log?select=created_at,actor_name,target&action=eq.staffing.report&order=id.desc&limit=1")
  reportRows = [REPORT_ROW]
  j = await (await call("/dashboard/api/staffing", { who: OTHER })).json()
  assert.deepEqual(j.report, { name: REPORT_ROW.target.name, bytes: 2007, uploaded_at: REPORT_ROW.created_at, uploaded_by: "Pong" })
  // A failed read is no report, not a failed tab.
  reportError = new Error("timeout")
  const r = await call("/dashboard/api/staffing", { who: OTHER })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).report, null)
})

test("anyone who sees the tab downloads the report: a signed link saved under its name", async () => {
  assert.equal((await call("/dashboard/api/staffing/report?link=1", { who: null })).status, 401)
  let r = await call("/dashboard/api/staffing/report?link=1", { who: OTHER })
  assert.equal(r.status, 404)
  assert.match((await r.json()).error, /ยังไม่มีไฟล์/)
  reportRows = [REPORT_ROW]
  r = await call("/dashboard/api/staffing/report?link=1", { who: OTHER })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("cache-control"), "no-store")
  const j = await r.json()
  assert.equal(j.name, REPORT_ROW.target.name)
  assert.equal(j.url, "https://db.example/storage/v1/object/sign/review-files/staffing/report.pdf?token=t0k&download=" + encodeURIComponent(REPORT_ROW.target.name))
  const sign = posts.find((p) => p[0] === "post")
  assert.equal(sign[1], "https://db.example/storage/v1/object/sign/review-files/staffing/report.pdf")
  assert.deepEqual(sign[2], { expiresIn: 120 })
  assert.deepEqual(audits, [[OTHER, "staffing.download", { name: REPORT_ROW.target.name }]])
  // Without ?link=1: a redirect to the same link.
  r = await call("/dashboard/api/staffing/report", { who: OWNER })
  assert.equal(r.status, 302)
  assert.match(r.headers.get("location"), /token=t0k&download=/)
  // The file gone from Storage: 404; anything else: 502.
  signError = pgFail({ statusCode: "404", error: "not_found", message: "Object not found" })
  signError.response.status = 400
  assert.equal((await call("/dashboard/api/staffing/report?link=1", { who: OTHER })).status, 404)
  signError = new Error("socket hang up")
  assert.equal((await call("/dashboard/api/staffing/report?link=1", { who: OTHER })).status, 502)
})

test("a user without the tab's right gets 404 for the report too", async () => {
  const app2 = express()
  mountStaffing({
    app: app2, express, axios: fakeAxios, supabaseUrl: "https://db.example", serviceHeaders: () => ({ apikey: "k" }),
    callServiceRpc: async () => ({}), dashSession: () => ({ sub: OTHER, name: "X", exp: 1 }), isDashOwner: () => false,
    canView: () => false, audit: async (req, actor, action, target) => { audits.push([actor.sub, action, target]) },
  })
  const srv = app2.listen(0)
  try {
    reportRows = [REPORT_ROW]
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/dashboard/api/staffing/report?link=1")
    assert.equal(r.status, 404)
    assert.equal(posts.filter((p) => p[0] === "post").length, 0)
    assert.equal(audits.length, 0)
  } finally { srv.close() }
})

test("only the owner uploads the report: a PDF up to 4 MB, put in place of the last and logged with its name", async () => {
  assert.equal((await upload(PDF, { who: null })).status, 401)
  assert.equal((await upload(PDF, { who: OTHER })).status, 404)
  assert.equal(posts.length, 0)
  const name = "รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน พ.ย. 2569.pdf"
  const r = await upload(PDF, { name: encodeURIComponent(name) })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.deepEqual([j.report.name, j.report.bytes, j.report.uploaded_by], [name, PDF.length, "Pong"])
  const up = posts.find((p) => p[0] === "post")
  assert.equal(up[1], "https://db.example/storage/v1/object/review-files/staffing/report.pdf")
  assert.ok(Buffer.isBuffer(up[2]) && up[2].equals(PDF), "the file as sent")
  assert.equal(up[3].headers["Content-Type"], "application/pdf")
  assert.equal(up[3].headers["x-upsert"], "true", "replaces the last one")
  assert.equal(up[3].headers.apikey, "k")
  assert.deepEqual(audits, [[OWNER, "staffing.report", { name, bytes: PDF.length }]])
})

test("an upload that is not a PDF, empty or too big is refused before Storage; a Storage failure is a 502", async () => {
  for (const [body, status, msg] of [
    [Buffer.from("PK\u0003\u0004 not a pdf"), 400, /ไม่ใช่ PDF/],
    [Buffer.alloc(0), 400, /ไม่พบไฟล์/],
    [Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(4 * 1024 * 1024)]), 413, /4 MB/],
  ]) {
    const r = await upload(body, { name: "x.pdf" })
    assert.equal(r.status, status)
    assert.match((await r.json()).error, msg)
  }
  assert.equal(posts.length, 0)
  assert.equal(audits.length, 0)
  uploadError = pgFail({ statusCode: "500", error: "internal" })
  const r = await upload(PDF, { name: "x.pdf" })
  assert.equal(r.status, 502)
  assert.equal(audits.length, 0, "nothing logged when Storage refused it")
})

test("the report's name: no folders or control characters, ends .pdf, a default when there is none", () => {
  const { reportName } = require(resolve(repoRoot, "lib/staffing-server"))
  const DEF = "รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน.pdf"
  for (const [v, want] of [
    [undefined, DEF], ["", DEF], [".pdf", DEF], ["  ", DEF], [5, DEF],
    [encodeURIComponent("รายงาน พ.ย. 2569.pdf"), "รายงาน พ.ย. 2569.pdf"],
    ["C:%5Cfakepath%5Creport.PDF", "report.PDF"], ["../../etc/passwd", "passwd.pdf"],
    ["a\u0000b\u001fc\".pdf", "abc.pdf"], ["%E0%A4%A", "%E0%A4%A.pdf"],
  ]) assert.equal(reportName(v), want, JSON.stringify(v))
  assert.ok(reportName("ก".repeat(400) + ".pdf").length <= 150)
  assert.match(reportName("ก".repeat(400) + ".pdf"), /[.]pdf$/)
})
