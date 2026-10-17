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
    const updatedEl  = document.getElementById("updated") as HTMLElement

    const CLOCK_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'

    logoutBtn.addEventListener("click", async () => {
        await fetch("/dashboard/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.href = "/dashboard/login"
    })

    // ── Helpers ──────────────────────────────────────────────────────────
    const el = (tag: string, cls?: string, text?: string): HTMLElement => {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
    }

    const fmtNum = (n: number): string => n.toLocaleString("th-TH")

    // Thai short date and time in Bangkok, e.g. "17 ต.ค. 2569 11:18 น."
    const fmtWhen = (iso: string): string => {
        const d = new Date(iso)
        const date = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })
        const time = d.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })
        return date + " " + time + " น."
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
            badge = el("span", "badge open", "กำลังรับไฟล์")
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

    // ── Boot ─────────────────────────────────────────────────────────────
    // main.ts only serves this page to a signed-in, allowlisted LINE user.
    // A 401 from either call means the session ended since the page
    // loaded: back to the login page.
    ;(async function main() {
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" })
            if (r.status === 401) { location.href = "/dashboard/login"; return }
            if (r.ok) {
                const session: { name?: string } = await r.json()
                const name = session.name || ""
                userName.textContent = name
                userAvatar.textContent = name ? Array.from(name)[0].toUpperCase() : ""
            }
        } catch (e) {
            // Name stays blank; the page itself is already authorised.
        }

        try {
            const r = await fetch("/dashboard/api/overview", { credentials: "same-origin" })
            if (r.status === 401) { location.href = "/dashboard/login"; return }
            if (!r.ok) throw new Error("HTTP " + r.status)
            const data: { months: MonthStatus[] } = await r.json()
            monthsEl.replaceChildren(...data.months.map(renderMonth))
            updatedEl.textContent = "อัปเดต " + fmtWhen(new Date().toISOString())
        } catch (e) {
            console.error("overview failed:", e)
            monthsEl.replaceChildren()
            errorEl.classList.remove("hidden")
        } finally {
            monthsEl.setAttribute("aria-busy", "false")
        }
    })()
})()
