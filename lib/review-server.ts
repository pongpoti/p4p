/**
 * lib/review-server.ts
 *
 * The /dashboard/ ตรวจสอบ (review) tab's API, owner only like รายชื่อ and
 * ประวัติการใช้งาน (anyone else gets 404). Mounted from main.ts with its
 * helpers passed in, so this file has no secrets or settings of its own.
 *
 * Tables, functions and the private bucket review-files come from
 * scripts/review-tab-2026-11.sql and then scripts/review-tab-2026-11-auditee.sql;
 * until both have been run the two loads (months, a month's state) answer
 * { installed: false } and the tab says so, and every other route fails
 * with 503.
 *
 * The auditee (ผู้จัดทำ) side, from ส.ค. 2569 (2569_08) on:
 *   GET  /dashboard/api/review/months                 the month tabs, oldest first
 *   GET  /dashboard/api/review/:month                 the month's state (?view=1 logs the visit)
 *   GET  /dashboard/api/review/:month/list            everyone in the newest build, with checks and edits
 *   PUT  /dashboard/api/review/:month/inputs          {budget, doctors}: per P4P = budget ÷ N, then a fresh build
 *   PUT  /dashboard/api/review/:month/scores/:index   {score, note}: one person's score, then a fresh build
 *   POST /dashboard/api/review/:month/rebuild         a fresh build (workflow 2.2 via the relay)
 *   POST /dashboard/api/review/:month/rounds          send the newest build to the auditor
 *   POST /dashboard/api/review/:month/rounds/withdraw take it back before the auditor opens it
 *
 * There is no download or upload: the SK03 and รวมค่าคะแนน files stay in
 * Google Drive (the state carries their ids, the tab links them view only),
 * and a round is the newest build as the system checked it.
 *
 * The auditor (ผู้ตรวจสอบ) side and the auditee's answers are listed above
 * their routes further down.
 */

import type { Express, Request, Response } from "express"
import type { AxiosStatic } from "axios"

const core = require("./review-core") as {
  parseMonth(key: unknown): { be: number; month: number } | null
  parseBudget(v: unknown, max: number): number | null
  parseCount(v: unknown, max: number): number | null
  parseScore(v: unknown): number | null
}

type Actor = { sub: string; name: string }

export interface ReviewDeps {
  app: Express
  express: { json(opts: { limit: string }): any }
  axios: AxiosStatic
  supabaseUrl: string
  serviceHeaders(): Record<string, string>
  callServiceRpc(fn: string, args?: Record<string, unknown>): Promise<any>
  listRosterTables(): Promise<string[]>
  dashSession(req: Request): (Actor & { exp: number }) | null
  isDashOwner(sub: string): boolean
  audit(req: Request, actor: Actor, action: string, target?: Record<string, unknown>): Promise<void>
}

