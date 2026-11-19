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

    // Users' LINE names shown as the Thai names Pong set (Pong, 2026-11-18;
    // a copy of lib/staff-names.ts). New saves already carry the Thai name;
    // this covers rows saved before.
    const STAFF_NAMES = new Map<string, string>([["pongsit", "ปองสิทธิ์"], ["dada", "กานดา"]])
    const staffName = (name: unknown): string => {
        const s = String(name == null ? "" : name).trim()
        return STAFF_NAMES.get(s.toLowerCase()) || s
    }

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
        // The email's test mode. Null or missing: the switch's SQL is not
        // installed (no switch).
        mail?: MailMode | null
        // The month's เอกสารจัดสรร (ภาพรวม's ข้อมูล button): uploaded, and
        // how many roster doctors still have no 4 digits. Sending waits for
        // it (Pong, 2026-11-18). Null or missing: not known (no reason shown;
        // the server still checks).
        alloc?: { installed: boolean; uploaded: boolean; roster: number; without: number } | null
    }
    interface MailMode {
        test: boolean       // on: every email to testTo only, subject marked [ทดสอบ]
        testTo: string      // the test address (kept while off)
        recipients: number  // how many real addresses get it when off
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
    // The side's main button sits in its own slot under the part that
    // scrolls, so it never covers the figures (render() moves every
    // .rv-dock of sideOut there).
    const dock = document.getElementById("review-dock") as HTMLElement
    const sideScroll = side.parentElement as HTMLElement
    const inSide = (n: Node | null): boolean => !!n && (side.contains(n) || dock.contains(n))
    let sideOut: Node[] = []
    const show = (...nodes: Node[]): void => { side.replaceChildren(); dock.replaceChildren(); body.replaceChildren(...nodes); syncSide() }
    // A reply that arrives while a mouse button is down on the tab waits
    // for the click (2026-11-18): redrawing the button under the pointer
    // between press and release makes the browser drop the click.
    let pressing = false
    let heldRender = false
    let pressT: number | undefined
    function release(): void {
        clearTimeout(pressT)
        if (!pressing) return
        pressing = false
        if (heldRender) render()
    }
    document.addEventListener("pointerdown", (ev) => {
        if (!ev.isPrimary || !(ev.target instanceof Node) || !view.contains(ev.target)) return
        pressing = true
        clearTimeout(pressT)
        pressT = window.setTimeout(release, 3000)
    }, true)
    // After the click: the timer runs once the click has been handled.
    for (const t of ["pointerup", "pointercancel"]) document.addEventListener(t, () => { if (pressing) setTimeout(release, 0) }, true)
    // The redraw for a reply: now, or after the press.
    function renderSoon(): void {
        if (pressing) { heldRender = true; return }
        render()
    }
    // A filter pressed shows as pressed at once; the list it picks (up to
    // 230 rows) is drawn after that paint, so the press is never left
    // without an answer while the rows are worked out (2026-11-18).
    let filterSeq = 0
    function pressFirst(b: HTMLElement, go: () => void): void {
        const g = b.parentElement
        if (g) for (const x of Array.from(g.children)) if (x instanceof HTMLElement && x.hasAttribute("aria-pressed")) x.setAttribute("aria-pressed", String(x === b))
        const seq = ++filterSeq
        requestAnimationFrame(() => setTimeout(() => { if (seq === filterSeq) go() }, 0))
    }
    // Layout reads (where the bars stick, scrolling the panel into place)
    // wait for the next frame, so a click's own work ends sooner and the
    // browser lays the page out once (2026-11-18).
    let frameWork: number | undefined
    let wantSpot = false
    // A note to scroll into the person panel's view once it is drawn.
    let revealId = ""
    function afterFrame(spot = false): void {
        if (spot) wantSpot = true
        if (frameWork !== undefined) return
        frameWork = requestAnimationFrame(() => {
            frameWork = undefined
            syncStick()
            if (wantSpot) { wantSpot = false; toWorkingSpot() }
            const n = revealId ? document.getElementById(revealId) : null
            if (n) { revealId = ""; inPanelView(n) }
            else if (boxFor && boxFor === selected) {
                const box = body.querySelector<HTMLElement>(".rv-person .rv-remark-box")
                if (box) inPanelView(box)
            }
        })
    }
    // The person whose remark box was opened with them: kept above the
    // decide row while their detail arrives and moves things, until the
    // auditor scrolls or presses in the panel themselves.
    let boxFor = ""
    const handsOn = (ev: Event): void => { if (ev.target instanceof Element && ev.target.closest(".rv-person")) boxFor = "" }
    for (const t of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener(t, handsOn, { capture: true, passive: true })
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
    // Writes only what differs: an unchanged attribute or text costs the
    // browser nothing to draw again.
    function setAttr(e: Element, name: string, v: string | null): void {
        if (v === null) { if (e.hasAttribute(name)) e.removeAttribute(name) } else if (e.getAttribute(name) !== v) e.setAttribute(name, v)
    }
    function setText(e: Node, t: string): void { if (e.textContent !== t) e.textContent = t }
    function setHidden(e: HTMLElement, h: boolean): void { if (e.hidden !== h) e.hidden = h }
    // Puts exactly these nodes in parent, in this order, moving only what is
    // out of place (2026-11-18, the tab's lag): a part kept from the last
    // redraw (the names, the auditee's table) stays where it is, so it is
    // not laid out again and keeps its scroll, focus and any press on it.
    function patchChildren(parent: Node, nodes: Node[]): void {
        let ref: ChildNode | null = parent.firstChild
        for (const n of nodes) {
            if (n === ref) { ref = ref.nextSibling; continue }
            parent.insertBefore(n, ref)
        }
        while (ref) { const nx: ChildNode | null = ref.nextSibling; parent.removeChild(ref); ref = nx }
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
    // One formatter each, made once (2026-11-18, the tab's lag): each
    // toLocaleString call builds a new one, and a 230-row table made
    // hundreds per redraw. The words they write are the same.
    const DATE_TH = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    const NUM_TH2 = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const NUM_TH = new Intl.NumberFormat("th-TH")
    const NUM_EN2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const when = (iso: string | null | undefined): string => {
        if (!iso) return ""
        const d = new Date(iso)
        if (isNaN(d.getTime())) return ""
        return DATE_TH.format(d) + " น."
    }
    const baht = (n: number | null | undefined): string =>
        n === null || n === undefined ? "—" : NUM_TH2.format(Number(n))
    const int = (n: number): string => NUM_TH.format(Number(n || 0))
    // Latin words inside Thai text (SK03, PDF, per P4P) read in English.
    const en = (t: string): HTMLElement => { const x = el("span", undefined, t); x.lang = "en"; return x }
    // Roving focus in a group of controls (months, the side switch, the
    // names): the arrows move the focus by step, Home / End to the ends; the
    // one focused becomes the group's one tab stop. Returns it, or null.
    function rove(items: HTMLElement[], ev: KeyboardEvent, steps: Record<string, number>): HTMLElement | null {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return null
        const i = items.indexOf(ev.target as HTMLElement)
        if (i < 0) return null
        const j = ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1
            : steps[ev.key] !== undefined ? Math.max(0, Math.min(items.length - 1, i + steps[ev.key])) : -1
        if (j < 0) return null
        ev.preventDefault()
        for (const x of items) x.tabIndex = -1
        items[j].tabIndex = 0
        items[j].focus()
        return items[j]
    }
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
    const notes = new Map<string, { kind: "ok" | "err"; text: string; scope?: string; failSeq?: number; fail?: { m: string; text: string } }>()
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
        else p.textContent = n.text
        return p
    }
    // One request at a time per control: a second click while the first runs
    // does nothing. The button shows as unavailable (aria-disabled, so it
    // keeps focus) until the request ends; a re-render draws it the same way.
    const inflight = new Set<string>()
    const flightKey = (s: State, spot: string): string => s.month + "|" + spot
    const flying = (s: State, spot: string): boolean => inflight.has(flightKey(s, spot))
    // A step on its way: the button is off and, when it is the one pressed,
    // shows a spinner inside (Pong, 2026-11-12; the CSS draws it).
    function markBusy(b: HTMLElement, spin = true): void {
        b.setAttribute("aria-disabled", "true")
        if (spin) b.setAttribute("aria-busy", "true")
    }
    // Which button started each step, so a redraw spins that one only.
    const pressedFor = new Map<string, string>()
    function begin(s: State, spot: string, btn?: HTMLElement | null): boolean {
        if (flying(s, spot)) return false
        inflight.add(flightKey(s, spot))
        if (btn && btn.id) pressedFor.set(flightKey(s, spot), btn.id)
        if (s.month === month) {
            for (const k of [spot, "top"]) { notes.delete(k); const n = document.getElementById(noteId(k)); if (n) n.remove() }
        }
        if (btn) markBusy(btn)
        return true
    }
    // A step's follow-up loading: its button spins, the notes stay.
    const holdBusy = (s: State, spot: string): void => { inflight.add(flightKey(s, spot)) }
    const end = (s: State, spot: string): void => {
        inflight.delete(flightKey(s, spot)); pressedFor.delete(flightKey(s, spot)); dirty = true
        for (const f of idleWaiters.splice(0)) f()
    }
    // ผู้จัดทำ's score edits and answers still being saved for a month: the
    // send waits for them, so a round never goes without one (2026-11-18).
    const idleWaiters: Array<() => void> = []
    const sideSaving = (m: string): boolean => Array.from(inflight).some((k) => k.startsWith(m + "|score-") || k.startsWith(m + "|answer-"))
    const whenSideSaved = (m: string): Promise<void> => new Promise((res) => {
        const check = (): void => { if (sideSaving(m)) idleWaiters.push(check); else res() }
        check()
    })

    // A visible failure with a way to try again (role=alert is on shout()).
    function failBox(text: string, id: string, retry: () => void): HTMLElement {
        const box = el("div", "rv-fail")
        const b = el("button", "btn-ghost", "ลองอีกครั้ง")
        b.type = "button"
        b.id = id
        // It spins until the try ends; what comes next replaces the box.
        b.addEventListener("click", () => { if (b.getAttribute("aria-busy") === "true") return; markBusy(b); retry() })
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
        again.addEventListener("click", () => {
            if (again.getAttribute("aria-busy") === "true") return
            markBusy(again)
            void open(true)
        })
        if (role === "auditor") return card("ยังไม่มีเดือนที่พร้อมตรวจ", [el("p", undefined, "เมื่อผู้จัดทำส่งแล้วจะเปิดได้"), again])
        return card("ยังไม่มีเดือนที่แพทย์ส่งครบ", [el("p", undefined, "เปิดเดือนได้เมื่อแพทย์ส่งครบทุกคน"), again])
    }
    // One button per month, in time order; the status under it depends on
    // the side shown (redrawn on a role switch).
    function drawTabs(): void {
        // The switch shows the side the tabs are drawn for. Without this, a
        // side remembered from the last visit (auditor) with no month to
        // open never reached render(), and the switch kept its default
        // ผู้จัดทำ while every month showed locked (Pong, 2026-11-17).
        syncRole()
        const a = document.activeElement
        const had = a instanceof HTMLElement && monthBox.contains(a) ? a.id : ""
        const keepTop = monthBox.scrollTop
        monthBox.replaceChildren(...monthRows.map((m) => {
            const b = el("button", "rv-mtab")
            b.type = "button"
            b.id = "rv-m-" + m.month
            b.setAttribute("role", "radio")
            b.setAttribute("aria-checked", String(m.month === month))
            b.tabIndex = -1
            const ms = monthStatus(m)
            const t = el("span", "rv-mtab-s rv-ms-" + ms.kind, ms.text)
            if (ms.sr) t.setAttribute("aria-hidden", "true")
            b.append(el("span", "rv-mtab-m", shortMonth(m.month)), t)
            if (ms.sr) b.append(el("span", "sr-only", " " + ms.sr))
            const off = locked(m)
            if (off) b.setAttribute("aria-disabled", "true")
            if (m.month === loadingFor || m.month === lookingAt) b.setAttribute("aria-busy", "true")
            b.addEventListener("click", () => {
                if (b.getAttribute("aria-busy") === "true") return
                if (!off) { pickMonth(m.month); return }
                // The list may be old: look again before saying no. The tab
                // spins meanwhile.
                lookingAt = m.month
                b.setAttribute("aria-busy", "true")
                void refreshMonthRows().catch(() => undefined).then(() => {
                    if (lookingAt === m.month) lookingAt = ""
                    syncBusy()
                    const now = monthRows.find((x) => x.month === m.month)
                    if (now && !locked(now)) pickMonth(m.month)
                    else say(shortMonth(m.month) + (role === "auditor" ? " ยังไม่พร้อมตรวจ" : " ยังเปิดไม่ได้ แพทย์ยังส่งไม่ครบ"))
                })
            })
            return b
        }))
        // One tab stop: the month focused, else the one open, else the first.
        const on = monthBox.querySelector<HTMLElement>('[aria-checked="true"]')
        const stop = (had && document.getElementById(had)) || on || monthBox.querySelector<HTMLElement>(".rv-mtab")
        if (stop) stop.tabIndex = 0
        monthBox.scrollTop = keepTop
        // A month newly open is scrolled into the months box (the box only).
        if (on && month !== tabsShown) {
            const top = on.offsetTop, bottom = top + on.offsetHeight
            if (top < monthBox.scrollTop) monthBox.scrollTop = top
            else if (bottom > monthBox.scrollTop + monthBox.clientHeight) monthBox.scrollTop = bottom - monthBox.clientHeight
        }
        tabsShown = month
        if (had) { const f = document.getElementById(had); if (f) f.focus() }
    }
    let tabsShown = ""
    // The arrows move between months (up and down by a row of two); Enter
    // or Space opens one, so arrowing past months loads none.
    monthBox.addEventListener("keydown", (ev) => {
        rove(Array.from(monthBox.querySelectorAll<HTMLElement>(".rv-mtab")), ev, { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 })
    })
    function pickMonth(m: string): void {
        if (!m || m === month) return
        month = m
        resetMonth()
        drawTabs()
        // A month seen before shows at once, as it was, and is looked at
        // again behind it (2026-11-18: a blank loading line for 2-3 s).
        if (st) { render(); void loadPicked(true); return }
        show(el("p", "rv-loading", "กำลังโหลดเดือน " + monthName(month) + "…"))
        void loadPicked()
    }
    // A month being opened: its tab (and the side switch, when the switch
    // opened it) spins until the month is on screen or the load fails
    // (Pong, 2026-11-17: every button shows it is loading).
    let loadingFor = ""
    let lookingAt = ""
    let roleLoad = false
    let pickSeq = 0
    // Lists on their way (names, issues), so the side switch that asked for
    // them can spin.
    let listsLoading = 0
    let roleLists = false
    // quiet: the month is on screen already (kept from before): no spin,
    // and no redraw when nothing changed.
    async function loadPicked(quiet = false): Promise<void> {
        // Only the newest load ends the spin: an older one of the same month
        // can come back first.
        const tok = ++pickSeq
        if (!quiet) loadingFor = month
        syncBusy()
        prefetchLists()
        try {
            await loadState(true, false, quiet)
        } catch (e) {
            loadFailed(e)
        } finally {
            if (tok === pickSeq) { loadingFor = ""; roleLoad = false; syncBusy() }
        }
    }
    // Asked for with the month's state, not after it (2026-11-18): the
    // names and the issues of the round the months list says is open, when
    // the side shown lists them (the auditor's round to check, the
    // auditee's round sent back).
    function prefetchLists(): void {
        const m = monthRows.find((x) => x.month === month)
        const rr = m ? m.round : null
        if (!rr || !(role === "auditor" ? rr.status === "submitted" : rr.status === "returned")) return
        const s0 = { month } as State
        if (peopleKey !== month + ":" + rr.round_no && !peopleErr) void loadPeople(s0, { round_no: rr.round_no } as Round)
        if (issuesKey !== month && !issuesErr) void loadIssues(s0)
    }
    function syncBusy(): void {
        for (const m of monthRows) {
            const b = document.getElementById("rv-m-" + m.month)
            if (!b) continue
            if (m.month === loadingFor || m.month === lookingAt) b.setAttribute("aria-busy", "true")
            else b.removeAttribute("aria-busy")
        }
        syncRole()
    }
    // Everything on screen belongs to one month: a switch drops the old
    // month's state, lists, drafts and notes, and any reply still on its way
    // for it (the sequence numbers no longer match).
    function resetMonth(): void {
        // The month being left is kept for a switch back.
        if (st && st.month && st.month !== month && !loadError) {
            // A list still on its way is asked for again on the way back.
            monthKeep.set(st.month, { st, stJson, people, peopleKey: people && !peopleErr ? peopleKey : "", issues, issuesKey: issues && !issuesErr ? issuesKey : "",
                rows, rowsKey: rows && !rowsErr ? rowsKey : "", details: new Map(details), selected, lastRoundKey, pl, lc, moreBox })
        }
        st = null; stJson = ""; loadError = ""; loadSeq++
        clearTimeout(poll); poll = undefined; pollFails = 0
        people = null; peopleKey = ""; peopleErr = ""; peopleSeq++
        issues = null; issuesKey = ""; issuesErr = ""; issuesSeq++
        details.clear(); detailErrs.clear(); detailLoading.clear(); detailSeq++
        selected = ""; lastRoundKey = ""
        rows = null; rowsKey = ""; rowsErr = ""; rowsSeq++; editing = ""; moreOpen = false
        // A failed decision save's note stays through the switch (the row
        // it put back is in the month kept), naming its month when it is
        // not the one shown.
        const failTop = notes.get("top")
        drafts.clear(); fieldErrs.clear(); notes.clear(); draftScope = ""; remarkOpen.clear(); kept.clear()
        if (failTop && failTop.fail && failTop.failSeq !== undefined) {
            const f = failTop.fail
            notes.set("top", { kind: "err", text: f.m === month ? f.text : "เดือน " + monthName(f.m) + ": " + f.text, failSeq: failTop.failSeq, fail: f })
        }
        pl = null; lc = null; moreBox = null
        const k = month ? monthKeep.get(month) : undefined
        if (k) {
            monthKeep.delete(month)
            st = k.st; stJson = k.stJson
            people = k.people; peopleKey = k.peopleKey; issues = k.issues; issuesKey = k.issuesKey
            rows = k.rows; rowsKey = k.rowsKey
            for (const [a, b] of k.details) details.set(a, b)
            selected = k.selected; lastRoundKey = k.lastRoundKey
            pl = k.pl; lc = k.lc; moreBox = k.moreBox
            // Saves still on their way for it are shown again.
            if (people) reapply(month, people, 0)
        }
    }
    // What a month showed, kept for a switch back to it (2026-11-18).
    interface Kept {
        st: State; stJson: string
        people: Person[] | null; peopleKey: string; issues: Issue[] | null; issuesKey: string
        rows: Row[] | null; rowsKey: string; details: Map<string, Detail>; selected: string; lastRoundKey: string
        pl: PList | null; lc: LCard | null; moreBox: { sec: HTMLElement; t: HTMLButtonElement; inner: HTMLElement } | null
    }
    const monthKeep = new Map<string, Kept>()
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
    async function loadState(logView: boolean, fromPoll = false, quiet = false): Promise<void> {
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
        // A load that started before the switch was flipped brings the old mode.
        if (s.mail !== undefined && !mailBusy && seq > mailSeq) mail = s.mail
        if (!((fromPoll || quiet) && same)) { freshState = true; renderSoon() }
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
        show(failBox("โหลดข้อมูลเดือน " + monthName(month) + " ไม่สำเร็จ: " + msg, "rv-retry-load", () => { void loadPicked() }))
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
        const hadFocus = body.contains(document.activeElement) || inSide(document.activeElement)
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

    // A dashboard user who is not the owner has one side only, with no
    // switch: ผู้จัดทำ (Pong, 2026-11-12) or ผู้ตรวจสอบ (2026-11-18); the
    // other side's routes answer 404 for them. app.js sets this from the
    // session before the tab is first drawn.
    const auditeeOnly = (): boolean => document.body.dataset.reviewSide === "auditee"
    const auditorOnly = (): boolean => document.body.dataset.reviewSide === "auditor"
    // Anyone but the owner (the owner has no side set): no ข้อมูล button on
    // ภาพรวม since 2026-11-19, so the owner types the budget and the
    // เอกสารจัดสรร for them.
    const notOwner = (): boolean => !!document.body.dataset.reviewSide
    const oneSide = (): boolean => auditeeOnly() || auditorOnly()
    function syncRole(): void {
        for (const b of roleBtns) {
            const on = b.dataset.role === role
            b.setAttribute("aria-selected", String(on))
            b.tabIndex = on ? 0 : -1
            if (on && ((roleLoad && loadingFor) || (roleLists && listsLoading > 0))) b.setAttribute("aria-busy", "true")
            else b.removeAttribute("aria-busy")
        }
    }
    // fromButton: a ลองอีกครั้ง / ดูอีกครั้ง button is spinning, so the
    // screen stays until the answer comes.
    async function open(fromButton = false): Promise<void> {
        if (oneSide()) {
            role = auditorOnly() ? "auditor" : "auditee"
            const sw = document.getElementById("review-role")
            if (sw) sw.classList.add("hidden")
        }
        // Back on the tab with its month still here (2026-11-18): it stays
        // on screen, and the months and the month are looked at again
        // together instead of a blank loading line and one after the other.
        const warm = !fromButton && !!st && st.month === month && !loadError && !!body.firstChild
        const asked = month
        const again = warm ? loadState(true, false, true).then(() => null, (e: unknown) => e) : null
        if (!fromButton && !warm) loadingLine("กำลังโหลด…")
        try {
            if (!(await loadMonths(true))) {
                // Still no month: the loading line, or the spinning button
                // that asked, gives way to the card (with a fresh button).
                if (warm || body.querySelector('.rv-loading, #rv-months-again[aria-busy="true"], #rv-retry-open[aria-busy="true"]')) show(noMonthCard())
                return
            }
        } catch (e) {
            if (signedOut(e)) return
            const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ")
            shout(msg)
            show(failBox("โหลดแท็บตรวจสอบไม่สำเร็จ: " + msg, "rv-retry-open", () => { void open(true) }))
            return
        }
        if (again && month === asked) {
            const e = await again
            if (e && month === asked) loadFailed(e)
            return
        }
        // Another month now: kept from before, it shows at once.
        if (st && st.month === month) { render(); await loadPicked(true); return }
        if (warm) loadingLine("กำลังโหลด…")
        await loadPicked()
    }
    window.addEventListener("dashboard:review", () => { void open() })
    for (const b of roleBtns) {
        b.addEventListener("click", () => {
            if (oneSide() || b.getAttribute("aria-busy") === "true") return
            role = b.dataset.role === "auditor" ? "auditor" : "auditee"
            try { localStorage.setItem(ROLE_KEY, role) } catch (e) { /* ignore */ }
            for (const x of roleBtns) { const on = x.dataset.role === role; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1 }
            // Neither side stays on a month it cannot open (each side locks
            // its own months), and a side gets a month back after the
            // other side had none to show.
            const shown = monthRows.find((m) => m.month === month)
            if (monthRows.length && (!shown || locked(shown))) {
                const m = defaultMonth()
                if (m) { roleLoad = true; pickMonth(m) }
                else { month = ""; resetMonth(); drawTabs(); show(noMonthCard()) }
            } else {
                // Same month, other side: it spins while the lists that side
                // needs (names, issues) load.
                roleLists = true
                drawTabs()
                render()
                if (!listsLoading) roleLists = false
                syncRole()
            }
            say("มุมมอง" + (role === "auditor" ? "ผู้ตรวจสอบ" : "ผู้จัดทำ"))
        })
    }

    // The side switch is a tab list: the arrows move between the two sides,
    // Enter or Space switches.
    const roleBox = document.getElementById("review-role")
    if (roleBox) roleBox.addEventListener("keydown", (ev) => { rove(roleBtns, ev, { ArrowLeft: -1, ArrowRight: 1 }) })

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
        t.append(el("span", "rv-tag", tag), el("strong", undefined, title))
        if (sub) t.append(el("span", "rv-sub", sub))
        return t
    }

    function renderNotInstalled(): void {
        show(card("ยังเปิดใช้แท็บนี้ไม่ได้", [
            el("p", undefined, "ฐานข้อมูลยังไม่มีตารางของแท็บตรวจสอบ หรือยังเป็นรุ่นเก่า แจ้งผู้ดูแลระบบ แล้วรีเฟรชหน้านี้"),
        ]))
    }

    // Redraws #review-body from st, drafts and notes. Every control that can
    // be focused has a stable id, so focus (and the caret in a text field)
    // comes back to the same control; if it is gone, to the heading of the
    // part it was in, never to the page.
    function render(): void {
        heldRender = false
        syncRole()
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
        const inBody = !!a && a !== body && a !== side && a !== dock && (body.contains(a) || inSide(a))
        const focusId = inBody && a ? a.id : ""
        const holder = inBody && a ? a.closest("[aria-labelledby]") : null
        const holderId = holder && (body.contains(holder) || inSide(holder)) ? holder.getAttribute("aria-labelledby") || "" : ""
        let selA: number | null = null, selB: number | null = null
        if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
            try { selA = a.selectionStart; selB = a.selectionEnd } catch (e) { /* not a text field */ }
        }
        const viewTop = view.scrollTop
        const list = body.querySelector(".rv-people-list")
        const listTop = list ? list.scrollTop : 0
        // The person panel is drawn new: the same person keeps its scroll.
        const per = body.querySelector<HTMLElement>(".rv-person")
        const perTop = per ? per.scrollTop : 0
        const perWho = selected
        refreshLists(s)
        const top: Node[] = []
        if (loadError) top.push(failBox(loadError, "rv-retry-load", () => { void reload() }))
        const tn = noteEl("top")
        if (tn) top.push(tn)
        sideOut = []
        chipDrawn = false
        const main = role === "auditee" ? auditee(s) : auditor(s)
        const docked = (n: Node): boolean => n instanceof HTMLElement && n.classList.contains("rv-dock")
        // The parts kept from the last redraw stay in place; the rest is new.
        patchChildren(side, sideOut.filter((n) => !docked(n)))
        patchChildren(dock, sideOut.filter(docked))
        patchChildren(body, [...top, ...main])
        const list2 = body.querySelector(".rv-people-list")
        if (list2 && list2 !== list && listTop) list2.scrollTop = listTop
        const per2 = perTop && selected === perWho ? body.querySelector<HTMLElement>(".rv-person") : null
        if (per2 && per2 !== per) per2.scrollTop = perTop
        if (inBody) {
            const f = focusId ? document.getElementById(focusId) : null
            if (f && document.activeElement !== f) f.focus({ preventScroll: true })
            if (f && document.activeElement === f) {
                if (selA !== null && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) && (f.selectionStart !== selA || f.selectionEnd !== selB)) {
                    try { f.setSelectionRange(selA, selB === null ? selA : selB) } catch (e) { /* not a text field */ }
                }
            } else {
                const h = (holderId && document.getElementById(holderId)) || body.querySelector<HTMLElement>(".rv-turn, .rv-card-h")
                if (h) { if (!h.hasAttribute("tabindex")) h.tabIndex = -1; h.focus({ preventScroll: true }) }
            }
        }
        // Unscrolled (the usual case at Pong's size): nothing to put back,
        // and no layout to force here.
        if (viewTop && view.scrollTop !== viewTop) view.scrollTop = viewTop
        afterFrame()
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
            // Kept like the table in it, so opening it again shows the
            // table built before (2026-11-18).
            if (!moreBox) moreBox = newMoreBox()
            const { sec: more, t, inner } = moreBox
            setText(t, moreOpen ? "ซ่อน" : "แสดง")
            setAttr(t, "aria-expanded", String(moreOpen))
            if (moreOpen) {
                const lc = listCard(s)
                patchChildren(inner, [...buildAlerts(s), lc])
                // Open, a long list shares the window's height with the fixes above.
                more.classList.toggle("rv-fill", lc.classList.contains("rv-fill"))
            } else { patchChildren(inner, []); more.classList.remove("rv-fill") }
            setHidden(inner, !moreOpen)
            out.push(more)
            if (!moreOpen) out.push(...buildAlerts(s).filter((n) => (n as HTMLElement).dataset.blocking === "1"))
        } else {
            out.push(...buildAlerts(s), listCard(s))
        }
        sideOut.push(sendBar(s))
        return out
    }
    let moreOpen = false
    let moreBox: { sec: HTMLElement; t: HTMLButtonElement; inner: HTMLElement } | null = null
    function newMoreBox(): { sec: HTMLElement; t: HTMLButtonElement; inner: HTMLElement } {
        const sec = el("section", "rv-card glass rv-more")
        const h = el("h2", "rv-card-h", "รายชื่อทั้งหมด")
        h.id = "rv-h-more"
        sec.setAttribute("aria-labelledby", h.id)
        const row = el("div", "rv-actions")
        const t = el("button", "btn-ghost", "แสดง")
        t.type = "button"
        t.id = "rv-more-toggle"
        t.setAttribute("aria-controls", "rv-more-body")
        t.addEventListener("click", () => { moreOpen = !moreOpen; render() })
        row.append(t)
        const inner = el("div", "rv-stack")
        inner.id = "rv-more-body"
        sec.append(h, row, inner)
        return { sec, t, inner }
    }

    function waitingCard(s: State): HTMLElement {
        const left = Math.max(0, s.roster.total - s.roster.sent)
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", shortMonth(s.month) + " · " + (s.roster.total ? "รอแพทย์ส่ง " + int(left) + " คน" : "ยังไม่มีรายชื่อ"))
        h.id = "rv-h-wait"
        c.setAttribute("aria-labelledby", h.id)
        const top = el("div", "rv-actions rv-spread")
        const a = el("a", "rv-link", "ดูรายชื่อในแท็บตามส่ง")
        a.href = "/dashboard/#followup"
        top.append(headRow(h), a)
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
        n === null || n === undefined ? "" : NUM_EN2.format(Number(n))

    // Budget and N are typed on the overview page (ภาพรวม, the month card's
    // งบ button; Pong, 2026-11-11), which also starts the month's build.
    // Here they are shown only, with a way there, and the two Drive files.
    function inputsCard(s: State): HTMLElement {
        const c = el("section", "rv-card glass rv-inputs")
        const h = el("h2", "sr-only", "งบประมาณและไฟล์")
        h.id = "rv-h-inputs"
        c.setAttribute("aria-labelledby", h.id)
        const inp = s.inputs
        const set = !!(inp && inp.doctors)
        c.append(h)
        if (inp) {
            const row = el("dl", "rv-ro")
            row.append(kv("งบประมาณ (บาท)", baht(inp.budget)), kv("จำนวนแพทย์ (N)", inp.doctors ? int(inp.doctors) : "–"), kv(en("per P4P"), baht(inp.per_p4p)))
            c.append(row)
        }
        // The owner alone has the ข้อมูล button (Pong, 2026-11-19: "ผู้จัดทำ =
        // hide ข้อมูล btn on overview"): everyone else sees the numbers, or
        // that the owner has yet to type them.
        if (!set) c.append(el("p", "rv-none", (inp ? "ยังไม่ได้กรอกจำนวนแพทย์" : "ยังไม่ได้กรอกงบประมาณ") + (notOwner() ? " (ผู้ดูแลระบบกรอก)" : "")))
        const a = s.alloc
        if (a && a.installed) {
            c.append(el("p", a.uploaded && !a.without ? "rv-hint" : "rv-none", !a.uploaded
                ? "ยังไม่ได้อัปโหลดเอกสารจัดสรร"
                : a.without ? "เอกสารจัดสรร: ยังไม่มีเลข " + int(a.without) + " คน"
                : "เอกสารจัดสรร: มีเลขครบ " + int(a.roster) + " คน"))
        }
        if (!notOwner()) {
            // All in already: a quiet link; not yet: the button to go and add them.
            const done = set && (!a || !a.installed || (a.uploaded && !a.without))
            const go = el("a", done ? "rv-link" : "btn-primary rv-go") as HTMLAnchorElement
            go.append(el("span", undefined, done ? "แก้ที่ปุ่มข้อมูล หน้าภาพรวม" : "กรอกที่ปุ่มข้อมูล หน้าภาพรวม"), iconEl("arrow-right"))
            go.href = "/dashboard/#overview"
            if (done) { const r = el("div", "rv-go-row"); r.append(go); c.append(r) } else c.append(go)
        }
        if (s.build || openRequest(s) || s.request) c.append(filesRow(s))
        return c
    }

    // The two files in Drive, view only: the tab never offers them as the
    // files that are sent (that is the build the system checked).
    function filesRow(s: State): HTMLElement {
        const w = el("div", "rv-files")
        const lab = el("span", "rv-label", "ไฟล์ใน ")
        lab.append(en("Google Drive"), " ")
        const b = s.build
        const req = openRequest(s)
        if (!req) lab.append(el("span", "rv-hint", "· ดูอย่างเดียว"))
        w.append(lab)
        const row = el("div", "rv-actions")
        if (req) {
            const p = el("p", "rv-progress", q2text(req))
            row.append(p)
            // Said here, not under the table, so the table keeps its rows.
            if (s.build && auditeeTurn(s)) row.append(el("p", "rv-hint", "ผลเทียบจะอัปเดตเมื่อสร้างไฟล์ใหม่เสร็จ"))
        } else {
            const link = (text: string, id: string | undefined, url: (x: string) => string): HTMLElement => {
                // No id: a build from before the file's id was kept, or the
                // upload failed. The next build stores it.
                if (!id) return el("span", "rv-hint", text + ": ยังไม่มีลิงก์")
                const a = el("a", "rv-link")
                a.href = url(id)
                a.target = "_blank"
                a.rel = "noopener"
                a.append(/^[A-Za-z0-9]+$/.test(text) ? en(text) : el("span", undefined, text), iconEl("external"),
                    el("span", "sr-only", " " + shortMonth(s.month) + " (เปิดในแท็บใหม่)"))
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
                // รายชื่อ is read-only for the ผู้จัดทำ (Pong, 2026-11-18): the
                // admin fixes the roster, so they get a note, not a link.
                if (auditeeOnly()) row.append(el("span", "rv-hint", "แจ้งผู้ดูแลระบบให้แก้รายชื่อ"))
                else {
                    const a = el("a", "rv-link", "แก้ในแท็บรายชื่อ")
                    a.href = "/dashboard/#roster"
                    row.append(a)
                }
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
    // A score save loads the list itself, with the state (rowsHold).
    let rowsHold = false
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
        renderSoon()
    }
    const ensureRows = (s: State): void => { if (s.build && rowsKey !== rowsWant(s) && !rowsErr && !rowsHold) void loadRows(s) }

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

    // The table, built once per month and kept (2026-11-18, the tab's lag:
    // about 3,000 new elements on every filter click, keystroke and edit).
    // Each redraw patches it: the filters' counts, which rows a filter or
    // the search hides, and only the rows whose person or edit box changed.
    interface LRow { tr: HTMLTableRowElement; tr2: HTMLTableRowElement | null; sig: string }
    interface LCard {
        card: HTMLElement
        h: HTMLElement
        head: HTMLElement
        flt: Map<string, { b: HTMLButtonElement; n: HTMLElement }>
        fl: HTMLElement
        sl: HTMLElement
        si: HTMLInputElement
        box: HTMLElement
        cap: HTMLElement
        thead: HTMLElement
        tbody: HTMLElement
        empty: HTMLTableRowElement
        emptyTd: HTMLTableCellElement
        rows: Map<string, LRow>
        canEdit: boolean | null
    }
    let lc: LCard | null = null
    let aSearchT: number | undefined
    const rowJson = new WeakMap<Row, string>()
    const rowData = (p: Row): string => { let j = rowJson.get(p); if (j === undefined) { j = JSON.stringify(p); rowJson.set(p, j) } return j }
    function newListCard(): LCard {
        const card = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", "รายชื่อ")
        h.id = "rv-h-list"
        card.setAttribute("aria-labelledby", h.id)
        const head = el("div", "rv-actions rv-list-head")
        const fl = el("div", "rv-filters")
        fl.setAttribute("role", "group")
        fl.setAttribute("aria-label", "แสดง")
        const flt = new Map<string, { b: HTMLButtonElement; n: HTMLElement }>()
        for (const [k, t, f] of FILTERS) {
            const b = el("button", "rv-flt", t + " ")
            const n = el("span", "rv-count", "")
            b.append(n)
            b.type = "button"
            b.id = "rv-flt-" + k
            b.addEventListener("click", () => {
                aFilter = k
                pressFirst(b, () => { if (st) render(); say(t + " " + int((rows || []).filter(f).length) + " คน") })
            })
            fl.append(b)
            flt.set(k, { b, n })
        }
        const sl = el("label", "rv-search")
        sl.append(el("span", "sr-only", "ค้นหาชื่อหรือกลุ่มงาน"))
        const si = el("input")
        si.type = "search"
        si.id = "rv-a-search"
        si.placeholder = "ค้นหาชื่อหรือกลุ่มงาน"
        si.autocomplete = "off"
        si.value = aSearch
        // The table follows once typing pauses (120 ms), not on every key.
        si.addEventListener("input", () => {
            aSearch = si.value
            clearTimeout(aSearchT)
            aSearchT = window.setTimeout(() => { aSearchT = undefined; if (st) render() }, 120)
            clearTimeout(searchSay)
            searchSay = window.setTimeout(() => { say(int(body.querySelectorAll(".rv-table tbody tr[data-i]:not([hidden])").length) + " คน") }, 700)
        })
        sl.append(si)
        const box = el("div", "rv-table-box")
        const tbl = el("table", "rv-table")
        const cap = el("caption", "sr-only", "")
        const thead = el("thead")
        const tbody = el("tbody")
        const empty = el("tr")
        const emptyTd = el("td", "rv-hint", "ไม่มีรายชื่อ")
        empty.append(emptyTd)
        empty.hidden = true
        tbody.append(empty)
        tbl.append(cap, thead, tbody)
        box.append(tbl)
        return { card, h, head, flt, fl, sl, si, box, cap, thead, tbody, empty, emptyTd, rows: new Map(), canEdit: null }
    }
    // One person's row (and, while their score is edited, the row of its
    // buttons under it), drawn new.
    function listRow(s: State, p: Row, canEdit: boolean, editingHere: boolean): LRow {
        const tr = el("tr", editingHere ? "on" : "")
        tr.dataset.i = p.index
        const name = el("td", undefined, p.name)
        const dept = el("td", undefined, p.intern ? "INTERN" : p.department)
        const sc = el("td", "num")
        if (editingHere) sc.append(...scoreEditor(s, p, "list"))
        else scoreCell(sc, p)
        const stated = el("td", "num", p.stated === null ? "–" : num2(p.stated))
        const res = el("td")
        res.append(...resultChips(p))
        tr.append(name, dept, sc, stated, res)
        if (canEdit) {
            const td = el("td", "rv-edit-cell")
            if (!editingHere) td.append(editButton(p, "list"))
            tr.append(td)
        }
        let tr2: HTMLTableRowElement | null = null
        if (editingHere) {
            tr2 = el("tr", "on")
            const td = el("td")
            td.colSpan = 6
            td.append(editActions(s, p, "list"))
            tr2.append(td)
        }
        return { tr, tr2, sig: "" }
    }

    function listCard(s: State): HTMLElement {
        if (!s.build) {
            const c = el("section", "rv-card glass")
            const h = el("h2", "rv-card-h", "รายชื่อ")
            h.id = "rv-h-list"
            c.setAttribute("aria-labelledby", h.id)
            c.append(headRow(h), el("p", "rv-hint", openRequest(s) ? "รอสร้างไฟล์เสร็จ แล้วรายชื่อและผลเทียบจะขึ้นที่นี่" : "รายชื่อและผลเทียบจะขึ้นที่นี่เมื่อระบบสร้างไฟล์แล้ว"))
            return c
        }
        ensureRows(s)
        if (!lc) lc = newListCard()
        const L = lc
        const c = L.card
        patchChildren(L.head, [headRow(L.h), L.fl, L.sl])
        const all = rows || []
        for (const [k, , f] of FILTERS) {
            const x = L.flt.get(k)
            if (!x) continue
            setText(x.n, int(all.filter(f).length))
            setAttr(x.b, "aria-pressed", String(aFilter === k))
        }
        if (L.si.value !== aSearch) L.si.value = aSearch
        if (rowsErr) { patchChildren(c, [L.head, failBox("โหลดรายชื่อไม่สำเร็จ: " + rowsErr, "rv-retry-rows", () => { rowsErr = ""; render() })]); c.classList.remove("rv-fill"); return c }
        if (!rows) { patchChildren(c, [L.head, el("p", "rv-loading", "กำลังโหลดรายชื่อ…")]); c.classList.remove("rv-fill"); return c }
        const kids: Node[] = [L.head]

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
            kids.push(w)
        }

        const q = aSearch.trim().toLowerCase()
        const pick = (FILTERS.find((x) => x[0] === aFilter) || FILTERS[0])[2]
        const shown = all.filter((p) => pick(p) && (!q || p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)))
        const vis = new Set(shown.map((p) => p.index))
        setText(L.cap, "รายชื่อ " + shortMonth(s.month) + " · " + int(shown.length) + " คน")
        const canEdit = auditeeTurn(s)
        if (L.canEdit !== canEdit) {
            const hr = el("tr")
            for (const [x, cls] of [["ชื่อ-นามสกุล", ""], ["กลุ่มงาน", ""], ["คะแนน", "num"], ["ไฟล์แพทย์", "num"], ["ผล", ""]]) {
                const th = el("th", cls, x); th.scope = "col"; hr.append(th)
            }
            if (canEdit) { const th = el("th"); th.scope = "col"; th.append(el("span", "sr-only", "แก้คะแนน")); hr.append(th) }
            L.thead.replaceChildren(hr)
            L.emptyTd.colSpan = canEdit ? 6 : 5
            L.canEdit = canEdit
        }
        // Each row is drawn again only when what it shows changed; a new one
        // takes its old one's place, so the rows around it stay put.
        const want: Node[] = []
        const next = new Map<string, LRow>()
        for (const p of all) {
            const editingHere = canEdit && editing === "list:" + p.index
            const spot = "score-" + p.index
            const n = notes.get(spot)
            const sig = rowData(p) + "|" + canEdit + "|" + editingHere +
                (editingHere ? "|" + (fieldErrs.get("score:" + p.index) || "") + "|" + (n ? n.kind + n.text : "") + "|" + flying(s, spot) : "")
            let r = L.rows.get(p.index)
            if (!r || r.sig !== sig) {
                const nr = listRow(s, p, canEdit, editingHere)
                nr.sig = sig
                if (r && r.tr.parentNode === L.tbody) {
                    r.tr.replaceWith(nr.tr)
                    if (r.tr2) { if (nr.tr2) r.tr2.replaceWith(nr.tr2); else r.tr2.remove() } else if (nr.tr2) nr.tr.after(nr.tr2)
                }
                r = nr
            }
            next.set(p.index, r)
            const h = !vis.has(p.index)
            setHidden(r.tr, h)
            want.push(r.tr)
            if (r.tr2) { setHidden(r.tr2, h); want.push(r.tr2) }
        }
        want.push(L.empty)
        L.rows = next
        patchChildren(L.tbody, want)
        setHidden(L.empty, shown.length > 0)
        kids.push(L.box)
        // Long enough to need it: the table gives up height to fit the
        // window (a short one keeps its own height; .rv-fill has a floor).
        c.classList.toggle("rv-fill", shown.length > 3)
        // While a build runs this is said in the left column, by its progress.
        if (!openRequest(s) && all.some(pending)) kids.push(el("p", "rv-hint", "ผลเทียบจะอัปเดตเมื่อสร้างไฟล์ใหม่เสร็จ"))
        const n = noteEl("score")
        if (n) kids.push(n)
        patchChildren(c, kids)
        return c
    }
    const num2 = (n: number | null): string => n === null ? "–" : NUM_TH2.format(Number(n))

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
        if (fl) out.push(chip("flag", FLAG_TEXT[fl]))
        if (resent(p)) out.push(chip("resent", "แพทย์ส่งไฟล์ใหม่หลังแก้"))
        else if (p.edit) out.push(chip("edit", "แก้แล้ว"))
        if (!pending(p)) {
            if (p.scoreCheck === "mismatch") out.push(chip("bad", "คะแนนไม่ตรง"))
            if (p.moneyCheck === "mismatch") out.push(chip("bad", "เงินไม่ตรง"))
            if (p.scoreCheck === "missing" || p.moneyCheck === "missing") {
                out.push(chip("miss", "ไม่พบข้อมูล"))
                out.push(el("span", "rv-old rv-miss-why", p.scoreCheck === "missing" ? (MISS_TEXT[p.statedHow] || "ไม่พบยอดรวมในไฟล์แพทย์")
                    : p.sk03Row === null ? "ไม่มีใน SK03" : "ไม่พบในชีตกลุ่มงาน"))
            }
        }
        if (!out.length) {
            const ok = el("span", "rv-ok-mark")
            ok.append(iconEl("check-circle"), el("span", undefined, "ตรงกัน"))
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
        // Written only when it changes: in the table, any write lays the
        // whole table out again (2026-11-18).
        const paint = (): void => { const w = scoreWarn(i.value); setText(warn, w); setHidden(warn, !w) }
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
        let out: ScoreReply | null = null
        try {
            const r = await post<ScoreReply>(monthApi(s) + "/scores/" + p.index, { score: v, note: ni ? ni.value : "" }, "PUT")
            ok = true
            out = r
            tell(s, "score", "ok", p.name + ": " + (r.changed ? "บันทึกคะแนน " + num2(Number(v)) + " แล้ว · กำลังสร้างไฟล์ใหม่" : "คะแนนเท่าเดิม"))
        } catch (e) {
            const msg = errText(e, "บันทึกไม่สำเร็จ")
            if (e instanceof ApiError && e.status === 400) fieldErrs.set("score:" + p.index, msg)
            tell(s, spot, "err", msg)
        } finally {
            busy = false
            end(s, spot)
        }
        if (!ok || s.month !== month) { await reload(); return }
        editing = ""
        forget(s, "score:" + p.index, "enote:" + p.index)
        // The row shows the new score from the reply at once (2026-11-18),
        // and a build queued shows as on its way; then the state, the list
        // (and the names of a returned round) load together, not one after
        // another.
        const e = out && out.changed ? out.edit : null
        const row = e && rows ? rows.find((x) => x.index === p.index) : undefined
        if (e && row) {
            row.roster = Number(e.new_score)
            row.edit = { old: e.old_score === null ? null : Number(e.old_score), new: Number(e.new_score), note: e.note || "", at: e.created_at || "", by: e.created_by || "" }
            rowJson.delete(row)
        }
        if (out && out.request && st && st.month === s.month) st.request = out.request
        render()
        const b = document.getElementById(eid("edit", where, p)) || document.getElementById(where === "fix" ? "rv-h-ans" : "rv-h-list")
        if (b) { if (!b.hasAttribute("tabindex") && b.tagName === "H2") b.tabIndex = -1; b.focus() }
        rowsHold = true
        const loads: Promise<unknown>[] = [reload(), loadRows(s)]
        const r = liveRound(s)
        if (people && r) loads.push(loadPeople(s, r))
        try { await Promise.all(loads) } finally { rowsHold = false }
        // The list was asked for after the save: it is the newest state's.
        if (st && st.month === s.month && !rowsErr) rowsKey = rowsWant(st)
        if (s.month === month) render()
    }
    interface ScoreReply {
        changed: boolean
        edit: { old_score: number | null; new_score: number; note?: string; created_at?: string; created_by?: string } | null
        request: Request | null
    }

    // ── Send ─────────────────────────────────────────────────────────────
    function submitReasons(s: State): string[] {
        const why: string[] = []
        if (!auditeeTurn(s)) return ["ส่งให้ผู้ตรวจสอบแล้ว"]
        if (s.roster.sent < s.roster.total) why.push("รอแพทย์ส่งครบ")
        // งบรายเดือน and เอกสารจัดสรร: both from the ข้อมูล button on
        // ภาพรวม, which only the owner has (Pong, 2026-11-19). The card
        // above links the owner to them; here the reason only.
        if (!s.inputs || !s.inputs.doctors) why.push(notOwner() ? "รอผู้ดูแลระบบกรอกงบรายเดือน" : "กรอกงบรายเดือนก่อน")
        const a = s.alloc
        if (a && !a.installed) why.push("ยังไม่ได้ติดตั้งเอกสารจัดสรร (SQL ขั้นที่ 29)")
        else if (a && !a.uploaded) why.push(notOwner() ? "รอผู้ดูแลระบบอัปโหลดเอกสารจัดสรร" : "อัปโหลดเอกสารจัดสรรก่อน")
        else if (a && a.without > 0) why.push((notOwner() ? "รอผู้ดูแลระบบใส่เลขเอกสารจัดสรรอีก " : "ใส่เลขเอกสารจัดสรรอีก ") + int(a.without) + " คน")
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
        const bar = el("div", "rv-sendbar rv-dock")
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
        if (flying(s, "send") || savesWait === send.id) markBusy(send)
        send.addEventListener("click", () => {
            if (why.length) { say("ยังส่งไม่ได้: " + why.join(" · ")); return }
            afterSaves(send, () => openConfirm(s, next), () => sideSaving(s.month), () => whenSideSaved(s.month))
        })
        bar.append(send, reason)
        return bar
    }

    // One figure: <div class="rv-kv"><dt>label</dt><dd>value</dd></div>, in a <dl>.
    function kv(label: string | Node, value: string): HTMLElement {
        const d = el("div", "rv-kv")
        const dt = el("dt")
        dt.append(label)
        d.append(dt, el("dd", undefined, value))
        return d
    }
    function kvGrid(budget: number | null, doctors: number | null | undefined, perP4p: number | null, edits?: number): HTMLElement {
        const g = el("dl", "rv-kvs")
        g.append(kv("งบประมาณ", baht(budget)), kv("จำนวนแพทย์", doctors ? int(doctors) : "–"), kv(en("per P4P"), baht(perP4p)))
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
        if (s.emails) kids.push(el("p", "rv-hint", mail && mail.test
            ? "โหมดทดสอบ: ระบบจะส่งอีเมลถึง " + mail.testTo + " เท่านั้น พร้อมไฟล์ SK03 และรวมค่าคะแนน"
            : "ระบบจะส่งอีเมลถึงผู้ตรวจสอบ พร้อมไฟล์ SK03 และรวมค่าคะแนน"))
        if (odd) kids.push(el("p", "rv-hint", "ผลเทียบไม่ตรงหรือไม่พบข้อมูล " + int(odd) + " รายการ · ผู้ตรวจสอบจะพิจารณา"))
        askConfirm(roundNo > 1 ? "ส่งรอบที่ " + roundNo + " ของ " + shortMonth(s.month) + "?" : "ส่ง " + shortMonth(s.month) + " ให้ผู้ตรวจสอบ?", kids, "ส่ง", () => doSubmit(s))
    }
    // One confirm dialog for every step that hands the month to the other
    // side. Each action keeps the s the dialog was written from.
    let confirmAction: (() => Promise<void>) | null = null
    let confirmBusy = false
    let confirmReturn = ""
    let confirmErr: HTMLElement | null = null
    // danger: the step undoes something (ส่งกลับ, reopening): a red button.
    function askConfirm(title: string, kids: Node[], button: string, action: () => Promise<void>, danger = false): void {
        confirmTitle.textContent = title
        const err = el("p", "rv-err rv-confirm-err")
        err.id = "review-confirm-err"
        err.setAttribute("role", "alert")
        confirmErr = err
        confirmBody.replaceChildren(...kids, err)
        confirmSend.textContent = button
        confirmSend.classList.toggle("btn-danger", danger)
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
    // Esc, × and ยกเลิก do not close it while the step is being sent (the
    // capture listener runs before the shared data-close one in app.ts).
    confirmDlg.addEventListener("cancel", (ev) => { if (confirmBusy) ev.preventDefault() })
    const confirmCancels = Array.from(confirmDlg.querySelectorAll<HTMLElement>("[data-close]"))
    confirmDlg.addEventListener("click", (ev) => {
        const t = ev.target
        if (confirmBusy && t instanceof Node && confirmCancels.some((x) => x.contains(t))) { ev.stopPropagation(); ev.preventDefault() }
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
    // s null: a step of no month (the email switch): said, not noted.
    async function confirmRun(s: State | null, call: () => Promise<string>): Promise<boolean> {
        if (confirmBusy) return false
        confirmBusy = true
        markBusy(confirmSend)
        for (const x of confirmCancels) x.setAttribute("aria-disabled", "true")
        const sent = confirmAction
        const err = confirmErr
        if (err) err.textContent = ""
        try {
            const done = await call()
            if (confirmDlg.open && confirmAction === sent) confirmDlg.close()
            if (s) tell(s, "top", "ok", done)
            else say(done)
            return true
        } catch (e) {
            const msg = errText(e, "ทำรายการไม่สำเร็จ")
            if (confirmDlg.open && confirmAction === sent && err && err.isConnected) setTimeout(() => { err.textContent = msg }, 50)
            else if (s) { tell(s, "top", "err", msg); if (s.month === month) render() }
            else shout(msg)
            return false
        } finally {
            confirmBusy = false
            for (const x of confirmCancels) x.removeAttribute("aria-disabled")
            confirmSend.removeAttribute("aria-disabled")
            confirmSend.removeAttribute("aria-busy")
        }
    }
    async function doSubmit(s: State): Promise<void> {
        const ok = await confirmRun(s, async () => {
            const r = await post<{ round: { round_no: number } }>(monthApi(s) + "/rounds")
            return "ส่งรอบที่ " + r.round.round_no + " ให้ผู้ตรวจสอบแล้ว"
        })
        if (!ok) { await reload(); return }
        // Sent: the note and a spinning ส่ง show at once; the month and the
        // months load together.
        moreOpen = false
        holdBusy(s, "send")
        if (s.month === month) render()
        await Promise.all([loadMonths().catch(() => false), reload()])
        end(s, "send")
        if (s.month === month) render()
        focusTop()
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
        await Promise.all([ok ? loadMonths().catch(() => false) : Promise.resolve(false), reload()])
        if (ok) focusTop()
    }

    // The round's email to the auditor (Pong, 2026-11-12): sending a round
    // queues it and the always-on relay sends it within about a minute.
    // Pong, 2026-11-18: no ส่งอีเมล button once the email went out, since
    // sending the round emails by itself (in test mode, to the test address
    // only). A button shows only while an email is still owed: ส่งอีเมลอีกครั้ง
    // after the relay gave up, ส่งอีเมลจริง after a test send once test mode
    // is off, ส่งอีเมล for a round with no email at all. The SQL refuses once
    // a real one went out.
    const roundEmails = (s: State, r: Round): Email[] => (s.emails || []).filter((e) => e.round_id === r.id)
    function emailWaiting(s: State): boolean {
        const r = liveRound(s)
        return !!r && roundEmails(s, r).some((e) => e.status === "queued" || e.status === "sending")
    }
    function emailBox(s: State, r: Round): HTMLElement | null {
        if (!s.emails) {
            // No email SQL: only the switch, when there is one.
            const mp = mailPanel()
            if (!mp) return null
            const w0 = el("div", "rv-email")
            w0.id = "rv-email"
            w0.append(mp)
            return w0
        }
        const list = roundEmails(s, r)
        const real = list.find((e) => e.status === "sent" && !e.test)
        const open = list.find((e) => e.status === "queued" || e.status === "sending")
        const last = list[0]
        const w = el("div", "rv-email")
        w.id = "rv-email"
        let button = ""
        if (real) {
            const p = el("p", "rv-hint")
            const mark = el("span", "rv-ok-mark")
            mark.setAttribute("aria-hidden", "true")
            mark.append(iconEl("check"))
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
            w.append(el("p", "rv-hint", "ส่งอีเมลทดสอบแล้ว " + when(last.sent_at) + (mail && !mail.test ? " · ยังไม่ได้ส่งจริง" : " · ถึงที่อยู่ทดสอบเท่านั้น")))
            // Only the test address has it and test mode is now off: the
            // real email is still owed, so the owner can send it.
            if (mail && !mail.test) button = "ส่งอีเมลจริง"
        } else {
            // No email row at all (a round sent before the email SQL).
            w.append(el("p", "rv-hint", "ยังไม่ได้ส่งอีเมลถึงผู้ตรวจสอบ"))
            button = "ส่งอีเมล"
        }
        if (button) {
            const row = el("div", "rv-actions")
            const b = el("button", "btn-ghost", button + (mail && mail.test ? " (ทดสอบ)" : ""))
            b.type = "button"
            b.id = "rv-email-send"
            b.addEventListener("click", () => askEmail(s, r))
            row.append(b)
            w.append(row)
        }
        const n = noteEl("email")
        if (n) w.append(n)
        // The test mode switch (owner, ผู้จัดทำ side) sits in this box once
        // the month is sent (2026-11-18).
        const mp = mailPanel()
        if (mp) w.append(mp)
        return w
    }
    function askEmail(s: State, r: Round): void {
        const m = mail
        const kids: Node[] = [el("p", undefined, "แนบไฟล์ SK03 และรวมค่าคะแนนของรอบนี้ · ส่งจาก sakhonmso")]
        if (m) kids.push(el("p", "rv-hint", m.test ? "โหมดทดสอบ: ส่งถึง " + m.testTo + " เท่านั้น · หัวเรื่องมี [ทดสอบ]"
            : m.recipients ? "ส่งจริง" + realTo(m) : "ยังไม่มีที่อยู่ผู้รับ อีเมลจะรอจนกว่าจะตั้ง"))
        askConfirm((m && m.test ? "ส่งอีเมลทดสอบ " : "ส่งอีเมล ") + shortMonth(s.month) + " รอบที่ " + r.round_no + (m && m.test ? "?" : " ถึงผู้ตรวจสอบ?"),
            kids, m && m.test ? "ส่งอีเมลทดสอบ" : "ส่งอีเมล", () => doEmail(s))
    }
    async function doEmail(s: State): Promise<void> {
        await confirmRun(s, async () => {
            await post(monthApi(s) + "/email")
            return "สั่งส่งอีเมลแล้ว ระบบจะส่งภายในประมาณ 1 นาที"
        })
        await reload()
    }

    // ── The email's test mode switch ─────────────────────────────────────
    // Pong, 2026-11-12 (แบบ ก): on the ผู้จัดทำ side, in the left column under
    // the months. On: every email to the test address only, its subject
    // marked [ทดสอบ]. Turning it off asks first (the next emails go to the
    // auditor for real); turning it on does not. Turning it off sends
    // nothing by itself. mail comes with each month's state.
    let mail: MailMode | null = null
    let mailBusy = false
    let mailErr = ""
    let mailSeq = 0 // the last load started before the switch's last change
    // "ถึงผู้ตรวจสอบ และอีก 3 ที่อยู่": the first address is the auditor's.
    const realTo = (m: MailMode): string => m.recipients > 1 ? "ถึงผู้ตรวจสอบ และอีก " + int(m.recipients - 1) + " ที่อยู่"
        : m.recipients === 1 ? "ถึงผู้ตรวจสอบ" : "ยังไม่มีที่อยู่ผู้รับ"
    // The switch with its words: in the email box of a sent or approved
    // month, else in the panel the chip by the list's title opens.
    function mailPanel(): HTMLElement | null {
        const m = role === "auditee" ? mail : null
        if (!m) return null
        const box = el("div", "rv-mail")
        const sw = el("button", "rv-switch")
        sw.type = "button"
        sw.id = "rv-mail-switch"
        sw.setAttribute("role", "switch")
        sw.setAttribute("aria-checked", String(m.test))
        sw.setAttribute("aria-label", "โหมดทดสอบอีเมล")
        sw.setAttribute("aria-describedby", "rv-mail-state")
        const track = el("span", "rv-switch-track")
        track.append(el("span", "rv-switch-knob"))
        sw.append(track)
        if (mailBusy) markBusy(sw)
        sw.addEventListener("click", () => { if (!mailBusy) toggleMail() })
        // Clicking the words flips it too.
        const text = el("label", "rv-mail-text") as HTMLLabelElement
        text.htmlFor = sw.id
        text.id = "rv-mail-state"
        text.append(el("b", "rv-mail-t " + (m.test ? "rv-mail-test" : "rv-mail-real"), m.test ? "โหมดทดสอบ" : "ส่งจริง"),
            el("span", "rv-mail-hint", m.test ? "ส่งถึง " + m.testTo + " เท่านั้น · หัวเรื่องมี [ทดสอบ]" : realTo(m)))
        const row = el("div", "rv-mail-row")
        row.append(sw, text)
        box.append(el("span", "rv-mail-h", "อีเมลถึงผู้ตรวจสอบ"), row)
        if (mailErr) {
            const p = el("p", "rv-note rv-note-err")
            p.append(el("strong", undefined, "ไม่สำเร็จ "), mailErr)
            box.append(p)
        }
        return box
    }
    // Before the month is sent: a chip by the title says the mode (โหมดทดสอบ
    // or ส่งจริง) and opens the switch under it. Esc or a click elsewhere
    // closes it.
    let mailOpen = false
    function mailChip(): HTMLElement | null {
        const m = role === "auditee" ? mail : null
        if (!m) return null
        const w = el("div", "rv-mail-pop")
        const b = el("button", "rv-mail-chip" + (m.test ? "" : " rv-mail-chip-real"))
        b.type = "button"
        b.id = "rv-mail-chip"
        b.setAttribute("aria-expanded", String(mailOpen))
        b.setAttribute("aria-controls", "rv-mail-panel")
        b.append(el("span", undefined, m.test ? "โหมดทดสอบ" : "ส่งจริง"), el("span", "sr-only", " อีเมลถึงผู้ตรวจสอบ"), iconEl("chevron-down"))
        b.addEventListener("click", () => { mailOpen = !mailOpen; render() })
        w.append(b)
        const panel = mailPanel()
        if (panel) {
            panel.id = "rv-mail-panel"
            panel.classList.add("rv-mail-panel")
            panel.hidden = !mailOpen
            w.append(panel)
        }
        w.addEventListener("keydown", (ev) => {
            if (ev.key !== "Escape" || !mailOpen) return
            ev.preventDefault()
            mailOpen = false
            render()
            const c = document.getElementById("rv-mail-chip")
            if (c) c.focus()
        })
        // Tab out of it closes it too (open, it covers the search under it).
        w.addEventListener("focusout", (ev) => {
            const to = ev.relatedTarget
            if (!mailOpen || !(to instanceof Node) || w.contains(to) || confirmDlg.contains(to)) return
            mailOpen = false
            renderSoon()
        })
        return w
    }
    // Esc closes it wherever the focus is.
    document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape" || !mailOpen || ev.defaultPrevented || document.querySelector("dialog[open]")) return
        mailOpen = false
        if (st) render()
    })
    document.addEventListener("click", (ev) => {
        if (!mailOpen || confirmDlg.open) return
        const t = ev.target
        if (t instanceof Element && (t.closest(".rv-mail-pop") || confirmDlg.contains(t))) return
        mailOpen = false
        if (st) render()
    })
    // A card title with the chip after it, when there is one: only on the
    // first card drawn (a returned round with รายชื่อทั้งหมด open has two
    // card titles, and the chip and its panel have fixed ids).
    let chipDrawn = false
    function headRow(h: HTMLElement): HTMLElement {
        const c = chipDrawn ? null : mailChip()
        if (!c) return h
        chipDrawn = true
        const r = el("div", "rv-head-row")
        r.append(h, c)
        return r
    }
    // The switch is part of the page now: a change draws the page again.
    function drawMail(): void { if (st) { dirty = true; render() } }
    async function putMail(on: boolean): Promise<string> {
        const r = await post<{ mail: MailMode | null }>("/dashboard/api/review/email-mode", { test: on }, "PUT")
        if (r && r.mail) mail = r.mail
        mailSeq = loadSeq
        mailErr = ""
        const m = mail
        if (!m) return on ? "เปิดโหมดทดสอบแล้ว" : "ปิดโหมดทดสอบแล้ว"
        return on ? "เปิดโหมดทดสอบแล้ว อีเมลต่อไปส่งถึง " + m.testTo + " เท่านั้น"
            : "ปิดโหมดทดสอบแล้ว อีเมลต่อไปส่งจริง" + realTo(m)
    }
    // After a switch: the email texts on the page follow the new mode.
    const mailDrawn = (): void => drawMail()
    function toggleMail(): void {
        const m = mail
        if (!m) return
        if (!m.test) { void mailOn(); return }
        const g = el("dl", "rv-kvs")
        g.append(kv("ส่งถึง", realTo(m).replace(/^ถึง/, "")), kv("หัวเรื่อง", "เอกสาร P4P เดือน… (ไม่มี [ทดสอบ])"))
        askConfirm("ปิดโหมดทดสอบ ส่งอีเมลจริง?", [
            g,
            el("p", undefined, "ปิดแล้วยังไม่ส่งอะไรทันที · ส่งจริงเมื่อกด ส่ง เดือนใหม่ หรือกด ส่งอีเมลจริง ในเดือนที่ส่งแบบทดสอบไปแล้ว"),
            el("p", "rv-hint", "เปิดโหมดทดสอบกลับได้ตลอด ไม่ต้องยืนยัน"),
        ], "ปิดโหมดทดสอบ", mailOff)
    }
    async function mailOff(): Promise<void> {
        mailBusy = true
        mailErr = ""
        drawMail()
        try {
            await confirmRun(st, () => putMail(false))
        } finally {
            mailBusy = false
            mailDrawn()
        }
    }
    async function mailOn(): Promise<void> {
        if (mailBusy) return
        mailBusy = true
        mailErr = ""
        drawMail()
        try {
            const done = await putMail(true)
            if (st) tell(st, "top", "ok", done)
            else say(done)
        } catch (e) {
            if (signedOut(e)) return
            mailErr = errText(e, "เปลี่ยนโหมดไม่สำเร็จ")
            shout(mailErr)
        } finally {
            mailBusy = false
            mailDrawn()
        }
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
        top.append(headRow(h), el("span", "rv-hint", "รอบที่ " + r.round_no + " · " + when(r.returned_at)))
        c.append(top)
        if (peopleErr) c.append(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople))
        else if (!people) c.append(el("p", "rv-loading", "กำลังโหลด…"))
        else if (!fixes.length) c.append(el("p", "rv-hint", "ไม่มีรายชื่อที่ต้องแก้ ดูปัญหาอื่น ๆ"))
        // The fixes scroll in their own box when the window is short.
        const list = el("div", "rv-fix-list")
        if (fixes.length) c.append(list)
        if (fixes.length > 1) c.classList.add("rv-fill")
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
            remark.append(el("span", "rv-remark-label", "หมายเหตุผู้ตรวจสอบ"), p.remark)
            const row = (rows || []).find((x) => x.index === p.index) || null
            const sc = el("div", "rv-fix-score num")
            const fixEditing = !!row && canEdit && editing === "fix:" + row.index
            if (row && fixEditing) {
                sc.append(...scoreEditor(s, row, "fix"))
            } else if (row) {
                const cell = el("span")
                scoreCell(cell, row)
                sc.append(cell)
                if (row.edit) sc.append(chip(resent(row) ? "resent" : "edit", resent(row) ? "แพทย์ส่งไฟล์ใหม่หลังแก้" : "แก้แล้ว"))
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
            list.append(item)
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
    // People decided while this filter is on stay in the list where they
    // were, their row showing the result, instead of a green note above the
    // names (Pong, 2026-11-12). Cleared when the filter changes.
    const kept = new Set<string>()

    function listDone(): void {
        listsLoading = Math.max(0, listsLoading - 1)
        if (!listsLoading) roleLists = false
        syncRole()
    }
    const roundKey = (s: State, r: Round): string => s.month + ":" + r.round_no + ":" + r.status + ":" + (r.counts.approve + r.counts.fix)
    async function loadPeople(s: State, r: Round): Promise<void> {
        listsLoading++
        try { await loadPeopleNow(s, r) } finally { listDone() }
    }
    async function loadPeopleNow(s: State, r: Round): Promise<void> {
        const key = s.month + ":" + r.round_no
        const seq = ++peopleSeq
        peopleKey = key
        peopleErr = ""
        const asked = performance.now()
        try {
            const res = await api<{ people: Person[] }>(monthApi(s) + "/people?round=" + r.round_no)
            if (seq !== peopleSeq || s.month !== month) return
            const list = res.people || []
            // A decision still being saved is not undone by a list asked for before it ended.
            reapply(s.month, list, asked)
            people = list
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
        renderSoon()
    }
    async function loadIssues(s: State): Promise<void> {
        listsLoading++
        try { await loadIssuesNow(s) } finally { listDone() }
    }
    async function loadIssuesNow(s: State): Promise<void> {
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
        renderSoon()
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
    // The counts of a round: from its names once they are here (they show
    // a decision the moment it is made, 2026-11-18), else the state's.
    function countsOf(s: State, r: Round): Round["counts"] {
        if (!people || s.month !== month || peopleKey !== s.month + ":" + r.round_no) return r.counts
        let approve = 0, fix = 0, waiting = 0, carried = 0
        for (const p of people) {
            if (p.decision === "approve") approve++
            else if (p.decision === "fix") fix++
            else waiting++
            if (p.carried) carried++
        }
        return { approve, fix, waiting, carried }
    }
    // A new state (another round, a decision made elsewhere) reloads both.
    // Counts that only show this screen's own decisions are not news
    // (2026-11-18: they reloaded both lists after every decision).
    let lastRoundKey = ""
    function refreshLists(s: State): void {
        const r = liveRound(s)
        if (!r) return
        const k = roundKey(s, r)
        if (k === lastRoundKey) return
        // The month's first state: the names asked for with it are this round's.
        if (!lastRoundKey && peopleKey === s.month + ":" + r.round_no) { lastRoundKey = k; return }
        const sameStep = lastRoundKey.split(":").slice(0, 3).join(":") === s.month + ":" + r.round_no + ":" + r.status
        if (sameStep && people && peopleKey === s.month + ":" + r.round_no) {
            const c = countsOf(s, r)
            if (c.approve === r.counts.approve && c.fix === r.counts.fix && c.waiting === r.counts.waiting) { lastRoundKey = k; return }
            // The server has yet to get this screen's saves: look again later.
            if (savingIn(s.month)) return
        }
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
    const num = (n: number | null): string => n === null ? "—" : NUM_TH2.format(Number(n))

    function chip(kind: string, text: string): HTMLElement {
        return el("span", "rv-chip rv-chip-" + kind, text)
    }

    // ผู้ตรวจสอบ ───────────────────────────────────────────────────────────
    const reviewWrap = el("div", "rv-review")
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
        sideOut.push(...finishBar(s, r))
        const out: Node[] = []
        if (peopleErr) out.push(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople))
        if (!people) { if (!peopleErr) out.push(el("p", "rv-loading", "กำลังโหลดรายชื่อ…")); return out }
        // The names stay; the person panel is drawn new (it is small).
        patchChildren(reviewWrap, [peopleList(), personPanel(s, r)])
        out.push(reviewWrap)
        if (issuesShown()) out.push(issuesCard(s, "auditor"))
        return out
    }

    // The left column's foot on the auditor's side: the round and its
    // figures, then the dock (อนุมัติทุกคนที่รอตรวจ, ส่งผลตรวจ, each with the
    // reason it cannot be pressed yet under it).
    function finishBar(s: State, r: Round): HTMLElement[] {
        const c = countsOf(s, r)
        // Not known until the issues load: no "0 open" and no approve-all before that.
        const openIssues = issues ? issues.filter((i) => i.status === "open").length : null
        const bar = el("div", "rv-finish")
        const dock = el("div", "rv-dock")
        // The month chip above already says พร้อมตรวจ; who sent it and when
        // are left out (Pong, 2026-11-12).
        const info = el("dl", "rv-ro")
        info.append(kv("งบ", baht(r.budget)), kv("จำนวนแพทย์", r.doctors ? int(r.doctors) : "–"), kv(en("per P4P"), baht(r.per_p4p)))
        if (r.edits) info.append(kv("ผู้จัดทำแก้คะแนน", int(r.edits) + " คน"))
        bar.append(el("p", "rv-round-title", "รอบที่ " + r.round_no + " · " + monthName(s.month, true)), info)
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
        if (c.waiting > 0) dock.append(approveAllBox(s, r))
        const btn = el("button", "btn-primary")
        btn.type = "button"
        btn.id = "rv-finish"
        const why = el("span", "rv-hint")
        why.id = "rv-finish-why"
        const others = openIssues ? " · ปัญหาอื่น " + int(openIssues) + " เรื่อง" : ""
        if (c.waiting > 0) {
            // Why it waits, under it (2026-11-18: shown again, so the
            // button that cannot be pressed says why without a hover).
            const left = "ส่งได้เมื่อตรวจครบทุกคน (เหลือ " + int(c.waiting) + " คน)"
            btn.textContent = "ส่งผลตรวจ"
            btn.setAttribute("aria-disabled", "true")
            btn.setAttribute("aria-describedby", why.id)
            why.textContent = left
            btn.addEventListener("click", () => say(left))
            dock.append(btn, why)
            return [bar, dock]
        }
        if (openIssues === null) {
            btn.textContent = "ส่งผลตรวจ"
            btn.setAttribute("aria-disabled", "true")
            btn.setAttribute("aria-describedby", why.id)
            why.textContent = issuesErr ? "ส่งได้เมื่อโหลดข้อมูลได้ กดลองอีกครั้งด้านขวา" : "กำลังโหลด…"
            btn.addEventListener("click", () => say(why.textContent || ""))
        } else if (c.fix > 0 || openIssues > 0) {
            btn.textContent = "ส่งกลับให้ผู้จัดทำแก้"
            btn.dataset.step = "return"
            why.textContent = "ต้องแก้ไข " + int(c.fix) + " คน" + others
            btn.addEventListener("click", () => afterSaves(btn, () => {
                askConfirm("ส่งกลับให้ผู้จัดทำแก้", [el("p", undefined, "ส่งรอบที่ " + r.round_no + " เดือน " + monthName(s.month) + " กลับ: ต้องแก้ไข " + int(c.fix) + " คน" + others),
                    el("p", "rv-hint", "ดึงกลับได้จนกว่าผู้จัดทำจะเปิดดู")], "ส่งกลับ", () => roundStep(s, "return", "ส่งกลับให้ผู้จัดทำแล้ว"), true)
            }))
        } else {
            btn.textContent = "อนุมัติทั้งหมด"
            btn.dataset.step = "approve"
            why.textContent = "อนุมัติครบ " + int(c.approve) + " คน"
            btn.addEventListener("click", () => afterSaves(btn, () => {
                askConfirm("อนุมัติทั้งหมด", [el("p", undefined, "อนุมัติ " + int(c.approve) + " คน ของเดือน " + monthName(s.month) + " รอบที่ " + r.round_no),
                    el("p", "rv-hint", "หลังอนุมัติ ระบบจะทำเอกสารเบิกจ่าย (PDF) ที่มีเวลาอนุมัติทุกหน้า")], "อนุมัติ", () => roundStep(s, "approve", "อนุมัติแล้ว"))
            }))
        }
        // Waiting for the saves, or the step's follow-up loading: it spins.
        if (savesWait === btn.id || flying(s, "finish")) markBusy(btn)
        dock.append(btn, why)
        return [bar, dock]
    }

    // A step that hands the round on (ส่งกลับ, อนุมัติทั้งหมด, อนุมัติ N คน)
    // waits for every decision still being saved (2026-11-18), so nothing
    // is sent with one unsaved. The button spins meanwhile, then is pressed
    // again as drawn from the saved names (a failed save may have put
    // someone back to รอตรวจ), but only when it is still the same step:
    // a failed save can turn ส่งกลับ into อนุมัติทั้งหมด (or back), and a
    // step not pressed never opens by itself; the failure note says why.
    let savesWait = ""
    function afterSaves(btn: HTMLElement, go: () => void, busyNow: () => boolean = () => flights.size > 0, wait: () => Promise<void> = settled): void {
        if (!busyNow()) { go(); return }
        if (savesWait) return
        savesWait = btn.id
        const step = btn.dataset.step || ""
        const m = month
        markBusy(btn)
        void wait().then(() => {
            savesWait = ""
            if (!st || view.classList.contains("hidden")) return
            render()
            const b = document.getElementById(btn.id)
            if (b && month === m && (b.dataset.step || "") === step && b.getAttribute("aria-disabled") !== "true") b.click()
        })
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
        const b = el("button", "btn-primary", "อนุมัติ " + int(n) + " คนที่รอตรวจ")
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
                        kept.clear()
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
            b.addEventListener("click", () => afterSaves(b, () => {
                // Short labelled lines (Pong, 2026-11-12: the sentences
                // were hard to read).
                const cc = countsOf(s, r)
                const done = cc.approve + cc.fix
                const g = el("dl", "rv-kvs")
                g.append(kv("เดือน", monthName(s.month) + " รอบที่ " + r.round_no), kv("อนุมัติครั้งนี้", int(n) + " คน"),
                    kv("ตัดสินแล้ว (คงเดิม)", done ? int(done) + " คน" : "–"))
                askConfirm("อนุมัติทุกคนที่รอตรวจ", [
                    g,
                    tick("ทุกคนที่จะอนุมัติ เทียบคะแนนและเทียบเงินตรงกัน"),
                ], "อนุมัติ " + int(n) + " คน", () => approveAll(s, r))
            }))
        }
        if (savesWait === b.id || flying(s, "approve-all")) markBusy(b)
        box.append(b, why)
        return box
    }

    const tick = (text: string): HTMLElement => { const p = el("p"); p.append(iconEl("check"), text); return p }
    async function approveAll(s: State, r: Round): Promise<void> {
        let said = ""
        let waiting: string[] = []
        const ok = await confirmRun(s, async () => {
            await settled()
            waiting = (people || []).filter((x) => x.decision === null).map((x) => x.index)
            const res = await post<{ approved: number }>(monthApi(s) + "/approve-all", { round: r.round_no })
            said = "อนุมัติแล้ว " + int(Number(res && res.approved) || 0) + " คน"
            return said
        })
        if (!ok || s.month !== month) { if (s.month === month) await reload(); return }
        // No note above the names: everyone just approved stays in the
        // list with an approved row, and the tiles show the new counts at
        // once (2026-11-18); the round, the names and the months are then
        // loaded together, not one after another.
        notes.delete("top")
        for (const i of waiting) {
            kept.add(i)
            const p = (people || []).find((x) => x.index === i)
            if (p && p.decision === null) { p.decision = "approve"; p.remark = ""; p.carried = false }
        }
        say(said)
        holdBusy(s, "approve-all")
        render()
        await Promise.all([loadMonths().catch(() => false), reload(), loadPeople(s, r), loadIssues(s)])
        end(s, "approve-all")
        if (s.month === month) render()
    }

    // ── Approved: the document, a retry, and reopening ───────────────────
    function approvedView(s: State, r: Round, side: "auditee" | "auditor"): Node[] {
        const status = r.pdf_status || "queued"
        const c = el("section", "rv-card glass")
        const h = el("h2", "rv-card-h", "อนุมัติ " + shortMonth(s.month) + " แล้ว")
        h.id = "rv-h-pdf"
        c.setAttribute("aria-labelledby", h.id)
        c.append(h, el("p", "rv-hint", when(r.approved_at) + " · รอบที่ " + r.round_no + (r.approved_by ? " · " + staffName(r.approved_by) : "")))
        if (status === "ready") {
            const row = el("div", "rv-actions")
            const a = el("a", "rv-link")
            a.href = "/dashboard/api/review/" + s.month + "/pdf"
            a.target = "_blank"
            a.rel = "noopener"
            a.id = "rv-pdf"
            const at = el("span", undefined, "เปิดเอกสารเบิกจ่าย ")
            at.append(en("PDF"))
            a.append(at, iconEl("external"), el("span", "sr-only", " (เปิดในแท็บใหม่)"))
            const d = el("a", "rv-link", "ดาวน์โหลด")
            d.href = "/dashboard/api/review/" + s.month + "/pdf?download=1"
            d.id = "rv-pdf-dl"
            d.append(el("span", "sr-only", " เอกสารเบิกจ่าย " + shortMonth(s.month)))
            if (flying(s, "pdf-dl")) markBusy(d)
            d.addEventListener("click", (ev) => { ev.preventDefault(); void downloadPdf(s, d) })
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
        // The per-person allocation list (Pong, 2026-11-17): made on request
        // from the approved round, so it does not wait for the PDF. The
        // auditor side only (the server lets only the owner and a ผู้ตรวจสอบ have it).
        if (side === "auditor") {
            const xl = el("div", "rv-actions")
            const xa = el("a", "rv-link")
            const xt = el("span", undefined, "ดาวน์โหลดรายละเอียดการจัดสรรเงินรายบุคคล (")
            xt.append(en("Excel"), ")")
            xa.append(xt)
            xa.href = "/dashboard/api/review/" + s.month + "/allocation"
            xa.id = "rv-allocation-dl"
            xa.append(el("span", "sr-only", " " + shortMonth(s.month)))
            if (flying(s, "xlsx")) markBusy(xa)
            xa.addEventListener("click", (ev) => { ev.preventDefault(); void downloadFile(s, "xlsx", xa, "allocation_" + s.month + ".xlsx") })
            xl.append(xa)
            c.append(xl)
            const xn = noteEl("xlsx")
            if (xn) c.append(xn)
        }
        c.append(kvGrid(r.budget, r.doctors, r.per_p4p, r.edits || 0))
        for (const spot of ["pdf", "pdf-dl"]) { const n = noteEl(spot); if (n) c.append(n) }
        const mail = side === "auditee" ? emailBox(s, r) : null
        if (mail) c.append(mail)
        const out: Node[] = [c]
        if (side === "auditor") {
            const row = el("div", "rv-actions")
            const b = el("button", "btn-danger", "ยกเลิกเอกสารและเปิดตรวจอีกครั้ง…")
            b.type = "button"
            b.id = "rv-reopen"
            b.addEventListener("click", () => askReopen(s, r))
            row.append(b)
            out.push(card("ต้องแก้หลังอนุมัติ?", [row,
                el("p", "rv-hint", "เอกสารที่สร้างแล้วจะใช้ไม่ได้ รอบที่ " + r.round_no + " กลับมาเป็นคิวผู้ตรวจสอบ ผลอนุมัติเดิมยังอยู่")], "rv-h-reopen"))
        }
        return out
    }

    // Downloads spin until the file is on its way (Pong, 2026-11-17: every
    // button shows it is loading). The Excel is made on request and can take
    // a few seconds, so it is fetched here and handed to the browser under
    // the name the server gave; the PDF link is signed first, then the
    // browser saves it from storage.
    async function fetchOk(url: string): Promise<Response> {
        let r: Response
        try { r = await fetch(url, { credentials: "same-origin" }) } catch (e) { throw new ApiError(NET_ERROR, 0) }
        if (r.status === 401) { location.href = "/dashboard/login?error=idle"; throw new ApiError("signed out", 401) }
        if (!r.ok) {
            let data: any = null
            try { data = await r.json() } catch (e) { data = null }
            throw new ApiError((data && typeof data.error === "string" && data.error) || "ดาวน์โหลดไม่สำเร็จ ลองใหม่อีกครั้ง (" + r.status + ")", r.status)
        }
        return r
    }
    // filename*=UTF-8''<name> (RFC 6266), else filename="<name>".
    function savedName(cd: string | null): string {
        if (!cd) return ""
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
        if (star) { try { return decodeURIComponent(star[1].trim()) } catch (e) { /* fall through */ } }
        const plain = /filename="([^"]+)"/i.exec(cd)
        return plain ? plain[1] : ""
    }
    function saveFrom(href: string, name?: string): void {
        const t = document.createElement("a")
        t.href = href
        if (name) t.download = name
        t.style.display = "none"
        document.body.append(t)
        t.click()
        t.remove()
    }
    async function downloadFile(s: State, spot: string, a: HTMLAnchorElement, fallback: string): Promise<void> {
        if (!begin(s, spot, a)) return
        try {
            const r = await fetchOk(a.href)
            const url = URL.createObjectURL(await r.blob())
            saveFrom(url, savedName(r.headers.get("Content-Disposition")) || fallback)
            setTimeout(() => URL.revokeObjectURL(url), 60000)
        } catch (e) {
            if (!signedOut(e)) tell(s, spot, "err", errText(e, "ดาวน์โหลดไม่สำเร็จ"))
        } finally {
            end(s, spot)
        }
        if (s.month === month) render()
    }
    async function downloadPdf(s: State, a: HTMLAnchorElement): Promise<void> {
        if (!begin(s, "pdf-dl", a)) return
        try {
            const r = await fetchOk(a.href + "&link=1")
            const data = await r.json() as { url?: string }
            if (!data || typeof data.url !== "string") throw new Error("ดาวน์โหลดไม่สำเร็จ ลองใหม่อีกครั้ง")
            saveFrom(data.url)
        } catch (e) {
            if (!signedOut(e)) tell(s, "pdf-dl", "err", errText(e, "ดาวน์โหลดไม่สำเร็จ"))
        } finally {
            end(s, "pdf-dl")
        }
        if (s.month === month) render()
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
            await Promise.all([loadMonths().catch(() => false), reload()])
        }, true)
        setTimeout(() => ta.focus(), 0)
    }

    // approve / return come from the confirm dialog (which stays open with
    // the reason when refused); unreturn is a plain button (btn).
    async function roundStep(s: State, step: "return" | "unreturn" | "approve", done: string, btn?: HTMLButtonElement): Promise<void> {
        // Never with a decision still being saved.
        const call = async (): Promise<string> => { await settled(); await post(monthApi(s) + "/" + step); return done }
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
        if (!ok) { await reload(); return }
        // Done: the note shows and the button spins while the month, its
        // lists and the months load together (2026-11-18: one after another).
        if (s.month === month) { peopleKey = ""; issuesKey = "" }
        holdBusy(s, "finish")
        if (s.month === month) render()
        await Promise.all([loadMonths().catch(() => false), reload()])
        end(s, "finish")
        if (s.month === month) render()
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
            return st.test(p) || kept.has(p.index)
        })
    }

    // The decision as a small round mark at the start of a name's row.
    function decisionMark(p: Person): HTMLElement {
        const kind = p.decision === "approve" ? "ok" : p.decision === "fix" ? "fix" : "wait"
        const m = el("span", "rv-dmark rv-dmark-" + kind)
        m.setAttribute("aria-hidden", "true")
        return m
    }

    // The names: built once per month and kept (2026-11-18, the tab's lag;
    // it was about 1,700 new elements on every click). Each redraw patches
    // it: the tiles' counts and pressed state, the rows whose person
    // changed, which rows a filter or the search hides, and the row open.
    interface PRow { li: HTMLLIElement; b: HTMLButtonElement; sig: string }
    interface PList {
        root: HTMLElement
        tiles: Map<string, { b: HTMLButtonElement; n: HTMLElement }>
        si: HTMLInputElement
        count: HTMLElement
        ul: HTMLUListElement
        empty: HTMLLIElement
        rows: Map<string, PRow>
        of: Person[] | null
    }
    let pl: PList | null = null
    let searchT: number | undefined
    function newPeopleList(): PList {
        const root = el("div", "rv-people glass")
        // Status tiles: the count of each type, and the filter.
        const tilesBox = el("div", "rv-status")
        tilesBox.setAttribute("role", "group")
        tilesBox.setAttribute("aria-label", "สถานะ: เลือกเพื่อแสดงเฉพาะกลุ่มนั้น")
        const tiles = new Map<string, { b: HTMLButtonElement; n: HTMLElement }>()
        for (const st of STATUSES) {
            const b = el("button", "rv-st rv-st-" + st.tone)
            b.type = "button"
            b.id = "rv-st-" + st.key
            b.dataset.filter = st.key
            const lab = el("span", "rv-st-label")
            if (st.tone !== "all") { const dot = el("span", "rv-st-dot"); dot.setAttribute("aria-hidden", "true"); lab.append(dot) }
            lab.append(st.label)
            const n = el("b", "rv-st-n", "")
            b.append(lab, n)
            b.addEventListener("click", () => {
                filter = st.key
                kept.clear()
                pressFirst(b, () => {
                    // The panel follows: the first of the group when the
                    // person on screen is not in it.
                    const list = visiblePeople()
                    if (list.length && !list.some((x) => x.index === selected)) selected = list[0].index
                    render()
                    say(st.label + " " + int((people || []).filter(st.test).length) + " คน")
                })
            })
            tilesBox.append(b)
            tiles.set(st.key, { b, n })
        }
        const sl = el("label", "rv-search rv-people-search")
        sl.append(el("span", "sr-only", "ค้นหาชื่อหรือกลุ่มงาน"))
        const si = el("input")
        si.type = "search"
        si.id = "rv-search"
        si.placeholder = "ค้นหาชื่อหรือกลุ่มงาน"
        si.value = search
        si.autocomplete = "off"
        // The list follows once typing pauses (120 ms), not on every key.
        si.addEventListener("input", () => {
            search = si.value
            clearTimeout(searchT)
            searchT = window.setTimeout(() => { searchT = undefined; if (st) render() }, 120)
        })
        sl.append(si)
        // With a search, how many of the group it leaves.
        const count = el("p", "rv-hint rv-people-count")
        count.setAttribute("aria-live", "polite")
        count.hidden = true
        const ul = el("ul", "rv-people-list")
        ul.setAttribute("aria-label", "รายชื่อในรอบนี้")
        const empty = el("li", "rv-hint")
        empty.hidden = true
        ul.append(empty)
        // A list box: one tab stop (the person open); up and down open the
        // person above or below, Home / End the first or last.
        ul.addEventListener("keydown", (ev) => {
            const opts = Array.from(ul.querySelectorAll<HTMLElement>('[role="option"]')).filter((b) => !(b.parentElement as HTMLElement).hidden)
            const to = rove(opts, ev, { ArrowUp: -1, ArrowDown: 1 })
            if (!to || !to.dataset.i || to.dataset.i === selected) return
            selected = to.dataset.i
            render()
            const f = document.getElementById(to.id)
            if (f && document.activeElement !== f) f.focus()
        })
        root.append(tilesBox, sl, count, ul)
        return { root, tiles, si, count, ul, empty, rows: new Map(), of: null }
    }
    // What a row shows; the row is drawn again only when this changes.
    const rowSig = (p: Person): string => [p.name, p.department, p.intern, p.decision, p.carried, isMismatch(p), isMissing(p)].join("|")
    function fillRow(r: PRow, p: Person, sig: string): void {
        const b = r.b
        const tone = p.decision === "approve" ? " rv-p-ok" : p.decision === "fix" ? " rv-p-fix" : ""
        b.className = "rv-person-btn" + tone + (p.index === selected ? " current" : "")
        const line = el("span", "rv-pline")
        line.append(el("span", "rv-pname", p.name))
        if (isMismatch(p)) line.append(chip("bad", "ไม่ตรงกัน"))
        else if (isMissing(p)) line.append(chip("miss", "ไม่พบ"))
        // The result in the row itself (Pong, 2026-11-12): a soft green
        // or orange row, and อนุมัติ / ต้องแก้ไข after the department.
        const sub = el("span", "rv-psub", p.intern ? "อินเทิร์น" : p.department)
        if (p.decision) sub.append(" · ", el("span", "rv-pdec rv-pdec-" + (p.decision === "approve" ? "ok" : "fix"), p.decision === "approve" ? "อนุมัติ" : "ต้องแก้ไข"))
        if (p.carried) sub.append(" · คงผลรอบก่อน")
        const text = el("span", "rv-ptext")
        text.append(line, sub)
        const kids: Node[] = [decisionMark(p), text]
        if (!p.decision) kids.push(el("span", "sr-only", " · รอตรวจ"))
        b.replaceChildren(...kids)
        r.sig = sig
    }
    function newRow(p: Person): PRow {
        const li = el("li")
        li.setAttribute("role", "none")
        const b = el("button", "rv-person-btn")
        b.type = "button"
        b.id = "rv-p-" + p.index
        b.dataset.i = p.index
        b.setAttribute("role", "option")
        b.tabIndex = -1
        const index = p.index
        b.addEventListener("click", () => { openPerson(index) })
        li.append(b)
        return { li, b, sig: "" }
    }

    function peopleList(): HTMLElement {
        if (!pl) pl = newPeopleList()
        const L = pl
        const all = people || []
        for (const st of STATUSES) {
            const n = all.filter(st.test).length
            const t = L.tiles.get(st.key)
            if (!t) continue
            setText(t.n, int(n))
            t.b.classList.toggle("rv-st-zero", n === 0 && st.key !== "all")
            setAttr(t.b, "aria-pressed", String(filter === st.key))
        }
        if (L.si.value !== search) L.si.value = search
        const shown = visiblePeople()
        const vis = new Set(shown.map((p) => p.index))
        // A new list (a load, another round): rows in its order, a person
        // no longer in it gone.
        if (L.of !== all) {
            const rows = new Map<string, PRow>()
            const want: Node[] = []
            for (const p of all) {
                const r = L.rows.get(p.index) || newRow(p)
                rows.set(p.index, r)
                want.push(r.li)
            }
            want.push(L.empty)
            L.rows = rows
            patchChildren(L.ul, want)
            L.of = all
        }
        const stopAt = vis.has(selected) ? selected : shown.length ? shown[0].index : ""
        for (const p of all) {
            const r = L.rows.get(p.index)
            if (!r) continue
            const sig = rowSig(p)
            if (sig !== r.sig) fillRow(r, p, sig)
            setHidden(r.li, !vis.has(p.index))
            const on = p.index === selected
            if (r.b.classList.contains("current") !== on) r.b.classList.toggle("current", on)
            setAttr(r.b, "aria-selected", String(on))
            const ti = p.index === stopAt ? 0 : -1
            if (r.b.tabIndex !== ti) r.b.tabIndex = ti
        }
        setAttr(L.ul, "role", shown.length ? "listbox" : null)
        setHidden(L.empty, shown.length > 0)
        if (!shown.length) setText(L.empty, filter === "todo" && !search.trim() ? "ตรวจครบทุกคนแล้ว" : "ไม่มีรายชื่อ")
        setHidden(L.count, !search.trim())
        if (search.trim()) setText(L.count, "พบ " + int(shown.length) + " คน")
        return L.root
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
            if (check === "mismatch" && diff) res.append(el("span", "rv-diff", diff))
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
        if (p.edit) {
            const w = el("p", "rv-why", "ผู้จัดทำแก้คะแนน " + num(p.edit.old))
            w.append(iconEl("arrow-right"), el("span", "sr-only", " → "), num(p.edit.new) + (p.edit.note ? " · " + p.edit.note : ""))
            panel.append(w)
        }
        if (p.prev && (p.prev.remark || p.prev.reply)) {
            const prev = el("div", "rv-prev")
            if (p.prev.remark) prev.append(el("p", undefined, "รอบก่อน ผู้ตรวจสอบ: " + p.prev.remark))
            prev.append(el("p", undefined, "คำตอบผู้จัดทำ: " + (p.prev.reply || "ไม่มีคำตอบ")))
            panel.append(prev)
        }
        panel.append(foot)
        panel.addEventListener("scroll", () => markStuck(), { passive: true })
        // The person a decision here moves on to: their detail is ready when
        // the app gets there.
        const next = nextAfter(p.index)
        if (next) loadDetail(s, r, next.index)
        return panel
    }

    // Show another person: the list and panel just under the counts bar, so
    // อนุมัติ is at the same place on the screen for everyone, and focus on
    // their name (one Tab on is อนุมัติ).
    function openPerson(index: string): void {
        selected = index
        render()
        afterFrame(true)
        const h = document.getElementById("rv-person-h")
        if (h) h.focus({ preventScroll: true })
    }
    function toWorkingSpot(): void {
        const wrap = body.querySelector<HTMLElement>(".rv-review")
        if (!wrap) return
        const fin = body.querySelector<HTMLElement>(".rv-finish")
        const top = wrap.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop
        view.scrollTop = Math.max(0, top - (fin ? fin.offsetHeight : 0) - 10)
        // A remark box open with the person (the only way on for a
        // ไม่ตรงกัน) is not left under the pinned decide row.
        const box = body.querySelector<HTMLElement>(".rv-person .rv-remark-box")
        boxFor = box ? selected : ""
        if (box) inPanelView(box)
        markStuck()
    }
    // Scrolls the person panel (only it) the least that brings el above
    // the pinned decide row, never past the panel's top.
    function inPanelView(t: HTMLElement): void {
        const panel = t.closest<HTMLElement>(".rv-person")
        if (!panel || panel.scrollHeight <= panel.clientHeight + 1) return
        const row = panel.querySelector<HTMLElement>(".rv-decide-row")
        const pr = panel.getBoundingClientRect()
        const r = t.getBoundingClientRect()
        const floor = (row ? row.getBoundingClientRect().top : pr.bottom) - 8
        const by = Math.min(r.bottom - floor, r.top - pr.top - 8)
        if (by > 0) panel.scrollTop += by
    }
    // The counts bar's height (it wraps on narrow windows) sets where the
    // people list and the decision row stick, and how much of the top a
    // focused control must clear.
    function syncStick(): void {
        const fin = body.querySelector<HTMLElement>(".rv-finish")
        const h = fin ? fin.offsetHeight : 0
        // Read first, then written only when changed (2026-11-18): each
        // write would make the browser lay the page out again.
        // Rounded down: clientHeight can round a fractional height up (a
        // zoomed window), and the half pixel over would bring a scrollbar.
        const vh = Math.floor(view.getBoundingClientRect().height) + "px"
        // What sits above the names and the person (a note, a failure box)
        // comes off their height, so the decide row stays in the window.
        const wrap = body.querySelector<HTMLElement>(":scope > .rv-review")
        const above = (wrap ? Math.max(0, Math.round(wrap.getBoundingClientRect().top - body.getBoundingClientRect().top)) : 0) + "px"
        const vs = view.style
        if (vs.getPropertyValue("--rv-fin") !== h + "px") vs.setProperty("--rv-fin", h + "px")
        if (vs.getPropertyValue("--rv-view-h") !== vh) vs.setProperty("--rv-view-h", vh)
        if (vs.getPropertyValue("--rv-above") !== above) vs.setProperty("--rv-above", above)
        // Focus never lands under the counts bar at the top (the decide
        // row's own room is kept by markStuck).
        if (vs.scrollPaddingTop !== h + 10 + "px") vs.scrollPaddingTop = h + 10 + "px"
        markStuck(true)
        syncSide()
    }
    // A shadow over the dock while the side has more under the fold.
    function syncSide(): void {
        const more = sideScroll.scrollHeight - sideScroll.scrollTop - sideScroll.clientHeight > 1 && dock.childElementCount > 0
        sideScroll.parentElement?.classList.toggle("rv-side-more", more)
    }
    sideScroll.addEventListener("scroll", syncSide, { passive: true })
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
        // one line with it; when even the keys do not fit, they go too.
        bar.classList.remove("tight")
        const btns = bar.querySelector<HTMLElement>(".rv-decide-btns")
        const nav = bar.querySelector<HTMLElement>(".rv-decide-nav")
        if (btns && nav && nav.offsetTop > btns.offsetTop + 4) bar.classList.add("tight")
        // Focus never lands under the pinned row, whatever its height now
        // (it wraps on narrower windows).
        const padB = bar.offsetHeight + 10 + "px"
        if (panel && panel.style.scrollPaddingBottom !== padB) panel.style.scrollPaddingBottom = padB
    }
    view.addEventListener("scroll", () => markStuck(), { passive: true })
    window.addEventListener("resize", syncStick)
    // Keys for the auditor (Pong picked them, 2026-11-12): A อนุมัติ,
    // F ต้องแก้ไข, ← / → the person before / after. By key position
    // (ev.code), so they work with the Thai layout on too; never while
    // typing, in a dialog, or with a modifier.
    // 2026-11-18: only while the focus is in the names or the person (so
    // the arrows elsewhere, the months and the side switch, are theirs), and
    // only while ปุ่มลัด is on (kept per computer; on by default).
    const KEYS_KEY = "review.keys"
    let keysOn = true
    try { if (localStorage.getItem(KEYS_KEY) === "off") keysOn = false } catch (e) { /* private window */ }
    document.addEventListener("keydown", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.repeat || ev.defaultPrevented) return
        if (!keysOn || role !== "auditor" || view.classList.contains("hidden") || !body.querySelector(".rv-decide-row")) return
        if (document.querySelector("dialog[open]")) return
        const t = ev.target as HTMLElement | null
        if (!t || !t.closest(".rv-review")) return
        if (t.closest("input, textarea, select, [contenteditable]")) return
        const id = ev.code === "KeyA" ? "rv-approve" : ev.code === "KeyF" ? "rv-fix"
            : ev.code === "ArrowLeft" ? "rv-prev-person" : ev.code === "ArrowRight" ? "rv-next-person" : ""
        if (!id) return
        const b = document.getElementById(id) as HTMLButtonElement | null
        if (!b || b.disabled) return
        ev.preventDefault()
        b.click()
    })

    // The second click of a double-click must not decide the next person
    // too (the first one moved the panel on). Every other click counts
    // (2026-11-18: the half-second guard after the panel changed person
    // dropped real clicks); keys (detail 0) always work, and the keys
    // ignore a held key's repeats.
    const dbl = (ev: MouseEvent): boolean => ev.detail > 1

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
        const approve = el("button", "btn-primary" + (ok ? "" : " rv-off"))
        if (p.decision === "approve") approve.append(iconEl("check"), "อนุมัติแล้ว")
        else approve.append("อนุมัติ")
        approve.type = "button"
        approve.id = "rv-approve"
        const fix = el("button", (ok ? "btn-ghost" : "btn-primary") + (open && ok ? " rv-pressed" : ""))
        if (p.decision === "fix") fix.append(iconEl("check"), "ต้องแก้ไขแล้ว")
        else fix.append("ต้องแก้ไข")
        fix.type = "button"
        fix.id = "rv-fix"
        // It opens the remark box under the checks.
        fix.setAttribute("aria-expanded", String(open))
        fix.setAttribute("aria-controls", "rv-remark-box")
        if (keysOn) {
            approve.setAttribute("aria-keyshortcuts", "A")
            approve.title = "ปุ่มลัด A"
            fix.setAttribute("aria-keyshortcuts", "F")
            fix.title = "ปุ่มลัด F"
        }
        btns.append(approve, fix)
        let undo: HTMLButtonElement | null = null
        if (p.decision) {
            undo = el("button", "btn-ghost", "ยกเลิกผล")
            undo.type = "button"
            undo.id = "rv-undo"
            const u = undo
            u.addEventListener("click", (ev) => { if (!dbl(ev)) decide(p.index, null, "") })
            btns.append(u)
        }
        const who = el("span", "rv-decide-who", p.name)
        who.setAttribute("aria-hidden", "true")
        const nav = el("div", "rv-decide-nav")
        const list = visiblePeople()
        const i = list.findIndex((x) => x.index === p.index)
        const go = (d: number, text: string): HTMLButtonElement => {
            const b = el("button", "btn-ghost")
            if (d < 0) b.append(iconEl("arrow-left"), text)
            else b.append(text, iconEl("arrow-right"))
            b.type = "button"
            b.id = d < 0 ? "rv-prev-person" : "rv-next-person"
            if (keysOn) {
                b.setAttribute("aria-keyshortcuts", d < 0 ? "ArrowLeft" : "ArrowRight")
                b.title = "ปุ่มลัด " + (d < 0 ? "←" : "→")
            }
            const target = list[i + d]
            b.disabled = !target
            b.addEventListener("click", () => { if (target) openPerson(target.index) })
            return b
        }
        nav.append(go(-1, "คนก่อนหน้า"), go(1, "คนถัดไป"))
        // ปุ่มลัด: a switch for the keys, and the keys while they are on.
        const keysBox = el("div", "rv-keys-box")
        // A switch named ปุ่มลัด; the word after it shows its state, which
        // aria-checked says to a screen reader.
        const kt = el("button", "rv-keys-toggle", "ปุ่มลัด ")
        const state = el("span", undefined, keysOn ? "เปิด" : "ปิด")
        state.setAttribute("aria-hidden", "true")
        kt.append(state)
        kt.type = "button"
        kt.id = "rv-keys-toggle"
        kt.setAttribute("role", "switch")
        kt.setAttribute("aria-checked", String(keysOn))
        kt.addEventListener("click", () => {
            keysOn = !keysOn
            try { localStorage.setItem(KEYS_KEY, keysOn ? "on" : "off") } catch (e) { /* private window */ }
            render()
            say(keysOn ? "ปุ่มลัด เปิด" : "ปุ่มลัด ปิด")
        })
        keysBox.append(kt)
        if (keysOn) {
            const kbd = (k: string | Node, sr?: string): HTMLElement => { const x = el("kbd"); x.append(k); if (sr) x.append(el("span", "sr-only", sr)); return x }
            const keys = el("span", "rv-keys")
            keys.append(kbd("A"), " · ", kbd("F"), " · ", kbd(iconEl("arrow-left"), "←"), " ", kbd(iconEl("arrow-right"), "→"))
            keysBox.append(keys)
        }
        bar.append(btns, who, keysBox, nav)
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
                const a = el("a", "rv-link")
                a.id = "rv-open-merged"
                a.href = "https://drive.google.com/file/d/" + encodeURIComponent(fid) + "/view"
                a.target = "_blank"
                a.rel = "noopener"
                a.append(el("span", undefined, "เปิดไฟล์รวมค่าคะแนน"), iconEl("external"), el("span", "sr-only", " (เปิดในแท็บใหม่)"))
                why.append(a)
            }
            out.push(why)
        }
        approve.addEventListener("click", (ev) => {
            if (dbl(ev)) return
            if (!ok) { say(why.textContent || ""); return }
            decide(p.index, "approve", "")
        })
        fix.addEventListener("click", (ev) => {
            if (dbl(ev)) return
            remarkOpen.add(p.index)
            if (!open) render()
            const ta = document.getElementById("rv-remark")
            if (ta) ta.focus()
        })

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
            sv.addEventListener("click", (ev) => {
                if (dbl(ev)) return
                if (!ta.value.trim()) {
                    err.textContent = "พิมพ์หมายเหตุว่าต้องแก้อะไร"
                    fieldErrs.set(draftKey, err.textContent)
                    err.classList.remove("hidden")
                    ta.setAttribute("aria-invalid", "true")
                    ta.focus()
                    return
                }
                fieldErrs.delete(draftKey)
                decide(p.index, "fix", ta.value)
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
        // A failed save shows just above the pinned row (not in it, so the
        // row keeps its height); it is scrolled into view when it comes.
        const n = noteEl(spot)
        if (n) out.push(n)
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
                if (selected === index && month === s.month) renderSoon()
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

    // A decision shows at once (2026-11-18, the tab's lag): the person's
    // row, the tiles and the counts change, and the panel moves on to the
    // next person still to check, while the save goes to the server in the
    // background. Each person's saves go one after another; a failed save
    // puts that person back as the server has them, shows why and says it.
    // pend keeps what is still being saved (and what a /people reply
    // started before the save ended cannot know yet), by month and person.
    interface Pend { decision: Person["decision"]; remark: string; seq: number; done: number }
    const pend = new Map<string, Pend>()
    const pendBase = new Map<string, { decision: Person["decision"]; remark: string; carried: boolean }>()
    const saving = new Map<string, Promise<void>>()
    const flights = new Set<Promise<void>>()
    let decSeq = 0
    // Every decision still on its way, ended (a step that hands the round on
    // waits for this, so nothing is sent with a decision unsaved).
    async function settled(): Promise<void> { while (flights.size) await Promise.all(Array.from(flights).map((x) => x.catch(() => undefined))) }
    const savingIn = (m: string): boolean => Array.from(pend.entries()).some(([k, e]) => !e.done && k.startsWith(m + ":"))
    // The people of a month: the one on screen, or one kept for a switch back.
    const peopleOf = (m: string): Person[] | null => m === month ? people : ((monthKeep.get(m) || {}) as Partial<Kept>).people || null
    // What a /people reply cannot know yet: saves that ended after it was
    // asked for, or have not ended. Older ones are in the reply already.
    function reapply(m: string, list: Person[], asked: number): void {
        for (const [k, e] of Array.from(pend.entries())) {
            if (!k.startsWith(m + ":")) continue
            if (e.done && e.done < asked) { pend.delete(k); pendBase.delete(k); continue }
            const idx = k.slice(m.length + 1)
            const cur = list.find((x) => x.index === idx)
            if (cur) { cur.decision = e.decision; cur.remark = e.remark; cur.carried = false }
        }
    }
    // The next person still to check after this one in the list (then from
    // the top): where a decision moves on to.
    function nextAfter(index: string): Person | null {
        const list = visiblePeople()
        const at = list.findIndex((x) => x.index === index)
        const order = at < 0 ? list : list.slice(at + 1).concat(list.slice(0, at))
        return order.find((x) => x.decision === null && x.index !== index) || null
    }
    function decide(index: string, decision: "approve" | "fix" | null, remark: string): void {
        const s = st
        if (!s || s.month !== month || !people) return
        const p = people.find((x) => x.index === index)
        if (!p) return
        const m = s.month
        const key = m + ":" + index
        const spot = "decide-" + index
        if (!pend.has(key)) pendBase.set(key, { decision: p.decision, remark: p.remark, carried: p.carried })
        const seq = ++decSeq
        const rem = decision === "fix" ? remark.trim() : ""
        pend.set(key, { decision, remark: rem, seq, done: 0 })
        p.decision = decision
        p.remark = rem
        p.carried = false
        // The typed remark stays a draft until the server has it (a failed
        // save gives it back); only its error goes now.
        const draftKey = "remark:" + index
        const typed = decision === "fix" ? remark : ""
        const draftAtPress = drafts.get(draftKey)
        fieldErrs.delete(draftKey)
        notes.delete(spot)
        if (decision !== "fix") remarkOpen.delete(index)
        // The row shows the result and stays where it was; the words are
        // only read out.
        kept.add(index)
        // Straight on to the next person still to check; the words say who.
        const next = decision ? nextAfter(index) : null
        if (next) selected = next.index
        say(p.name + ": " + decisionText(p) + (next ? " · ถัดไป " + next.name : ""))
        const pressed = document.activeElement instanceof HTMLElement ? document.activeElement.id : ""
        render()
        if (next) {
            afterFrame(true)
            const hh = document.getElementById("rv-person-h")
            if (hh) hh.focus({ preventScroll: true })
        } else {
            // Stay on the button pressed (ยกเลิกผล becomes อนุมัติ's
            // neighbour again), else the name.
            const back = (pressed && document.getElementById(pressed)) || document.getElementById("rv-person-h")
            if (back && document.activeElement !== back) back.focus({ preventScroll: true })
        }
        const name = p.name
        const before = saving.get(key) || Promise.resolve()
        const run = before.then(() => post(monthApi(s) + "/decisions/" + index, { decision, remark }, "PUT")).then(() => {
            pendBase.set(key, { decision, remark: rem, carried: false })
            const e = pend.get(key)
            if (e && e.seq === seq) {
                e.done = performance.now()
                // Saved: the draft goes, unless more was typed since.
                if (m === month && drafts.get(draftKey) === draftAtPress) drafts.delete(draftKey)
            }
            // A failed save's note at the top goes with the next save that
            // works after it.
            const t = notes.get("top")
            if (m === month && t && t.failSeq !== undefined && t.failSeq < seq) { notes.delete("top"); renderSoon() }
        }, (err) => {
            if (signedOut(err)) return
            const e = pend.get(key)
            // A later decision for the same person is on its way: it decides.
            if (!e || e.seq !== seq) return
            const b = pendBase.get(key)
            pend.delete(key)
            pendBase.delete(key)
            const cur = (peopleOf(m) || []).find((x) => x.index === index)
            if (cur && b) { cur.decision = b.decision; cur.remark = b.remark; cur.carried = b.carried }
            // What was typed comes back in the box, open.
            if (m === month && typed.trim()) {
                if (!drafts.has(draftKey) || drafts.get(draftKey) === "") drafts.set(draftKey, typed)
                remarkOpen.add(index)
            }
            // Shown above the person's decision row while they are open,
            // else at the top (until a later save works).
            const here = m === month && selected === index
            tell(s, here ? spot : "top", "err", name + ": " + errText(err, "บันทึกไม่สำเร็จ"))
            if (here) revealId = noteId(spot)
            else { const t = notes.get("top"); if (t) { t.failSeq = decSeq; t.fail = { m, text: name + ": " + errText(err, "บันทึกไม่สำเร็จ") } } }
            // No clear answer (no connection, a server error): the save may
            // have gone through, so the names are read again; saves still on
            // their way keep their result.
            const status = err instanceof ApiError ? err.status : 0
            const r2 = st && st.month === m ? liveRound(st) : null
            if (m === month && st && r2 && (status === 0 || status >= 500)) void loadPeople(st, r2)
            renderSoon()
        })
        const tail: Promise<void> = run.finally(() => {
            flights.delete(tail)
            if (saving.get(key) === tail) saving.delete(key)
        })
        saving.set(key, tail)
        flights.add(tail)
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
        // The issues load with the month, not after it.
        if (s.month !== month) return
        await Promise.all([reload(), loadIssues(s)])
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
