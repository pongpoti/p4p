/**
 * lib/review-server.ts
 *
 * The /dashboard/ ตรวจสอบ (review) tab's API, owner only like รายชื่อ and
 * ประวัติการใช้งาน (anyone else gets 404). Mounted from main.ts with its
 * helpers passed in, so this file has no secrets or settings of its own.
 *
 * Tables, functions and the private bucket review-files come from
 * scripts/review-tab-2026-11.sql; until that has been run every route
 * answers { installed: false } and the tab says so.
 *
 * The auditee (ผู้จัดทำ) side:
 *   GET  /dashboard/api/review/months                 month picker
 *   GET  /dashboard/api/review/:month                 the month's state (?view=1 logs the visit)
 *   PUT  /dashboard/api/review/:month/inputs          budget + per P4P, then a fresh build
 *   POST /dashboard/api/review/:month/rebuild         a fresh build (workflow 2.2 via the relay)
 *   GET  /dashboard/api/review/:month/file/:build/:kind   download (302 to a short signed URL)
 *   POST /dashboard/api/review/:month/uploads         start an upload: signed URL straight to Storage
 *   POST /dashboard/api/review/:month/uploads/:id/verify  which build the uploaded file is, by SHA-256
 *   POST /dashboard/api/review/:month/rounds          send the round to the auditor
 *   POST /dashboard/api/review/:month/rounds/withdraw take it back before the auditor opens it
 *
 * Files go browser ⇄ Storage directly with signed URLs: a Vercel function
 * takes at most ~4.5 MB in a request body, and these files can be larger.
 */

import type { Express, Request, Response } from "express"
import type { AxiosStatic } from "axios"

const crypto = require("crypto") as typeof import("crypto")
const core = require("./review-core") as {
  uploadMatch(kind: "sk03" | "merged", sha: string, builds: BuildRow[]): { result: string; build: BuildRow | null }
  parseMonth(key: unknown): { be: number; month: number } | null
  parseMoney(v: unknown, max: number): number | null
}

