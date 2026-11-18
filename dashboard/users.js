"use strict";
/** GENERATED FILE'S SOURCE — compiled to dashboard/users.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin.
 *
 * The owner's users and rights (Pong, 2026-11-18: "Go QR"). The name chip in
 * the brown bar opens a menu with:
 *   เพิ่มผู้ใช้ด้วย QR   a QR that works once for 10 minutes; once someone
 *                       scans it, the same dialog becomes the approval panel:
 *                       the 4-digit code from their phone, the name to show
 *                       and the tabs they may see;
 *   ผู้ใช้งานและสิทธิ์    the requests waiting, and every user, with edit and
 *                       suspend.
 * Only the owner gets any of it: app.js sends the session here
 * ("dashboard:session") and this file does nothing for anyone else. The
 * server checks every call again (main.ts, /dashboard/api/users*). Names are
 * always set with textContent.
 */
;
(function () {
    "use strict";
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
        return;
    const NOT_INSTALLED = "ยังไม่ได้ติดตั้ง — วาง scripts/dashboard-users-2026-11.sql ใน Supabase SQL editor";
    // The dialog's title already says ยังไม่ได้ติดตั้ง, so its body only says what to do.
    const PRESETS = [
        { key: "author", label: "ผู้จัดทำ", title: "เหมือนกานดา", perms: ["followup.edit", "followup.view", "review.auditee", "roster.view", "staffing.view"] },
        { key: "view", label: "ดูอย่างเดียว", perms: ["followup.view", "roster.view", "staffing.view"] },
        { key: "clear", label: "ล้าง", perms: [] },
    ];
    // ── Helpers ──────────────────────────────────────────────────────────
    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls)
            e.className = cls;
        if (text !== undefined)
            e.textContent = text;
        return e;
    };
    const btn = (cls, text, onClick, iconName) => {
        const b = el("button", cls);
        b.type = "button";
        if (iconName)
            b.appendChild(iconEl(iconName));
        b.appendChild(document.createTextNode(text));
        b.addEventListener("click", onClick);
        return b;
    };
    const fillIcons = (root) => {
        for (const s of Array.from(root.querySelectorAll("[data-icon]"))) {
            if (!s.firstChild)
                s.replaceWith(iconEl(s.dataset.icon || ""));
        }
    };
    const sortPerms = (p) => {
        const s = new Set(p);
        if (s.has("followup.edit"))
            s.add("followup.view");
        return Array.from(s).sort();
    };
    const samePerms = (a, b) => sortPerms(a).join() === sortPerms(b).join();
    // "ตามส่ง (บันทึก) · รายชื่อ (ดู) · อัตรากำลัง (ดู) · ตรวจสอบ (ผู้จัดทำ)"
    const permsSummary = (perms) => {
        const out = [];
        if (perms.includes("followup.edit"))
            out.push("ตามส่ง (บันทึก)");
        else if (perms.includes("followup.view"))
            out.push("ตามส่ง (ดู)");
        if (perms.includes("roster.view"))
            out.push("รายชื่อ (ดู)");
        if (perms.includes("staffing.view"))
            out.push("อัตรากำลัง (ดู)");
        if (perms.includes("review.auditee"))
            out.push("ตรวจสอบ (ผู้จัดทำ)");
        return out.length ? out.join(" · ") : "ภาพรวมเท่านั้น";
    };
    const bkkTime = (iso) => iso
        ? new Date(iso).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }) + " น."
        : "";
    // "18 พ.ย. 69"
    const bkkDate = (iso) => iso
        ? new Date(iso).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit" })
        : "–";
    const initial = (name) => (Array.from(name.trim())[0] || "?").toUpperCase();
    class HttpError extends Error {
        constructor(status, body) { super("HTTP " + status); this.status = status; this.body = body; }
    }
    const api = async (url, method = "GET", body, keepalive = false) => {
        const init = { method, credentials: "same-origin", keepalive };
        if (method !== "GET") {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body || {});
        }
        const r = await fetch(url, init);
        if (r.status === 401) {
            location.href = "/dashboard/login?error=idle";
            throw new HttpError(401, {});
        }
        const data = await r.json().catch(() => ({}));
        if (!r.ok)
            throw new HttpError(r.status, data || {});
        // Typed by each caller's own annotation.
        return data;
    };
    let toastTimer = 0;
    const toast = (text) => {
        let t = document.getElementById("um-toast");
        if (!t) {
            t = el("div", "um-toast");
            t.id = "um-toast";
            t.setAttribute("role", "status");
            document.body.appendChild(t);
        }
        t.textContent = text;
        t.classList.remove("hidden");
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => t.classList.add("hidden"), 3500);
    };
    const ROWS = [
        { name: "ภาพรวม", locked: "ดู (ทุกคน)", note: "งบ: เฉพาะผู้ดูแล" },
        { name: "ตามส่ง", choices: [{ label: "ไม่เห็น", perms: [] }, { label: "ดู", perms: ["followup.view"] }, { label: "บันทึก", perms: ["followup.view", "followup.edit"] }],
            note: "บันทึก = เพิ่ม/ลบบันทึกการติดตาม", hint: true },
        { name: "รายชื่อ", choices: [{ label: "ไม่เห็น", perms: [] }, { label: "ดู", perms: ["roster.view"] }], note: "แก้ไข: เฉพาะผู้ดูแล" },
        { name: "อัตรากำลัง", choices: [{ label: "ไม่เห็น", perms: [] }, { label: "ดู", perms: ["staffing.view"] }], note: "แก้ไข: เฉพาะผู้ดูแล" },
        { name: "ตรวจสอบ", choices: [{ label: "ไม่เห็น", perms: [] }, { label: "ผู้จัดทำ", perms: ["review.auditee"] }], note: "ผู้ตรวจสอบ: เฉพาะผู้ดูแล" },
        { name: "ประวัติการใช้งาน", locked: "เฉพาะผู้ดูแล", lockIcon: true, note: "" },
    ];
    function buildMatrix(start, onChange) {
        const root = el("div", "um-matrix");
        const picks = [];
        const setters = [];
        for (const r of ROWS) {
            const row = el("div", "um-r");
            row.appendChild(el("b", undefined, r.name));
            if (r.locked) {
                const l = el("span", "um-locked");
                if (r.lockIcon)
                    l.appendChild(iconEl("lock"));
                l.appendChild(document.createTextNode(r.locked));
                row.appendChild(l);
            }
            else if (r.choices) {
                const choices = r.choices;
                const seg = el("div", "um-seg");
                seg.setAttribute("role", "radiogroup");
                seg.setAttribute("aria-label", r.name);
                let cur = 0;
                const buttons = choices.map((c, i) => {
                    const b = el("button", undefined, c.label);
                    b.type = "button";
                    b.setAttribute("role", "radio");
                    b.addEventListener("click", () => { pick(i); onChange(); });
                    b.addEventListener("keydown", (ev) => {
                        const d = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
                        if (!d)
                            return;
                        ev.preventDefault();
                        const n = (cur + d + choices.length) % choices.length;
                        pick(n);
                        buttons[n].focus();
                        onChange();
                    });
                    seg.appendChild(b);
                    return b;
                });
                const pick = (i) => {
                    cur = i;
                    buttons.forEach((b, j) => { b.setAttribute("aria-checked", String(j === i)); b.tabIndex = j === i ? 0 : -1; });
                };
                picks.push(() => choices[cur].perms);
                setters.push((p) => {
                    // The widest choice the rights hold.
                    let best = 0;
                    choices.forEach((c, i) => { if (c.perms.every((k) => p.includes(k)))
                        best = i; });
                    pick(best);
                });
                row.appendChild(seg);
            }
            row.appendChild(el("small", undefined, r.note));
            root.appendChild(row);
        }
        const m = {
            root,
            get: () => sortPerms(picks.flatMap((f) => f())),
            set: (p) => setters.forEach((f) => f(p)),
        };
        m.set(start);
        return m;
    }
    // The preset chips above a matrix, and the summary line under it.
    function rightsBlock(start, onChange) {
        const root = el("div");
        const chips = el("div", "um-chips");
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", "ชุดสิทธิ์สำเร็จรูป");
        const summary = el("p", "um-summary");
        summary.setAttribute("aria-live", "polite");
        const chipBtns = [];
        const sync = () => {
            const p = matrix.get();
            for (const [b, perms] of chipBtns)
                b.setAttribute("aria-pressed", String(samePerms(p, perms)));
            summary.replaceChildren(el("b", undefined, "สิทธิ์:"), document.createTextNode(" " + permsSummary(p)));
            onChange();
        };
        const matrix = buildMatrix(start, sync);
        for (const pr of PRESETS) {
            const b = btn("um-chip", pr.label, () => { matrix.set(pr.perms); sync(); });
            if (pr.title)
                b.title = pr.title;
            chipBtns.push([b, pr.perms]);
            chips.appendChild(b);
        }
        root.append(chips, matrix.root, summary, el("p", "um-foot-note", "เฉพาะผู้ดูแล: งบ · แก้ไขรายชื่อ/อัตรากำลัง · คำขอเข้าใช้งาน · ฝั่งผู้ตรวจสอบ · ประวัติการใช้งาน · จัดการผู้ใช้"));
        sync();
        return { root, matrix };
    }
    // ── Session, chip and menu ───────────────────────────────────────────
    let session = {};
    let installed = true;
    let pending = 0;
    let chip = null;
    const menu = document.getElementById("user-menu");
    const menuItems = Array.from(menu.querySelectorAll(".um-item"));
    const pendingPill = document.getElementById("um-pending");
    const inviteSub = document.getElementById("um-invite-sub");
    const usersSub = document.getElementById("um-users-sub");
    fillIcons(document);
    const updateBadge = () => {
        pendingPill.textContent = "รออนุมัติ " + pending;
        pendingPill.classList.toggle("hidden", !(installed && pending > 0));
        const dot = chip && chip.querySelector(".um-dot");
        if (dot)
            dot.classList.toggle("hidden", !(installed && pending > 0));
        if (chip)
            chip.setAttribute("aria-label", (session.name || "") + " — เมนูผู้ดูแลระบบ" + (installed && pending ? " (รออนุมัติ " + pending + ")" : ""));
        inviteSub.textContent = installed ? "ให้ผู้ใช้ใหม่สแกนด้วยแอป LINE" : NOT_INSTALLED;
        usersSub.textContent = installed ? "" : NOT_INSTALLED;
        usersSub.classList.toggle("hidden", installed);
    };
    // #user becomes a button with the avatar, the name and a chevron.
    const setupChip = () => {
        if (chip)
            return;
        const span = document.getElementById("user");
        const b = document.createElement("button");
        b.type = "button";
        b.id = "user";
        b.className = "userchip";
        b.title = span.title;
        b.setAttribute("aria-haspopup", "menu");
        b.setAttribute("aria-expanded", "false");
        b.setAttribute("aria-controls", "user-menu");
        const av = el("span", "um-av");
        const avatar = document.getElementById("user-avatar");
        av.appendChild(avatar);
        const dot = el("i", "um-dot hidden");
        dot.setAttribute("aria-hidden", "true");
        av.appendChild(dot);
        b.appendChild(av);
        b.appendChild(document.getElementById("user-name"));
        b.appendChild(iconEl("chevron-down", "um-chev"));
        span.replaceWith(b);
        chip = b;
        menu.setAttribute("aria-labelledby", "user");
        menu.removeAttribute("aria-label");
        document.getElementById("um-name").textContent = session.name || "";
        b.addEventListener("click", () => (menu.classList.contains("hidden") ? openMenu(false) : closeMenu(false)));
        b.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                ev.preventDefault();
                openMenu(true, ev.key === "ArrowUp");
            }
        });
    };
    const openMenu = (focusItem, last = false) => {
        if (!chip)
            return;
        menu.classList.remove("hidden");
        // Under the chip, right edges lined up (the menu sits in #header-actions,
        // which also holds ออกจากระบบ), but never past the window's left edge.
        const box = (menu.offsetParent || document.body).getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        const right = Math.min(box.right - c.right, box.right - 8 - menu.offsetWidth);
        menu.style.right = Math.max(0, Math.round(right)) + "px";
        chip.setAttribute("aria-expanded", "true");
        if (focusItem)
            menuItems[last ? menuItems.length - 1 : 0].focus();
        else
            menuItems[0].focus();
    };
    const closeMenu = (focusChip) => {
        if (menu.classList.contains("hidden"))
            return;
        menu.classList.add("hidden");
        if (chip) {
            chip.setAttribute("aria-expanded", "false");
            if (focusChip)
                chip.focus();
        }
    };
    menu.addEventListener("keydown", (ev) => {
        const i = menuItems.indexOf(document.activeElement);
        if (ev.key === "Escape") {
            ev.preventDefault();
            closeMenu(true);
        }
        else if (ev.key === "ArrowDown") {
            ev.preventDefault();
            menuItems[(i + 1) % menuItems.length].focus();
        }
        else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            menuItems[(i - 1 + menuItems.length) % menuItems.length].focus();
        }
        else if (ev.key === "Home") {
            ev.preventDefault();
            menuItems[0].focus();
        }
        else if (ev.key === "End") {
            ev.preventDefault();
            menuItems[menuItems.length - 1].focus();
        }
        else if (ev.key === "Tab")
            closeMenu(false);
    });
    document.addEventListener("mousedown", (ev) => {
        const t = ev.target;
        if (!menu.classList.contains("hidden") && !menu.contains(t) && !(chip && chip.contains(t)))
            closeMenu(false);
    });
    document.getElementById("um-invite").addEventListener("click", () => { closeMenu(false); void openInvite(); });
    document.getElementById("um-users").addEventListener("click", () => { closeMenu(false); void openUsers(); });
    window.addEventListener("dashboard:session", (ev) => {
        const s = ev.detail;
        if (!s || s.isOwner !== true)
            return;
        session = s;
        installed = s.usersInstalled !== false;
        pending = Number(s.pendingUsers) || 0;
        setupChip();
        updateBadge();
    });
    const refreshPending = async () => {
        try {
            const s = await api("/dashboard/api/session");
            installed = s.usersInstalled !== false;
            pending = Number(s.pendingUsers) || 0;
            updateBadge();
        }
        catch (e) { /* the next keep-alive tries again */ }
    };
    // ── เพิ่มผู้ใช้ด้วย QR ─────────────────────────────────────────────────
    const invDlg = document.getElementById("invite-dialog");
    const invTitle = document.getElementById("invite-title");
    const invSub = document.getElementById("invite-sub");
    const invBody = document.getElementById("invite-body");
    const invFoot = document.getElementById("invite-foot");
    const usersDlgEl = document.getElementById("users-dialog");
    for (const d of [invDlg, usersDlgEl]) {
        for (const b of Array.from(d.querySelectorAll("[data-um-close]")))
            b.addEventListener("click", () => d.close());
    }
    // The dialog's one invite: what it shows, and whether this page cancelled it.
    let inv = null;
    let pollTimer = 0;
    let tickTimer = 0;
    let seq = 0;
    const baseTitle = document.title;
    const stopTimers = () => { clearTimeout(pollTimer); clearInterval(tickTimer); pollTimer = 0; tickTimer = 0; };
    const setHead = (title, sub, wide = false) => {
        invTitle.textContent = title;
        invSub.textContent = sub;
        invDlg.classList.toggle("wide", wide);
    };
    const footer = (...nodes) => { invFoot.replaceChildren(...nodes); };
    const grow = () => el("span", "um-grow");
    const closeBtn = () => btn("ub", "ปิด", () => invDlg.close());
    const newQrBtn = (cls = "ub") => btn(cls, "สร้าง QR ใหม่", () => { void makeQr(); });
    // A result card (done, rejected, locked, gone…): read out, and its
    // heading takes the focus, since the button that led here is gone.
    function resultCard(kind, title) {
        const box = el("div", "um-result");
        box.setAttribute("role", "status");
        const mark = el("div", "um-mark" + (kind === "ok" ? "" : " " + kind));
        mark.appendChild(iconEl(kind === "ok" ? "check" : kind === "no" ? "x" : "alert-tri"));
        const h = el("h3", undefined, title);
        h.tabIndex = -1;
        box.append(mark, h);
        return { box, show: () => { invBody.replaceChildren(box); h.focus(); } };
    }
    function showMessage(title, text, kind = "warn", withNewQr = true) {
        stopTimers();
        setHead("เพิ่มผู้ใช้ด้วย QR", "");
        const card = resultCard(kind, title);
        if (text)
            card.box.appendChild(el("p", undefined, text));
        footer(grow(), ...(withNewQr && installed ? [newQrBtn()] : []), closeBtn());
        card.show();
    }
    async function openInvite() {
        if (!invDlg.open)
            invDlg.showModal();
        if (!installed) {
            showMessage(NOT_INSTALLED, "", "warn", false);
            return;
        }
        await makeQr();
    }
    // A new QR (the server cancels the owner's previous open one).
    async function makeQr() {
        const my = ++seq;
        stopTimers();
        if (inv && inv.status === "open")
            inv.selfCancelled = true;
        inv = null;
        setHead("เพิ่มผู้ใช้ด้วย QR", "ให้ผู้ใช้ใหม่สแกน QR นี้ด้วยแอป LINE บนมือถือ");
        const tile = el("div", "um-qrtile");
        const over = el("div", "um-over");
        over.appendChild(el("span", "um-spin"));
        tile.appendChild(over);
        drawQrView(tile, null);
        footer(grow(), closeBtn());
        try {
            const r = await api("/dashboard/api/users/invites", "POST", {});
            if (my !== seq || !invDlg.open) {
                // Closed or replaced while it was being made.
                if (!invDlg.open)
                    void api("/dashboard/api/users/invites/" + r.id + "/cancel", "POST", {}, true).catch(() => { });
                return;
            }
            inv = { id: r.id, expiresAt: Date.parse(r.expiresAt), qr: r.qr, status: "open", selfCancelled: false };
            const img = document.createElement("img");
            img.src = r.qr;
            img.alt = "QR สำหรับเพิ่มผู้ใช้ใหม่ ใช้ได้ 1 ครั้ง";
            tile.replaceChildren(img);
            drawQrView(tile, inv);
            tick();
            tickTimer = window.setInterval(tick, 1000);
            schedulePoll();
        }
        catch (e) {
            if (my !== seq)
                return;
            const err = e;
            if (err.status === 409 && err.body && err.body.installed === false) {
                installed = false;
                updateBadge();
                return showMessage(NOT_INSTALLED, "", "warn", false);
            }
            showMessage(err.status === 429 ? "สร้าง QR บ่อยเกินไป ลองใหม่ในอีกสักครู่" : "สร้าง QR ไม่สำเร็จ กรุณาลองใหม่", "", "warn", err.status !== 429);
        }
    }
    let countdownEl = null;
    let statusEl = null;
    let tileEl = null;
    function drawQrView(tile, cur) {
        tileEl = tile;
        const grid = el("div", "um-qrgrid");
        const left = el("div");
        left.appendChild(tile);
        const meta = el("div", "um-qrmeta");
        meta.append("ใช้ได้ 1 ครั้ง · หมดอายุใน ");
        countdownEl = el("b", undefined, cur ? "10:00" : "–");
        meta.appendChild(countdownEl);
        left.appendChild(meta);
        const again = el("div");
        again.style.textAlign = "center";
        again.appendChild(newQrBtn("ub link"));
        left.appendChild(again);
        const right = el("div", "um-steps");
        right.appendChild(el("h3", undefined, "ขั้นตอน"));
        const ol = el("ol");
        for (const t of ["เปิดแอป LINE บนมือถือ แล้วแตะไอคอนสแกน ข้างช่องค้นหา", "สแกน QR นี้ แล้วแตะ “ยืนยันตัวตนด้วย LINE”", "ขอดูรหัส 4 หลักบนมือถือ แล้วกรอกที่นี่"]) {
            const li = el("li");
            li.appendChild(el("span", undefined, t));
            ol.appendChild(li);
        }
        right.appendChild(ol);
        const st = el("div", "um-status");
        st.setAttribute("aria-live", "polite");
        statusEl = el("span", "um-pill info");
        statusEl.append(el("span", "um-pulse"), cur ? "รอการสแกน…" : "กำลังสร้าง QR…");
        st.appendChild(statusEl);
        right.appendChild(st);
        right.appendChild(el("div", "um-note", "QR ใช้ได้ครั้งเดียว · ผู้สแกนยังเข้าใช้ไม่ได้จนกว่าคุณจะกดอนุมัติ · อย่าถ่ายภาพหรือส่งต่อ QR นี้"));
        grid.append(left, right);
        invBody.replaceChildren(grid);
    }
    // The QR can no longer be scanned: dimmed, with why and a new one.
    function qrGone(text) {
        stopTimers();
        if (!tileEl)
            return;
        tileEl.classList.add("dim");
        const over = el("div", "um-over");
        over.appendChild(el("span", undefined, text));
        over.appendChild(newQrBtn("ub primary"));
        tileEl.appendChild(over);
        if (countdownEl)
            countdownEl.textContent = "0:00";
        if (statusEl) {
            statusEl.className = "um-pill muted";
            statusEl.textContent = text;
        }
    }
    function tick() {
        if (!inv || !countdownEl)
            return;
        const left = Math.max(0, Math.round((inv.expiresAt - Date.now()) / 1000));
        countdownEl.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
        // One last look at the server: a scan just before the end still counts.
        if (left === 0) {
            clearInterval(tickTimer);
            tickTimer = 0;
            void poll(true);
        }
    }
    // Every 2 s while the page is in view; slower in a background tab, so the
    // tab's title can still say someone scanned.
    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = window.setTimeout(() => { void poll(false); }, document.hidden ? 15000 : 2000);
    }
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            document.title = baseTitle;
            if (inv && inv.status === "open" && pollTimer)
                schedulePoll();
        }
    });
    async function poll(final) {
        if (!inv || !invDlg.open)
            return;
        const my = inv;
        let r;
        try {
            r = await api("/dashboard/api/users/invites/" + my.id);
        }
        catch (e) {
            if (inv === my && !final)
                schedulePoll();
            return;
        }
        if (inv !== my || !invDlg.open)
            return;
        my.status = r.status;
        if (r.status === "open") {
            if (final || Date.now() >= my.expiresAt)
                qrGone("QR หมดอายุแล้ว");
            else
                schedulePoll();
            return;
        }
        if (r.status === "scanned") {
            stopTimers();
            if (document.hidden)
                document.title = "(1) ผู้ใช้ใหม่รออนุมัติ · P4P";
            pending = Math.max(pending, 1);
            updateBadge();
            return showApprove(r);
        }
        if (r.status === "cancelled")
            return qrGone(my.selfCancelled ? "ยกเลิก QR แล้ว" : "QR นี้ถูกยกเลิก เพราะเปิด QR ใหม่แล้ว");
        if (r.status === "expired")
            return qrGone("QR หมดอายุแล้ว");
        // approved / rejected / locked elsewhere (another tab)
        showMessage("คำขอนี้หมดอายุหรือถูกจัดการแล้ว", "");
    }
    // Each dialog opens from a menu item (or a dialog) that is hidden by then,
    // so the browser has nowhere to send focus back to: the chip takes it.
    const focusChip = () => {
        if (invDlg.open || usersDlgEl.open || !chip)
            return;
        // At the close event focus may still sit on a button of the closed
        // dialog (blurred a moment later), or already be on <body>.
        const a = document.activeElement;
        if (!a || a === document.body || invDlg.contains(a) || usersDlgEl.contains(a) || menu.contains(a))
            chip.focus();
    };
    invDlg.addEventListener("close", () => {
        focusChip();
        stopTimers();
        seq++;
        document.title = baseTitle;
        // Closed before anyone scanned: the QR dies with it. After a scan the
        // request waits (24 h) under ผู้ใช้งานและสิทธิ์ › รออนุมัติ.
        if (inv && inv.status === "open") {
            inv.selfCancelled = true;
            void api("/dashboard/api/users/invites/" + inv.id + "/cancel", "POST", {}, true).catch(() => { });
        }
        inv = null;
        void refreshPending();
    });
    // ── อนุมัติผู้ใช้ใหม่ ───────────────────────────────────────────────────
    function showApprove(r) {
        const claim = r.claim || { name: "", picture: null, subTail: "", at: null };
        inv = { id: r.id, expiresAt: Date.parse(r.expiresAt), qr: "", status: "scanned", selfCancelled: false };
        setHead("อนุมัติผู้ใช้ใหม่", "", true);
        const grid = el("div", "um-apgrid");
        // Footer: ปฏิเสธ on the left, อนุมัติ on the right (made first: the
        // rights block below reports its first state at once).
        const approveBtn = btn("ub primary", "อนุมัติ", () => { void approve(); });
        const rejectBtn = btn("ub danger", "ปฏิเสธ", () => askReject());
        // Left: who scanned, and the code from their phone.
        const left = el("div");
        const person = el("div", "um-person");
        if (claim.picture) {
            const img = document.createElement("img");
            img.className = "um-pic";
            img.src = claim.picture;
            img.alt = "";
            img.referrerPolicy = "no-referrer";
            img.addEventListener("error", () => img.replaceWith(el("span", "um-pic", initial(claim.name))));
            person.appendChild(img);
        }
        else {
            const pic = el("span", "um-pic", initial(claim.name));
            pic.setAttribute("aria-hidden", "true");
            person.appendChild(pic);
        }
        const who = el("div");
        who.appendChild(el("b", undefined, claim.name || "(ไม่มีชื่อ LINE)"));
        who.appendChild(el("small", undefined, "LINE ID ลงท้าย …" + claim.subTail + " · สแกนเมื่อ " + bkkTime(claim.at)));
        person.appendChild(who);
        left.appendChild(person);
        const codeLbl = el("span", "um-lbl", "รหัสยืนยันบนมือถือผู้ใช้ใหม่");
        codeLbl.id = "um-code-lbl";
        left.appendChild(codeLbl);
        const digits = el("div", "um-digits");
        digits.setAttribute("role", "group");
        digits.setAttribute("aria-labelledby", "um-code-lbl");
        const boxes = [0, 1, 2, 3].map((i) => {
            const b = document.createElement("input");
            b.type = "text";
            b.inputMode = "numeric";
            // No maxlength: it would cut a pasted code to its first digit.
            b.autocomplete = "off";
            b.setAttribute("aria-label", "หลักที่ " + (i + 1));
            digits.appendChild(b);
            return b;
        });
        const code = () => boxes.map((b) => b.value).join("");
        boxes.forEach((b, i) => {
            b.addEventListener("input", () => {
                const v = b.value.replace(/[^0-9]/g, "");
                if (v.length > 1) {
                    // Pasted: spread the digits over the boxes.
                    v.slice(0, 4 - i).split("").forEach((d, j) => { boxes[i + j].value = d; });
                    boxes[Math.min(3, i + v.length - 1)].focus();
                }
                else {
                    b.value = v;
                    if (v && i < 3)
                        boxes[i + 1].focus();
                }
                digits.classList.remove("bad");
                syncApprove();
            });
            b.addEventListener("keydown", (ev) => {
                if (ev.key === "Backspace" && !b.value && i > 0) {
                    boxes[i - 1].focus();
                    boxes[i - 1].value = "";
                    syncApprove();
                    ev.preventDefault();
                }
                else if (ev.key === "ArrowLeft" && i > 0) {
                    boxes[i - 1].focus();
                    ev.preventDefault();
                }
                else if (ev.key === "ArrowRight" && i < 3) {
                    boxes[i + 1].focus();
                    ev.preventDefault();
                }
                else if (ev.key === "Enter" && !approveBtn.disabled) {
                    ev.preventDefault();
                    void approve();
                }
            });
            b.addEventListener("paste", (ev) => {
                const v = ((ev.clipboardData && ev.clipboardData.getData("text")) || "").replace(/[^0-9]/g, "");
                if (!v)
                    return;
                ev.preventDefault();
                v.slice(0, 4 - i).split("").forEach((d, j) => { boxes[i + j].value = d; });
                boxes[Math.min(3, i + v.length - 1)].focus();
                digits.classList.remove("bad");
                syncApprove();
            });
            b.addEventListener("focus", () => b.select());
        });
        left.appendChild(digits);
        left.appendChild(el("p", "um-help", "ถ้ามือถือผู้ใช้ใหม่ขึ้นว่า “QR นี้ถูกใช้แล้ว” แปลว่ามีคนอื่นสแกนก่อน ให้กดปฏิเสธ"));
        const err = el("p", "error-text hidden");
        err.setAttribute("role", "alert");
        left.appendChild(err);
        // Right: the shown name and the rights.
        const right = el("div");
        const nameLbl = el("label", "um-lbl first", "ชื่อที่แสดงในแดชบอร์ด");
        nameLbl.htmlFor = "um-display-name";
        const name = document.createElement("input");
        name.id = "um-display-name";
        name.className = "um-inp";
        name.maxLength = 60;
        name.required = true;
        name.placeholder = "เช่น กานดา";
        name.autocomplete = "off";
        name.value = (claim.name || "").trim().slice(0, 60);
        name.addEventListener("input", () => syncApprove());
        right.append(nameLbl, name, el("span", "um-lbl", "สิทธิ์การใช้งาน"));
        const rights = rightsBlock([], () => syncApprove());
        right.appendChild(rights.root);
        grid.append(left, right);
        invBody.replaceChildren(grid);
        const normalFoot = () => footer(rejectBtn, grow(), approveBtn);
        function syncApprove() {
            const ready = /^[0-9]{4}$/.test(code());
            approveBtn.disabled = !ready || !name.value.trim();
            approveBtn.title = !ready ? "กรอกรหัส 4 หลักก่อน" : !name.value.trim() ? "กรอกชื่อที่แสดงก่อน" : "";
        }
        function askReject() {
            const box = el("div", "um-confirm");
            box.appendChild(el("b", undefined, "ปฏิเสธคำขอของ " + (claim.name || "ผู้ใช้นี้") + "?"));
            const yes = btn("ub danger solid", "ปฏิเสธ", () => { void reject(yes); });
            box.append(btn("ub", "ยกเลิก", () => { normalFoot(); rejectBtn.focus(); }), yes);
            footer(box);
            yes.focus();
        }
        const showErr = (t) => { err.textContent = t; err.classList.remove("hidden"); };
        async function approve() {
            if (approveBtn.disabled || !inv)
                return;
            approveBtn.disabled = true;
            approveBtn.setAttribute("aria-busy", "true");
            err.classList.add("hidden");
            const perms = rights.matrix.get();
            const shown = name.value.trim();
            try {
                await api("/dashboard/api/users/invites/" + r.id + "/approve", "POST", { code: code(), perms, displayName: shown });
                if (inv)
                    inv.status = "approved";
                pending = Math.max(0, pending - 1);
                updateBadge();
                showDone(shown, perms);
            }
            catch (e) {
                approveBtn.removeAttribute("aria-busy");
                const x = e;
                const what = x.body && x.body.error;
                if (what === "bad_code") {
                    showErr("รหัสไม่ตรง เหลืออีก " + Number(x.body.triesLeft || 0) + " ครั้ง");
                    boxes.forEach((b) => { b.value = ""; });
                    digits.classList.add("bad");
                    boxes[0].focus();
                    syncApprove();
                }
                else if (what === "locked") {
                    if (inv)
                        inv.status = "locked";
                    showMessage("กรอกรหัสผิด 3 ครั้ง ยกเลิกคำขอนี้แล้ว", "", "no");
                }
                else if (what === "not_pending" || x.status === 404) {
                    if (inv)
                        inv.status = "gone";
                    showMessage("คำขอนี้หมดอายุหรือถูกจัดการแล้ว", "");
                }
                else if (what === "too_many") {
                    showErr("มีผู้ใช้ครบ 20 คนแล้ว ระงับผู้ใช้ที่ไม่ใช้แล้วก่อน");
                    syncApprove();
                    approveBtn.focus();
                }
                else {
                    showErr("บันทึกไม่สำเร็จ กรุณาลองใหม่");
                    syncApprove();
                    approveBtn.focus();
                }
            }
        }
        async function reject(yes) {
            yes.disabled = true;
            yes.setAttribute("aria-busy", "true");
            try {
                await api("/dashboard/api/users/invites/" + r.id + "/reject", "POST", {});
                if (inv)
                    inv.status = "rejected";
                pending = Math.max(0, pending - 1);
                updateBadge();
                setHead("เพิ่มผู้ใช้ด้วย QR", "");
                const card = resultCard("no", "ปฏิเสธคำขอแล้ว");
                footer(grow(), newQrBtn(), closeBtn());
                card.show();
            }
            catch (e) {
                const x = e;
                if (x.body && x.body.error === "not_pending")
                    showMessage("คำขอนี้หมดอายุหรือถูกจัดการแล้ว", "");
                else {
                    normalFoot();
                    showErr("บันทึกไม่สำเร็จ กรุณาลองใหม่");
                    rejectBtn.focus();
                }
            }
        }
        normalFoot();
        syncApprove();
        boxes[0].focus();
    }
    function showDone(shown, perms) {
        setHead("เพิ่มผู้ใช้ด้วย QR", "");
        const card = resultCard("ok", "เพิ่ม " + shown + " แล้ว");
        const sum = el("p");
        sum.append(el("b", undefined, "สิทธิ์:"), " " + permsSummary(perms));
        card.box.appendChild(sum);
        card.box.appendChild(el("p", undefined, "ให้เข้าสู่ระบบด้วย LINE บนคอมพิวเตอร์ที่ p4p-sakhonmso.vercel.app/dashboard ด้วยบัญชีเดียวกันนี้"));
        footer(grow(), btn("ub", "เพิ่มอีกคน", () => { void makeQr(); }), btn("ub primary", "ปิด", () => invDlg.close()));
        card.show();
    }
    // A request from the list (ตรวจและอนุมัติ): the approval panel at once.
    async function openRequest(id) {
        seq++;
        stopTimers();
        inv = null;
        if (!invDlg.open)
            invDlg.showModal();
        setHead("อนุมัติผู้ใช้ใหม่", "", true);
        invBody.replaceChildren(el("p", undefined, "กำลังโหลด…"));
        footer(grow(), closeBtn());
        try {
            const r = await api("/dashboard/api/users/invites/" + id);
            if (r.status === "scanned")
                showApprove(r);
            else
                showMessage("คำขอนี้หมดอายุหรือถูกจัดการแล้ว", "");
        }
        catch (e) {
            showMessage("โหลดคำขอไม่สำเร็จ กรุณาลองใหม่", "", "warn", false);
        }
    }
    // ── ผู้ใช้งานและสิทธิ์ ─────────────────────────────────────────────────
    const usersDlg = usersDlgEl;
    usersDlg.addEventListener("close", () => focusChip());
    const usersBody = document.getElementById("users-body");
    document.getElementById("users-add").addEventListener("click", () => { usersDlg.close(); void openInvite(); });
    let users = [];
    async function openUsers() {
        if (!usersDlg.open)
            usersDlg.showModal();
        usersBody.replaceChildren(el("p", undefined, "กำลังโหลด…"));
        await loadUsers();
    }
    async function loadUsers() {
        try {
            const r = await api("/dashboard/api/users");
            if (!r.installed) {
                installed = false;
                updateBadge();
                usersBody.replaceChildren(el("div", "um-note warn", NOT_INSTALLED));
                return;
            }
            installed = true;
            users = r.users;
            pending = r.pending.length;
            updateBadge();
            drawUsers(r.owner.name || session.name || "", r.pending);
        }
        catch (e) {
            usersBody.replaceChildren(el("p", "error-text", "โหลดรายชื่อผู้ใช้ไม่สำเร็จ กรุณาลองใหม่"));
        }
    }
    function drawUsers(ownerName, waiting) {
        const parts = [];
        if (waiting.length) {
            const sec = el("section", "um-sec um-pending");
            sec.appendChild(el("h3", undefined, "รออนุมัติ (" + waiting.length + ")"));
            const ul = el("ul");
            for (const w of waiting) {
                const li = el("li");
                const txt = el("span", "um-grow");
                txt.append(el("b", undefined, (w.claim && w.claim.name) || "(ไม่มีชื่อ LINE)"), " ", el("small", undefined, "· สแกนเมื่อ " + bkkTime(w.claim && w.claim.at)));
                li.append(txt, btn("ub sm primary", "ตรวจและอนุมัติ", () => { usersDlg.close(); void openRequest(w.id); }));
                ul.appendChild(li);
            }
            sec.appendChild(ul);
            parts.push(sec);
        }
        const sec = el("section", "um-sec");
        sec.appendChild(el("h3", undefined, "ผู้ใช้งาน (" + (users.length + 1) + ")"));
        const table = el("table", "um-table");
        const head = el("thead");
        const hr = el("tr");
        for (const [t, w] of [["ชื่อ", "28%"], ["สิทธิ์", ""], ["เพิ่มเมื่อ", "110px"], ["", ""]]) {
            const th = el("th", undefined, t);
            th.setAttribute("scope", "col");
            if (w)
                th.style.width = w;
            if (!t)
                th.appendChild(el("span", "sr-only", "การจัดการ"));
            hr.appendChild(th);
        }
        head.appendChild(hr);
        const body = el("tbody");
        // The owner, pinned: no actions.
        const o = el("tr");
        const on = el("td");
        on.append(el("b", undefined, ownerName), " · ผู้ดูแลระบบ");
        o.append(on, el("td", undefined, "ทุกสิทธิ์"), el("td", undefined, "–"), el("td", undefined, ""));
        body.appendChild(o);
        for (const u of users)
            body.appendChild(userRow(u));
        table.append(head, body);
        sec.appendChild(table);
        parts.push(sec);
        usersBody.replaceChildren(...parts);
    }
    function userRow(u) {
        const tr = el("tr", u.active ? "" : "off");
        tr.dataset.uid = u.id;
        const n = el("td");
        n.appendChild(el("b", undefined, u.displayName));
        if (u.lineName && u.lineName !== u.displayName)
            n.appendChild(el("small", undefined, "LINE: " + u.lineName));
        const p = el("td");
        if (!u.active)
            p.appendChild(el("span", "um-pill danger", "ระงับแล้ว"));
        else {
            const s = permsSummary(u.perms);
            for (const bit of s.split(" · "))
                p.appendChild(el("span", "um-perm", bit));
        }
        const acts = el("td", "um-acts-cell");
        const box = el("div", "um-acts");
        if (u.active) {
            const editBtn = btn("ub sm", "แก้ไขสิทธิ์", () => editRow(tr, u, editBtn));
            const stopBtn = btn("ub sm danger", "ระงับการใช้งาน", () => confirmSuspend(tr, u, stopBtn));
            box.append(editBtn, stopBtn);
        }
        else {
            box.appendChild(btn("ub sm", "เปิดใช้อีกครั้ง", () => {
                void save(u, u.perms, u.displayName, true, "เปิดใช้ " + u.displayName + " อีกครั้งแล้ว มีผลภายใน 30 วินาที");
            }));
        }
        acts.appendChild(box);
        tr.append(n, p, el("td", undefined, bkkDate(u.addedAt)), acts);
        return tr;
    }
    const dropExtra = (tr) => {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains("um-edit"))
            next.remove();
    };
    function editRow(tr, u, from) {
        dropExtra(tr);
        const row = el("tr", "um-edit");
        const td = el("td");
        td.colSpan = 4;
        const grid = el("div", "um-edit-grid");
        const left = el("div");
        const lbl = el("label", "um-lbl first", "ชื่อที่แสดงในแดชบอร์ด");
        const name = document.createElement("input");
        name.className = "um-inp";
        name.maxLength = 60;
        name.value = u.displayName;
        name.id = "um-edit-name-" + u.id.slice(-6);
        lbl.htmlFor = name.id;
        left.append(lbl, name);
        const right = el("div");
        right.appendChild(el("span", "um-lbl first", "สิทธิ์การใช้งาน"));
        const rights = rightsBlock(u.perms, () => { });
        right.appendChild(rights.root);
        grid.append(left, right);
        const err = el("span", "error-text hidden");
        err.setAttribute("role", "alert");
        const btns = el("div", "um-edit-btns");
        const saveBtn = btn("ub primary", "บันทึก", () => {
            const shown = name.value.trim();
            if (!shown) {
                err.textContent = "กรอกชื่อที่แสดงก่อน";
                err.classList.remove("hidden");
                return;
            }
            void save(u, rights.matrix.get(), shown, true, "บันทึกสิทธิ์แล้ว มีผลภายใน 30 วินาที", saveBtn, err);
        });
        btns.append(err, btn("ub", "ยกเลิก", () => { row.remove(); from.focus(); }), saveBtn);
        td.append(grid, btns);
        row.appendChild(td);
        tr.after(row);
        name.focus();
    }
    function confirmSuspend(tr, u, from) {
        dropExtra(tr);
        const row = el("tr", "um-edit");
        const td = el("td");
        td.colSpan = 4;
        const box = el("div", "um-confirm");
        const t = el("div", "um-grow");
        t.append(el("b", undefined, "ระงับ " + u.displayName + "?"), el("small", undefined, u.displayName + " จะออกจากระบบภายใน 30 วินาที"));
        const err = el("span", "error-text hidden");
        err.setAttribute("role", "alert");
        const yes = btn("ub danger solid", "ระงับการใช้งาน", () => {
            void save(u, u.perms, u.displayName, false, "ระงับ " + u.displayName + " แล้ว", yes, err);
        });
        box.append(t, err, btn("ub", "ยกเลิก", () => { row.remove(); from.focus(); }), yes);
        td.appendChild(box);
        row.appendChild(td);
        tr.after(row);
        yes.focus();
    }
    async function save(u, perms, displayName, active, done, busy, err) {
        if (busy) {
            busy.disabled = true;
            busy.setAttribute("aria-busy", "true");
        }
        try {
            await api("/dashboard/api/users/" + encodeURIComponent(u.id), "PATCH", { perms, displayName, active });
            toast(done);
            await loadUsers();
            // The table was drawn again: back to that user's first button.
            const again = Array.from(usersBody.querySelectorAll("tr[data-uid]")).find((r) => r.dataset.uid === u.id);
            const first = again && again.querySelector(".um-acts button");
            if (first)
                first.focus();
        }
        catch (e) {
            if (busy) {
                busy.disabled = false;
                busy.removeAttribute("aria-busy");
                busy.focus();
            }
            const x = e;
            const msg = x.body && x.body.error === "too_many" ? "มีผู้ใช้ครบ 20 คนแล้ว" : "บันทึกไม่สำเร็จ กรุณาลองใหม่";
            if (err) {
                err.textContent = msg;
                err.classList.remove("hidden");
            }
            else
                toast(msg);
        }
    }
})();