const BUCKET = "review-files"
// The tab starts at ส.ค. 2569: earlier months were paid before it existed.
const FIRST_MONTH = "2569_08"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The SQL functions' refusals, in the tab's words.
const REFUSALS: [RegExp, number, string][] = [
  [/no budget yet/, 409, "ยังไม่ได้กรอกงบประมาณและจำนวนแพทย์"],
  [/no build yet/, 409, "ยังไม่มีไฟล์ที่ระบบสร้างของเดือนนี้"],
  [/a build is on its way/, 409, "รอสร้างไฟล์ใหม่เสร็จก่อน"],
  [/blocking problem/, 409, "ไฟล์ล่าสุดยังมีปัญหาที่ต้องแก้ในระบบก่อนส่ง"],
  [/does not carry the typed numbers/, 409, "ไฟล์ล่าสุดยังไม่มีงบประมาณและจำนวนแพทย์ ที่กรอกไว้ กดสร้างใหม่ก่อน"],
  [/the build is out of date/, 409, "รายชื่อหรือคะแนนเปลี่ยนหลังสร้างไฟล์ล่าสุด กดสร้างใหม่ก่อนส่ง"],
  [/a score is out of range/, 409, "มีคะแนนผิดปกติ (30,000 ขึ้นไป หรือต่ำกว่า 2,200) แก้ก่อนส่ง"],
  [/bad budget/, 400, "งบประมาณ: ใส่ตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง"],
  [/bad doctors/, 400, "N: ต้องเป็นจำนวนเต็มมากกว่า 0"],
  [/per P4P out of range/, 400, "per P4P (งบประมาณ ÷ N) ต้องมากกว่า 0.00"],
  [/bad score/, 400, "คะแนน: ใส่ตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง"],
  [/the note is too long/, 400, "หมายเหตุไม่เกิน 500 ตัวอักษร"],
  [/not on the roster/, 404, "ไม่พบชื่อนี้ในรายชื่อเดือนนี้"],
  [/not the auditee's turn/, 409, "ส่งให้ผู้ตรวจสอบไปแล้ว รอผลตรวจก่อน"],
  [/nothing to withdraw/, 409, "ไม่มีรอบที่ส่งไว้ให้ดึงกลับ"],
  [/auditor has started/, 409, "ผู้ตรวจสอบเริ่มตรวจแล้ว ดึงกลับไม่ได้"],
  [/bad month/, 404, "ไม่พบเดือนนี้"],
  [/not the auditor's turn/, 409, "ยังไม่ใช่คิวผู้ตรวจสอบ (ส่งกลับแล้ว อนุมัติแล้ว หรือยังไม่ได้ส่งมา)"],
  [/a fix needs a remark/, 400, "ต้องแก้ไข ต้องมีหมายเหตุบอกว่าแก้อะไร"],
  [/someone is still to check/, 409, "ยังมีคนที่รอตรวจ ตรวจให้ครบก่อน"],
  [/nothing to fix/, 409, "ไม่มีคนที่ต้องแก้หรือปัญหาที่เปิดอยู่ ใช้ปุ่มอนุมัติแทน"],
  [/not everyone is approved/, 409, "ยังอนุมัติไม่ครบทุกคน"],
  [/a problem is still open/, 409, "ยังมีปัญหาอื่น ๆ ที่เปิดอยู่ ปิดก่อนอนุมัติ"],
  [/the auditee has started/, 409, "ผู้จัดทำเริ่มแก้แล้ว ดึงกลับไม่ได้"],
  [/not in this round/, 404, "ไม่พบในรอบนี้"],
  [/not approved/, 409, "เดือนนี้ยังไม่ได้อนุมัติ"],
  [/has not failed/, 409, "เอกสารไม่ได้สร้างไม่สำเร็จ ไม่ต้องสร้างใหม่"],
  [/a reopen needs a reason/, 400, "เขียนเหตุผลก่อน"],
  [/reason is too long/, 400, "เหตุผลไม่เกิน 1,000 ตัวอักษร"],
]

const pgError = (e: any): { code?: string; message?: string } => (e && e.response && e.response.data) || {}
// Part of the SQL is missing: no such function or table (PostgREST's schema
// cache), or one the installed functions use (an older copy of the file was
// run). Only these: PGRST002 ("Could not query the database for the schema
// cache. Retrying.") is the database being briefly unreachable, not missing.
const NOT_INSTALLED = ["PGRST202", "PGRST204", "PGRST205", "42P01", "42883", "42703"]
const notInstalled = (e: any): boolean => {
  const d = pgError(e)
  const code = String(d.code || "")
  if (NOT_INSTALLED.includes(code)) return true
  // An answer with no code at all: only the wording of a missing one.
  return !code && /^(relation|function|column) .+ does not exist|^could not find the (function|table) .+ in the schema cache/i
    .test(String(d.message || ""))
}
const NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งส่วนนี้ของแท็บตรวจสอบ ผู้ดูแลระบบต้องรันไฟล์ scripts/review-tab-2026-11.sql แล้ว scripts/review-tab-2026-11-auditee.sql ใน Supabase SQL editor"
// review_state says v: 2 once the second file has been run.
const SQL_VERSION = 2

// Is the newest build made with these numbers?
const inBuild = (b: any, budget: number, perP4p: number): boolean =>
  !!b && b.budget !== null && b.per_p4p !== null && Number(b.budget) === budget && Number(b.per_p4p) === perP4p
// The open request that will build with the numbers saved at savedAt, if
// any: a queued or dispatched one reads review_inputs after its run starts,
// a running one did only if it started after they were saved. (review_state
// already shows a request past its deadline as failed.)
const carrier = (q: any, savedAt: unknown): any => {
  if (!q) return null
  if (q.status === "queued" || q.status === "dispatched") return q
  const started = Date.parse(String(q.started_at || "")), saved = Date.parse(String(savedAt || ""))
  return q.status === "running" && started >= saved ? q : null
}

export function mountReview(d: ReviewDeps): void {
  const { app, axios } = d
  const rest = (p: string): string => d.supabaseUrl + "/rest/v1/" + p
  const storage = (p: string): string => d.supabaseUrl + "/storage/v1/" + p
  const json = (extra: Record<string, string> = {}) => ({ ...d.serviceHeaders(), "Content-Type": "application/json", ...extra })

  // Owner only, a real roster month, and the tables installed.
  const gate = async (req: Request, res: Response): Promise<{ s: Actor; month: string } | null> => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) { res.status(401).json({ error: "not authenticated" }); return null }
    if (!d.isDashOwner(s.sub)) { res.status(404).json({ error: "not found" }); return null }
    const month = String(req.params.month || "")
    if (req.params.month !== undefined) {
      if (!core.parseMonth(month) || month < FIRST_MONTH || !(await d.listRosterTables()).includes(month)) {
        res.status(404).json({ error: "ไม่พบเดือนนี้" }); return null
      }
    }
    return { s: { sub: s.sub, name: s.name }, month }
  }

  // Only the two loads (load = true) answer a missing install with 200
  // { installed: false }: the tab reads that and shows how to set it up.
  // Anything else must fail, since the browser only checks r.ok and would
  // otherwise report a save, a reopen or a list that never happened.
  const fail = (res: Response, what: string, e: any, load = false): void => {
    if (notInstalled(e)) {
      if (load) { res.json({ installed: false }); return }
      console.error("[dashboard] review " + what + ": not installed (" + String(pgError(e).code || "") + ")")
      res.status(503).json({ installed: false, error: NOT_INSTALLED_MSG }); return
    }
    const msg = String(pgError(e).message || "")
    const hit = REFUSALS.find(([re]) => re.test(msg))
    if (hit) { res.status(hit[1]).json({ error: hit[2] }); return }
    console.error("[dashboard] review " + what + " failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง" })
  }

  const state = (month: string): Promise<any> => d.callServiceRpc("review_state", { p_month: month })

  // No build may change once the auditor has it, or after approval.
  const auditeeTurn = (st: any): boolean => {
    const live = (st.rounds || []).find((r: any) => r.round_no === st.live)
    return !live || live.status === "returned"
  }

  app.get("/dashboard/api/review/months", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const tables = (await d.listRosterTables()).filter((t) => core.parseMonth(t) && t >= FIRST_MONTH).sort()
      const months = await d.callServiceRpc("review_months", { p_months: tables })
      res.json({ installed: true, months: months || [] })
    } catch (e: any) { fail(res, "months", e, true) }
  })

  app.get("/dashboard/api/review/:month", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const st = await state(g.month)
      // Only the first SQL file run: the tab says the second is needed.
      if (!st || st.v !== SQL_VERSION) return res.json({ installed: false })
      if (req.query.view === "1") await d.audit(req, g.s, "view.review", { month: g.month })
      res.json({ installed: true, ...st })
    } catch (e: any) { fail(res, "state", e, true) }
  })

  app.put("/dashboard/api/review/:month/inputs", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const budget = core.parseBudget(req.body && req.body.budget, 1e11)
    const doctors = core.parseCount(req.body && req.body.doctors, 1e5)
    if (budget === null) return res.status(400).json({ error: "งบประมาณ: ใส่จำนวนเต็มบาทมากกว่า 0 ไม่มีทศนิยม", field: "budget" })
    if (doctors === null) return res.status(400).json({ error: "N: ใส่จำนวนเต็มมากกว่า 0 ไม่มีทศนิยม", field: "doctors" })
    try {
      const st = await state(g.month)
      if (!auditeeTurn(st)) return res.status(409).json({ error: "ส่งให้ผู้ตรวจสอบแล้ว เปลี่ยนตัวเลขไม่ได้จนกว่าจะได้ผลตรวจ" })
      // per P4P = round(budget ÷ N, 2) is worked out by the SQL function.
      const saved = await d.callServiceRpc("review_save_inputs", { p_month: g.month, p_budget: budget, p_doctors: doctors, p_actor: g.s.name })
      const was = saved && saved.before, now = (saved && saved.after) || {}
      const before = was ? { budget: Number(was.budget), per_p4p: Number(was.per_p4p), doctors: was.doctors === null ? null : Number(was.doctors) } : null
      const perP4p = Number(now.per_p4p)
      // Saved, so on record now, even if asking for the build below fails.
      await d.audit(req, g.s, "review.inputs", { month: g.month, budget, doctors, per_p4p: perP4p, before })
      // A build is needed when the numbers in the SK03 (budget, per P4P)
      // changed, or when they did not (a retry after the build request
      // failed) but the newest build lacks them and no open request will
      // build with them. N on its own is not in the SK03.
      const changed = !before || before.budget !== budget || before.per_p4p !== perP4p
      const notBuilt = !changed && !inBuild(st.build, budget, perP4p)
      const open = notBuilt ? carrier(st.request, st.inputs && st.inputs.updated_at) : null
      const ask = changed || (notBuilt && !open)
      const request = ask
        ? await d.callServiceRpc("review_request_build", { p_month: g.month, p_reason: "inputs", p_actor: g.s.name })
        : open
      // changed: a build with these numbers is on its way (the tab's message).
      res.json({ ok: true, changed: ask || !!open, per_p4p: perP4p, request })
    } catch (e: any) { fail(res, "inputs", e) }
  })

  // One person's score: written to the month's roster table, logged as a
  // roster edit (so History shows it with the รายชื่อ tab's edits), and a
  // fresh build is queued. Only on the auditee's turn (the SQL checks).
  app.put("/dashboard/api/review/:month/scores/:index", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const index = String(req.params.index)
    if (!UUID_RE.test(index)) return res.status(404).json({ error: "ไม่พบชื่อนี้ในรายชื่อเดือนนี้" })
    const score = core.parseScore(req.body && req.body.score)
    if (score === null) return res.status(400).json({ error: "ใส่ตัวเลข เช่น 2,480.00", field: "score" })
    const note = typeof (req.body && req.body.note) === "string" ? req.body.note.trim() : ""
    if (note.length > 500) return res.status(400).json({ error: "หมายเหตุไม่เกิน 500 ตัวอักษร", field: "note" })
    try {
      const out = await d.callServiceRpc("review_edit_score", { p_month: g.month, p_index: index, p_score: score, p_note: note, p_actor: g.s.name })
      if (out && out.changed && out.edit) {
        await d.audit(req, g.s, "roster.edit", {
          month: g.month, index, physician: out.edit.name, via: "review",
          changes: { score: [out.edit.old_score, out.edit.new_score] }, ...(note ? { note } : {}),
        })
      }
      res.json({ ok: true, changed: !!(out && out.changed), edit: (out && out.edit) || null, request: (out && out.request) || null })
    } catch (e: any) { fail(res, "score", e) }
  })

  // Everyone in the newest build: the auditee's list.
  app.get("/dashboard/api/review/:month/list", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      res.json(await d.callServiceRpc("review_auditee_people", { p_month: g.month }))
    } catch (e: any) { fail(res, "list", e) }
  })

  app.post("/dashboard/api/review/:month/rebuild", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const st = await state(g.month)
      if (!auditeeTurn(st)) return res.status(409).json({ error: "ส่งให้ผู้ตรวจสอบแล้ว สร้างไฟล์ใหม่ไม่ได้จนกว่าจะได้ผลตรวจ" })
      const request = await d.callServiceRpc("review_request_build", { p_month: g.month, p_reason: "rebuild", p_actor: g.s.name })
      await d.audit(req, g.s, "review.rebuild", { month: g.month, request: request && request.id })
      res.json({ ok: true, request })
    } catch (e: any) { fail(res, "rebuild", e) }
  })

  app.post("/dashboard/api/review/:month/rounds", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const round = await d.callServiceRpc("review_submit_round", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.submit", { month: g.month, round: round && round.round_no })
      res.json({ ok: true, round })
    } catch (e: any) { fail(res, "submit", e) }
  })

  app.post("/dashboard/api/review/:month/rounds/withdraw", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const roundNo = await d.callServiceRpc("review_withdraw_round", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.withdraw", { month: g.month, round: roundNo })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "withdraw", e) }
  })

  // ── The auditor's side, and the auditee's answers ─────────────────────
  //   GET  /dashboard/api/review/:month/people?round=N   everyone in a round (live round by default)
  //   GET  /dashboard/api/review/:month/person/:round/:index   their sheet and department row
  //   POST /dashboard/api/review/:month/opened           {role} the auditor / auditee opened the round
  //   PUT  /dashboard/api/review/:month/decisions/:index {decision: approve|fix|null, remark}
  //   PUT  /dashboard/api/review/:month/replies/:index   {reply} the auditee's answer to a ต้องแก้ไข
  //   POST /dashboard/api/review/:month/return | unreturn | approve
  //   GET  /dashboard/api/review/:month/issues
  //   POST /dashboard/api/review/:month/issues           {index?, body}
  //   POST /dashboard/api/review/:month/issues/:id/replies  {role, body}
  //   POST /dashboard/api/review/:month/issues/:id/status   {open}
  // A person's name for the History tab (the decision routes only get the roster index).
  const personName = async (index: string): Promise<string> => {
    try {
      const r = await axios.get(rest("review_build_people?select=name&roster_index=eq." + index + "&limit=1"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      return String(((r.data as any[])[0] || {}).name || "")
    } catch { return "" }
  }

  const text = (v: unknown, max: number): string | null => {
    const t = typeof v === "string" ? v.trim() : ""
    return t && t.length <= max ? t : null
  }

  app.get("/dashboard/api/review/:month/people", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const round = /^[1-9][0-9]{0,3}$/.test(String(req.query.round || "")) ? Number(req.query.round) : null
    try {
      res.json(await d.callServiceRpc("review_people", { p_month: g.month, p_round: round }))
    } catch (e: any) { fail(res, "people", e) }
  })

  app.get("/dashboard/api/review/:month/person/:round/:index", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const round = String(req.params.round), index = String(req.params.index)
    if (!/^[1-9][0-9]{0,3}$/.test(round) || !UUID_RE.test(index)) return res.status(404).json({ error: "ไม่พบในรอบนี้" })
    try {
      res.json(await d.callServiceRpc("review_person", { p_month: g.month, p_round: Number(round), p_index: index }))
    } catch (e: any) { fail(res, "person", e) }
  })

  app.post("/dashboard/api/review/:month/opened", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const role = req.body && req.body.role
    if (role !== "auditor" && role !== "auditee") return res.status(400).json({ error: "bad role" })
    try {
      await d.callServiceRpc("review_mark_opened", { p_month: g.month, p_role: role })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "opened", e) }
  })

  app.put("/dashboard/api/review/:month/decisions/:index", d.express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const index = String(req.params.index)
    const decision = req.body ? req.body.decision : undefined
    if (!UUID_RE.test(index) || !(decision === "approve" || decision === "fix" || decision === null)) {
      return res.status(400).json({ error: "bad decision" })
    }
    const remark = decision === "fix" ? text(req.body.remark, 1000) : ""
    if (remark === null) return res.status(400).json({ error: "ต้องแก้ไข ต้องมีหมายเหตุบอกว่าแก้อะไร (ไม่เกิน 1,000 ตัวอักษร)" })
    try {
      const row = await d.callServiceRpc("review_decide", { p_month: g.month, p_index: index, p_decision: decision, p_remark: remark, p_actor: g.s.name })
      await d.audit(req, g.s, "review.decide", { month: g.month, index, physician: await personName(index), decision, remark })
      res.json({ ok: true, decision: row })
    } catch (e: any) { fail(res, "decide", e) }
  })

  app.put("/dashboard/api/review/:month/replies/:index", d.express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const index = String(req.params.index)
    const reply = typeof (req.body && req.body.reply) === "string" ? req.body.reply.trim() : ""
    if (!UUID_RE.test(index) || reply.length > 1000) return res.status(400).json({ error: "คำตอบไม่เกิน 1,000 ตัวอักษร" })
    try {
      await d.callServiceRpc("review_reply_decision", { p_month: g.month, p_index: index, p_reply: reply, p_actor: g.s.name })
      await d.audit(req, g.s, "review.reply", { month: g.month, index, physician: await personName(index), reply })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "reply", e) }
  })

  const roundAction = (path: string, fn: string, action: string): void => {
    app.post("/dashboard/api/review/:month/" + path, async (req: Request, res: Response) => {
      const g = await gate(req, res)
      if (!g) return
      try {
        const round = await d.callServiceRpc(fn, { p_month: g.month, p_actor: g.s.name })
        await d.audit(req, g.s, action, { month: g.month, round: round && round.round_no })
        res.json({ ok: true, round })
      } catch (e: any) { fail(res, path, e) }
    })
  }
  roundAction("return", "review_return_round", "review.return")
  roundAction("unreturn", "review_unreturn_round", "review.unreturn")
  roundAction("approve", "review_approve_round", "review.approve")

  // The approval document (process/review-pdf.ts, workflow 2.8).
  app.get("/dashboard/api/review/:month/pdf", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const r = await axios.get(rest("review_rounds?select=round_no,pdf_status,pdf_path&month=eq." + g.month + "&status=eq.approved"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const row = (r.data as any[])[0]
      if (!row || row.pdf_status !== "ready" || !row.pdf_path) return res.status(404).json({ error: "เอกสารยังไม่พร้อม" })
      const signed = await axios.post(storage("object/sign/" + BUCKET + "/" + row.pdf_path), { expiresIn: 120 },
        { headers: json(), timeout: 8000 })
      await d.audit(req, g.s, "review.download", { month: g.month, kind: "pdf", round: row.round_no })
      // Opens in the browser's PDF viewer (the tab links it in a new tab);
      // ?download=1 saves it under a readable name instead.
      res.redirect(302, d.supabaseUrl + "/storage/v1" + signed.data.signedURL +
        (req.query.download === "1" ? "&download=" + encodeURIComponent("P4P_" + g.month + "_approved.pdf") : ""))
    } catch (e: any) { fail(res, "pdf download", e) }
  })

  app.post("/dashboard/api/review/:month/pdf/retry", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const round = await d.callServiceRpc("review_retry_pdf", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.pdf_retry", { month: g.month, round: round && round.round_no })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "pdf retry", e) }
  })

  // ยกเลิกเอกสารและเปิดตรวจอีกครั้ง: the round goes back to the auditor and
  // the cancelled PDF is deleted, so no old link can fetch it.
  app.post("/dashboard/api/review/:month/reopen", d.express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const reason = text(req.body && req.body.reason, 1000)
    if (!reason) return res.status(400).json({ error: "เขียนเหตุผลก่อน (ไม่เกิน 1,000 ตัวอักษร)" })
    try {
      const out = await d.callServiceRpc("review_reopen_round", { p_month: g.month, p_reason: reason, p_actor: g.s.name })
      if (out && out.old_pdf) {
        await axios.delete(storage("object/" + BUCKET), { headers: json(), data: { prefixes: [out.old_pdf] }, timeout: 8000 })
          .catch((e: any) => console.error("[dashboard] review: could not delete the cancelled PDF:", e.message))
      }
      await d.audit(req, g.s, "review.reopen", { month: g.month, round: out && out.round_no, reason })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "reopen", e) }
  })

  app.get("/dashboard/api/review/:month/issues", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      res.json({ issues: (await d.callServiceRpc("review_issue_list", { p_month: g.month })) || [] })
    } catch (e: any) { fail(res, "issues", e) }
  })

  app.post("/dashboard/api/review/:month/issues", d.express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const body = text(req.body && req.body.body, 2000)
    const index = req.body && req.body.index ? String(req.body.index) : null
    if (!body || (index !== null && !UUID_RE.test(index))) return res.status(400).json({ error: "พิมพ์รายละเอียดของปัญหา (ไม่เกิน 2,000 ตัวอักษร)" })
    try {
      const issue = await d.callServiceRpc("review_add_issue", { p_month: g.month, p_index: index, p_body: body, p_actor: g.s.name })
      await d.audit(req, g.s, "review.issue", { month: g.month, id: issue && issue.id, body })
      res.json({ ok: true, issue })
    } catch (e: any) { fail(res, "issue", e) }
  })

  app.post("/dashboard/api/review/:month/issues/:id/replies", d.express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const id = String(req.params.id)
    const role = req.body && req.body.role
    const body = text(req.body && req.body.body, 2000)
    if (!/^[1-9][0-9]{0,17}$/.test(id) || (role !== "auditor" && role !== "auditee") || !body) {
      return res.status(400).json({ error: "พิมพ์คำตอบ (ไม่เกิน 2,000 ตัวอักษร)" })
    }
    try {
      await d.callServiceRpc("review_issue_reply", { p_month: g.month, p_issue: Number(id), p_role: role, p_body: body, p_actor: g.s.name })
      await d.audit(req, g.s, "review.issue_reply", { month: g.month, id: Number(id), role, body })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "issue reply", e) }
  })

  app.post("/dashboard/api/review/:month/issues/:id/status", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const id = String(req.params.id)
    const open = req.body && req.body.open === true
    if (!/^[1-9][0-9]{0,17}$/.test(id)) return res.status(404).json({ error: "ไม่พบในรอบนี้" })
    try {
      await d.callServiceRpc("review_issue_status", { p_month: g.month, p_issue: Number(id), p_open: open, p_actor: g.s.name })
      await d.audit(req, g.s, open ? "review.issue_open" : "review.issue_close", { month: g.month, id: Number(id) })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "issue status", e) }
  })
}

;(module as NodeModule).exports = { mountReview }
