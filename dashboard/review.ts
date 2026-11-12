/** GENERATED FILE'S SOURCE — compiled to dashboard/review.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin.
 *
 * The ตรวจสอบ (review) tab, owner only. app.ts owns the tabs and fires
 * "dashboard:review" when this tab is opened; everything else is here.
 * The server side is lib/review-server.ts.
 *
 * Months start at ส.ค. 69 (2569_08), one tab each.
 * ผู้จัดทำ (auditee): sees the month's budget and N (typed on the overview
 * page's month card since 2026-11-11; per P4P = budget ÷ N, the build puts
 * budget and per P4P in SK03 Y9 / W9), sees the SK03 and
 * รวมค่าคะแนน files the system wrote to Google Drive (view only), can edit
 * any person's score (it goes to the roster and the files are built again),
 * and sends the newest build to the auditor. Sending waits for a finished
 * build that matches the roster, with no score of 30,000 or more or under
 * 2,200 (the SQL refuses the same).
 * ผู้ตรวจสอบ (auditor): checks each person of the round, then returns it or
 * approves it (the PDF is made after approval).
 */
;(function () {
    "use strict"

    interface Build {
        id: string
        built_at: string
        budget: number | null
        per_p4p: number | null
        people: number
        staff: number
        interns: number
        pay_total: number | null
        sk03_file_id: string
        merged_file_id?: string
        problems: { code: string; blocking: boolean; count?: number; names?: string[] }[]
    }
    interface Request {
        id: number
        status: "queued" | "dispatched" | "running" | "done" | "failed"
        reason: string
        requested_at: string
        started_at: string | null
        finished_at: string | null
        build_id: string | null
        error: string | null
        run_url: string | null
    }
    interface Round {
        id: number
        round_no: number
        status: "submitted" | "returned" | "superseded" | "approved"
        build_id: string
        budget: number
        per_p4p: number
        doctors: number | null
        edits?: number
        submitted_at: string
        submitted_by: string
        auditor_opened_at: string | null
        auditee_opened_at: string | null
        returned_at: string | null
        approved_at: string | null
        approved_by?: string
        pdf_status?: "none" | "queued" | "building" | "ready" | "failed"
        pdf_bytes?: number | null
        pdf_pages?: number | null
        pdf_error?: string
        pdf_built_at?: string | null
        reopened_at?: string | null
        reopened_by?: string
        reopen_reason?: string
        counts: { approve: number; fix: number; waiting: number; carried: number }
    }
    // An email to the auditor (scripts/review-email-2026-11.sql), newest first.
    interface Email {
        id: number
        round_id: number | null
        round_no: number
        status: "queued" | "sending" | "sent" | "failed" | "cancelled"
        test: boolean
        attempts: number
        fix_no: number | null
        sent_at: string | null
        error: string
        created_at: string
    }
    interface State {
        installed: boolean
        v: number
        month: string
        roster: { total: number; sent: number; exists: boolean }
        inputs: { budget: number; per_p4p: number; doctors: number | null; updated_at: string; updated_by: string } | null
        build: Build | null
        buildChecks: { scoreMismatch: number; scoreMissing: number; moneyMismatch: number; moneyMissing: number; high: number; low: number } | null
        // People whose roster row no longer matches the newest build.
        stale: number
        // People whose score was edited since the last round was sent.
        edits: number
        request: Request | null
        rounds: Round[]
        live: number | null
        // Null or missing: the email SQL is not installed (nothing is shown).
        emails?: Email[] | null
    }
    interface MonthRow {
        month: string
        total: number
        sent: number
        builtAt: string | null
        round: { round_no: number; status: string; fix?: number } | null
        hasInputs: boolean
    }

    const view = document.getElementById("review-view") as HTMLElement
    const body = document.getElementById("review-body") as HTMLElement
    // The left column under the months: each side's summary and main
    // button. render() fills it; everything else that draws the body alone
    // (loading, a failure, no month) empties it, so no stale button stays.
    const side = document.getElementById("review-side") as HTMLElement
    let sideOut: Node[] = []
    const show = (...nodes: Node[]): void => { side.replaceChildren(); body.replaceChildren(...nodes) }
    const monthBox = document.getElementById("review-months") as HTMLElement
    const roleBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#review-role button"))
    const live = document.getElementById("review-live") as HTMLElement
    const confirmDlg = document.getElementById("review-confirm") as HTMLDialogElement
    const confirmBody = document.getElementById("review-confirm-body") as HTMLElement
    const confirmSend = document.getElementById("review-confirm-send") as HTMLButtonElement
    const confirmTitle = document.getElementById("review-confirm-title") as HTMLElement

    // ── Small helpers ────────────────────────────────────────────────────
    function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
    }
    const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]
    const THAI_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]
    const monthName = (key: string, short = false): string => {
        const m = /^(\d{4})_(\d{2})$/.exec(key)
        return m ? (short ? THAI_SHORT : THAI_MONTHS)[Number(m[2]) - 1] + " " + m[1] : key
    }
    // "ส.ค. 69": the month tabs and headings.
    const shortMonth = (key: string): string => {
        const m = /^(\d{4})_(\d{2})$/.exec(key)
        return m ? THAI_SHORT[Number(m[2]) - 1] + " " + m[1].slice(2) : key
    }
    const when = (iso: string | null | undefined): string => {
        if (!iso) return ""
        const d = new Date(iso)
        if (isNaN(d.getTime())) return ""
        return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " น."
    }
    const baht = (n: number | null | undefined): string =>
        n === null || n === undefined ? "—" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const int = (n: number): string => Number(n || 0).toLocaleString("th-TH")
    // The budget is whole baht: no decimals, unless an older one was saved with satang.
    const budgetText = (n: number | null | undefined): string =>
        n === null || n === undefined ? "—" : Number.isInteger(Number(n)) ? int(Number(n)) : baht(n)
    const sizeText = (b: number): string => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"
    const say = (msg: string): void => { live.textContent = ""; setTimeout(() => { live.textContent = msg }, 50) }
    // A failure is announced at once (role=alert); say() is the polite one.
    // Either way the same words are also shown on the page (tell, failBox),
    // without a live role there, so nothing is read out twice.
    // Failures that come together (people and issues both failing) are read as one.
    const alertBox = document.getElementById("review-alert") as HTMLElement | null
    let shoutQ: string[] = []
    let shoutT: number | undefined
    const shout = (msg: string): void => {
        if (!alertBox) { say(msg); return }
        shoutQ.push(msg)
        if (shoutT !== undefined) return
        alertBox.textContent = ""
        shoutT = window.setTimeout(() => { alertBox.textContent = shoutQ.join(" · "); shoutQ = []; shoutT = undefined }, 50)
    }

    class ApiError extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s } }
    const NET_ERROR = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง"
    async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
        let r: Response
        try { r = await fetch(path, { credentials: "same-origin", ...init }) } catch (e) { throw new ApiError(NET_ERROR, 0) }
        if (r.status === 401) { location.href = "/dashboard/login?error=idle"; throw new ApiError("signed out", 401) }
        let data: any = null
        try { data = await r.json() } catch (e) { data = null }
        // Any refusal (409, 503 { installed: false, error }, …) carries its reason in error.
        if (!r.ok) throw new ApiError((data && typeof data.error === "string" && data.error) || "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง (" + r.status + ")", r.status)
        return data as T
    }
    const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message) || fallback
    const signedOut = (e: unknown): boolean => e instanceof ApiError && e.status === 401
    const monthApi = (s: State): string => "/dashboard/api/review/" + s.month
    const post = <T>(path: string, json?: unknown, method = "POST"): Promise<T> =>
        api<T>(path, json === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) })

    // ── State ────────────────────────────────────────────────────────────
    const ROLE_KEY = "review.role"
    let role: "auditee" | "auditor" = "auditee"
    try { if (localStorage.getItem(ROLE_KEY) === "auditor") role = "auditor" } catch (e) { /* private window */ }
    // month is the one picked; st is the state on screen, always of that
    // month (a switch clears it). Every action builds its URL from the s it
    // was drawn with, so what a dialog says and what is sent agree.
    let month = ""
    let st: State | null = null
    let stJson = ""
    let poll: number | undefined
    let pollFails = 0
    let busy = false
    let loadSeq = 0
    let loadError = ""
    // Something not in st changed (a note, a request ended): the next look
    // draws even when the state it brings is the same.
    let dirty = false
    let freshState = false // the next render draws a state that just arrived

    // Typed text not saved yet, by field. Every re-render (the 15 s look, a
    // click on a person, a list arriving) draws a field from here first, so
    // nothing typed is lost. An entry goes once its save succeeds, or when
    // the month or the round changes.
    const drafts = new Map<string, string>()
    let draftScope = ""
    const fieldErrs = new Map<string, string>()
    function keep<T extends HTMLInputElement | HTMLTextAreaElement>(i: T, key: string, saved: string): T {
        const d = drafts.get(key)
        i.value = d !== undefined ? d : saved
        i.addEventListener("input", () => { drafts.set(key, i.value) })
        return i
    }
    const forget = (s: State, ...keys: string[]): void => { if (s.month === month) { for (const k of keys) drafts.delete(k); dirty = true } }

    // What the last action at each place said, drawn next to its control by
    // every render until that place is used again or the month changes.
    const notes = new Map<string, { kind: "ok" | "err"; text: string; scope?: string }>()
    const noteId = (spot: string): string => "rv-note-" + spot.replace(/[^A-Za-z0-9_-]/g, "-")
    function tell(s: State, spot: string, kind: "ok" | "err", text: string): void {
        // Finished after a switch to another month: say so at the top.
        if (s.month !== month) { spot = "top"; text = "เดือน " + monthName(s.month) + ": " + text }
        notes.set(spot, { kind, text })
        dirty = true
        if (kind === "err") shout(text)
        else say(text)
    }
    function noteEl(spot: string): HTMLElement | null {
        const n = notes.get(spot)
        if (!n) return null
        const p = el("p", "rv-note rv-note-" + n.kind)
        p.id = noteId(spot)
        if (n.kind === "err") p.append(el("strong", undefined, "ไม่สำเร็จ "), n.text)
        else p.textContent = "✓ " + n.text
        return p
    }
    // One request at a time per control: a second click while the first runs
    // does nothing. The button shows as unavailable (aria-disabled, so it
    // keeps focus) until the request ends; a re-render draws it the same way.
    const inflight = new Set<string>()
    const flightKey = (s: State, spot: string): string => s.month + "|" + spot
    const flying = (s: State, spot: string): boolean => inflight.has(flightKey(s, spot))
    function markBusy(b: HTMLElement): void { b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-busy", "true") }
    function begin(s: State, spot: string, btn?: HTMLElement | null): boolean {
        if (flying(s, spot)) return false
        inflight.add(flightKey(s, spot))
        if (s.month === month) {
            for (const k of [spot, "top"]) { notes.delete(k); const n = document.getElementById(noteId(k)); if (n) n.remove() }
        }
        if (btn) markBusy(btn)
        return true
    }
    const end = (s: State, spot: string): void => { inflight.delete(flightKey(s, spot)); dirty = true }

    // A visible failure with a way to try again (role=alert is on shout()).
    function failBox(text: string, id: string, retry: () => void): HTMLElement {
        const box = el("div", "rv-fail")
        const b = el("button", "btn-ghost", "ลองอีกครั้ง")
        b.type = "button"
        b.id = id
        b.addEventListener("click", retry)
        box.append(el("p", undefined, text), b)
        return box
    }

    const openRequest = (s: State): Request | null =>
        s.request && ["queued", "dispatched", "running"].includes(s.request.status) ? s.request : null
    const liveRound = (s: State): Round | null => s.rounds.find((r) => r.round_no === s.live) || null
    const auditeeTurn = (s: State): boolean => { const r = liveRound(s); return !r || r.status === "returned" }
    const inputsInBuild = (s: State): boolean =>
        !!(s.inputs && s.build && Number(s.build.budget) === Number(s.inputs.budget) && Number(s.build.per_p4p) === Number(s.inputs.per_p4p))
    // A build's blocking problems, but no_inputs: the empty fields and the
    // send bar already say it (Pong, 2026-11-10: the box was unnecessary).
    const blocking = (s: State): Build["problems"] =>
        (s.build ? s.build.problems.filter((p) => p.blocking && p.code !== "no_inputs") : [])

    const PROBLEM: Record<string, (p: Build["problems"][0]) => string> = {
        no_inputs: () => "ยังไม่ได้กรอกงบประมาณและจำนวนแพทย์ (กรอกที่หน้าภาพรวม)",
        inputs_not_in_sheet: () => "งบประมาณหรือ per P4P ใน SK03 ไม่ตรงกับที่บันทึกไว้",
        not_in_sk03: (p) => "SK03 ไม่มีชื่อ " + int(p.count || 0) + " คนตามรายชื่อเดือนนี้",
        no_doctor_sheet: (p) => "ไม่พบชีตของแพทย์ " + int(p.count || 0) + " คนในไฟล์รวม",
        not_in_dept_sheet: (p) => "ไม่พบชื่อในชีตกลุ่มงาน " + int(p.count || 0) + " คน",
    }

    // ── Loading ──────────────────────────────────────────────────────────
    let monthRows: MonthRow[] = []
    // fresh (opening the tab): a month the side shown cannot open is left
    // for the default. A later look keeps the month on screen. false: no
    // month to show (none at all, none the auditee can open, or not installed).
    async function loadMonths(fresh = false): Promise<boolean> {
        const r = await api<{ installed: boolean; months?: MonthRow[] }>("/dashboard/api/review/months")
        if (!r.installed) { renderNotInstalled(); return false }
        monthRows = r.months || []
        const keep = !!month && monthRows.some((m) => m.month === month && !(fresh && locked(m)))
        const pick = keep ? month : defaultMonth()
        if (pick !== month) { month = pick; resetMonth() }
        drawTabs()
        return month !== ""
    }
    // The month list again, for the tabs only: the month shown stays.
    async function refreshMonthRows(): Promise<void> {
        const r = await api<{ installed: boolean; months?: MonthRow[] }>("/dashboard/api/review/months")
        if (r.installed && r.months) { monthRows = r.months; drawTabs() }
    }
    // A month the doctors have not all sent, with nothing sent to the
    // auditor yet: the auditee side cannot open it (Pong, 2026-11-10). The
    // auditor opens only a month พร้อมตรวจ, or one approved (its document
    // and reopening live there) (Pong, 2026-11-12).
    const locked = (m: MonthRow): boolean => role === "auditee"
        ? !m.round && m.sent < m.total
        : !m.round || (m.round.status !== "submitted" && m.round.status !== "approved")
    // The oldest month not approved yet, else the newest, of those the side
    // shown can open.
    function defaultMonth(): string {
        const can = monthRows.filter((x) => !locked(x))
        const m = can.find((x) => !x.round || x.round.status !== "approved") || can[can.length - 1]
        return m ? m.month : ""
    }
    function noMonthCard(): HTMLElement {
        if (!monthRows.length) return card("ยังไม่มีเดือนให้ตรวจ", [el("p", undefined, "ยังไม่มีตารางรายชื่อตั้งแต่ ส.ค. 69")])
        const again = el("button", "btn-ghost", "ดูอีกครั้ง")
        again.type = "button"
        again.id = "rv-months-again"
        again.addEventListener("click", () => { void open() })
        if (role === "auditor") return card("ยังไม่มีเดือนที่พร้อมตรวจ", [el("p", undefined, "เมื่อผู้จัดทำส่งแล้วจะเปิดได้"), again])
        return card("ยังไม่มีเดือนที่แพทย์ส่งครบ", [el("p", undefined, "เปิดเดือนได้เมื่อแพทย์ส่งครบทุกคน"), again])
    }
    // One button per month, in time order; the status under it depends on
    // the side shown (redrawn on a role switch).
    function drawTabs(): void {
        const a = document.activeElement
        const had = a instanceof HTMLElement && monthBox.contains(a) ? a.id : ""
        monthBox.replaceChildren(...monthRows.map((m) => {
            const b = el("button", "rv-mtab")
            b.type = "button"
            b.id = "rv-m-" + m.month
            b.setAttribute("aria-pressed", String(m.month === month))
            const ms = monthStatus(m)
            const t = el("span", "rv-mtab-s rv-ms-" + ms.kind, ms.text)
            if (ms.sr) t.setAttribute("aria-hidden", "true")
            b.append(el("span", "rv-mtab-m", shortMonth(m.month)), t)
            if (ms.sr) b.append(el("span", "sr-only", " " + ms.sr))
            const off = locked(m)
            if (off) b.setAttribute("aria-disabled", "true")
            b.addEventListener("click", () => {
                if (!off) { pickMonth(m.month); return }
                // The list may be old: look again before saying no.
                void refreshMonthRows().catch(() => undefined).then(() => {
                    const now = monthRows.find((x) => x.month === m.month)
                    if (now && !locked(now)) pickMonth(m.month)
                    else say(shortMonth(m.month) + (role === "auditor" ? " ยังไม่พร้อมตรวจ" : " ยังเปิดไม่ได้ แพทย์ยังส่งไม่ครบ"))
                })
            })
            return b
        }))
        if (had) { const f = document.getElementById(had); if (f) f.focus() }
    }
    function pickMonth(m: string): void {
        if (!m || m === month) return
        month = m
        resetMonth()
        drawTabs()
        show(el("p", "rv-loading", "กำลังโหลดเดือน " + monthName(month) + "…"))
        void loadState(true).catch(loadFailed)
    }
    // Everything on screen belongs to one month: a switch drops the old
    // month's state, lists, drafts and notes, and any reply still on its way
    // for it (the sequence numbers no longer match).
    function resetMonth(): void {
        st = null; stJson = ""; loadError = ""; loadSeq++
        clearTimeout(poll); poll = undefined; pollFails = 0
        people = null; peopleKey = ""; peopleErr = ""; peopleSeq++
        issues = null; issuesKey = ""; issuesErr = ""; issuesSeq++
        details.clear(); detailErrs.clear(); detailLoading.clear(); detailSeq++
        selected = ""; lastRoundKey = ""
        rows = null; rowsKey = ""; rowsErr = ""; rowsSeq++; editing = ""; moreOpen = false
        drafts.clear(); fieldErrs.clear(); notes.clear(); draftScope = ""; remarkOpen.clear(); lastDecided = ""
    }
    const monthStatus = (m: MonthRow): { kind: string; text: string; sr?: string } => {
        const r = m.round
        const me = role === "auditee"
        if (r && r.status === "approved") return { kind: "ok", text: "อนุมัติแล้ว" }
        if (r && r.status === "returned") return me ? { kind: "fix", text: "ต้องแก้ " + int(r.fix || 0) } : { kind: "wait", text: "รอผู้จัดทำ" }
        // Not "ถึงคิวคุณ": a softer word for the auditor (Pong, 2026-11-12).
        if (r) return me ? { kind: "wait", text: "รอผู้ตรวจสอบ" } : { kind: "you", text: "พร้อมตรวจ" }
        if (m.sent < m.total) return { kind: "wait", text: "ส่ง " + int(m.sent) + "/" + int(m.total), sr: "แพทย์ส่งแล้ว " + int(m.sent) + " จาก " + int(m.total) + " คน" }
        return me ? { kind: "you", text: "ตรวจสอบ" } : { kind: "wait", text: "รอผู้จัดทำ" }
    }

    // Only the newest load of the month picked may draw: a slower reply for
    // another month, or an older one for this month, is dropped. fromPoll:
    // the 15 s look, which draws nothing when the state is unchanged.
    async function loadState(logView: boolean, fromPoll = false): Promise<void> {
        if (!month) return
        const m = month
        const seq = ++loadSeq
        const current = (): boolean => seq === loadSeq && m === month
        let s: State
        try {
            s = await api<State>("/dashboard/api/review/" + m + (logView ? "?view=1" : ""))
        } catch (e) {
            if (!current()) return
            throw e
        }
        if (!current()) return
        if (!s || typeof s !== "object") throw new ApiError("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง", 0)
        if (!s.installed) { st = null; stJson = ""; clearTimeout(poll); renderNotInstalled(); return }
        if (s.month && s.month !== m) return
        const json = JSON.stringify(s)
        const same = json === stJson && !loadError && !dirty
        st = s
        stJson = json
        loadError = ""
        if (!(fromPoll && same)) { freshState = true; render() }
        clearTimeout(poll)
        poll = undefined
        const r = liveRound(s)
        const pdfWaiting = !!(r && r.status === "approved" && (r.pdf_status === "queued" || r.pdf_status === "building"))
        if (openRequest(s) || pdfWaiting || emailWaiting(s)) poll = window.setTimeout(() => { void refresh() }, 15000)
    }
    // A failed load is shown: over the month's screen when it is still the
    // month picked (its actions stay right), or in place of it.
    function loadFailed(e: unknown): void {
        if (signedOut(e)) return
        const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ")
        shout(msg)
        if (st && st.month === month) { loadError = msg; render(); keepLooking(); return }
        show(failBox("โหลดข้อมูลเดือน " + monthName(month) + " ไม่สำเร็จ: " + msg, "rv-retry-load", () => {
            loadingLine("กำลังโหลด…")
            void loadState(true).catch(loadFailed)
        }))
        const b = document.getElementById("rv-retry-load")
        if (b && document.activeElement === document.body) b.focus()
    }
    // A failed load while a build or the PDF is on its way: keep looking.
    function keepLooking(): void {
        if (poll !== undefined || !st || st.month !== month) return
        const r = liveRound(st)
        const pdfWaiting = !!(r && r.status === "approved" && (r.pdf_status === "queued" || r.pdf_status === "building"))
        if (!openRequest(st) && !pdfWaiting && !emailWaiting(st)) return
        pollFails++
        poll = window.setTimeout(() => { void refresh() }, Math.min(15000 * Math.pow(2, pollFails), 120000))
    }
    // The loading line takes the focus a pressed retry button had.
    function loadingLine(text: string): void {
        const hadFocus = body.contains(document.activeElement) || side.contains(document.activeElement)
        const p = el("p", "rv-loading", text)
        p.tabIndex = -1
        show(p)
        if (hadFocus) p.focus()
    }
    const reload = (): Promise<void> => loadState(false).catch(loadFailed)
    // The look while a build or the PDF is on its way. A failed look tries
    // again later (30 s, 60 s, then every 2 minutes) instead of stopping.
    async function refresh(): Promise<void> {
        poll = undefined
        if (view.classList.contains("hidden")) return // opening the tab again loads and looks again
        if (busy) { poll = window.setTimeout(() => { void refresh() }, 3000); return }
        try {
            await loadState(false, true)
            pollFails = 0
        } catch (e) {
            if (signedOut(e)) return
            pollFails++
            const wait = Math.min(15000 * Math.pow(2, pollFails), 120000)
            clearTimeout(poll)
            poll = window.setTimeout(() => { void refresh() }, wait)
            if (st && st.month === month) {
                loadError = "อัปเดตอัตโนมัติไม่สำเร็จ (" + errText(e, NET_ERROR) + ") จะลองอีกครั้งใน " + int(Math.round(wait / 1000)) + " วินาที"
                if (pollFails === 1) say(loadError)
                render()
            }
        }
    }

    async function open(): Promise<void> {
        loadingLine("กำลังโหลด…")
        try {
            if (!(await loadMonths(true))) {
                if (body.querySelector(".rv-loading")) show(noMonthCard())
                return
            }
        } catch (e) {
            if (signedOut(e)) return
            const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ")
            shout(msg)
            show(failBox("โหลดแท็บตรวจสอบไม่สำเร็จ: " + msg, "rv-retry-open", () => { void open() }))
            return
        }
        await loadState(true).catch(loadFailed)
    }
    window.addEventListener("dashboard:review", () => { void open() })
    for (const b of roleBtns) {
        b.addEventListener("click", () => {
            role = b.dataset.role === "auditor" ? "auditor" : "auditee"
            try { localStorage.setItem(ROLE_KEY, role) } catch (e) { /* ignore */ }
            for (const x of roleBtns) x.setAttribute("aria-pressed", String(x.dataset.role === role))
            // Neither side stays on a month it cannot open (each side locks
            // its own months), and a side gets a month back after the
            // other side had none to show.
            const shown = monthRows.find((m) => m.month === month)
            if (monthRows.length && (!shown || locked(shown))) {
                const m = defaultMonth()
                if (m) pickMonth(m)
                else { month = ""; resetMonth(); drawTabs(); show(noMonthCard()) }
            } else {
                drawTabs()
                render()
            }
            say("มุมมอง" + (role === "auditor" ? "ผู้ตรวจสอบ" : "ผู้จัดทำ"))
        })
    }

    // ── Rendering ────────────────────────────────────────────────────────
    function card(title: string, children: Node[], id?: string): HTMLElement {
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", title)
        h.id = id || "rv-h-" + Math.random().toString(36).slice(2, 8)
        c.setAttribute("aria-labelledby", h.id)
        c.append(h, ...children)
        return c
    }
    function turn(kind: "you" | "wait" | "ok" | "bad", tag: string, title: string, sub?: string): HTMLElement {
        const t = el("div", "rv-turn rv-" + kind)
        t.setAttribute("role", "status")
        t.append(el("span", "rv-tag", tag), el("strong", undefined, title))
        if (sub) t.append(el("span", "rv-sub", sub))
        return t
    }
    function line(kind: "ok" | "bad" | "warn" | "info", text: string, extra?: Node): HTMLElement {
        const li = el("li", "rv-check rv-" + kind)
        const mark = el("span", "rv-mark", kind === "ok" ? "ถูกต้อง" : kind === "bad" ? "ต้องแก้" : kind === "warn" ? "ให้ผู้ตรวจดู" : "ข้อมูล")
        li.append(mark, el("span", undefined, text))
        if (extra) li.append(extra)
        return li
    }

    function renderNotInstalled(): void {
        show(card("ยังเปิดใช้แท็บนี้ไม่ได้", [
            el("p", undefined, "ฐานข้อมูลยังไม่มีตารางของแท็บตรวจสอบ หรือยังเป็นรุ่นเก่า ผู้ดูแลระบบต้องรันไฟล์ scripts/review-tab-2026-11.sql แล้วตามด้วย scripts/review-tab-2026-11-auditee.sql ใน Supabase SQL editor แล้วรีเฟรชหน้านี้"),
        ]))
    }

    // Redraws #review-body from st, drafts and notes. Every control that can
    // be focused has a stable id, so focus (and the caret in a text field)
    // comes back to the same control; if it is gone, to the heading of the
    // part it was in, never to the page.
    function render(): void {
        for (const b of roleBtns) b.setAttribute("aria-pressed", String(b.dataset.role === role))
        if (!st) return
        const s = st
        dirty = false
        const fresh = freshState
        freshState = false
        const lr = liveRound(s)
        const scope = s.month + ":" + (lr ? lr.round_no + ":" + lr.status : "")
        if (scope !== draftScope) { if (draftScope) { drafts.clear(); fieldErrs.clear(); remarkOpen.clear() } draftScope = scope }
        // A note stays while the screen it was written for is the one shown:
        // it takes the screen of the first state loaded after it, and a later
        // round step, build request or role switch clears it.
        const noteScope = scope + ":" + role + ":" + (s.request ? s.request.id + ":" + s.request.status : "")
        for (const [k, n] of notes) {
            if (n.scope === undefined) { if (fresh) n.scope = noteScope }
            else if (n.scope !== noteScope) notes.delete(k)
        }
        const a = document.activeElement as HTMLElement | null
        const inBody = !!a && a !== body && a !== side && (body.contains(a) || side.contains(a))
        const focusId = inBody && a ? a.id : ""
        const holder = inBody && a ? a.closest("[aria-labelledby]") : null
        const holderId = holder && (body.contains(holder) || side.contains(holder)) ? holder.getAttribute("aria-labelledby") || "" : ""
        let selA: number | null = null, selB: number | null = null
        if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
            try { selA = a.selectionStart; selB = a.selectionEnd } catch (e) { /* not a text field */ }
        }
        const viewTop = view.scrollTop
        const list = body.querySelector(".rv-people-list")
        const listTop = list ? list.scrollTop : 0
        refreshLists(s)
        const top: Node[] = []
        if (loadError) top.push(failBox(loadError, "rv-retry-load", () => { void reload() }))
        const tn = noteEl("top")
        if (tn) top.push(tn)
        sideOut = []
        const main = role === "auditee" ? auditee(s) : auditor(s)
        side.replaceChildren(...sideOut)
        body.replaceChildren(...top, ...main)
        const list2 = body.querySelector(".rv-people-list")
        if (list2) list2.scrollTop = listTop
        if (inBody) {
            const f = focusId ? document.getElementById(focusId) : null
            if (f) f.focus({ preventScroll: true })
            if (f && document.activeElement === f) {
                if (selA !== null && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) {
                    try { f.setSelectionRange(selA, selB === null ? selA : selB) } catch (e) { /* not a text field */ }
                }
            } else {
                const h = (holderId && document.getElementById(holderId)) || body.querySelector<HTMLElement>(".rv-turn, .rv-card-h")
                if (h) { if (!h.hasAttribute("tabindex")) h.tabIndex = -1; h.focus({ preventScroll: true }) }
            }
        }
        view.scrollTop = viewTop
        syncStick()
        markOpened(s)
    }

    // Opening a round on your side stops the other side taking it back.
    const opened = new Set<string>()
    function markOpened(s: State): void {
        const r = liveRound(s)
        if (!r) return
        const who = r.status === "submitted" && role === "auditor" && !r.auditor_opened_at ? "auditor"
            : r.status === "returned" && role === "auditee" && !r.auditee_opened_at ? "auditee" : ""
        const key = s.month + ":" + r.round_no + ":" + who
        if (!who || opened.has(key)) return
        opened.add(key)
        void post("/dashboard/api/review/" + s.month + "/opened", { role: who }).catch(() => { opened.delete(key) })
    }

    // ผู้จัดทำ ─────────────────────────────────────────────────────────────
    // Layout v5: budget and N (read-only) in one card with the Drive links, everyone in
    // the newest build in one table (edit a score inline), and one send bar.
    // Sending waits for: budget and N, a finished build that carries them,
    // still matches the roster, has no blocking problem and no score of
    // 30,000 or more or under 2,200 (the SQL refuses the same).
    function auditee(s: State): Node[] {
        const r = liveRound(s)
        if (r && r.status === "submitted") return [sentView(s, r)]
        if (r && r.status === "approved") return approvedView(s, r, "auditee")
        const complete = s.roster.total > 0 && s.roster.sent >= s.roster.total
        // Budget, N, per P4P and the Drive files sit in the left column,
        // with ส่ง under them (Pong, 2026-11-12: save screen height).
        sideOut.push(inputsCard(s))
        if (!r && !complete) return [waitingCard(s)]
        const out: Node[] = []
        if (r && r.status === "returned") {
            out.push(returnedCard(s, r))
            ensureIssues(s)
            if (issuesShown()) out.push(issuesCard(s, "auditee"))
            const more = el("section", "rv-card glass rv-more")
            const h = el("h2", "rv-card-h", "รายชื่อทั้งหมด")
            h.id = "rv-h-more"
            more.setAttribute("aria-labelledby", h.id)
            const row = el("div", "rv-actions")
            const t = el("button", "btn-ghost", moreOpen ? "ซ่อน" : "แสดง")
            t.type = "button"
            t.id = "rv-more-toggle"
            t.setAttribute("aria-expanded", String(moreOpen))
            t.setAttribute("aria-controls", "rv-more-body")
            t.addEventListener("click", () => { moreOpen = !moreOpen; render() })
            row.append(t)
            const inner = el("div", "rv-stack")
            inner.id = "rv-more-body"
            if (moreOpen) inner.append(...buildAlerts(s), listCard(s))
            else inner.hidden = true
            more.append(h, row, inner)
            out.push(more)
            if (!moreOpen) out.push(...buildAlerts(s).filter((n) => (n as HTMLElement).dataset.blocking === "1"))
        } else {
            out.push(...buildAlerts(s), listCard(s))
        }
        sideOut.push(sendBar(s))
        return out
    }
    let moreOpen = false

    function waitingCard(s: State): HTMLElement {
        const left = Math.max(0, s.roster.total - s.roster.sent)
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", shortMonth(s.month) + " · " + (s.roster.total ? "รอแพทย์ส่ง " + int(left) + " คน" : "ยังไม่มีรายชื่อ"))
        h.id = "rv-h-wait"
        c.setAttribute("aria-labelledby", h.id)
        const top = el("div", "rv-actions rv-spread")
        const a = el("a", "rv-link", "ดูรายชื่อในแท็บตามส่ง")
        a.href = "/dashboard/#followup"
        top.append(h, a)
        const bar = el("div", "rv-bar")
        bar.setAttribute("role", "progressbar")
        bar.setAttribute("aria-label", "แพทย์ส่งแล้ว")
        bar.setAttribute("aria-valuemin", "0")
        bar.setAttribute("aria-valuemax", String(s.roster.total))
        bar.setAttribute("aria-valuenow", String(s.roster.sent))
        bar.setAttribute("aria-valuetext", int(s.roster.sent) + " จาก " + int(s.roster.total) + " คน")
        const fill = el("div")
        fill.style.width = (s.roster.total ? Math.round(100 * s.roster.sent / s.roster.total) : 0) + "%"
        bar.append(fill)
        c.append(top, bar, el("p", "rv-hint", "ส่งแล้ว " + int(s.roster.sent) + " จาก " + int(s.roster.total) + " · ระบบสร้าง SK03 ให้เองเมื่อส่งครบ"))
        return c
    }

    const fmt2 = (n: number | null | undefined): string =>
        n === null || n === undefined ? "" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    // Budget and N are typed on the overview page (ภาพรวม, the month card's
    // งบ button; Pong, 2026-11-11), which also starts the month's build.
    // Here they are shown only, with a way there, and the two Drive files.
    function inputsCard(s: State): HTMLElement {
        const c = el("section", "rv-card glass rv-inputs")
        const h = el("h2", "sr-only", "งบประมาณและไฟล์")
        h.id = "rv-h-inputs"
        c.setAttribute("aria-labelledby", h.id)
        const inp = s.inputs
        const row = el("div", "rv-ro")
        const set = !!(inp && inp.doctors)
        const go = el("a", (set ? "btn-ghost" : "btn-primary") + " rv-go", set ? "แก้ที่หน้าภาพรวม →" : "กรอกที่หน้าภาพรวม →") as HTMLAnchorElement
        go.href = "/dashboard/#overview"
        if (inp) {
            row.append(kv("งบประมาณ (บาท)", budgetText(inp.budget)), kv("จำนวนแพทย์ (N)", inp.doctors ? int(inp.doctors) : "–"), kv("per P4P", baht(inp.per_p4p)))
        }
        if (!set) row.append(el("span", "rv-none", inp ? "ยังไม่ได้กรอกจำนวนแพทย์" : "ยังไม่ได้กรอกงบประมาณ"))
        row.append(go)
        c.append(h, row)
        if (s.build || openRequest(s) || s.request) c.append(filesRow(s))
        return c
    }

    // The two files in Drive, view only: the tab never offers them as the
    // files that are sent (that is the build the system checked).
    function filesRow(s: State): HTMLElement {
        const w = el("div", "rv-files")
        const lab = el("span", "rv-label", "ไฟล์ใน Google Drive ")
        const b = s.build
        const req = openRequest(s)
        if (!req) lab.append(el("span", "rv-hint", "· ดูอย่างเดียว"))
        w.append(lab)
        const row = el("div", "rv-actions")
        if (req) {
            const p = el("p", "rv-progress", q2text(req))
            row.append(p)
        } else {
            const link = (text: string, id: string | undefined, url: (x: string) => string): HTMLElement => {
                // No id: a build from before the file's id was kept, or the
                // upload failed. The next build stores it.
                if (!id) return el("span", "rv-hint", text + ": ยังไม่มีลิงก์")
                const a = el("a", "rv-link", text + " ")
                a.href = url(id)
                a.target = "_blank"
                a.rel = "noopener"
                const arrow = el("span", undefined, "↗")
                arrow.setAttribute("aria-hidden", "true")
                a.append(arrow, el("span", "sr-only", " " + shortMonth(s.month) + " (เปิดในแท็บใหม่)"))
                return a
            }
            if (b) {
                row.append(
                    link("SK03", b.sk03_file_id, (x) => "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(x) + "/preview"),
                    link("รวมค่าคะแนน", b.merged_file_id, (x) => "https://drive.google.com/file/d/" + encodeURIComponent(x) + "/view"),
                    el("span", "rv-hint", "อัปเดต " + when(b.built_at)))
            } else {
                row.append(el("span", "rv-hint", "ยังไม่มีไฟล์ · ระบบสร้างทุกคืนเมื่อแพทย์ส่งครบ"))
            }
            if (auditeeTurn(s)) {
                const rb = el("button", "btn-ghost", "สร้างใหม่")
                rb.type = "button"
                rb.id = "rv-rebuild"
                if (flying(s, "rebuild")) markBusy(rb)
                rb.addEventListener("click", () => { void doRebuild(s, rb) })
                row.append(rb)
            }
        }
        w.append(row)
        const n = noteEl("rebuild")
        if (n) w.append(n)
        return w
    }
    const q2text = (q: Request): string => q.status === "running"
        ? "กำลังสร้าง SK03 และรวมค่าคะแนนใหม่ · ~10 นาที"
        : "รอเริ่มสร้าง SK03 และรวมค่าคะแนนใหม่ · ~10 นาที"

    async function doRebuild(s: State, btn: HTMLElement): Promise<void> {
        if (!begin(s, "rebuild", btn)) return
        try {
            await post(monthApi(s) + "/rebuild")
            tell(s, "rebuild", "ok", "ขอสร้างใหม่แล้ว · ~10 นาที หน้านี้อัปเดตเอง")
        } catch (e) {
            tell(s, "rebuild", "err", errText(e, "ขอสร้างใหม่ไม่สำเร็จ"))
        } finally {
            end(s, "rebuild")
        }
        await reload()
    }

    // The newest failed build request (after the newest build), shown once
    // as an alert; and the build's problems: blocking ones first.
    let announcedFail = 0
    function buildAlerts(s: State): HTMLElement[] {
        const out: HTMLElement[] = []
        const q = s.request
        if (q && q.status === "failed" && !openRequest(s) && (!s.build || Date.parse(q.requested_at) > Date.parse(s.build.built_at))) {
            const why = q.error === "timed out" ? "งานสร้างไฟล์ไม่เสร็จในเวลาที่กำหนด" : (q.error || "ไม่ทราบสาเหตุ")
            const box = el("div", "rv-alert")
            box.dataset.blocking = "1"
            box.append(el("strong", undefined, "สร้างไฟล์ไม่สำเร็จ"), el("span", undefined, why + (q.finished_at ? " · " + when(q.finished_at) : "")))
            if (auditeeTurn(s)) {
                const b = el("button", "btn-ghost", "ลองอีกครั้ง")
                b.type = "button"
                b.id = "rv-rebuild-retry"
                if (flying(s, "rebuild")) markBusy(b)
                b.addEventListener("click", () => { void doRebuild(s, b) })
                box.append(b)
            }
            out.push(box)
            if (announcedFail !== q.id && s.month === month) { announcedFail = q.id; shout("สร้างไฟล์ไม่สำเร็จ: " + why) }
        }
        const b = s.build
        if (!b || openRequest(s)) return out
        const text = (p: Build["problems"][0]): string => (PROBLEM[p.code] || (() => p.code))(p) +
            (p.names && p.names.length ? ": " + p.names.slice(0, 8).join(", ") + (p.names.length > 8 ? " และอีก " + int(p.names.length - 8) + " คน" : "") : "")
        const blockers = blocking(s)
        const notes2 = b.problems.filter((p) => !p.blocking && p.code !== "no_inputs")
        if (blockers.length || s.stale > 0) {
            const box = el("div", "rv-alert")
            box.dataset.blocking = "1"
            box.append(el("strong", undefined, "ต้องแก้ก่อนส่ง"))
            const ul = el("ul")
            for (const p of blockers) ul.append(el("li", undefined, text(p)))
            if (s.stale > 0) ul.append(el("li", undefined, "รายชื่อหรือคะแนนเปลี่ยนหลังสร้างไฟล์ " + int(s.stale) + " คน · สร้างใหม่ให้ตรงก่อนส่ง"))
            box.append(ul)
            const row = el("div", "rv-actions")
            if (blockers.some((p) => p.code === "not_in_sk03" || p.code === "no_doctor_sheet" || p.code === "not_in_dept_sheet")) {
                const a = el("a", "rv-link", "แก้ในแท็บรายชื่อ")
                a.href = "/dashboard/#roster"
                row.append(a)
            }
            if (s.stale > 0 && auditeeTurn(s)) {
                const rb = el("button", "btn-ghost", "สร้างใหม่")
                rb.type = "button"
                rb.id = "rv-rebuild-stale"
                if (flying(s, "rebuild")) markBusy(rb)
                rb.addEventListener("click", () => { void doRebuild(s, rb) })
                row.append(rb)
            }
            if (row.childNodes.length) box.append(row)
            out.push(box)
        }
        if (notes2.length) {
            const box = el("div", "rv-alert rv-alert-soft")
            const ul = el("ul")
            for (const p of notes2) ul.append(el("li", undefined, text(p)))
            box.append(el("strong", undefined, "ให้ผู้ตรวจสอบดู"), ul)
            out.push(box)
        }
        return out
    }

    // ── The auditee's list: everyone in the newest build ─────────────────
    interface Row {
        index: string
        name: string
        department: string
        intern: boolean
        sk03Row: number | null
        score: number | null
        stated: number | null
        statedCell: string | null
        statedHow: string
        sheet: string | null
        pay: number | null
        deptPay: number | null
        scoreCheck: "match" | "mismatch" | "missing"
        moneyCheck: "match" | "mismatch" | "missing"
        onRoster: boolean
        roster: number | null
        edit: { old: number | null; new: number; note: string; at: string; by: string } | null
    }
    let rows: Row[] | null = null
    let rowsKey = ""
    let rowsErr = ""
    let rowsSeq = 0
    let aFilter = "all"
    let aSearch = ""
    let editing = ""
    let searchSay: number | undefined
    const rowsWant = (s: State): string => s.month + ":" + (s.build ? s.build.id : "") + ":" + s.stale + ":" + s.edits
    async function loadRows(s: State): Promise<void> {
        const seq = ++rowsSeq
        rowsKey = rowsWant(s)
        rowsErr = ""
        try {
            const res = await api<{ people: Row[] }>(monthApi(s) + "/list")
            if (seq !== rowsSeq || s.month !== month) return
            rows = res.people || []
        } catch (e) {
            if (seq !== rowsSeq || s.month !== month || signedOut(e)) return
            rowsKey = ""
            rowsErr = errText(e, "โหลดรายชื่อไม่สำเร็จ")
            shout("โหลดรายชื่อไม่สำเร็จ: " + rowsErr)
        }
        render()
    }
    const ensureRows = (s: State): void => { if (s.build && rowsKey !== rowsWant(s) && !rowsErr) void loadRows(s) }

    const sameScore = (a: number | null, b: number | null): boolean =>
        a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) < 0.005
    // The score now on the roster (where an edit goes), else the build's.
    const curScore = (p: Row): number | null => (p.onRoster ? p.roster : p.score)
    const pending = (p: Row): boolean => p.onRoster && !sameScore(p.roster, p.score)
    const flagOf = (n: number | null): "high" | "low" | null =>
        n === null || !isFinite(Number(n)) ? null : Number(n) >= 30000 ? "high" : Number(n) < 2200 ? "low" : null
    const resent = (p: Row): boolean => !!p.edit && p.onRoster && !sameScore(p.roster, p.edit.new)
    const FLAG_TEXT = { high: "30,000 ขึ้นไป", low: "ต่ำกว่า 2,200" }
    const isDiff = (p: Row): boolean => p.scoreCheck === "mismatch" || p.moneyCheck === "mismatch"
    const isMiss = (p: Row): boolean => p.scoreCheck === "missing" || p.moneyCheck === "missing"
    const FILTERS: [string, string, (p: Row) => boolean][] = [
        ["all", "ทั้งหมด", () => true],
        ["diff", "ไม่ตรง", isDiff],
        ["miss", "ไม่พบข้อมูล", isMiss],
        ["edited", "แก้แล้ว", (p) => !!p.edit],
        ["flag", "คะแนนผิดปกติ", (p) => !!flagOf(curScore(p))],
    ]
    const MISS_TEXT: Record<string, string> = {
        uncached: "ยอดรวมในไฟล์แพทย์เป็นสูตรที่ไม่ได้บันทึกค่า", none: "ไม่พบยอดรวมในไฟล์แพทย์", empty: "ไฟล์แพทย์ว่าง", "no-sheet": "ไม่พบไฟล์แพทย์",
    }

    function listCard(s: State): HTMLElement {
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", "รายชื่อ")
        h.id = "rv-h-list"
        c.setAttribute("aria-labelledby", h.id)
        if (!s.build) {
            c.append(h, el("p", "rv-hint", openRequest(s) ? "รอสร้างไฟล์เสร็จ แล้วรายชื่อและผลเทียบจะขึ้นที่นี่" : "รายชื่อและผลเทียบจะขึ้นที่นี่เมื่อระบบสร้างไฟล์แล้ว"))
            return c
        }
        ensureRows(s)
        const head = el("div", "rv-actions rv-list-head")
        head.append(h)
        const all = rows || []
        const fl = el("div", "rv-filters")
        fl.setAttribute("role", "group")
        fl.setAttribute("aria-label", "แสดง")
        for (const [k, t, f] of FILTERS) {
            const b = el("button", "rv-flt", t + " " + int(all.filter(f).length))
            b.type = "button"
            b.id = "rv-flt-" + k
            b.setAttribute("aria-pressed", String(aFilter === k))
            b.addEventListener("click", () => { aFilter = k; render(); say(t + " " + int(all.filter(f).length) + " คน") })
            fl.append(b)
        }
        const sl = el("label", "rv-search")
        sl.append(el("span", "sr-only", "ค้นหาชื่อหรือกลุ่มงาน"))
        const si = el("input")
        si.type = "search"
        si.id = "rv-a-search"
        si.placeholder = "ค้นหาชื่อหรือกลุ่มงาน"
        si.autocomplete = "off"
        si.value = aSearch
        si.addEventListener("input", () => {
            aSearch = si.value
            render()
            clearTimeout(searchSay)
            searchSay = window.setTimeout(() => { say(int(body.querySelectorAll(".rv-table tbody tr[data-i]").length) + " คน") }, 700)
        })
        sl.append(si)
        head.append(fl, sl)
        c.append(head)
        if (rowsErr) { c.append(failBox("โหลดรายชื่อไม่สำเร็จ: " + rowsErr, "rv-retry-rows", () => { rowsErr = ""; render() })); return c }
        if (!rows) { c.append(el("p", "rv-loading", "กำลังโหลดรายชื่อ…")); return c }

        // The alert: scores of 30,000 or more, or under 2,200.
        const high = all.filter((p) => flagOf(curScore(p)) === "high").length
        const low = all.filter((p) => flagOf(curScore(p)) === "low").length
        if (high + low) {
            const w = el("div", "rv-warnbar")
            w.append(el("strong", undefined, "คะแนนผิดปกติ " + int(high + low) + " คน"),
                el("span", undefined, [high ? "30,000 ขึ้นไป " + int(high) + " คน" : "", low ? "ต่ำกว่า 2,200 " + int(low) + " คน" : ""].filter(Boolean).join(" · ") + " · แก้ก่อนส่ง"))
            if (aFilter !== "flag") {
                const b = el("button", "btn-ghost", "ดูรายชื่อ")
                b.type = "button"
                b.id = "rv-flag-show"
                b.addEventListener("click", () => { aFilter = "flag"; render(); const f = document.getElementById("rv-flt-flag"); if (f) f.focus() })
                w.append(b)
            }
            c.append(w)
        }

        const q = aSearch.trim().toLowerCase()
        const pick = (FILTERS.find((x) => x[0] === aFilter) || FILTERS[0])[2]
        const shown = all.filter((p) => pick(p) && (!q || p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)))
        const box = el("div", "rv-table-box")
        const tbl = el("table", "rv-table")
        const cap = el("caption", "sr-only", "รายชื่อ " + shortMonth(s.month) + " · " + int(shown.length) + " คน")
        const hr = el("tr")
        for (const [x, cls] of [["ชื่อ-นามสกุล", ""], ["กลุ่มงาน", ""], ["คะแนน", "num"], ["ไฟล์แพทย์", "num"], ["ผล", ""]]) {
            const th = el("th", cls, x); th.scope = "col"; hr.append(th)
        }
        const canEdit = auditeeTurn(s)
        if (canEdit) { const th = el("th"); th.scope = "col"; th.append(el("span", "sr-only", "แก้คะแนน")); hr.append(th) }
        const thead = el("thead"); thead.append(hr)
        const tbody = el("tbody")
        for (const p of shown) {
            const editingHere = canEdit && editing === "list:" + p.index
            const tr = el("tr", editingHere ? "on" : "")
            tr.dataset.i = p.index
            const name = el("td", undefined, p.name)
            const dept = el("td", undefined, p.intern ? "INTERN" : p.department)
            const sc = el("td", "num")
            if (editingHere) sc.append(...scoreEditor(s, p, "list"))
            else scoreCell(sc, p)
            const st = el("td", "num", p.stated === null ? "–" : num2(p.stated))
            const res = el("td")
            res.append(...resultChips(p))
            tr.append(name, dept, sc, st, res)
            if (canEdit) {
                const td = el("td", "rv-edit-cell")
                if (!editingHere) td.append(editButton(p, "list"))
                tr.append(td)
            }
            tbody.append(tr)
            if (editingHere) {
                const tr2 = el("tr", "on")
                const td = el("td")
                td.colSpan = 6
                td.append(editActions(s, p, "list"))
                tr2.append(td)
                tbody.append(tr2)
            }
        }
        if (!shown.length) {
            const tr = el("tr"); const td = el("td", "rv-hint", "ไม่มีรายชื่อ"); td.colSpan = canEdit ? 6 : 5; tr.append(td); tbody.append(tr)
        }
        tbl.append(cap, thead, tbody)
        box.append(tbl)
        c.append(box)
        if (openRequest(s) || all.some(pending)) c.append(el("p", "rv-hint", "ผลเทียบจะอัปเดตเมื่อสร้างไฟล์ใหม่เสร็จ"))
        const n = noteEl("score")
        if (n) c.append(n)
        return c
    }
    const num2 = (n: number | null): string => n === null ? "–" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    function scoreCell(td: HTMLElement, p: Row): void {
        const cur = curScore(p)
        td.append(el("span", flagOf(cur) ? "rv-flagged" : "", num2(cur)))
        if (resent(p) && p.edit) td.append(el("span", "rv-old", "แก้ไว้ " + num2(p.edit.new)))
        else if (p.edit && p.edit.old !== null) td.append(el("span", "rv-old", "เดิม " + num2(p.edit.old)))
        if (pending(p)) td.append(el("span", "rv-old", "รอไฟล์ใหม่"))
    }

    function resultChips(p: Row): Node[] {
        const out: Node[] = []
        const fl = flagOf(curScore(p))
        if (fl) out.push(chip("warn", FLAG_TEXT[fl]))
        if (resent(p)) out.push(chip("warn", "แพทย์ส่งไฟล์ใหม่หลังแก้"))
        else if (p.edit) out.push(chip("edit", "แก้แล้ว"))
        if (!pending(p)) {
            if (p.scoreCheck === "mismatch") out.push(chip("bad", "คะแนนไม่ตรง"))
            if (p.moneyCheck === "mismatch") out.push(chip("bad", "เงินไม่ตรง"))
            if (p.scoreCheck === "missing" || p.moneyCheck === "missing") {
                out.push(chip("miss", "ไม่พบข้อมูล"))
                out.push(el("span", "rv-old", p.scoreCheck === "missing" ? (MISS_TEXT[p.statedHow] || "ไม่พบยอดรวมในไฟล์แพทย์")
                    : p.sk03Row === null ? "ไม่มีใน SK03" : "ไม่พบในชีตกลุ่มงาน"))
            }
        }
        if (!out.length) {
            const ok = el("span", "rv-ok-mark")
            const m = el("span", undefined, "✓")
            m.setAttribute("aria-hidden", "true")
            ok.append(m, el("span", "sr-only", "ตรงกัน"))
            out.push(ok)
        }
        return out
    }

    // where: "list" (the รายชื่อ table) or "fix" (a person sent back); one
    // score is edited at a time, and its controls' ids say where it is.
    type Where = "list" | "fix"
    const eid = (kind: string, where: Where, p: Row): string => "rv-" + kind + "-" + where + "-" + p.index
    function editButton(p: Row, where: Where): HTMLElement {
        const b = el("button", "rv-icon-btn", "แก้คะแนน")
        b.type = "button"
        b.id = eid("edit", where, p)
        b.append(el("span", "sr-only", " " + p.name))
        b.addEventListener("click", () => {
            editing = where + ":" + p.index
            render()
            const i = document.getElementById(eid("score", where, p)) as HTMLInputElement | null
            if (i) { i.focus(); i.select() }
        })
        return b
    }

    // The new score, with the warning under it while it is out of range.
    const SCORE_RE = /^\d+(\.\d{1,2})?$/
    function scoreWarn(v: string): string {
        const t = v.replace(/,/g, "").trim()
        if (!SCORE_RE.test(t)) return ""
        const fl = flagOf(Number(t))
        return fl === "high" ? "คะแนน 30,000 ขึ้นไป ตรวจอีกครั้ง" : fl === "low" ? "ต่ำกว่า 2,200 ได้ 0 บาท ตรวจอีกครั้ง" : ""
    }
    function scoreEditor(s: State, p: Row, where: Where): Node[] {
        const id = eid("score", where, p)
        const lab = el("label", "sr-only", "คะแนนใหม่ " + p.name)
        lab.htmlFor = id
        const i = keep(el("input"), "score:" + p.index, fmt2(curScore(p)))
        i.id = id
        i.type = "text"
        i.inputMode = "decimal"
        i.autocomplete = "off"
        i.className = "rv-score-in"
        const fe = fieldErrs.get("score:" + p.index)
        const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "")
        err.id = id + "-e"
        const warn = el("p", "rv-warn-text")
        warn.id = id + "-w"
        const paint = (): void => { const w = scoreWarn(i.value); warn.textContent = w; warn.hidden = !w }
        paint()
        i.addEventListener("input", paint)
        if (fe) i.setAttribute("aria-invalid", "true")
        i.setAttribute("aria-describedby", err.id + " " + warn.id)
        i.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); const b = document.getElementById(eid("score-save", where, p)); if (b) b.click() }
            if (ev.key === "Escape") { ev.preventDefault(); cancelEdit(s, p, where) }
        })
        const out: Node[] = [lab, i, err, warn]
        if (p.edit && p.edit.old !== null && !resent(p)) out.push(el("span", "rv-old", "เดิม " + num2(p.edit.old)))
        else if (curScore(p) !== null) out.push(el("span", "rv-old", "เดิม " + num2(curScore(p))))
        return out
    }
    function editActions(s: State, p: Row, where: Where): HTMLElement {
        const w = el("div", "rv-edit-actions")
        const nid = eid("enote", where, p)
        const lab = el("label", "rv-label", "หมายเหตุ ")
        lab.htmlFor = nid
        lab.append(el("span", "rv-hint", "(ถ้ามี)"))
        const note = keep(el("input"), "enote:" + p.index, "")
        note.id = nid
        note.type = "text"
        note.maxLength = 500
        note.autocomplete = "off"
        note.className = "rv-note-in"
        const save = el("button", "btn-primary", "บันทึก")
        save.type = "button"
        save.id = eid("score-save", where, p)
        save.append(el("span", "sr-only", " คะแนน " + p.name))
        const spot = "score-" + p.index
        if (flying(s, spot)) markBusy(save)
        save.addEventListener("click", () => { void saveScore(s, p, save, where) })
        const cancel = el("button", "btn-ghost", "ยกเลิก")
        cancel.type = "button"
        cancel.id = eid("score-cancel", where, p)
        cancel.addEventListener("click", () => cancelEdit(s, p, where))
        w.append(lab, note, save, cancel)
        const n = noteEl(spot)
        if (n) w.append(n)
        return w
    }
    function cancelEdit(s: State, p: Row, where: Where): void {
        editing = ""
        forget(s, "score:" + p.index, "enote:" + p.index)
        fieldErrs.delete("score:" + p.index)
        notes.delete("score-" + p.index)
        render()
        const b = document.getElementById(eid("edit", where, p))
        if (b) b.focus()
    }
    async function saveScore(s: State, p: Row, btn: HTMLElement, where: Where): Promise<void> {
        const spot = "score-" + p.index
        if (flying(s, spot)) return
        const i = document.getElementById(eid("score", where, p)) as HTMLInputElement | null
        const ni = document.getElementById(eid("enote", where, p)) as HTMLInputElement | null
        if (!i) return
        const v = i.value.replace(/,/g, "").trim()
        if (!SCORE_RE.test(v) || Number(v) >= 1e6) {
            fieldErrs.set("score:" + p.index, "ใส่ตัวเลข เช่น 2,480.00")
            render()
            const j = document.getElementById(eid("score", where, p))
            if (j) j.focus()
            return
        }
        fieldErrs.delete("score:" + p.index)
        if (!begin(s, spot, btn)) return
        busy = true
        let ok = false
        try {
            const r = await post<{ changed: boolean }>(monthApi(s) + "/scores/" + p.index, { score: v, note: ni ? ni.value : "" }, "PUT")
            ok = true
            tell(s, "score", "ok", p.name + ": " + (r.changed ? "บันทึกคะแนน " + num2(Number(v)) + " แล้ว · กำลังสร้างไฟล์ใหม่" : "คะแนนเท่าเดิม"))
        } catch (e) {
            const msg = errText(e, "บันทึกไม่สำเร็จ")
            if (e instanceof ApiError && e.status === 400) fieldErrs.set("score:" + p.index, msg)
            tell(s, spot, "err", msg)
        } finally {
            busy = false
            end(s, spot)
        }
        if (ok) {
            editing = ""
            forget(s, "score:" + p.index, "enote:" + p.index)
            rowsKey = ""
            if (people && s.month === month) peopleKey = ""
        }
        await reload()
        if (ok) {
            const b = document.getElementById(eid("edit", where, p)) || document.getElementById(where === "fix" ? "rv-h-ans" : "rv-h-list")
            if (b) { if (!b.hasAttribute("tabindex") && b.tagName === "H2") b.tabIndex = -1; b.focus() }
        }
    }

    // ── Send ─────────────────────────────────────────────────────────────
    function submitReasons(s: State): string[] {
        const why: string[] = []
        if (!auditeeTurn(s)) return ["ส่งให้ผู้ตรวจสอบแล้ว"]
        if (s.roster.sent < s.roster.total) why.push("รอแพทย์ส่งครบ")
        if (!s.inputs || !s.inputs.doctors) why.push("กรอกงบประมาณที่หน้าภาพรวม")
        if (openRequest(s)) why.push("รอสร้างไฟล์ใหม่เสร็จ")
        else if (!s.build) why.push("รอระบบสร้างไฟล์")
        else {
            if (s.inputs && s.inputs.doctors && !inputsInBuild(s)) why.push("กดสร้างใหม่ให้มีงบประมาณล่าสุด")
            else if (s.stale > 0) why.push("กดสร้างใหม่ (รายชื่อหรือคะแนนเปลี่ยน)")
            if (blocking(s).length) why.push("แก้ปัญหาด้านบนก่อน")
            const c = s.buildChecks
            const flagged = c ? Number(c.high || 0) + Number(c.low || 0) : 0
            if (flagged) why.push("แก้คะแนนผิดปกติ " + int(flagged) + " คน")
        }
        return why
    }

    function sendBar(s: State): HTMLElement {
        const why = submitReasons(s)
        const r = liveRound(s)
        const next = r ? r.round_no + 1 : 1
        const bar = el("div", "rv-sendbar glass")
        const reason = el("span", "rv-hint")
        reason.id = "rv-send-why"
        const send = el("button", "btn-primary rv-lg", next > 1 ? "ส่งรอบที่ " + next : "ส่งให้ผู้ตรวจสอบ")
        send.type = "button"
        send.id = "rv-send"
        if (why.length) {
            reason.textContent = why.join(" · ")
            send.setAttribute("aria-disabled", "true")
            send.setAttribute("aria-describedby", reason.id)
        }
        if (flying(s, "send")) markBusy(send)
        send.addEventListener("click", () => {
            if (why.length) { say("ยังส่งไม่ได้: " + why.join(" · ")); return }
            openConfirm(s, next)
        })
        bar.append(reason, send)
        return bar
    }

    function kv(label: string, value: string): HTMLElement {
        const d = el("div", "rv-kv")
        d.append(el("span", undefined, label), el("b", undefined, value))
        return d
    }
    function kvGrid(budget: number | null, doctors: number | null | undefined, perP4p: number | null, edits?: number): HTMLElement {
        const g = el("div", "rv-kvs")
        g.append(kv("งบประมาณ", budgetText(budget)), kv("N", doctors ? int(doctors) : "–"), kv("per P4P", baht(perP4p)))
        if (edits !== undefined) g.append(kv("แก้คะแนน", int(edits) + " คน"))
        return g
    }

    function openConfirm(s: State, roundNo: number): void {
        const inp = s.inputs
        if (!inp) return
        const kids: Node[] = [kvGrid(inp.budget, inp.doctors, inp.per_p4p)]
        const c = s.buildChecks
        const odd = c ? Number(c.scoreMismatch) + Number(c.moneyMismatch) + Number(c.scoreMissing) + Number(c.moneyMissing) : 0
        const bits = [s.edits ? "แก้คะแนน " + int(s.edits) + " คน" : "", "ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิด"].filter(Boolean)
        kids.push(el("p", undefined, bits.join(" · ")))
        if (s.emails) kids.push(el("p", "rv-hint", "ระบบจะส่งอีเมลถึงผู้ตรวจสอบ พร้อมไฟล์ SK03 และรวมค่าคะแนน"))
        if (odd) kids.push(el("p", "rv-hint", "ผลเทียบไม่ตรงหรือไม่พบข้อมูล " + int(odd) + " รายการ · ผู้ตรวจสอบจะพิจารณา"))
        askConfirm(roundNo > 1 ? "ส่งรอบที่ " + roundNo + " ของ " + shortMonth(s.month) + "?" : "ส่ง " + shortMonth(s.month) + " ให้ผู้ตรวจสอบ?", kids, "ส่ง", () => doSubmit(s))
    }
    // One confirm dialog for every step that hands the month to the other
    // side. Each action keeps the s the dialog was written from.
    let confirmAction: (() => Promise<void>) | null = null
    let confirmBusy = false
    let confirmReturn = ""
    let confirmErr: HTMLElement | null = null
    function askConfirm(title: string, kids: Node[], button: string, action: () => Promise<void>): void {
        confirmTitle.textContent = title
        const err = el("p", "rv-err rv-confirm-err")
        err.id = "review-confirm-err"
        err.setAttribute("role", "alert")
        confirmErr = err
        confirmBody.replaceChildren(...kids, err)
        confirmSend.textContent = button
        if (!confirmBusy) {
            confirmSend.removeAttribute("aria-disabled")
            confirmSend.removeAttribute("aria-busy")
        }
        confirmAction = action
        const a = document.activeElement as HTMLElement | null
        confirmReturn = a && a.id ? a.id : ""
        confirmDlg.showModal()
    }
    confirmSend.addEventListener("click", () => { if (confirmAction && !confirmBusy) void confirmAction() })
    // Esc and ยกเลิก do not close it while the step is being sent (the
    // capture listener runs before the shared data-close one in app.ts).
    confirmDlg.addEventListener("cancel", (ev) => { if (confirmBusy) ev.preventDefault() })
    const confirmCancel = confirmDlg.querySelector<HTMLElement>("[data-close]")
    confirmDlg.addEventListener("click", (ev) => {
        if (confirmBusy && confirmCancel && ev.target instanceof Node && confirmCancel.contains(ev.target)) { ev.stopPropagation(); ev.preventDefault() }
    }, true)
    // The button that opened it may have been redrawn while it was open.
    confirmDlg.addEventListener("close", () => {
        const a = document.activeElement
        if ((!a || a === document.body || confirmDlg.contains(a)) && confirmReturn) {
            const f = document.getElementById(confirmReturn)
            if (f) f.focus()
            else focusTop()
        }
    })
    // Sends a dialog's step: on success the dialog closes; on a refusal or
    // a network error it stays open with the reason inside it.
    async function confirmRun(s: State, call: () => Promise<string>): Promise<boolean> {
        if (confirmBusy) return false
        confirmBusy = true
        markBusy(confirmSend)
        if (confirmCancel) confirmCancel.setAttribute("aria-disabled", "true")
        const sent = confirmAction
        const err = confirmErr
        if (err) err.textContent = ""
        try {
            const done = await call()
            if (confirmDlg.open && confirmAction === sent) confirmDlg.close()
            tell(s, "top", "ok", done)
            return true
        } catch (e) {
            const msg = errText(e, "ทำรายการไม่สำเร็จ")
            if (confirmDlg.open && confirmAction === sent && err && err.isConnected) setTimeout(() => { err.textContent = msg }, 50)
            else { tell(s, "top", "err", msg); if (s.month === month) render() }
            return false
        } finally {
            confirmBusy = false
            if (confirmCancel) confirmCancel.removeAttribute("aria-disabled")
            confirmSend.removeAttribute("aria-disabled")
            confirmSend.removeAttribute("aria-busy")
        }
    }
    async function doSubmit(s: State): Promise<void> {
        const ok = await confirmRun(s, async () => {
            const r = await post<{ round: { round_no: number } }>(monthApi(s) + "/rounds")
            return "ส่งรอบที่ " + r.round.round_no + " ให้ผู้ตรวจสอบแล้ว"
        })
        if (ok) { moreOpen = false; await loadMonths().catch(() => false) }
        await reload()
        if (ok) focusTop()
    }
    function focusTop(): void {
        const h = body.querySelector<HTMLElement>(".rv-turn, .rv-card-h")
        if (h) { h.tabIndex = -1; h.focus() }
    }

    // Sent: the auditor's turn.
    function sentView(s: State, r: Round): HTMLElement {
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", (r.round_no > 1 ? "ส่งรอบที่ " + r.round_no + " ของ " : "ส่ง ") + shortMonth(s.month) + " แล้ว · รอผู้ตรวจสอบ")
        h.id = "rv-h-sent"
        c.setAttribute("aria-labelledby", h.id)
        const top = el("div", "rv-actions rv-spread")
        const t = el("div")
        t.append(h, el("p", "rv-hint", r.reopened_at
            ? "ผู้ตรวจสอบยกเลิกเอกสารและเปิดตรวจอีกครั้ง " + when(r.reopened_at) + (r.reopen_reason ? " · " + r.reopen_reason : "")
            : when(r.submitted_at) + " · " + (r.auditor_opened_at ? "ผู้ตรวจสอบเปิดแล้ว " + when(r.auditor_opened_at) : "ผู้ตรวจสอบยังไม่เปิด")))
        top.append(t)
        if (!r.auditor_opened_at) {
            const w = el("button", "btn-ghost", "ดึงกลับ")
            w.type = "button"
            w.id = "rv-withdraw"
            if (flying(s, "withdraw")) markBusy(w)
            w.addEventListener("click", () => { void doWithdraw(s, w) })
            top.append(w)
        }
        c.append(top, kvGrid(r.budget, r.doctors, r.per_p4p, r.edits || 0))
        const n = noteEl("withdraw")
        if (n) c.append(n)
        const mail = emailBox(s, r)
        if (mail) c.append(mail)
        return c
    }
    async function doWithdraw(s: State, btn: HTMLButtonElement): Promise<void> {
        if (!begin(s, "withdraw", btn)) return
        let ok = false
        try {
            await post(monthApi(s) + "/rounds/withdraw")
            tell(s, "top", "ok", "ดึงกลับแล้ว แก้แล้วส่งใหม่ได้")
            ok = true
        } catch (e) {
            tell(s, "withdraw", "err", errText(e, "ดึงกลับไม่สำเร็จ"))
        } finally {
            end(s, "withdraw")
        }
        if (ok) await loadMonths().catch(() => false)
        await reload()
        if (ok) focusTop()
    }

    // The round's email to the auditor (Pong, 2026-11-12): sending a round
    // queues it and the always-on relay sends it within about a minute.
    // ส่งอีเมล sends it (again) for a month sent before this existed, a
    // failed email, or after a test; the SQL refuses once a real one went out.
    const roundEmails = (s: State, r: Round): Email[] => (s.emails || []).filter((e) => e.round_id === r.id)
    function emailWaiting(s: State): boolean {
        const r = liveRound(s)
        return !!r && roundEmails(s, r).some((e) => e.status === "queued" || e.status === "sending")
    }
    function emailBox(s: State, r: Round): HTMLElement | null {
        if (!s.emails) return null
        const list = roundEmails(s, r)
        const real = list.find((e) => e.status === "sent" && !e.test)
        const open = list.find((e) => e.status === "queued" || e.status === "sending")
        const last = list[0]
        const w = el("div", "rv-email")
        w.id = "rv-email"
        let button = ""
        if (real) {
            const p = el("p", "rv-hint")
            const mark = el("span", "rv-ok-mark", "✓ ")
            mark.setAttribute("aria-hidden", "true")
            p.append(mark, "ส่งอีเมลถึงผู้ตรวจสอบแล้ว " + when(real.sent_at) + (real.fix_no ? " · แก้ไขครั้งที่ " + real.fix_no : ""))
            w.append(p)
        } else if (open) {
            const p = el("p", "rv-loading", open.status === "sending" ? "กำลังส่งอีเมลถึงผู้ตรวจสอบ · หน้านี้อัปเดตเอง"
                : open.attempts > 0 ? "ส่งอีเมลไม่สำเร็จ ระบบจะลองอีกครั้งใน 5 นาที" + (open.error ? " (" + open.error + ")" : "")
                : "รอส่งอีเมลถึงผู้ตรวจสอบ · หน้านี้อัปเดตเอง")
            p.setAttribute("aria-busy", "true")
            w.append(p)
        } else if (last && last.status === "failed") {
            const box = el("div", "rv-alert")
            box.append(el("strong", undefined, "ส่งอีเมลถึงผู้ตรวจสอบไม่สำเร็จ"))
            if (last.error) box.append(el("span", undefined, last.error))
            w.append(box)
            button = "ส่งอีเมลอีกครั้ง"
        } else if (last && last.status === "sent" && last.test) {
            w.append(el("p", "rv-hint", "ส่งอีเมลทดสอบแล้ว " + when(last.sent_at) + " · ถึงที่อยู่ทดสอบเท่านั้น"))
            button = "ส่งอีเมล"
        } else {
            w.append(el("p", "rv-hint", "ยังไม่ได้ส่งอีเมลถึงผู้ตรวจสอบ"))
            button = "ส่งอีเมล"
        }
        if (button) {
            const row = el("div", "rv-actions")
            const b = el("button", "btn-ghost", button)
            b.type = "button"
            b.id = "rv-email-send"
            b.addEventListener("click", () => askEmail(s, r))
            row.append(b)
            w.append(row)
        }
        const n = noteEl("email")
        if (n) w.append(n)
        return w
    }
    function askEmail(s: State, r: Round): void {
        askConfirm("ส่งอีเมล " + shortMonth(s.month) + " รอบที่ " + r.round_no + " ถึงผู้ตรวจสอบ?",
            [el("p", undefined, "แนบไฟล์ SK03 และรวมค่าคะแนนของรอบนี้ · ส่งจาก sakhonmso")],
            "ส่งอีเมล", () => doEmail(s))
    }
    async function doEmail(s: State): Promise<void> {
        await confirmRun(s, async () => {
            await post(monthApi(s) + "/email")
            return "สั่งส่งอีเมลแล้ว ระบบจะส่งภายในประมาณ 1 นาที"
        })
        await reload()
    }

    // Returned: what the auditor asked to fix, each with the score (edit it
    // here) and the auditee's answer.
    function returnedCard(s: State, r: Round): HTMLElement {
        ensure(s, r)
        if (s.build) ensureRows(s)
        const c = el("section", "rv-card glass")
        const fixes = (people || []).filter((p) => p.decision === "fix")
        const h = el("h2", "rv-card-h", "ผู้ตรวจสอบส่งกลับ · ต้องแก้ " + int(r.counts.fix) + " คน")
        h.id = "rv-h-ans"
        c.setAttribute("aria-labelledby", h.id)
        const top = el("div", "rv-actions rv-spread")
        top.append(h, el("span", "rv-hint", "รอบที่ " + r.round_no + " · " + when(r.returned_at)))
        c.append(top)
        if (peopleErr) c.append(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople))
        else if (!people) c.append(el("p", "rv-loading", "กำลังโหลด…"))
        else if (!fixes.length) c.append(el("p", "rv-hint", "ไม่มีรายชื่อที่ต้องแก้ ดูปัญหาอื่น ๆ"))
        const canEdit = auditeeTurn(s)
        for (const p of fixes) {
            const item = el("article", "rv-fix")
            const hid = "rv-ans-" + p.index
            const nm = el("h3", undefined, p.name)
            nm.id = hid
            item.setAttribute("aria-labelledby", hid)
            const who = el("div")
            who.append(nm, el("span", "rv-old", p.intern ? "INTERN" : p.department))
            const remark = el("p", "rv-remark")
            remark.append(el("span", "sr-only", "หมายเหตุผู้ตรวจสอบ: "), p.remark)
            const row = (rows || []).find((x) => x.index === p.index) || null
            const sc = el("div", "rv-fix-score num")
            const fixEditing = !!row && canEdit && editing === "fix:" + row.index
            if (row && fixEditing) {
                sc.append(...scoreEditor(s, row, "fix"))
            } else if (row) {
                const cell = el("span")
                scoreCell(cell, row)
                sc.append(cell)
                if (row.edit) sc.append(chip(resent(row) ? "warn" : "edit", resent(row) ? "แพทย์ส่งไฟล์ใหม่หลังแก้" : "แก้แล้ว"))
                if (canEdit) sc.append(editButton(row, "fix"))
            } else {
                sc.append(el("span", undefined, num2(p.score)))
            }
            const form = el("form", "rv-answer")
            const lab = el("label", "rv-label", "คำตอบ")
            const ta = keep(el("input"), "answer:" + p.index, p.reply)
            ta.id = "rv-answer-" + p.index
            ta.type = "text"
            ta.maxLength = 1000
            ta.placeholder = "พิมพ์คำตอบ"
            lab.htmlFor = ta.id
            const save = el("button", "btn-ghost", "บันทึก")
            save.type = "submit"
            save.id = "rv-answer-save-" + p.index
            save.append(el("span", "sr-only", " คำตอบ " + p.name))
            const spot = "answer-" + p.index
            if (flying(s, spot)) markBusy(save)
            form.append(lab, ta, save)
            form.addEventListener("submit", (ev) => { ev.preventDefault(); void saveAnswer(s, p, ta.value, save) })
            item.append(who, remark, sc)
            if (row && fixEditing) item.append(editActions(s, row, "fix"))
            item.append(form)
            const n = noteEl(spot)
            if (n) item.append(n)
            c.append(item)
        }
        const n = moreOpen ? null : noteEl("score")
        if (n) c.append(n)
        return c
    }

    // ── People in a round (both sides) ───────────────────────────────────
    interface Person {
        index: string
        name: string
        department: string
        intern: boolean
        sk03Row: number | null
        score: number | null
        stated: number | null
        statedCell: string | null
        statedHow: string
        sheet: string | null
        pay: number | null
        deptRow?: number | null
        deptPay: number | null
        admin: number | null
        scoreCheck: "match" | "mismatch" | "missing"
        moneyCheck: "match" | "mismatch" | "missing"
        decision: "approve" | "fix" | null
        remark: string
        carried: boolean
        why: string
        decidedAt: string | null
        reply: string
        prev: { decision: string | null; remark: string; reply: string } | null
        // The auditee's newest score edit sent with this round.
        edit: { old: number | null; new: number; note: string; at: string; by: string } | null
    }
    interface Grid { sheet: string; rows: number; cols: number; cells: [number, number, string | number][]; merges: string[] }
    interface Detail { grid: Grid | null; deptHeader: string[][] | null; deptRow: (string | number | null)[] | null }
    interface Issue {
        id: number
        round_no: number
        index: string | null
        body: string
        status: "open" | "closed"
        created_at: string
        created_by: string
        replies: { id: number; role: "auditor" | "auditee"; body: string; round_no: number | null; created_at: string; created_by: string }[]
    }

    // The key says what is loaded or on its way; the sequence number lets
    // only the newest request land (a month switch bumps them all). A failed
    // load clears its key and keeps the reason, shown with a retry button,
    // instead of loading again on every render.
    let people: Person[] | null = null
    let peopleKey = ""
    let peopleErr = ""
    let peopleSeq = 0
    let issues: Issue[] | null = null
    let issuesKey = ""
    let issuesErr = ""
    let issuesSeq = 0
    let selected = ""
    let filter = "todo"
    let search = ""
    const details = new Map<string, Detail>()
    const detailErrs = new Map<string, string>()
    const detailLoading = new Set<string>()
    let detailSeq = 0
    // People whose ต้องแก้ไข box the auditor opened, kept outside the page so
    // a re-render (the sheet arriving, a reload) leaves it open.
    const remarkOpen = new Set<string>()
    let swapAt = 0 // when the panel last drew another person
    let shownPerson = "" // the person the panel last drew
    let lastDecided = "" // the person the "decided" note in the list names

    const roundKey = (s: State, r: Round): string => s.month + ":" + r.round_no + ":" + r.status + ":" + (r.counts.approve + r.counts.fix)
    async function loadPeople(s: State, r: Round): Promise<void> {
        const key = s.month + ":" + r.round_no
        const seq = ++peopleSeq
        peopleKey = key
        peopleErr = ""
        try {
            const res = await api<{ people: Person[] }>(monthApi(s) + "/people?round=" + r.round_no)
            if (seq !== peopleSeq || s.month !== month) return
            people = res.people || []
            if (!selected || !people.some((p) => p.index === selected)) {
                const first = people.find((p) => p.decision === null) || people[0]
                selected = first ? first.index : ""
            }
        } catch (e) {
            if (seq !== peopleSeq || s.month !== month || signedOut(e)) return
            peopleKey = ""
            peopleErr = errText(e, "โหลดรายชื่อไม่สำเร็จ")
            shout("โหลดรายชื่อไม่สำเร็จ: " + peopleErr)
        }
        render()
    }
    async function loadIssues(s: State): Promise<void> {
        const seq = ++issuesSeq
        issuesKey = s.month
        issuesErr = ""
        try {
            const res = await api<{ issues: Issue[] }>(monthApi(s) + "/issues")
            if (seq !== issuesSeq || s.month !== month) return
            issues = res.issues || []
        } catch (e) {
            if (seq !== issuesSeq || s.month !== month || signedOut(e)) return
            issuesKey = ""
            issuesErr = errText(e, "โหลดปัญหาอื่น ๆ ไม่สำเร็จ")
            shout("โหลดปัญหาอื่น ๆ ไม่สำเร็จ: " + issuesErr)
        }
        render()
    }
    const needPeople = (s: State, r: Round): boolean => peopleKey !== s.month + ":" + r.round_no
    const ensureIssues = (s: State): void => { if (issuesKey !== s.month && !issuesErr) void loadIssues(s) }
    // ปัญหาอื่น ๆ is no longer a box of its own (Pong, 2026-11-12). It shows
    // only while one is open, which now happens only when an approved month
    // is reopened (the reason is added as one), so it can be read, answered
    // and closed; or when loading them failed, for its retry.
    const issuesShown = (): boolean => !!issuesErr || !!(issues && issues.some((i) => i.status === "open"))
    const ensure = (s: State, r: Round): void => {
        if (needPeople(s, r) && !peopleErr) void loadPeople(s, r)
        ensureIssues(s)
    }
    // Retry: forget the failure and draw again, which loads again.
    const retryPeople = (): void => { peopleErr = ""; render() }
    const retryIssues = (): void => { issuesErr = ""; render() }
    // A new state (another round, a decision made elsewhere) reloads both.
    let lastRoundKey = ""
    function refreshLists(s: State): void {
        const r = liveRound(s)
        if (!r) return
        const k = roundKey(s, r)
        if (k === lastRoundKey) return
        // Another round: its people are not the old round's.
        if (lastRoundKey.split(":").slice(0, 2).join(":") !== s.month + ":" + r.round_no) people = null
        lastRoundKey = k
        peopleKey = ""; issuesKey = ""; peopleErr = ""; issuesErr = ""
    }

    const CHECK_TEXT: Record<string, string> = { match: "ตรงกัน", mismatch: "ไม่ตรงกัน", missing: "ไม่พบ" }
    const WHY_TEXT: Record<string, string> = {
        fix: "รอบก่อนให้แก้ไข", new: "ไม่มีในรอบก่อน", score: "คะแนนของตัวเองเปลี่ยน",
        department: "กลุ่มงานเปลี่ยน", name: "ชื่อเปลี่ยน", check: "ผลเทียบไม่ตรงกัน",
    }
    const HOW_TEXT: Record<string, string> = {
        "grand-total": "แถวรวมทั้งหมด", "free-text": "ข้อความสรุปยอดรวม", "sub-total": "แถวรวม", "largest-over-sub-total": "ตัวเลขมากที่สุดในชีต (มากกว่าแถวรวม)", "largest-on-total-row": "ตัวเลขมากที่สุดในชีต อยู่ในแถวรวม",
        "largest-in-sheet": "ตัวเลขมากที่สุดในชีต", "largest-year-like": "ตัวเลขมากที่สุดในชีต รวมตัวเลขที่ดูคล้ายปี", "weight-x-days": "คำนวณจากแต้ม × จำนวนวัน",
        "sum-of-sub-totals": "ผลบวกแถวรวมย่อย เพราะแถวรวมทั้งหมดไม่มีค่าที่บันทึกไว้", "sum-of-data-rows": "ผลบวกคอลัมน์แต้ม เพราะแถวรวมไม่มีค่าที่บันทึกไว้",
        "rebuilt-from-days": "คำนวณจากจำนวนรายวัน × แต้ม เพราะแถวรวมไม่มีค่าที่บันทึกไว้",
        uncached: "แถวรวมเป็นสูตรที่ Excel ไม่ได้บันทึกค่าไว้", none: "ไม่พบแถวรวม", empty: "ชีตว่าง", "no-sheet": "ไม่พบชีตของแพทย์",
    }
    const bothMatch = (p: Person): boolean => p.scoreCheck === "match" && p.moneyCheck === "match"
    const decisionText = (p: Person): string => p.decision === "approve" ? (p.carried ? "อนุมัติ (คงผลรอบก่อน)" : "อนุมัติ")
        : p.decision === "fix" ? "ต้องแก้ไข" : "รอตรวจ"
    const num = (n: number | null): string => n === null ? "—" : Number(n).toLocaleString("th-TH", { maximumFractionDigits: 2 })

    function chip(kind: string, text: string): HTMLElement {
        return el("span", "rv-chip rv-chip-" + kind, text)
    }

    // ผู้ตรวจสอบ ───────────────────────────────────────────────────────────
    function auditor(s: State): Node[] {
        const r = liveRound(s)
        if (!r) return [turn("wait", "รอผู้จัดทำ", "ผู้จัดทำยังไม่ได้ส่งข้อมูลเดือน " + monthName(s.month, true), "เมื่อส่งแล้วจะขึ้นที่นี่")]
        if (r.status === "returned") {
            const out: Node[] = [turn("wait", "รอผู้จัดทำ", "ส่งกลับรอบที่ " + r.round_no + " แล้ว เมื่อ " + when(r.returned_at),
                "ต้องแก้ " + int(r.counts.fix) + " คน · รอผู้จัดทำแก้ในแอปแล้วส่งรอบที่ " + (r.round_no + 1))]
            if (!r.auditee_opened_at) {
                const row = el("div", "rv-actions")
                const b = el("button", "btn-ghost", "ดึงผลตรวจกลับมาแก้")
                b.type = "button"
                b.id = "rv-unreturn"
                if (flying(s, "unreturn")) markBusy(b)
                b.addEventListener("click", () => { void roundStep(s, "unreturn", "ดึงกลับแล้ว ตรวจต่อได้", b) })
                row.append(b, el("span", "rv-hint", "ใช้ได้จนกว่าผู้จัดทำจะเปิดดู"))
                const kids: Node[] = [row]
                const n = noteEl("unreturn")
                if (n) kids.push(n)
                out.push(card("ส่งผิด?", kids, "rv-h-unret"))
            }
            return out
        }
        if (r.status === "approved") return approvedView(s, r, "auditor")
        ensure(s, r)
        // The round, the counts and ส่งผลตรวจ sit in the left column, so the
        // names and the checks start at the top (Pong, 2026-11-12).
        sideOut.push(finishBar(s, r))
        const out: Node[] = []
        if (peopleErr) out.push(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople))
        if (!people) { if (!peopleErr) out.push(el("p", "rv-loading", "กำลังโหลดรายชื่อ…")); return out }
        const wrap = el("div", "rv-review")
        wrap.append(peopleList(), personPanel(s, r))
        out.push(wrap)
        if (issuesShown()) out.push(issuesCard(s, "auditor"))
        return out
    }

    function finishBar(s: State, r: Round): HTMLElement {
        const c = r.counts
        // Not known until the issues load: no "0 open" and no approve-all before that.
        const openIssues = issues ? issues.filter((i) => i.status === "open").length : null
        const bar = el("div", "rv-finish glass")
        const info = el("div", "rv-round-line")
        // The month chip above already says พร้อมตรวจ; who sent it and when
        // are left out (Pong, 2026-11-12).
        info.append(el("span", undefined, "รอบที่ " + r.round_no + " · " + monthName(s.month, true)),
            el("span", undefined, "งบ " + budgetText(r.budget) + (r.doctors ? " · N " + int(r.doctors) : "")),
            el("span", undefined, "per P4P " + baht(r.per_p4p)))
        if (r.edits) info.append(el("span", undefined, "ผู้จัดทำแก้คะแนน " + int(r.edits) + " คน"))
        bar.append(info)
        // The counts of each status are the tiles above the names now (Pong,
        // 2026-11-12). ปัญหาอื่น ๆ is gone; only a reopened month still has
        // one open, and then it is counted here.
        if (openIssues) {
            const counts = el("ul", "rv-countlist rv-counts")
            const li = el("li")
            li.append(el("span", undefined, "ปัญหาอื่นที่เปิดอยู่"), el("b", undefined, int(openIssues)))
            counts.append(li)
            bar.append(counts)
        }
        if (c.waiting > 0) bar.append(approveAllBox(s, r))
        const btn = el("button", "btn-primary")
        btn.type = "button"
        btn.id = "rv-finish"
        const why = el("span", "rv-hint")
        why.id = "rv-finish-why"
        const others = openIssues ? " · ปัญหาอื่น " + int(openIssues) + " เรื่อง" : ""
        if (c.waiting > 0) {
            // The reason line under the button is gone (Pong, 2026-11-12):
            // รอตรวจ above says how many are left; hover and click still say it.
            const left = "ส่งได้เมื่อตรวจครบทุกคน (เหลือ " + int(c.waiting) + " คน)"
            btn.textContent = "ส่งผลตรวจ…"
            btn.setAttribute("aria-disabled", "true")
            btn.title = left
            btn.addEventListener("click", () => say(left))
            bar.append(btn)
            return bar
        }
        if (openIssues === null) {
            btn.textContent = "ส่งผลตรวจ…"
            btn.setAttribute("aria-disabled", "true")
            btn.setAttribute("aria-describedby", why.id)
            why.textContent = issuesErr ? "ส่งได้เมื่อโหลดข้อมูลได้ กดลองอีกครั้งด้านขวา" : "กำลังโหลด…"
            btn.addEventListener("click", () => say(why.textContent || ""))
        } else if (c.fix > 0 || openIssues > 0) {
            btn.textContent = "ส่งกลับให้ผู้จัดทำแก้…"
            why.textContent = "ต้องแก้ไข " + int(c.fix) + " คน" + others
            btn.addEventListener("click", () => {
                askConfirm("ส่งกลับให้ผู้จัดทำแก้", [el("p", undefined, "ส่งรอบที่ " + r.round_no + " เดือน " + monthName(s.month) + " กลับ: ต้องแก้ไข " + int(c.fix) + " คน" + others),
                    el("p", "rv-hint", "ดึงกลับได้จนกว่าผู้จัดทำจะเปิดดู")], "ส่งกลับ", () => roundStep(s, "return", "ส่งกลับให้ผู้จัดทำแล้ว"))
            })
        } else {
            btn.textContent = "อนุมัติทั้งหมด…"
            why.textContent = "อนุมัติครบ " + int(c.approve) + " คน"
            btn.addEventListener("click", () => {
                askConfirm("อนุมัติทั้งหมด", [el("p", undefined, "อนุมัติ " + int(c.approve) + " คน ของเดือน " + monthName(s.month) + " รอบที่ " + r.round_no),
                    el("p", "rv-hint", "หลังอนุมัติ ระบบจะทำเอกสารเบิกจ่าย (PDF) ที่มีเวลาอนุมัติทุกหน้า")], "อนุมัติ", () => roundStep(s, "approve", "อนุมัติแล้ว"))
            })
        }
        bar.append(btn, why)
        return bar
    }

    // อนุมัติทุกคนที่รอตรวจ (Pong, 2026-11-12): one press approves everyone
    // still to check, usable only when none of them has a ไม่ตรงกัน or ไม่พบ
    // result (those are checked one by one first). Anyone already decided
    // keeps their result. scripts/review-approve-all-2026-11.sql checks the
    // same again.
    function approveAllBox(s: State, r: Round): HTMLElement {
        const box = el("div", "rv-approve-all")
        const waiting = people ? people.filter((p) => p.decision === null) : null
        const n = waiting ? waiting.length : r.counts.waiting
        const b = el("button", "btn-primary", "อนุมัติ " + int(n) + " คนที่รอตรวจ…")
        b.type = "button"
        b.id = "rv-approve-all"
        const why = el("p", "rv-hint rv-approve-all-why")
        why.id = "rv-approve-all-why"
        const blocked = waiting ? waiting.filter((p) => !bothMatch(p)) : []
        if (!waiting || blocked.length) {
            b.setAttribute("aria-disabled", "true")
            b.setAttribute("aria-describedby", why.id)
            if (!waiting) why.textContent = "กำลังโหลดรายชื่อ…"
            else {
                // Which ones, each a link to that group in the names.
                why.append("ใช้ได้เมื่อตรวจคนที่ ")
                const mm = blocked.filter(isMismatch).length
                const parts: [string, string, number][] = [["mismatch", "ไม่ตรงกัน", mm], ["missing", "ไม่พบ", blocked.length - mm]]
                let first = true
                for (const [key, label, k] of parts) {
                    if (!k) continue
                    if (!first) why.append(" และ ")
                    first = false
                    const a = el("button", "rv-link rv-inline-link", label + " " + int(k) + " คน")
                    a.type = "button"
                    a.addEventListener("click", () => {
                        filter = key
                        const p = (people || []).find((x) => x.decision === null && (key === "mismatch" ? isMismatch(x) : isMissing(x)))
                        if (p) openPerson(p.index)
                        else render()
                    })
                    why.append(a)
                }
                why.append(" แล้ว")
            }
            b.addEventListener("click", () => say(why.textContent || ""))
        } else {
            b.addEventListener("click", () => {
                askConfirm("อนุมัติทุกคนที่รอตรวจ", [
                    el("p", undefined, "อนุมัติ " + int(n) + " คนที่รอตรวจ เดือน " + monthName(s.month) + " รอบที่ " + r.round_no),
                    el("p", undefined, "ทุกคนผลเทียบคะแนนและเทียบเงิน ตรงกัน คนที่ตัดสินแล้ว (อนุมัติ " + int(r.counts.approve) + " · ต้องแก้ไข " + int(r.counts.fix) + ") ไม่เปลี่ยน"),
                    el("p", "rv-hint", "ยกเลิกผลรายคนได้ภายหลัง แล้วจึงกด อนุมัติทั้งหมด เพื่อทำเอกสารเบิกจ่าย"),
                ], "อนุมัติ " + int(n) + " คน", () => approveAll(s, r))
            })
        }
        box.append(b, why)
        return box
    }

    async function approveAll(s: State, r: Round): Promise<void> {
        const ok = await confirmRun(s, async () => {
            const res = await post<{ approved: number }>(monthApi(s) + "/approve-all", { round: r.round_no })
            return "อนุมัติแล้ว " + int(Number(res && res.approved) || 0) + " คน"
        })
        if (ok) {
            // Said above the names, like a single decision, so the window
            // keeps its height and the buttons stay in view.
            const n = notes.get("top")
            if (n && s.month === month) { notes.delete("top"); notes.set("decided", n); lastDecided = "" }
            if (s.month === month) { peopleKey = ""; issuesKey = "" }
            await loadMonths().catch(() => false)
        }
        await reload()
    }

    // ── Approved: the document, a retry, and reopening ───────────────────
    function approvedView(s: State, r: Round, side: "auditee" | "auditor"): Node[] {
        const status = r.pdf_status || "queued"
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", "อนุมัติ " + shortMonth(s.month) + " แล้ว")
        h.id = "rv-h-pdf"
        c.setAttribute("aria-labelledby", h.id)
        c.append(h, el("p", "rv-hint", when(r.approved_at) + " · รอบที่ " + r.round_no + (r.approved_by ? " · " + r.approved_by : "")))
        if (status === "ready") {
            const row = el("div", "rv-actions")
            const a = el("a", "rv-link", "เปิดเอกสารเบิกจ่าย PDF ")
            a.href = "/dashboard/api/review/" + s.month + "/pdf"
            a.target = "_blank"
            a.rel = "noopener"
            a.id = "rv-pdf"
            const arrow = el("span", undefined, "↗")
            arrow.setAttribute("aria-hidden", "true")
            a.append(arrow, el("span", "sr-only", " (เปิดในแท็บใหม่)"))
            const d = el("a", "rv-link", "ดาวน์โหลด")
            d.href = "/dashboard/api/review/" + s.month + "/pdf?download=1"
            d.id = "rv-pdf-dl"
            d.append(el("span", "sr-only", " เอกสารเบิกจ่าย " + shortMonth(s.month)))
            const size = [r.pdf_pages ? int(r.pdf_pages) + " หน้า" : "", r.pdf_bytes ? sizeText(r.pdf_bytes) : ""].filter(Boolean).join(" · ")
            row.append(a, d)
            if (size) row.append(el("span", "rv-hint", size))
            c.append(row)
        } else if (status === "failed") {
            const box = el("div", "rv-alert")
            box.append(el("strong", undefined, "สร้างเอกสารเบิกจ่ายไม่สำเร็จ"))
            if (r.pdf_error) box.append(el("span", undefined, r.pdf_error))
            const b = el("button", "btn-ghost", "ลองอีกครั้ง")
            b.type = "button"
            b.id = "rv-pdf-retry"
            if (flying(s, "pdf")) markBusy(b)
            b.addEventListener("click", () => { void retryPdf(s, b) })
            box.append(b)
            c.append(box)
        } else {
            const p = el("p", "rv-loading", "กำลังสร้างเอกสารเบิกจ่าย · หน้านี้อัปเดตเอง")
            p.setAttribute("aria-busy", "true")
            c.append(p)
        }
        c.append(kvGrid(r.budget, r.doctors, r.per_p4p, r.edits || 0))
        const n = noteEl("pdf")
        if (n) c.append(n)
        const mail = side === "auditee" ? emailBox(s, r) : null
        if (mail) c.append(mail)
        const out: Node[] = [c]
        if (side === "auditor") {
            const row = el("div", "rv-actions")
            const b = el("button", "btn-ghost", "ยกเลิกเอกสารและเปิดตรวจอีกครั้ง…")
            b.type = "button"
            b.id = "rv-reopen"
            b.addEventListener("click", () => askReopen(s, r))
            row.append(b)
            out.push(card("ต้องแก้หลังอนุมัติ?", [row,
                el("p", "rv-hint", "เอกสารที่สร้างแล้วจะใช้ไม่ได้ รอบที่ " + r.round_no + " กลับมาเป็นคิวผู้ตรวจสอบ ผลอนุมัติเดิมยังอยู่")], "rv-h-reopen"))
        }
        return out
    }

    async function retryPdf(s: State, b: HTMLButtonElement): Promise<void> {
        if (!begin(s, "pdf", b)) return
        try {
            await post(monthApi(s) + "/pdf/retry")
            tell(s, "pdf", "ok", "สั่งสร้างเอกสารอีกครั้งแล้ว")
        } catch (e) {
            tell(s, "pdf", "err", errText(e, "ทำรายการไม่สำเร็จ"))
        } finally {
            end(s, "pdf")
        }
        await reload()
    }

    function askReopen(s: State, r: Round): void {
        const ta = el("textarea")
        ta.id = "rv-reopen-reason"
        ta.rows = 3
        ta.maxLength = 1000
        ta.required = true
        ta.setAttribute("aria-required", "true")
        const lab = el("label", undefined, "เหตุผล (ต้องกรอก)")
        lab.htmlFor = ta.id
        const err = el("p", "rv-err")
        err.id = "rv-reopen-err"
        ta.setAttribute("aria-describedby", err.id)
        const field = el("div", "rv-reason")
        field.append(lab, ta, err)
        askConfirm("ยกเลิกเอกสารและเปิดตรวจอีกครั้ง · " + monthName(s.month, true), [
            el("p", undefined, "เอกสารเบิกจ่าย" + (r.pdf_built_at ? "ที่สร้างเมื่อ " + when(r.pdf_built_at) : "") +
                " จะใช้ไม่ได้ รวมถึงฉบับที่ดาวน์โหลดหรือพิมพ์ไปแล้ว ผู้จัดทำจะเห็นเหตุผลนี้ และบันทึกในประวัติการใช้งาน"),
            el("p", undefined, "สิ่งที่จะเกิดขึ้น: ผลอนุมัติ " + int(r.counts.approve) + " คนยังอยู่ · เหตุผลจะเป็นปัญหาอื่น ๆ ที่เปิดอยู่ · " +
                "เปลี่ยนคนที่ต้องแก้เป็น ต้องแก้ไข แล้วส่งกลับ · ผู้จัดทำแก้ในแอปแล้วส่งรอบที่ " + (r.round_no + 1) +
                " · ถ้าไม่มีอะไรต้องแก้ ปิดเรื่องแล้วอนุมัติใหม่ได้"),
            field,
        ], "ยกเลิกเอกสารและเปิดตรวจอีกครั้ง", async () => {
            const reason = ta.value.trim()
            if (!reason) {
                ta.setAttribute("aria-invalid", "true")
                err.textContent = "เขียนเหตุผลก่อน จึงจะกดได้"
                ta.focus()
                return
            }
            ta.removeAttribute("aria-invalid")
            err.textContent = ""
            const ok = await confirmRun(s, async () => {
                await post(monthApi(s) + "/reopen", { reason })
                return "ยกเลิกเอกสารแล้ว รอบที่ " + r.round_no + " กลับมาให้ตรวจอีกครั้ง"
            })
            if (!ok) return
            if (s.month === month) { peopleKey = ""; issuesKey = "" }
            await loadMonths().catch(() => false)
            await reload()
        })
        setTimeout(() => ta.focus(), 0)
    }

    // approve / return come from the confirm dialog (which stays open with
    // the reason when refused); unreturn is a plain button (btn).
    async function roundStep(s: State, step: "return" | "unreturn" | "approve", done: string, btn?: HTMLButtonElement): Promise<void> {
        const call = async (): Promise<string> => { await post(monthApi(s) + "/" + step); return done }
        let ok = false
        if (btn) {
            if (!begin(s, step, btn)) return
            try {
                tell(s, "top", "ok", await call())
                ok = true
            } catch (e) {
                tell(s, step, "err", errText(e, "ทำรายการไม่สำเร็จ"))
            } finally {
                end(s, step)
            }
        } else {
            ok = await confirmRun(s, call)
        }
        if (ok) {
            if (s.month === month) { peopleKey = ""; issuesKey = "" }
            await loadMonths().catch(() => false)
        }
        await reload()
    }

    // The status types (Pong, 2026-11-12: "display status types of user").
    // The first three are the auditor's decision, the last two the checks'
    // result; each tile filters the names. ไม่ตรงกัน wins over ไม่พบ when a
    // person has one of each.
    const isMismatch = (p: Person): boolean => p.scoreCheck === "mismatch" || p.moneyCheck === "mismatch"
    const isMissing = (p: Person): boolean => !bothMatch(p) && !isMismatch(p)
    const STATUSES: { key: string; label: string; tone: string; test: (p: Person) => boolean }[] = [
        { key: "todo", label: "รอตรวจ", tone: "wait", test: (p) => p.decision === null },
        { key: "approve", label: "อนุมัติ", tone: "ok", test: (p) => p.decision === "approve" },
        { key: "fix", label: "ต้องแก้ไข", tone: "fix", test: (p) => p.decision === "fix" },
        { key: "mismatch", label: "ไม่ตรงกัน", tone: "bad", test: isMismatch },
        { key: "missing", label: "ไม่พบ", tone: "miss", test: isMissing },
        { key: "all", label: "ทุกคน", tone: "all", test: () => true },
    ]

    function visiblePeople(): Person[] {
        const q = search.trim().toLowerCase()
        const st = STATUSES.find((x) => x.key === filter) || STATUSES[0]
        return (people || []).filter((p) => {
            if (q && !(p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q))) return false
            return st.test(p)
        })
    }

    // The decision as a small round mark at the start of a name's row.
    function decisionMark(p: Person): HTMLElement {
        const kind = p.decision === "approve" ? "ok" : p.decision === "fix" ? "fix" : "wait"
        const m = el("span", "rv-dmark rv-dmark-" + kind, p.decision === "approve" ? "✓" : p.decision === "fix" ? "!" : "")
        m.setAttribute("aria-hidden", "true")
        return m
    }

    function peopleList(): HTMLElement {
        const side = el("div", "rv-people glass")
        const all = people || []
        // Status tiles: the count of each type, and the filter.
        const tiles = el("div", "rv-status")
        tiles.setAttribute("role", "group")
        tiles.setAttribute("aria-label", "สถานะ: เลือกเพื่อแสดงเฉพาะกลุ่มนั้น")
        for (const st of STATUSES) {
            const n = all.filter(st.test).length
            const b = el("button", "rv-st rv-st-" + st.tone + (n === 0 && st.key !== "all" ? " rv-st-zero" : ""))
            b.type = "button"
            b.id = "rv-st-" + st.key
            b.dataset.filter = st.key
            b.setAttribute("aria-pressed", String(filter === st.key))
            const lab = el("span", "rv-st-label")
            if (st.tone !== "all") { const dot = el("span", "rv-st-dot"); dot.setAttribute("aria-hidden", "true"); lab.append(dot) }
            lab.append(st.label)
            b.append(lab, el("b", "rv-st-n", int(n)))
            b.addEventListener("click", () => {
                filter = st.key
                // The panel follows: the first of the group when the person
                // on screen is not in it.
                const list = visiblePeople()
                if (list.length && !list.some((x) => x.index === selected)) selected = list[0].index
                render()
                say(st.label + " " + int(n) + " คน")
            })
            tiles.append(b)
        }
        const sl = el("label", "rv-search rv-people-search")
        sl.append(el("span", "sr-only", "ค้นหาชื่อหรือกลุ่มงาน"))
        const si = el("input")
        si.type = "search"
        si.id = "rv-search"
        si.placeholder = "ค้นหาชื่อหรือกลุ่มงาน"
        si.value = search
        si.autocomplete = "off"
        si.addEventListener("input", () => { search = si.value; render() })
        sl.append(si)
        const shown = visiblePeople()
        side.append(tiles, sl)
        // With a search, how many of the group it leaves.
        if (search.trim()) {
            const count = el("p", "rv-hint rv-people-count", "พบ " + int(shown.length) + " คน")
            count.setAttribute("aria-live", "polite")
            side.append(count)
        }
        const ul = el("ul", "rv-people-list")
        ul.setAttribute("aria-label", "รายชื่อในรอบนี้")
        for (const p of shown) {
            const li = el("li")
            const b = el("button", "rv-person-btn" + (p.index === selected ? " current" : ""))
            b.type = "button"
            b.id = "rv-p-" + p.index
            if (p.index === selected) b.setAttribute("aria-current", "true")
            const line = el("span", "rv-pline")
            line.append(el("span", "rv-pname", p.name))
            if (isMismatch(p)) line.append(chip("bad", "ไม่ตรงกัน"))
            else if (isMissing(p)) line.append(chip("miss", "ไม่พบ"))
            const text = el("span", "rv-ptext")
            text.append(line, el("span", "rv-psub", (p.intern ? "อินเทิร์น" : p.department) + (p.carried ? " · คงผลรอบก่อน" : "")))
            b.append(decisionMark(p), text, el("span", "sr-only", " · " + decisionText(p)))
            b.addEventListener("click", () => { openPerson(p.index) })
            li.append(b)
            ul.append(li)
        }
        if (!shown.length) ul.append(el("li", "rv-hint", filter === "todo" && !search.trim() ? "ตรวจครบทุกคนแล้ว" : "ไม่มีรายชื่อ"))
        const dn = noteEl("decided")
        const back = lastDecided ? (people || []).find((x) => x.index === lastDecided) : undefined
        if (dn && back) {
            const b = el("button", "rv-link", "เปิดดูอีกครั้ง")
            b.type = "button"
            b.id = "rv-decided-back"
            b.addEventListener("click", () => { openPerson(back.index) })
            dn.append(" ", b)
        }
        if (dn) side.append(dn)
        side.append(ul)
        return side
    }

    // One person on the auditor's side. Top to bottom: name, the two checks
    // with where each number comes from, the one-line round-2 notes, the
    // earlier remark and reply, then the decision row pinned to the bottom of
    // the window. No หลักฐาน section (the doctor's sheet and department row):
    // the checks say it in words instead (Pong, 2026-11-12).
    function personPanel(s: State, r: Round): HTMLElement {
        const panel = el("section", "rv-person glass")
        const p = (people || []).find((x) => x.index === selected)
        if (!p) { panel.append(el("p", "rv-hint", "เลือกรายชื่อทางซ้าย")); return panel }
        const h = el("h3", "rv-person-h", p.name)
        h.id = "rv-person-h"
        h.tabIndex = -1
        panel.setAttribute("aria-labelledby", h.id)
        // Name and group on one line, to save height.
        const top = el("div", "rv-person-top")
        top.append(h, el("p", "rv-hint", (p.intern ? "อินเทิร์น" : "staff · " + p.department) + " · " + decisionText(p)))
        panel.append(top)
        // A person drawn for the first time starts the click guard (tooSoon).
        if (p.index !== shownPerson) { shownPerson = p.index; swapAt = Date.now() }
        // The name of the doctor's score row (its first text in columns A-C)
        // comes with the person's detail, loaded once in the background.
        const key = s.month + ":" + r.round_no + ":" + p.index
        const d = details.get(key)
        if (!d) loadDetail(s, r, p.index)
        const rowName = d ? scoreRowName(d.grid, p.statedCell) : ""
        // ผล comes second, so the eye goes from the result straight down to
        // the buttons. Each number says where it comes from (Pong,
        // 2026-11-12: more description on เทียบคะแนน and เทียบเงิน).
        const t = el("table", "rv-compare")
        const cap = el("caption", "sr-only", "ผลเทียบอัตโนมัติ")
        const head = el("tr")
        for (const x of ["เรื่อง", "ผล", "SK03", "เทียบกับ"]) { const th = el("th", undefined, x); th.scope = "col"; head.append(th) }
        const cell = (value: string, from: string): HTMLElement => {
            const td = el("td")
            td.append(el("b", "rv-v", value), el("span", "rv-src", from))
            return td
        }
        // How far apart the two are, said from SK03's side.
        const gap = (a: number | null, b: number | null): string => {
            if (a === null || b === null) return ""
            const dd = Math.round((a - b) * 100) / 100
            return dd > 0 ? "SK03 มากกว่า " + num(dd) : dd < 0 ? "SK03 น้อยกว่า " + num(-dd) : ""
        }
        const row = (label: string, what: string, check: string, diff: string, a: HTMLElement, b: HTMLElement): HTMLElement => {
            const tr = el("tr")
            const th = el("th")
            th.scope = "row"
            th.append(el("b", undefined, label), el("span", "rv-src", what))
            const res = el("td")
            res.append(chip(check === "match" ? "ok" : check === "missing" ? "miss" : "bad", CHECK_TEXT[check]))
            if (check === "mismatch" && diff) res.append(el("span", "rv-src", diff))
            tr.append(th, res, a, b)
            return tr
        }
        const summary = "ชีตสรุป" + (p.intern ? "อินเทิร์น" : " staff") + (p.sk03Row ? " แถว " + p.sk03Row : "")
        const how = HOW_TEXT[p.statedHow] || p.statedHow
        const form = "ไฟล์รวมค่าคะแนน" + (p.sheet ? " ชีต \"" + p.sheet + "\"" : "")
        const deptSheet = p.department
        // "อ่านจากแถวรวมทั้งหมด"; a total the app worked out reads on its own.
        const from = /^(คำนวณ|ผลบวก)/.test(how) ? how : "อ่านจาก" + how
        const thead = el("thead"), tbody = el("tbody")
        thead.append(head)
        tbody.append(
            row("เทียบคะแนน", "กับยอดรวมในแบบฟอร์มแพทย์", p.scoreCheck, gap(p.score, p.stated),
                cell(p.score === null ? "ไม่มี" : num(p.score), summary + " คอลัมน์ K"),
                p.stated === null
                    ? cell("ไม่พบ", form + " · " + how)
                    : cell(num(p.stated), form + (p.statedCell ? " ช่อง " + p.statedCell : "") + (rowName ? " แถว “" + rowName + "”" : "") + " · " + from)),
            row("เทียบเงิน", "กับเงินตามสัดส่วนวิชาชีพ", p.moneyCheck, gap(p.pay, p.deptPay),
                cell(p.pay === null ? "ไม่มี" : num(p.pay), summary + " คอลัมน์ N"),
                p.deptPay === null
                    ? cell("ไม่พบ", "ไม่พบชื่อใน SK03 ชีต " + deptSheet)
                    : cell(num(p.deptPay), "SK03 ชีต " + deptSheet + (p.deptRow != null ? " แถว " + p.deptRow : "") + " คอลัมน์ F"
                        + (p.admin ? " · ไม่รวมงานบริหาร (E) " + num(p.admin) : ""))),
        )
        t.append(cap, thead, tbody)
        panel.append(t)
        // The buttons live in a bar pinned to the bottom of the window
        // (Pong, 2026-11-12: "Approve btn stay btm"), at the end of the
        // panel: any hint and the remark box above them, the buttons last.
        const [bar, ...rest] = decideBox(s, p)
        const foot = el("div", "rv-decide-foot")
        foot.append(...rest, bar)
        // 'check': a check is not ตรงกัน in the new build; say which kind.
        const whyText = p.why === "check" && p.scoreCheck !== "mismatch" && p.moneyCheck !== "mismatch" ? "ไม่พบข้อมูลให้เทียบ" : (WHY_TEXT[p.why || ""] || p.why)
        if (p.why) panel.append(el("p", "rv-why", "ตรวจอีกครั้งเพราะ: " + whyText))
        if (p.edit) panel.append(el("p", "rv-why", "ผู้จัดทำแก้คะแนน " + num(p.edit.old) + " → " + num(p.edit.new) + (p.edit.note ? " · " + p.edit.note : "")))
        if (p.prev && (p.prev.remark || p.prev.reply)) {
            const prev = el("div", "rv-prev")
            if (p.prev.remark) prev.append(el("p", undefined, "รอบก่อน ผู้ตรวจสอบ: " + p.prev.remark))
            prev.append(el("p", undefined, "คำตอบผู้จัดทำ: " + (p.prev.reply || "ไม่มีคำตอบ")))
            panel.append(prev)
        }
        panel.append(foot)
        panel.addEventListener("scroll", () => markStuck(), { passive: true })
        // The next person still to check: their detail is ready when the app moves on.
        const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index)
        if (next) loadDetail(s, r, next.index)
        return panel
    }

    // Show another person: the list and panel just under the counts bar, so
    // อนุมัติ is at the same place on the screen for everyone, and focus on
    // their name (one Tab on is อนุมัติ).
    function openPerson(index: string): void {
        selected = index
        render()
        toWorkingSpot()
        const h = document.getElementById("rv-person-h")
        if (h) h.focus({ preventScroll: true })
    }
    function toWorkingSpot(): void {
        const wrap = body.querySelector<HTMLElement>(".rv-review")
        if (!wrap) return
        const fin = body.querySelector<HTMLElement>(".rv-finish")
        const top = wrap.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop
        view.scrollTop = Math.max(0, top - (fin ? fin.offsetHeight : 0) - 10)
        markStuck()
    }
    // The counts bar's height (it wraps on narrow windows) sets where the
    // people list and the decision row stick, and how much of the top a
    // focused control must clear.
    function syncStick(): void {
        const fin = body.querySelector<HTMLElement>(".rv-finish")
        const h = fin ? fin.offsetHeight : 0
        view.style.setProperty("--rv-fin", h + "px")
        view.style.setProperty("--rv-view-h", view.clientHeight + "px")
        // Focus never lands under the counts bar at the top or the
        // buttons bar pinned at the bottom.
        view.style.scrollPaddingTop = h + 10 + "px"
        const foot = body.querySelector<HTMLElement>(".rv-decide-foot")
        view.style.scrollPaddingBottom = (foot && getComputedStyle(foot).position === "sticky" ? foot.offsetHeight + 10 : 0) + "px"
        markStuck(true)
    }
    // Once the checks have scrolled up out of sight, the bottom bar also
    // names the person.
    function markStuck(force = false): void {
        const bar = body.querySelector<HTMLElement>(".rv-decide-row")
        const cmp = body.querySelector<HTMLElement>(".rv-compare")
        if (!bar || !cmp) return
        // The person panel scrolls itself when it fills the window.
        const panel = cmp.closest<HTMLElement>(".rv-person")
        const own = !!panel && panel.scrollHeight > panel.clientHeight + 1
        const fin = body.querySelector<HTMLElement>(".rv-finish")
        const at = own && panel ? panel.getBoundingClientRect().top : view.getBoundingClientRect().top + (fin ? fin.offsetHeight : 0)
        const stuck = cmp.getBoundingClientRect().bottom < at
        if (!force && stuck === bar.classList.contains("stuck")) return
        bar.classList.toggle("stuck", stuck)
        // The name shown in the pinned row only when the row still fits on
        // one line with it.
        bar.classList.remove("tight")
        const btns = bar.querySelector<HTMLElement>(".rv-decide-btns")
        const nav = bar.querySelector<HTMLElement>(".rv-decide-nav")
        if (stuck && btns && nav && nav.offsetTop > btns.offsetTop + 4) bar.classList.add("tight")
    }
    view.addEventListener("scroll", () => markStuck(), { passive: true })
    window.addEventListener("resize", syncStick)
    // Keys for the auditor (Pong picked them, 2026-11-12): A อนุมัติ,
    // F ต้องแก้ไข, ← / → the person before / after. By key position
    // (ev.code), so they work with the Thai layout on too; never while
    // typing, in a dialog, or with a modifier.
    document.addEventListener("keydown", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.repeat || ev.defaultPrevented) return
        if (role !== "auditor" || view.classList.contains("hidden") || !body.querySelector(".rv-decide-row")) return
        if (document.querySelector("dialog[open]")) return
        const t = ev.target as HTMLElement | null
        if (t && (t.closest("input, textarea, select, [contenteditable]"))) return
        const id = ev.code === "KeyA" ? "rv-approve" : ev.code === "KeyF" ? "rv-fix"
            : ev.code === "ArrowLeft" ? "rv-prev-person" : ev.code === "ArrowRight" ? "rv-next-person" : ""
        if (!id) return
        const b = document.getElementById(id) as HTMLButtonElement | null
        if (!b || b.disabled) return
        ev.preventDefault()
        b.click()
    })

    // The click that decided one person must not land on the next one's
    // button: ignore pointer clicks for half a second after the panel shows
    // another person, and the second click of a double-click. Keys (detail 0)
    // always work.
    const tooSoon = (ev: MouseEvent): boolean => ev.detail > 1 || (ev.detail === 1 && Date.now() - swapAt < 500)

    // What the auditor would most likely write, ready to edit.
    function suggestRemark(p: Person): string {
        if (p.scoreCheck === "mismatch") return "คะแนนในไฟล์แพทย์ " + num(p.stated) + " แต่ SK03 " + num(p.score)
        if (p.moneyCheck === "mismatch") return "เงินในชีตกลุ่มงาน " + num(p.deptPay) + " แต่ SK03 " + num(p.pay)
        if (p.moneyCheck === "missing") return "ไม่พบเงินในชีตกลุ่มงาน" + (p.intern ? "" : " " + p.department)
        return ""
    }

    function decideBox(s: State, p: Person): Node[] {
        // Pay must be ตรงกัน. The score may be ตรงกัน, or ไม่พบ (the doctor's
        // file has no saved total): then the auditor looks at the sheet and
        // approves (Pong, 2026-11-10). ไม่ตรงกัน never approves.
        const ok = p.moneyCheck === "match" && p.scoreCheck !== "mismatch"
        const spot = "decide-" + p.index
        const draftKey = "remark:" + p.index
        const fe = fieldErrs.get(draftKey)
        // The remark box is open when it is the only way on, when a remark is
        // saved, or when the auditor opened it (kept across re-renders).
        const forced = !ok || p.decision === "fix"
        const open = forced || remarkOpen.has(p.index) || !!fe
        const out: Node[] = []
        const bar = el("div", "rv-decide-row")
        bar.setAttribute("role", "group")
        bar.setAttribute("aria-label", "ตัดสินผล " + p.name)
        const btns = el("div", "rv-decide-btns")
        const approve = el("button", "btn-primary" + (ok ? "" : " rv-off"), p.decision === "approve" ? "✓ อนุมัติแล้ว" : "อนุมัติ")
        approve.type = "button"
        approve.id = "rv-approve"
        approve.setAttribute("aria-keyshortcuts", "A")
        approve.title = "ปุ่มลัด A"
        const fix = el("button", (ok ? "btn-ghost" : "btn-primary") + (open && ok ? " rv-pressed" : ""), p.decision === "fix" ? "✓ ต้องแก้ไขแล้ว" : "ต้องแก้ไข")
        fix.type = "button"
        fix.id = "rv-fix"
        fix.setAttribute("aria-keyshortcuts", "F")
        fix.title = "ปุ่มลัด F"
        btns.append(approve, fix)
        if (p.decision) {
            const undo = el("button", "btn-ghost", "ยกเลิกผล")
            undo.type = "button"
            undo.id = "rv-undo"
            undo.addEventListener("click", (ev) => { if (!tooSoon(ev)) void decide(s, p, null, "", undo) })
            btns.append(undo)
        }
        const who = el("span", "rv-decide-who", p.name)
        who.setAttribute("aria-hidden", "true")
        const nav = el("div", "rv-decide-nav")
        const list = visiblePeople()
        const i = list.findIndex((x) => x.index === p.index)
        const go = (d: number, text: string): HTMLButtonElement => {
            const b = el("button", "btn-ghost", text)
            b.type = "button"
            b.id = d < 0 ? "rv-prev-person" : "rv-next-person"
            b.setAttribute("aria-keyshortcuts", d < 0 ? "ArrowLeft" : "ArrowRight")
            b.title = "ปุ่มลัด " + (d < 0 ? "←" : "→")
            const target = list[i + d]
            b.disabled = !target
            b.addEventListener("click", () => { if (target) openPerson(target.index) })
            return b
        }
        nav.append(go(-1, "← คนก่อนหน้า"), go(1, "คนถัดไป →"))
        const keys = el("span", "rv-keys", "ปุ่มลัด A · F · ← →")
        keys.setAttribute("aria-hidden", "true")
        bar.append(btns, who, keys, nav)
        // A failed save shows in the row, which is on screen even when pinned.
        const n = noteEl(spot)
        if (n) bar.append(n)
        out.push(bar)

        const why = el("div", "rv-decide-hint")
        why.id = "rv-approve-why"
        if (!ok) {
            approve.setAttribute("aria-disabled", "true")
            approve.setAttribute("aria-describedby", why.id)
            why.classList.add("bad")
            why.textContent = (p.moneyCheck === "missing" && p.scoreCheck !== "mismatch" ? "ไม่พบเงินในชีตกลุ่มงาน" : "เทียบไม่ตรงกัน")
                + " อนุมัติไม่ได้ เขียนหมายเหตุแล้วกด บันทึก"
            out.push(why)
        } else if (!bothMatch(p)) {
            const txt = el("span", undefined, "ไม่พบยอดรวมในไฟล์แพทย์ ดูชีตของแพทย์ในไฟล์รวมค่าคะแนนก่อน แล้วอนุมัติหรือเลือก ต้องแก้ไข")
            txt.id = "rv-approve-why-text"
            approve.setAttribute("aria-describedby", txt.id)
            why.append(txt)
            // The sheet is no longer drawn here (Pong, 2026-11-12): the
            // newest รวมค่าคะแนน file in Drive, view only.
            const fid = s.build && s.build.merged_file_id
            if (fid) {
                const a = el("a", "rv-link", "เปิดไฟล์รวมค่าคะแนน ")
                a.id = "rv-open-merged"
                a.href = "https://drive.google.com/file/d/" + encodeURIComponent(fid) + "/view"
                a.target = "_blank"
                a.rel = "noopener"
                const arrow = el("span", undefined, "↗")
                arrow.setAttribute("aria-hidden", "true")
                a.append(arrow, el("span", "sr-only", " (เปิดในแท็บใหม่)"))
                why.append(a)
            }
            out.push(why)
        }
        approve.addEventListener("click", (ev) => {
            if (tooSoon(ev)) return
            if (!ok) { say(why.textContent || ""); return }
            void decide(s, p, "approve", "", approve)
        })
        fix.addEventListener("click", (ev) => {
            if (tooSoon(ev)) return
            remarkOpen.add(p.index)
            if (!open) render()
            const ta = document.getElementById("rv-remark")
            if (ta) ta.focus()
        })

        let save: HTMLButtonElement | null = null
        if (open) {
            const box = el("div", "rv-remark-box")
            box.id = "rv-remark-box"
            const lab = el("label", undefined, p.decision === "fix" ? "หมายเหตุที่ส่งให้ผู้จัดทำ" : "หมายเหตุ ต้องแก้ไขอะไร")
            lab.htmlFor = "rv-remark"
            const ta = keep(el("textarea"), draftKey, p.decision === "fix" ? p.remark : suggestRemark(p))
            ta.id = "rv-remark"
            ta.rows = 1
            ta.maxLength = 1000
            const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "")
            err.id = "rv-remark-e"
            if (fe) ta.setAttribute("aria-invalid", "true")
            ta.setAttribute("aria-describedby", err.id)
            const sv = el("button", "btn-primary", p.decision === "fix" ? "บันทึกหมายเหตุใหม่" : "บันทึก")
            sv.type = "button"
            sv.id = "rv-fix-save"
            save = sv
            sv.addEventListener("click", (ev) => {
                if (tooSoon(ev)) return
                if (!ta.value.trim()) {
                    err.textContent = "พิมพ์หมายเหตุว่าต้องแก้อะไร"
                    fieldErrs.set(draftKey, err.textContent)
                    err.classList.remove("hidden")
                    ta.setAttribute("aria-invalid", "true")
                    ta.focus()
                    return
                }
                fieldErrs.delete(draftKey)
                void decide(s, p, "fix", ta.value, sv)
            })
            const acts = el("div", "rv-actions")
            acts.append(sv)
            // ยกเลิก drops the text; Esc only folds the box away (the text
            // comes back with ต้องแก้ไข).
            const close = (discard: boolean): void => {
                remarkOpen.delete(p.index)
                if (discard) drafts.delete(draftKey)
                fieldErrs.delete(draftKey)
                render()
                const f = document.getElementById("rv-fix")
                if (f) f.focus({ preventScroll: true })
            }
            if (!forced) {
                const cancel = el("button", "btn-ghost", "ยกเลิก")
                cancel.type = "button"
                cancel.id = "rv-fix-cancel"
                cancel.addEventListener("click", () => close(true))
                acts.append(cancel)
            }
            ta.addEventListener("keydown", (ev) => {
                if (ev.key === "Escape" && !forced) { ev.preventDefault(); close(false) }
                else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sv.click() }
            })
            // The text box and its buttons side by side, to save height.
            const line = el("div", "rv-remark-line")
            line.append(ta, acts)
            box.append(lab, line, err)
            out.push(box)
        }
        if (flying(s, spot)) for (const b of [approve, fix, save]) if (b) markBusy(b)
        return out
    }

    // Load one person's detail once (only the score row's name is used now).
    // A failure is kept only for the person on screen, so it is not asked for
    // again on every redraw; the checks show without the row's name.
    function loadDetail(s: State, r: Round, index: string): void {
        const key = s.month + ":" + r.round_no + ":" + index
        if (details.has(key) || detailErrs.has(key) || detailLoading.has(key)) return
        detailLoading.add(key)
        const seq = detailSeq
        void api<Detail>(monthApi(s) + "/person/" + r.round_no + "/" + index)
            .then((x) => { if (seq === detailSeq) details.set(key, x) }, (e) => {
                if (seq !== detailSeq || signedOut(e) || selected !== index) return
                detailErrs.set(key, errText(e, "โหลดไม่สำเร็จ"))
            })
            .then(() => {
                if (seq !== detailSeq) return
                detailLoading.delete(key)
                if (selected === index) render()
            })
    }

    function cellRC(name: string | null): [number, number] | null {
        const m = /^([A-Z]+)(\d+)$/.exec(name || "")
        if (!m) return null
        let c = 0
        for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
        return [Number(m[2]) - 1, c - 1]
    }
    // The doctor's score row by name: its first text in columns A-C.
    function scoreRowName(g: Grid | null, cellName: string | null): string {
        const hit = cellRC(cellName)
        if (!g || !hit) return ""
        let best: [number, string] | null = null
        for (const [rr, cc, v] of g.cells) {
            if (rr !== hit[0] || cc > 2 || typeof v !== "string" || !v.trim()) continue
            if (!best || cc < best[0]) best = [cc, v.trim()]
        }
        const t = best ? best[1].replace(/\s+/g, " ") : ""
        return t.length > 40 ? t.slice(0, 39) + "…" : t
    }

    async function decide(s: State, p: Person, decision: "approve" | "fix" | null, remark: string, btn: HTMLButtonElement): Promise<void> {
        const spot = "decide-" + p.index
        if (!begin(s, spot, btn)) return
        notes.delete("decided")
        busy = true
        let moved = false, failed = false
        try {
            await post(monthApi(s) + "/decisions/" + p.index, { decision, remark }, "PUT")
            p.decision = decision
            p.remark = decision === "fix" ? remark.trim() : ""
            p.carried = false
            forget(s, "remark:" + p.index)
            fieldErrs.delete("remark:" + p.index)
            if (decision !== "fix") remarkOpen.delete(p.index)
            // Said in the people list, not under the next person's buttons,
            // where it would read as their own result.
            tell(s, "decided", "ok", p.name + ": " + decisionText(p))
            lastDecided = p.index
            // Straight on to the next person still to check.
            if (decision && s.month === month) {
                const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index)
                if (next) { selected = next.index; moved = true }
            }
        } catch (e) {
            failed = true
            tell(s, spot, "err", p.name + ": " + errText(e, "บันทึกไม่สำเร็จ"))
        } finally {
            busy = false
            end(s, spot)
        }
        // Show the next person at once; the reload only refreshes counts.
        const focusHead = (): void => {
            const hh = document.getElementById("rv-person-h")
            if (hh) hh.focus({ preventScroll: true })
        }
        if (moved && s.month === month) { render(); toWorkingSpot(); focusHead() }
        const pressed = btn.id
        await reload()
        if (s.month !== month) return
        if (moved) { toWorkingSpot(); focusHead(); return }
        // After a failure stay on the button that was pressed.
        const back = failed && pressed ? document.getElementById(pressed) : null
        if (back) back.focus({ preventScroll: true })
        else focusHead()
    }

    // ปัญหาอื่น ๆ (both sides), the open ones only; nothing new is added here.
    function issuesCard(s: State, side: "auditor" | "auditee"): HTMLElement {
        const kids: Node[] = []
        const r = liveRound(s)
        const canAct = side === "auditor" ? !!r && r.status === "submitted" : !!r && r.status === "returned"
        ensureIssues(s)
        if (issuesErr) kids.push(failBox("โหลดปัญหาอื่น ๆ ไม่สำเร็จ: " + issuesErr, "rv-retry-issues", retryIssues))
        else if (!issues) kids.push(el("p", "rv-loading", "กำลังโหลด…"))
        const list = (issues || []).filter((i) => i.status === "open")
        for (const i of list) {
            const item = el("article", "rv-issue" + (i.status === "closed" ? " closed" : ""))
            const hid = "rv-issue-" + i.id
            const h = el("h4", undefined, "เรื่องที่ " + i.id + (i.status === "closed" ? " (ปิดแล้ว)" : ""))
            h.id = hid
            item.setAttribute("aria-labelledby", hid)
            item.append(h, el("p", undefined, i.body), el("p", "rv-hint", "แจ้งรอบที่ " + i.round_no + " · " + when(i.created_at)))
            const ul = el("ul", "rv-replies")
            for (const x of i.replies) {
                ul.append(el("li", undefined, (x.role === "auditor" ? "ผู้ตรวจสอบ" : "ผู้จัดทำ") + (x.round_no === null ? " (ร่าง ส่งไปกับรอบถัดไป)" : "") + ": " + x.body))
            }
            if (i.replies.length) item.append(ul)
            if (canAct) {
                const form = el("form", "rv-reply")
                const lab = el("label", "sr-only", "ตอบเรื่องที่ " + i.id)
                const ta = keep(el("textarea"), "reply:" + i.id, "")
                ta.id = "rv-reply-" + i.id
                ta.rows = 1
                ta.maxLength = 2000
                lab.htmlFor = ta.id
                const send = el("button", "btn-ghost", "ตอบ")
                send.type = "submit"
                send.id = "rv-reply-send-" + i.id
                const spot = "reply-" + i.id
                if (flying(s, spot)) markBusy(send)
                form.append(lab, ta, send)
                form.addEventListener("submit", (ev) => {
                    ev.preventDefault()
                    if (flying(s, spot)) return
                    if (!ta.value.trim()) { ta.focus(); return }
                    void issueCall(s, spot, "/issues/" + i.id + "/replies", { role: side, body: ta.value }, "ส่งคำตอบแล้ว", send, "reply:" + i.id)
                })
                item.append(form)
                if (side === "auditor") {
                    const t = el("button", "btn-ghost", i.status === "open" ? "ปิดเรื่องนี้" : "เปิดอีกครั้ง")
                    t.type = "button"
                    t.id = "rv-issue-toggle-" + i.id
                    const tspot = "status-" + i.id
                    if (flying(s, tspot)) markBusy(t)
                    t.addEventListener("click", () => { void issueCall(s, tspot, "/issues/" + i.id + "/status", { open: i.status !== "open" }, i.status === "open" ? "ปิดแล้ว" : "เปิดอีกครั้งแล้ว", t) })
                    item.append(t)
                }
            }
            for (const k of ["reply-" + i.id, "status-" + i.id]) { const n = noteEl(k); if (n) item.append(n) }
            kids.push(item)
        }
        return card("ปัญหาอื่น ๆ", kids, "rv-h-issues")
    }

    // One request per form at a time; the typed text (draft) is cleared
    // only once the server has it.
    async function issueCall(s: State, spot: string, path: string, json: unknown, done: string, btn: HTMLElement, draft?: string): Promise<void> {
        if (!begin(s, spot, btn)) return
        try {
            await post(monthApi(s) + path, json)
            if (draft) forget(s, draft)
            tell(s, spot, "ok", done)
        } catch (e) {
            tell(s, spot, "err", errText(e, "ทำรายการไม่สำเร็จ"))
        } finally {
            end(s, spot)
        }
        if (s.month === month) issuesKey = ""
        await reload()
    }

    // ผู้จัดทำ: the answer to one person sent back, sent with the next round.
    async function saveAnswer(s: State, p: Person, text: string, btn: HTMLButtonElement): Promise<void> {
        const spot = "answer-" + p.index
        if (!begin(s, spot, btn)) return
        try {
            await post(monthApi(s) + "/replies/" + p.index, { reply: text }, "PUT")
            p.reply = text.trim()
            const cur = s.month === month && people ? people.find((x) => x.index === p.index) : undefined
            if (cur) cur.reply = p.reply
            forget(s, "answer:" + p.index)
            tell(s, spot, "ok", "บันทึกคำตอบแล้ว ส่งไปกับรอบถัดไป")
        } catch (e) {
            tell(s, spot, "err", errText(e, "บันทึกไม่สำเร็จ"))
        } finally {
            end(s, spot)
        }
        render()
    }
})()
