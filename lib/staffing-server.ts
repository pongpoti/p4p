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
 *   PUT /dashboard/api/staffing/:code   {fte, staff, monthly, daily,
 *                                       absent}: one department, owner only
 *                                       (404 for anyone else). Since
 *                                       2026-11-28 the tab sends the saved
 *                                       monthly and daily hires unchanged:
 *                                       they are not in the multiplier.
 *   GET /dashboard/api/staffing/report  the staffing report PDF (Pong,
 *                                       2026-11-28: "add download button
 *                                       for pdf on dashboard"): a signed
 *                                       Storage link saved under its name
 *                                       (?link=1 answers {url, name}); any
 *                                       user who sees the tab
 *   POST /dashboard/api/staffing/report the owner uploads it (the PDF
 *                                       itself as the body, its name in
 *                                       X-File-Name); it replaces the last
 *
 * The report is review-files/staffing/report.pdf (the private bucket of
 * scripts/review-tab-2026-11.sql, which takes PDFs). Its name, size, when
 * and by whom come from the last staffing.report row of the audit log
 * (the upload writes it), so no SQL file is needed for it.
 *
 * The numbers live in the Supabase table dept_staffing, saved through
 * staffing_save (scripts/dept-staffing-2026-11.sql). Until that file has
 * been run the list is the starting numbers of lib/dept-staffing.ts with
 * installed: false, and a save answers 503 saying what to run. A table made
 * before the monthly-hires column (2026-11-17) is read as it is, with
 * monthly 0 and needsUpdate: true, and a save answers 503 the same way
 * until the file has been run again. ไม่ได้ปฏิบัติงาน (absent, 2026-11-26)
 * is read the same way: before scripts/dept-staffing-absent-2026-11.sql
 * (step 33) the list has the starting numbers with needsAbsent: true, and a
 * save answers 503 naming that file. absent is shown only: it is not in the
 * multiplier and a change to it alone queues no build. Every save is
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
  express: { json(opts?: { limit?: string }): any; raw(opts: { limit: string; type: (req: any) => boolean }): any }
  axios: Pick<AxiosStatic, "get" | "post">
  supabaseUrl: string
  serviceHeaders(): Record<string, string>
  callServiceRpc(fn: string, args?: Record<string, unknown>): Promise<any>
  dashSession(req: Request): { sub: string; name: string; exp: number; perms?: string[] } | null
  isDashOwner(sub: string): boolean
  /** The อัตรากำลัง view right (main.ts's path gate checks it too). */
  canView?(s: { sub: string; name: string; exp: number; perms?: string[] }): boolean
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
// The table is there but staffing_save does not take p_absent yet (step 33 not run).
const NO_ABSENT_MSG = "ยังไม่ได้ติดตั้งช่องไม่ได้ปฏิบัติงาน ผู้ดูแลระบบต้องรันไฟล์ scripts/dept-staffing-absent-2026-11.sql ใน Supabase SQL editor"
const FIELD_ERROR: Record<"fte" | "staff" | "monthly" | "daily" | "absent", string> = {
  fte: "FTE: ใส่จำนวนเต็ม 1 ถึง 999",
  staff: "ข้าราชการ: ใส่จำนวนเต็ม 0 ถึง 999",
  monthly: "จ้างรายเดือน: ใส่จำนวนเต็ม 0 ถึง 999",
  daily: "จ้างรายวัน: ใส่จำนวนเต็ม 0 ถึง 999",
  absent: "ไม่ได้ปฏิบัติงาน: ใส่จำนวนเต็ม 0 ถึง 999",
}
const FIELDS = ["fte", "staff", "monthly", "daily", "absent"] as const

// The staffing report PDF (2026-11-28).
const BUCKET = "review-files"
const REPORT_PATH = "staffing/report.pdf"
// Vercel takes a request body up to about 4.5 MB; the report is about 0.2 MB.
const REPORT_MAX_BYTES = 4 * 1024 * 1024
const REPORT_DEFAULT_NAME = "รายงานอัตรากำลังแพทย์จำแนกตามกลุ่มงาน.pdf"
export interface StaffingReport { name: string; bytes: number | null; uploaded_at: string | null; uploaded_by: string }
/** The file name as typed or stored: no folders or control characters, at most 150 characters, ending .pdf. */
export function reportName(v: unknown): string {
  let n = ""
  if (typeof v === "string") {
    try { n = decodeURIComponent(v) } catch { n = v }
  }
  n = n.split(/[/\\]/).pop() || ""
  // eslint-disable-next-line no-control-regex -- control characters are what it takes out
  n = n.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim()
  if (!n.replace(/\.pdf$/i, "").replace(/[.\s]/g, "")) return REPORT_DEFAULT_NAME
  if (!/\.pdf$/i.test(n)) n = n.slice(0, 146) + ".pdf"
  if (n.length > 150) n = n.slice(0, 146).trim() + ".pdf"
  return n
}
/** The last staffing.report row of the audit log, as the tab shows it (null: none, or unreadable). */
const reportOf = (rows: unknown): StaffingReport | null => {
  const r = Array.isArray(rows) ? rows[0] : null
  const t = r && r.target && typeof r.target === "object" ? r.target : null
  if (!t || typeof t.name !== "string") return null
  return {
    name: reportName(t.name),
    bytes: Number.isInteger(t.bytes) ? t.bytes : null,
    uploaded_at: typeof r.created_at === "string" ? r.created_at : null,
    uploaded_by: typeof r.actor_name === "string" ? r.actor_name : "",
  }
}

type Counts = { fte: number; staff: number; monthly: number; daily: number; absent: number }
const round4 = (n: number): number => Math.round(n * 10000) / 10000
/** One department as the tab shows it: the numbers, lack and multiplier (4 decimals). */
const withMultiplier = (d: import("./dept-staffing").DeptStaffingRow) => ({
  ...d,
  lack: round4(staffing.deptLack(d)),
  multiplier: round4(staffing.deptMultiplier(d)),
})
// A row from before the monthly column has none: 0 (its staff still counts them).
// One from before the absent column (step 33) has none either: the number sent.
const countsOf = (r: any, absent: number): Counts | null =>
  r ? { fte: Number(r.fte), staff: Number(r.staff), monthly: Number(r.monthly ?? 0), daily: Number(r.daily),
        absent: Number(r.absent ?? absent) } : null
/** The months staffing_save queued a build of (YYYY_MM, oldest first). */
const monthsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && /^\d{4}_\d{2}$/.test(m)) : []

