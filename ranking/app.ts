/** GENERATED FILE'S SOURCE — this file is compiled to ranking/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
// Wrapped in an IIFE (the original file was a bare top-level classic script,
// no wrapper) purely so its declarations don't collide, under tsc's
// whole-program type-check of every page script in this tsconfig together,
// with same-named top-level identifiers another page's script declares (e.g.
// status/app.ts's own `db`). Every one of these pages is still served, and
// runs, entirely on its own — nothing outside this file ever reads any of
// these names.
;(function () {
    // Supabase client + verification gate come from /assets/auth-guard.js
    const db = P4P.db as SupabaseClientLike

    const THAI_MONTHS_SHORT = P4P.THAI_MONTHS_SHORT
    const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

    const escHtml = P4P.escHtml

    interface MonthTab {
        key: string
        tab: string
        current: boolean
    }

    function buildMonths(): MonthTab[] {
        const FLOOR = "2569_04"
        const now = new Date()
        let y = now.getFullYear(), m = now.getMonth()
        const result: MonthTab[] = []
        while (result.length < 24) {
            const mo = String(m + 1).padStart(2, "0")
            const key = `${y + 543}_${mo}`
            // First tab = current month (its submission window is still open).
            result.push({ key, tab: `${THAI_MONTHS_SHORT[m]} ${y + 543}`, current: result.length === 0 })
            if (key === FLOOR) break
            if (m-- === 0) { m = 11; y-- }
        }
        return result
    }

    function deadlineISO(monthKey: string): string {
        const [beYear, mo] = monthKey.split("_").map(Number)
        const ceYear = beYear - 543
        const nextMo = mo === 12 ? 1 : mo + 1
        const nextYear = mo === 12 ? ceYear + 1 : ceYear
        const pad = (n: number) => String(n).padStart(2, "0")
        return `${nextYear}-${pad(nextMo)}-10T23:59:59+07:00`
    }

    function formatTime(isoStr: string): string {
        const d   = new Date(isoStr)
        const day = d.getDate()
        const mo  = THAI_MONTHS_SHORT[d.getMonth()]
        const h   = String(d.getHours()).padStart(2, "0")
        const min = String(d.getMinutes()).padStart(2, "0")
        return `${day} ${mo} · ${h}:${min}`
    }

    const months    = buildMonths()
    const tabsEl    = document.getElementById("tabs-inner") as HTMLElement
    const spinner   = document.getElementById("spinner") as HTMLElement
    const timeline  = document.getElementById("timeline") as HTMLElement
    const emptyEl   = document.getElementById("empty-state") as HTMLElement
    const contentEl = document.getElementById("content") as HTMLElement

    months.forEach((m, i) => {
        const btn = document.createElement("button")
        btn.className = "tab" + (i === 0 ? " active" : "") + (m.current ? " tab-current" : "")
        const liveDot = m.current ? `<span class="tab-live"></span>` : ""
        btn.innerHTML = `${liveDot}${m.tab}<span class="tab-underline"></span>`
        btn.onclick = () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"))
            btn.classList.add("active")
            contentEl.scrollTop = 0
            tabsEl.scrollTo({ left: btn.offsetLeft - (tabsEl.offsetWidth - btn.offsetWidth) / 2, behavior: "smooth" })
            loadMonth(m)
        }
        tabsEl.appendChild(btn)
    })

    interface RankingRow {
        firstname: string | null
        lastname: string | null
        department: string | null
        submitted_at: string
    }

    function renderRanking(data: RankingRow[] | null): void {
        timeline.innerHTML = ""

        if (!data || data.length === 0) {
            spinner.style.display  = "none"
            timeline.style.display = "none"
            emptyEl.style.display  = "block"
            contentEl.scrollTop = 0
            return
        }

        emptyEl.style.display = "none"

        data.forEach((row, i) => {
            const rank = i + 1
            const el = document.createElement("div")
            el.className = "tl-item" + (rank <= 3 ? ` r${rank}` : "")
            el.style.animationDelay = `${i * 0.04}s`
            const leadTag = rank === 1
                ? `<div class="lead-tag"><svg viewBox="0 0 24 24" fill="none"><path d="M5 3.5V20.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="4.5" width="12" height="7.5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="4.5" width="6" height="3.75" fill="currentColor"/><rect x="11" y="8.25" width="6" height="3.75" fill="currentColor"/></svg>ส่งเป็นคนแรก</div>` : ""
            const name = [row.firstname, row.lastname].filter(Boolean).join(" ") || "—"
            el.innerHTML = `
                <div class="tl-node">${rank}</div>
                ${leadTag}
                <div class="tl-name">${escHtml(name)}</div>
                <div class="tl-meta">
                    <span class="tl-dept">${escHtml(row.department ?? "—")}</span>
                    <span class="tl-sep"></span>
                    <span class="tl-time">${CLOCK_SVG}${formatTime(row.submitted_at)}</span>
                </div>`
            timeline.appendChild(el)
        })

        spinner.style.display  = "none"
        timeline.style.display = "block"
        contentEl.scrollTop = 0
    }

    async function loadMonth(monthObj: MonthTab): Promise<void> {
        spinner.style.display  = "block"
        timeline.style.display = "none"
        emptyEl.style.display  = "none"

        try {
            const subRes = await db.from(monthObj.key)
                .select("firstname, lastname, department, submitted_at")
                .not("submitted_at", "is", null)
                .lte("submitted_at", deadlineISO(monthObj.key))
                .order("submitted_at", { ascending: true })
                .limit(500)
            if (subRes.error) throw subRes.error
            renderRanking(subRes.data as RankingRow[])
        } catch (err) {
            console.error(err)
            spinner.style.display  = "none"
            timeline.style.display = "none"
            // The current month's table may not exist yet (created once the
            // first submission/admin setup happens) — treat that as "no one
            // has sent yet" instead of a generic error. Prefer the structured
            // Postgres error code (stable) over matching PostgREST's message
            // text (fragile — a wording change would silently break this).
            const e = err as { code?: string; message?: string } | null
            const tableMissing = e?.code === "42P01" ||
                /does not exist|undefined_table|schema cache/i.test(e?.message ?? "")
            if (tableMissing) {
                emptyEl.querySelector(".es-title")!.textContent = "ยังไม่มีการส่ง"
                emptyEl.querySelector(".es-sub")!.textContent   = "เดือนนี้ยังไม่มีแพทย์ส่งไฟล์ P4P"
            } else {
                emptyEl.querySelector(".es-title")!.textContent = "เกิดข้อผิดพลาด"
                emptyEl.querySelector(".es-sub")!.textContent   = "ไม่สามารถโหลดข้อมูลได้"
            }
            emptyEl.style.display = "block"
        }
    }

    // Only load data once the verification gate confirms a valid session
    // (P4P.ready never resolves when unverified — it redirects to /verify/).
    P4P.ready!.then(() => {
        const _block = document.getElementById("desktop-block") as HTMLElement
        if (/Line\//i.test(navigator.userAgent)) {
            loadMonth(months[0])
        } else if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
            _block.querySelector("h2")!.textContent = "กรุณาเปิดผ่าน LINE application"
            _block.querySelector("p")!.textContent  = "ขอบคุณสำหรับความร่วมมือ"
            _block.style.display = "flex"
        } else {
            _block.style.display = "flex"
        }
    })
})()
