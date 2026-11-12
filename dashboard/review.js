"use strict";
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
;
(function () {
    "use strict";
    const view = document.getElementById("review-view");
    const body = document.getElementById("review-body");
    // The left column under the months: each side's summary and main
    // button. render() fills it; everything else that draws the body alone
    // (loading, a failure, no month) empties it, so no stale button stays.
    const side = document.getElementById("review-side");
    let sideOut = [];
    const show = (...nodes) => { side.replaceChildren(); body.replaceChildren(...nodes); };
    const monthBox = document.getElementById("review-months");
    const roleBtns = Array.from(document.querySelectorAll("#review-role button"));
    const live = document.getElementById("review-live");
    const confirmDlg = document.getElementById("review-confirm");
    const confirmBody = document.getElementById("review-confirm-body");
    const confirmSend = document.getElementById("review-confirm-send");
    const confirmTitle = document.getElementById("review-confirm-title");
    // ── Small helpers ────────────────────────────────────────────────────
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls)
            e.className = cls;
        if (text !== undefined)
            e.textContent = text;
        return e;
    }
    const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
    const THAI_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    const monthName = (key, short = false) => {
        const m = /^(\d{4})_(\d{2})$/.exec(key);
        return m ? (short ? THAI_SHORT : THAI_MONTHS)[Number(m[2]) - 1] + " " + m[1] : key;
    };
    // "ส.ค. 69": the month tabs and headings.
    const shortMonth = (key) => {
        const m = /^(\d{4})_(\d{2})$/.exec(key);
        return m ? THAI_SHORT[Number(m[2]) - 1] + " " + m[1].slice(2) : key;
    };
    const when = (iso) => {
        if (!iso)
            return "";
        const d = new Date(iso);
        if (isNaN(d.getTime()))
            return "";
        return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " น.";
    };
    const baht = (n) => n === null || n === undefined ? "—" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const int = (n) => Number(n || 0).toLocaleString("th-TH");
    // The budget is whole baht: no decimals, unless an older one was saved with satang.
    const budgetText = (n) => n === null || n === undefined ? "—" : Number.isInteger(Number(n)) ? int(Number(n)) : baht(n);
    const sizeText = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
    const say = (msg) => { live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 50); };
    // A failure is announced at once (role=alert); say() is the polite one.
    // Either way the same words are also shown on the page (tell, failBox),
    // without a live role there, so nothing is read out twice.
    // Failures that come together (people and issues both failing) are read as one.
    const alertBox = document.getElementById("review-alert");
    let shoutQ = [];
    let shoutT;
    const shout = (msg) => {
        if (!alertBox) {
            say(msg);
            return;
        }
        shoutQ.push(msg);
        if (shoutT !== undefined)
            return;
        alertBox.textContent = "";
        shoutT = window.setTimeout(() => { alertBox.textContent = shoutQ.join(" · "); shoutQ = []; shoutT = undefined; }, 50);
    };
    class ApiError extends Error {
        constructor(m, s) { super(m); this.status = s; }
    }
    const NET_ERROR = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง";
    async function api(path, init = {}) {
        let r;
        try {
            r = await fetch(path, { credentials: "same-origin", ...init });
        }
        catch (e) {
            throw new ApiError(NET_ERROR, 0);
        }
        if (r.status === 401) {
            location.href = "/dashboard/login?error=idle";
            throw new ApiError("signed out", 401);
        }
        let data = null;
        try {
            data = await r.json();
        }
        catch (e) {
            data = null;
        }
        // Any refusal (409, 503 { installed: false, error }, …) carries its reason in error.
        if (!r.ok)
            throw new ApiError((data && typeof data.error === "string" && data.error) || "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง (" + r.status + ")", r.status);
        return data;
    }
    const errText = (e, fallback) => (e instanceof Error && e.message) || fallback;
    const signedOut = (e) => e instanceof ApiError && e.status === 401;
    const monthApi = (s) => "/dashboard/api/review/" + s.month;
    const post = (path, json, method = "POST") => api(path, json === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
    // ── State ────────────────────────────────────────────────────────────
    const ROLE_KEY = "review.role";
    let role = "auditee";
    try {
        if (localStorage.getItem(ROLE_KEY) === "auditor")
            role = "auditor";
    }
    catch (e) { /* private window */ }
    // month is the one picked; st is the state on screen, always of that
    // month (a switch clears it). Every action builds its URL from the s it
    // was drawn with, so what a dialog says and what is sent agree.
    let month = "";
    let st = null;
    let stJson = "";
    let poll;
    let pollFails = 0;
    let busy = false;
    let loadSeq = 0;
    let loadError = "";
    // Something not in st changed (a note, a request ended): the next look
    // draws even when the state it brings is the same.
    let dirty = false;
    let freshState = false; // the next render draws a state that just arrived
    // Typed text not saved yet, by field. Every re-render (the 15 s look, a
    // click on a person, a list arriving) draws a field from here first, so
    // nothing typed is lost. An entry goes once its save succeeds, or when
    // the month or the round changes.
    const drafts = new Map();
    let draftScope = "";
    const fieldErrs = new Map();
    function keep(i, key, saved) {
        const d = drafts.get(key);
        i.value = d !== undefined ? d : saved;
        i.addEventListener("input", () => { drafts.set(key, i.value); });
        return i;
    }
    const forget = (s, ...keys) => { if (s.month === month) {
        for (const k of keys)
            drafts.delete(k);
        dirty = true;
    } };
    // What the last action at each place said, drawn next to its control by
    // every render until that place is used again or the month changes.
    const notes = new Map();
    const noteId = (spot) => "rv-note-" + spot.replace(/[^A-Za-z0-9_-]/g, "-");
    function tell(s, spot, kind, text) {
        // Finished after a switch to another month: say so at the top.
        if (s.month !== month) {
            spot = "top";
            text = "เดือน " + monthName(s.month) + ": " + text;
        }
        notes.set(spot, { kind, text });
        dirty = true;
        if (kind === "err")
            shout(text);
        else
            say(text);
    }
    function noteEl(spot) {
        const n = notes.get(spot);
        if (!n)
            return null;
        const p = el("p", "rv-note rv-note-" + n.kind);
        p.id = noteId(spot);
        if (n.kind === "err")
            p.append(el("strong", undefined, "ไม่สำเร็จ "), n.text);
        else
            p.textContent = "✓ " + n.text;
        return p;
    }
    // One request at a time per control: a second click while the first runs
    // does nothing. The button shows as unavailable (aria-disabled, so it
    // keeps focus) until the request ends; a re-render draws it the same way.
    const inflight = new Set();
    const flightKey = (s, spot) => s.month + "|" + spot;
    const flying = (s, spot) => inflight.has(flightKey(s, spot));
    function markBusy(b) { b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-busy", "true"); }
    function begin(s, spot, btn) {
        if (flying(s, spot))
            return false;
        inflight.add(flightKey(s, spot));
        if (s.month === month) {
            for (const k of [spot, "top"]) {
                notes.delete(k);
                const n = document.getElementById(noteId(k));
                if (n)
                    n.remove();
            }
        }
        if (btn)
            markBusy(btn);
        return true;
    }
    const end = (s, spot) => { inflight.delete(flightKey(s, spot)); dirty = true; };
    // A visible failure with a way to try again (role=alert is on shout()).
    function failBox(text, id, retry) {
        const box = el("div", "rv-fail");
        const b = el("button", "btn-ghost", "ลองอีกครั้ง");
        b.type = "button";
        b.id = id;
        b.addEventListener("click", retry);
        box.append(el("p", undefined, text), b);
        return box;
    }
    const openRequest = (s) => s.request && ["queued", "dispatched", "running"].includes(s.request.status) ? s.request : null;
    const liveRound = (s) => s.rounds.find((r) => r.round_no === s.live) || null;
    const auditeeTurn = (s) => { const r = liveRound(s); return !r || r.status === "returned"; };
    const inputsInBuild = (s) => !!(s.inputs && s.build && Number(s.build.budget) === Number(s.inputs.budget) && Number(s.build.per_p4p) === Number(s.inputs.per_p4p));
    // A build's blocking problems, but no_inputs: the empty fields and the
    // send bar already say it (Pong, 2026-11-10: the box was unnecessary).
    const blocking = (s) => (s.build ? s.build.problems.filter((p) => p.blocking && p.code !== "no_inputs") : []);
    const PROBLEM = {
        no_inputs: () => "ยังไม่ได้กรอกงบประมาณและจำนวนแพทย์ (กรอกที่หน้าภาพรวม)",
        inputs_not_in_sheet: () => "งบประมาณหรือ per P4P ใน SK03 ไม่ตรงกับที่บันทึกไว้",
        not_in_sk03: (p) => "SK03 ไม่มีชื่อ " + int(p.count || 0) + " คนตามรายชื่อเดือนนี้",
        no_doctor_sheet: (p) => "ไม่พบชีตของแพทย์ " + int(p.count || 0) + " คนในไฟล์รวม",
        not_in_dept_sheet: (p) => "ไม่พบชื่อในชีตกลุ่มงาน " + int(p.count || 0) + " คน",
    };
    // ── Loading ──────────────────────────────────────────────────────────
    let monthRows = [];
    // fresh (opening the tab): a month the side shown cannot open is left
    // for the default. A later look keeps the month on screen. false: no
    // month to show (none at all, none the auditee can open, or not installed).
    async function loadMonths(fresh = false) {
        const r = await api("/dashboard/api/review/months");
        if (!r.installed) {
            renderNotInstalled();
            return false;
        }
        monthRows = r.months || [];
        const keep = !!month && monthRows.some((m) => m.month === month && !(fresh && locked(m)));
        const pick = keep ? month : defaultMonth();
        if (pick !== month) {
            month = pick;
            resetMonth();
        }
        drawTabs();
        return month !== "";
    }
    // The month list again, for the tabs only: the month shown stays.
    async function refreshMonthRows() {
        const r = await api("/dashboard/api/review/months");
        if (r.installed && r.months) {
            monthRows = r.months;
            drawTabs();
        }
    }
    // A month the doctors have not all sent, with nothing sent to the
    // auditor yet: the auditee side cannot open it (Pong, 2026-11-10).
    const locked = (m) => role === "auditee" && !m.round && m.sent < m.total;
    // The oldest month not approved yet, else the newest, of those the side
    // shown can open.
    function defaultMonth() {
        const can = monthRows.filter((x) => !locked(x));
        const m = can.find((x) => !x.round || x.round.status !== "approved") || can[can.length - 1];
        return m ? m.month : "";
    }
    function noMonthCard() {
        if (!monthRows.length)
            return card("ยังไม่มีเดือนให้ตรวจ", [el("p", undefined, "ยังไม่มีตารางรายชื่อตั้งแต่ ส.ค. 69")]);
        const again = el("button", "btn-ghost", "ดูอีกครั้ง");
        again.type = "button";
        again.id = "rv-months-again";
        again.addEventListener("click", () => { void open(); });
        return card("ยังไม่มีเดือนที่แพทย์ส่งครบ", [el("p", undefined, "เปิดเดือนได้เมื่อแพทย์ส่งครบทุกคน"), again]);
    }
    // One button per month, in time order; the status under it depends on
    // the side shown (redrawn on a role switch).
    function drawTabs() {
        const a = document.activeElement;
        const had = a instanceof HTMLElement && monthBox.contains(a) ? a.id : "";
        monthBox.replaceChildren(...monthRows.map((m) => {
            const b = el("button", "rv-mtab");
            b.type = "button";
            b.id = "rv-m-" + m.month;
            b.setAttribute("aria-pressed", String(m.month === month));
            const ms = monthStatus(m);
            const t = el("span", "rv-mtab-s rv-ms-" + ms.kind, ms.text);
            if (ms.sr)
                t.setAttribute("aria-hidden", "true");
            b.append(el("span", "rv-mtab-m", shortMonth(m.month)), t);
            if (ms.sr)
                b.append(el("span", "sr-only", " " + ms.sr));
            const off = locked(m);
            if (off)
                b.setAttribute("aria-disabled", "true");
            b.addEventListener("click", () => {
                if (!off) {
                    pickMonth(m.month);
                    return;
                }
                // The list may be old: look again before saying no.
                void refreshMonthRows().catch(() => undefined).then(() => {
                    const now = monthRows.find((x) => x.month === m.month);
                    if (now && !locked(now))
                        pickMonth(m.month);
                    else
                        say(shortMonth(m.month) + " ยังเปิดไม่ได้ แพทย์ยังส่งไม่ครบ");
                });
            });
            return b;
        }));
        if (had) {
            const f = document.getElementById(had);
            if (f)
                f.focus();
        }
    }
    function pickMonth(m) {
        if (!m || m === month)
            return;
        month = m;
        resetMonth();
        drawTabs();
        show(el("p", "rv-loading", "กำลังโหลดเดือน " + monthName(month) + "…"));
        void loadState(true).catch(loadFailed);
    }
    // Everything on screen belongs to one month: a switch drops the old
    // month's state, lists, drafts and notes, and any reply still on its way
    // for it (the sequence numbers no longer match).
    function resetMonth() {
        st = null;
        stJson = "";
        loadError = "";
        loadSeq++;
        clearTimeout(poll);
        poll = undefined;
        pollFails = 0;
        people = null;
        peopleKey = "";
        peopleErr = "";
        peopleSeq++;
        issues = null;
        issuesKey = "";
        issuesErr = "";
        issuesSeq++;
        details.clear();
        detailErrs.clear();
        detailLoading.clear();
        detailSeq++;
        selected = "";
        lastRoundKey = "";
        rows = null;
        rowsKey = "";
        rowsErr = "";
        rowsSeq++;
        editing = "";
        moreOpen = false;
        drafts.clear();
        fieldErrs.clear();
        notes.clear();
        draftScope = "";
        remarkOpen.clear();
        lastDecided = "";
    }
    const monthStatus = (m) => {
        const r = m.round;
        const me = role === "auditee";
        if (r && r.status === "approved")
            return { kind: "ok", text: "อนุมัติแล้ว" };
        if (r && r.status === "returned")
            return me ? { kind: "fix", text: "ต้องแก้ " + int(r.fix || 0) } : { kind: "wait", text: "รอผู้จัดทำ" };
        // Not "ถึงคิวคุณ": a softer word for the auditor (Pong, 2026-11-12).
        if (r)
            return me ? { kind: "wait", text: "รอผู้ตรวจสอบ" } : { kind: "you", text: "พร้อมตรวจ" };
        if (m.sent < m.total)
            return { kind: "wait", text: "ส่ง " + int(m.sent) + "/" + int(m.total), sr: "แพทย์ส่งแล้ว " + int(m.sent) + " จาก " + int(m.total) + " คน" };
        return me ? { kind: "you", text: "ตรวจสอบ" } : { kind: "wait", text: "รอผู้จัดทำ" };
    };
    // Only the newest load of the month picked may draw: a slower reply for
    // another month, or an older one for this month, is dropped. fromPoll:
    // the 15 s look, which draws nothing when the state is unchanged.
    async function loadState(logView, fromPoll = false) {
        if (!month)
            return;
        const m = month;
        const seq = ++loadSeq;
        const current = () => seq === loadSeq && m === month;
        let s;
        try {
            s = await api("/dashboard/api/review/" + m + (logView ? "?view=1" : ""));
        }
        catch (e) {
            if (!current())
                return;
            throw e;
        }
        if (!current())
            return;
        if (!s || typeof s !== "object")
            throw new ApiError("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง", 0);
        if (!s.installed) {
            st = null;
            stJson = "";
            clearTimeout(poll);
            renderNotInstalled();
            return;
        }
        if (s.month && s.month !== m)
            return;
        const json = JSON.stringify(s);
        const same = json === stJson && !loadError && !dirty;
        st = s;
        stJson = json;
        loadError = "";
        if (!(fromPoll && same)) {
            freshState = true;
            render();
        }
        clearTimeout(poll);
        poll = undefined;
        const r = liveRound(s);
        const pdfWaiting = !!(r && r.status === "approved" && (r.pdf_status === "queued" || r.pdf_status === "building"));
        if (openRequest(s) || pdfWaiting)
            poll = window.setTimeout(() => { void refresh(); }, 15000);
    }
    // A failed load is shown: over the month's screen when it is still the
    // month picked (its actions stay right), or in place of it.
    function loadFailed(e) {
        if (signedOut(e))
            return;
        const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ");
        shout(msg);
        if (st && st.month === month) {
            loadError = msg;
            render();
            keepLooking();
            return;
        }
        show(failBox("โหลดข้อมูลเดือน " + monthName(month) + " ไม่สำเร็จ: " + msg, "rv-retry-load", () => {
            loadingLine("กำลังโหลด…");
            void loadState(true).catch(loadFailed);
        }));
        const b = document.getElementById("rv-retry-load");
        if (b && document.activeElement === document.body)
            b.focus();
    }
    // A failed load while a build or the PDF is on its way: keep looking.
    function keepLooking() {
        if (poll !== undefined || !st || st.month !== month)
            return;
        const r = liveRound(st);
        const pdfWaiting = !!(r && r.status === "approved" && (r.pdf_status === "queued" || r.pdf_status === "building"));
        if (!openRequest(st) && !pdfWaiting)
            return;
        pollFails++;
        poll = window.setTimeout(() => { void refresh(); }, Math.min(15000 * Math.pow(2, pollFails), 120000));
    }
    // The loading line takes the focus a pressed retry button had.
    function loadingLine(text) {
        const hadFocus = body.contains(document.activeElement) || side.contains(document.activeElement);
        const p = el("p", "rv-loading", text);
        p.tabIndex = -1;
        show(p);
        if (hadFocus)
            p.focus();
    }
    const reload = () => loadState(false).catch(loadFailed);
    // The look while a build or the PDF is on its way. A failed look tries
    // again later (30 s, 60 s, then every 2 minutes) instead of stopping.
    async function refresh() {
        poll = undefined;
        if (view.classList.contains("hidden"))
            return; // opening the tab again loads and looks again
        if (busy) {
            poll = window.setTimeout(() => { void refresh(); }, 3000);
            return;
        }
        try {
            await loadState(false, true);
            pollFails = 0;
        }
        catch (e) {
            if (signedOut(e))
                return;
            pollFails++;
            const wait = Math.min(15000 * Math.pow(2, pollFails), 120000);
            clearTimeout(poll);
            poll = window.setTimeout(() => { void refresh(); }, wait);
            if (st && st.month === month) {
                loadError = "อัปเดตอัตโนมัติไม่สำเร็จ (" + errText(e, NET_ERROR) + ") จะลองอีกครั้งใน " + int(Math.round(wait / 1000)) + " วินาที";
                if (pollFails === 1)
                    say(loadError);
                render();
            }
        }
    }
    async function open() {
        loadingLine("กำลังโหลด…");
        try {
            if (!(await loadMonths(true))) {
                if (body.querySelector(".rv-loading"))
                    show(noMonthCard());
                return;
            }
        }
        catch (e) {
            if (signedOut(e))
                return;
            const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ");
            shout(msg);
            show(failBox("โหลดแท็บตรวจสอบไม่สำเร็จ: " + msg, "rv-retry-open", () => { void open(); }));
            return;
        }
        await loadState(true).catch(loadFailed);
    }
    window.addEventListener("dashboard:review", () => { void open(); });
    for (const b of roleBtns) {
        b.addEventListener("click", () => {
            role = b.dataset.role === "auditor" ? "auditor" : "auditee";
            try {
                localStorage.setItem(ROLE_KEY, role);
            }
            catch (e) { /* ignore */ }
            for (const x of roleBtns)
                x.setAttribute("aria-pressed", String(x.dataset.role === role));
            // The auditee cannot stay on a month it cannot open; the auditor
            // gets a month back after the auditee side had none to show.
            const shown = monthRows.find((m) => m.month === month);
            if (monthRows.length && (!shown || locked(shown))) {
                const m = defaultMonth();
                if (m)
                    pickMonth(m);
                else {
                    month = "";
                    resetMonth();
                    drawTabs();
                    show(noMonthCard());
                }
            }
            else {
                drawTabs();
                render();
            }
            say("มุมมอง" + (role === "auditor" ? "ผู้ตรวจสอบ" : "ผู้จัดทำ"));
        });
    }
    // ── Rendering ────────────────────────────────────────────────────────
    function card(title, children, id) {
        const c = el("section", "rv-card glass");
        const h = el("h2", "rv-card-h", title);
        h.id = id || "rv-h-" + Math.random().toString(36).slice(2, 8);
        c.setAttribute("aria-labelledby", h.id);
        c.append(h, ...children);
        return c;
    }
    function turn(kind, tag, title, sub) {
        const t = el("div", "rv-turn rv-" + kind);
        t.setAttribute("role", "status");
        t.append(el("span", "rv-tag", tag), el("strong", undefined, title));
        if (sub)
            t.append(el("span", "rv-sub", sub));
        return t;
    }
    function line(kind, text, extra) {
        const li = el("li", "rv-check rv-" + kind);
        const mark = el("span", "rv-mark", kind === "ok" ? "ถูกต้อง" : kind === "bad" ? "ต้องแก้" : kind === "warn" ? "ให้ผู้ตรวจดู" : "ข้อมูล");
        li.append(mark, el("span", undefined, text));
        if (extra)
            li.append(extra);
        return li;
    }
    function renderNotInstalled() {
        show(card("ยังเปิดใช้แท็บนี้ไม่ได้", [
            el("p", undefined, "ฐานข้อมูลยังไม่มีตารางของแท็บตรวจสอบ หรือยังเป็นรุ่นเก่า ผู้ดูแลระบบต้องรันไฟล์ scripts/review-tab-2026-11.sql แล้วตามด้วย scripts/review-tab-2026-11-auditee.sql ใน Supabase SQL editor แล้วรีเฟรชหน้านี้"),
        ]));
    }
    // Redraws #review-body from st, drafts and notes. Every control that can
    // be focused has a stable id, so focus (and the caret in a text field)
    // comes back to the same control; if it is gone, to the heading of the
    // part it was in, never to the page.
    function render() {
        for (const b of roleBtns)
            b.setAttribute("aria-pressed", String(b.dataset.role === role));
        if (!st)
            return;
        const s = st;
        dirty = false;
        const fresh = freshState;
        freshState = false;
        const lr = liveRound(s);
        const scope = s.month + ":" + (lr ? lr.round_no + ":" + lr.status : "");
        if (scope !== draftScope) {
            if (draftScope) {
                drafts.clear();
                fieldErrs.clear();
                remarkOpen.clear();
            }
            draftScope = scope;
        }
        // A note stays while the screen it was written for is the one shown:
        // it takes the screen of the first state loaded after it, and a later
        // round step, build request or role switch clears it.
        const noteScope = scope + ":" + role + ":" + (s.request ? s.request.id + ":" + s.request.status : "");
        for (const [k, n] of notes) {
            if (n.scope === undefined) {
                if (fresh)
                    n.scope = noteScope;
            }
            else if (n.scope !== noteScope)
                notes.delete(k);
        }
        const a = document.activeElement;
        const inBody = !!a && a !== body && a !== side && (body.contains(a) || side.contains(a));
        const focusId = inBody && a ? a.id : "";
        const holder = inBody && a ? a.closest("[aria-labelledby]") : null;
        const holderId = holder && (body.contains(holder) || side.contains(holder)) ? holder.getAttribute("aria-labelledby") || "" : "";
        let selA = null, selB = null;
        if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
            try {
                selA = a.selectionStart;
                selB = a.selectionEnd;
            }
            catch (e) { /* not a text field */ }
        }
        const viewTop = view.scrollTop;
        const list = body.querySelector(".rv-people-list");
        const listTop = list ? list.scrollTop : 0;
        const sheet = body.querySelector(".rv-sheet");
        const sheetAt = sheet ? { key: sheet.dataset.key || "", placed: sheet.dataset.placed === "1", top: sheet.scrollTop, left: sheet.scrollLeft } : null;
        refreshLists(s);
        const top = [];
        if (loadError)
            top.push(failBox(loadError, "rv-retry-load", () => { void reload(); }));
        const tn = noteEl("top");
        if (tn)
            top.push(tn);
        sideOut = [];
        const main = role === "auditee" ? auditee(s) : auditor(s);
        side.replaceChildren(...sideOut);
        body.replaceChildren(...top, ...main);
        const list2 = body.querySelector(".rv-people-list");
        if (list2)
            list2.scrollTop = listTop;
        const sheet2 = body.querySelector(".rv-sheet");
        // Kept only once the old sheet was brought to the score cell: a
        // redraw before that frame would keep its unscrolled start.
        if (sheet2 && sheetAt && sheetAt.placed && sheet2.dataset.key === sheetAt.key) {
            sheet2.dataset.kept = "1";
            sheet2.dataset.placed = "1";
            sheet2.scrollTop = sheetAt.top;
            sheet2.scrollLeft = sheetAt.left;
        }
        if (inBody) {
            const f = focusId ? document.getElementById(focusId) : null;
            if (f)
                f.focus({ preventScroll: true });
            if (f && document.activeElement === f) {
                if (selA !== null && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) {
                    try {
                        f.setSelectionRange(selA, selB === null ? selA : selB);
                    }
                    catch (e) { /* not a text field */ }
                }
            }
            else {
                const h = (holderId && document.getElementById(holderId)) || body.querySelector(".rv-turn, .rv-card-h");
                if (h) {
                    if (!h.hasAttribute("tabindex"))
                        h.tabIndex = -1;
                    h.focus({ preventScroll: true });
                }
            }
        }
        view.scrollTop = viewTop;
        syncStick();
        markOpened(s);
    }
    // Opening a round on your side stops the other side taking it back.
    const opened = new Set();
    function markOpened(s) {
        const r = liveRound(s);
        if (!r)
            return;
        const who = r.status === "submitted" && role === "auditor" && !r.auditor_opened_at ? "auditor"
            : r.status === "returned" && role === "auditee" && !r.auditee_opened_at ? "auditee" : "";
        const key = s.month + ":" + r.round_no + ":" + who;
        if (!who || opened.has(key))
            return;
        opened.add(key);
        void post("/dashboard/api/review/" + s.month + "/opened", { role: who }).catch(() => { opened.delete(key); });
    }
    // ผู้จัดทำ ─────────────────────────────────────────────────────────────
    // Layout v5: budget and N (read-only) in one card with the Drive links, everyone in
    // the newest build in one table (edit a score inline), and one send bar.
    // Sending waits for: budget and N, a finished build that carries them,
    // still matches the roster, has no blocking problem and no score of
    // 30,000 or more or under 2,200 (the SQL refuses the same).
    function auditee(s) {
        const r = liveRound(s);
        if (r && r.status === "submitted")
            return [sentView(s, r)];
        if (r && r.status === "approved")
            return approvedView(s, r, "auditee");
        const complete = s.roster.total > 0 && s.roster.sent >= s.roster.total;
        // Budget, N, per P4P and the Drive files sit in the left column,
        // with ส่ง under them (Pong, 2026-11-12: save screen height).
        sideOut.push(inputsCard(s));
        if (!r && !complete)
            return [waitingCard(s)];
        const out = [];
        if (r && r.status === "returned") {
            out.push(returnedCard(s, r), issuesCard(s, "auditee"));
            const more = el("section", "rv-card glass rv-more");
            const h = el("h2", "rv-card-h", "รายชื่อทั้งหมด");
            h.id = "rv-h-more";
            more.setAttribute("aria-labelledby", h.id);
            const row = el("div", "rv-actions");
            const t = el("button", "btn-ghost", moreOpen ? "ซ่อน" : "แสดง");
            t.type = "button";
            t.id = "rv-more-toggle";
            t.setAttribute("aria-expanded", String(moreOpen));
            t.setAttribute("aria-controls", "rv-more-body");
            t.addEventListener("click", () => { moreOpen = !moreOpen; render(); });
            row.append(t);
            const inner = el("div", "rv-stack");
            inner.id = "rv-more-body";
            if (moreOpen)
                inner.append(...buildAlerts(s), listCard(s));
            else
                inner.hidden = true;
            more.append(h, row, inner);
            out.push(more);
            if (!moreOpen)
                out.push(...buildAlerts(s).filter((n) => n.dataset.blocking === "1"));
        }
        else {
            out.push(...buildAlerts(s), listCard(s));
        }
        sideOut.push(sendBar(s));
        return out;
    }
    let moreOpen = false;
    function waitingCard(s) {
        const left = Math.max(0, s.roster.total - s.roster.sent);
        const c = el("section", "rv-card glass");
        const h = el("h2", "rv-card-h", shortMonth(s.month) + " · " + (s.roster.total ? "รอแพทย์ส่ง " + int(left) + " คน" : "ยังไม่มีรายชื่อ"));
        h.id = "rv-h-wait";
        c.setAttribute("aria-labelledby", h.id);
        const top = el("div", "rv-actions rv-spread");
        const a = el("a", "rv-link", "ดูรายชื่อในแท็บตามส่ง");
        a.href = "/dashboard/#followup";
        top.append(h, a);
        const bar = el("div", "rv-bar");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", "แพทย์ส่งแล้ว");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(s.roster.total));
        bar.setAttribute("aria-valuenow", String(s.roster.sent));
        bar.setAttribute("aria-valuetext", int(s.roster.sent) + " จาก " + int(s.roster.total) + " คน");
        const fill = el("div");
        fill.style.width = (s.roster.total ? Math.round(100 * s.roster.sent / s.roster.total) : 0) + "%";
        bar.append(fill);
        c.append(top, bar, el("p", "rv-hint", "ส่งแล้ว " + int(s.roster.sent) + " จาก " + int(s.roster.total) + " · ระบบสร้าง SK03 ให้เองเมื่อส่งครบ"));
        return c;
    }
    const fmt2 = (n) => n === null || n === undefined ? "" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Budget and N are typed on the overview page (ภาพรวม, the month card's
    // งบ button; Pong, 2026-11-11), which also starts the month's build.
    // Here they are shown only, with a way there, and the two Drive files.
    function inputsCard(s) {
        const c = el("section", "rv-card glass rv-inputs");
        const h = el("h2", "sr-only", "งบประมาณและไฟล์");
        h.id = "rv-h-inputs";
        c.setAttribute("aria-labelledby", h.id);
        const inp = s.inputs;
        const row = el("div", "rv-ro");
        const set = !!(inp && inp.doctors);
        const go = el("a", (set ? "btn-ghost" : "btn-primary") + " rv-go", set ? "แก้ที่หน้าภาพรวม →" : "กรอกที่หน้าภาพรวม →");
        go.href = "/dashboard/#overview";
        if (inp) {
            row.append(kv("งบประมาณ (บาท)", budgetText(inp.budget)), kv("จำนวนแพทย์ (N)", inp.doctors ? int(inp.doctors) : "–"), kv("per P4P", baht(inp.per_p4p)));
        }
        if (!set)
            row.append(el("span", "rv-none", inp ? "ยังไม่ได้กรอกจำนวนแพทย์" : "ยังไม่ได้กรอกงบประมาณ"));
        row.append(go);
        c.append(h, row);
        if (s.build || openRequest(s) || s.request)
            c.append(filesRow(s));
        return c;
    }
    // The two files in Drive, view only: the tab never offers them as the
    // files that are sent (that is the build the system checked).
    function filesRow(s) {
        const w = el("div", "rv-files");
        const lab = el("span", "rv-label", "ไฟล์ใน Google Drive ");
        const b = s.build;
        const req = openRequest(s);
        if (!req)
            lab.append(el("span", "rv-hint", "· ดูอย่างเดียว"));
        w.append(lab);
        const row = el("div", "rv-actions");
        if (req) {
            const p = el("p", "rv-progress", q2text(req));
            row.append(p);
        }
        else {
            const link = (text, id, url) => {
                // No id: a build from before the file's id was kept, or the
                // upload failed. The next build stores it.
                if (!id)
                    return el("span", "rv-hint", text + ": ยังไม่มีลิงก์");
                const a = el("a", "rv-link", text + " ");
                a.href = url(id);
                a.target = "_blank";
                a.rel = "noopener";
                const arrow = el("span", undefined, "↗");
                arrow.setAttribute("aria-hidden", "true");
                a.append(arrow, el("span", "sr-only", " " + shortMonth(s.month) + " (เปิดในแท็บใหม่)"));
                return a;
            };
            if (b) {
                row.append(link("SK03", b.sk03_file_id, (x) => "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(x) + "/preview"), link("รวมค่าคะแนน", b.merged_file_id, (x) => "https://drive.google.com/file/d/" + encodeURIComponent(x) + "/view"), el("span", "rv-hint", "อัปเดต " + when(b.built_at)));
            }
            else {
                row.append(el("span", "rv-hint", "ยังไม่มีไฟล์ · ระบบสร้างทุกคืนเมื่อแพทย์ส่งครบ"));
            }
            if (auditeeTurn(s)) {
                const rb = el("button", "btn-ghost", "สร้างใหม่");
                rb.type = "button";
                rb.id = "rv-rebuild";
                if (flying(s, "rebuild"))
                    markBusy(rb);
                rb.addEventListener("click", () => { void doRebuild(s, rb); });
                row.append(rb);
            }
        }
        w.append(row);
        const n = noteEl("rebuild");
        if (n)
            w.append(n);
        return w;
    }
    const q2text = (q) => q.status === "running"
        ? "กำลังสร้าง SK03 และรวมค่าคะแนนใหม่ · ~10 นาที"
        : "รอเริ่มสร้าง SK03 และรวมค่าคะแนนใหม่ · ~10 นาที";
    async function doRebuild(s, btn) {
        if (!begin(s, "rebuild", btn))
            return;
        try {
            await post(monthApi(s) + "/rebuild");
            tell(s, "rebuild", "ok", "ขอสร้างใหม่แล้ว · ~10 นาที หน้านี้อัปเดตเอง");
        }
        catch (e) {
            tell(s, "rebuild", "err", errText(e, "ขอสร้างใหม่ไม่สำเร็จ"));
        }
        finally {
            end(s, "rebuild");
        }
        await reload();
    }
    // The newest failed build request (after the newest build), shown once
    // as an alert; and the build's problems: blocking ones first.
    let announcedFail = 0;
    function buildAlerts(s) {
        const out = [];
        const q = s.request;
        if (q && q.status === "failed" && !openRequest(s) && (!s.build || Date.parse(q.requested_at) > Date.parse(s.build.built_at))) {
            const why = q.error === "timed out" ? "งานสร้างไฟล์ไม่เสร็จในเวลาที่กำหนด" : (q.error || "ไม่ทราบสาเหตุ");
            const box = el("div", "rv-alert");
            box.dataset.blocking = "1";
            box.append(el("strong", undefined, "สร้างไฟล์ไม่สำเร็จ"), el("span", undefined, why + (q.finished_at ? " · " + when(q.finished_at) : "")));
            if (auditeeTurn(s)) {
                const b = el("button", "btn-ghost", "ลองอีกครั้ง");
                b.type = "button";
                b.id = "rv-rebuild-retry";
                if (flying(s, "rebuild"))
                    markBusy(b);
                b.addEventListener("click", () => { void doRebuild(s, b); });
                box.append(b);
            }
            out.push(box);
            if (announcedFail !== q.id && s.month === month) {
                announcedFail = q.id;
                shout("สร้างไฟล์ไม่สำเร็จ: " + why);
            }
        }
        const b = s.build;
        if (!b || openRequest(s))
            return out;
        const text = (p) => (PROBLEM[p.code] || (() => p.code))(p) +
            (p.names && p.names.length ? ": " + p.names.slice(0, 8).join(", ") + (p.names.length > 8 ? " และอีก " + int(p.names.length - 8) + " คน" : "") : "");
        const blockers = blocking(s);
        const notes2 = b.problems.filter((p) => !p.blocking && p.code !== "no_inputs");
        if (blockers.length || s.stale > 0) {
            const box = el("div", "rv-alert");
            box.dataset.blocking = "1";
            box.append(el("strong", undefined, "ต้องแก้ก่อนส่ง"));
            const ul = el("ul");
            for (const p of blockers)
                ul.append(el("li", undefined, text(p)));
            if (s.stale > 0)
                ul.append(el("li", undefined, "รายชื่อหรือคะแนนเปลี่ยนหลังสร้างไฟล์ " + int(s.stale) + " คน · สร้างใหม่ให้ตรงก่อนส่ง"));
            box.append(ul);
            const row = el("div", "rv-actions");
            if (blockers.some((p) => p.code === "not_in_sk03" || p.code === "no_doctor_sheet" || p.code === "not_in_dept_sheet")) {
                const a = el("a", "rv-link", "แก้ในแท็บรายชื่อ");
                a.href = "/dashboard/#roster";
                row.append(a);
            }
            if (s.stale > 0 && auditeeTurn(s)) {
                const rb = el("button", "btn-ghost", "สร้างใหม่");
                rb.type = "button";
                rb.id = "rv-rebuild-stale";
                if (flying(s, "rebuild"))
                    markBusy(rb);
                rb.addEventListener("click", () => { void doRebuild(s, rb); });
                row.append(rb);
            }
            if (row.childNodes.length)
                box.append(row);
            out.push(box);
        }
        if (notes2.length) {
            const box = el("div", "rv-alert rv-alert-soft");
            const ul = el("ul");
            for (const p of notes2)
                ul.append(el("li", undefined, text(p)));
            box.append(el("strong", undefined, "ให้ผู้ตรวจสอบดู"), ul);
            out.push(box);
        }
        return out;
    }
    let rows = null;
    let rowsKey = "";
    let rowsErr = "";
    let rowsSeq = 0;
    let aFilter = "all";
    let aSearch = "";
    let editing = "";
    let searchSay;
    const rowsWant = (s) => s.month + ":" + (s.build ? s.build.id : "") + ":" + s.stale + ":" + s.edits;
    async function loadRows(s) {
        const seq = ++rowsSeq;
        rowsKey = rowsWant(s);
        rowsErr = "";
        try {
            const res = await api(monthApi(s) + "/list");
            if (seq !== rowsSeq || s.month !== month)
                return;
            rows = res.people || [];
        }
        catch (e) {
            if (seq !== rowsSeq || s.month !== month || signedOut(e))
                return;
            rowsKey = "";
            rowsErr = errText(e, "โหลดรายชื่อไม่สำเร็จ");
            shout("โหลดรายชื่อไม่สำเร็จ: " + rowsErr);
        }
        render();
    }
    const ensureRows = (s) => { if (s.build && rowsKey !== rowsWant(s) && !rowsErr)
        void loadRows(s); };
    const sameScore = (a, b) => a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) < 0.005;
    // The score now on the roster (where an edit goes), else the build's.
    const curScore = (p) => (p.onRoster ? p.roster : p.score);
    const pending = (p) => p.onRoster && !sameScore(p.roster, p.score);
    const flagOf = (n) => n === null || !isFinite(Number(n)) ? null : Number(n) >= 30000 ? "high" : Number(n) < 2200 ? "low" : null;
    const resent = (p) => !!p.edit && p.onRoster && !sameScore(p.roster, p.edit.new);
    const FLAG_TEXT = { high: "30,000 ขึ้นไป", low: "ต่ำกว่า 2,200" };
    const isDiff = (p) => p.scoreCheck === "mismatch" || p.moneyCheck === "mismatch";
    const isMiss = (p) => p.scoreCheck === "missing" || p.moneyCheck === "missing";
    const FILTERS = [
        ["all", "ทั้งหมด", () => true],
        ["diff", "ไม่ตรง", isDiff],
        ["miss", "ไม่พบข้อมูล", isMiss],
        ["edited", "แก้แล้ว", (p) => !!p.edit],
        ["flag", "คะแนนผิดปกติ", (p) => !!flagOf(curScore(p))],
    ];
    const MISS_TEXT = {
        uncached: "ยอดรวมในไฟล์แพทย์เป็นสูตรที่ไม่ได้บันทึกค่า", none: "ไม่พบยอดรวมในไฟล์แพทย์", empty: "ไฟล์แพทย์ว่าง", "no-sheet": "ไม่พบไฟล์แพทย์",
    };
    function listCard(s) {
        const c = el("section", "rv-card glass");
        const h = el("h2", "rv-card-h", "รายชื่อ");
        h.id = "rv-h-list";
        c.setAttribute("aria-labelledby", h.id);
        if (!s.build) {
            c.append(h, el("p", "rv-hint", openRequest(s) ? "รอสร้างไฟล์เสร็จ แล้วรายชื่อและผลเทียบจะขึ้นที่นี่" : "รายชื่อและผลเทียบจะขึ้นที่นี่เมื่อระบบสร้างไฟล์แล้ว"));
            return c;
        }
        ensureRows(s);
        const head = el("div", "rv-actions rv-list-head");
        head.append(h);
        const all = rows || [];
        const fl = el("div", "rv-filters");
        fl.setAttribute("role", "group");
        fl.setAttribute("aria-label", "แสดง");
        for (const [k, t, f] of FILTERS) {
            const b = el("button", "rv-flt", t + " " + int(all.filter(f).length));
            b.type = "button";
            b.id = "rv-flt-" + k;
            b.setAttribute("aria-pressed", String(aFilter === k));
            b.addEventListener("click", () => { aFilter = k; render(); say(t + " " + int(all.filter(f).length) + " คน"); });
            fl.append(b);
        }
        const sl = el("label", "rv-search");
        sl.append(el("span", "sr-only", "ค้นหาชื่อหรือกลุ่มงาน"));
        const si = el("input");
        si.type = "search";
        si.id = "rv-a-search";
        si.placeholder = "ค้นหาชื่อหรือกลุ่มงาน";
        si.autocomplete = "off";
        si.value = aSearch;
        si.addEventListener("input", () => {
            aSearch = si.value;
            render();
            clearTimeout(searchSay);
            searchSay = window.setTimeout(() => { say(int(body.querySelectorAll(".rv-table tbody tr[data-i]").length) + " คน"); }, 700);
        });
        sl.append(si);
        head.append(fl, sl);
        c.append(head);
        if (rowsErr) {
            c.append(failBox("โหลดรายชื่อไม่สำเร็จ: " + rowsErr, "rv-retry-rows", () => { rowsErr = ""; render(); }));
            return c;
        }
        if (!rows) {
            c.append(el("p", "rv-loading", "กำลังโหลดรายชื่อ…"));
            return c;
        }
        // The alert: scores of 30,000 or more, or under 2,200.
        const high = all.filter((p) => flagOf(curScore(p)) === "high").length;
        const low = all.filter((p) => flagOf(curScore(p)) === "low").length;
        if (high + low) {
            const w = el("div", "rv-warnbar");
            w.append(el("strong", undefined, "คะแนนผิดปกติ " + int(high + low) + " คน"), el("span", undefined, [high ? "30,000 ขึ้นไป " + int(high) + " คน" : "", low ? "ต่ำกว่า 2,200 " + int(low) + " คน" : ""].filter(Boolean).join(" · ") + " · แก้ก่อนส่ง"));
            if (aFilter !== "flag") {
                const b = el("button", "btn-ghost", "ดูรายชื่อ");
                b.type = "button";
                b.id = "rv-flag-show";
                b.addEventListener("click", () => { aFilter = "flag"; render(); const f = document.getElementById("rv-flt-flag"); if (f)
                    f.focus(); });
                w.append(b);
            }
            c.append(w);
        }
        const q = aSearch.trim().toLowerCase();
        const pick = (FILTERS.find((x) => x[0] === aFilter) || FILTERS[0])[2];
        const shown = all.filter((p) => pick(p) && (!q || p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)));
        const box = el("div", "rv-table-box");
        const tbl = el("table", "rv-table");
        const cap = el("caption", "sr-only", "รายชื่อ " + shortMonth(s.month) + " · " + int(shown.length) + " คน");
        const hr = el("tr");
        for (const [x, cls] of [["ชื่อ-นามสกุล", ""], ["กลุ่มงาน", ""], ["คะแนน", "num"], ["ไฟล์แพทย์", "num"], ["ผล", ""]]) {
            const th = el("th", cls, x);
            th.scope = "col";
            hr.append(th);
        }
        const canEdit = auditeeTurn(s);
        if (canEdit) {
            const th = el("th");
            th.scope = "col";
            th.append(el("span", "sr-only", "แก้คะแนน"));
            hr.append(th);
        }
        const thead = el("thead");
        thead.append(hr);
        const tbody = el("tbody");
        for (const p of shown) {
            const editingHere = canEdit && editing === "list:" + p.index;
            const tr = el("tr", editingHere ? "on" : "");
            tr.dataset.i = p.index;
            const name = el("td", undefined, p.name);
            const dept = el("td", undefined, p.intern ? "INTERN" : p.department);
            const sc = el("td", "num");
            if (editingHere)
                sc.append(...scoreEditor(s, p, "list"));
            else
                scoreCell(sc, p);
            const st = el("td", "num", p.stated === null ? "–" : num2(p.stated));
            const res = el("td");
            res.append(...resultChips(p));
            tr.append(name, dept, sc, st, res);
            if (canEdit) {
                const td = el("td", "rv-edit-cell");
                if (!editingHere)
                    td.append(editButton(p, "list"));
                tr.append(td);
            }
            tbody.append(tr);
            if (editingHere) {
                const tr2 = el("tr", "on");
                const td = el("td");
                td.colSpan = 6;
                td.append(editActions(s, p, "list"));
                tr2.append(td);
                tbody.append(tr2);
            }
        }
        if (!shown.length) {
            const tr = el("tr");
            const td = el("td", "rv-hint", "ไม่มีรายชื่อ");
            td.colSpan = canEdit ? 6 : 5;
            tr.append(td);
            tbody.append(tr);
        }
        tbl.append(cap, thead, tbody);
        box.append(tbl);
        c.append(box);
        if (openRequest(s) || all.some(pending))
            c.append(el("p", "rv-hint", "ผลเทียบจะอัปเดตเมื่อสร้างไฟล์ใหม่เสร็จ"));
        const n = noteEl("score");
        if (n)
            c.append(n);
        return c;
    }
    const num2 = (n) => n === null ? "–" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    function scoreCell(td, p) {
        const cur = curScore(p);
        td.append(el("span", flagOf(cur) ? "rv-flagged" : "", num2(cur)));
        if (resent(p) && p.edit)
            td.append(el("span", "rv-old", "แก้ไว้ " + num2(p.edit.new)));
        else if (p.edit && p.edit.old !== null)
            td.append(el("span", "rv-old", "เดิม " + num2(p.edit.old)));
        if (pending(p))
            td.append(el("span", "rv-old", "รอไฟล์ใหม่"));
    }
    function resultChips(p) {
        const out = [];
        const fl = flagOf(curScore(p));
        if (fl)
            out.push(chip("warn", FLAG_TEXT[fl]));
        if (resent(p))
            out.push(chip("warn", "แพทย์ส่งไฟล์ใหม่หลังแก้"));
        else if (p.edit)
            out.push(chip("edit", "แก้แล้ว"));
        if (!pending(p)) {
            if (p.scoreCheck === "mismatch")
                out.push(chip("bad", "คะแนนไม่ตรง"));
            if (p.moneyCheck === "mismatch")
                out.push(chip("bad", "เงินไม่ตรง"));
            if (p.scoreCheck === "missing" || p.moneyCheck === "missing") {
                out.push(chip("miss", "ไม่พบข้อมูล"));
                out.push(el("span", "rv-old", p.scoreCheck === "missing" ? (MISS_TEXT[p.statedHow] || "ไม่พบยอดรวมในไฟล์แพทย์")
                    : p.sk03Row === null ? "ไม่มีใน SK03" : "ไม่พบในชีตกลุ่มงาน"));
            }
        }
        if (!out.length) {
            const ok = el("span", "rv-ok-mark");
            const m = el("span", undefined, "✓");
            m.setAttribute("aria-hidden", "true");
            ok.append(m, el("span", "sr-only", "ตรงกัน"));
            out.push(ok);
        }
        return out;
    }
    const eid = (kind, where, p) => "rv-" + kind + "-" + where + "-" + p.index;
    function editButton(p, where) {
        const b = el("button", "rv-icon-btn", "แก้คะแนน");
        b.type = "button";
        b.id = eid("edit", where, p);
        b.append(el("span", "sr-only", " " + p.name));
        b.addEventListener("click", () => {
            editing = where + ":" + p.index;
            render();
            const i = document.getElementById(eid("score", where, p));
            if (i) {
                i.focus();
                i.select();
            }
        });
        return b;
    }
    // The new score, with the warning under it while it is out of range.
    const SCORE_RE = /^\d+(\.\d{1,2})?$/;
    function scoreWarn(v) {
        const t = v.replace(/,/g, "").trim();
        if (!SCORE_RE.test(t))
            return "";
        const fl = flagOf(Number(t));
        return fl === "high" ? "คะแนน 30,000 ขึ้นไป ตรวจอีกครั้ง" : fl === "low" ? "ต่ำกว่า 2,200 ได้ 0 บาท ตรวจอีกครั้ง" : "";
    }
    function scoreEditor(s, p, where) {
        const id = eid("score", where, p);
        const lab = el("label", "sr-only", "คะแนนใหม่ " + p.name);
        lab.htmlFor = id;
        const i = keep(el("input"), "score:" + p.index, fmt2(curScore(p)));
        i.id = id;
        i.type = "text";
        i.inputMode = "decimal";
        i.autocomplete = "off";
        i.className = "rv-score-in";
        const fe = fieldErrs.get("score:" + p.index);
        const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "");
        err.id = id + "-e";
        const warn = el("p", "rv-warn-text");
        warn.id = id + "-w";
        const paint = () => { const w = scoreWarn(i.value); warn.textContent = w; warn.hidden = !w; };
        paint();
        i.addEventListener("input", paint);
        if (fe)
            i.setAttribute("aria-invalid", "true");
        i.setAttribute("aria-describedby", err.id + " " + warn.id);
        i.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                const b = document.getElementById(eid("score-save", where, p));
                if (b)
                    b.click();
            }
            if (ev.key === "Escape") {
                ev.preventDefault();
                cancelEdit(s, p, where);
            }
        });
        const out = [lab, i, err, warn];
        if (p.edit && p.edit.old !== null && !resent(p))
            out.push(el("span", "rv-old", "เดิม " + num2(p.edit.old)));
        else if (curScore(p) !== null)
            out.push(el("span", "rv-old", "เดิม " + num2(curScore(p))));
        return out;
    }
    function editActions(s, p, where) {
        const w = el("div", "rv-edit-actions");
        const nid = eid("enote", where, p);
        const lab = el("label", "rv-label", "หมายเหตุ ");
        lab.htmlFor = nid;
        lab.append(el("span", "rv-hint", "(ถ้ามี)"));
        const note = keep(el("input"), "enote:" + p.index, "");
        note.id = nid;
        note.type = "text";
        note.maxLength = 500;
        note.autocomplete = "off";
        note.className = "rv-note-in";
        const save = el("button", "btn-primary", "บันทึก");
        save.type = "button";
        save.id = eid("score-save", where, p);
        save.append(el("span", "sr-only", " คะแนน " + p.name));
        const spot = "score-" + p.index;
        if (flying(s, spot))
            markBusy(save);
        save.addEventListener("click", () => { void saveScore(s, p, save, where); });
        const cancel = el("button", "btn-ghost", "ยกเลิก");
        cancel.type = "button";
        cancel.id = eid("score-cancel", where, p);
        cancel.addEventListener("click", () => cancelEdit(s, p, where));
        w.append(lab, note, save, cancel);
        const n = noteEl(spot);
        if (n)
            w.append(n);
        return w;
    }
    function cancelEdit(s, p, where) {
        editing = "";
        forget(s, "score:" + p.index, "enote:" + p.index);
        fieldErrs.delete("score:" + p.index);
        notes.delete("score-" + p.index);
        render();
        const b = document.getElementById(eid("edit", where, p));
        if (b)
            b.focus();
    }
    async function saveScore(s, p, btn, where) {
        const spot = "score-" + p.index;
        if (flying(s, spot))
            return;
        const i = document.getElementById(eid("score", where, p));
        const ni = document.getElementById(eid("enote", where, p));
        if (!i)
            return;
        const v = i.value.replace(/,/g, "").trim();
        if (!SCORE_RE.test(v) || Number(v) >= 1e6) {
            fieldErrs.set("score:" + p.index, "ใส่ตัวเลข เช่น 2,480.00");
            render();
            const j = document.getElementById(eid("score", where, p));
            if (j)
                j.focus();
            return;
        }
        fieldErrs.delete("score:" + p.index);
        if (!begin(s, spot, btn))
            return;
        busy = true;
        let ok = false;
        try {
            const r = await post(monthApi(s) + "/scores/" + p.index, { score: v, note: ni ? ni.value : "" }, "PUT");
            ok = true;
            tell(s, "score", "ok", p.name + ": " + (r.changed ? "บันทึกคะแนน " + num2(Number(v)) + " แล้ว · กำลังสร้างไฟล์ใหม่" : "คะแนนเท่าเดิม"));
        }
        catch (e) {
            const msg = errText(e, "บันทึกไม่สำเร็จ");
            if (e instanceof ApiError && e.status === 400)
                fieldErrs.set("score:" + p.index, msg);
            tell(s, spot, "err", msg);
        }
        finally {
            busy = false;
            end(s, spot);
        }
        if (ok) {
            editing = "";
            forget(s, "score:" + p.index, "enote:" + p.index);
            rowsKey = "";
            if (people && s.month === month)
                peopleKey = "";
        }
        await reload();
        if (ok) {
            const b = document.getElementById(eid("edit", where, p)) || document.getElementById(where === "fix" ? "rv-h-ans" : "rv-h-list");
            if (b) {
                if (!b.hasAttribute("tabindex") && b.tagName === "H2")
                    b.tabIndex = -1;
                b.focus();
            }
        }
    }
    // ── Send ─────────────────────────────────────────────────────────────
    function submitReasons(s) {
        const why = [];
        if (!auditeeTurn(s))
            return ["ส่งให้ผู้ตรวจสอบแล้ว"];
        if (s.roster.sent < s.roster.total)
            why.push("รอแพทย์ส่งครบ");
        if (!s.inputs || !s.inputs.doctors)
            why.push("กรอกงบประมาณที่หน้าภาพรวม");
        if (openRequest(s))
            why.push("รอสร้างไฟล์ใหม่เสร็จ");
        else if (!s.build)
            why.push("รอระบบสร้างไฟล์");
        else {
            if (s.inputs && s.inputs.doctors && !inputsInBuild(s))
                why.push("กดสร้างใหม่ให้มีงบประมาณล่าสุด");
            else if (s.stale > 0)
                why.push("กดสร้างใหม่ (รายชื่อหรือคะแนนเปลี่ยน)");
            if (blocking(s).length)
                why.push("แก้ปัญหาด้านบนก่อน");
            const c = s.buildChecks;
            const flagged = c ? Number(c.high || 0) + Number(c.low || 0) : 0;
            if (flagged)
                why.push("แก้คะแนนผิดปกติ " + int(flagged) + " คน");
        }
        return why;
    }
    function sendBar(s) {
        const why = submitReasons(s);
        const r = liveRound(s);
        const next = r ? r.round_no + 1 : 1;
        const bar = el("div", "rv-sendbar glass");
        const reason = el("span", "rv-hint");
        reason.id = "rv-send-why";
        const send = el("button", "btn-primary rv-lg", next > 1 ? "ส่งรอบที่ " + next : "ส่งให้ผู้ตรวจสอบ");
        send.type = "button";
        send.id = "rv-send";
        if (why.length) {
            reason.textContent = why.join(" · ");
            send.setAttribute("aria-disabled", "true");
            send.setAttribute("aria-describedby", reason.id);
        }
        if (flying(s, "send"))
            markBusy(send);
        send.addEventListener("click", () => {
            if (why.length) {
                say("ยังส่งไม่ได้: " + why.join(" · "));
                return;
            }
            openConfirm(s, next);
        });
        bar.append(reason, send);
        return bar;
    }
    function kv(label, value) {
        const d = el("div", "rv-kv");
        d.append(el("span", undefined, label), el("b", undefined, value));
        return d;
    }
    function kvGrid(budget, doctors, perP4p, edits) {
        const g = el("div", "rv-kvs");
        g.append(kv("งบประมาณ", budgetText(budget)), kv("N", doctors ? int(doctors) : "–"), kv("per P4P", baht(perP4p)));
        if (edits !== undefined)
            g.append(kv("แก้คะแนน", int(edits) + " คน"));
        return g;
    }
    function openConfirm(s, roundNo) {
        const inp = s.inputs;
        if (!inp)
            return;
        const kids = [kvGrid(inp.budget, inp.doctors, inp.per_p4p)];
        const c = s.buildChecks;
        const odd = c ? Number(c.scoreMismatch) + Number(c.moneyMismatch) + Number(c.scoreMissing) + Number(c.moneyMissing) : 0;
        const bits = [s.edits ? "แก้คะแนน " + int(s.edits) + " คน" : "", "ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิด"].filter(Boolean);
        kids.push(el("p", undefined, bits.join(" · ")));
        if (odd)
            kids.push(el("p", "rv-hint", "ผลเทียบไม่ตรงหรือไม่พบข้อมูล " + int(odd) + " รายการ · ผู้ตรวจสอบจะพิจารณา"));
        askConfirm(roundNo > 1 ? "ส่งรอบที่ " + roundNo + " ของ " + shortMonth(s.month) + "?" : "ส่ง " + shortMonth(s.month) + " ให้ผู้ตรวจสอบ?", kids, "ส่ง", () => doSubmit(s));
    }
    // One confirm dialog for every step that hands the month to the other
    // side. Each action keeps the s the dialog was written from.
    let confirmAction = null;
    let confirmBusy = false;
    let confirmReturn = "";
    let confirmErr = null;
    function askConfirm(title, kids, button, action) {
        confirmTitle.textContent = title;
        const err = el("p", "rv-err rv-confirm-err");
        err.id = "review-confirm-err";
        err.setAttribute("role", "alert");
        confirmErr = err;
        confirmBody.replaceChildren(...kids, err);
        confirmSend.textContent = button;
        if (!confirmBusy) {
            confirmSend.removeAttribute("aria-disabled");
            confirmSend.removeAttribute("aria-busy");
        }
        confirmAction = action;
        const a = document.activeElement;
        confirmReturn = a && a.id ? a.id : "";
        confirmDlg.showModal();
    }
    confirmSend.addEventListener("click", () => { if (confirmAction && !confirmBusy)
        void confirmAction(); });
    // Esc and ยกเลิก do not close it while the step is being sent (the
    // capture listener runs before the shared data-close one in app.ts).
    confirmDlg.addEventListener("cancel", (ev) => { if (confirmBusy)
        ev.preventDefault(); });
    const confirmCancel = confirmDlg.querySelector("[data-close]");
    confirmDlg.addEventListener("click", (ev) => {
        if (confirmBusy && confirmCancel && ev.target instanceof Node && confirmCancel.contains(ev.target)) {
            ev.stopPropagation();
            ev.preventDefault();
        }
    }, true);
    // The button that opened it may have been redrawn while it was open.
    confirmDlg.addEventListener("close", () => {
        const a = document.activeElement;
        if ((!a || a === document.body || confirmDlg.contains(a)) && confirmReturn) {
            const f = document.getElementById(confirmReturn);
            if (f)
                f.focus();
            else
                focusTop();
        }
    });
    // Sends a dialog's step: on success the dialog closes; on a refusal or
    // a network error it stays open with the reason inside it.
    async function confirmRun(s, call) {
        if (confirmBusy)
            return false;
        confirmBusy = true;
        markBusy(confirmSend);
        if (confirmCancel)
            confirmCancel.setAttribute("aria-disabled", "true");
        const sent = confirmAction;
        const err = confirmErr;
        if (err)
            err.textContent = "";
        try {
            const done = await call();
            if (confirmDlg.open && confirmAction === sent)
                confirmDlg.close();
            tell(s, "top", "ok", done);
            return true;
        }
        catch (e) {
            const msg = errText(e, "ทำรายการไม่สำเร็จ");
            if (confirmDlg.open && confirmAction === sent && err && err.isConnected)
                setTimeout(() => { err.textContent = msg; }, 50);
            else {
                tell(s, "top", "err", msg);
                if (s.month === month)
                    render();
            }
            return false;
        }
        finally {
            confirmBusy = false;
            if (confirmCancel)
                confirmCancel.removeAttribute("aria-disabled");
            confirmSend.removeAttribute("aria-disabled");
            confirmSend.removeAttribute("aria-busy");
        }
    }
    async function doSubmit(s) {
        const ok = await confirmRun(s, async () => {
            const r = await post(monthApi(s) + "/rounds");
            return "ส่งรอบที่ " + r.round.round_no + " ให้ผู้ตรวจสอบแล้ว";
        });
        if (ok) {
            moreOpen = false;
            await loadMonths().catch(() => false);
        }
        await reload();
        if (ok)
            focusTop();
    }
    function focusTop() {
        const h = body.querySelector(".rv-turn, .rv-card-h");
        if (h) {
            h.tabIndex = -1;
            h.focus();
        }
    }
    // Sent: the auditor's turn.
    function sentView(s, r) {
        const c = el("section", "rv-card glass");
        const h = el("h2", "rv-card-h", (r.round_no > 1 ? "ส่งรอบที่ " + r.round_no + " ของ " : "ส่ง ") + shortMonth(s.month) + " แล้ว · รอผู้ตรวจสอบ");
        h.id = "rv-h-sent";
        c.setAttribute("aria-labelledby", h.id);
        const top = el("div", "rv-actions rv-spread");
        const t = el("div");
        t.append(h, el("p", "rv-hint", r.reopened_at
            ? "ผู้ตรวจสอบยกเลิกเอกสารและเปิดตรวจอีกครั้ง " + when(r.reopened_at) + (r.reopen_reason ? " · " + r.reopen_reason : "")
            : when(r.submitted_at) + " · " + (r.auditor_opened_at ? "ผู้ตรวจสอบเปิดแล้ว " + when(r.auditor_opened_at) : "ผู้ตรวจสอบยังไม่เปิด")));
        top.append(t);
        if (!r.auditor_opened_at) {
            const w = el("button", "btn-ghost", "ดึงกลับ");
            w.type = "button";
            w.id = "rv-withdraw";
            if (flying(s, "withdraw"))
                markBusy(w);
            w.addEventListener("click", () => { void doWithdraw(s, w); });
            top.append(w);
        }
        c.append(top, kvGrid(r.budget, r.doctors, r.per_p4p, r.edits || 0));
        const n = noteEl("withdraw");
        if (n)
            c.append(n);
        return c;
    }
    async function doWithdraw(s, btn) {
        if (!begin(s, "withdraw", btn))
            return;
        let ok = false;
        try {
            await post(monthApi(s) + "/rounds/withdraw");
            tell(s, "top", "ok", "ดึงกลับแล้ว แก้แล้วส่งใหม่ได้");
            ok = true;
        }
        catch (e) {
            tell(s, "withdraw", "err", errText(e, "ดึงกลับไม่สำเร็จ"));
        }
        finally {
            end(s, "withdraw");
        }
        if (ok)
            await loadMonths().catch(() => false);
        await reload();
        if (ok)
            focusTop();
    }
    // Returned: what the auditor asked to fix, each with the score (edit it
    // here) and the auditee's answer.
    function returnedCard(s, r) {
        ensure(s, r);
        if (s.build)
            ensureRows(s);
        const c = el("section", "rv-card glass");
        const fixes = (people || []).filter((p) => p.decision === "fix");
        const h = el("h2", "rv-card-h", "ผู้ตรวจสอบส่งกลับ · ต้องแก้ " + int(r.counts.fix) + " คน");
        h.id = "rv-h-ans";
        c.setAttribute("aria-labelledby", h.id);
        const top = el("div", "rv-actions rv-spread");
        top.append(h, el("span", "rv-hint", "รอบที่ " + r.round_no + " · " + when(r.returned_at)));
        c.append(top);
        if (peopleErr)
            c.append(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople));
        else if (!people)
            c.append(el("p", "rv-loading", "กำลังโหลด…"));
        else if (!fixes.length)
            c.append(el("p", "rv-hint", "ไม่มีรายชื่อที่ต้องแก้ ดูปัญหาอื่น ๆ"));
        const canEdit = auditeeTurn(s);
        for (const p of fixes) {
            const item = el("article", "rv-fix");
            const hid = "rv-ans-" + p.index;
            const nm = el("h3", undefined, p.name);
            nm.id = hid;
            item.setAttribute("aria-labelledby", hid);
            const who = el("div");
            who.append(nm, el("span", "rv-old", p.intern ? "INTERN" : p.department));
            const remark = el("p", "rv-remark");
            remark.append(el("span", "sr-only", "หมายเหตุผู้ตรวจสอบ: "), p.remark);
            const row = (rows || []).find((x) => x.index === p.index) || null;
            const sc = el("div", "rv-fix-score num");
            const fixEditing = !!row && canEdit && editing === "fix:" + row.index;
            if (row && fixEditing) {
                sc.append(...scoreEditor(s, row, "fix"));
            }
            else if (row) {
                const cell = el("span");
                scoreCell(cell, row);
                sc.append(cell);
                if (row.edit)
                    sc.append(chip(resent(row) ? "warn" : "edit", resent(row) ? "แพทย์ส่งไฟล์ใหม่หลังแก้" : "แก้แล้ว"));
                if (canEdit)
                    sc.append(editButton(row, "fix"));
            }
            else {
                sc.append(el("span", undefined, num2(p.score)));
            }
            const form = el("form", "rv-answer");
            const lab = el("label", "rv-label", "คำตอบ");
            const ta = keep(el("input"), "answer:" + p.index, p.reply);
            ta.id = "rv-answer-" + p.index;
            ta.type = "text";
            ta.maxLength = 1000;
            ta.placeholder = "พิมพ์คำตอบ";
            lab.htmlFor = ta.id;
            const save = el("button", "btn-ghost", "บันทึก");
            save.type = "submit";
            save.id = "rv-answer-save-" + p.index;
            save.append(el("span", "sr-only", " คำตอบ " + p.name));
            const spot = "answer-" + p.index;
            if (flying(s, spot))
                markBusy(save);
            form.append(lab, ta, save);
            form.addEventListener("submit", (ev) => { ev.preventDefault(); void saveAnswer(s, p, ta.value, save); });
            item.append(who, remark, sc);
            if (row && fixEditing)
                item.append(editActions(s, row, "fix"));
            item.append(form);
            const n = noteEl(spot);
            if (n)
                item.append(n);
            c.append(item);
        }
        const n = moreOpen ? null : noteEl("score");
        if (n)
            c.append(n);
        return c;
    }
    // The key says what is loaded or on its way; the sequence number lets
    // only the newest request land (a month switch bumps them all). A failed
    // load clears its key and keeps the reason, shown with a retry button,
    // instead of loading again on every render.
    let people = null;
    let peopleKey = "";
    let peopleErr = "";
    let peopleSeq = 0;
    let issues = null;
    let issuesKey = "";
    let issuesErr = "";
    let issuesSeq = 0;
    let selected = "";
    let filter = "todo";
    let search = "";
    const details = new Map();
    const detailErrs = new Map();
    const detailLoading = new Set();
    let detailSeq = 0;
    // People whose ต้องแก้ไข box the auditor opened, kept outside the page so
    // a re-render (the sheet arriving, a reload) leaves it open.
    const remarkOpen = new Set();
    let swapAt = 0; // when the panel last drew another person
    let shownPerson = ""; // the person the panel last drew
    let lastDecided = ""; // the person the "decided" note in the list names
    const roundKey = (s, r) => s.month + ":" + r.round_no + ":" + r.status + ":" + (r.counts.approve + r.counts.fix);
    async function loadPeople(s, r) {
        const key = s.month + ":" + r.round_no;
        const seq = ++peopleSeq;
        peopleKey = key;
        peopleErr = "";
        try {
            const res = await api(monthApi(s) + "/people?round=" + r.round_no);
            if (seq !== peopleSeq || s.month !== month)
                return;
            people = res.people || [];
            if (!selected || !people.some((p) => p.index === selected)) {
                const first = people.find((p) => p.decision === null) || people[0];
                selected = first ? first.index : "";
            }
        }
        catch (e) {
            if (seq !== peopleSeq || s.month !== month || signedOut(e))
                return;
            peopleKey = "";
            peopleErr = errText(e, "โหลดรายชื่อไม่สำเร็จ");
            shout("โหลดรายชื่อไม่สำเร็จ: " + peopleErr);
        }
        render();
    }
    async function loadIssues(s) {
        const seq = ++issuesSeq;
        issuesKey = s.month;
        issuesErr = "";
        try {
            const res = await api(monthApi(s) + "/issues");
            if (seq !== issuesSeq || s.month !== month)
                return;
            issues = res.issues || [];
        }
        catch (e) {
            if (seq !== issuesSeq || s.month !== month || signedOut(e))
                return;
            issuesKey = "";
            issuesErr = errText(e, "โหลดปัญหาอื่น ๆ ไม่สำเร็จ");
            shout("โหลดปัญหาอื่น ๆ ไม่สำเร็จ: " + issuesErr);
        }
        render();
    }
    const needPeople = (s, r) => peopleKey !== s.month + ":" + r.round_no;
    const ensureIssues = (s) => { if (issuesKey !== s.month && !issuesErr)
        void loadIssues(s); };
    const ensure = (s, r) => {
        if (needPeople(s, r) && !peopleErr)
            void loadPeople(s, r);
        ensureIssues(s);
    };
    // Retry: forget the failure and draw again, which loads again.
    const retryPeople = () => { peopleErr = ""; render(); };
    const retryIssues = () => { issuesErr = ""; render(); };
    // A new state (another round, a decision made elsewhere) reloads both.
    let lastRoundKey = "";
    function refreshLists(s) {
        const r = liveRound(s);
        if (!r)
            return;
        const k = roundKey(s, r);
        if (k === lastRoundKey)
            return;
        // Another round: its people are not the old round's.
        if (lastRoundKey.split(":").slice(0, 2).join(":") !== s.month + ":" + r.round_no)
            people = null;
        lastRoundKey = k;
        peopleKey = "";
        issuesKey = "";
        peopleErr = "";
        issuesErr = "";
    }
    const CHECK_TEXT = { match: "ตรงกัน", mismatch: "ไม่ตรงกัน", missing: "ไม่พบ" };
    const WHY_TEXT = {
        fix: "รอบก่อนให้แก้ไข", new: "ไม่มีในรอบก่อน", score: "คะแนนของตัวเองเปลี่ยน",
        department: "กลุ่มงานเปลี่ยน", name: "ชื่อเปลี่ยน", check: "ผลเทียบไม่ตรงกัน",
    };
    const HOW_TEXT = {
        "grand-total": "แถวรวมทั้งหมด", "free-text": "ข้อความสรุปยอดรวม", "sub-total": "แถวรวม", "largest-over-sub-total": "ตัวเลขมากที่สุดในชีต (มากกว่าแถวรวม)", "largest-on-total-row": "ตัวเลขมากที่สุดในชีต อยู่ในแถวรวม",
        "largest-in-sheet": "ตัวเลขมากที่สุดในชีต", "largest-year-like": "ตัวเลขมากที่สุดในชีต รวมตัวเลขที่ดูคล้ายปี", "weight-x-days": "คำนวณจากแต้ม × จำนวนวัน",
        "sum-of-sub-totals": "ผลบวกแถวรวมย่อย เพราะแถวรวมทั้งหมดไม่มีค่าที่บันทึกไว้", "sum-of-data-rows": "ผลบวกคอลัมน์แต้ม เพราะแถวรวมไม่มีค่าที่บันทึกไว้",
        "rebuilt-from-days": "คำนวณจากจำนวนรายวัน × แต้ม เพราะแถวรวมไม่มีค่าที่บันทึกไว้",
        uncached: "แถวรวมเป็นสูตรที่ Excel ไม่ได้บันทึกค่าไว้", none: "ไม่พบแถวรวม", empty: "ชีตว่าง", "no-sheet": "ไม่พบชีตของแพทย์",
    };
    const bothMatch = (p) => p.scoreCheck === "match" && p.moneyCheck === "match";
    const decisionText = (p) => p.decision === "approve" ? (p.carried ? "อนุมัติ (คงผลรอบก่อน)" : "อนุมัติ")
        : p.decision === "fix" ? "ต้องแก้ไข" : "รอตรวจ";
    const num = (n) => n === null ? "—" : Number(n).toLocaleString("th-TH", { maximumFractionDigits: 2 });
    function chip(kind, text) {
        return el("span", "rv-chip rv-chip-" + kind, text);
    }
    // ผู้ตรวจสอบ ───────────────────────────────────────────────────────────
    function auditor(s) {
        const r = liveRound(s);
        if (!r)
            return [turn("wait", "รอผู้จัดทำ", "ผู้จัดทำยังไม่ได้ส่งข้อมูลเดือน " + monthName(s.month, true), "เมื่อส่งแล้วจะขึ้นที่นี่")];
        if (r.status === "returned") {
            const out = [turn("wait", "รอผู้จัดทำ", "ส่งกลับรอบที่ " + r.round_no + " แล้ว เมื่อ " + when(r.returned_at), "ต้องแก้ " + int(r.counts.fix) + " คน · รอผู้จัดทำแก้ในแอปแล้วส่งรอบที่ " + (r.round_no + 1))];
            if (!r.auditee_opened_at) {
                const row = el("div", "rv-actions");
                const b = el("button", "btn-ghost", "ดึงผลตรวจกลับมาแก้");
                b.type = "button";
                b.id = "rv-unreturn";
                if (flying(s, "unreturn"))
                    markBusy(b);
                b.addEventListener("click", () => { void roundStep(s, "unreturn", "ดึงกลับแล้ว ตรวจต่อได้", b); });
                row.append(b, el("span", "rv-hint", "ใช้ได้จนกว่าผู้จัดทำจะเปิดดู"));
                const kids = [row];
                const n = noteEl("unreturn");
                if (n)
                    kids.push(n);
                out.push(card("ส่งผิด?", kids, "rv-h-unret"));
            }
            return out;
        }
        if (r.status === "approved")
            return approvedView(s, r, "auditor");
        ensure(s, r);
        // The round, the counts and ส่งผลตรวจ sit in the left column, so the
        // names and the checks start at the top (Pong, 2026-11-12).
        sideOut.push(finishBar(s, r));
        const out = [];
        if (peopleErr)
            out.push(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople));
        if (!people) {
            if (!peopleErr)
                out.push(el("p", "rv-loading", "กำลังโหลดรายชื่อ…"));
            return out;
        }
        const wrap = el("div", "rv-review");
        wrap.append(peopleList(), personPanel(s, r));
        out.push(wrap, issuesCard(s, "auditor"));
        return out;
    }
    function finishBar(s, r) {
        const c = r.counts;
        // Not known until the issues load: no "0 open" and no approve-all before that.
        const openIssues = issues ? issues.filter((i) => i.status === "open").length : null;
        const bar = el("div", "rv-finish glass");
        const info = el("div", "rv-round-line");
        // The month chip above already says พร้อมตรวจ.
        info.append(el("span", undefined, "รอบที่ " + r.round_no + " · " + monthName(s.month, true)), el("span", undefined, "ส่งมา " + when(r.submitted_at) + (r.submitted_by ? " โดย " + r.submitted_by : "")), el("span", undefined, "งบ " + budgetText(r.budget) + (r.doctors ? " · N " + int(r.doctors) : "")), el("span", undefined, "per P4P " + baht(r.per_p4p)));
        if (r.edits)
            info.append(el("span", undefined, "ผู้จัดทำแก้คะแนน " + int(r.edits) + " คน"));
        bar.append(info);
        const counts = el("ul", "rv-countlist rv-counts");
        counts.setAttribute("aria-label", "สรุปรอบนี้");
        const cnt = (label, v) => { const li = el("li"); li.append(el("span", undefined, label), el("b", undefined, v)); counts.append(li); };
        cnt("รอตรวจ", int(c.waiting));
        cnt("อนุมัติ", int(c.approve) + (c.carried ? " (คงผล " + int(c.carried) + ")" : ""));
        cnt("ต้องแก้ไข", int(c.fix));
        cnt("ปัญหาอื่นที่เปิดอยู่", openIssues === null ? (issuesErr ? "โหลดไม่สำเร็จ" : "…") : int(openIssues));
        bar.append(counts);
        const btn = el("button", "btn-primary");
        btn.type = "button";
        btn.id = "rv-finish";
        const why = el("span", "rv-hint");
        why.id = "rv-finish-why";
        if (c.waiting > 0 || openIssues === null) {
            btn.textContent = "ส่งผลตรวจ…";
            btn.setAttribute("aria-disabled", "true");
            btn.setAttribute("aria-describedby", why.id);
            why.textContent = c.waiting > 0 ? "ส่งได้เมื่อตรวจครบทุกคน (เหลือ " + int(c.waiting) + " คน)"
                : issuesErr ? "ส่งได้เมื่อโหลดปัญหาอื่น ๆ ได้ กดลองอีกครั้งในกล่องปัญหาอื่น ๆ" : "รอโหลดปัญหาอื่น ๆ";
            btn.addEventListener("click", () => say(why.textContent || ""));
        }
        else if (c.fix > 0 || openIssues > 0) {
            btn.textContent = "ส่งกลับให้ผู้จัดทำแก้…";
            why.textContent = "ต้องแก้ไข " + int(c.fix) + " คน · ปัญหาอื่น " + int(openIssues) + " เรื่อง";
            btn.addEventListener("click", () => {
                askConfirm("ส่งกลับให้ผู้จัดทำแก้", [el("p", undefined, "ส่งรอบที่ " + r.round_no + " เดือน " + monthName(s.month) + " กลับ: ต้องแก้ไข " + int(c.fix) + " คน · ปัญหาอื่นที่เปิดอยู่ " + int(openIssues) + " เรื่อง"),
                    el("p", "rv-hint", "ดึงกลับได้จนกว่าผู้จัดทำจะเปิดดู")], "ส่งกลับ", () => roundStep(s, "return", "ส่งกลับให้ผู้จัดทำแล้ว"));
            });
        }
        else {
            btn.textContent = "อนุมัติทั้งหมด…";
            why.textContent = "อนุมัติครบ " + int(c.approve) + " คน และไม่มีปัญหาที่เปิดอยู่";
            btn.addEventListener("click", () => {
                askConfirm("อนุมัติทั้งหมด", [el("p", undefined, "อนุมัติ " + int(c.approve) + " คน ของเดือน " + monthName(s.month) + " รอบที่ " + r.round_no),
                    el("p", "rv-hint", "หลังอนุมัติ ระบบจะทำเอกสารเบิกจ่าย (PDF) ที่มีเวลาอนุมัติทุกหน้า")], "อนุมัติ", () => roundStep(s, "approve", "อนุมัติแล้ว"));
            });
        }
        bar.append(btn, why);
        return bar;
    }
    // ── Approved: the document, a retry, and reopening ───────────────────
    function approvedView(s, r, side) {
        const status = r.pdf_status || "queued";
        const c = el("section", "rv-card glass");
        const h = el("h2", "rv-card-h", "อนุมัติ " + shortMonth(s.month) + " แล้ว");
        h.id = "rv-h-pdf";
        c.setAttribute("aria-labelledby", h.id);
        c.append(h, el("p", "rv-hint", when(r.approved_at) + " · รอบที่ " + r.round_no + (r.approved_by ? " · " + r.approved_by : "")));
        if (status === "ready") {
            const row = el("div", "rv-actions");
            const a = el("a", "rv-link", "เปิดเอกสารเบิกจ่าย PDF ");
            a.href = "/dashboard/api/review/" + s.month + "/pdf";
            a.target = "_blank";
            a.rel = "noopener";
            a.id = "rv-pdf";
            const arrow = el("span", undefined, "↗");
            arrow.setAttribute("aria-hidden", "true");
            a.append(arrow, el("span", "sr-only", " (เปิดในแท็บใหม่)"));
            const d = el("a", "rv-link", "ดาวน์โหลด");
            d.href = "/dashboard/api/review/" + s.month + "/pdf?download=1";
            d.id = "rv-pdf-dl";
            d.append(el("span", "sr-only", " เอกสารเบิกจ่าย " + shortMonth(s.month)));
            const size = [r.pdf_pages ? int(r.pdf_pages) + " หน้า" : "", r.pdf_bytes ? sizeText(r.pdf_bytes) : ""].filter(Boolean).join(" · ");
            row.append(a, d);
            if (size)
                row.append(el("span", "rv-hint", size));
            c.append(row);
        }
        else if (status === "failed") {
            const box = el("div", "rv-alert");
            box.append(el("strong", undefined, "สร้างเอกสารเบิกจ่ายไม่สำเร็จ"));
            if (r.pdf_error)
                box.append(el("span", undefined, r.pdf_error));
            const b = el("button", "btn-ghost", "ลองอีกครั้ง");
            b.type = "button";
            b.id = "rv-pdf-retry";
            if (flying(s, "pdf"))
                markBusy(b);
            b.addEventListener("click", () => { void retryPdf(s, b); });
            box.append(b);
            c.append(box);
        }
        else {
            const p = el("p", "rv-loading", "กำลังสร้างเอกสารเบิกจ่าย · หน้านี้อัปเดตเอง");
            p.setAttribute("aria-busy", "true");
            c.append(p);
        }
        c.append(kvGrid(r.budget, r.doctors, r.per_p4p, r.edits || 0));
        const n = noteEl("pdf");
        if (n)
            c.append(n);
        const out = [c];
        if (side === "auditor") {
            const row = el("div", "rv-actions");
            const b = el("button", "btn-ghost", "ยกเลิกเอกสารและเปิดตรวจอีกครั้ง…");
            b.type = "button";
            b.id = "rv-reopen";
            b.addEventListener("click", () => askReopen(s, r));
            row.append(b);
            out.push(card("ต้องแก้หลังอนุมัติ?", [row,
                el("p", "rv-hint", "เอกสารที่สร้างแล้วจะใช้ไม่ได้ รอบที่ " + r.round_no + " กลับมาเป็นคิวผู้ตรวจสอบ ผลอนุมัติเดิมยังอยู่")], "rv-h-reopen"));
        }
        return out;
    }
    async function retryPdf(s, b) {
        if (!begin(s, "pdf", b))
            return;
        try {
            await post(monthApi(s) + "/pdf/retry");
            tell(s, "pdf", "ok", "สั่งสร้างเอกสารอีกครั้งแล้ว");
        }
        catch (e) {
            tell(s, "pdf", "err", errText(e, "ทำรายการไม่สำเร็จ"));
        }
        finally {
            end(s, "pdf");
        }
        await reload();
    }
    function askReopen(s, r) {
        const ta = el("textarea");
        ta.id = "rv-reopen-reason";
        ta.rows = 3;
        ta.maxLength = 1000;
        ta.required = true;
        ta.setAttribute("aria-required", "true");
        const lab = el("label", undefined, "เหตุผล (ต้องกรอก)");
        lab.htmlFor = ta.id;
        const err = el("p", "rv-err");
        err.id = "rv-reopen-err";
        ta.setAttribute("aria-describedby", err.id);
        const field = el("div", "rv-reason");
        field.append(lab, ta, err);
        askConfirm("ยกเลิกเอกสารและเปิดตรวจอีกครั้ง · " + monthName(s.month, true), [
            el("p", undefined, "เอกสารเบิกจ่าย" + (r.pdf_built_at ? "ที่สร้างเมื่อ " + when(r.pdf_built_at) : "") +
                " จะใช้ไม่ได้ รวมถึงฉบับที่ดาวน์โหลดหรือพิมพ์ไปแล้ว ผู้จัดทำจะเห็นเหตุผลนี้ และบันทึกในประวัติการใช้งาน"),
            el("p", undefined, "สิ่งที่จะเกิดขึ้น: ผลอนุมัติ " + int(r.counts.approve) + " คนยังอยู่ · เหตุผลจะเป็นปัญหาอื่น ๆ ที่เปิดอยู่ · " +
                "เปลี่ยนคนที่ต้องแก้เป็น ต้องแก้ไข แล้วส่งกลับ · ผู้จัดทำแก้ในแอปแล้วส่งรอบที่ " + (r.round_no + 1) +
                " · ถ้าไม่มีอะไรต้องแก้ ปิดเรื่องแล้วอนุมัติใหม่ได้"),
            field,
        ], "ยกเลิกเอกสารและเปิดตรวจอีกครั้ง", async () => {
            const reason = ta.value.trim();
            if (!reason) {
                ta.setAttribute("aria-invalid", "true");
                err.textContent = "เขียนเหตุผลก่อน จึงจะกดได้";
                ta.focus();
                return;
            }
            ta.removeAttribute("aria-invalid");
            err.textContent = "";
            const ok = await confirmRun(s, async () => {
                await post(monthApi(s) + "/reopen", { reason });
                return "ยกเลิกเอกสารแล้ว รอบที่ " + r.round_no + " กลับมาให้ตรวจอีกครั้ง";
            });
            if (!ok)
                return;
            if (s.month === month) {
                peopleKey = "";
                issuesKey = "";
            }
            await loadMonths().catch(() => false);
            await reload();
        });
        setTimeout(() => ta.focus(), 0);
    }
    // approve / return come from the confirm dialog (which stays open with
    // the reason when refused); unreturn is a plain button (btn).
    async function roundStep(s, step, done, btn) {
        const call = async () => { await post(monthApi(s) + "/" + step); return done; };
        let ok = false;
        if (btn) {
            if (!begin(s, step, btn))
                return;
            try {
                tell(s, "top", "ok", await call());
                ok = true;
            }
            catch (e) {
                tell(s, step, "err", errText(e, "ทำรายการไม่สำเร็จ"));
            }
            finally {
                end(s, step);
            }
        }
        else {
            ok = await confirmRun(s, call);
        }
        if (ok) {
            if (s.month === month) {
                peopleKey = "";
                issuesKey = "";
            }
            await loadMonths().catch(() => false);
        }
        await reload();
    }
    function visiblePeople() {
        const q = search.trim().toLowerCase();
        return (people || []).filter((p) => {
            if (q && !(p.name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)))
                return false;
            if (filter === "todo")
                return p.decision === null;
            if (filter === "diff")
                return !bothMatch(p);
            if (filter === "fix")
                return p.decision === "fix";
            if (filter === "approve")
                return p.decision === "approve";
            return true;
        });
    }
    function peopleList() {
        const side = el("div", "rv-people glass");
        const tools = el("div", "rv-people-tools");
        const fl = el("label", "rv-mini", "แสดง");
        const sel = el("select");
        sel.id = "rv-filter";
        for (const [v, t] of [["todo", "รอตรวจ"], ["diff", "ไม่ตรงหรือไม่พบ"], ["fix", "ต้องแก้ไข"], ["approve", "อนุมัติแล้ว"], ["all", "ทุกคน"]]) {
            const o = el("option", undefined, t);
            o.value = v;
            sel.append(o);
        }
        sel.value = filter;
        sel.addEventListener("change", () => { filter = sel.value; render(); });
        fl.append(sel);
        const sl = el("label", "rv-mini", "ค้นหา");
        const si = el("input");
        si.type = "search";
        si.id = "rv-search";
        si.value = search;
        si.autocomplete = "off";
        si.addEventListener("input", () => { search = si.value; render(); });
        sl.append(si);
        tools.append(fl, sl);
        const shown = visiblePeople();
        const count = el("p", "rv-hint", int(shown.length) + " คน");
        count.setAttribute("aria-live", "polite");
        const ul = el("ul", "rv-people-list");
        ul.setAttribute("aria-label", "รายชื่อในรอบนี้");
        for (const p of shown) {
            const li = el("li");
            const b = el("button", "rv-person-btn" + (p.index === selected ? " current" : ""));
            b.type = "button";
            b.id = "rv-p-" + p.index;
            if (p.index === selected)
                b.setAttribute("aria-current", "true");
            const top = el("span", "rv-pname", p.name);
            const sub = el("span", "rv-psub", (p.intern ? "อินเทิร์น" : p.department) + " · " + decisionText(p));
            b.append(top, sub);
            if (p.scoreCheck === "mismatch" || p.moneyCheck === "mismatch")
                b.append(chip("bad", "ผลเทียบไม่ตรง"));
            else if (!bothMatch(p))
                b.append(chip("miss", "ไม่พบข้อมูล"));
            b.addEventListener("click", () => { openPerson(p.index); });
            li.append(b);
            ul.append(li);
        }
        if (!shown.length)
            ul.append(el("li", "rv-hint", filter === "todo" ? "ตรวจครบทุกคนแล้ว" : "ไม่มีรายชื่อ"));
        side.append(tools, count);
        const dn = noteEl("decided");
        const back = lastDecided ? (people || []).find((x) => x.index === lastDecided) : undefined;
        if (dn && back) {
            const b = el("button", "rv-link", "เปิดดูอีกครั้ง");
            b.type = "button";
            b.id = "rv-decided-back";
            b.addEventListener("click", () => { openPerson(back.index); });
            dn.append(" ", b);
        }
        if (dn)
            side.append(dn);
        side.append(ul);
        return side;
    }
    // One person on the auditor's side. Top to bottom: name, the one-line
    // round-2 notes, the two checks, then the decision row (pinned under the
    // counts bar while the auditor reads further down), any remark box, the
    // earlier remark and reply, and last หลักฐาน: the doctor's sheet and the
    // department row. The buttons come before the sheet so the auditor never
    // scrolls past it to decide (Pong, 2026-11-11).
    function personPanel(s, r) {
        const panel = el("section", "rv-person glass");
        const p = (people || []).find((x) => x.index === selected);
        if (!p) {
            panel.append(el("p", "rv-hint", "เลือกรายชื่อทางซ้าย"));
            return panel;
        }
        const h = el("h3", "rv-person-h", p.name);
        h.id = "rv-person-h";
        h.tabIndex = -1;
        panel.setAttribute("aria-labelledby", h.id);
        panel.append(h, el("p", "rv-hint", (p.intern ? "อินเทิร์น" : "staff · " + p.department) + (p.sk03Row ? " · SK03 แถว " + p.sk03Row : "") + " · " + decisionText(p)));
        // A person drawn for the first time starts the click guard (tooSoon).
        if (p.index !== shownPerson) {
            shownPerson = p.index;
            swapAt = Date.now();
        }
        // ผล comes second, so the eye goes from the result straight down to the buttons.
        const t = el("table", "rv-compare");
        const cap = el("caption", "sr-only", "ผลเทียบอัตโนมัติ");
        const head = el("tr");
        for (const x of ["เรื่อง", "ผล", "SK03", "เทียบกับ"]) {
            const th = el("th", undefined, x);
            th.scope = "col";
            head.append(th);
        }
        const row = (label, a, b, check) => {
            const tr = el("tr");
            const th = el("th", undefined, label);
            th.scope = "row";
            const res = el("td");
            res.append(chip(check === "match" ? "ok" : check === "missing" ? "miss" : "bad", CHECK_TEXT[check]));
            tr.append(th, res, el("td", undefined, a), el("td", undefined, b));
            return tr;
        };
        const thead = el("thead"), tbody = el("tbody");
        thead.append(head);
        tbody.append(row("เทียบคะแนน", num(p.score) + " (คอลัมน์ K)", p.stated === null ? "ไม่พบในชีตของแพทย์ (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")"
            : num(p.stated) + (p.statedCell ? " ช่อง " + p.statedCell : "") + " ชีต \"" + (p.sheet || "") + "\" (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")", p.scoreCheck), row("เทียบเงิน", num(p.pay) + " (คอลัมน์ N)", p.deptPay === null ? "ไม่พบในชีตกลุ่มงาน" : num(p.deptPay) + " ชีตกลุ่มงาน" + (p.deptRow != null ? " แถว " + p.deptRow : "") + " (ตามสัดส่วนวิชาชีพ)", p.moneyCheck));
        t.append(cap, thead, tbody);
        panel.append(t);
        // The buttons live in a bar pinned to the bottom of the window
        // (Pong, 2026-11-12: "Approve btn stay btm"), at the end of the
        // panel: any hint and the remark box above them, the buttons last.
        const [bar, ...rest] = decideBox(s, p);
        const foot = el("div", "rv-decide-foot");
        foot.append(...rest, bar);
        // 'check': a check is not ตรงกัน in the new build; say which kind.
        const whyText = p.why === "check" && p.scoreCheck !== "mismatch" && p.moneyCheck !== "mismatch" ? "ไม่พบข้อมูลให้เทียบ" : (WHY_TEXT[p.why || ""] || p.why);
        if (p.why)
            panel.append(el("p", "rv-why", "ตรวจอีกครั้งเพราะ: " + whyText));
        if (p.edit)
            panel.append(el("p", "rv-why", "ผู้จัดทำแก้คะแนน " + num(p.edit.old) + " → " + num(p.edit.new) + (p.edit.note ? " · " + p.edit.note : "")));
        if (p.prev && (p.prev.remark || p.prev.reply)) {
            const prev = el("div", "rv-prev");
            if (p.prev.remark)
                prev.append(el("p", undefined, "รอบก่อน ผู้ตรวจสอบ: " + p.prev.remark));
            prev.append(el("p", undefined, "คำตอบผู้จัดทำ: " + (p.prev.reply || "ไม่มีคำตอบ")));
            panel.append(prev);
        }
        panel.append(evidence(s, r, p), foot);
        // The next person still to check: their sheet is ready when the app moves on.
        const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index);
        if (next)
            loadDetail(s, r, next.index);
        return panel;
    }
    // Show another person: the list and panel just under the counts bar, so
    // อนุมัติ is at the same place on the screen for everyone, and focus on
    // their name (one Tab on is อนุมัติ).
    function openPerson(index) {
        selected = index;
        render();
        toWorkingSpot();
        const h = document.getElementById("rv-person-h");
        if (h)
            h.focus({ preventScroll: true });
    }
    function toWorkingSpot() {
        const wrap = body.querySelector(".rv-review");
        if (!wrap)
            return;
        const fin = body.querySelector(".rv-finish");
        const top = wrap.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
        view.scrollTop = Math.max(0, top - (fin ? fin.offsetHeight : 0) - 10);
        markStuck();
    }
    // The counts bar's height (it wraps on narrow windows) sets where the
    // people list and the decision row stick, and how much of the top a
    // focused control must clear.
    function syncStick() {
        const fin = body.querySelector(".rv-finish");
        const h = fin ? fin.offsetHeight : 0;
        view.style.setProperty("--rv-fin", h + "px");
        view.style.setProperty("--rv-view-h", view.clientHeight + "px");
        // Focus never lands under the counts bar at the top or the
        // buttons bar pinned at the bottom.
        view.style.scrollPaddingTop = h + 10 + "px";
        const foot = body.querySelector(".rv-decide-foot");
        view.style.scrollPaddingBottom = (foot && getComputedStyle(foot).position === "sticky" ? foot.offsetHeight + 10 : 0) + "px";
        markStuck(true);
    }
    // Once the checks have scrolled up out of sight, the bottom bar also
    // names the person.
    function markStuck(force = false) {
        const bar = body.querySelector(".rv-decide-row");
        const cmp = body.querySelector(".rv-compare");
        if (!bar || !cmp)
            return;
        const fin = body.querySelector(".rv-finish");
        const at = view.getBoundingClientRect().top + (fin ? fin.offsetHeight : 0);
        const stuck = cmp.getBoundingClientRect().bottom < at;
        if (!force && stuck === bar.classList.contains("stuck"))
            return;
        bar.classList.toggle("stuck", stuck);
        // The name shown in the pinned row only when the row still fits on
        // one line with it.
        bar.classList.remove("tight");
        const btns = bar.querySelector(".rv-decide-btns");
        const nav = bar.querySelector(".rv-decide-nav");
        if (stuck && btns && nav && nav.offsetTop > btns.offsetTop + 4)
            bar.classList.add("tight");
    }
    view.addEventListener("scroll", () => markStuck(), { passive: true });
    window.addEventListener("resize", syncStick);
    // Keys for the auditor (Pong picked them, 2026-11-12): A อนุมัติ,
    // F ต้องแก้ไข, ← / → the person before / after. By key position
    // (ev.code), so they work with the Thai layout on too; never while
    // typing, in a dialog, with a modifier, or with the sheet focused (its
    // arrows scroll it).
    document.addEventListener("keydown", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.repeat || ev.defaultPrevented)
            return;
        if (role !== "auditor" || view.classList.contains("hidden") || !body.querySelector(".rv-decide-row"))
            return;
        if (document.querySelector("dialog[open]"))
            return;
        const t = ev.target;
        if (t && (t.closest("input, textarea, select, [contenteditable], .rv-sheet")))
            return;
        const id = ev.code === "KeyA" ? "rv-approve" : ev.code === "KeyF" ? "rv-fix"
            : ev.code === "ArrowLeft" ? "rv-prev-person" : ev.code === "ArrowRight" ? "rv-next-person" : "";
        if (!id)
            return;
        const b = document.getElementById(id);
        if (!b || b.disabled)
            return;
        ev.preventDefault();
        b.click();
    });
    // The click that decided one person must not land on the next one's
    // button: ignore pointer clicks for half a second after the panel shows
    // another person, and the second click of a double-click. Keys (detail 0)
    // always work.
    const tooSoon = (ev) => ev.detail > 1 || (ev.detail === 1 && Date.now() - swapAt < 500);
    // What the auditor would most likely write, ready to edit.
    function suggestRemark(p) {
        if (p.scoreCheck === "mismatch")
            return "คะแนนในไฟล์แพทย์ " + num(p.stated) + " แต่ SK03 " + num(p.score);
        if (p.moneyCheck === "mismatch")
            return "เงินในชีตกลุ่มงาน " + num(p.deptPay) + " แต่ SK03 " + num(p.pay);
        if (p.moneyCheck === "missing")
            return "ไม่พบเงินในชีตกลุ่มงาน" + (p.intern ? "" : " " + p.department);
        return "";
    }
    function decideBox(s, p) {
        // Pay must be ตรงกัน. The score may be ตรงกัน, or ไม่พบ (the doctor's
        // file has no saved total): then the auditor looks at the sheet and
        // approves (Pong, 2026-11-10). ไม่ตรงกัน never approves.
        const ok = p.moneyCheck === "match" && p.scoreCheck !== "mismatch";
        const spot = "decide-" + p.index;
        const draftKey = "remark:" + p.index;
        const fe = fieldErrs.get(draftKey);
        // The remark box is open when it is the only way on, when a remark is
        // saved, or when the auditor opened it (kept across re-renders).
        const forced = !ok || p.decision === "fix";
        const open = forced || remarkOpen.has(p.index) || !!fe;
        const out = [];
        const bar = el("div", "rv-decide-row");
        bar.setAttribute("role", "group");
        bar.setAttribute("aria-label", "ตัดสินผล " + p.name);
        const btns = el("div", "rv-decide-btns");
        const approve = el("button", "btn-primary" + (ok ? "" : " rv-off"), p.decision === "approve" ? "✓ อนุมัติแล้ว" : "อนุมัติ");
        approve.type = "button";
        approve.id = "rv-approve";
        approve.setAttribute("aria-keyshortcuts", "A");
        approve.title = "ปุ่มลัด A";
        const fix = el("button", (ok ? "btn-ghost" : "btn-primary") + (open && ok ? " rv-pressed" : ""), p.decision === "fix" ? "✓ ต้องแก้ไขแล้ว" : "ต้องแก้ไข");
        fix.type = "button";
        fix.id = "rv-fix";
        fix.setAttribute("aria-keyshortcuts", "F");
        fix.title = "ปุ่มลัด F";
        btns.append(approve, fix);
        if (p.decision) {
            const undo = el("button", "btn-ghost", "ยกเลิกผล");
            undo.type = "button";
            undo.id = "rv-undo";
            undo.addEventListener("click", (ev) => { if (!tooSoon(ev))
                void decide(s, p, null, "", undo); });
            btns.append(undo);
        }
        const who = el("span", "rv-decide-who", p.name);
        who.setAttribute("aria-hidden", "true");
        const nav = el("div", "rv-decide-nav");
        const list = visiblePeople();
        const i = list.findIndex((x) => x.index === p.index);
        const go = (d, text) => {
            const b = el("button", "btn-ghost", text);
            b.type = "button";
            b.id = d < 0 ? "rv-prev-person" : "rv-next-person";
            b.setAttribute("aria-keyshortcuts", d < 0 ? "ArrowLeft" : "ArrowRight");
            b.title = "ปุ่มลัด " + (d < 0 ? "←" : "→");
            const target = list[i + d];
            b.disabled = !target;
            b.addEventListener("click", () => { if (target)
                openPerson(target.index); });
            return b;
        };
        nav.append(go(-1, "← คนก่อนหน้า"), go(1, "คนถัดไป →"));
        const keys = el("span", "rv-keys", "ปุ่มลัด A · F · ← →");
        keys.setAttribute("aria-hidden", "true");
        bar.append(btns, who, keys, nav);
        // A failed save shows in the row, which is on screen even when pinned.
        const n = noteEl(spot);
        if (n)
            bar.append(n);
        out.push(bar);
        const why = el("div", "rv-decide-hint");
        why.id = "rv-approve-why";
        if (!ok) {
            approve.setAttribute("aria-disabled", "true");
            approve.setAttribute("aria-describedby", why.id);
            why.classList.add("bad");
            why.textContent = (p.moneyCheck === "missing" && p.scoreCheck !== "mismatch" ? "ไม่พบเงินในชีตกลุ่มงาน" : "เทียบไม่ตรงกัน")
                + " อนุมัติไม่ได้ เขียนหมายเหตุแล้วกด บันทึก";
            out.push(why);
        }
        else if (!bothMatch(p)) {
            const txt = el("span", undefined, "ไม่พบยอดรวมในไฟล์แพทย์ ดูชีตของแพทย์ด้านบนก่อน แล้วอนุมัติหรือเลือก ต้องแก้ไข");
            txt.id = "rv-approve-why-text";
            approve.setAttribute("aria-describedby", txt.id);
            const goSheet = el("button", "btn-ghost", "ไปที่ชีต ↑");
            goSheet.type = "button";
            goSheet.id = "rv-go-sheet";
            goSheet.addEventListener("click", showSheet);
            why.append(txt, goSheet);
            out.push(why);
        }
        approve.addEventListener("click", (ev) => {
            if (tooSoon(ev))
                return;
            if (!ok) {
                say(why.textContent || "");
                return;
            }
            void decide(s, p, "approve", "", approve);
        });
        fix.addEventListener("click", (ev) => {
            if (tooSoon(ev))
                return;
            remarkOpen.add(p.index);
            if (!open)
                render();
            const ta = document.getElementById("rv-remark");
            if (ta)
                ta.focus();
        });
        let save = null;
        if (open) {
            const box = el("div", "rv-remark-box");
            box.id = "rv-remark-box";
            const lab = el("label", undefined, p.decision === "fix" ? "หมายเหตุที่ส่งให้ผู้จัดทำ" : "หมายเหตุ ต้องแก้ไขอะไร");
            lab.htmlFor = "rv-remark";
            const ta = keep(el("textarea"), draftKey, p.decision === "fix" ? p.remark : suggestRemark(p));
            ta.id = "rv-remark";
            ta.rows = 2;
            ta.maxLength = 1000;
            const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "");
            err.id = "rv-remark-e";
            if (fe)
                ta.setAttribute("aria-invalid", "true");
            ta.setAttribute("aria-describedby", err.id);
            const sv = el("button", "btn-primary", p.decision === "fix" ? "บันทึกหมายเหตุใหม่" : "บันทึก");
            sv.type = "button";
            sv.id = "rv-fix-save";
            save = sv;
            sv.addEventListener("click", (ev) => {
                if (tooSoon(ev))
                    return;
                if (!ta.value.trim()) {
                    err.textContent = "พิมพ์หมายเหตุว่าต้องแก้อะไร";
                    fieldErrs.set(draftKey, err.textContent);
                    err.classList.remove("hidden");
                    ta.setAttribute("aria-invalid", "true");
                    ta.focus();
                    return;
                }
                fieldErrs.delete(draftKey);
                void decide(s, p, "fix", ta.value, sv);
            });
            const acts = el("div", "rv-actions");
            acts.append(sv);
            // ยกเลิก drops the text; Esc only folds the box away (the text
            // comes back with ต้องแก้ไข).
            const close = (discard) => {
                remarkOpen.delete(p.index);
                if (discard)
                    drafts.delete(draftKey);
                fieldErrs.delete(draftKey);
                render();
                const f = document.getElementById("rv-fix");
                if (f)
                    f.focus({ preventScroll: true });
            };
            if (!forced) {
                const cancel = el("button", "btn-ghost", "ยกเลิก");
                cancel.type = "button";
                cancel.id = "rv-fix-cancel";
                cancel.addEventListener("click", () => close(true));
                acts.append(cancel);
            }
            ta.addEventListener("keydown", (ev) => {
                if (ev.key === "Escape" && !forced) {
                    ev.preventDefault();
                    close(false);
                }
                else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    sv.click();
                }
            });
            box.append(lab, ta, err, acts);
            out.push(box);
        }
        if (flying(s, spot))
            for (const b of [approve, fix, save])
                if (b)
                    markBusy(b);
        return out;
    }
    // ไปที่ชีต: the sheet straight under the counts bar, and the keyboard on it.
    function showSheet() {
        const h = document.getElementById("rv-ev-h");
        const fin = body.querySelector(".rv-finish");
        if (!h)
            return;
        const at = (fin ? fin.offsetHeight : 0) + 10;
        view.scrollTop += h.getBoundingClientRect().top - view.getBoundingClientRect().top - at;
        markStuck();
        const region = document.getElementById("rv-sheet") || h;
        if (region === h && !h.hasAttribute("tabindex"))
            h.tabIndex = -1;
        region.focus({ preventScroll: true });
    }
    // Load one person's sheet and department row once; a failure is kept
    // (shown with a retry) only for the person on screen, so a failed
    // look-ahead just loads again when that person is opened.
    function loadDetail(s, r, index) {
        const key = s.month + ":" + r.round_no + ":" + index;
        if (details.has(key) || detailErrs.has(key) || detailLoading.has(key))
            return;
        detailLoading.add(key);
        const seq = detailSeq;
        void api(monthApi(s) + "/person/" + r.round_no + "/" + index)
            .then((x) => { if (seq === detailSeq)
            details.set(key, x); }, (e) => {
            if (seq !== detailSeq || signedOut(e) || selected !== index)
                return;
            const msg = errText(e, "โหลดไม่สำเร็จ");
            detailErrs.set(key, msg);
            shout("โหลดชีตของแพทย์ไม่สำเร็จ: " + msg);
        })
            .then(() => {
            if (seq !== detailSeq)
                return;
            detailLoading.delete(key);
            if (selected === index)
                render();
        });
    }
    function cellRC(name) {
        const m = /^([A-Z]+)(\d+)$/.exec(name || "");
        if (!m)
            return null;
        let c = 0;
        for (const ch of m[1])
            c = c * 26 + (ch.charCodeAt(0) - 64);
        return [Number(m[2]) - 1, c - 1];
    }
    const colLetters = (c) => { let s2 = "", n = c + 1; while (n > 0) {
        const m = (n - 1) % 26;
        s2 = String.fromCharCode(65 + m) + s2;
        n = Math.floor((n - 1) / 26);
    } return s2; };
    // หลักฐาน: the doctor's sheet first (the ไม่พบ people must read it), then
    // the department row.
    function evidence(s, r, p) {
        const box = el("section", "rv-evidence");
        const h = el("h4", undefined, "หลักฐาน");
        h.id = "rv-ev-h";
        box.setAttribute("aria-labelledby", h.id);
        box.append(h);
        const key = s.month + ":" + r.round_no + ":" + p.index;
        const d = details.get(key);
        if (!d) {
            const de = detailErrs.get(key);
            if (de)
                box.append(failBox("โหลดชีตของแพทย์ไม่สำเร็จ: " + de, "rv-retry-sheet", () => { detailErrs.delete(key); render(); }));
            else {
                box.append(el("p", "rv-hint", "กำลังโหลดชีตของแพทย์…"));
                loadDetail(s, r, p.index);
            }
            return box;
        }
        const g = d.grid;
        if (!g)
            box.append(el("p", "rv-hint", "ไม่มีชีตของแพทย์ให้ดู"));
        else {
            const hit = cellRC(p.statedCell);
            // Only the rows around the score, so the sheet never scrolls up
            // or down (Pong, 2026-11-12): 3 rows above the score cell and 1
            // below; with no cell (a total rebuilt from the days, or none
            // found), the last 5 rows that have something in them.
            let lastRow = 0;
            for (const [rr0, , v0] of g.cells)
                if (v0 !== "" && v0 !== null && rr0 > lastRow)
                    lastRow = rr0;
            const r1 = Math.min(g.rows - 1, hit ? hit[0] + 1 : lastRow);
            const r0 = Math.max(0, hit ? hit[0] - 3 : lastRow - 4);
            const region = el("div", "rv-sheet rv-crop");
            region.id = "rv-sheet";
            region.dataset.key = key;
            region.setAttribute("role", "region");
            region.tabIndex = 0;
            const capId = "rv-sheet-cap";
            region.setAttribute("aria-labelledby", capId);
            const cap = el("p", "rv-sheet-cap", "ชีต \"" + (p.sheet || g.sheet) + "\" ในไฟล์รวม แถว " + (r0 + 1) + "–" + (r1 + 1) + " (ค่าที่บันทึกไว้ในไฟล์ของแพทย์)");
            cap.id = capId;
            if (p.statedCell)
                cap.append(" ", el("span", "rv-cell-chip", "คะแนนอยู่ช่อง " + p.statedCell));
            const tbl = el("table", "rv-xl");
            const map = new Map();
            for (const [rr, cc, v] of g.cells)
                map.set(rr + ":" + cc, v);
            const isHit = (rr, c) => !!hit && hit[0] === rr && hit[1] === c;
            const blank = (rr, c) => { const v = map.get(rr + ":" + c); return (v === undefined || v === "") && !isHit(rr, c); };
            // The score is often far right: then a รายการ column, pinned
            // beside the row numbers, keeps each row's name (its first text
            // in columns A–C) next to the numbers (Pong, 2026-11-12).
            const labelOf = (rr) => {
                for (let c = 0; c < Math.min(3, g.cols); c++) {
                    const v = map.get(rr + ":" + c);
                    if (typeof v === "string" && v.trim())
                        return v.trim();
                }
                return "";
            };
            const pinLabel = !!hit && hit[1] >= 6;
            if (pinLabel)
                region.classList.add("rv-pinlab");
            const hd = el("tr");
            hd.append(el("th", "corner"));
            if (pinLabel) {
                const th = el("th", "lab", "รายการ");
                th.scope = "col";
                hd.append(th);
            }
            for (let c = 0; c < g.cols; c++) {
                const th = el("th", undefined, colLetters(c));
                th.scope = "col";
                hd.append(th);
            }
            const thead = el("thead");
            thead.append(hd);
            const tbody = el("tbody");
            for (let rr = r0; rr <= r1; rr++) {
                const tr = el("tr");
                const th = el("th", undefined, String(rr + 1));
                th.scope = "row";
                tr.append(th);
                if (pinLabel) {
                    const lt = labelOf(rr);
                    const lb = el("td", "lab", lt);
                    lb.title = lt;
                    tr.append(lb);
                }
                for (let c = 0; c < g.cols; c++) {
                    const v = map.get(rr + ":" + c);
                    const td = el("td", typeof v === "number" ? "num" : "", v === undefined ? "" : typeof v === "number" ? num(v) : String(v));
                    if (isHit(rr, c)) {
                        td.className += " hit";
                        td.setAttribute("aria-label", "คะแนนที่ใช้ " + (p.stated !== null ? num(p.stated) : String(v)));
                    }
                    // Text runs on over the empty cells to its right, as in
                    // Excel, so a long title does not make its column wide.
                    else if (typeof v === "string" && v !== "") {
                        let span = 1;
                        while (c + span < g.cols && blank(rr, c + span))
                            span++;
                        if (span > 1) {
                            td.colSpan = span;
                            td.className += " spill";
                            td.replaceChildren(el("span", undefined, String(v)));
                            c += span - 1;
                        }
                    }
                    tr.append(td);
                }
                tbody.append(tr);
            }
            tbl.append(thead, tbody);
            region.append(tbl);
            box.append(cap, region);
            // Bring the cell used as the score into view (it is often far
            // right): sideways only as far as needed, so the activity names on
            // the left stay in view when they fit. Not on a redraw of the
            // sheet already open (render kept its scroll).
            requestAnimationFrame(() => {
                const rh = tbl.querySelector("tbody th");
                if (rh)
                    region.style.setProperty("--rv-rowhead", rh.offsetWidth + "px");
                if (region.dataset.kept || !region.isConnected)
                    return;
                const hc = tbl.querySelector("td.hit");
                if (hc) {
                    const over = hc.offsetLeft + hc.offsetWidth + 24 - region.clientWidth;
                    region.scrollLeft = over > 0 ? over : 0;
                }
                region.dataset.placed = "1";
            });
        }
        if (d.deptRow) {
            const dt = el("table", "rv-dept");
            const cap = el("caption", undefined, "แถวในชีตกลุ่มงาน " + p.department);
            const hr = el("tr");
            for (const x of ["ที่", "ชื่อ", "ตำแหน่ง", "ประเภท", "งานบริหาร (E)", "ตามสัดส่วนวิชาชีพ (F)", "รวม (G)"]) {
                const th = el("th", undefined, x);
                th.scope = "col";
                hr.append(th);
            }
            const tr = el("tr");
            d.deptRow.slice(0, 7).forEach((v, k) => tr.append(el("td", k >= 4 ? "num" : "", typeof v === "number" ? num(v) : String(v === null ? "" : v))));
            const th2 = el("thead");
            th2.append(hr);
            const tb = el("tbody");
            tb.append(tr);
            dt.append(cap, th2, tb);
            box.append(dt);
        }
        return box;
    }
    async function decide(s, p, decision, remark, btn) {
        const spot = "decide-" + p.index;
        if (!begin(s, spot, btn))
            return;
        notes.delete("decided");
        busy = true;
        let moved = false, failed = false;
        try {
            await post(monthApi(s) + "/decisions/" + p.index, { decision, remark }, "PUT");
            p.decision = decision;
            p.remark = decision === "fix" ? remark.trim() : "";
            p.carried = false;
            forget(s, "remark:" + p.index);
            fieldErrs.delete("remark:" + p.index);
            if (decision !== "fix")
                remarkOpen.delete(p.index);
            // Said in the people list, not under the next person's buttons,
            // where it would read as their own result.
            tell(s, "decided", "ok", p.name + ": " + decisionText(p));
            lastDecided = p.index;
            // Straight on to the next person still to check.
            if (decision && s.month === month) {
                const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index);
                if (next) {
                    selected = next.index;
                    moved = true;
                }
            }
        }
        catch (e) {
            failed = true;
            tell(s, spot, "err", p.name + ": " + errText(e, "บันทึกไม่สำเร็จ"));
        }
        finally {
            busy = false;
            end(s, spot);
        }
        // Show the next person at once; the reload only refreshes counts.
        const focusHead = () => {
            const hh = document.getElementById("rv-person-h");
            if (hh)
                hh.focus({ preventScroll: true });
        };
        if (moved && s.month === month) {
            render();
            toWorkingSpot();
            focusHead();
        }
        const pressed = btn.id;
        await reload();
        if (s.month !== month)
            return;
        if (moved) {
            toWorkingSpot();
            focusHead();
            return;
        }
        // After a failure stay on the button that was pressed.
        const back = failed && pressed ? document.getElementById(pressed) : null;
        if (back)
            back.focus({ preventScroll: true });
        else
            focusHead();
    }
    // ปัญหาอื่น ๆ (both sides) ──────────────────────────────────────────────
    function issuesCard(s, side) {
        const kids = [];
        const r = liveRound(s);
        const canAct = side === "auditor" ? !!r && r.status === "submitted" : !!r && r.status === "returned";
        ensureIssues(s);
        if (issuesErr)
            kids.push(failBox("โหลดปัญหาอื่น ๆ ไม่สำเร็จ: " + issuesErr, "rv-retry-issues", retryIssues));
        else if (!issues)
            kids.push(el("p", "rv-loading", "กำลังโหลด…"));
        const list = issues || [];
        if (issues && !list.length)
            kids.push(el("p", "rv-hint", side === "auditor" ? "ยังไม่มี ใช้สำหรับเรื่องที่ไม่ใช่ของแพทย์คนใดคนหนึ่ง เช่น ลายเซ็น หรือยอดรวมของกลุ่มงาน" : "ไม่มี"));
        for (const i of list) {
            const item = el("article", "rv-issue" + (i.status === "closed" ? " closed" : ""));
            const hid = "rv-issue-" + i.id;
            const h = el("h4", undefined, "เรื่องที่ " + i.id + (i.status === "closed" ? " (ปิดแล้ว)" : ""));
            h.id = hid;
            item.setAttribute("aria-labelledby", hid);
            item.append(h, el("p", undefined, i.body), el("p", "rv-hint", "แจ้งรอบที่ " + i.round_no + " · " + when(i.created_at)));
            const ul = el("ul", "rv-replies");
            for (const x of i.replies) {
                ul.append(el("li", undefined, (x.role === "auditor" ? "ผู้ตรวจสอบ" : "ผู้จัดทำ") + (x.round_no === null ? " (ร่าง ส่งไปกับรอบถัดไป)" : "") + ": " + x.body));
            }
            if (i.replies.length)
                item.append(ul);
            if (canAct) {
                const form = el("form", "rv-reply");
                const lab = el("label", "sr-only", "ตอบเรื่องที่ " + i.id);
                const ta = keep(el("textarea"), "reply:" + i.id, "");
                ta.id = "rv-reply-" + i.id;
                ta.rows = 1;
                ta.maxLength = 2000;
                lab.htmlFor = ta.id;
                const send = el("button", "btn-ghost", "ตอบ");
                send.type = "submit";
                send.id = "rv-reply-send-" + i.id;
                const spot = "reply-" + i.id;
                if (flying(s, spot))
                    markBusy(send);
                form.append(lab, ta, send);
                form.addEventListener("submit", (ev) => {
                    ev.preventDefault();
                    if (flying(s, spot))
                        return;
                    if (!ta.value.trim()) {
                        ta.focus();
                        return;
                    }
                    void issueCall(s, spot, "/issues/" + i.id + "/replies", { role: side, body: ta.value }, "ส่งคำตอบแล้ว", send, "reply:" + i.id);
                });
                item.append(form);
                if (side === "auditor") {
                    const t = el("button", "btn-ghost", i.status === "open" ? "ปิดเรื่องนี้" : "เปิดอีกครั้ง");
                    t.type = "button";
                    t.id = "rv-issue-toggle-" + i.id;
                    const tspot = "status-" + i.id;
                    if (flying(s, tspot))
                        markBusy(t);
                    t.addEventListener("click", () => { void issueCall(s, tspot, "/issues/" + i.id + "/status", { open: i.status !== "open" }, i.status === "open" ? "ปิดแล้ว" : "เปิดอีกครั้งแล้ว", t); });
                    item.append(t);
                }
            }
            for (const k of ["reply-" + i.id, "status-" + i.id]) {
                const n = noteEl(k);
                if (n)
                    item.append(n);
            }
            kids.push(item);
        }
        if (side === "auditor" && canAct) {
            const form = el("form", "rv-reply");
            const lab = el("label", undefined, "แจ้งปัญหาอื่น");
            const ta = keep(el("textarea"), "issue:new", "");
            ta.id = "rv-new-issue";
            ta.rows = 2;
            ta.maxLength = 2000;
            lab.htmlFor = ta.id;
            const add = el("button", "btn-ghost", "เพิ่มปัญหา");
            add.type = "submit";
            add.id = "rv-new-issue-add";
            if (flying(s, "issue-new"))
                markBusy(add);
            form.append(lab, ta, add);
            form.addEventListener("submit", (ev) => {
                ev.preventDefault();
                if (flying(s, "issue-new"))
                    return;
                if (!ta.value.trim()) {
                    ta.focus();
                    return;
                }
                void issueCall(s, "issue-new", "/issues", { body: ta.value }, "เพิ่มปัญหาแล้ว", add, "issue:new");
            });
            kids.push(form);
            const n = noteEl("issue-new");
            if (n)
                kids.push(n);
        }
        return card("ปัญหาอื่น ๆ", kids, "rv-h-issues");
    }
    // One request per form at a time; the typed text (draft) is cleared
    // only once the server has it.
    async function issueCall(s, spot, path, json, done, btn, draft) {
        if (!begin(s, spot, btn))
            return;
        try {
            await post(monthApi(s) + path, json);
            if (draft)
                forget(s, draft);
            tell(s, spot, "ok", done);
        }
        catch (e) {
            tell(s, spot, "err", errText(e, "ทำรายการไม่สำเร็จ"));
        }
        finally {
            end(s, spot);
        }
        if (s.month === month)
            issuesKey = "";
        await reload();
    }
    // ผู้จัดทำ: the answer to one person sent back, sent with the next round.
    async function saveAnswer(s, p, text, btn) {
        const spot = "answer-" + p.index;
        if (!begin(s, spot, btn))
            return;
        try {
            await post(monthApi(s) + "/replies/" + p.index, { reply: text }, "PUT");
            p.reply = text.trim();
            const cur = s.month === month && people ? people.find((x) => x.index === p.index) : undefined;
            if (cur)
                cur.reply = p.reply;
            forget(s, "answer:" + p.index);
            tell(s, spot, "ok", "บันทึกคำตอบแล้ว ส่งไปกับรอบถัดไป");
        }
        catch (e) {
            tell(s, spot, "err", errText(e, "บันทึกไม่สำเร็จ"));
        }
        finally {
            end(s, spot);
        }
        render();
    }
})();