export function mountStaffing(d: StaffingDeps): void {
  const { app } = d
  const storage = (p: string): string => d.supabaseUrl + "/storage/v1/" + p
  // The report's name and who uploaded it; null when there is none, or the read fails (the tab then offers no download).
  const readReport = async (): Promise<StaffingReport | null> => {
    try {
      const r = await d.axios.get(d.supabaseUrl + "/rest/v1/dashboard_audit_log?select=created_at,actor_name,target" +
        "&action=eq.staffing.report&order=id.desc&limit=1", { headers: d.serviceHeaders(), timeout: 8000 })
      return reportOf(r.data)
    } catch (e: any) {
      console.error("[dashboard] staffing report read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      return null
    }
  }

  app.get("/dashboard/api/staffing", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    if (d.canView && !d.canView(s)) return res.status(404).json({ error: "not found" })
    const logged = req.query.view === "1" ? d.audit(req, s, "view.staffing") : Promise.resolve()
    let installed = true
    let rows: unknown = []
    const report = readReport()
    try {
      // select=*: a table made before the monthly column still reads.
      const r = await d.axios.get(d.supabaseUrl + "/rest/v1/dept_staffing?select=*",
        { headers: d.serviceHeaders(), timeout: 8000 })
      rows = r.data
    } catch (e: any) {
      if (!notInstalled(e)) {
        await Promise.all([logged, report])
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
      needsAbsent: installed && merged.noAbsent.length > 0,
      canEdit: d.isDashOwner(s.sub),
      k: staffing.LACK_K,
      source: staffing.STAFFING_SOURCE,
      limits: staffing.STAFFING_LIMITS,
      depts: merged.list.map(withMultiplier),
      report: await report,
    })
  })

  // The staffing report PDF: everyone who sees the tab downloads it.
  app.get("/dashboard/api/staffing/report", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    if (d.canView && !d.canView(s)) return res.status(404).json({ error: "not found" })
    const report = await readReport()
    if (!report) return res.status(404).json({ error: "ยังไม่มีไฟล์รายงานอัตรากำลัง" })
    try {
      const signed = await d.axios.post(storage("object/sign/" + BUCKET + "/" + REPORT_PATH), { expiresIn: 120 },
        { headers: { ...d.serviceHeaders(), "Content-Type": "application/json" }, timeout: 8000 })
      const link = signed && signed.data && typeof signed.data.signedURL === "string" ? signed.data.signedURL : ""
      if (!link) throw new Error("no signedURL")
      await d.audit(req, { sub: s.sub, name: s.name }, "staffing.download", { name: report.name })
      const url = d.supabaseUrl + "/storage/v1" + link + (link.includes("?") ? "&" : "?") + "download=" + encodeURIComponent(report.name)
      if (req.query.link === "1") return res.json({ url, name: report.name })
      res.redirect(302, url)
    } catch (e: any) {
      const st = e.response ? Number(e.response.status) : 0
      const body = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message
      console.error("[dashboard] staffing report link failed:", st, body)
      // Storage answers a missing object with 400/404 {"statusCode":"404"}.
      if (st === 404 || /not.?found|404/i.test(String(body))) return res.status(404).json({ error: "ยังไม่มีไฟล์รายงานอัตรากำลัง" })
      res.status(502).json({ error: "ดาวน์โหลดไม่สำเร็จ ลองใหม่อีกครั้ง" })
    }
  })

  // The owner uploads (or replaces) it: the PDF as the body, its name in X-File-Name (URI-encoded).
  app.post("/dashboard/api/staffing/report",
    d.express.raw({ limit: "4500kb", type: () => true }), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    if (!d.isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!buf.length) return res.status(400).json({ error: "ไม่พบไฟล์ เลือกไฟล์ PDF แล้วลองใหม่" })
    if (buf.length > REPORT_MAX_BYTES) return res.status(413).json({ error: "ไฟล์ใหญ่เกิน 4 MB" })
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return res.status(400).json({ error: "ไฟล์นี้ไม่ใช่ PDF" })
    const name = reportName(req.headers["x-file-name"])
    try {
      await d.axios.post(storage("object/" + BUCKET + "/" + REPORT_PATH), buf, {
        headers: { ...d.serviceHeaders(), "Content-Type": "application/pdf", "x-upsert": "true", "cache-control": "no-cache" },
        timeout: 20000, maxBodyLength: Infinity, maxContentLength: Infinity,
      })
    } catch (e: any) {
      console.error("[dashboard] staffing report upload failed:", e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
      return res.status(502).json({ error: "อัปโหลดไม่สำเร็จ ลองใหม่อีกครั้ง" })
    }
    await d.audit(req, { sub: s.sub, name: s.name }, "staffing.report", { name, bytes: buf.length })
    const report: StaffingReport = { name, bytes: buf.length, uploaded_at: new Date().toISOString(), uploaded_by: s.name }
    res.json({ ok: true, report })
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
      // absent may be left out (a page from before it): the saved number stays.
      if (f === "absent" && body[f] === undefined) continue
      const v = staffing.parseStaffCount(body[f], f)
      if (v === null) return res.status(400).json({ error: FIELD_ERROR[f], field: f })
      next[f] = v
    }
    const absent = next.absent
    try {
      const args: Record<string, unknown> = {
        p_code: dept.code, p_fte: next.fte, p_staff: next.staff, p_monthly: next.monthly, p_daily: next.daily,
        p_actor: s.name,
      }
      // Sent only when given, so a save without it also works before step 33.
      if (absent !== undefined) args.p_absent = absent
      const out = await d.callServiceRpc("staffing_save", args)
      const before = countsOf(out && out.before, dept.absent)
      const after = countsOf(out && out.after, absent ?? (before ? before.absent : dept.absent)) ||
        { ...(next as Counts), absent: absent ?? dept.absent }
      // A department never saved before had the starting numbers.
      const was = before || { fte: dept.fte, staff: dept.staff, monthly: dept.monthly, daily: dept.daily, absent: dept.absent }
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
        const code = String(pgError(e).code || "")
        console.error("[dashboard] staffing save: not installed (" + code + ")")
        // No such function with p_absent: the table is there, step 33 is not.
        const fn = code === "PGRST202" || code === "42883" || /function/i.test(String(pgError(e).message || ""))
        return res.status(503).json({ installed: false, error: fn ? NO_ABSENT_MSG : NOT_INSTALLED_MSG })
      }
      console.error("[dashboard] staffing save failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      res.status(500).json({ error: "บันทึกไม่สำเร็จ กรุณาลองใหม่" })
    }
  })
}
