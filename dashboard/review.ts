/** GENERATED FILE'S SOURCE — compiled to dashboard/review.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin.
 *
 * The ตรวจสอบ (review) tab, owner only. app.ts owns the tabs and fires
 * "dashboard:review" when this tab is opened; everything else is here.
 * The server side is lib/review-server.ts.
 *
 * ผู้จัดทำ (auditee): 1. type the month's budget and per P4P once (the
 * build puts them in SK03 Y9 / W9) · 2. download the SK03 and merged file
 * the system built · 3. upload both back unchanged and send them to the
 * auditor. Any fix is made in the app (roster, or the doctor re-sends), then
 * the files are rebuilt; a file edited by hand is refused.
 * ผู้ตรวจสอบ (auditor): the round's summary (checking each person comes
 * with the next update).
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
    interface Upload {
        id: string
        kind: "sk03" | "merged"
        file_name: string
        bytes: number
        created_at: string
        result: "latest" | "older" | "other_kind" | "unknown" | null
        build_id: string | null
    }
    interface Round {
        id: number
        round_no: number
        status: "submitted" | "returned" | "superseded" | "approved"
        build_id: string
        budget: number
        per_p4p: number
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
    interface State {
        installed: boolean
        month: string
        roster: { total: number; sent: number; exists: boolean }
        inputs: { budget: number; per_p4p: number; updated_at: string; updated_by: string } | null
        build: Build | null
        buildChecks: { scoreMismatch: number; scoreMissing: number; moneyMismatch: number; moneyMissing: number } | null
        request: Request | null
        uploads: Partial<Record<"sk03" | "merged", Upload>>
        rounds: Round[]
        live: number | null
    }
    interface MonthRow {
        month: string
        total: number
        sent: number
        builtAt: string | null
        round: { round_no: number; status: string } | null
        hasInputs: boolean
    }

    const view = document.getElementById("review-view") as HTMLElement
    const body = document.getElementById("review-body") as HTMLElement
    const monthSel = document.getElementById("review-month") as HTMLSelectElement
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
    const when = (iso: string | null | undefined): string => {
        if (!iso) return ""
        const d = new Date(iso)
        if (isNaN(d.getTime())) return ""
        return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " น."
    }
    const baht = (n: number | null | undefined): string =>
        n === null || n === undefined ? "—" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const int = (n: number): string => Number(n || 0).toLocaleString("th-TH")
    const sizeText = (b: number): string => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"
    const say = (msg: string): void => { live.textContent = ""; setTimeout(() => { live.textContent = msg }, 50) }

    class ApiError extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s } }
    async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
        const r = await fetch(path, { credentials: "same-origin", ...init })
        if (r.status === 401) { location.href = "/dashboard/login?error=idle"; throw new ApiError("signed out", 401) }
        let data: any = null
        try { data = await r.json() } catch (e) { data = null }
        if (!r.ok) throw new ApiError((data && data.error) || "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง", r.status)
        return data as T
    }
    const post = <T>(path: string, json?: unknown, method = "POST"): Promise<T> =>
        api<T>(path, json === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) })

    // ── State ────────────────────────────────────────────────────────────
    const ROLE_KEY = "review.role"
    let role: "auditee" | "auditor" = "auditee"
    try { if (localStorage.getItem(ROLE_KEY) === "auditor") role = "auditor" } catch (e) { /* private window */ }
    let month = ""
    let st: State | null = null
    let poll: number | undefined
    let busy = false

    const openRequest = (s: State): Request | null =>
        s.request && ["queued", "dispatched", "running"].includes(s.request.status) ? s.request : null
    const liveRound = (s: State): Round | null => s.rounds.find((r) => r.round_no === s.live) || null
    const auditeeTurn = (s: State): boolean => { const r = liveRound(s); return !r || r.status === "returned" }
    const uploadOk = (s: State, kind: "sk03" | "merged"): boolean => {
        const u = s.uploads[kind]
        return !!(u && s.build && u.result === "latest" && u.build_id === s.build.id)
    }
    const inputsInBuild = (s: State): boolean =>
        !!(s.inputs && s.build && Number(s.build.budget) === Number(s.inputs.budget) && Number(s.build.per_p4p) === Number(s.inputs.per_p4p))
    const blocking = (s: State): Build["problems"] => (s.build ? s.build.problems.filter((p) => p.blocking) : [])

    const PROBLEM: Record<string, (p: Build["problems"][0]) => string> = {
        no_inputs: () => "ยังไม่ได้กรอกงบประมาณและ per P4P (ข้อ 1)",
        inputs_not_in_sheet: () => "งบประมาณหรือ per P4P ใน SK03 ไม่ตรงกับข้อ 1",
        not_in_sk03: (p) => "SK03 ไม่มีชื่อ " + int(p.count || 0) + " คนตามรายชื่อเดือนนี้",
        no_doctor_sheet: (p) => "ไม่พบชีตของแพทย์ " + int(p.count || 0) + " คนในไฟล์รวม",
        not_in_dept_sheet: (p) => "ไม่พบชื่อในชีตกลุ่มงาน " + int(p.count || 0) + " คน",
    }

    // ── Loading ──────────────────────────────────────────────────────────
    async function loadMonths(): Promise<boolean> {
        const r = await api<{ installed: boolean; months?: MonthRow[] }>("/dashboard/api/review/months")
        if (!r.installed) { renderNotInstalled(); return false }
        const rows = r.months || []
        const keep = month && rows.some((m) => m.month === month) ? month : (rows[0] ? rows[0].month : "")
        monthSel.replaceChildren(...rows.map((m) => {
            const o = el("option", undefined, monthName(m.month) + " — " + monthStatus(m))
            o.value = m.month
            return o
        }))
        month = keep
        monthSel.value = keep
        return rows.length > 0
    }
    const monthStatus = (m: MonthRow): string => {
        if (m.round) {
            if (m.round.status === "approved") return "อนุมัติครบแล้ว"
            if (m.round.status === "returned") return "รอผู้จัดทำแก้ไข (รอบที่ " + m.round.round_no + ")"
            return "กำลังตรวจ รอบที่ " + m.round.round_no
        }
        if (m.sent < m.total) return "แพทย์ส่งไฟล์ " + int(m.sent) + "/" + int(m.total)
        return "รอผู้จัดทำส่งข้อมูล"
    }

    async function loadState(logView: boolean): Promise<void> {
        if (!month) return
        const s = await api<State>("/dashboard/api/review/" + month + (logView ? "?view=1" : ""))
        if (!s.installed) { renderNotInstalled(); return }
        st = s
        render()
        clearTimeout(poll)
        const r = liveRound(s)
        const pdfWaiting = !!(r && r.status === "approved" && (r.pdf_status === "queued" || r.pdf_status === "building"))
        if (openRequest(s) || pdfWaiting) poll = window.setTimeout(() => { void refresh() }, 15000)
    }
    async function refresh(): Promise<void> {
        if (view.classList.contains("hidden") || busy) return
        try { await loadState(false) } catch (e) { /* next look retries */ }
    }

    async function open(): Promise<void> {
        body.replaceChildren(el("p", "rv-loading", "กำลังโหลด…"))
        try {
            if (!(await loadMonths())) {
                if (body.querySelector(".rv-loading")) body.replaceChildren(card("ยังไม่มีเดือนให้ตรวจ", [el("p", undefined, "ยังไม่มีตารางรายชื่อของเดือนใด")]))
                return
            }
            await loadState(true)
        } catch (e) {
            body.replaceChildren(el("div", "alert", e instanceof Error ? e.message : "โหลดข้อมูลไม่สำเร็จ"))
        }
    }
    window.addEventListener("dashboard:review", () => { void open() })
    monthSel.addEventListener("change", () => { month = monthSel.value; void loadState(true) })
    for (const b of roleBtns) {
        b.addEventListener("click", () => {
            role = b.dataset.role === "auditor" ? "auditor" : "auditee"
            try { localStorage.setItem(ROLE_KEY, role) } catch (e) { /* ignore */ }
            render()
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
        body.replaceChildren(card("ยังเปิดใช้แท็บนี้ไม่ได้", [
            el("p", undefined, "ฐานข้อมูลยังไม่มีตารางของแท็บตรวจสอบ ผู้ดูแลระบบต้องรันไฟล์ scripts/review-tab-2026-11.sql ใน Supabase SQL editor ก่อน แล้วรีเฟรชหน้านี้"),
        ]))
    }

    function render(): void {
        for (const b of roleBtns) b.setAttribute("aria-pressed", String(b.dataset.role === role))
        if (!st) return
        const s = st
        const focusId = document.activeElement && (document.activeElement as HTMLElement).id
        const list = body.querySelector(".rv-people-list")
        const listTop = list ? list.scrollTop : 0
        refreshLists(s)
        body.replaceChildren(...(role === "auditee" ? auditee(s) : auditor(s)))
        const list2 = body.querySelector(".rv-people-list")
        if (list2) list2.scrollTop = listTop
        if (focusId) { const f = document.getElementById(focusId); if (f) f.focus() }
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
    function auditee(s: State): Node[] {
        const out: Node[] = []
        const r = liveRound(s)
        const name = monthName(s.month, true)
        if (r && r.status === "submitted") {
            out.push(turn("wait", "รอผู้ตรวจสอบ", "ส่งรอบที่ " + r.round_no + " แล้ว เมื่อ " + when(r.submitted_at),
                r.reopened_at ? "ผู้ตรวจสอบยกเลิกเอกสารเบิกจ่ายและเปิดตรวจอีกครั้ง เมื่อ " + when(r.reopened_at) + " · เหตุผล: " + (r.reopen_reason || "")
                    : r.auditor_opened_at ? "ผู้ตรวจสอบเปิดดูแล้ว เมื่อ " + when(r.auditor_opened_at) : "ผู้ตรวจสอบยังไม่ได้เปิด ดึงกลับมาแก้ได้จนกว่าผู้ตรวจสอบจะเปิด"))
            out.push(sentSummary(s, r))
            return out
        }
        if (r && r.status === "approved") return approvedView(s, r, "auditee")
        if (r && r.status === "returned") {
            out.push(turn("you", "ถึงคิวคุณ", "ผู้ตรวจสอบส่งกลับรอบที่ " + r.round_no + " ให้แก้ไข เมื่อ " + when(r.returned_at),
                "ต้องแก้ " + int(r.counts.fix) + " คน · แก้ในแอป แล้วสร้างไฟล์ใหม่ ดาวน์โหลด และส่งรอบที่ " + (r.round_no + 1)))
        } else if (s.roster.sent < s.roster.total) {
            out.push(turn("wait", "รอแพทย์", "แพทย์ส่งไฟล์แล้ว " + int(s.roster.sent) + " จาก " + int(s.roster.total) + " คน",
                "ระบบสร้าง SK03 ได้เมื่อแพทย์ส่งครบและรายชื่อตรงกับ Drive · กรอกข้อ 1 ไว้ก่อนได้"))
        } else {
            out.push(turn("you", "ถึงคิวคุณ", "ส่งข้อมูลเดือน " + name + " ให้ผู้ตรวจสอบ", "แพทย์ส่งไฟล์ครบ " + int(s.roster.total) + " คนแล้ว · ทำตามลำดับข้อ 1 ถึง 3"))
        }
        if (r && r.status === "returned") out.push(answersCard(s, r))
        out.push(inputsCard(s), filesCard(s), uploadCard(s))
        return out
    }

    function inputsCard(s: State): HTMLElement {
        const form = el("form", "rv-form")
        form.noValidate = true
        const field = (id: string, label: string, value: number | null, hint: string): HTMLElement => {
            const w = el("div", "rv-field")
            const l = el("label", undefined, label)
            l.htmlFor = id
            const i = el("input")
            i.id = id
            i.type = "text"
            i.inputMode = "decimal"
            i.autocomplete = "off"
            i.value = value === null ? "" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            const h = el("p", "rv-hint", hint)
            h.id = id + "-h"
            const err = el("p", "rv-err hidden")
            err.id = id + "-e"
            i.setAttribute("aria-describedby", h.id + " " + err.id)
            w.append(l, i, h, err)
            return w
        }
        const base = monthName(s.month, true).replace(/ 25(\d\d)$/, " $1")
        const grid = el("div", "rv-grid")
        form.append(grid)
        grid.append(
            field("rv-budget", "งบประมาณ P4P ทั้งหมดของเดือน (บาท)", s.inputs ? s.inputs.budget : null,
                "ระบบใส่ลงแท็บ \"" + base + " - staff\" ช่อง Y9 ให้"),
            field("rv-rate", "per P4P อินเทิร์น (บาท ต่อคน)", s.inputs ? s.inputs.per_p4p : null,
                "ระบบใส่ลงแท็บ \"" + base + " - intern\" ช่อง W9 เป็น จำนวนอินเทิร์น × อัตรานี้"),
        )
        const row = el("div", "rv-actions")
        const save = el("button", "btn-primary", "บันทึกและใส่ลง SK03")
        save.type = "submit"
        row.append(save)
        if (s.inputs) row.append(el("p", "rv-saved", "✓ บันทึกแล้ว " + when(s.inputs.updated_at) + (s.inputs.updated_by ? " โดย " + s.inputs.updated_by : "") + " · ระบบใส่ให้อีกทุกคืนหลังสร้าง SK03 ใหม่ ตัวเลขนี้จึงไม่หาย"))
        form.append(row)
        const editable = auditeeTurn(s)
        if (!editable) { for (const i of Array.from(form.querySelectorAll("input"))) i.readOnly = true; save.disabled = true }
        form.addEventListener("submit", (ev) => {
            ev.preventDefault()
            void saveInputs(form, save)
        })
        return card("1. กรอกงบประมาณและ per P4P (กรอกที่นี่ที่เดียว ไม่ต้องแก้ใน SK03)", [form], "rv-h1")
    }

    const MONEY_RE = /^\d+(\.\d{1,2})?$/
    async function saveInputs(form: HTMLFormElement, btn: HTMLButtonElement): Promise<void> {
        let bad: HTMLInputElement | null = null
        const read = (id: string): string => {
            const i = form.querySelector("#" + id) as HTMLInputElement
            const e = form.querySelector("#" + id + "-e") as HTMLElement
            const v = i.value.replace(/,/g, "").trim()
            const ok = MONEY_RE.test(v) && Number(v) > 0
            i.setAttribute("aria-invalid", String(!ok))
            e.textContent = ok ? "" : "กรอกตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 9,551.81"
            e.classList.toggle("hidden", ok)
            if (!ok && !bad) bad = i
            return v
        }
        const budget = read("rv-budget"), rate = read("rv-rate")
        if (bad) { (bad as HTMLInputElement).focus(); return }
        busy = true
        btn.disabled = true
        try {
            const r = await post<{ changed: boolean }>("/dashboard/api/review/" + month + "/inputs", { budget, per_p4p: rate }, "PUT")
            say(r.changed ? "บันทึกแล้ว ระบบกำลังสร้าง SK03 ใหม่ที่มีตัวเลขนี้ ประมาณ 5 ถึง 15 นาที" : "บันทึกแล้ว ตัวเลขเหมือนเดิม")
        } catch (e) {
            say(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ")
        } finally {
            busy = false
            btn.disabled = false
        }
        await loadState(false)
    }

    function requestLine(s: State): HTMLElement | null {
        const q = s.request
        if (!q) return null
        if (["queued", "dispatched"].includes(q.status)) return el("p", "rv-progress", "⏳ รอเริ่มสร้างไฟล์ใหม่ (ขอเมื่อ " + when(q.requested_at) + ") · ถ้ามีการสร้างอื่นอยู่ จะเริ่มต่อจากนั้น")
        if (q.status === "running") return el("p", "rv-progress", "⏳ กำลังสร้าง SK03 และไฟล์รวมใหม่ (เริ่ม " + when(q.started_at) + ") · ประมาณ 5 ถึง 15 นาที หน้านี้จะอัปเดตเอง")
        if (q.status === "failed" && (!s.build || Date.parse(q.requested_at) > Date.parse(s.build.built_at))) {
            return el("p", "rv-err", "สร้างไฟล์ไม่สำเร็จ: " + (q.error || "ไม่ทราบสาเหตุ"))
        }
        return null
    }

    function filesCard(s: State): HTMLElement {
        const kids: Node[] = []
        const b = s.build
        const req = openRequest(s)
        const rl = requestLine(s)
        if (!b) {
            kids.push(el("p", undefined, "ยังไม่มีไฟล์ที่ระบบสร้างของเดือนนี้ ระบบสร้างทุกคืนเวลา 00:37 น. เมื่อแพทย์ส่งไฟล์ครบ หรือกดสร้างใหม่ด้านล่าง"))
        } else {
            kids.push(el("p", "rv-meta", "ไฟล์ล่าสุดสร้างเมื่อ " + when(b.built_at) + " · " + int(b.people) + " คน (staff " + int(b.staff) + " · อินเทิร์น " + int(b.interns) + ")" +
                (b.budget !== null ? " · งบประมาณ " + baht(b.budget) + " · per P4P " + baht(b.per_p4p) : " · ยังไม่มีงบประมาณ")))
            const ul = el("ul", "rv-checks")
            if (s.inputs && !inputsInBuild(s)) ul.append(line("bad", req ? "ไฟล์นี้ยังไม่มีตัวเลขที่บันทึกล่าสุด รอไฟล์ใหม่ที่กำลังสร้าง" : "ไฟล์นี้ยังไม่มีงบประมาณและ per P4P ที่บันทึกล่าสุด กดสร้างไฟล์ใหม่"))
            for (const p of b.problems) {
                const text = (PROBLEM[p.code] || (() => p.code))(p) + (p.names && p.names.length ? ": " + p.names.slice(0, 8).join(", ") + (p.names.length > 8 ? " และอีก " + int(p.names.length - 8) + " คน" : "") : "")
                ul.append(line(p.blocking ? "bad" : "warn", text))
            }
            const c = s.buildChecks
            if (c) {
                const diff = c.scoreMismatch + c.moneyMismatch
                const miss = c.scoreMissing + c.moneyMissing
                if (!diff && !miss) ul.append(line("ok", "ระบบเทียบคะแนนและเงินให้แล้ว ตรงกันทุกคน"))
                else ul.append(line("warn", "ระบบเทียบให้แล้ว: คะแนนไม่ตรง " + int(c.scoreMismatch) + " · ไม่พบคะแนนในชีตของแพทย์ " + int(c.scoreMissing) +
                    " · เงินไม่ตรง " + int(c.moneyMismatch) + " · ไม่พบในชีตกลุ่มงาน " + int(c.moneyMissing) + " — แก้ในแอปก่อนส่ง หรือส่งให้ผู้ตรวจสอบพิจารณาก็ได้"))
            }
            if (ul.childNodes.length) kids.push(ul)
            const dl = el("ul", "rv-downloads")
            const link = (kind: "sk03" | "merged", text: string): HTMLElement => {
                const li = el("li")
                const a = el("a", "rv-link", text)
                a.href = "/dashboard/api/review/" + s.month + "/file/" + b.id + "/" + kind
                a.setAttribute("download", "")
                li.append(a)
                return li
            }
            dl.append(link("sk03", "ดาวน์โหลด SK03 " + monthName(s.month, true) + " เป็น Excel"),
                link("merged", "ดาวน์โหลดไฟล์รวมคะแนนรายคน " + monthName(s.month, true)))
            kids.push(dl)
        }
        kids.push(el("p", "rv-hint", "ถ้าต้องแก้อะไร: แก้คะแนน ชื่อ หรือกลุ่มงานในแท็บรายชื่อ หรือให้แพทย์ส่งไฟล์ใหม่ทาง LINE หรืออีเมล ห้ามแก้ในไฟล์ Excel แล้วสร้างไฟล์ใหม่ ระบบจะใช้ไฟล์ใหม่เท่านั้น งบประมาณและ per P4P กรอกในข้อ 1 เท่านั้น"))
        const row = el("div", "rv-actions")
        const rebuild = el("button", "btn-ghost", req ? "กำลังสร้างไฟล์ใหม่…" : "สร้าง SK03 และไฟล์รวมใหม่")
        rebuild.type = "button"
        rebuild.id = "rv-rebuild"
        rebuild.disabled = !!req || !auditeeTurn(s)
        rebuild.setAttribute("aria-describedby", "rv-rebuild-h")
        const rh = el("span", "rv-hint", "ใช้หลังแก้ในแอป · ประมาณ 5 ถึง 15 นาที แล้วดาวน์โหลดใหม่")
        rh.id = "rv-rebuild-h"
        rebuild.addEventListener("click", () => { void doRebuild(rebuild) })
        row.append(rebuild, rh)
        kids.push(row)
        if (rl) kids.push(rl)
        return card("2. ดาวน์โหลดไฟล์", kids, "rv-h2")
    }

    async function doRebuild(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true
        try {
            await post("/dashboard/api/review/" + month + "/rebuild")
            say("ขอสร้างไฟล์ใหม่แล้ว ประมาณ 5 ถึง 15 นาที หน้านี้จะอัปเดตเอง")
        } catch (e) {
            say(e instanceof Error ? e.message : "ขอสร้างไฟล์ใหม่ไม่สำเร็จ")
        }
        await loadState(false)
    }

    const UPLOAD_TEXT: Record<string, string> = {
        latest: "ตรงกับไฟล์ที่ระบบสร้างล่าสุด ไม่มีการแก้ในไฟล์",
        older: "เป็นไฟล์รุ่นเก่า ดาวน์โหลดไฟล์ล่าสุดในข้อ 2 แล้วเลือกใหม่",
        other_kind: "เป็นไฟล์อีกชนิด (เลือกสลับช่อง) เลือกไฟล์ให้ตรงช่อง",
        unknown: "ไม่ใช่ไฟล์ที่ระบบสร้าง หรือถูกแก้หลังดาวน์โหลด ห้ามแก้ในไฟล์ ให้แก้ในแอป สร้างไฟล์ใหม่ แล้วดาวน์โหลดใหม่",
    }

    function uploadSlot(s: State, kind: "sk03" | "merged"): HTMLElement {
        const u = s.uploads[kind]
        const ok = uploadOk(s, kind)
        const title = kind === "sk03" ? "SK03" : "ไฟล์รวมคะแนนรายคน"
        const slot = el("div", "rv-slot" + (u ? (ok ? " ok" : " bad") : ""))
        slot.append(el("h3", undefined, title))
        const status = el("ul", "rv-checks")
        status.id = "rv-" + kind + "-st"
        if (u) {
            slot.append(el("p", "rv-file", u.file_name + " · " + sizeText(u.bytes) + " · เลือกเมื่อ " + when(u.created_at)))
            if (u.result === "latest" && !ok) status.append(line("bad", "มีไฟล์ใหม่กว่าที่ระบบสร้างหลังเลือกไฟล์นี้ ดาวน์โหลดใหม่แล้วเลือกอีกครั้ง"))
            else status.append(line(ok ? "ok" : "bad", UPLOAD_TEXT[u.result || "unknown"]))
        } else {
            status.append(line("info", "ยังไม่ได้เลือกไฟล์"))
        }
        slot.append(status)
        const pick = el("div", "rv-pick")
        const input = el("input")
        input.type = "file"
        input.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        input.id = "rv-file-" + kind
        input.className = "sr-only"
        input.setAttribute("aria-describedby", status.id)
        if (u && !ok) input.setAttribute("aria-invalid", "true")
        const fileWord = kind === "sk03" ? "ไฟล์ SK03" : "ไฟล์รวมคะแนนรายคน"
        const lab = el("label", "btn-ghost rv-btn-label", "เลือก" + fileWord + (u ? "ใหม่" : ""))
        lab.htmlFor = input.id
        const editable = auditeeTurn(s) && !!s.build
        input.disabled = !editable
        if (!editable) lab.classList.add("disabled")
        input.addEventListener("change", () => { if (input.files && input.files[0]) void doUpload(kind, input.files[0], slot) })
        pick.append(input, lab, el("span", "rv-hint", "หรือลากไฟล์มาวางในกรอบนี้"))
        slot.append(pick)
        slot.addEventListener("dragover", (ev) => { if (editable) { ev.preventDefault(); slot.classList.add("drag") } })
        slot.addEventListener("dragleave", () => slot.classList.remove("drag"))
        slot.addEventListener("drop", (ev) => {
            ev.preventDefault()
            slot.classList.remove("drag")
            const f = ev.dataTransfer && ev.dataTransfer.files[0]
            if (f && editable) void doUpload(kind, f, slot)
        })
        return slot
    }

    async function doUpload(kind: "sk03" | "merged", file: File, slot: HTMLElement): Promise<void> {
        const title = kind === "sk03" ? "SK03" : "ไฟล์รวมคะแนนรายคน"
        if (!/\.xlsx$/i.test(file.name)) { say(title + ": เลือกไฟล์ .xlsx"); return }
        busy = true
        slot.setAttribute("aria-busy", "true")
        const st2 = slot.querySelector(".rv-checks") as HTMLElement
        st2.replaceChildren(line("info", "กำลังอัปโหลดและตรวจไฟล์…"))
        say(title + ": กำลังอัปโหลดและตรวจไฟล์")
        try {
            const start = await post<{ id: string; url: string; contentType: string }>("/dashboard/api/review/" + month + "/uploads",
                { kind, fileName: file.name, bytes: file.size })
            const put = await fetch(start.url, { method: "PUT", body: file, headers: { "Content-Type": start.contentType, "x-upsert": "false" } })
            if (!put.ok) throw new Error("อัปโหลดไม่สำเร็จ (" + put.status + ") ลองอีกครั้ง")
            const v = await post<{ result: string }>("/dashboard/api/review/" + month + "/uploads/" + start.id + "/verify")
            say(title + ": " + (UPLOAD_TEXT[v.result] || v.result))
        } catch (e) {
            say(title + ": " + (e instanceof Error ? e.message : "อัปโหลดไม่สำเร็จ"))
        } finally {
            busy = false
        }
        await loadState(false)
    }

    function submitReasons(s: State): string[] {
        const why: string[] = []
        if (!auditeeTurn(s)) why.push("ส่งให้ผู้ตรวจสอบแล้ว")
        if (!s.inputs) why.push("กรอกงบประมาณและ per P4P ในข้อ 1")
        if (!s.build) why.push("รอระบบสร้างไฟล์")
        if (openRequest(s)) why.push("รอสร้างไฟล์ใหม่ให้เสร็จก่อน")
        else if (s.inputs && s.build && !inputsInBuild(s)) why.push("สร้างไฟล์ใหม่ให้มีงบประมาณและ per P4P ล่าสุด")
        if (blocking(s).length) why.push("แก้ปัญหาที่แจ้งในข้อ 2 ในแอปก่อน")
        if (!uploadOk(s, "sk03")) why.push("เลือกไฟล์ SK03 ที่ดาวน์โหลดล่าสุด")
        if (!uploadOk(s, "merged")) why.push("เลือกไฟล์รวมคะแนนรายคนที่ดาวน์โหลดล่าสุด")
        return why
    }

    function uploadCard(s: State): HTMLElement {
        const grid = el("div", "rv-upload-grid")
        grid.append(uploadSlot(s, "sk03"), uploadSlot(s, "merged"))
        const why = submitReasons(s)
        const row = el("div", "rv-actions")
        const r = liveRound(s)
        const next = r ? r.round_no + 1 : 1
        const send = el("button", "btn-primary rv-lg", "ตรวจทานและส่งรอบที่ " + next + " ให้ผู้ตรวจสอบ…")
        send.type = "button"
        send.id = "rv-send"
        const reason = el("p", "rv-hint")
        reason.id = "rv-send-why"
        if (why.length) {
            send.setAttribute("aria-disabled", "true")
            send.setAttribute("aria-describedby", reason.id)
            reason.textContent = "ส่งได้เมื่อ: " + why.join(" · ")
        }
        send.addEventListener("click", () => {
            if (why.length) { say("ยังส่งไม่ได้: " + why.join(" · ")); return }
            openConfirm(s, next)
        })
        row.append(send, reason)
        return card("3. เลือกไฟล์ที่ดาวน์โหลดแล้วส่ง", [grid, row], "rv-h3")
    }

    function openConfirm(s: State, roundNo: number): void {
        const b = s.build as Build
        const c = s.buildChecks
        const ul = el("ul", "rv-confirm-list")
        ul.append(
            el("li", undefined, "เดือน " + monthName(s.month) + " · รอบที่ " + roundNo),
            el("li", undefined, "งบประมาณ " + baht(b.budget) + " บาท · per P4P อินเทิร์น " + baht(b.per_p4p) + " บาท"),
            el("li", undefined, int(b.people) + " คน (staff " + int(b.staff) + " · อินเทิร์น " + int(b.interns) + ") · รวมจ่าย " + baht(b.pay_total) + " บาท"),
            el("li", undefined, "ไฟล์สร้างเมื่อ " + when(b.built_at)),
        )
        if (c && (c.scoreMismatch + c.moneyMismatch + c.scoreMissing + c.moneyMissing)) {
            ul.append(el("li", undefined, "ระบบพบคะแนนหรือเงินไม่ตรง หรือไม่พบ " + int(c.scoreMismatch + c.moneyMismatch + c.scoreMissing + c.moneyMissing) + " รายการ ผู้ตรวจสอบจะพิจารณา"))
        }
        const r = liveRound(s)
        const note = el("p", "rv-hint", r && r.status === "returned"
            ? "รอบนี้ผู้ตรวจสอบจะตรวจคนที่ส่งกลับให้แก้ และคนที่คะแนน กลุ่มงาน หรือชื่อของตัวเองเปลี่ยน หรือผลเทียบไม่ตรงกันแล้ว คนอื่นที่อนุมัติแล้วคงผลเดิม"
            : "หลังส่ง ระบบล็อกตัวเลขและไฟล์ไว้จนกว่าผู้ตรวจสอบจะส่งผลกลับ ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิดดู")
        askConfirm("ตรวจทานก่อนส่งให้ผู้ตรวจสอบ", [ul, note], "ส่งรอบที่ " + roundNo, doSubmit)
    }
    // One confirm dialog for every step that hands the month to the other side.
    let confirmAction: (() => Promise<void>) | null = null
    function askConfirm(title: string, kids: Node[], button: string, action: () => Promise<void>): void {
        confirmTitle.textContent = title
        confirmBody.replaceChildren(...kids)
        confirmSend.textContent = button
        confirmAction = action
        confirmDlg.showModal()
    }
    confirmSend.addEventListener("click", () => { if (confirmAction) void confirmAction() })
    async function doSubmit(): Promise<void> {
        if (!st) return
        const s = st
        const sk03 = s.uploads.sk03, merged = s.uploads.merged
        if (!sk03 || !merged) return
        confirmSend.disabled = true
        confirmSend.setAttribute("aria-busy", "true")
        try {
            const r = await post<{ round: { round_no: number } }>("/dashboard/api/review/" + month + "/rounds", { sk03: sk03.id, merged: merged.id })
            confirmDlg.close()
            say("ส่งรอบที่ " + r.round.round_no + " ให้ผู้ตรวจสอบแล้ว")
        } catch (e) {
            confirmDlg.close()
            say(e instanceof Error ? e.message : "ส่งไม่สำเร็จ")
        } finally {
            confirmSend.disabled = false
            confirmSend.removeAttribute("aria-busy")
        }
        await loadMonths().catch(() => false)
        await loadState(false)
        const h = document.querySelector<HTMLElement>("#review-body .rv-turn")
        if (h) { h.tabIndex = -1; h.focus() }
    }

    function sentSummary(s: State, r: Round): HTMLElement {
        const kids: Node[] = []
        const ul = el("ul", "rv-confirm-list")
        ul.append(
            el("li", undefined, "งบประมาณ " + baht(r.budget) + " บาท · per P4P อินเทิร์น " + baht(r.per_p4p) + " บาท"),
            el("li", undefined, "ผู้ตรวจสอบอนุมัติแล้ว " + int(r.counts.approve) + " · รอตรวจ " + int(r.counts.waiting) + " · ต้องแก้ " + int(r.counts.fix)),
        )
        kids.push(ul)
        if (!r.auditor_opened_at) {
            const row = el("div", "rv-actions")
            const w = el("button", "btn-ghost", "ดึงกลับมาแก้")
            w.type = "button"
            w.addEventListener("click", () => { void doWithdraw(w) })
            row.append(w, el("span", "rv-hint", "ใช้เมื่อส่งผิด · ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิดดู"))
            kids.push(row)
        }
        return card("รอบที่ " + r.round_no + " ที่ส่งไว้", kids, "rv-h-sent")
    }
    async function doWithdraw(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true
        try {
            await post("/dashboard/api/review/" + month + "/rounds/withdraw")
            say("ดึงกลับแล้ว แก้แล้วส่งใหม่ได้")
        } catch (e) {
            say(e instanceof Error ? e.message : "ดึงกลับไม่สำเร็จ")
        }
        await loadMonths().catch(() => false)
        await loadState(false)
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
        deptRow: number | null
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

    let people: Person[] | null = null
    let peopleKey = ""
    let issues: Issue[] | null = null
    let issuesKey = ""
    let selected = ""
    let filter = "todo"
    let search = ""
    const details = new Map<string, Detail>()

    const roundKey = (s: State, r: Round): string => s.month + ":" + r.round_no + ":" + r.status + ":" + (r.counts.approve + r.counts.fix)
    async function loadPeople(s: State, r: Round): Promise<void> {
        const key = s.month + ":" + r.round_no
        const res = await api<{ people: Person[] }>("/dashboard/api/review/" + s.month + "/people?round=" + r.round_no)
        people = res.people
        peopleKey = key
        if (!selected || !people.some((p) => p.index === selected)) {
            const first = people.find((p) => p.decision === null) || people[0]
            selected = first ? first.index : ""
        }
        render()
    }
    async function loadIssues(s: State): Promise<void> {
        const res = await api<{ issues: Issue[] }>("/dashboard/api/review/" + s.month + "/issues")
        issues = res.issues
        issuesKey = s.month
        render()
    }
    const needPeople = (s: State, r: Round): boolean => peopleKey !== s.month + ":" + r.round_no
    const ensure = (s: State, r: Round): void => {
        if (needPeople(s, r)) { peopleKey = s.month + ":" + r.round_no; void loadPeople(s, r).catch((e) => say(e.message)) }
        if (issuesKey !== s.month) { issuesKey = s.month; void loadIssues(s).catch((e) => say(e.message)) }
    }
    // A new state (another round, a decision made elsewhere) reloads both.
    let lastRoundKey = ""
    function refreshLists(s: State): void {
        const r = liveRound(s)
        if (!r) return
        const k = roundKey(s, r)
        if (k !== lastRoundKey) { lastRoundKey = k; peopleKey = ""; issuesKey = "" }
    }

    const CHECK_TEXT: Record<string, string> = { match: "ตรงกัน", mismatch: "ไม่ตรงกัน", missing: "ไม่พบ" }
    const WHY_TEXT: Record<string, string> = {
        fix: "รอบก่อนให้แก้ไข", new: "ไม่มีในรอบก่อน", score: "คะแนนของตัวเองเปลี่ยน",
        department: "กลุ่มงานเปลี่ยน", name: "ชื่อเปลี่ยน", check: "ผลเทียบไม่ตรงกัน",
    }
    const HOW_TEXT: Record<string, string> = {
        "grand-total": "แถวรวมทั้งหมด", "sub-total": "แถวรวม", "largest-over-sub-total": "ตัวเลขมากที่สุดในชีต (มากกว่าแถวรวม)",
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
                b.addEventListener("click", () => { void roundStep("unreturn", "ดึงกลับแล้ว ตรวจต่อได้") })
                row.append(b, el("span", "rv-hint", "ใช้ได้จนกว่าผู้จัดทำจะเปิดดู"))
                out.push(card("ส่งผิด?", [row], "rv-h-unret"))
            }
            return out
        }
        if (r.status === "approved") return approvedView(s, r, "auditor")
        ensure(s, r)
        const out: Node[] = [turn("you", "ถึงคิวคุณ", "ตรวจรอบที่ " + r.round_no + " เดือน " + monthName(s.month, true),
            "ส่งมาเมื่อ " + when(r.submitted_at) + (r.submitted_by ? " โดย " + r.submitted_by : "") +
            " · งบประมาณ " + baht(r.budget) + " · per P4P อินเทิร์น " + baht(r.per_p4p))]
        out.push(finishBar(s, r))
        if (!people) { out.push(el("p", "rv-loading", "กำลังโหลดรายชื่อ…")); return out }
        const wrap = el("div", "rv-review")
        wrap.append(peopleList(), personPanel(s, r))
        out.push(wrap, issuesCard(s, "auditor"))
        return out
    }

    function finishBar(s: State, r: Round): HTMLElement {
        const c = r.counts
        const openIssues = (issues || []).filter((i) => i.status === "open").length
        const bar = el("div", "rv-finish glass")
        bar.append(el("p", "rv-counts", "รอตรวจ " + int(c.waiting) + " · อนุมัติ " + int(c.approve) +
            (c.carried ? " (คงผลรอบก่อน " + int(c.carried) + ")" : "") + " · ต้องแก้ไข " + int(c.fix) + " · ปัญหาอื่นที่เปิดอยู่ " + int(openIssues)))
        const btn = el("button", "btn-primary")
        btn.type = "button"
        btn.id = "rv-finish"
        const why = el("span", "rv-hint")
        why.id = "rv-finish-why"
        if (c.waiting > 0) {
            btn.textContent = "ส่งผลตรวจ…"
            btn.setAttribute("aria-disabled", "true")
            btn.setAttribute("aria-describedby", why.id)
            why.textContent = "ส่งได้เมื่อตรวจครบทุกคน (เหลือ " + int(c.waiting) + " คน)"
            btn.addEventListener("click", () => say(why.textContent || ""))
        } else if (c.fix > 0 || openIssues > 0) {
            btn.textContent = "ส่งกลับให้ผู้จัดทำแก้…"
            why.textContent = "ต้องแก้ไข " + int(c.fix) + " คน · ปัญหาอื่น " + int(openIssues) + " เรื่อง"
            btn.addEventListener("click", () => {
                askConfirm("ส่งกลับให้ผู้จัดทำแก้", [el("p", undefined, "ส่งรอบที่ " + r.round_no + " กลับ: ต้องแก้ไข " + int(c.fix) + " คน · ปัญหาอื่นที่เปิดอยู่ " + int(openIssues) + " เรื่อง"),
                    el("p", "rv-hint", "ดึงกลับได้จนกว่าผู้จัดทำจะเปิดดู")], "ส่งกลับ", () => roundStep("return", "ส่งกลับให้ผู้จัดทำแล้ว"))
            })
        } else {
            btn.textContent = "อนุมัติทั้งหมด…"
            why.textContent = "อนุมัติครบ " + int(c.approve) + " คน และไม่มีปัญหาที่เปิดอยู่"
            btn.addEventListener("click", () => {
                askConfirm("อนุมัติทั้งหมด", [el("p", undefined, "อนุมัติ " + int(c.approve) + " คน ของเดือน " + monthName(s.month) + " รอบที่ " + r.round_no),
                    el("p", "rv-hint", "หลังอนุมัติ ระบบจะทำเอกสารเบิกจ่าย (PDF) ที่มีเวลาอนุมัติทุกหน้า")], "อนุมัติ", () => roundStep("approve", "อนุมัติแล้ว"))
            })
        }
        bar.append(btn, why)
        return bar
    }

    // ── Approved: the document, a retry, and reopening ───────────────────
    function approvedView(s: State, r: Round, side: "auditee" | "auditor"): Node[] {
        const status = r.pdf_status || "queued"
        const out: Node[] = [turn("ok", "เสร็จแล้ว", "อนุมัติครบ " + int(r.counts.approve) + " คน เมื่อ " + when(r.approved_at) +
            (r.approved_by ? " โดย " + r.approved_by : ""),
            status === "ready" ? "เอกสารเบิกจ่ายพร้อมแล้ว" + (r.pdf_built_at ? " (สร้างเมื่อ " + when(r.pdf_built_at) + ")" : "") + " · ทั้งสองฝั่งดาวน์โหลดได้"
                : status === "failed" ? "สร้างเอกสารเบิกจ่ายไม่สำเร็จ ดูด้านล่าง"
                    : "กำลังสร้างเอกสารเบิกจ่าย (PDF) · ปกติไม่เกินไม่กี่นาที หน้านี้อัปเดตเอง")]
        const kids: Node[] = []
        if (status === "ready") {
            const a = el("a", "btn-primary rv-download", "ดาวน์โหลดเอกสารเบิกจ่าย " + monthName(s.month, true) + " (PDF" +
                (r.pdf_pages ? ", " + int(r.pdf_pages) + " หน้า" : "") + (r.pdf_bytes ? ", " + sizeText(r.pdf_bytes) : "") + ")")
            a.href = "/dashboard/api/review/" + s.month + "/pdf"
            a.id = "rv-pdf"
            kids.push(el("div", "rv-actions"))
            ;(kids[0] as HTMLElement).append(a)
            kids.push(el("p", "rv-hint", "A4 แนวนอน · หน้าแรกสรุปรายกลุ่มงาน ตามด้วยชีตกลุ่มงานทุกกลุ่ม · เวลาอนุมัติอยู่มุมขวาล่างทุกหน้า"))
        } else if (status === "failed") {
            const p = el("p", "alert", "สร้างเอกสารเบิกจ่ายไม่สำเร็จ")
            p.setAttribute("role", "alert")
            kids.push(p)
            if (r.pdf_error) kids.push(el("p", "rv-hint", "รายละเอียด: " + r.pdf_error))
            const row = el("div", "rv-actions")
            const b = el("button", "btn-primary", "สร้างเอกสารอีกครั้ง")
            b.type = "button"
            b.id = "rv-pdf-retry"
            b.addEventListener("click", () => { void retryPdf(b) })
            row.append(b)
            kids.push(row)
        } else {
            const p = el("p", "rv-loading", "กำลังสร้างเอกสาร…")
            p.setAttribute("aria-busy", "true")
            kids.push(p)
        }
        out.push(card("เอกสารเบิกจ่าย", kids, "rv-h-pdf"))
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

    async function retryPdf(b: HTMLButtonElement): Promise<void> {
        b.disabled = true
        try {
            await post("/dashboard/api/review/" + month + "/pdf/retry")
            say("สั่งสร้างเอกสารอีกครั้งแล้ว")
        } catch (e) {
            say(e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ")
        }
        await loadState(false)
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
            confirmSend.disabled = true
            try {
                await post("/dashboard/api/review/" + month + "/reopen", { reason })
                say("ยกเลิกเอกสารแล้ว รอบที่ " + r.round_no + " กลับมาให้ตรวจอีกครั้ง")
                if (confirmDlg.open) confirmDlg.close()
            } catch (e) {
                err.textContent = e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ"
                return
            } finally {
                confirmSend.disabled = false
            }
            peopleKey = ""; issuesKey = ""
            await loadMonths().catch(() => false)
            await loadState(false)
        })
        setTimeout(() => ta.focus(), 0)
    }

    async function roundStep(step: "return" | "unreturn" | "approve", done: string): Promise<void> {
        confirmSend.disabled = true
        try {
            await post("/dashboard/api/review/" + month + "/" + step)
            say(done)
        } catch (e) {
            say(e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ")
        } finally {
            confirmSend.disabled = false
            if (confirmDlg.open) confirmDlg.close()
        }
        peopleKey = ""; issuesKey = ""
        await loadMonths().catch(() => false)
        await loadState(false)
    }

    function visiblePeople(): Person[] {
        const q = search.trim().toLowerCase()
        return (people || []).filter((p) => {
            if (q && !(p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q))) return false
            if (filter === "todo") return p.decision === null
            if (filter === "diff") return !bothMatch(p)
            if (filter === "fix") return p.decision === "fix"
            if (filter === "approve") return p.decision === "approve"
            return true
        })
    }

    function peopleList(): HTMLElement {
        const side = el("div", "rv-people glass")
        const tools = el("div", "rv-people-tools")
        const fl = el("label", "rv-mini", "แสดง")
        const sel = el("select")
        sel.id = "rv-filter"
        for (const [v, t] of [["todo", "รอตรวจ"], ["diff", "ผลเทียบไม่ตรง"], ["fix", "ต้องแก้ไข"], ["approve", "อนุมัติแล้ว"], ["all", "ทุกคน"]]) {
            const o = el("option", undefined, t)
            o.value = v
            sel.append(o)
        }
        sel.value = filter
        sel.addEventListener("change", () => { filter = sel.value; render() })
        fl.append(sel)
        const sl = el("label", "rv-mini", "ค้นหา")
        const si = el("input")
        si.type = "search"
        si.id = "rv-search"
        si.value = search
        si.autocomplete = "off"
        si.addEventListener("input", () => { search = si.value; render() })
        sl.append(si)
        tools.append(fl, sl)
        const shown = visiblePeople()
        const count = el("p", "rv-hint", int(shown.length) + " คน")
        count.setAttribute("aria-live", "polite")
        const ul = el("ul", "rv-people-list")
        ul.setAttribute("aria-label", "รายชื่อในรอบนี้")
        for (const p of shown) {
            const li = el("li")
            const b = el("button", "rv-person-btn" + (p.index === selected ? " current" : ""))
            b.type = "button"
            b.id = "rv-p-" + p.index
            if (p.index === selected) b.setAttribute("aria-current", "true")
            const top = el("span", "rv-pname", p.name)
            const sub = el("span", "rv-psub", (p.intern ? "อินเทิร์น" : p.department) + " · " + decisionText(p))
            b.append(top, sub)
            if (!bothMatch(p)) b.append(chip("bad", "ผลเทียบไม่ตรง"))
            b.addEventListener("click", () => { selected = p.index; render(); const t = document.getElementById("rv-person-h"); if (t) t.focus() })
            li.append(b)
            ul.append(li)
        }
        if (!shown.length) ul.append(el("li", "rv-hint", filter === "todo" ? "ตรวจครบทุกคนแล้ว" : "ไม่มีรายชื่อ"))
        side.append(tools, count, ul)
        return side
    }

    function personPanel(s: State, r: Round): HTMLElement {
        const panel = el("section", "rv-person glass")
        const p = (people || []).find((x) => x.index === selected)
        if (!p) { panel.append(el("p", "rv-hint", "เลือกรายชื่อทางซ้าย")); return panel }
        const h = el("h3", "rv-person-h", p.name)
        h.id = "rv-person-h"
        h.tabIndex = -1
        panel.setAttribute("aria-labelledby", h.id)
        panel.append(h, el("p", "rv-hint", (p.intern ? "อินเทิร์น" : "staff · " + p.department) + (p.sk03Row ? " · SK03 แถว " + p.sk03Row : "") + " · " + decisionText(p)))
        if (p.why) panel.append(el("p", "rv-why", "ตรวจอีกครั้งเพราะ: " + (WHY_TEXT[p.why] || p.why)))
        if (p.prev && (p.prev.remark || p.prev.reply)) {
            const prev = el("div", "rv-prev")
            if (p.prev.remark) prev.append(el("p", undefined, "รอบก่อน ผู้ตรวจสอบ: " + p.prev.remark))
            prev.append(el("p", undefined, "คำตอบผู้จัดทำ: " + (p.prev.reply || "ไม่มีคำตอบ")))
            panel.append(prev)
        }
        const t = el("table", "rv-compare")
        const cap = el("caption", "sr-only", "ผลเทียบอัตโนมัติ")
        const head = el("tr")
        for (const x of ["เรื่อง", "SK03", "เทียบกับ", "ผล"]) { const th = el("th", undefined, x); th.scope = "col"; head.append(th) }
        const row = (label: string, a: string, b: string, check: string): HTMLElement => {
            const tr = el("tr")
            const th = el("th", undefined, label)
            th.scope = "row"
            const res = el("td")
            res.append(chip(check === "match" ? "ok" : "bad", CHECK_TEXT[check]))
            tr.append(th, el("td", undefined, a), el("td", undefined, b), res)
            return tr
        }
        const thead = el("thead"), tbody = el("tbody")
        thead.append(head)
        tbody.append(
            row("เทียบคะแนน", num(p.score) + " (คอลัมน์ K)", p.stated === null ? "ไม่พบในชีตของแพทย์ (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")"
                : num(p.stated) + " ช่อง " + p.statedCell + " ชีต \"" + (p.sheet || "") + "\" (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")", p.scoreCheck),
            row("เทียบเงิน", num(p.pay) + " (คอลัมน์ N)", p.deptPay === null ? "ไม่พบในชีตกลุ่มงาน" : num(p.deptPay) + " ชีตกลุ่มงาน แถว " + p.deptRow + " (ตามสัดส่วนวิชาชีพ)", p.moneyCheck),
        )
        t.append(cap, thead, tbody)
        panel.append(t)
        panel.append(sheetBox(s, r, p))
        panel.append(decideBox(p))
        const nav = el("div", "rv-actions")
        const list = visiblePeople()
        const i = list.findIndex((x) => x.index === p.index)
        const go = (d: number, text: string): HTMLButtonElement => {
            const b = el("button", "btn-ghost", text)
            b.type = "button"
            const target = list[i + d]
            b.disabled = !target
            b.addEventListener("click", () => { if (target) { selected = target.index; render(); const hh = document.getElementById("rv-person-h"); if (hh) hh.focus() } })
            return b
        }
        nav.append(go(-1, "← คนก่อนหน้า"), go(1, "คนถัดไป →"))
        panel.append(nav)
        return panel
    }

    function cellRC(name: string | null): [number, number] | null {
        const m = /^([A-Z]+)(\d+)$/.exec(name || "")
        if (!m) return null
        let c = 0
        for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
        return [Number(m[2]) - 1, c - 1]
    }
    const colLetters = (c: number): string => { let s2 = "", n = c + 1; while (n > 0) { const m = (n - 1) % 26; s2 = String.fromCharCode(65 + m) + s2; n = Math.floor((n - 1) / 26) } return s2 }

    function sheetBox(s: State, r: Round, p: Person): HTMLElement {
        const box = el("div", "rv-sheet-box")
        const key = r.round_no + ":" + p.index
        const d = details.get(key)
        if (!d) {
            box.append(el("p", "rv-hint", "กำลังโหลดชีตของแพทย์…"))
            void api<Detail>("/dashboard/api/review/" + s.month + "/person/" + r.round_no + "/" + p.index)
                .then((x) => { details.set(key, x); if (selected === p.index) render() })
                .catch((e) => say(e.message))
            return box
        }
        if (d.deptRow) {
            const dt = el("table", "rv-dept")
            const cap = el("caption", undefined, "แถวในชีตกลุ่มงาน " + p.department)
            const hr = el("tr")
            for (const x of ["ที่", "ชื่อ", "ตำแหน่ง", "ประเภท", "งานบริหาร (E)", "ตามสัดส่วนวิชาชีพ (F)", "รวม (G)"]) { const th = el("th", undefined, x); th.scope = "col"; hr.append(th) }
            const tr = el("tr")
            d.deptRow.slice(0, 7).forEach((v, k) => tr.append(el("td", k >= 4 ? "num" : "", typeof v === "number" ? num(v) : String(v === null ? "" : v))))
            const th2 = el("thead"); th2.append(hr)
            const tb = el("tbody"); tb.append(tr)
            dt.append(cap, th2, tb)
            box.append(dt)
        }
        const g = d.grid
        if (!g) { box.append(el("p", "rv-hint", "ไม่มีชีตของแพทย์ให้ดู")); return box }
        const hit = cellRC(p.statedCell)
        const region = el("div", "rv-sheet")
        region.setAttribute("role", "region")
        region.tabIndex = 0
        const capId = "rv-sheet-cap"
        region.setAttribute("aria-labelledby", capId)
        const cap = el("p", "rv-sheet-cap", "ชีต \"" + (p.sheet || g.sheet) + "\" ในไฟล์รวม (ค่าที่บันทึกไว้ในไฟล์ของแพทย์)" + (p.statedCell ? " · ช่องที่ใช้เป็นคะแนน: " + p.statedCell : ""))
        cap.id = capId
        const tbl = el("table", "rv-xl")
        const map = new Map<string, string | number>()
        for (const [rr, cc, v] of g.cells) map.set(rr + ":" + cc, v)
        const hd = el("tr")
        hd.append(el("th", "corner"))
        for (let c = 0; c < g.cols; c++) { const th = el("th", undefined, colLetters(c)); th.scope = "col"; hd.append(th) }
        const thead = el("thead"); thead.append(hd)
        const tbody = el("tbody")
        for (let rr = 0; rr < g.rows; rr++) {
            const tr = el("tr")
            const th = el("th", undefined, String(rr + 1)); th.scope = "row"
            tr.append(th)
            for (let c = 0; c < g.cols; c++) {
                const v = map.get(rr + ":" + c)
                const td = el("td", typeof v === "number" ? "num" : "", v === undefined ? "" : typeof v === "number" ? num(v) : String(v))
                if (hit && hit[0] === rr && hit[1] === c) { td.className += " hit"; td.setAttribute("aria-label", "คะแนนที่ใช้ " + num(Number(v))) }
                tr.append(td)
            }
            tbody.append(tr)
        }
        tbl.append(thead, tbody)
        region.append(tbl)
        box.append(cap, region)
        // Bring the cell used as the score into view (it is often far right / bottom).
        requestAnimationFrame(() => {
            const h = tbl.querySelector("td.hit") as HTMLElement | null
            if (!h) return
            region.scrollTop = Math.max(0, h.offsetTop - region.clientHeight / 2)
            region.scrollLeft = Math.max(0, h.offsetLeft - region.clientWidth / 2)
        })
        return box
    }

    function decideBox(p: Person): HTMLElement {
        const box = el("div", "rv-decide")
        const ok = bothMatch(p)
        const approve = el("button", "btn-primary", p.decision === "approve" ? "✓ อนุมัติแล้ว" : "อนุมัติ")
        approve.type = "button"
        approve.id = "rv-approve"
        const why = el("p", "rv-hint")
        why.id = "rv-approve-why"
        if (!ok) {
            approve.setAttribute("aria-disabled", "true")
            approve.setAttribute("aria-describedby", why.id)
            why.textContent = "อนุมัติได้เมื่อเทียบคะแนนและเทียบเงินตรงกันทั้งคู่ คนนี้ให้เลือก ต้องแก้ไข พร้อมหมายเหตุ"
        }
        approve.addEventListener("click", () => {
            if (!ok) { say(why.textContent || ""); return }
            void decide(p, "approve", "")
        })
        const fixLabel = el("label", undefined, "หมายเหตุ (ต้องมีเมื่อเลือก ต้องแก้ไข)")
        fixLabel.htmlFor = "rv-remark"
        const ta = el("textarea")
        ta.id = "rv-remark"
        ta.rows = 2
        ta.maxLength = 1000
        ta.value = p.decision === "fix" ? p.remark : ""
        const err = el("p", "rv-err hidden")
        err.id = "rv-remark-e"
        ta.setAttribute("aria-describedby", err.id)
        const fix = el("button", "btn-ghost", p.decision === "fix" ? "บันทึกหมายเหตุใหม่" : "ต้องแก้ไข")
        fix.type = "button"
        fix.id = "rv-fix"
        fix.addEventListener("click", () => {
            if (!ta.value.trim()) {
                err.textContent = "พิมพ์หมายเหตุว่าต้องแก้อะไร"
                err.classList.remove("hidden")
                ta.setAttribute("aria-invalid", "true")
                ta.focus()
                return
            }
            void decide(p, "fix", ta.value)
        })
        const row = el("div", "rv-actions")
        row.append(approve, fix)
        if (p.decision) {
            const undo = el("button", "btn-ghost", "ยกเลิกผล")
            undo.type = "button"
            undo.id = "rv-undo"
            undo.addEventListener("click", () => { void decide(p, null, "") })
            row.append(undo)
        }
        box.append(fixLabel, ta, err, row, why)
        return box
    }

    async function decide(p: Person, decision: "approve" | "fix" | null, remark: string): Promise<void> {
        busy = true
        try {
            await post("/dashboard/api/review/" + month + "/decisions/" + p.index, { decision, remark }, "PUT")
            p.decision = decision
            p.remark = decision === "fix" ? remark.trim() : ""
            p.carried = false
            say(p.name + ": " + decisionText(p))
            // Straight on to the next person still to check.
            if (decision) {
                const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index)
                if (next) selected = next.index
            }
        } catch (e) {
            say(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ")
        } finally {
            busy = false
        }
        await loadState(false)
        const hh = document.getElementById("rv-person-h")
        if (hh) hh.focus()
    }

    // ปัญหาอื่น ๆ (both sides) ──────────────────────────────────────────────
    function issuesCard(s: State, side: "auditor" | "auditee"): HTMLElement {
        const kids: Node[] = []
        const r = liveRound(s)
        const canAct = side === "auditor" ? !!r && r.status === "submitted" : !!r && r.status === "returned"
        if (issuesKey !== s.month) { issuesKey = s.month; void loadIssues(s).catch((e) => say(e.message)) }
        const list = issues || []
        if (!list.length) kids.push(el("p", "rv-hint", side === "auditor" ? "ยังไม่มี ใช้สำหรับเรื่องที่ไม่ใช่ของแพทย์คนใดคนหนึ่ง เช่น ลายเซ็น หรือยอดรวมของกลุ่มงาน" : "ไม่มี"))
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
                const ta = el("textarea")
                ta.id = "rv-reply-" + i.id
                ta.rows = 1
                ta.maxLength = 2000
                lab.htmlFor = ta.id
                const send = el("button", "btn-ghost", "ตอบ")
                send.type = "submit"
                form.append(lab, ta, send)
                form.addEventListener("submit", (ev) => {
                    ev.preventDefault()
                    if (!ta.value.trim()) { ta.focus(); return }
                    void issueCall("/issues/" + i.id + "/replies", { role: side, body: ta.value }, "ส่งคำตอบแล้ว")
                })
                item.append(form)
                if (side === "auditor") {
                    const t = el("button", "btn-ghost", i.status === "open" ? "ปิดเรื่องนี้" : "เปิดอีกครั้ง")
                    t.type = "button"
                    t.addEventListener("click", () => { void issueCall("/issues/" + i.id + "/status", { open: i.status !== "open" }, i.status === "open" ? "ปิดแล้ว" : "เปิดอีกครั้งแล้ว") })
                    item.append(t)
                }
            }
            kids.push(item)
        }
        if (side === "auditor" && canAct) {
            const form = el("form", "rv-reply")
            const lab = el("label", undefined, "แจ้งปัญหาอื่น")
            const ta = el("textarea")
            ta.id = "rv-new-issue"
            ta.rows = 2
            ta.maxLength = 2000
            lab.htmlFor = ta.id
            const add = el("button", "btn-ghost", "เพิ่มปัญหา")
            add.type = "submit"
            form.append(lab, ta, add)
            form.addEventListener("submit", (ev) => {
                ev.preventDefault()
                if (!ta.value.trim()) { ta.focus(); return }
                void issueCall("/issues", { body: ta.value }, "เพิ่มปัญหาแล้ว")
            })
            kids.push(form)
        }
        return card("ปัญหาอื่น ๆ", kids, "rv-h-issues")
    }

    async function issueCall(path: string, json: unknown, done: string): Promise<void> {
        try {
            await post("/dashboard/api/review/" + month + path, json)
            say(done)
        } catch (e) {
            say(e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ")
        }
        issuesKey = ""
        await loadState(false)
    }

    // ผู้จัดทำ: what the auditor sent back, with a reply to each ─────────────
    function answersCard(s: State, r: Round): HTMLElement {
        ensure(s, r)
        const kids: Node[] = []
        const fixes = (people || []).filter((p) => p.decision === "fix")
        if (!people) kids.push(el("p", "rv-loading", "กำลังโหลด…"))
        else if (!fixes.length) kids.push(el("p", "rv-hint", "ไม่มีรายชื่อที่ต้องแก้ ดูปัญหาอื่น ๆ ด้านล่าง"))
        for (const p of fixes) {
            const item = el("article", "rv-issue")
            const hid = "rv-ans-" + p.index
            const h = el("h4", undefined, p.name + " · " + (p.intern ? "อินเทิร์น" : p.department))
            h.id = hid
            item.setAttribute("aria-labelledby", hid)
            item.append(h, el("p", undefined, "ผู้ตรวจสอบ: " + p.remark))
            const form = el("form", "rv-reply")
            const lab = el("label", undefined, "คำตอบของผู้จัดทำ (ไม่บังคับ)")
            const ta = el("textarea")
            ta.id = "rv-answer-" + p.index
            ta.rows = 1
            ta.maxLength = 1000
            ta.value = p.reply
            lab.htmlFor = ta.id
            const save = el("button", "btn-ghost", "บันทึกคำตอบ")
            save.type = "submit"
            form.append(lab, ta, save)
            form.addEventListener("submit", (ev) => {
                ev.preventDefault()
                void (async () => {
                    try {
                        await post("/dashboard/api/review/" + month + "/replies/" + p.index, { reply: ta.value }, "PUT")
                        p.reply = ta.value.trim()
                        say("บันทึกคำตอบแล้ว ส่งไปกับรอบถัดไป")
                    } catch (e) { say(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ") }
                })()
            })
            item.append(form)
            kids.push(item)
        }
        kids.push(el("p", "rv-hint", "แก้ในแอป (แท็บรายชื่อ หรือให้แพทย์ส่งไฟล์ใหม่) แล้วสร้างไฟล์ใหม่ในข้อ 2 ดาวน์โหลด และส่งรอบที่ " + (r.round_no + 1) +
            " ในข้อ 3 รอบถัดไปผู้ตรวจสอบจะตรวจคนที่ต้องแก้ไข และคนที่คะแนน กลุ่มงาน หรือชื่อของตัวเองเปลี่ยน หรือผลเทียบไม่ตรงกัน"))
        const wrap = el("div", "rv-stack")
        wrap.append(card("สิ่งที่ผู้ตรวจสอบให้แก้ (รอบที่ " + r.round_no + ")", kids, "rv-h-ans"), issuesCard(s, "auditee"))
        return wrap
    }
})()
