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
    const navBtns    = Array.from(document.querySelectorAll<HTMLAnchorElement>(".nav-btn[data-view]"))

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
        audit: "ประวัติการใช้งาน — การเข้าใช้และการแก้ไขแดชบอร์ด",
    }
    const isComplete = (m: MonthStatus): boolean => m.exists && m.total > 0 && m.sent === m.total
    let months: MonthStatus[] | null = null
    // Set from /dashboard/api/session; only the owner gets the audit tab.
    let isOwner = false
    const auditView = document.getElementById("audit-view") as HTMLElement
    const currentView = (): string =>
        location.hash === "#followup" ? "followup" : location.hash === "#audit" && isOwner ? "audit" : "overview"
    const render = (): void => {
        const view = currentView()
        const audit = view === "audit"
        auditView.classList.toggle("hidden", !audit)
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
    const auditPrev   = document.getElementById("audit-prev") as HTMLButtonElement
    const auditNext   = document.getElementById("audit-next") as HTMLButtonElement
    const auditPage   = document.getElementById("audit-page") as HTMLElement
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
    }
    const GROUP_LABEL: Record<string, string> = {
        change: "เพิ่ม / ลบบันทึก", view: "การเปิดดู", login: "เข้าสู่ระบบ", refused: "ถูกปฏิเสธ", session: "ออกจากระบบ",
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
        const tr = el("tr", a.action === "followup.delete" || a.action === "login.refused" ? "warn"
            : a.action === "followup.add" ? "change" : "")
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
    // table shows one screenful of them and ก่อนหน้า / ถัดไป move between
    // screenfuls, fetching the next 50 only when the page needs them.
    let auditAll: AuditEntry[] = []
    let auditHasMore = false
    let auditPageNo = 0
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
    // Rows that fit below the table header (each row is a fixed 44px + border).
    const auditPageSize = (): number => {
        const head = (auditWrap.querySelector("thead") as HTMLElement).offsetHeight
        return Math.max(1, Math.floor((auditWrap.clientHeight - head) / 45))
    }
    let auditPageSizeAtLastShow = 1
    const showAuditPage = (): void => {
        const size = auditPageSize()
        auditPageSizeAtLastShow = size
        const from = auditPageNo * size
        const rows = auditAll.slice(from, from + size)
        auditRows.replaceChildren(...(rows.length ? rows.map(auditRow) : [emptyRow("ไม่มีรายการ")]))
        const lastLoaded = from + size >= auditAll.length
        auditPrev.disabled = auditPageNo === 0
        auditNext.disabled = lastLoaded && !auditHasMore
        const known = auditHasMore ? "" : " / " + Math.max(1, Math.ceil(auditAll.length / size))
        auditPage.textContent = "หน้า " + (auditPageNo + 1) + known
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
        auditPageNo = 0
        auditPrev.disabled = auditNext.disabled = true
        auditPage.textContent = ""
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
            showAuditPage()
        } catch (e) {
            if (seq !== auditSeq) return
            console.error("audit failed:", e)
            auditRows.replaceChildren(emptyRow("โหลดประวัติการใช้งานไม่สำเร็จ กรุณาลองใหม่", "error-text"))
        }
    }

    auditPrev.addEventListener("click", () => {
        if (auditPageNo === 0) return
        auditPageNo--
        showAuditPage()
    })
    auditNext.addEventListener("click", async () => {
        const seq = auditSeq
        const need = (auditPageNo + 2) * auditPageSize()
        auditNext.disabled = auditPrev.disabled = true
        try {
            while (auditAll.length < need && auditHasMore) {
                const data = await fetchAudit(auditAll[auditAll.length - 1].id)
                if (seq !== auditSeq) return
                auditAll = auditAll.concat(data.entries)
                auditHasMore = data.more
            }
            if (auditAll.length > (auditPageNo + 1) * auditPageSize()) auditPageNo++
        } catch (e) {
            console.error("audit page failed:", e)
        }
        if (seq === auditSeq) showAuditPage()
    })
    // A different window height fits a different number of rows: keep the
    // first entry on screen and re-cut the pages around it.
    let auditResizeTimer = 0
    window.addEventListener("resize", () => {
        clearTimeout(auditResizeTimer)
        auditResizeTimer = window.setTimeout(() => {
            if (currentView() !== "audit" || !auditAll.length) return
            const first = auditPageNo * auditPageSizeAtLastShow
            auditPageNo = Math.floor(first / auditPageSize())
            showAuditPage()
        }, 150)
    })
    for (const f of [auditActor, auditGroup, auditFrom, auditTo]) f.addEventListener("change", () => { void loadAudit() })
    auditReset.addEventListener("click", () => {
        auditActor.value = ""; auditGroup.value = ""; auditFrom.value = ""; auditTo.value = ""
        void loadAudit()
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
        else await loadOverview(view)
    })()
})()
