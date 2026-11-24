/**
 * lib/review-server.ts
 *
 * The /dashboard/ ตรวจสอบ (review) tab's API. The owner has both sides; another
 * dashboard user has one side at most: ผู้จัดทำ (review.auditee, Pong
 * 2026-11-12) or ผู้ตรวจสอบ (review.auditor, Pong 2026-11-18), never both.
 * Routes that are not theirs answer 404. Mounted from main.ts with its
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
 *   PUT  /dashboard/api/review/:month/scores/:index   {score, note}: one person's score, then a fresh build
 *   POST /dashboard/api/review/:month/rebuild         a fresh build (workflow 2.2 via the relay)
 *   POST /dashboard/api/review/:month/rounds          send the newest build to the auditor
 *   POST /dashboard/api/review/:month/rounds/withdraw take it back before the auditor opens it
 *   POST /dashboard/api/review/:month/email           email the live round to the auditor (again)
 *   PUT  /dashboard/api/review/email-mode             {test: true|false}: the email's test mode switch
 *
 * Sending a round queues an email to the auditor (scripts/review-email-2026-11.sql,
 * sent by the always-on relay, automation/review-email.ts); the month's
 * state carries the month's emails, newest first, as `emails` (null until
 * that file has been run), and the email's mode as `mail` ({test, testTo,
 * recipients}: null until scripts/review-email-test-toggle-2026-11.sql has
 * been run, and then the tab shows no switch).
 *
 * There is no upload: the SK03 and รวมค่าคะแนน files stay in Google Drive
 * (the state carries their ids, the tab links them view only), and a round
 * is the newest build as the system checked it. Once a month is approved,
 * both sides can download the approval PDF (:month/pdf), and the auditor
 * side the per-person allocation list (:month/allocation,
 * lib/allocation-xlsx.ts).
 *
 * Every round keeps its files (Pong, 2026-11-20: "the generated excel and
 * pdf is missing or lost"): scripts/review-rounds-2026-11.sql keeps an
 * approval that is undone as a 'cancelled' round, PDF and all, and starts
 * the next round from it. ประวัติรอบ downloads any round's files:
 *   GET  /dashboard/api/review/:month/rounds/:no/file/:kind
 *        kind sk03 | merged: the round's own copy of SK03 / รวมค่าคะแนน (both sides)
 *        kind pdf: the round's approval PDF, approved or cancelled (both sides)
 *        kind allocation: the round's allocation list, any round, so the
 *        auditor can check it before approving (the auditor side; Pong,
 *        2026-11-20 "Allow auditor to download allocation sheet"). A round
 *        not approved is named "(รอบที่ N ยังไม่อนุมัติ)", a cancelled one
 *        "(ยกเลิก รอบที่ N)".
 *   ?link=1 answers {url} (a signed link, 2 minutes) instead of redirecting;
 *   allocation is made on request and sent as the file itself.
 *
 * The auditor (ผู้ตรวจสอบ) side and the auditee's answers are listed above
 * their routes further down.
 *
 * Also here, though not part of the review: PUT /dashboard/api/budget/:month
 * {budget, doctors}, the overview page's budget box (any month; saves, then
 * starts workflow 2.2 for the month when its roster is complete).
 */

import type { Express, Request, Response } from "express"
import type { AxiosStatic } from "axios"

const allocation = require("./allocation-xlsx") as typeof import("./allocation-xlsx")
const core = require("./review-core") as {
  parseMonth(key: unknown): { be: number; month: number } | null
  approvalPdfName(key: unknown): string | null
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
  // A dashboard user who gets the ตรวจสอบ tab's ผู้จัดทำ side only.
  isReviewAuditee(sub: string): boolean
  // A dashboard user who gets the ตรวจสอบ tab's ผู้ตรวจสอบ side only.
  isReviewAuditor(sub: string): boolean
  audit(req: Request, actor: Actor, action: string, target?: Record<string, unknown>): Promise<void>
}

