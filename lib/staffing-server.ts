/**
 * lib/staffing-server.ts
 *
 * The /dashboard/ อัตรากำลัง (Staffing) tab's API (Pong, 2026-11-16): each
 * STAFF department's physician staffing and its department multiplier, and
 * the owner's edits to the numbers (the tab locks FTE and sends it
 * unchanged; the API still takes all three). Mounted from main.ts with its
 * helpers passed in, so this file has no secrets or settings of its own.
 *
 *   GET /dashboard/api/staffing         every department, in the SK03 order
 *                                       (?view=1 logs the visit); any
 *                                       dashboard user. canEdit: the owner.
 *   PUT /dashboard/api/staffing/:code   {fte, staff, monthly, daily}: one
 *                                       department, owner only (404 for
 *                                       anyone else)
 *
 * The numbers live in the Supabase table dept_staffing, saved through
 * staffing_save (scripts/dept-staffing-2026-11.sql). Until that file has
 * been run the list is the starting numbers of lib/dept-staffing.ts with
 * installed: false, and a save answers 503 saying what to run. A table made
 * before the monthly-hires column (2026-11-17) is read as it is, with
 * monthly 0 and needsUpdate: true, and a save answers 503 the same way
 * until the file has been run again. Every save is
 * in ประวัติการใช้งาน as staffing.save, with the numbers and multiplier
 * before and after. When a number changed, staffing_save also queues a new
 * build of every ตรวจสอบ month still on the auditee's side (rebuild: those
 * months), so none is sent with pay from the old numbers; any other month
 * uses the new numbers on its next build (process/process.ts loadDeptStaffing).
 */

import type { Express, Request, Response } from "express"
import type { AxiosStatic } from "axios"

const staffing = require("./dept-staffing") as typeof import("./dept-staffing")

export interface StaffingDeps {
  app: Express
  express: { json(opts?: { limit?: string }): any }
  axios: Pick<AxiosStatic, "get">
  supabaseUrl: string
  serviceHeaders(): Record<string, string>
  callServiceRpc(fn: string, args?: Record<string, unknown>): Promise<any>
  dashSession(req: Request): { sub: string; name: string; exp: number } | null
  isDashOwner(sub: string): boolean
  audit(req: Request, actor: { sub: string; name: string }, action: string, target?: Record<string, unknown>): Promise<void>
}

// PostgREST / Postgres answers that mean the SQL file has not been run yet.
const NOT_INSTALLED = ["PGRST202", "PGRST205", "42P01", "42883"]
const pgError = (e: any): Record<string, unknown> => (e && e.response && e.response.data) || {}
const notInstalled = (e: any): boolean => {
  const d = pgError(e)
  const code = String(d.code || "")
  if (NOT_INSTALLED.includes(code)) return true
  return !code && /^(relation|function) .+ does not exist|^could not find the (function|table) .+ in the schema cache/i
    .test(String(d.message || ""))
}
const NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งการบันทึกอัตรากำลัง ผู้ดูแลระบบต้องรันไฟล์ scripts/dept-staffing-2026-11.sql ใน Supabase SQL editor"
const FIELD_ERROR: Record<"fte" | "staff" | "monthly" | "daily", string> = {
  fte: "FTE: ใส่จำนวนเต็ม 1 ถึง 999",
  staff: "มีจริง: ใส่จำนวนเต็ม 0 ถึง 999",
  monthly: "จ้างรายเดือน: ใส่จำนวนเต็ม 0 ถึง 999",
  daily: "จ้างรายวัน: ใส่จำนวนเต็ม 0 ถึง 999",
}
const FIELDS = ["fte", "staff", "monthly", "daily"] as const