interface BuildRow { id: string; built_at: string; sk03_sha256: string; merged_sha256: string }
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
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const MAX_BYTES = 50 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The SQL functions' refusals, in the tab's words.
const REFUSALS: [RegExp, number, string][] = [
  [/no budget yet/, 409, "ยังไม่ได้กรอกงบประมาณและ per P4P"],
  [/no build yet/, 409, "ยังไม่มีไฟล์ที่ระบบสร้างของเดือนนี้"],
  [/not the latest build/, 409, "ไฟล์ที่อัปโหลดไม่ใช่ไฟล์ล่าสุดที่ระบบสร้าง ดาวน์โหลดใหม่แล้วอัปโหลดอีกครั้ง"],
  [/blocking problem/, 409, "ไฟล์ล่าสุดยังมีปัญหาที่ต้องแก้ในระบบก่อนส่ง"],
  [/does not carry the typed numbers/, 409, "ไฟล์ล่าสุดยังไม่มีงบประมาณและ per P4P ที่กรอกไว้ กดสร้างไฟล์ใหม่ก่อน"],
  [/not the auditee's turn/, 409, "ส่งให้ผู้ตรวจสอบไปแล้ว รอผลตรวจก่อน"],
  [/nothing to withdraw/, 409, "ไม่มีรอบที่ส่งไว้ให้ดึงกลับ"],
  [/auditor has started/, 409, "ผู้ตรวจสอบเริ่มตรวจแล้ว ดึงกลับไม่ได้"],
  [/bad month/, 404, "ไม่พบเดือนนี้"],
]

const pgError = (e: any): { code?: string; message?: string } => (e && e.response && e.response.data) || {}
const notInstalled = (e: any): boolean => {
  const d = pgError(e)
  return ["PGRST202", "PGRST205", "42P01", "42883"].includes(String(d.code)) ||
    /does not exist|schema cache/i.test(String(d.message || ""))
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
      if (!core.parseMonth(month) || !(await d.listRosterTables()).includes(month)) {
        res.status(404).json({ error: "ไม่พบเดือนนี้" }); return null
      }
    }
    return { s: { sub: s.sub, name: s.name }, month }
  }

  const fail = (res: Response, what: string, e: any): void => {
    if (notInstalled(e)) { res.json({ installed: false }); return }
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
      const tables = (await d.listRosterTables()).filter((t) => core.parseMonth(t)).sort().reverse().slice(0, 12)
      const months = await d.callServiceRpc("review_months", { p_months: tables })
      res.json({ installed: true, months: months || [] })
    } catch (e: any) { fail(res, "months", e) }
  })

  app.get("/dashboard/api/review/:month", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    try {
      const st = await state(g.month)
      if (req.query.view === "1") await d.audit(req, g.s, "view.review", { month: g.month })
      res.json({ installed: true, ...st })
    } catch (e: any) { fail(res, "state", e) }
  })

  app.put("/dashboard/api/review/:month/inputs", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const budget = core.parseMoney(req.body && req.body.budget, 1e11)
    const perP4p = core.parseMoney(req.body && req.body.per_p4p, 1e7)
    if (budget === null || perP4p === null) {
      return res.status(400).json({ error: "กรอกตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง" })
    }
    try {
      const st = await state(g.month)
      if (!auditeeTurn(st)) return res.status(409).json({ error: "ส่งให้ผู้ตรวจสอบแล้ว เปลี่ยนตัวเลขไม่ได้จนกว่าจะได้ผลตรวจ" })
      const before = st.inputs ? { budget: Number(st.inputs.budget), per_p4p: Number(st.inputs.per_p4p) } : null
      await axios.post(rest("review_inputs?on_conflict=month"),
        { month: g.month, budget, per_p4p: perP4p, updated_at: new Date().toISOString(), updated_by: g.s.name },
        { headers: json({ Prefer: "resolution=merge-duplicates,return=minimal" }), timeout: 8000 })
      const changed = !before || before.budget !== budget || before.per_p4p !== perP4p
      const request = changed
        ? await d.callServiceRpc("review_request_build", { p_month: g.month, p_reason: "inputs", p_actor: g.s.name })
        : null
      await d.audit(req, g.s, "review.inputs", { month: g.month, budget, per_p4p: perP4p, before })
      res.json({ ok: true, changed, request })
    } catch (e: any) { fail(res, "inputs", e) }
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

  app.get("/dashboard/api/review/:month/file/:build/:kind", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const build = String(req.params.build), kind = String(req.params.kind)
    if (!UUID_RE.test(build) || (kind !== "sk03" && kind !== "merged")) return res.status(404).json({ error: "ไม่พบไฟล์" })
    try {
      const r = await axios.get(rest("review_builds?select=id,month," + kind + "_path&id=eq." + build + "&month=eq." + g.month),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const row = (r.data as any[])[0]
      if (!row) return res.status(404).json({ error: "ไม่พบไฟล์" })
      const objectPath: string = row[kind + "_path"]
      const signed = await axios.post(storage("object/sign/" + BUCKET + "/" + objectPath), { expiresIn: 120 },
        { headers: json(), timeout: 8000 })
      const name = (kind === "sk03" ? "SK03_" : "merged_") + g.month + ".xlsx"
      await d.audit(req, g.s, "review.download", { month: g.month, kind, build })
      res.redirect(302, d.supabaseUrl + "/storage/v1" + signed.data.signedURL + "&download=" + encodeURIComponent(name))
    } catch (e: any) { fail(res, "download", e) }
  })

  app.post("/dashboard/api/review/:month/uploads", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const kind = req.body && req.body.kind
    const bytes = Number(req.body && req.body.bytes)
    const fileName = String((req.body && req.body.fileName) || "").slice(0, 200)
    if (kind !== "sk03" && kind !== "merged") return res.status(400).json({ error: "bad kind" })
    if (!/\.xlsx$/i.test(fileName)) return res.status(400).json({ error: "เลือกไฟล์ .xlsx" })
    if (!(bytes > 0 && bytes <= MAX_BYTES)) return res.status(400).json({ error: "ไฟล์ต้องไม่เกิน 50 MB" })
    try {
      const st = await state(g.month)
      if (!auditeeTurn(st)) return res.status(409).json({ error: "ส่งให้ผู้ตรวจสอบแล้ว อัปโหลดไม่ได้จนกว่าจะได้ผลตรวจ" })
      const id = crypto.randomUUID()
      const objectPath = "uploads/" + g.month + "/" + id + ".xlsx"
      await axios.post(rest("review_uploads"),
        { id, month: g.month, kind, path: objectPath, file_name: fileName, bytes, created_by: g.s.name },
        { headers: json({ Prefer: "return=minimal" }), timeout: 8000 })
      const signed = await axios.post(storage("object/upload/sign/" + BUCKET + "/" + objectPath), {},
        { headers: json(), timeout: 8000 })
      res.json({ id, url: d.supabaseUrl + "/storage/v1" + signed.data.url, contentType: XLSX })
    } catch (e: any) { fail(res, "upload", e) }
  })

  app.post("/dashboard/api/review/:month/uploads/:id/verify", async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const id = String(req.params.id || "")
    if (!UUID_RE.test(id)) return res.status(404).json({ error: "ไม่พบไฟล์" })
    try {
      const u = await axios.get(rest("review_uploads?select=id,kind,path,file_name,verified_at&id=eq." + id + "&month=eq." + g.month),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const row = (u.data as any[])[0]
      if (!row) return res.status(404).json({ error: "ไม่พบไฟล์" })
      let file: Buffer
      try {
        const obj = await axios.get(storage("object/" + BUCKET + "/" + row.path),
          { headers: d.serviceHeaders(), responseType: "arraybuffer", timeout: 25000, maxContentLength: MAX_BYTES + 1 })
        file = Buffer.from(obj.data)
      } catch (e: any) {
        if (e.response && (e.response.status === 400 || e.response.status === 404)) {
          return res.status(409).json({ error: "อัปโหลดไม่สำเร็จ ลองเลือกไฟล์อีกครั้ง" })
        }
        throw e
      }
      const sha = crypto.createHash("sha256").update(file).digest("hex")
      const b = await axios.get(rest("review_builds?select=id,built_at,sk03_sha256,merged_sha256&month=eq." + g.month + "&order=built_at.desc"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const m = core.uploadMatch(row.kind, sha, b.data as BuildRow[])
      await axios.patch(rest("review_uploads?id=eq." + id),
        { verified_at: new Date().toISOString(), sha256: sha, bytes: file.length, build_id: m.build ? m.build.id : null, result: m.result },
        { headers: json({ Prefer: "return=minimal" }), timeout: 8000 })
      await d.audit(req, g.s, "review.upload", { month: g.month, kind: row.kind, result: m.result, file: row.file_name })
      res.json({ ok: true, result: m.result, buildId: m.build ? m.build.id : null, builtAt: m.build ? m.build.built_at : null })
    } catch (e: any) { fail(res, "verify", e) }
  })

  app.post("/dashboard/api/review/:month/rounds", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const sk03 = String((req.body && req.body.sk03) || "")
    const merged = String((req.body && req.body.merged) || "")
    if (!UUID_RE.test(sk03) || !UUID_RE.test(merged)) return res.status(400).json({ error: "เลือกไฟล์ทั้งสองไฟล์ก่อน" })
    try {
      const round = await d.callServiceRpc("review_submit_round", { p_month: g.month, p_sk03: sk03, p_merged: merged, p_actor: g.s.name })
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
}

;(module as NodeModule).exports = { mountReview }