const BUCKET = "review-files"
const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]
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
  [/nothing to fix/, 409, "ไม่มีคนที่ต้องแก้ เขียนหมายเหตุถึงผู้จัดทำ หรือใช้ปุ่มอนุมัติแทน"],
  [/the message is too long/, 400, "หมายเหตุถึงผู้จัดทำไม่เกิน 1,000 ตัวอักษร"],
  [/not everyone is approved/, 409, "ยังอนุมัติไม่ครบทุกคน"],
  [/a problem is still open/, 409, "ยังมีปัญหาอื่น ๆ ที่เปิดอยู่ ปิดก่อนอนุมัติ"],
  [/the auditee has started/, 409, "ผู้จัดทำเริ่มแก้แล้ว ดึงกลับไม่ได้"],
  [/not in this round/, 404, "ไม่พบในรอบนี้"],
  [/not approved/, 409, "เดือนนี้ยังไม่ได้อนุมัติ"],
  [/has not failed/, 409, "เอกสารไม่ได้สร้างไม่สำเร็จ ไม่ต้องสร้างใหม่"],
  [/a reopen needs a reason/, 400, "เขียนเหตุผลก่อน"],
  [/no round to email/, 409, "ยังไม่มีรอบที่ส่งให้ผู้ตรวจสอบ"],
  [/an email is on its way/, 409, "อีเมลรอบนี้กำลังจะส่งอยู่แล้ว"],
  [/already emailed/, 409, "ส่งอีเมลรอบนี้ถึงผู้ตรวจสอบไปแล้ว"],
  [/reason is too long/, 400, "เหตุผลไม่เกิน 1,000 ตัวอักษร"],
  [/another round/, 409, "รอบที่ตรวจอยู่เปลี่ยนแล้ว โหลดหน้าใหม่ก่อน"],
  [/an email is still going out/, 409, "มีอีเมลที่ยังส่งไม่เสร็จ รอให้ส่งเสร็จก่อน (ประมาณ 1 นาที) แล้วค่อยปิดโหมดทดสอบ"],
  [/no recipients/, 409, "ยังไม่มีที่อยู่ผู้รับจริง ปิดโหมดทดสอบไม่ได้ (ตั้งใน review_email_settings ก่อน)"],
  [/no test address/, 409, "ยังไม่มีที่อยู่ทดสอบ (ตั้งใน review_email_settings ก่อน)"],
  [/no email settings/, 409, "ยังไม่ได้ตั้งค่าอีเมล (review_email_settings ว่าง)"],
  [/bad switch/, 400, "ส่งค่าเปิดหรือปิดโหมดทดสอบมาไม่ถูก"],
  [/a check is not a match/, 409, "ยังมีคนที่รอตรวจที่ผลเทียบไม่ตรงกันหรือไม่พบ ตรวจรายคนก่อน"],
  [/nobody to approve/, 409, "ไม่มีคนที่รอตรวจแล้ว"],
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
// The overview's budget box: budget_save comes with PART 2 of this file.
const BUDGET_NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งการบันทึกงบประมาณ ผู้ดูแลระบบต้องรันไฟล์ scripts/budget-inputs-2026-11.sql (PART 2) ใน Supabase SQL editor"
// review_state says v: 2 once the second file has been run.
const SQL_VERSION = 2
const EMAIL_NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งการส่งอีเมล ผู้ดูแลระบบต้องรันไฟล์ scripts/review-email-2026-11.sql ใน Supabase SQL editor"
const MAIL_MODE_NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งสวิตช์โหมดทดสอบอีเมล ผู้ดูแลระบบต้องรันไฟล์ scripts/review-email-test-toggle-2026-11.sql ใน Supabase SQL editor"
const EMAIL_COLS = "id,round_id,round_no,status,test,attempts,fix_no,sent_at,error,created_at"
const ROUNDS_NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งประวัติรอบ (ส่งกลับพร้อมหมายเหตุ และยกเลิกอนุมัติแบบเก็บเอกสาร) ผู้ดูแลระบบต้องรันไฟล์ scripts/review-rounds-2026-11.sql ใน Supabase SQL editor"
const APPROVE_ALL_NOT_INSTALLED_MSG = "ยังไม่ได้ติดตั้งปุ่มอนุมัติทุกคนที่รอตรวจ ผู้ดูแลระบบต้องรันไฟล์ scripts/review-approve-all-2026-11.sql ใน Supabase SQL editor"