type Counts = { fte: number; staff: number; monthly: number; daily: number }
const round4 = (n: number): number => Math.round(n * 10000) / 10000
/** One department as the tab shows it: the numbers, lack and multiplier (4 decimals). */
const withMultiplier = (d: import("./dept-staffing").DeptStaffingRow) => ({
  ...d,
  lack: round4(staffing.deptLack(d)),
  multiplier: round4(staffing.deptMultiplier(d)),
})
// A row from before the monthly column has none: 0 (its staff still counts them).
const countsOf = (r: any): Counts | null =>
  r ? { fte: Number(r.fte), staff: Number(r.staff), monthly: Number(r.monthly ?? 0), daily: Number(r.daily) } : null
/** The months staffing_save queued a build of (YYYY_MM, oldest first). */
const monthsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && /^\d{4}_\d{2}$/.test(m)) : []

export function mountStaffing(d: StaffingDeps): void {
  const { app } = d

  app.get("/dashboard/api/staffing", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    const logged = req.query.view === "1" ? d.audit(req, s, "view.staffing") : Promise.resolve()
    let installed = true
    let rows: unknown = []
    try {
      // select=*: a table made before the monthly column still reads.
      const r = await d.axios.get(d.supabaseUrl + "/rest/v1/dept_staffing?select=*",
        { headers: d.serviceHeaders(), timeout: 8000 })
      rows = r.data
    } catch (e: any) {
      if (!notInstalled(e)) {
        await logged
        console.error("[dashboard] staffing read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
        return res.status(500).json({ error: "โหลดอัตรากำลังไม่สำเร็จ" })
      }
      installed = false
    }
    await logged
    const merged = staffing.mergeStaffing(rows)
    res.json({
      installed,
      needsUpdate: installed && merged.noMonthly.length > 0,
      canEdit: d.isDashOwner(s.sub),
      k: staffing.LACK_K,
      source: staffing.STAFFING_SOURCE,
      limits: staffing.STAFFING_LIMITS,
      depts: merged.list.map(withMultiplier),
    })
  })

  app.put("/dashboard/api/staffing/:code", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    if (!d.isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
    const dept = staffing.staffingDept(String(req.params.code || ""))
    if (!dept) return res.status(404).json({ error: "ไม่พบกลุ่มงานนี้" })
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>
    const next: Partial<Counts> = {}
    for (const f of FIELDS) {
      const v = staffing.parseStaffCount(body[f], f)
      if (v === null) return res.status(400).json({ error: FIELD_ERROR[f], field: f })
      next[f] = v
    }
    const counts = next as Counts
    try {
      const out = await d.callServiceRpc("staffing_save", {
        p_code: dept.code, p_fte: counts.fte, p_staff: counts.staff, p_monthly: counts.monthly, p_daily: counts.daily,
        p_actor: s.name,
      })
      const before = countsOf(out && out.before)
      const after = countsOf(out && out.after) || counts
      // A department never saved before had the starting numbers.
      const was = before || { fte: dept.fte, staff: dept.staff, monthly: dept.monthly, daily: dept.daily }
      const rebuild = monthsOf(out && out.rebuild)
      await d.audit(req, { sub: s.sub, name: s.name }, "staffing.save", {
        code: dept.code, name: dept.name, before: was, after, k: staffing.LACK_K,
        multiplier_before: round4(staffing.deptMultiplier(was)), multiplier_after: round4(staffing.deptMultiplier(after)),
        rebuild,
      })
      const row = {
        ...dept, ...after,
        updated_at: (out && out.after && out.after.updated_at) || null,
        updated_by: (out && out.after && out.after.updated_by) || s.name,
      }
      res.json({ ok: true, dept: withMultiplier(row), rebuild })
    } catch (e: any) {
      if (notInstalled(e)) {
        console.error("[dashboard] staffing save: not installed (" + String(pgError(e).code || "") + ")")
        return res.status(503).json({ installed: false, error: NOT_INSTALLED_MSG })
      }
      console.error("[dashboard] staffing save failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      res.status(500).json({ error: "บันทึกไม่สำเร็จ กรุณาลองใหม่" })
    }
  })
}
