/** GENERATED FILE'S SOURCE — this file is compiled to dashboard/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
;(function () {
    "use strict"

    // ── Desktop-only gate — the inverse of the LIFF pages' mobile gate ───
    const mobileBlock = document.getElementById("mobile-block") as HTMLElement
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        mobileBlock.style.display = "flex"
        return
    }

    // One month as /dashboard/api/overview returns it (newest first).
    interface MonthStatus {
        key: string
        name: string
        color: string
        exists: boolean
        total: number
        sent: number
        lastSubmittedAt: string | null
    }

    // ── DOM refs ─────────────────────────────────────────────────────────
    const logoutBtn  = document.getElementById("logout-btn") as HTMLElement
    const userName   = document.getElementById("user-name") as HTMLElement
    const userAvatar = document.getElementById("user-avatar") as HTMLElement
    const monthsEl   = document.getElementById("months") as HTMLElement
    const errorEl    = document.getElementById("error") as HTMLElement
    const emptyEl    = document.getElementById("empty") as HTMLElement
    const titleEl    = document.getElementById("page-title") as HTMLElement
    const navBtns    = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[data-view]"))

    const CLOCK_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'

    // reason "idle" is recorded as an automatic sign-out in the audit log.
    const signOut = async (to: string, reason?: string): Promise<void> => {
        await fetch("/dashboard/logout" + (reason ? "?reason=" + reason : ""), { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.href = to
    }
    logoutBtn.addEventListener("click", () => { void signOut("/dashboard/login") })

    // ── Idle sign-out ────────────────────────────────────────────────────
    // 15 minutes without a mouse, key, scroll or touch event signs the user
    // out. The server holds the same deadline in the session cookie, and
    // the keep-alive below (at most once a minute while active) slides it
    // forward, so a sleeping laptop or closed tab is signed out too.
    const IDLE_MS = 15 * 60 * 1000
    const KEEPALIVE_MS = 60 * 1000
    let lastActivity = Date.now()
    let lastKeepAlive = Date.now()
    const keepAlive = async (): Promise<void> => {
        lastKeepAlive = Date.now()
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" })
            if (r.status === 401) location.href = "/dashboard/login?error=idle"
        } catch (e) {
            // Offline for a moment; the next activity retries.
        }
    }
    const checkIdle = (): boolean => {
        if (Date.now() - lastActivity < IDLE_MS) return false
        void signOut("/dashboard/login?error=idle", "idle")
        return true
    }
    const onActivity = (): void => {
        if (checkIdle()) return
        lastActivity = Date.now()
        if (lastActivity - lastKeepAlive >= KEEPALIVE_MS) void keepAlive()
    }
    for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"]) {
        window.addEventListener(ev, onActivity, { passive: true })
    }
    // Timers are throttled in background tabs, so also check on return.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdle() })
    setInterval(checkIdle, 15 * 1000)

    // ── Helpers ──────────────────────────────────────────────────────────
    const el = (tag: string, cls?: string, text?: string): HTMLElement => {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
    }

    const fmtNum = (n: number): string => n.toLocaleString("th-TH")

    // Thai short date and time in Bangkok, e.g. "17 ต.ค. 2569  11:18 น." (em space between)
    const fmtWhen = (iso: string): string => {
        const d = new Date(iso)
        const date = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })
        const time = d.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })
        return date + "\u2003" + time + " น."
    }

    const renderMonth = (m: MonthStatus): HTMLElement => {
        const card = el("article", "month-card glass")
        card.style.setProperty("--month", m.color)
        card.setAttribute("aria-label", m.name)

        const header = el("div", "card-header")
        header.appendChild(el("h2", "month-chip", m.name))
        card.appendChild(header)

        if (!m.exists) {
            card.classList.add("no-roster")
            header.appendChild(el("span", "badge idle", "ยังไม่มีรายชื่อ"))
            const content = el("div", "card-content")
            content.appendChild(el("p", undefined, "ยังไม่ได้สร้างรายชื่อแพทย์ของเดือนนี้"))
            card.appendChild(content)
            return card
        }

        const pending = m.total - m.sent
        const pct = m.total ? Math.round((m.sent / m.total) * 100) : 0
        let badge: HTMLElement
        if (m.total > 0 && pending === 0) {
            card.classList.add("complete")
            badge = el("span", "badge done", "ส่งครบแล้ว")
        } else if (m.sent > 0) {
            badge = el("span", "badge open", "ดำเนินการส่ง")
        } else {
            badge = el("span", "badge idle", "ยังไม่มีผู้ส่ง")
        }
        header.appendChild(badge)

        const content = el("div", "card-content")
        const stat = el("div", "stat")
        stat.appendChild(el("span", "pct", pct + "%"))
        const of = el("span", "of")
        of.appendChild(el("b", undefined, fmtNum(m.sent)))
        of.appendChild(document.createTextNode(" จาก " + fmtNum(m.total) + " คน"))
        stat.appendChild(of)
        content.appendChild(stat)

        const progress = el("div", "progress")
        progress.setAttribute("role", "progressbar")
        progress.setAttribute("aria-valuemin", "0")
        progress.setAttribute("aria-valuemax", String(m.total))
        progress.setAttribute("aria-valuenow", String(m.sent))
        progress.setAttribute("aria-label", "ส่งแล้ว " + m.sent + " จาก " + m.total + " คน")
        const fill = el("span")
        fill.style.width = "0%"
        progress.appendChild(fill)
        content.appendChild(progress)
        // Next frame, so the bar animates in from zero.
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct + "%" }))

        const split = el("dl", "split")
        const sentBox = el("div")
        sentBox.appendChild(el("dt", undefined, "ส่งแล้ว"))
        sentBox.appendChild(el("dd", undefined, fmtNum(m.sent)))
        const pendBox = el("div", "pending" + (pending === 0 ? " zero" : ""))
        pendBox.appendChild(el("dt", undefined, "ค้างส่ง"))
        pendBox.appendChild(el("dd", undefined, fmtNum(pending)))
        split.appendChild(sentBox)
        split.appendChild(pendBox)
        content.appendChild(split)
        card.appendChild(content)

        const footer = el("div", "card-footer")
        footer.innerHTML = CLOCK_SVG
        footer.appendChild(el("span", undefined,
            m.lastSubmittedAt ? "ส่งล่าสุด " + fmtWhen(m.lastSubmittedAt) : "ยังไม่มีการส่งไฟล์"))
        card.appendChild(footer)
        return card
    }

    // ── Tabs ─────────────────────────────────────────────────────────────
    // ภาพรวม shows all six months; ตามส่ง shows only the months not yet
    // complete. Both come from the one overview response; the URL hash
    // (#overview / #followup) picks the tab so it survives a refresh.
    const TITLES: Record<string, string> = {
        overview: "ภาพรวม — สถานะการส่งไฟล์ Excel 6 เดือนที่ผ่านมา",
        followup: "ตามส่ง — เดือนที่ยังส่งไฟล์ Excel ไม่ครบ",
        roster: "รายชื่อ — รายชื่อแพทย์รายเดือน เพิ่ม แก้ไข และลบ",
        audit: "ประวัติการใช้งาน — การเข้าใช้และการแก้ไขแดชบอร์ด",
    }
    const isComplete = (m: MonthStatus): boolean => m.exists && m.total > 0 && m.sent === m.total
    let months: MonthStatus[] | null = null
    // Set from /dashboard/api/session; only the owner gets the audit tab.
    let isOwner = false
    const auditView = document.getElementById("audit-view") as HTMLElement
    const rosterView = document.getElementById("roster-view") as HTMLElement
    const currentView = (): string =>
        location.hash === "#followup" ? "followup" : location.hash === "#roster" ? "roster"
            : location.hash === "#audit" && isOwner ? "audit" : "overview"
    const render = (): void => {
        const view = currentView()
        const audit = view === "audit" || view === "roster"
        auditView.classList.toggle("hidden", view !== "audit")
        rosterView.classList.toggle("hidden", view !== "roster")
        for (const a of navBtns) {
            const on = a.dataset.view === view
            a.classList.toggle("active", on)
            if (on) a.setAttribute("aria-current", "page")
            else a.removeAttribute("aria-current")
        }
        titleEl.textContent = TITLES[view]
        if (audit) {
            monthsEl.classList.add("hidden")
            emptyEl.classList.add("hidden")
            errorEl.classList.add("hidden")
            return
        }
        monthsEl.classList.remove("hidden")
        if (!months) return
        const shown = view === "followup" ? months.filter((m) => !isComplete(m)) : months
        monthsEl.classList.toggle("followup", view === "followup")
        monthsEl.replaceChildren(...shown.map((m) => {
            const card = renderMonth(m)
            if (view === "followup" && m.exists) {
                card.classList.add("clickable")
                card.tabIndex = 0
                card.setAttribute("role", "button")
                card.setAttribute("aria-label", m.name + " — ดูรายชื่อผู้ที่ยังไม่ส่ง")
                card.addEventListener("click", () => { void openPending(m) })
                card.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); void openPending(m) }
                })
            }
            return card
        }))
        emptyEl.classList.toggle("hidden", shown.length > 0)
        monthsEl.classList.toggle("hidden", shown.length === 0)
    }
    // ตามส่ง always shows fresh numbers: every visit to the tab reloads.
    // Switch at once with the counts already loaded; ตามส่ง then refreshes
    // them in the background (the server is a slow round trip away).
    // Each tab visit is logged for the owner (?view=), so ภาพรวม reloads too.
    window.addEventListener("hashchange", () => {
        render()
        const view = currentView()
        if (view === "audit") void loadAudit()
        else if (view === "roster") void loadRoster(true)
        else void loadOverview(view)
    })
    render()

    // ── ตามส่ง: who has not sent, and the calls / LINE messages logged ───
    interface Pending {
        index: string
        name: string
        department: string
        phone: number
        line: number
        lastContactAt: string | null
    }
    interface Entry { id: number; note: string; logged_by: string; created_at: string }
    type Channel = "phone" | "line"
    const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
    const CHANNEL_LABEL: Record<Channel, string> = { phone: "โทรศัพท์", line: "LINE" }
    const PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
    const LINE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#06C755"/><path fill="#fff" d="M12 5.2c-4.1 0-7.4 2.7-7.4 6 0 3 2.6 5.5 6.2 5.9.2 0 .6.2.7.4.1.2 0 .6 0 .8l-.1.6c0 .2-.2.7.6.4.8-.3 4.3-2.5 5.8-4.3 1-1.1 1.6-2.3 1.6-3.7 0-3.4-3.3-6.1-7.4-6.1z"/><path fill="#06C755" d="M8.2 9.5h-.6c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h2c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2H8.4V9.7c0-.1-.1-.2-.2-.2zm2.3 0h-.5c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h.5c.1 0 .2-.1.2-.2V9.7c0-.1-.1-.2-.2-.2zm3.5 0h-.5c-.1 0-.2.1-.2.2v2.1l-1.6-2.2-.2-.1h-.5c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h.5c.1 0 .2-.1.2-.2v-2.1l1.6 2.2.2.1h.5c.1 0 .2-.1.2-.2V9.7c0-.1-.1-.2-.2-.2zm2.6 0h-2c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h2c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2h-1.3v-.6h1.3c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2h-1.3v-.6h1.3c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2z"/></svg>'

    const sheet      = document.getElementById("pending-sheet") as HTMLDialogElement
    const sheetChip  = document.getElementById("pending-chip") as HTMLElement
    const sheetCount = document.getElementById("pending-count") as HTMLElement
    const sheetList  = document.getElementById("pending-list") as HTMLElement
    const searchBox  = document.getElementById("pending-search") as HTMLInputElement
    const logDlg     = document.getElementById("log-dialog") as HTMLDialogElement
    const logTitle   = document.getElementById("log-title") as HTMLElement
    const logSub     = document.getElementById("log-sub") as HTMLElement
    const logList    = document.getElementById("log-list") as HTMLElement
    const logForm    = document.getElementById("log-form") as HTMLFormElement
    const logNote    = document.getElementById("log-note") as HTMLTextAreaElement
    const logPresets = document.getElementById("log-presets") as HTMLDivElement
    const logSubmit  = document.getElementById("log-submit") as HTMLButtonElement
    const logError   = document.getElementById("log-error") as HTMLElement
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("[data-close]"))) {
        b.addEventListener("click", () => (b.closest("dialog") as HTMLDialogElement).close())
    }
    // A click on the dimmed backdrop (the dialog element itself) closes it.
    for (const d of [sheet, logDlg]) d.addEventListener("click", (ev) => { if (ev.target === d) d.close() })
    // Closing the list may mean calls were logged: refresh the cards.
    sheet.addEventListener("close", () => { void loadOverview() })

    let openMonth: MonthStatus | null = null
    let logTarget: { p: Pending; channel: Channel; btn: HTMLElement } | null = null

    const api = async (url: string, init?: RequestInit): Promise<any> => {
        const r = await fetch(url, { credentials: "same-origin", ...init })
        if (r.status === 401) { location.href = "/dashboard/login?error=idle"; throw new Error("signed out") }
        if (!r.ok) throw new Error("HTTP " + r.status)
        return r.json()
    }

    const contactBtn = (p: Pending, channel: Channel): HTMLElement => {
        const b = el("button", "contact-btn " + channel)
        b.setAttribute("type", "button")
        const setLabel = (): void => {
            b.innerHTML = channel === "phone" ? PHONE_SVG : LINE_SVG
            const n = p[channel]
            b.appendChild(el("span", "count" + (n ? "" : " zero"), String(n)))
            b.setAttribute("aria-label", CHANNEL_LABEL[channel] + " " + p.name + " — ติดต่อแล้ว " + n + " ครั้ง")
            b.title = CHANNEL_LABEL[channel] + " · ติดต่อแล้ว " + n + " ครั้ง"
        }
        setLabel()
        ;(b as any).refresh = setLabel
        b.addEventListener("click", () => { void openLog(p, channel, b) })
        return b
    }

    const renderPending = (list: Pending[]): void => {
        sheetCount.textContent = "ยังไม่ส่ง " + fmtNum(list.length) + " คน"
        if (!list.length) {
            sheetList.replaceChildren(el("p", "sheet-empty", "ทุกคนส่งไฟล์แล้ว"))
            return
        }
        sheetList.replaceChildren(...list.map((p, i) => {
            const row = el("li", "pending-row")
            row.appendChild(el("span", "num", String(i + 1)))
            const who = el("div", "who")
            who.appendChild(el("span", "name", p.name))
            who.appendChild(el("span", "meta", p.department))
            row.appendChild(who)
            row.appendChild(el("span", "last" + (p.lastContactAt ? "" : " none"),
                p.lastContactAt ? "ติดต่อล่าสุด " + fmtWhen(p.lastContactAt) : "ยังไม่ได้ติดต่อ"))
            row.dataset.search = (p.name + " " + p.department).toLowerCase()
            const actions = el("div", "actions")
            actions.appendChild(contactBtn(p, "phone"))
            actions.appendChild(contactBtn(p, "line"))
            row.appendChild(actions)
            return row
        }))
        applySearch()
    }

    // Typing filters the rows already on screen by name or department.
    const applySearch = (): void => {
        const q = searchBox.value.trim().toLowerCase()
        let shown = 0
        for (const row of Array.from(sheetList.querySelectorAll<HTMLElement>(".pending-row"))) {
            const hit = !q || (row.dataset.search || "").includes(q)
            row.hidden = !hit
            if (hit) shown++
        }
        let none = sheetList.querySelector(".no-match")
        if (q && !shown) {
            if (!none) none = sheetList.appendChild(el("p", "sheet-empty no-match", "ไม่พบรายชื่อที่ค้นหา"))
        } else if (none) none.remove()
    }
    searchBox.addEventListener("input", applySearch)

    const openPending = async (m: MonthStatus): Promise<void> => {
        openMonth = m
        sheet.style.setProperty("--month", m.color)
        sheetChip.textContent = m.name
        sheetCount.textContent = ""
        searchBox.value = ""
        sheetList.replaceChildren(...[0, 1, 2, 3, 4].map(() => el("li", "pending-row skeleton-row")))
        if (!sheet.open) sheet.showModal()
        searchBox.focus()
        try {
            const data: { physicians: Pending[] } = await api("/dashboard/api/pending?month=" + encodeURIComponent(m.key))
            if (openMonth === m) renderPending(data.physicians)
        } catch (e) {
            console.error("pending failed:", e)
            sheetList.replaceChildren(el("p", "sheet-empty error-text", "โหลดรายชื่อไม่สำเร็จ กรุณาลองใหม่"))
        }
    }

    const renderLog = (entries: Entry[]): void => {
        if (!entries.length) {
            logList.replaceChildren(el("li", "log-empty", "ยังไม่มีบันทึกการติดต่อ"))
        } else {
            logList.replaceChildren(...entries.map((e, i) => {
                const li = el("li", "log-entry")
                li.appendChild(el("span", "time-no", "ครั้งที่ " + (i + 1)))
                const body = el("div", "log-body")
                body.appendChild(el("span", "when", fmtWhen(e.created_at) + (e.logged_by ? "\u2003(บันทึกโดย " + e.logged_by + ")" : "")))
                if (e.note) body.appendChild(el("p", "note", e.note))
                li.appendChild(body)
                const del = el("button", "icon-btn log-delete") as HTMLButtonElement
                del.type = "button"
                del.innerHTML = TRASH_SVG
                del.setAttribute("aria-label", "ลบครั้งที่ " + (i + 1))
                del.title = "ลบ"
                del.addEventListener("click", () => { void deleteEntry(e, i + 1, del) })
                li.appendChild(del)
                return li
            }))
        }
        logSubmit.textContent = "บันทึกครั้งที่ " + (entries.length + 1)
        logList.scrollTop = logList.scrollHeight
    }

    // One-tap notes; a tap replaces an earlier preset but keeps anything typed after it
    const PRESETS: Record<Channel, string[]> = {
        phone: ["รับทราบ", "ไม่รับสาย", "เบอร์ติดต่อไม่ได้", "ส่งไปแล้ว (มีข้อผิดพลาด)"],
        line:  ["รับทราบ", "ยังไม่อ่านข้อความ", "อ่านแล้วไม่ตอบ", "ส่งไปแล้ว (มีข้อผิดพลาด)"],
    }
    let presetList: string[] = []
    const SEP = " · "

    const currentPreset = (): string | undefined =>
        presetList.find(t => logNote.value === t || logNote.value.startsWith(t + SEP))

    const syncPresets = (): void => {
        const cur = currentPreset()
        logPresets.querySelectorAll<HTMLButtonElement>(".preset").forEach(b => {
            b.setAttribute("aria-pressed", String(b.dataset.text === cur))
        })
    }

    const renderPresets = (channel: Channel): void => {
        presetList = PRESETS[channel]
        logPresets.replaceChildren(...presetList.map(t => {
            const b = el("button", "preset", t) as HTMLButtonElement
            b.type = "button"
            b.dataset.text = t
            b.setAttribute("aria-pressed", "false")
            b.addEventListener("click", () => {
                const cur = currentPreset()
                const rest = cur ? logNote.value.slice(cur.length).replace(SEP, "") : logNote.value.trim()
                logNote.value = cur === t ? rest : (rest ? t + SEP + rest : t)
                syncPresets()
                logNote.focus()
            })
            return b
        }))
    }

    logNote.addEventListener("input", syncPresets)

    const openLog = async (p: Pending, channel: Channel, btn: HTMLElement): Promise<void> => {
        if (!openMonth) return
        logTarget = { p, channel, btn }
        logDlg.dataset.channel = channel
        logTitle.textContent = CHANNEL_LABEL[channel] + " · " + p.name
        logSub.textContent = openMonth.name + (p.department ? " · " + p.department : "")
        logList.replaceChildren(el("li", "log-empty", "กำลังโหลด…"))
        logNote.value = ""
        renderPresets(channel)
        logError.classList.add("hidden")
        logSubmit.disabled = true
        logDlg.showModal()
        try {
            const q = "month=" + encodeURIComponent(openMonth.key) + "&index=" + encodeURIComponent(p.index) + "&channel=" + channel
            const data: { entries: Entry[] } = await api("/dashboard/api/followups?" + q)
            renderLog(data.entries)
            logSubmit.disabled = false
            logNote.focus()
        } catch (e) {
            console.error("follow-ups failed:", e)
            logList.replaceChildren(el("li", "log-empty error-text", "โหลดประวัติไม่สำเร็จ"))
        }
    }

    // Reload this channel's history, then the row's counts and last contact
    // (which spans both channels, so it comes from the server).
    const refreshAfterChange = async (p: Pending, channel: Channel, btn: HTMLElement): Promise<void> => {
        if (!openMonth) return
        const q = "month=" + encodeURIComponent(openMonth.key) + "&index=" + encodeURIComponent(p.index) + "&channel=" + channel
        // refresh=1: the page's own reload, not a fresh look (left out of the audit log)
        const data: { entries: Entry[] } = await api("/dashboard/api/followups?" + q + "&refresh=1")
        renderLog(data.entries)
        p[channel] = data.entries.length
        try {
            const list: { physicians: Pending[] } = await api("/dashboard/api/pending?month=" + encodeURIComponent(openMonth.key) + "&refresh=1")
            const fresh = list.physicians.find(x => x.index === p.index)
            if (fresh) { p.phone = fresh.phone; p.line = fresh.line; p.lastContactAt = fresh.lastContactAt }
        } catch (e) {
            console.error("pending refresh failed:", e)
        }
        ;(btn as any).refresh()
        const last = btn.closest(".pending-row")?.querySelector(".last")
        if (last) {
            last.className = "last" + (p.lastContactAt ? "" : " none")
            last.textContent = p.lastContactAt ? "ติดต่อล่าสุด " + fmtWhen(p.lastContactAt) : "ยังไม่ได้ติดต่อ"
        }
    }

    const showLogError = (msg: string): void => {
        logError.textContent = msg
        logError.classList.remove("hidden")
    }

    const deleteEntry = async (e: Entry, no: number, del: HTMLButtonElement): Promise<void> => {
        if (!logTarget) return
        if (!confirm("ลบบันทึกครั้งที่ " + no + "?\n" + (e.note || "(ไม่มีข้อความ)"))) return
        const { p, channel, btn } = logTarget
        del.disabled = true
        logError.classList.add("hidden")
        try {
            await api("/dashboard/api/followups/" + e.id, { method: "DELETE" })
        } catch (err) {
            // 404: someone else already deleted it, so just refresh below.
            if (!(err instanceof Error && err.message === "HTTP 404")) {
                console.error("delete follow-up failed:", err)
                showLogError("ลบไม่สำเร็จ กรุณาลองใหม่")
                del.disabled = false
                return
            }
        }
        // The delete went through; a failed reload must not read as a failed delete.
        try {
            await refreshAfterChange(p, channel, btn)
        } catch (err) {
            console.error("refresh after delete failed:", err)
            showLogError("ลบแล้ว แต่โหลดประวัติใหม่ไม่สำเร็จ กรุณาเปิดใหม่")
        }
    }

    logForm.addEventListener("submit", async (ev) => {
        ev.preventDefault()
        if (!logTarget || !openMonth || logSubmit.disabled) return
        const { p, channel, btn } = logTarget
        const label = logSubmit.textContent
        logSubmit.disabled = true
        logSubmit.setAttribute("aria-busy", "true")
        logSubmit.replaceChildren(el("span", "spinner"), document.createTextNode("กำลังบันทึก…"))
        logError.classList.add("hidden")
        try {
            await api("/dashboard/api/followups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ month: openMonth.key, index: p.index, channel, note: logNote.value }),
            })
        } catch (e) {
            console.error("save follow-up failed:", e)
            showLogError("บันทึกไม่สำเร็จ กรุณาลองใหม่")
            logSubmit.textContent = label
            logSubmit.removeAttribute("aria-busy")
            logSubmit.disabled = false
            return
        }
        // Saved: clear the note now so a failed reload can't lead to a duplicate entry.
        logNote.value = ""
        syncPresets()
        try {
            await refreshAfterChange(p, channel, btn)
        } catch (e) {
            console.error("refresh after save failed:", e)
            showLogError("บันทึกแล้ว แต่โหลดประวัติใหม่ไม่สำเร็จ กรุณาเปิดใหม่")
            logSubmit.textContent = label
        } finally {
            logSubmit.removeAttribute("aria-busy")
            logSubmit.disabled = false
        }
    })

    // view: the tab the user just opened (logged); none for a background refresh.
    async function loadOverview(view?: string): Promise<void> {
        monthsEl.setAttribute("aria-busy", "true")
        try {
            const r = await fetch("/dashboard/api/overview" + (view ? "?view=" + view : ""), { credentials: "same-origin" })
            if (r.status === 401) { location.href = "/dashboard/login"; return }
            if (!r.ok) throw new Error("HTTP " + r.status)
            const data: { months: MonthStatus[] } = await r.json()
            months = data.months
            errorEl.classList.add("hidden")
            render()
        } catch (e) {
            console.error("overview failed:", e)
            monthsEl.replaceChildren()
            errorEl.classList.remove("hidden")
        } finally {
            monthsEl.setAttribute("aria-busy", "false")
        }
    }


    // ── ประวัติการใช้งาน (owner only) ────────────────────────────────────
    interface AuditEntry {
        id: number
        created_at: string
        actor_line_id: string
        actor_name: string
        action: string
        target: Record<string, any>
        ip: string
        user_agent: string
    }
    const auditRows   = document.getElementById("audit-rows") as HTMLElement
    const auditWrap   = auditRows.closest(".audit-table-wrap") as HTMLElement
    const auditActor  = document.getElementById("audit-actor") as HTMLSelectElement
    const auditGroup  = document.getElementById("audit-group") as HTMLSelectElement
    const auditFrom   = document.getElementById("audit-from") as HTMLInputElement
    const auditTo     = document.getElementById("audit-to") as HTMLInputElement
    const auditReset  = document.getElementById("audit-reset") as HTMLButtonElement
    const auditNav    = document.getElementById("audit-nav") as HTMLElement

    const ACTION_LABEL: Record<string, string> = {
        "login.success": "เข้าสู่ระบบ",
        "login.refused": "ถูกปฏิเสธการเข้าสู่ระบบ",
        "session.logout": "ออกจากระบบ",
        "session.idle": "ออกจากระบบอัตโนมัติ",
        "view.overview": "เปิดแท็บภาพรวม",
        "view.followup": "เปิดแท็บตามส่ง",
        "pending.open": "เปิดรายชื่อผู้ที่ยังไม่ส่ง",
        "followup.history": "เปิดประวัติการติดต่อ",
        "followup.add": "เพิ่มบันทึก",
        "followup.delete": "ลบบันทึก",
        "audit.view": "เปิดประวัติการใช้งาน",
        "view.roster": "เปิดแท็บรายชื่อ",
        "roster.add": "เพิ่มรายชื่อ",
        "roster.edit": "แก้ไขรายชื่อ",
        "roster.delete": "ลบรายชื่อ",
        "access.approve": "อนุมัติคำขอเข้าใช้งาน",
        "access.reject": "ปฏิเสธคำขอเข้าใช้งาน",
    }
    const GROUP_LABEL: Record<string, string> = {
        change: "การแก้ไข", view: "การเปิดดู", login: "เข้าสู่ระบบ", refused: "ถูกปฏิเสธ", session: "ออกจากระบบ",
    }
    // Roster columns in Thai, for the form and the audit log.
    const FIELD_LABEL: Record<string, string> = {
        prefix: "คำนำหน้า", firstname: "ชื่อ", lastname: "นามสกุล", department: "กลุ่มงาน", position: "ตำแหน่ง",
        type: "ประเภทบุคลากร", rank: "ระดับ", score: "คะแนน", submitted_at: "ส่งไฟล์เมื่อ",
    }
    const auditValue = (k: string, v: unknown): string => {
        if (v === null || v === undefined || v === "") return "—"
        if (k === "submitted_at") return fmtWhen(String(v))
        if (typeof v === "number") return v.toLocaleString("th-TH", { maximumFractionDigits: 2 })
        return String(v)
    }
    const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]
    // "2569_09" → "ก.ย. 2569"
    const monthLabel = (key: unknown): string => {
        const m = /^(\d{4})_(\d{2})$/.exec(String(key || ""))
        return m ? THAI_MONTHS[Number(m[2]) - 1] + " " + m[1] : ""
    }

    // One readable line of what the action touched; the note is quoted.
    const auditDetail = (a: AuditEntry): HTMLElement => {
        const t = a.target || {}
        const td = el("td", "detail")
        const parts: string[] = []
        const add = (s: unknown): void => { if (s !== undefined && s !== null && s !== "") parts.push(String(s)) }
        switch (a.action) {
            case "pending.open":
                add(monthLabel(t.month)); add("ยังไม่ส่ง " + fmtNum(Number(t.unsent) || 0) + " คน")
                break
            case "followup.history":
                add(monthLabel(t.month)); add(t.physician); add(CHANNEL_LABEL[t.channel as Channel]); add("มี " + fmtNum(Number(t.entries) || 0) + " ครั้ง")
                break
            case "followup.add":
            case "followup.delete":
                add(monthLabel(t.month)); add(t.physician); add(CHANNEL_LABEL[t.channel as Channel])
                if (a.action === "followup.delete" && t.logged_by) add("บันทึกโดย " + t.logged_by + (t.logged_at ? " " + fmtWhen(t.logged_at) : ""))
                break
            case "login.refused":
                add("LINE " + a.actor_line_id)
                break
            case "audit.view":
                if (t.group) add(GROUP_LABEL[t.group] || t.group)
                if (t.from || t.to) add((t.from || "…") + " ถึง " + (t.to || "…"))
                break
            case "view.roster":
                add(monthLabel(t.month)); add(fmtNum(Number(t.rows) || 0) + " คน")
                break
            case "roster.add":
            case "roster.delete":
                add(monthLabel(t.month)); add(t.physician); add(t.row && t.row.department)
                break
            case "roster.edit":
                add(monthLabel(t.month)); add(t.physician)
                // "คะแนน 2,410 → 2,455"
                for (const [k, v] of Object.entries((t.changes || {}) as Record<string, [unknown, unknown]>)) {
                    add((FIELD_LABEL[k] || k) + " " + auditValue(k, v[0]) + " → " + auditValue(k, v[1]))
                }
                break
            case "access.approve":
            case "access.reject":
                add(t.name); add(t.email); add(t.department)
                break
        }
        td.textContent = parts.join(" · ")
        if ((a.action === "followup.add" || a.action === "followup.delete") && t.note) {
            td.appendChild(document.createTextNode(parts.length ? " · " : ""))
            td.appendChild(el("q", undefined, String(t.note)))
        }
        // Rows are one line; the whole text is in the tooltip.
        td.title = td.textContent || ""
        return td
    }

    const auditRow = (a: AuditEntry): HTMLElement => {
        const tr = el("tr", /\.(delete|reject)$/.test(a.action) || a.action === "login.refused" ? "warn"
            : /^(followup\.add|roster\.(add|edit)|access\.approve)$/.test(a.action) ? "change" : "")
        tr.appendChild(el("td", "when", fmtWhen(a.created_at)))
        const who = el("td", "who", a.actor_name || "—")
        who.title = a.actor_name
        tr.appendChild(who)
        tr.appendChild(el("td", "what", ACTION_LABEL[a.action] || a.action))
        tr.appendChild(auditDetail(a))
        const ip = el("td", "ip", a.ip || "—")
        if (a.user_agent) ip.title = a.user_agent
        tr.appendChild(ip)
        return tr
    }

    // Entries arrive 50 at a time, newest first (?before= pages back); the
    // table scrolls inside its box and the next 50 load as the bottom nears.
    let auditAll: AuditEntry[] = []
    let auditHasMore = false
    let auditLoadingMore = false
    let auditSeq = 0
    const auditQuery = (): string => {
        const q = new URLSearchParams()
        if (auditActor.value) q.set("actor", auditActor.value)
        if (auditGroup.value) q.set("group", auditGroup.value)
        if (auditFrom.value) q.set("from", auditFrom.value)
        if (auditTo.value) q.set("to", auditTo.value)
        return q.toString()
    }
    const emptyRow = (text: string, cls?: string): HTMLElement => {
        const tr = el("tr")
        const td = el("td", "audit-empty" + (cls ? " " + cls : ""), text)
        td.setAttribute("colspan", "5")
        tr.appendChild(td)
        return tr
    }
    const showAudit = (): void => {
        auditRows.replaceChildren(...(auditAll.length ? auditAll.map(auditRow) : [emptyRow("ไม่มีรายการ")]))
    }
    const fetchAudit = async (before: number | null): Promise<{ entries: AuditEntry[]; more: boolean; actors: { id: string; name: string }[] }> => {
        let q = auditQuery()
        if (before !== null) q += (q ? "&" : "") + "before=" + before
        return api("/dashboard/api/audit" + (q ? "?" + q : ""))
    }

    // A filter change (or opening the tab) starts again from the newest entry.
    async function loadAudit(): Promise<void> {
        const seq = ++auditSeq
        auditAll = []
        auditHasMore = false
        auditLoadingMore = false
        auditWrap.scrollTop = 0
        auditRows.replaceChildren(emptyRow("กำลังโหลด…"))
        try {
            const data = await fetchAudit(null)
            if (seq !== auditSeq) return
            // Keep the chosen person while refreshing the list of names.
            const chosen = auditActor.value
            auditActor.replaceChildren(el("option", undefined, "ทุกคน"), ...data.actors.map((p) => {
                const o = el("option", undefined, p.name || p.id) as HTMLOptionElement
                o.value = p.id
                return o
            }))
            ;(auditActor.options[0] as HTMLOptionElement).value = ""
            auditActor.value = chosen
            auditAll = data.entries
            auditHasMore = data.more
            showAudit()
            void auditMore()
        } catch (e) {
            if (seq !== auditSeq) return
            console.error("audit failed:", e)
            auditRows.replaceChildren(emptyRow("โหลดประวัติการใช้งานไม่สำเร็จ กรุณาลองใหม่", "error-text"))
        }
    }

    // Load the next 50 while the bottom is within a screenful (or the box isn't full yet).
    async function auditMore(): Promise<void> {
        const seq = auditSeq
        while (auditHasMore && !auditLoadingMore && seq === auditSeq &&
            auditWrap.scrollHeight - auditWrap.scrollTop - auditWrap.clientHeight < auditWrap.clientHeight) {
            auditLoadingMore = true
            try {
                const data = await fetchAudit(auditAll[auditAll.length - 1].id)
                if (seq !== auditSeq) return
                auditAll = auditAll.concat(data.entries)
                auditHasMore = data.more
                auditRows.append(...data.entries.map(auditRow))
            } catch (e) {
                console.error("audit more failed:", e)
                return
            } finally {
                if (seq === auditSeq) auditLoadingMore = false
            }
        }
    }
    auditWrap.addEventListener("scroll", () => { void auditMore() }, { passive: true })
    window.addEventListener("resize", () => { if (currentView() === "audit") void auditMore() })
    for (const f of [auditActor, auditGroup, auditFrom, auditTo]) f.addEventListener("change", () => { void loadAudit() })
    auditReset.addEventListener("click", () => {
        auditActor.value = ""; auditGroup.value = ""; auditFrom.value = ""; auditTo.value = ""
        void loadAudit()
    })

    // ── รายชื่อ: the LINE /admin/ roster editor, for every admin ────────
    // Same data and rules as admin/app.ts: one month table at a time
    // (newest first, this month by default), search by name or department,
    // a department filter, add / edit / delete a row, and the access
    // requests waiting for approval. Every write is in the audit log.
    interface ColumnMeta { column_name: string; data_type: string; is_pk: boolean }
    type RowRecord = Record<string, any>
    interface AccessRequest { email: string; name?: string | null; department?: string | null; requested_at?: string | null }

    // Same list and order as admin/app.ts's dep_array (INTERN last).
    const DEP_ARRAY = ["กุมารเวชกรรม", "จักษุวิทยา", "จิตเวชและยาเสพติด", "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", "นิติเวช", "ผู้ป่วยนอก", "พยาธิวิทยากายวิภาค", "รังสีวิทยา", "วิสัญญีวิทยา", "เวชกรรมฟื้นฟู", "เวชกรรมสังคม", "เวชศาสตร์ฉุกเฉิน", "ศัลยกรรม", "ศัลยกรรมออร์โธปิดิกส์", "สูติ-นรีเวชกรรม", "โสต ศอ นาสิก", "อาชีวเวชกรรม", "อายุรกรรม", "INTERN"]
    const sortDeps = (list: string[]): string[] => [...list].sort((a, b) => {
        const ia = DEP_ARRAY.indexOf(a)
        const ib = DEP_ARRAY.indexOf(b)
        if (ia === -1 && ib === -1) return a.localeCompare(b, "th")
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
    })
    const deptLabel = (d: string): string => d === "INTERN" ? "INTERN" : "กลุ่มงาน" + d
    // Form order: two to a row, กลุ่มงาน on its own; any other column after.
    const FIELD_ORDER = ["prefix", "position", "firstname", "lastname", "department", "type", "rank", "score", "submitted_at"]
    // Free-text columns that suggest the values already in the month.
    const SUGGEST = ["prefix", "position", "type", "rank"]
    const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'

    const rosterMonth   = document.getElementById("roster-month") as HTMLSelectElement
    const rosterSearch  = document.getElementById("roster-search") as HTMLInputElement
    const rosterDept    = document.getElementById("roster-dept") as HTMLSelectElement
    const rosterCount   = document.getElementById("roster-count") as HTMLElement
    const rosterRows    = document.getElementById("roster-rows") as HTMLElement
    const rosterWrap    = rosterRows.closest(".audit-table-wrap") as HTMLElement
    const rosterAdd     = document.getElementById("roster-add") as HTMLButtonElement
    const rosterDlg     = document.getElementById("roster-dialog") as HTMLDialogElement
    const rosterDlgT    = document.getElementById("roster-dialog-title") as HTMLElement
    const rosterDlgSub  = document.getElementById("roster-dialog-sub") as HTMLElement
    const rosterForm    = document.getElementById("roster-form") as HTMLFormElement
    const rosterFields  = document.getElementById("roster-fields") as HTMLElement
    const rosterError   = document.getElementById("roster-error") as HTMLElement
    const rosterSave    = document.getElementById("roster-save") as HTMLButtonElement
    const reqBtn        = document.getElementById("req-btn") as HTMLButtonElement
    const reqBadge      = document.getElementById("req-badge") as HTMLElement
    const reqDlg        = document.getElementById("req-dialog") as HTMLDialogElement
    const reqSub        = document.getElementById("req-sub") as HTMLElement
    const reqList       = document.getElementById("req-list") as HTMLElement
    for (const d of [rosterDlg, reqDlg]) d.addEventListener("click", (ev) => { if (ev.target === d) d.close() })

    let rosterCols: ColumnMeta[] = []
    let rosterAll: RowRecord[] = []
    let rosterShown: RowRecord[] = []
    let rosterTable = ""
    let rosterSeq = 0
    let rosterTables: string[] | null = null

    // Errors from the roster API carry the database's reason (e.g. a bad number).
    const rosterApi = async (url: string, init?: RequestInit): Promise<any> => {
        const r = await fetch(url, { credentials: "same-origin", ...init })
        if (r.status === 401) { location.href = "/dashboard/login?error=idle"; throw new Error("signed out") }
        const body = await r.json().catch(() => ({}))
        if (!r.ok) {
            const err = new Error(body.error || "HTTP " + r.status) as Error & { status?: number }
            err.status = r.status
            throw err
        }
        return body
    }

    // This month in Bangkok as a roster table name, e.g. "2569_10".
    const thisMonthKey = (): string => {
        const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).formatToParts(new Date())
        const get = (t: string): string => (p.find((x) => x.type === t) as Intl.DateTimeFormatPart).value
        return (Number(get("year")) + 543) + "_" + get("month")
    }
    // Prefix sticks to the first name: "นพ.สมชาย ใจดี"
    const fullName = (r: RowRecord): string =>
        (((r.prefix || "") + (r.firstname || "")).trim() + " " + (r.lastname || "")).trim().replace(/\s+/g, " ")
    // Sorted by name without the prefix, as on the LINE page.
    const sortName = (r: RowRecord): string => ((r.firstname || "") + " " + (r.lastname || "")).trim()
    const isTimestamp = (c: ColumnMeta): boolean => /timestamp/i.test(c.data_type || "")
    const isNumeric = (c: ColumnMeta): boolean => /double precision|numeric|integer|real|bigint/i.test(c.data_type || "")
    const fmtScore = (v: unknown): string =>
        v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 })
    // ISO → the value a datetime-local input wants, in Bangkok time.
    const toLocalInput = (iso: unknown): string => {
        if (!iso) return ""
        const d = new Date(String(iso))
        if (isNaN(d.getTime())) return ""
        return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 16)
    }
    const fromLocalInput = (v: string): string => new Date(v + ":00+07:00").toISOString()

    const rosterEmpty = (text: string, cls?: string): HTMLElement => {
        const tr = emptyRow(text, cls)
        ;(tr.firstElementChild as HTMLElement).setAttribute("colspan", "7")
        return tr
    }
    const rosterRow = (r: RowRecord, no: number): HTMLElement => {
        const tr = el("tr")
        tr.dataset.index = r.index
        tr.appendChild(el("td", "num", String(no)))
        const name = fullName(r) || "(ไม่มีชื่อ)"
        const nameTd = el("td", "name", name)
        nameTd.title = name + (r.position ? " · " + r.position : "")
        tr.appendChild(nameTd)
        const dept = el("td", r.department ? "" : "muted", r.department || "—")
        dept.title = r.department || ""
        tr.appendChild(dept)
        const kind = [r.type, r.rank].filter(Boolean).join(" · ")
        const kindTd = el("td", "muted", kind || "—")
        kindTd.title = kind
        tr.appendChild(kindTd)
        tr.appendChild(el("td", "score", fmtScore(r.score)))
        tr.appendChild(el("td", "sent" + (r.submitted_at ? "" : " none"), r.submitted_at ? fmtWhen(r.submitted_at) : "ยังไม่ส่ง"))
        const acts = el("td", "acts")
        const edit = el("button", "icon-btn") as HTMLButtonElement
        edit.type = "button"
        edit.innerHTML = EDIT_SVG
        edit.title = "แก้ไข"
        edit.setAttribute("aria-label", "แก้ไข " + name)
        edit.addEventListener("click", () => openRosterForm(r))
        const del = el("button", "icon-btn del") as HTMLButtonElement
        del.type = "button"
        del.innerHTML = TRASH_SVG
        del.title = "ลบ"
        del.setAttribute("aria-label", "ลบ " + name)
        del.addEventListener("click", () => { void deleteRosterRow(r, del) })
        acts.appendChild(edit)
        acts.appendChild(del)
        tr.appendChild(acts)
        return tr
    }

    const showRoster = (): void => {
        rosterRows.replaceChildren(...(rosterShown.length ? rosterShown.map((r, i) => rosterRow(r, i + 1))
            : [rosterEmpty(rosterAll.length ? "ไม่พบรายชื่อที่ค้นหา" : "ยังไม่มีรายชื่อในเดือนนี้")]))
    }

    const populateDept = (): void => {
        const present = sortDeps([...new Set(rosterAll.map((r) => r.department).filter(Boolean) as string[])])
        const chosen = rosterDept.value
        rosterDept.replaceChildren(el("option", undefined, "ทุกกลุ่มงาน"), ...present.map((d) => {
            const o = el("option", undefined, deptLabel(d)) as HTMLOptionElement
            o.value = d
            return o
        }))
        ;(rosterDept.options[0] as HTMLOptionElement).value = ""
        rosterDept.value = present.includes(chosen) ? chosen : ""
    }

    const applyRosterFilter = (): void => {
        const q = rosterSearch.value.trim().toLowerCase()
        const dept = rosterDept.value
        rosterShown = rosterAll.filter((r) => {
            if (dept && r.department !== dept) return false
            return !q || (fullName(r) + " " + (r.department || "")).toLowerCase().includes(q)
        }).sort((a, b) => sortName(a).localeCompare(sortName(b), "th"))
        rosterCount.textContent = fmtNum(rosterShown.length) + " จาก " + fmtNum(rosterAll.length) + " คน"
        showRoster()
    }

    // Reload the month; the list stays where it was scrolled, or scrolls to `focus`.
    const reloadRoster = async (focus?: string): Promise<void> => {
        const seq = ++rosterSeq
        const data: { columns: ColumnMeta[]; rows: RowRecord[] } =
            await rosterApi("/dashboard/api/roster/" + encodeURIComponent(rosterTable) + "?refresh=1")
        if (seq !== rosterSeq) return
        rosterCols = data.columns
        rosterAll = data.rows
        populateDept()
        rosterShown = []
        applyRosterFilter()
        if (focus) {
            let at = rosterShown.findIndex((r) => r.index === focus)
            if (at === -1 && (rosterSearch.value || rosterDept.value)) {
                // The saved row is hidden by the filter: clear it so it shows.
                rosterSearch.value = ""
                rosterDept.value = ""
                applyRosterFilter()
                at = rosterShown.findIndex((r) => r.index === focus)
            }
            if (at !== -1) {
                const tr = rosterRows.querySelector('tr[data-index="' + focus + '"]') as HTMLElement | null
                if (tr) {
                    tr.scrollIntoView({ block: "nearest" })
                    tr.classList.add("flash")
                    setTimeout(() => tr.classList.remove("flash"), 2400)
                }
            }
        }
    }

    // logged: the user opened the tab or picked a month (written to the audit log).
    async function loadRoster(logged: boolean): Promise<void> {
        const seq = ++rosterSeq
        rosterRows.replaceChildren(rosterEmpty("กำลังโหลด…"))
        rosterWrap.scrollTop = 0
        void loadRequests()
        try {
            if (!rosterTables) {
                const t: { tables: string[] } = await rosterApi("/dashboard/api/roster")
                rosterTables = t.tables
                rosterMonth.replaceChildren(...rosterTables.map((k) => {
                    const o = el("option", undefined, monthLabel(k) || k) as HTMLOptionElement
                    o.value = k
                    return o
                }))
                const now = thisMonthKey()
                rosterMonth.value = rosterTables.includes(now) ? now : (rosterTables[0] || "")
            }
            rosterTable = rosterMonth.value
            if (!rosterTable) {
                rosterRows.replaceChildren(rosterEmpty("ยังไม่มีตารางรายชื่อ"))
                return
            }
            const data: { columns: ColumnMeta[]; rows: RowRecord[] } =
                await rosterApi("/dashboard/api/roster/" + encodeURIComponent(rosterTable) + (logged ? "" : "?refresh=1"))
            if (seq !== rosterSeq) return
            rosterCols = data.columns
            rosterAll = data.rows
            populateDept()
            applyRosterFilter()
        } catch (e) {
            if (seq !== rosterSeq) return
            console.error("roster failed:", e)
            rosterRows.replaceChildren(rosterEmpty("โหลดรายชื่อไม่สำเร็จ กรุณาลองใหม่", "error-text"))
        }
    }

    rosterMonth.addEventListener("change", () => { rosterDept.value = ""; void loadRoster(true) })
    rosterSearch.addEventListener("input", () => { applyRosterFilter(); rosterWrap.scrollTop = 0 })
    rosterDept.addEventListener("change", () => { applyRosterFilter(); rosterWrap.scrollTop = 0 })

    // ── Add / edit one row ──
    let rosterEditing: RowRecord | null = null

    const fieldFor = (c: ColumnMeta, value: any): HTMLElement => {
        const name = c.column_name
        const label = el("label", name === "department" ? "wide" : "")
        label.appendChild(document.createTextNode(FIELD_LABEL[name] || name))
        let input: HTMLInputElement | HTMLSelectElement
        if (name === "department") {
            // Only the canonical names; a legacy spelling stays as the first
            // option so saving without touching it doesn't change it.
            const sel = el("select") as HTMLSelectElement
            const opts = value && !DEP_ARRAY.includes(value) ? [value, ...DEP_ARRAY] : DEP_ARRAY
            sel.appendChild(el("option", undefined, "—"))
            ;(sel.options[0] as HTMLOptionElement).value = ""
            for (const d of opts) {
                const o = el("option", undefined, deptLabel(d)) as HTMLOptionElement
                o.value = d
                sel.appendChild(o)
            }
            sel.value = value || ""
            input = sel
        } else {
            const inp = el("input") as HTMLInputElement
            if (isTimestamp(c)) { inp.type = "datetime-local"; inp.value = toLocalInput(value) }
            else if (isNumeric(c)) { inp.type = "number"; inp.step = "any"; inp.value = value === null || value === undefined ? "" : String(value) }
            else { inp.type = "text"; inp.value = value === null || value === undefined ? "" : String(value) }
            // Almost everyone is นายแพทย์, as on the LINE page.
            if (name === "position" && !inp.value) inp.value = "นายแพทย์"
            if (SUGGEST.includes(name)) {
                const id = "roster-dl-" + name
                inp.setAttribute("list", id)
                const dl = el("datalist") as HTMLDataListElement
                dl.id = id
                for (const v of [...new Set(rosterAll.map((r) => r[name]).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "th"))) {
                    const o = el("option") as HTMLOptionElement
                    o.value = v
                    dl.appendChild(o)
                }
                label.appendChild(dl)
            }
            if (name === "firstname") inp.required = true
            inp.autocomplete = "off"
            input = inp
        }
        input.dataset.col = name
        // An edit sends only what changed, so an untouched time keeps its seconds.
        input.dataset.orig = input.value
        label.appendChild(input)
        return label
    }

    const openRosterForm = (row: RowRecord | null): void => {
        if (!rosterTable) return
        rosterEditing = row
        rosterDlgT.textContent = row ? "แก้ไขรายชื่อ" : "เพิ่มรายชื่อ"
        rosterDlgSub.textContent = (monthLabel(rosterTable) || rosterTable) + (row ? " · " + fullName(row) : "")
        const cols = rosterCols.filter((c) => !c.is_pk)
        const rank = (n: string): number => { const i = FIELD_ORDER.indexOf(n); return i === -1 ? 99 : i }
        cols.sort((a, b) => rank(a.column_name) - rank(b.column_name))
        rosterFields.replaceChildren(...cols.map((c) => fieldFor(c, row ? row[c.column_name] : null)))
        rosterError.classList.add("hidden")
        rosterSave.disabled = false
        rosterSave.removeAttribute("aria-busy")
        rosterSave.textContent = row ? "บันทึก" : "เพิ่ม"
        rosterDlg.showModal()
        const first = rosterFields.querySelector<HTMLInputElement>(row ? '[data-col="firstname"]' : '[data-col="prefix"]')
        if (first) first.focus()
    }
    rosterAdd.addEventListener("click", () => openRosterForm(null))

    const collectRoster = (): RowRecord => {
        const out: RowRecord = {}
        for (const input of Array.from(rosterFields.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-col]"))) {
            const name = input.dataset.col as string
            if (rosterEditing && input.value === input.dataset.orig) continue
            const col = rosterCols.find((c) => c.column_name === name)
            const v = input.value.trim()
            if (v === "") { out[name] = null; continue }
            if (col && isNumeric(col)) out[name] = Number(v)
            else if (col && isTimestamp(col)) out[name] = fromLocalInput(v)
            else out[name] = v
        }
        return out
    }

    rosterForm.addEventListener("submit", async (ev) => {
        ev.preventDefault()
        if (rosterSave.disabled) return
        const values = collectRoster()
        const showErr = (msg: string): void => { rosterError.textContent = msg; rosterError.classList.remove("hidden") }
        const first = (rosterFields.querySelector('[data-col="firstname"]') as HTMLInputElement | null)
        if (first && !first.value.trim()) {
            showErr("กรุณากรอกชื่อ")
            first.focus()
            return
        }
        if (rosterEditing && !Object.keys(values).length) { rosterDlg.close(); return }
        const label = rosterSave.textContent
        rosterSave.disabled = true
        rosterSave.setAttribute("aria-busy", "true")
        rosterSave.replaceChildren(el("span", "spinner"), document.createTextNode("กำลังบันทึก…"))
        rosterError.classList.add("hidden")
        const editing = rosterEditing
        let saved: RowRecord | null = null
        try {
            const url = "/dashboard/api/roster/" + encodeURIComponent(rosterTable) + (editing ? "/" + encodeURIComponent(editing.index) : "")
            const data = await rosterApi(url, {
                method: editing ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(values),
            })
            saved = data.row
        } catch (e) {
            console.error("roster save failed:", e)
            const status = (e as { status?: number }).status
            showErr(status === 404 ? "ไม่พบรายชื่อนี้แล้ว อาจถูกลบไปก่อนหน้า" : "บันทึกไม่สำเร็จ: " + (e as Error).message)
            rosterSave.textContent = label
            rosterSave.removeAttribute("aria-busy")
            rosterSave.disabled = false
            return
        }
        rosterDlg.close()
        try {
            await reloadRoster(saved ? saved.index : editing ? editing.index : undefined)
        } catch (e) {
            console.error("roster reload failed:", e)
            rosterRows.replaceChildren(rosterEmpty("บันทึกแล้ว แต่โหลดรายชื่อใหม่ไม่สำเร็จ กรุณารีเฟรช", "error-text"))
        }
    })

    const deleteRosterRow = async (r: RowRecord, btn: HTMLButtonElement): Promise<void> => {
        const name = fullName(r) || "(ไม่มีชื่อ)"
        if (!confirm("ลบ " + name + " ออกจากรายชื่อเดือน " + (monthLabel(rosterTable) || rosterTable) + "?")) return
        btn.disabled = true
        try {
            await rosterApi("/dashboard/api/roster/" + encodeURIComponent(rosterTable) + "/" + encodeURIComponent(r.index), { method: "DELETE" })
        } catch (e) {
            // 404: someone else already removed it, so just reload.
            if ((e as { status?: number }).status !== 404) {
                console.error("roster delete failed:", e)
                alert("ลบไม่สำเร็จ กรุณาลองใหม่")
                btn.disabled = false
                return
            }
        }
        try {
            await reloadRoster()
        } catch (e) {
            console.error("roster reload failed:", e)
            rosterAll = rosterAll.filter((x) => x !== r)
            applyRosterFilter()
        }
    }

    // ── Access requests ──
    const renderRequests = (list: AccessRequest[]): void => {
        reqBadge.textContent = String(list.length)
        reqBadge.classList.toggle("hidden", list.length === 0)
        reqBtn.setAttribute("aria-label", "คำขอเข้าใช้งาน " + list.length + " รายการ")
        reqSub.textContent = list.length ? "รออนุมัติ " + fmtNum(list.length) + " คน" : ""
        if (!list.length) {
            reqList.replaceChildren(el("li", "log-empty", "ไม่มีคำขอค้างอยู่"))
            return
        }
        reqList.replaceChildren(...list.map((q) => {
            const li = el("li", "req-row")
            const who = el("div")
            who.appendChild(el("div", "name", q.name || q.email))
            who.appendChild(el("div", "meta", [q.name ? q.email : "", q.department ? deptLabel(q.department) : "",
                q.requested_at ? "ขอเมื่อ " + fmtWhen(q.requested_at) : ""].filter(Boolean).join(" · ")))
            li.appendChild(who)
            const acts = el("div", "actions")
            const ok = el("button", "btn-primary", "อนุมัติ") as HTMLButtonElement
            ok.type = "button"
            const no = el("button", "btn-ghost reject", "ปฏิเสธ") as HTMLButtonElement
            no.type = "button"
            const decide = async (decision: "approve" | "reject"): Promise<void> => {
                if (decision === "reject" && !confirm("ปฏิเสธคำขอของ " + (q.name || q.email) + "?")) return
                ok.disabled = no.disabled = true
                try {
                    await rosterApi("/dashboard/api/access-requests/" + encodeURIComponent(q.email) + "/" + decision, { method: "POST" })
                } catch (e) {
                    if ((e as { status?: number }).status !== 404) {
                        console.error("access request failed:", e)
                        alert((decision === "approve" ? "อนุมัติ" : "ปฏิเสธ") + "ไม่สำเร็จ กรุณาลองใหม่")
                        ok.disabled = no.disabled = false
                        return
                    }
                }
                await loadRequests()
            }
            ok.addEventListener("click", () => { void decide("approve") })
            no.addEventListener("click", () => { void decide("reject") })
            acts.appendChild(ok)
            acts.appendChild(no)
            li.appendChild(acts)
            return li
        }))
    }
    async function loadRequests(): Promise<void> {
        try {
            const data: { requests: AccessRequest[] } = await rosterApi("/dashboard/api/access-requests")
            renderRequests(data.requests)
        } catch (e) {
            console.error("access requests failed:", e)
            if (reqDlg.open) reqList.replaceChildren(el("li", "log-empty error-text", "โหลดคำขอไม่สำเร็จ กรุณาลองใหม่"))
        }
    }
    reqBtn.addEventListener("click", () => {
        reqList.replaceChildren(el("li", "log-empty", "กำลังโหลด…"))
        reqDlg.showModal()
        void loadRequests()
    })

    // ── Boot ─────────────────────────────────────────────────────────────
    // main.ts only serves this page to a signed-in, allowlisted LINE user.
    // A 401 from either call means the session ended since the page
    // loaded: back to the login page.
    ;(async function main() {
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" })
            if (r.status === 401) { location.href = "/dashboard/login"; return }
            if (r.ok) {
                const session: { name?: string; isOwner?: boolean } = await r.json()
                const name = session.name || ""
                userName.textContent = name
                userAvatar.textContent = name ? Array.from(name)[0].toUpperCase() : ""
                isOwner = session.isOwner === true
                auditNav.classList.toggle("hidden", !isOwner)
            }
        } catch (e) {
            // Name stays blank; the page itself is already authorised.
        }

        render()
        const view = currentView()
        if (view === "audit") await loadAudit()
        else if (view === "roster") await loadRoster(true)
        else await loadOverview(view)
    })()
})()
