"use strict";
/** GENERATED FILE'S SOURCE — this file is compiled to dashboard/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
;
(function () {
    "use strict";
    // ── Desktop-only gate — the inverse of the LIFF pages' mobile gate ───
    const mobileBlock = document.getElementById("mobile-block");
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        mobileBlock.style.display = "flex";
        return;
    }
    // ── DOM refs ─────────────────────────────────────────────────────────
    const logoutBtn = document.getElementById("logout-btn");
    const userName = document.getElementById("user-name");
    const userAvatar = document.getElementById("user-avatar");
    const monthsEl = document.getElementById("months");
    const errorEl = document.getElementById("error");
    const emptyEl = document.getElementById("empty");
    const titleEl = document.getElementById("page-title");
    const navBtns = Array.from(document.querySelectorAll(".nav-btn[data-view]"));
    const CLOCK_SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    const signOut = async (to) => {
        await fetch("/dashboard/logout", { method: "POST", credentials: "same-origin" }).catch(() => { });
        location.href = to;
    };
    logoutBtn.addEventListener("click", () => { void signOut("/dashboard/login"); });
    // ── Idle sign-out ────────────────────────────────────────────────────
    // 15 minutes without a mouse, key, scroll or touch event signs the user
    // out. The server holds the same deadline in the session cookie, and
    // the keep-alive below (at most once a minute while active) slides it
    // forward, so a sleeping laptop or closed tab is signed out too.
    const IDLE_MS = 15 * 60 * 1000;
    const KEEPALIVE_MS = 60 * 1000;
    let lastActivity = Date.now();
    let lastKeepAlive = Date.now();
    const keepAlive = async () => {
        lastKeepAlive = Date.now();
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" });
            if (r.status === 401)
                location.href = "/dashboard/login?error=idle";
        }
        catch (e) {
            // Offline for a moment; the next activity retries.
        }
    };
    const checkIdle = () => {
        if (Date.now() - lastActivity < IDLE_MS)
            return false;
        void signOut("/dashboard/login?error=idle");
        return true;
    };
    const onActivity = () => {
        if (checkIdle())
            return;
        lastActivity = Date.now();
        if (lastActivity - lastKeepAlive >= KEEPALIVE_MS)
            void keepAlive();
    };
    for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"]) {
        window.addEventListener(ev, onActivity, { passive: true });
    }
    // Timers are throttled in background tabs, so also check on return.
    document.addEventListener("visibilitychange", () => { if (!document.hidden)
        checkIdle(); });
    setInterval(checkIdle, 15 * 1000);
    // ── Helpers ──────────────────────────────────────────────────────────
    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls)
            e.className = cls;
        if (text !== undefined)
            e.textContent = text;
        return e;
    };
    const fmtNum = (n) => n.toLocaleString("th-TH");
    // Thai short date and time in Bangkok, e.g. "17 ต.ค. 2569 11:18 น."
    const fmtWhen = (iso) => {
        const d = new Date(iso);
        const date = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" });
        const time = d.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
        return date + " " + time + " น.";
    };
    const renderMonth = (m) => {
        const card = el("article", "month-card glass");
        card.style.setProperty("--month", m.color);
        card.setAttribute("aria-label", m.name);
        const header = el("div", "card-header");
        header.appendChild(el("h2", "month-chip", m.name));
        card.appendChild(header);
        if (!m.exists) {
            card.classList.add("no-roster");
            header.appendChild(el("span", "badge idle", "ยังไม่มีรายชื่อ"));
            const content = el("div", "card-content");
            content.appendChild(el("p", undefined, "ยังไม่ได้สร้างรายชื่อแพทย์ของเดือนนี้"));
            card.appendChild(content);
            return card;
        }
        const pending = m.total - m.sent;
        const pct = m.total ? Math.round((m.sent / m.total) * 100) : 0;
        let badge;
        if (m.total > 0 && pending === 0) {
            card.classList.add("complete");
            badge = el("span", "badge done", "ส่งครบแล้ว");
        }
        else if (m.sent > 0) {
            badge = el("span", "badge open", "ดำเนินการส่ง");
        }
        else {
            badge = el("span", "badge idle", "ยังไม่มีผู้ส่ง");
        }
        header.appendChild(badge);
        const content = el("div", "card-content");
        const stat = el("div", "stat");
        stat.appendChild(el("span", "pct", pct + "%"));
        const of = el("span", "of");
        of.appendChild(el("b", undefined, fmtNum(m.sent)));
        of.appendChild(document.createTextNode(" จาก " + fmtNum(m.total) + " คน"));
        stat.appendChild(of);
        content.appendChild(stat);
        const progress = el("div", "progress");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", String(m.total));
        progress.setAttribute("aria-valuenow", String(m.sent));
        progress.setAttribute("aria-label", "ส่งแล้ว " + m.sent + " จาก " + m.total + " คน");
        const fill = el("span");
        fill.style.width = "0%";
        progress.appendChild(fill);
        content.appendChild(progress);
        // Next frame, so the bar animates in from zero.
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct + "%"; }));
        const split = el("dl", "split");
        const sentBox = el("div");
        sentBox.appendChild(el("dt", undefined, "ส่งแล้ว"));
        sentBox.appendChild(el("dd", undefined, fmtNum(m.sent)));
        const pendBox = el("div", "pending" + (pending === 0 ? " zero" : ""));
        pendBox.appendChild(el("dt", undefined, "ค้างส่ง"));
        pendBox.appendChild(el("dd", undefined, fmtNum(pending)));
        split.appendChild(sentBox);
        split.appendChild(pendBox);
        content.appendChild(split);
        card.appendChild(content);
        const footer = el("div", "card-footer");
        footer.innerHTML = CLOCK_SVG;
        footer.appendChild(el("span", undefined, m.lastSubmittedAt ? "ส่งล่าสุด " + fmtWhen(m.lastSubmittedAt) : "ยังไม่มีการส่งไฟล์"));
        card.appendChild(footer);
        return card;
    };
    // ── Tabs ─────────────────────────────────────────────────────────────
    // ภาพรวม shows all six months; ตามส่ง shows only the months not yet
    // complete. Both come from the one overview response; the URL hash
    // (#overview / #followup) picks the tab so it survives a refresh.
    const TITLES = {
        overview: "ภาพรวม — สถานะการส่งไฟล์ Excel 6 เดือนที่ผ่านมา",
        followup: "ตามส่ง — เดือนที่ยังส่งไฟล์ Excel ไม่ครบ",
    };
    const isComplete = (m) => m.exists && m.total > 0 && m.sent === m.total;
    let months = null;
    const currentView = () => (location.hash === "#followup" ? "followup" : "overview");
    const render = () => {
        const view = currentView();
        for (const a of navBtns) {
            const on = a.dataset.view === view;
            a.classList.toggle("active", on);
            if (on)
                a.setAttribute("aria-current", "page");
            else
                a.removeAttribute("aria-current");
        }
        titleEl.textContent = TITLES[view];
        if (!months)
            return;
        const shown = view === "followup" ? months.filter((m) => !isComplete(m)) : months;
        monthsEl.classList.toggle("followup", view === "followup");
        monthsEl.replaceChildren(...shown.map((m) => {
            const card = renderMonth(m);
            if (view === "followup" && m.exists) {
                card.classList.add("clickable");
                card.tabIndex = 0;
                card.setAttribute("role", "button");
                card.setAttribute("aria-label", m.name + " — ดูรายชื่อผู้ที่ยังไม่ส่ง");
                card.addEventListener("click", () => { void openPending(m); });
                card.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        void openPending(m);
                    }
                });
            }
            return card;
        }));
        emptyEl.classList.toggle("hidden", shown.length > 0);
        monthsEl.classList.toggle("hidden", shown.length === 0);
    };
    // ตามส่ง always shows fresh numbers: every visit to the tab reloads.
    window.addEventListener("hashchange", () => {
        if (currentView() === "followup")
            void loadOverview();
        else
            render();
    });
    render();
    const CHANNEL_LABEL = { phone: "โทรศัพท์", line: "LINE" };
    const PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    const LINE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#06C755"/><path fill="#fff" d="M12 5.2c-4.1 0-7.4 2.7-7.4 6 0 3 2.6 5.5 6.2 5.9.2 0 .6.2.7.4.1.2 0 .6 0 .8l-.1.6c0 .2-.2.7.6.4.8-.3 4.3-2.5 5.8-4.3 1-1.1 1.6-2.3 1.6-3.7 0-3.4-3.3-6.1-7.4-6.1z"/><path fill="#06C755" d="M8.2 9.5h-.6c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h2c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2H8.4V9.7c0-.1-.1-.2-.2-.2zm2.3 0h-.5c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h.5c.1 0 .2-.1.2-.2V9.7c0-.1-.1-.2-.2-.2zm3.5 0h-.5c-.1 0-.2.1-.2.2v2.1l-1.6-2.2-.2-.1h-.5c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h.5c.1 0 .2-.1.2-.2v-2.1l1.6 2.2.2.1h.5c.1 0 .2-.1.2-.2V9.7c0-.1-.1-.2-.2-.2zm2.6 0h-2c-.1 0-.2.1-.2.2v3.6c0 .1.1.2.2.2h2c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2h-1.3v-.6h1.3c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2h-1.3v-.6h1.3c.1 0 .2-.1.2-.2v-.5c0-.1-.1-.2-.2-.2z"/></svg>';
    const sheet = document.getElementById("pending-sheet");
    const sheetChip = document.getElementById("pending-chip");
    const sheetCount = document.getElementById("pending-count");
    const sheetList = document.getElementById("pending-list");
    const logDlg = document.getElementById("log-dialog");
    const logTitle = document.getElementById("log-title");
    const logSub = document.getElementById("log-sub");
    const logList = document.getElementById("log-list");
    const logForm = document.getElementById("log-form");
    const logNote = document.getElementById("log-note");
    const logSubmit = document.getElementById("log-submit");
    const logError = document.getElementById("log-error");
    for (const b of Array.from(document.querySelectorAll("[data-close]"))) {
        b.addEventListener("click", () => b.closest("dialog").close());
    }
    // A click on the dimmed backdrop (the dialog element itself) closes it.
    for (const d of [sheet, logDlg])
        d.addEventListener("click", (ev) => { if (ev.target === d)
            d.close(); });
    // Closing the list may mean calls were logged: refresh the cards.
    sheet.addEventListener("close", () => { void loadOverview(); });
    let openMonth = null;
    let logTarget = null;
    const api = async (url, init) => {
        const r = await fetch(url, { credentials: "same-origin", ...init });
        if (r.status === 401) {
            location.href = "/dashboard/login?error=idle";
            throw new Error("signed out");
        }
        if (!r.ok)
            throw new Error("HTTP " + r.status);
        return r.json();
    };
    const contactBtn = (p, channel) => {
        const b = el("button", "contact-btn " + channel);
        b.setAttribute("type", "button");
        const setLabel = () => {
            b.innerHTML = channel === "phone" ? PHONE_SVG : LINE_SVG;
            const n = p[channel];
            b.appendChild(el("span", "count" + (n ? "" : " zero"), String(n)));
            b.setAttribute("aria-label", CHANNEL_LABEL[channel] + " " + p.name + " — ติดต่อแล้ว " + n + " ครั้ง");
            b.title = CHANNEL_LABEL[channel] + " · ติดต่อแล้ว " + n + " ครั้ง";
        };
        setLabel();
        b.refresh = setLabel;
        b.addEventListener("click", () => { void openLog(p, channel, b); });
        return b;
    };
    const renderPending = (list) => {
        sheetCount.textContent = "ยังไม่ส่ง " + fmtNum(list.length) + " คน";
        if (!list.length) {
            sheetList.replaceChildren(el("p", "sheet-empty", "ทุกคนส่งไฟล์แล้ว"));
            return;
        }
        sheetList.replaceChildren(...list.map((p, i) => {
            const row = el("li", "pending-row");
            row.appendChild(el("span", "num", String(i + 1)));
            const who = el("div", "who");
            who.appendChild(el("span", "name", p.name));
            const meta = el("span", "meta", p.department);
            who.appendChild(meta);
            if (p.lastContactAt)
                who.appendChild(el("span", "meta last", "ติดต่อล่าสุด " + fmtWhen(p.lastContactAt)));
            row.appendChild(who);
            const actions = el("div", "actions");
            actions.appendChild(contactBtn(p, "phone"));
            actions.appendChild(contactBtn(p, "line"));
            row.appendChild(actions);
            return row;
        }));
    };
    const openPending = async (m) => {
        openMonth = m;
        sheet.style.setProperty("--month", m.color);
        sheetChip.textContent = m.name;
        sheetCount.textContent = "";
        sheetList.replaceChildren(...[0, 1, 2, 3, 4].map(() => el("li", "pending-row skeleton-row")));
        if (!sheet.open)
            sheet.showModal();
        try {
            const data = await api("/dashboard/api/pending?month=" + encodeURIComponent(m.key));
            if (openMonth === m)
                renderPending(data.physicians);
        }
        catch (e) {
            console.error("pending failed:", e);
            sheetList.replaceChildren(el("p", "sheet-empty error-text", "โหลดรายชื่อไม่สำเร็จ กรุณาลองใหม่"));
        }
    };
    const renderLog = (entries) => {
        if (!entries.length) {
            logList.replaceChildren(el("li", "log-empty", "ยังไม่มีบันทึกการติดต่อ"));
        }
        else {
            logList.replaceChildren(...entries.map((e, i) => {
                const li = el("li", "log-entry");
                li.appendChild(el("span", "time-no", "ครั้งที่ " + (i + 1)));
                const body = el("div", "log-body");
                body.appendChild(el("span", "when", fmtWhen(e.created_at) + (e.logged_by ? " · " + e.logged_by : "")));
                if (e.note)
                    body.appendChild(el("p", "note", e.note));
                li.appendChild(body);
                return li;
            }));
        }
        logSubmit.textContent = "บันทึกครั้งที่ " + (entries.length + 1);
        logList.scrollTop = logList.scrollHeight;
    };
    const openLog = async (p, channel, btn) => {
        if (!openMonth)
            return;
        logTarget = { p, channel, btn };
        logDlg.dataset.channel = channel;
        logTitle.textContent = CHANNEL_LABEL[channel] + " · " + p.name;
        logSub.textContent = openMonth.name + (p.department ? " · " + p.department : "");
        logList.replaceChildren(el("li", "log-empty", "กำลังโหลด…"));
        logNote.value = "";
        logError.classList.add("hidden");
        logSubmit.disabled = true;
        logDlg.showModal();
        try {
            const q = "month=" + encodeURIComponent(openMonth.key) + "&index=" + encodeURIComponent(p.index) + "&channel=" + channel;
            const data = await api("/dashboard/api/followups?" + q);
            renderLog(data.entries);
            logSubmit.disabled = false;
            logNote.focus();
        }
        catch (e) {
            console.error("follow-ups failed:", e);
            logList.replaceChildren(el("li", "log-empty error-text", "โหลดประวัติไม่สำเร็จ"));
        }
    };
    logForm.addEventListener("submit", async (ev) => {
        var _a;
        ev.preventDefault();
        if (!logTarget || !openMonth || logSubmit.disabled)
            return;
        const { p, channel, btn } = logTarget;
        logSubmit.disabled = true;
        logError.classList.add("hidden");
        try {
            await api("/dashboard/api/followups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ month: openMonth.key, index: p.index, channel, note: logNote.value }),
            });
            const q = "month=" + encodeURIComponent(openMonth.key) + "&index=" + encodeURIComponent(p.index) + "&channel=" + channel;
            const data = await api("/dashboard/api/followups?" + q);
            p[channel] = data.entries.length;
            p.lastContactAt = data.entries.length ? data.entries[data.entries.length - 1].created_at : p.lastContactAt;
            btn.refresh();
            const who = (_a = btn.closest(".pending-row")) === null || _a === void 0 ? void 0 : _a.querySelector(".who");
            if (who && p.lastContactAt) {
                const last = who.querySelector(".last") || who.appendChild(el("span", "meta last"));
                last.textContent = "ติดต่อล่าสุด " + fmtWhen(p.lastContactAt);
            }
            renderLog(data.entries);
            logNote.value = "";
        }
        catch (e) {
            console.error("save follow-up failed:", e);
            logError.classList.remove("hidden");
        }
        finally {
            logSubmit.disabled = false;
        }
    });
    async function loadOverview() {
        monthsEl.setAttribute("aria-busy", "true");
        try {
            const r = await fetch("/dashboard/api/overview", { credentials: "same-origin" });
            if (r.status === 401) {
                location.href = "/dashboard/login";
                return;
            }
            if (!r.ok)
                throw new Error("HTTP " + r.status);
            const data = await r.json();
            months = data.months;
            errorEl.classList.add("hidden");
            render();
        }
        catch (e) {
            console.error("overview failed:", e);
            monthsEl.replaceChildren();
            errorEl.classList.remove("hidden");
        }
        finally {
            monthsEl.setAttribute("aria-busy", "false");
        }
    }
    // ── Boot ─────────────────────────────────────────────────────────────
    // main.ts only serves this page to a signed-in, allowlisted LINE user.
    // A 401 from either call means the session ended since the page
    // loaded: back to the login page.
    ;
    (async function main() {
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" });
            if (r.status === 401) {
                location.href = "/dashboard/login";
                return;
            }
            if (r.ok) {
                const session = await r.json();
                const name = session.name || "";
                userName.textContent = name;
                userAvatar.textContent = name ? Array.from(name)[0].toUpperCase() : "";
            }
        }
        catch (e) {
            // Name stays blank; the page itself is already authorised.
        }
        await loadOverview();
    })();
})();