export function mountReview(d: ReviewDeps): void {
  const { app, axios } = d
  const rest = (p: string): string => d.supabaseUrl + "/rest/v1/" + p
  const storage = (p: string): string => d.supabaseUrl + "/storage/v1/" + p
  const json = (extra: Record<string, string> = {}) => ({ ...d.serviceHeaders(), "Content-Type": "application/json", ...extra })

  // The roster tables, kept for a minute (2026-11-18, the tab's lag): every
  // :month route checks its month against them before its own work, and the
  // list changes about once a month. A month that is not in the kept list
  // asks again before it is refused, so a new month opens at once; the
  // months load always asks (and refreshes what is kept).
  const TABLES_TTL_MS = 60 * 1000
  let tablesKept: { at: number; list: string[] } | null = null
  let tablesAsk: Promise<string[]> | null = null
  const rosterTables = (fresh = false): Promise<string[]> => {
    if (!fresh && tablesKept && Date.now() - tablesKept.at < TABLES_TTL_MS) return Promise.resolve(tablesKept.list)
    if (!tablesAsk) {
      tablesAsk = d.listRosterTables().then((list) => { tablesKept = { at: Date.now(), list: list || [] }; return list || [] })
        .finally(() => { tablesAsk = null })
    }
    return tablesAsk
  }
  const isRosterMonth = async (month: string): Promise<boolean> =>
    (await rosterTables()).includes(month) || (await rosterTables(true)).includes(month)

  // Signed in, allowed this side, a real roster month, and the tables
  // installed. Who may call a route, by its side:
  //   "owner"    the owner (admin) only: the email's test mode switch;
  //   "auditor"  the owner and a ผู้ตรวจสอบ (review.auditor);
  //   "auditee"  the owner and a ผู้จัดทำ (review.auditee, Pong 2026-11-12);
  //   "both"     any of them: the reads both sides draw from.
  // A route is the owner's only unless it names a side. One that is not
  // open to the caller answers 404, as the owner-only tabs do. auditor and
  // auditee in the answer say which sides the caller has.
  type Side = "owner" | "auditor" | "auditee" | "both"
  type Gated = { s: Actor; month: string; owner: boolean; auditor: boolean; auditee: boolean }
  const gate = async (req: Request, res: Response, side: Side = "owner"): Promise<Gated | null> => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) { res.status(401).json({ error: "not authenticated" }); return null }
    const owner = d.isDashOwner(s.sub)
    const auditor = owner || d.isReviewAuditor(s.sub)
    const auditee = owner || d.isReviewAuditee(s.sub)
    const ok = side === "owner" ? owner : side === "auditor" ? auditor : side === "auditee" ? auditee : auditor || auditee
    if (!ok) { res.status(404).json({ error: "not found" }); return null }
    const month = String(req.params.month || "")
    if (req.params.month !== undefined) {
      if (!core.parseMonth(month) || month < FIRST_MONTH || !(await isRosterMonth(month))) {
        res.status(404).json({ error: "ไม่พบเดือนนี้" }); return null
      }
    }
    return { s: { sub: s.sub, name: s.name }, month, owner, auditor, auditee }
  }

  // Only the two loads (load = true) answer a missing install with 200
  // { installed: false }: the tab reads that and shows how to set it up.
  // Anything else must fail, since the browser only checks r.ok and would
  // otherwise report a save, a reopen or a list that never happened.
  const fail = (res: Response, what: string, e: any, load = false, missing = NOT_INSTALLED_MSG): void => {
    if (notInstalled(e)) {
      if (load) { res.json({ installed: false }); return }
      console.error("[dashboard] review " + what + ": not installed (" + String(pgError(e).code || "") + ")")
      res.status(503).json({ installed: false, error: missing }); return
    }
    const msg = String(pgError(e).message || "")
    const hit = REFUSALS.find(([re]) => re.test(msg))
    if (hit) { res.status(hit[1]).json({ error: hit[2] }); return }
    console.error("[dashboard] review " + what + " failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง" })
  }

  const state = (month: string): Promise<any> => d.callServiceRpc("review_state", { p_month: month })

  // The month's emails to the auditor, newest first. Null when the email
  // SQL is not installed or the read fails: the month still loads.
  const emails = async (month: string): Promise<any[] | null> => {
    try {
      const r = await axios.get(rest("review_emails?select=" + EMAIL_COLS + "&month=eq." + month + "&order=id.desc&limit=20"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      return Array.isArray(r.data) ? r.data : null
    } catch (e: any) {
      if (!notInstalled(e)) console.error("[dashboard] review emails failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      return null
    }
  }

  // The email's mode, for the switch on the ผู้จัดทำ side: test mode
  // (test_to set: every email to that one address only), the test address
  // (kept in test_addr while off), and how many real recipients. Never the
  // recipients' addresses. Null when scripts/review-email-test-toggle-2026-11.sql
  // has not been run (no test_addr column) or the read fails: no switch.
  type MailMode = { test: boolean; testTo: string; recipients: number }
  const toMode = (row: any): MailMode | null => !row || typeof row !== "object" ? null : {
    test: String(row.test_to || "") !== "",
    testTo: String(row.test_to || row.test_addr || ""),
    recipients: Array.isArray(row.recipients) ? row.recipients.length : Math.max(0, Number(row.recipients) || 0),
  }
  const mailMode = async (): Promise<MailMode | null> => {
    try {
      const r = await axios.get(rest("review_email_settings?select=recipients,test_to,test_addr&id=eq.1"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      return Array.isArray(r.data) ? toMode(r.data[0]) : null
    } catch (e: any) {
      if (!notInstalled(e)) console.error("[dashboard] review email mode failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      return null
    }
  }

  // No build may change once the auditor has it, or after approval.
  const auditeeTurn = (st: any): boolean => {
    const live = (st.rounds || []).find((r: any) => r.round_no === st.live)
    return !live || live.status === "returned"
  }

  app.get("/dashboard/api/review/months", async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
    if (!g) return
    try {
      const tables = (await rosterTables(true)).filter((t) => core.parseMonth(t) && t >= FIRST_MONTH).sort()
      const months = await d.callServiceRpc("review_months", { p_months: tables })
      res.json({ installed: true, months: months || [] })
    } catch (e: any) { fail(res, "months", e, true) }
  })

  app.get("/dashboard/api/review/:month", async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
    if (!g) return
    try {
      // The state, the emails, the mode and the visit's log line do not
      // wait on each other (2026-11-18: one round trip to the database
      // instead of three). emails, mailMode and audit never throw; a
      // failed state is thrown once all four have ended.
      // The email's mode (and its test address) is for the owner only: a
      // dashboard user given the ผู้จัดทำ side alone gets no switch.
      const [got, em, mail] = await Promise.all([
        state(g.month).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
        emails(g.month),
        d.isDashOwner(g.s.sub) ? mailMode() : Promise.resolve(null),
        req.query.view === "1" ? d.audit(req, g.s, "view.review", { month: g.month }) : Promise.resolve(),
      ])
      if (!got.ok) throw got.e
      const st = got.v
      // Only the first SQL file run: the tab says the second is needed.
      if (!st || st.v !== SQL_VERSION) return res.json({ installed: false })
      res.json({ installed: true, ...st, emails: em, mail })
    } catch (e: any) { fail(res, "state", e, true) }
  })

  // ── Budget and N, from the overview page's month cards ───────────────
  // Pong, 2026-11-11: typed on ภาพรวม (one box per month card), not in the
  // ตรวจสอบ tab, and not tied to its rounds. budget_save (scripts/
  // budget-inputs-2026-11.sql PART 2) stores them in review_inputs with per
  // P4P = round(budget ÷ N, 2), marks a Telegram as due, and queues a
  // one-month build of workflow 2.2 when everyone on the roster has sent.
  // Any month key, so a budget can go in before the month's roster exists.
  app.put("/dashboard/api/budget/:month", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store")
    const s = d.dashSession(req)
    if (!s) return res.status(401).json({ error: "not authenticated" })
    // The owner only, like the ข้อมูล button (Pong, 2026-11-19: "ผู้จัดทำ =
    // hide ข้อมูล btn on overview"; the ผู้จัดทำ had it 18 to 19 Nov).
    if (!d.isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
    const month = String(req.params.month || "")
    if (!core.parseMonth(month)) return res.status(404).json({ error: "ไม่พบเดือนนี้" })
    const budget = core.parseBudget(req.body && req.body.budget, 1e11)
    const doctors = core.parseCount(req.body && req.body.doctors, 1e5)
    if (budget === null) return res.status(400).json({ error: "งบประมาณ: ใส่ตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง", field: "budget" })
    if (doctors === null) return res.status(400).json({ error: "จำนวนแพทย์: ใส่จำนวนเต็มมากกว่า 0", field: "doctors" })
    const actor = { sub: s.sub, name: s.name }
    try {
      const out = await d.callServiceRpc("budget_save", { p_month: month, p_budget: budget, p_doctors: doctors, p_actor: s.name })
      const was = out && out.before, now = (out && out.after) || {}
      const before = was ? { budget: Number(was.budget), per_p4p: Number(was.per_p4p), doctors: was.doctors === null ? null : Number(was.doctors) } : null
      const perP4p = Number(now.per_p4p)
      await d.audit(req, actor, "budget.save", { month, budget, doctors, per_p4p: perP4p, before, build: !!(out && out.request) })
      res.json({
        ok: true,
        budget: { budget: Number(now.budget), per_p4p: perP4p, doctors: Number(now.doctors), updated_at: now.updated_at, updated_by: now.updated_by },
        complete: !!(out && out.complete),
        request: (out && out.request) || null,
      })
    } catch (e: any) {
      if (notInstalled(e)) {
        console.error("[dashboard] budget save: not installed (" + String(pgError(e).code || "") + ")")
        res.status(503).json({ installed: false, error: BUDGET_NOT_INSTALLED_MSG }); return
      }
      fail(res, "budget", e)
    }
  })

  // One person's score: written to the month's roster table, logged as a
  // roster edit (so History shows it with the รายชื่อ tab's edits), and a
  // fresh build is queued. Only on the auditee's turn (the SQL checks).
  app.put("/dashboard/api/review/:month/scores/:index", d.express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditee")
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
    const g = await gate(req, res, "auditee")
    if (!g) return
    try {
      res.json(await d.callServiceRpc("review_auditee_people", { p_month: g.month }))
    } catch (e: any) { fail(res, "list", e) }
  })

  app.post("/dashboard/api/review/:month/rebuild", async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditee")
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
    const g = await gate(req, res, "auditee")
    if (!g) return
    try {
      const round = await d.callServiceRpc("review_submit_round", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.submit", { month: g.month, round: round && round.round_no })
      res.json({ ok: true, round })
    } catch (e: any) { fail(res, "submit", e) }
  })

  app.post("/dashboard/api/review/:month/rounds/withdraw", async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditee")
    if (!g) return
    try {
      const roundNo = await d.callServiceRpc("review_withdraw_round", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.withdraw", { month: g.month, round: roundNo })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "withdraw", e) }
  })

  // The email box's button (ส่งอีเมลอีกครั้ง / ส่งอีเมลจริง / ส่งอีเมล): the live
  // round's email again, shown only while one is owed (a failed email, a
  // test send once test mode is off, a round with no email). The SQL refuses
  // while one is on its way or once a real one went out.
  app.post("/dashboard/api/review/:month/email", async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditee")
    if (!g) return
    try {
      const e = await d.callServiceRpc("review_email_queue", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.email", { month: g.month, round: e && e.round_no })
      res.json({ ok: true, email: e })
    } catch (e: any) {
      if (notInstalled(e)) {
        console.error("[dashboard] review email: not installed (" + String(pgError(e).code || "") + ")")
        res.status(503).json({ installed: false, error: EMAIL_NOT_INSTALLED_MSG }); return
      }
      fail(res, "email", e)
    }
  })

  // The email's test mode switch (Pong, 2026-11-12: on the ผู้จัดทำ side,
  // in the left column under the months). {test: true} sends every email
  // to the test address only; {test: false} to the real recipients. The
  // SQL refuses off with no recipients, or while an email is on its way
  // (one queued as a test would otherwise go out for real).
  app.put("/dashboard/api/review/email-mode", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res)
    if (!g) return
    const on = req.body ? req.body.test : undefined
    if (typeof on !== "boolean") return res.status(400).json({ error: "ส่งค่าเปิดหรือปิดโหมดทดสอบมาไม่ถูก" })
    try {
      const row = await d.callServiceRpc("review_email_set_test", { p_on: on })
      await d.audit(req, g.s, "review.email_mode", { test: on })
      res.json({ ok: true, mail: toMode(row) })
    } catch (e: any) {
      if (notInstalled(e)) {
        console.error("[dashboard] review email mode: not installed (" + String(pgError(e).code || "") + ")")
        res.status(503).json({ installed: false, error: MAIL_MODE_NOT_INSTALLED_MSG }); return
      }
      fail(res, "email mode", e)
    }
  })

  // ── The auditor's side, and the auditee's answers ─────────────────────
  //   GET  /dashboard/api/review/:month/people?round=N   everyone in a round (live round by default)
  //   GET  /dashboard/api/review/:month/person/:round/:index   their sheet and department row
  //   POST /dashboard/api/review/:month/opened           {role} the auditor / auditee opened the round
  //   PUT  /dashboard/api/review/:month/decisions/:index {decision: approve|fix|null, remark}
  //   PUT  /dashboard/api/review/:month/replies/:index   {reply} the auditee's answer to a ต้องแก้ไข
  //   POST /dashboard/api/review/:month/approve-all     {round} อนุมัติทุกคนที่รอตรวจ (all checks ตรงกัน)
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
    const g = await gate(req, res, "both")
    if (!g) return
    const round = /^[1-9][0-9]{0,3}$/.test(String(req.query.round || "")) ? Number(req.query.round) : null
    try {
      const out = await d.callServiceRpc("review_people", { p_month: g.month, p_round: round })
      // The ผู้จัดทำ (กานดา) reads a round's decisions and remarks only once the
      // auditor has handed it back or approved it, never while the auditor is
      // still deciding (Pong, 2026-11-18: "ตรวจสอบ : access only in auditee part").
      const st = out && out.round ? String(out.round.status || "") : ""
      if (!g.auditor && out && out.round && st !== "returned" && st !== "approved") return res.status(404).json({ error: "ไม่พบในรอบนี้" })
      res.json(out)
    } catch (e: any) { fail(res, "people", e) }
  })

  // One doctor's sheet for the auditor's per-person panel: the auditor's only.
  app.get("/dashboard/api/review/:month/person/:round/:index", async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    const round = String(req.params.round), index = String(req.params.index)
    if (!/^[1-9][0-9]{0,3}$/.test(round) || !UUID_RE.test(index)) return res.status(404).json({ error: "ไม่พบในรอบนี้" })
    try {
      res.json(await d.callServiceRpc("review_person", { p_month: g.month, p_round: Number(round), p_index: index }))
    } catch (e: any) { fail(res, "person", e) }
  })

  app.post("/dashboard/api/review/:month/opened", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
    if (!g) return
    const role = req.body && req.body.role
    if (role !== "auditor" && role !== "auditee") return res.status(400).json({ error: "bad role" })
    if (role === "auditor" ? !g.auditor : !g.auditee) return res.status(404).json({ error: "not found" })
    try {
      await d.callServiceRpc("review_mark_opened", { p_month: g.month, p_role: role })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "opened", e) }
  })

  app.put("/dashboard/api/review/:month/decisions/:index", d.express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    const index = String(req.params.index)
    const decision = req.body ? req.body.decision : undefined
    if (!UUID_RE.test(index) || !(decision === "approve" || decision === "fix" || decision === null)) {
      return res.status(400).json({ error: "bad decision" })
    }
    const remark = decision === "fix" ? text(req.body.remark, 1000) : ""
    if (remark === null) return res.status(400).json({ error: "ต้องแก้ไข ต้องมีหมายเหตุบอกว่าแก้อะไร (ไม่เกิน 1,000 ตัวอักษร)" })
    try {
      // The name for the log is looked up while the decision is saved.
      const [row, physician] = await Promise.all([
        d.callServiceRpc("review_decide", { p_month: g.month, p_index: index, p_decision: decision, p_remark: remark, p_actor: g.s.name }),
        personName(index),
      ])
      await d.audit(req, g.s, "review.decide", { month: g.month, index, physician, decision, remark })
      res.json({ ok: true, decision: row })
    } catch (e: any) { fail(res, "decide", e) }
  })

  app.put("/dashboard/api/review/:month/replies/:index", d.express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditee")
    if (!g) return
    const index = String(req.params.index)
    const reply = typeof (req.body && req.body.reply) === "string" ? req.body.reply.trim() : ""
    if (!UUID_RE.test(index) || reply.length > 1000) return res.status(400).json({ error: "คำตอบไม่เกิน 1,000 ตัวอักษร" })
    try {
      const [, physician] = await Promise.all([
        d.callServiceRpc("review_reply_decision", { p_month: g.month, p_index: index, p_reply: reply, p_actor: g.s.name }),
        personName(index),
      ])
      await d.audit(req, g.s, "review.reply", { month: g.month, index, physician, reply })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "reply", e) }
  })

  const roundAction = (path: string, fn: string, action: string): void => {
    app.post("/dashboard/api/review/:month/" + path, async (req: Request, res: Response) => {
      const g = await gate(req, res, "auditor")
      if (!g) return
      try {
        const round = await d.callServiceRpc(fn, { p_month: g.month, p_actor: g.s.name })
        await d.audit(req, g.s, action, { month: g.month, round: round && round.round_no })
        res.json({ ok: true, round })
      } catch (e: any) { fail(res, path, e) }
    })
  }
  // Everyone still to check, approved at once; refused while any of them
  // has a check that is not ตรงกัน (scripts/review-approve-all-2026-11.sql).
  // round: the round on the auditor's screen, so a newer one is not touched.
  app.post("/dashboard/api/review/:month/approve-all", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    const round = req.body ? req.body.round : undefined
    if (!Number.isInteger(round) || round < 1 || round > 9999) return res.status(400).json({ error: "bad round" })
    try {
      const n = await d.callServiceRpc("review_approve_all", { p_month: g.month, p_round: round, p_actor: g.s.name })
      await d.audit(req, g.s, "review.approve_all", { month: g.month, round, count: n })
      res.json({ ok: true, approved: n })
    } catch (e: any) {
      if (notInstalled(e)) {
        console.error("[dashboard] review approve-all: not installed (" + String(pgError(e).code || "") + ")")
        res.status(503).json({ installed: false, error: APPROVE_ALL_NOT_INSTALLED_MSG }); return
      }
      fail(res, "approve-all", e)
    }
  })

  // ส่งกลับ, with the auditor's note to the ผู้จัดทำ (optional; with
  // everyone approved, the note is the reason to send back).
  app.post("/dashboard/api/review/:month/return", d.express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    const raw = req.body && req.body.note
    const note = typeof raw === "string" ? raw.trim() : ""
    if (note.length > 1000) return res.status(400).json({ error: "หมายเหตุถึงผู้จัดทำไม่เกิน 1,000 ตัวอักษร" })
    try {
      const round = await d.callServiceRpc("review_return_round", { p_month: g.month, p_actor: g.s.name, p_note: note })
      await d.audit(req, g.s, "review.return", { month: g.month, round: round && round.round_no, ...(note ? { note } : {}) })
      res.json({ ok: true, round })
    } catch (e: any) { fail(res, "return", e, false, ROUNDS_NOT_INSTALLED_MSG) }
  })
  roundAction("unreturn", "review_unreturn_round", "review.unreturn")
  roundAction("approve", "review_approve_round", "review.approve")

  // The approval document (process/review-pdf.ts, workflow 2.8).
  app.get("/dashboard/api/review/:month/pdf", async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
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
      // ?download=1 saves it under the form's name instead
      // ("แบบฟอร์ม P4P_SK02 เดือนสิงหาคม 2569.pdf", Pong 2026-11-17).
      // ?link=1 answers {url} instead of redirecting, so the tab's
      // ดาวน์โหลด link can spin until the link is signed.
      const name = core.approvalPdfName(g.month) || "P4P_" + g.month + "_approved.pdf"
      const url = d.supabaseUrl + "/storage/v1" + signed.data.signedURL +
        (req.query.download === "1" ? "&download=" + encodeURIComponent(name) : "")
      if (req.query.link === "1") { res.json({ url }); return }
      res.redirect(302, url)
    } catch (e: any) { fail(res, "pdf download", e) }
  })

  // รายละเอียดการจัดสรรเงินรายบุคคล (lib/allocation-xlsx.ts, Pong 2026-11-17):
  // made on request from the approved round's own SK03 copy, with each
  // person's department from that build, so it always matches what was
  // approved. Nothing is stored. The auditor side only (the owner or a ผู้ตรวจสอบ): the auditee
  // gets a 404 like any other page they cannot see (Pong, 2026-11-17).
  // tag: "" for the approved round; else what the name adds, for a round
  // not approved yet or an approval undone since (ประวัติรอบ).
  const sendAllocation = async (req: Request, res: Response, g: Gated, round: { round_no: number; build_id: string }, tag: string): Promise<void> => {
    // No runs 0001, 0002, … down the sheet (Pong, 2026-11-20), so
    // nothing else is read for it. เลขที่บัตรประชาชน is the month's roster
    // national_id (Pong, 2026-11-22), found by each SK03 row's roster index
    // in the build; a month whose roster has no such column leaves it blank.
    const [b, people, ids] = await Promise.all([
      axios.get(rest("review_builds?select=sk03_path&id=eq." + round.build_id), { headers: d.serviceHeaders(), timeout: 8000 }),
      axios.get(rest("review_build_people?select=roster_index,is_intern,sk03_row,department&build_id=eq." + round.build_id),
        { headers: d.serviceHeaders(), timeout: 8000 }),
      axios.get(rest(encodeURIComponent(g.month) + "?select=index,national_id"), { headers: d.serviceHeaders(), timeout: 8000 })
        .catch((e: any) => {
          if (pgError(e).code === "42703") return { data: [] }   // no national_id column on this month's roster
          throw e
        }),
    ])
    const path = (b.data as any[])[0]?.sk03_path
    if (!path) { res.status(404).json({ error: "ไม่พบไฟล์ SK03 ของรอบนี้" }); return }
    let file: { data: ArrayBuffer }
    try {
      file = await axios.get(storage("object/" + BUCKET + "/" + String(path).split("/").map(encodeURIComponent).join("/")),
        { headers: d.serviceHeaders(), responseType: "arraybuffer", timeout: 20000 })
    } catch (e: any) {
      // The body of a failed binary read is bytes: log it as text.
      const body = e.response && e.response.data ? Buffer.from(e.response.data).toString("utf8").slice(0, 300) : ""
      console.error("[dashboard] review allocation: SK03 download failed:", e.response ? e.response.status + " " + body : e.message)
      res.status(502).json({ error: "ดาวน์โหลดไฟล์ SK03 ของรอบนี้ไม่สำเร็จ ลองใหม่อีกครั้ง" }); return
    }
    const idByIndex = new Map<string, string>()
    for (const x of (ids.data as any[]) || []) {
      if (x && x.index != null && x.national_id != null && String(x.national_id).trim()) idByIndex.set(String(x.index), String(x.national_id).trim())
    }
    const dept = new Map<string, string>()
    const nid = new Map<string, string>()
    for (const p of (people.data as any[]) || []) {
      if (p.sk03_row == null) continue
      const key = (p.is_intern ? "i" : "s") + p.sk03_row
      if (p.department) dept.set(key, String(p.department))
      const n = idByIndex.get(String(p.roster_index))
      if (n) nid.set(key, n)
    }
    const ExcelJS = require("exceljs") as typeof import("exceljs")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(file.data as ArrayBuffer)
    const rows = allocation.allocationRows(wb, (intern, row) => dept.get((intern ? "i" : "s") + row) ?? null,
      (intern, row) => nid.get((intern ? "i" : "s") + row) ?? null)
    if (!rows.length) { res.status(404).json({ error: "ไม่พบรายชื่อใน SK03 ของรอบนี้" }); return }
    const buf = await allocation.buildAllocationXlsx(g.month, rows, ExcelJS)
    await d.audit(req, g.s, "review.download", { month: g.month, kind: "allocation", round: round.round_no, rows: rows.length,
      ids: rows.filter((x) => x.nationalId).length })
    const base = allocation.allocationFileName(g.month) || "allocation_" + g.month + ".xlsx"
    const name = tag ? base.replace(/\.xlsx$/, "") + " (" + tag + ").xlsx" : base
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    res.setHeader("Content-Disposition", "attachment; filename=\"allocation_" + g.month + ".xlsx\"; filename*=UTF-8''" + encodeURIComponent(name))
    res.send(buf)
  }
  app.get("/dashboard/api/review/:month/allocation", async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    try {
      const r = await axios.get(rest("review_rounds?select=round_no,build_id&month=eq." + g.month + "&status=eq.approved"),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const round = (r.data as any[])[0]
      if (!round || !round.build_id) return res.status(404).json({ error: "เดือนนี้ยังไม่ได้อนุมัติ" })
      await sendAllocation(req, res, g, round, "")
    } catch (e: any) { fail(res, "allocation", e) }
  })

  // ประวัติรอบ: one file of one round (see the top of this file). A signed
  // link to the round's own copy in the bucket, never the Drive file (that
  // one is the newest build's).
  const FILE_KINDS = ["sk03", "merged", "pdf", "allocation"]
  app.get("/dashboard/api/review/:month/rounds/:no/file/:kind", async (req: Request, res: Response) => {
    const kind = String(req.params.kind)
    const no = String(req.params.no)
    const g = await gate(req, res, kind === "allocation" ? "auditor" : "both")
    if (!g) return
    if (!FILE_KINDS.includes(kind) || !/^[1-9][0-9]{0,3}$/.test(no)) return res.status(404).json({ error: "ไม่พบไฟล์นี้" })
    try {
      const r = await axios.get(rest("review_rounds?select=round_no,status,build_id,approved_at,pdf_status,pdf_path&month=eq." + g.month + "&round_no=eq." + no),
        { headers: d.serviceHeaders(), timeout: 8000 })
      const round = (r.data as any[])[0]
      if (!round) return res.status(404).json({ error: "ไม่พบรอบนี้" })
      const cancelled = round.status === "cancelled"
      const approval = round.status === "approved" || cancelled
      const p = core.parseMonth(g.month)
      const tag = cancelled ? " (ยกเลิก รอบที่ " + round.round_no + ")" : " รอบที่ " + round.round_no
      let path = "", name = ""
      if (kind === "allocation") {
        if (!round.build_id) return res.status(404).json({ error: "ไม่พบไฟล์ของรอบนี้" })
        await sendAllocation(req, res, g, round, round.status === "approved" ? ""
          : cancelled ? "ยกเลิก รอบที่ " + round.round_no : "รอบที่ " + round.round_no + " ยังไม่อนุมัติ")
        return
      } else if (kind === "pdf") {
        if (!approval || round.pdf_status !== "ready" || !round.pdf_path) return res.status(404).json({ error: "รอบนี้ไม่มีเอกสารเบิกจ่าย" })
        path = round.pdf_path
        const base = core.approvalPdfName(g.month) || "P4P_" + g.month + "_approved.pdf"
        name = cancelled ? base.replace(/\.pdf$/, "") + tag + ".pdf" : base
      } else {
        const b = await axios.get(rest("review_builds?select=sk03_path,merged_path&id=eq." + round.build_id),
          { headers: d.serviceHeaders(), timeout: 8000 })
        const row = (b.data as any[])[0]
        path = row ? String((kind === "sk03" ? row.sk03_path : row.merged_path) || "") : ""
        if (!path) return res.status(404).json({ error: "ไม่พบไฟล์ของรอบนี้" })
        const monthText = p ? THAI_MONTHS[p.month - 1] + " " + p.be : g.month
        name = (kind === "sk03" ? "SK03 " : "รวมค่าคะแนน ") + monthText + tag + ".xlsx"
      }
      const signed = await axios.post(storage("object/sign/" + BUCKET + "/" + path), { expiresIn: 120 },
        { headers: json(), timeout: 8000 })
      await d.audit(req, g.s, "review.download", { month: g.month, kind, round: round.round_no })
      const url = d.supabaseUrl + "/storage/v1" + signed.data.signedURL + "&download=" + encodeURIComponent(name)
      if (req.query.link === "1") { res.json({ url, name }); return }
      res.redirect(302, url)
    } catch (e: any) { fail(res, "round file", e) }
  })

  app.post("/dashboard/api/review/:month/pdf/retry", async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
    if (!g) return
    try {
      const round = await d.callServiceRpc("review_retry_pdf", { p_month: g.month, p_actor: g.s.name })
      await d.audit(req, g.s, "review.pdf_retry", { month: g.month, round: round && round.round_no })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "pdf retry", e) }
  })

  // ยกเลิกอนุมัติ (scripts/review-rounds-2026-11.sql): the approved round is
  // kept as cancelled, with its PDF, and the next round starts with every
  // approval carried over. back: true sends it straight to the ผู้จัดทำ with
  // the reason as the note; else it is the auditor's to check again.
  app.post("/dashboard/api/review/:month/reopen", d.express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
    if (!g) return
    const reason = text(req.body && req.body.reason, 1000)
    if (!reason) return res.status(400).json({ error: "เขียนเหตุผลก่อน (ไม่เกิน 1,000 ตัวอักษร)" })
    const back = !!(req.body && req.body.back === true)
    try {
      const out = await d.callServiceRpc("review_reopen_round", { p_month: g.month, p_reason: reason, p_actor: g.s.name, p_return: back })
      await d.audit(req, g.s, "review.reopen", {
        month: g.month, round: out && out.cancelled, next: out && out.round_no, back, reason,
      })
      res.json({ ok: true, round: out && out.round_no, status: out && out.status })
    } catch (e: any) { fail(res, "reopen", e, false, ROUNDS_NOT_INSTALLED_MSG) }
  })

  app.get("/dashboard/api/review/:month/issues", async (req: Request, res: Response) => {
    const g = await gate(req, res, "both")
    if (!g) return
    try {
      res.json({ issues: (await d.callServiceRpc("review_issue_list", { p_month: g.month })) || [] })
    } catch (e: any) { fail(res, "issues", e) }
  })

  app.post("/dashboard/api/review/:month/issues", d.express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
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
    const g = await gate(req, res, "both")
    if (!g) return
    const id = String(req.params.id)
    const role = req.body && req.body.role
    const body = text(req.body && req.body.body, 2000)
    if (!/^[1-9][0-9]{0,17}$/.test(id) || (role !== "auditor" && role !== "auditee") || !body) {
      return res.status(400).json({ error: "พิมพ์คำตอบ (ไม่เกิน 2,000 ตัวอักษร)" })
    }
    if (role === "auditor" ? !g.auditor : !g.auditee) return res.status(404).json({ error: "not found" })
    try {
      await d.callServiceRpc("review_issue_reply", { p_month: g.month, p_issue: Number(id), p_role: role, p_body: body, p_actor: g.s.name })
      await d.audit(req, g.s, "review.issue_reply", { month: g.month, id: Number(id), role, body })
      res.json({ ok: true })
    } catch (e: any) { fail(res, "issue reply", e) }
  })

  app.post("/dashboard/api/review/:month/issues/:id/status", d.express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
    const g = await gate(req, res, "auditor")
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
