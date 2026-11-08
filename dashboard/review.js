"use strict";
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
;
(function () {
    "use strict";
    const view = document.getElementById("review-view");
    const body = document.getElementById("review-body");
    const monthSel = document.getElementById("review-month");
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
    const uploadOk = (s, kind) => {
        const u = s.uploads[kind];
        return !!(u && s.build && u.result === "latest" && u.build_id === s.build.id);
    };
    const inputsInBuild = (s) => !!(s.inputs && s.build && Number(s.build.budget) === Number(s.inputs.budget) && Number(s.build.per_p4p) === Number(s.inputs.per_p4p));
    const blocking = (s) => (s.build ? s.build.problems.filter((p) => p.blocking) : []);
    const PROBLEM = {
        no_inputs: () => "ยังไม่ได้กรอกงบประมาณและ per P4P (ข้อ 1)",
        inputs_not_in_sheet: () => "งบประมาณหรือ per P4P ใน SK03 ไม่ตรงกับข้อ 1",
        not_in_sk03: (p) => "SK03 ไม่มีชื่อ " + int(p.count || 0) + " คนตามรายชื่อเดือนนี้",
        no_doctor_sheet: (p) => "ไม่พบชีตของแพทย์ " + int(p.count || 0) + " คนในไฟล์รวม",
        not_in_dept_sheet: (p) => "ไม่พบชื่อในชีตกลุ่มงาน " + int(p.count || 0) + " คน",
    };
    // ── Loading ──────────────────────────────────────────────────────────
    async function loadMonths() {
        const r = await api("/dashboard/api/review/months");
        if (!r.installed) {
            renderNotInstalled();
            return false;
        }
        const rows = r.months || [];
        const keep = month && rows.some((m) => m.month === month) ? month : (rows[0] ? rows[0].month : "");
        monthSel.replaceChildren(...rows.map((m) => {
            const o = el("option", undefined, monthName(m.month) + " — " + monthStatus(m));
            o.value = m.month;
            return o;
        }));
        if (keep !== month) {
            month = keep;
            resetMonth();
        }
        monthSel.value = keep;
        return rows.length > 0;
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
        drafts.clear();
        fieldErrs.clear();
        notes.clear();
        draftScope = "";
    }
    const monthStatus = (m) => {
        if (m.round) {
            if (m.round.status === "approved")
                return "อนุมัติครบแล้ว";
            if (m.round.status === "returned")
                return "รอผู้จัดทำแก้ไข (รอบที่ " + m.round.round_no + ")";
            return "กำลังตรวจ รอบที่ " + m.round.round_no;
        }
        if (m.sent < m.total)
            return "แพทย์ส่งไฟล์ " + int(m.sent) + "/" + int(m.total);
        return "รอผู้จัดทำส่งข้อมูล";
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
        body.replaceChildren(failBox("โหลดข้อมูลเดือน " + monthName(month) + " ไม่สำเร็จ: " + msg, "rv-retry-load", () => {
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
        const hadFocus = body.contains(document.activeElement);
        const p = el("p", "rv-loading", text);
        p.tabIndex = -1;
        body.replaceChildren(p);
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
            if (!(await loadMonths())) {
                if (body.querySelector(".rv-loading"))
                    body.replaceChildren(card("ยังไม่มีเดือนให้ตรวจ", [el("p", undefined, "ยังไม่มีตารางรายชื่อของเดือนใด")]));
                return;
            }
        }
        catch (e) {
            if (signedOut(e))
                return;
            const msg = errText(e, "โหลดข้อมูลไม่สำเร็จ");
            shout(msg);
            body.replaceChildren(failBox("โหลดแท็บตรวจสอบไม่สำเร็จ: " + msg, "rv-retry-open", () => { void open(); }));
            return;
        }
        await loadState(true).catch(loadFailed);
    }
    window.addEventListener("dashboard:review", () => { void open(); });
    monthSel.addEventListener("change", () => {
        if (!monthSel.value || monthSel.value === month)
            return;
        month = monthSel.value;
        resetMonth();
        body.replaceChildren(el("p", "rv-loading", "กำลังโหลดเดือน " + monthName(month) + "…"));
        void loadState(true).catch(loadFailed);
    });
    for (const b of roleBtns) {
        b.addEventListener("click", () => {
            role = b.dataset.role === "auditor" ? "auditor" : "auditee";
            try {
                localStorage.setItem(ROLE_KEY, role);
            }
            catch (e) { /* ignore */ }
            render();
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
        body.replaceChildren(card("ยังเปิดใช้แท็บนี้ไม่ได้", [
            el("p", undefined, "ฐานข้อมูลยังไม่มีตารางของแท็บตรวจสอบ ผู้ดูแลระบบต้องรันไฟล์ scripts/review-tab-2026-11.sql ใน Supabase SQL editor ก่อน แล้วรีเฟรชหน้านี้"),
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
        const inBody = !!a && a !== body && body.contains(a);
        const focusId = inBody && a ? a.id : "";
        const holder = inBody && a ? a.closest("[aria-labelledby]") : null;
        const holderId = holder && body.contains(holder) ? holder.getAttribute("aria-labelledby") || "" : "";
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
        const sheetAt = sheet ? { key: sheet.dataset.key || "", top: sheet.scrollTop, left: sheet.scrollLeft } : null;
        refreshLists(s);
        const top = [];
        if (loadError)
            top.push(failBox(loadError, "rv-retry-load", () => { void reload(); }));
        const tn = noteEl("top");
        if (tn)
            top.push(tn);
        body.replaceChildren(...top, ...(role === "auditee" ? auditee(s) : auditor(s)));
        const list2 = body.querySelector(".rv-people-list");
        if (list2)
            list2.scrollTop = listTop;
        const sheet2 = body.querySelector(".rv-sheet");
        if (sheet2 && sheetAt && sheet2.dataset.key === sheetAt.key) {
            sheet2.dataset.kept = "1";
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
                const h = (holderId && document.getElementById(holderId)) || body.querySelector(".rv-turn");
                if (h) {
                    if (!h.hasAttribute("tabindex"))
                        h.tabIndex = -1;
                    h.focus({ preventScroll: true });
                }
            }
        }
        view.scrollTop = viewTop;
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
    function auditee(s) {
        const out = [];
        const r = liveRound(s);
        const name = monthName(s.month, true);
        if (r && r.status === "submitted") {
            out.push(turn("wait", "รอผู้ตรวจสอบ", "ส่งรอบที่ " + r.round_no + " แล้ว เมื่อ " + when(r.submitted_at), r.reopened_at ? "ผู้ตรวจสอบยกเลิกเอกสารเบิกจ่ายและเปิดตรวจอีกครั้ง เมื่อ " + when(r.reopened_at) + " · เหตุผล: " + (r.reopen_reason || "")
                : r.auditor_opened_at ? "ผู้ตรวจสอบเปิดดูแล้ว เมื่อ " + when(r.auditor_opened_at) : "ผู้ตรวจสอบยังไม่ได้เปิด ดึงกลับมาแก้ได้จนกว่าผู้ตรวจสอบจะเปิด"));
            out.push(sentSummary(s, r));
            return out;
        }
        if (r && r.status === "approved")
            return approvedView(s, r, "auditee");
        if (r && r.status === "returned") {
            out.push(turn("you", "ถึงคิวคุณ", "ผู้ตรวจสอบส่งกลับรอบที่ " + r.round_no + " ให้แก้ไข เมื่อ " + when(r.returned_at), "ต้องแก้ " + int(r.counts.fix) + " คน · แก้ในแอป แล้วสร้างไฟล์ใหม่ ดาวน์โหลด และส่งรอบที่ " + (r.round_no + 1)));
        }
        else if (s.roster.sent < s.roster.total) {
            out.push(turn("wait", "รอแพทย์", "แพทย์ส่งไฟล์แล้ว " + int(s.roster.sent) + " จาก " + int(s.roster.total) + " คน", "ระบบสร้าง SK03 ได้เมื่อแพทย์ส่งครบและรายชื่อตรงกับ Drive · กรอกข้อ 1 ไว้ก่อนได้"));
        }
        else {
            out.push(turn("you", "ถึงคิวคุณ", "ส่งข้อมูลเดือน " + name + " ให้ผู้ตรวจสอบ", "แพทย์ส่งไฟล์ครบ " + int(s.roster.total) + " คนแล้ว · ทำตามลำดับข้อ 1 ถึง 3"));
        }
        if (r && r.status === "returned")
            out.push(answersCard(s, r));
        out.push(inputsCard(s), filesCard(s), uploadCard(s));
        return out;
    }
    function inputsCard(s) {
        const form = el("form", "rv-form");
        form.noValidate = true;
        const editable = auditeeTurn(s);
        const field = (id, label, value, hint) => {
            const w = el("div", "rv-field");
            const l = el("label", undefined, label);
            l.htmlFor = id;
            const i = el("input");
            i.id = id;
            i.type = "text";
            i.inputMode = "decimal";
            i.autocomplete = "off";
            const saved = value === null ? "" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (editable)
                keep(i, id, saved);
            else
                i.value = saved;
            const h = el("p", "rv-hint", hint);
            h.id = id + "-h";
            const fe = editable ? fieldErrs.get(id) : undefined;
            const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "");
            err.id = id + "-e";
            if (fe)
                i.setAttribute("aria-invalid", "true");
            i.setAttribute("aria-describedby", h.id + " " + err.id);
            w.append(l, i, h, err);
            return w;
        };
        const base = monthName(s.month, true).replace(/ 25(\d\d)$/, " $1");
        const grid = el("div", "rv-grid");
        form.append(grid);
        grid.append(field("rv-budget", "งบประมาณ P4P ทั้งหมดของเดือน (บาท)", s.inputs ? s.inputs.budget : null, "ระบบใส่ลงแท็บ \"" + base + " - staff\" ช่อง Y9 ให้"), field("rv-rate", "per P4P อินเทิร์น (บาท ต่อคน)", s.inputs ? s.inputs.per_p4p : null, "ระบบใส่ลงแท็บ \"" + base + " - intern\" ช่อง W9 เป็น จำนวนอินเทิร์น × อัตรานี้"));
        const row = el("div", "rv-actions");
        const save = el("button", "btn-primary", "บันทึกและใส่ลง SK03");
        save.type = "submit";
        save.id = "rv-save-inputs";
        if (flying(s, "inputs"))
            markBusy(save);
        row.append(save);
        if (s.inputs)
            row.append(el("p", "rv-saved", "✓ บันทึกแล้ว " + when(s.inputs.updated_at) + (s.inputs.updated_by ? " โดย " + s.inputs.updated_by : "") + " · ระบบใส่ให้อีกทุกคืนหลังสร้าง SK03 ใหม่ ตัวเลขนี้จึงไม่หาย"));
        form.append(row);
        const n = noteEl("inputs");
        if (n)
            form.append(n);
        if (!editable) {
            for (const i of Array.from(form.querySelectorAll("input")))
                i.readOnly = true;
            save.disabled = true;
        }
        form.addEventListener("submit", (ev) => {
            ev.preventDefault();
            void saveInputs(s, form, save);
        });
        return card("1. กรอกงบประมาณและ per P4P (กรอกที่นี่ที่เดียว ไม่ต้องแก้ใน SK03)", [form], "rv-h1");
    }
    const MONEY_RE = /^\d+(\.\d{1,2})?$/;
    async function saveInputs(s, form, btn) {
        if (flying(s, "inputs"))
            return;
        let bad = null;
        const read = (id) => {
            const i = form.querySelector("#" + id);
            const e = form.querySelector("#" + id + "-e");
            const v = i.value.replace(/,/g, "").trim();
            const ok = MONEY_RE.test(v) && Number(v) > 0;
            const msg = ok ? "" : "กรอกตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 9,551.81";
            i.setAttribute("aria-invalid", String(!ok));
            e.textContent = msg;
            e.classList.toggle("hidden", ok);
            if (ok)
                fieldErrs.delete(id);
            else
                fieldErrs.set(id, msg);
            if (!ok && !bad)
                bad = i;
            return v;
        };
        const budget = read("rv-budget"), rate = read("rv-rate");
        if (bad) {
            bad.focus();
            return;
        }
        if (!begin(s, "inputs", btn))
            return;
        busy = true;
        let saved = false;
        try {
            const r = await post(monthApi(s) + "/inputs", { budget, per_p4p: rate }, "PUT");
            saved = true;
            tell(s, "inputs", "ok", r.changed ? "บันทึกแล้ว ระบบกำลังสร้าง SK03 ใหม่ที่มีตัวเลขนี้ ประมาณ 5 ถึง 15 นาที" : "บันทึกแล้ว ตัวเลขเหมือนเดิม");
        }
        catch (e) {
            tell(s, "inputs", "err", errText(e, "บันทึกไม่สำเร็จ"));
        }
        finally {
            busy = false;
            end(s, "inputs");
        }
        if (!saved) {
            await reload();
            return;
        }
        // Saved: the fields show the saved numbers from the new state, or
        // keep what was typed if that state does not come.
        const typed = ["rv-budget", "rv-rate"].map((k) => [k, drafts.get(k)]);
        forget(s, "rv-budget", "rv-rate");
        await loadState(false).catch((e) => {
            if (s.month === month)
                for (const [k, v] of typed)
                    if (v !== undefined && !drafts.has(k))
                        drafts.set(k, v);
            loadFailed(e);
        });
    }
    function requestLine(s) {
        const q = s.request;
        if (!q)
            return null;
        if (["queued", "dispatched"].includes(q.status))
            return el("p", "rv-progress", "⏳ รอเริ่มสร้างไฟล์ใหม่ (ขอเมื่อ " + when(q.requested_at) + ") · ถ้ามีการสร้างอื่นอยู่ จะเริ่มต่อจากนั้น");
        if (q.status === "running")
            return el("p", "rv-progress", "⏳ กำลังสร้าง SK03 และไฟล์รวมใหม่ (เริ่ม " + when(q.started_at) + ") · ประมาณ 5 ถึง 15 นาที หน้านี้จะอัปเดตเอง");
        if (q.status === "failed" && (!s.build || Date.parse(q.requested_at) > Date.parse(s.build.built_at))) {
            const why = q.error === "timed out" ? "งานสร้างไฟล์ไม่เสร็จในเวลาที่กำหนด กดสร้างไฟล์ใหม่อีกครั้งได้" : q.error;
            return el("p", "rv-err", "สร้างไฟล์ไม่สำเร็จ: " + (why || "ไม่ทราบสาเหตุ"));
        }
        return null;
    }
    function filesCard(s) {
        const kids = [];
        const b = s.build;
        const req = openRequest(s);
        const rl = requestLine(s);
        if (!b) {
            kids.push(el("p", undefined, "ยังไม่มีไฟล์ที่ระบบสร้างของเดือนนี้ ระบบสร้างทุกคืนเวลา 00:37 น. เมื่อแพทย์ส่งไฟล์ครบ หรือกดสร้างใหม่ด้านล่าง"));
        }
        else {
            kids.push(el("p", "rv-meta", "ไฟล์ล่าสุดสร้างเมื่อ " + when(b.built_at) + " · " + int(b.people) + " คน (staff " + int(b.staff) + " · อินเทิร์น " + int(b.interns) + ")" +
                (b.budget !== null ? " · งบประมาณ " + baht(b.budget) + " · per P4P " + baht(b.per_p4p) : " · ยังไม่มีงบประมาณ")));
            const ul = el("ul", "rv-checks");
            if (s.inputs && !inputsInBuild(s))
                ul.append(line("bad", req ? "ไฟล์นี้ยังไม่มีตัวเลขที่บันทึกล่าสุด รอไฟล์ใหม่ที่กำลังสร้าง" : "ไฟล์นี้ยังไม่มีงบประมาณและ per P4P ที่บันทึกล่าสุด กดสร้างไฟล์ใหม่"));
            for (const p of b.problems) {
                const text = (PROBLEM[p.code] || (() => p.code))(p) + (p.names && p.names.length ? ": " + p.names.slice(0, 8).join(", ") + (p.names.length > 8 ? " และอีก " + int(p.names.length - 8) + " คน" : "") : "");
                ul.append(line(p.blocking ? "bad" : "warn", text));
            }
            const c = s.buildChecks;
            if (c) {
                const diff = c.scoreMismatch + c.moneyMismatch;
                const miss = c.scoreMissing + c.moneyMissing;
                if (!diff && !miss)
                    ul.append(line("ok", "ระบบเทียบคะแนนและเงินให้แล้ว ตรงกันทุกคน"));
                else
                    ul.append(line("warn", "ระบบเทียบให้แล้ว: คะแนนไม่ตรง " + int(c.scoreMismatch) + " · ไม่พบคะแนนในชีตของแพทย์ " + int(c.scoreMissing) +
                        " · เงินไม่ตรง " + int(c.moneyMismatch) + " · ไม่พบในชีตกลุ่มงาน " + int(c.moneyMissing) + " — แก้ในแอปก่อนส่ง หรือส่งให้ผู้ตรวจสอบพิจารณาก็ได้"));
            }
            if (ul.childNodes.length)
                kids.push(ul);
            const dl = el("ul", "rv-downloads");
            const link = (kind, text) => {
                const li = el("li");
                const a = el("a", "rv-link", text);
                a.id = "rv-dl-" + kind;
                a.href = "/dashboard/api/review/" + s.month + "/file/" + b.id + "/" + kind;
                a.setAttribute("download", "");
                li.append(a);
                return li;
            };
            dl.append(link("sk03", "ดาวน์โหลด SK03 " + monthName(s.month, true) + " เป็น Excel"), link("merged", "ดาวน์โหลดไฟล์รวมคะแนนรายคน " + monthName(s.month, true)));
            kids.push(dl);
        }
        kids.push(el("p", "rv-hint", "ถ้าต้องแก้อะไร: แก้คะแนน ชื่อ หรือกลุ่มงานในแท็บรายชื่อ หรือให้แพทย์ส่งไฟล์ใหม่ทาง LINE หรืออีเมล ห้ามแก้ในไฟล์ Excel แล้วสร้างไฟล์ใหม่ ระบบจะใช้ไฟล์ใหม่เท่านั้น งบประมาณและ per P4P กรอกในข้อ 1 เท่านั้น"));
        const row = el("div", "rv-actions");
        const rebuild = el("button", "btn-ghost", req ? "กำลังสร้างไฟล์ใหม่…" : "สร้าง SK03 และไฟล์รวมใหม่");
        rebuild.type = "button";
        rebuild.id = "rv-rebuild";
        rebuild.disabled = !!req || !auditeeTurn(s);
        rebuild.setAttribute("aria-describedby", "rv-rebuild-h");
        const rh = el("span", "rv-hint", "ใช้หลังแก้ในแอป · ประมาณ 5 ถึง 15 นาที แล้วดาวน์โหลดใหม่");
        rh.id = "rv-rebuild-h";
        if (flying(s, "rebuild"))
            markBusy(rebuild);
        rebuild.addEventListener("click", () => { void doRebuild(s, rebuild); });
        row.append(rebuild, rh);
        kids.push(row);
        const n = noteEl("rebuild");
        if (n)
            kids.push(n);
        if (rl)
            kids.push(rl);
        return card("2. ดาวน์โหลดไฟล์", kids, "rv-h2");
    }
    async function doRebuild(s, btn) {
        if (!begin(s, "rebuild", btn))
            return;
        try {
            await post(monthApi(s) + "/rebuild");
            tell(s, "rebuild", "ok", "ขอสร้างไฟล์ใหม่แล้ว ประมาณ 5 ถึง 15 นาที หน้านี้จะอัปเดตเอง");
        }
        catch (e) {
            tell(s, "rebuild", "err", errText(e, "ขอสร้างไฟล์ใหม่ไม่สำเร็จ"));
        }
        finally {
            end(s, "rebuild");
        }
        await reload();
    }
    const UPLOAD_TEXT = {
        latest: "ตรงกับไฟล์ที่ระบบสร้างล่าสุด ไม่มีการแก้ในไฟล์",
        older: "เป็นไฟล์รุ่นเก่า ดาวน์โหลดไฟล์ล่าสุดในข้อ 2 แล้วเลือกใหม่",
        other_kind: "เป็นไฟล์อีกชนิด (เลือกสลับช่อง) เลือกไฟล์ให้ตรงช่อง",
        unknown: "ไม่ใช่ไฟล์ที่ระบบสร้าง หรือถูกแก้หลังดาวน์โหลด ห้ามแก้ในไฟล์ ให้แก้ในแอป สร้างไฟล์ใหม่ แล้วดาวน์โหลดใหม่",
    };
    function uploadSlot(s, kind) {
        const u = s.uploads[kind];
        const ok = uploadOk(s, kind);
        const title = kind === "sk03" ? "SK03" : "ไฟล์รวมคะแนนรายคน";
        const slot = el("div", "rv-slot" + (u ? (ok ? " ok" : " bad") : ""));
        slot.append(el("h3", undefined, title));
        const status = el("ul", "rv-checks");
        status.id = "rv-" + kind + "-st";
        const sending = flying(s, "upload-" + kind);
        if (u)
            slot.append(el("p", "rv-file", u.file_name + " · " + sizeText(u.bytes) + " · เลือกเมื่อ " + when(u.created_at)));
        if (sending) {
            slot.setAttribute("aria-busy", "true");
            status.append(line("info", "กำลังอัปโหลดและตรวจไฟล์…"));
        }
        else if (u) {
            if (u.result === "latest" && !ok)
                status.append(line("bad", "มีไฟล์ใหม่กว่าที่ระบบสร้างหลังเลือกไฟล์นี้ ดาวน์โหลดใหม่แล้วเลือกอีกครั้ง"));
            else
                status.append(line(ok ? "ok" : "bad", UPLOAD_TEXT[u.result || "unknown"]));
        }
        else {
            status.append(line("info", "ยังไม่ได้เลือกไฟล์"));
        }
        slot.append(status);
        const n = noteEl("upload-" + kind);
        if (n)
            slot.append(n);
        const pick = el("div", "rv-pick");
        const input = el("input");
        input.type = "file";
        input.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        input.id = "rv-file-" + kind;
        input.className = "sr-only";
        input.setAttribute("aria-describedby", status.id);
        if (u && !ok)
            input.setAttribute("aria-invalid", "true");
        const fileWord = kind === "sk03" ? "ไฟล์ SK03" : "ไฟล์รวมคะแนนรายคน";
        const lab = el("label", "btn-ghost rv-btn-label", "เลือก" + fileWord + (u ? "ใหม่" : ""));
        lab.htmlFor = input.id;
        const editable = auditeeTurn(s) && !!s.build;
        input.disabled = !editable;
        if (!editable)
            lab.classList.add("disabled");
        input.addEventListener("change", () => { if (input.files && input.files[0])
            void doUpload(s, kind, input.files[0], slot); });
        pick.append(input, lab, el("span", "rv-hint", "หรือลากไฟล์มาวางในกรอบนี้"));
        slot.append(pick);
        slot.addEventListener("dragover", (ev) => { if (editable) {
            ev.preventDefault();
            slot.classList.add("drag");
        } });
        slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
        slot.addEventListener("drop", (ev) => {
            ev.preventDefault();
            slot.classList.remove("drag");
            const f = ev.dataTransfer && ev.dataTransfer.files[0];
            if (f && editable)
                void doUpload(s, kind, f, slot);
        });
        return slot;
    }
    async function doUpload(s, kind, file, slot) {
        const title = kind === "sk03" ? "SK03" : "ไฟล์รวมคะแนนรายคน";
        const spot = "upload-" + kind;
        if (flying(s, spot))
            return;
        if (!/\.xlsx$/i.test(file.name)) {
            tell(s, spot, "err", title + ": เลือกไฟล์ .xlsx");
            render();
            return;
        }
        if (!begin(s, spot))
            return;
        busy = true;
        slot.setAttribute("aria-busy", "true");
        const st2 = slot.querySelector(".rv-checks");
        st2.replaceChildren(line("info", "กำลังอัปโหลดและตรวจไฟล์…"));
        say(title + ": กำลังอัปโหลดและตรวจไฟล์");
        try {
            const start = await post(monthApi(s) + "/uploads", { kind, fileName: file.name, bytes: file.size });
            const put = await fetch(start.url, { method: "PUT", body: file, headers: { "Content-Type": start.contentType, "x-upsert": "false" } })
                .catch(() => { throw new Error("อัปโหลดไม่สำเร็จ " + NET_ERROR); });
            if (!put.ok)
                throw new Error("อัปโหลดไม่สำเร็จ (" + put.status + ") ลองอีกครั้ง");
            const v = await post(monthApi(s) + "/uploads/" + start.id + "/verify");
            // The slot's own status line shows the result once the state reloads.
            say(title + ": " + (UPLOAD_TEXT[v.result] || v.result));
        }
        catch (e) {
            tell(s, spot, "err", title + ": " + errText(e, "อัปโหลดไม่สำเร็จ"));
        }
        finally {
            busy = false;
            end(s, spot);
        }
        await reload();
    }
    function submitReasons(s) {
        const why = [];
        if (!auditeeTurn(s))
            why.push("ส่งให้ผู้ตรวจสอบแล้ว");
        if (!s.inputs)
            why.push("กรอกงบประมาณและ per P4P ในข้อ 1");
        if (!s.build)
            why.push("รอระบบสร้างไฟล์");
        if (openRequest(s))
            why.push("รอสร้างไฟล์ใหม่ให้เสร็จก่อน");
        else if (s.inputs && s.build && !inputsInBuild(s))
            why.push("สร้างไฟล์ใหม่ให้มีงบประมาณและ per P4P ล่าสุด");
        if (blocking(s).length)
            why.push("แก้ปัญหาที่แจ้งในข้อ 2 ในแอปก่อน");
        if (!uploadOk(s, "sk03"))
            why.push("เลือกไฟล์ SK03 ที่ดาวน์โหลดล่าสุด");
        if (!uploadOk(s, "merged"))
            why.push("เลือกไฟล์รวมคะแนนรายคนที่ดาวน์โหลดล่าสุด");
        return why;
    }
    function uploadCard(s) {
        const grid = el("div", "rv-upload-grid");
        grid.append(uploadSlot(s, "sk03"), uploadSlot(s, "merged"));
        const why = submitReasons(s);
        const row = el("div", "rv-actions");
        const r = liveRound(s);
        const next = r ? r.round_no + 1 : 1;
        const send = el("button", "btn-primary rv-lg", "ตรวจทานและส่งรอบที่ " + next + " ให้ผู้ตรวจสอบ…");
        send.type = "button";
        send.id = "rv-send";
        const reason = el("p", "rv-hint");
        reason.id = "rv-send-why";
        if (why.length) {
            send.setAttribute("aria-disabled", "true");
            send.setAttribute("aria-describedby", reason.id);
            reason.textContent = "ส่งได้เมื่อ: " + why.join(" · ");
        }
        send.addEventListener("click", () => {
            if (why.length) {
                say("ยังส่งไม่ได้: " + why.join(" · "));
                return;
            }
            openConfirm(s, next);
        });
        row.append(send, reason);
        return card("3. เลือกไฟล์ที่ดาวน์โหลดแล้วส่ง", [grid, row], "rv-h3");
    }
    function openConfirm(s, roundNo) {
        const b = s.build;
        const c = s.buildChecks;
        const ul = el("ul", "rv-confirm-list");
        ul.append(el("li", undefined, "เดือน " + monthName(s.month) + " · รอบที่ " + roundNo), el("li", undefined, "งบประมาณ " + baht(b.budget) + " บาท · per P4P อินเทิร์น " + baht(b.per_p4p) + " บาท"), el("li", undefined, int(b.people) + " คน (staff " + int(b.staff) + " · อินเทิร์น " + int(b.interns) + ") · รวมจ่าย " + baht(b.pay_total) + " บาท"), el("li", undefined, "ไฟล์สร้างเมื่อ " + when(b.built_at)));
        if (c && (c.scoreMismatch + c.moneyMismatch + c.scoreMissing + c.moneyMissing)) {
            ul.append(el("li", undefined, "ระบบพบคะแนนหรือเงินไม่ตรง หรือไม่พบ " + int(c.scoreMismatch + c.moneyMismatch + c.scoreMissing + c.moneyMissing) + " รายการ ผู้ตรวจสอบจะพิจารณา"));
        }
        const r = liveRound(s);
        const note = el("p", "rv-hint", r && r.status === "returned"
            ? "รอบนี้ผู้ตรวจสอบจะตรวจคนที่ส่งกลับให้แก้ และคนที่คะแนน กลุ่มงาน หรือชื่อของตัวเองเปลี่ยน หรือผลเทียบไม่ตรงกันแล้ว คนอื่นที่อนุมัติแล้วคงผลเดิม"
            : "หลังส่ง ระบบล็อกตัวเลขและไฟล์ไว้จนกว่าผู้ตรวจสอบจะส่งผลกลับ ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิดดู");
        askConfirm("ตรวจทานก่อนส่งให้ผู้ตรวจสอบ", [ul, note], "ส่งรอบที่ " + roundNo, () => doSubmit(s));
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
            else {
                const h = body.querySelector(".rv-turn");
                if (h) {
                    h.tabIndex = -1;
                    h.focus();
                }
            }
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
        const sk03 = s.uploads.sk03, merged = s.uploads.merged;
        if (!sk03 || !merged)
            return;
        const ok = await confirmRun(s, async () => {
            const r = await post(monthApi(s) + "/rounds", { sk03: sk03.id, merged: merged.id });
            return "ส่งรอบที่ " + r.round.round_no + " ให้ผู้ตรวจสอบแล้ว";
        });
        if (ok)
            await loadMonths().catch(() => false);
        await reload();
        const h = ok ? document.querySelector("#review-body .rv-turn") : null;
        if (h) {
            h.tabIndex = -1;
            h.focus();
        }
    }
    function sentSummary(s, r) {
        const kids = [];
        const ul = el("ul", "rv-confirm-list");
        ul.append(el("li", undefined, "งบประมาณ " + baht(r.budget) + " บาท · per P4P อินเทิร์น " + baht(r.per_p4p) + " บาท"), el("li", undefined, "ผู้ตรวจสอบอนุมัติแล้ว " + int(r.counts.approve) + " · รอตรวจ " + int(r.counts.waiting) + " · ต้องแก้ " + int(r.counts.fix)));
        kids.push(ul);
        if (!r.auditor_opened_at) {
            const row = el("div", "rv-actions");
            const w = el("button", "btn-ghost", "ดึงกลับมาแก้");
            w.type = "button";
            w.id = "rv-withdraw";
            if (flying(s, "withdraw"))
                markBusy(w);
            w.addEventListener("click", () => { void doWithdraw(s, w); });
            row.append(w, el("span", "rv-hint", "ใช้เมื่อส่งผิด · ดึงกลับได้จนกว่าผู้ตรวจสอบจะเปิดดู"));
            kids.push(row);
        }
        const n = noteEl("withdraw");
        if (n)
            kids.push(n);
        return card("รอบที่ " + r.round_no + " ที่ส่งไว้", kids, "rv-h-sent");
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
        "grand-total": "แถวรวมทั้งหมด", "free-text": "ข้อความสรุปยอดรวม", "sub-total": "แถวรวม", "largest-over-sub-total": "ตัวเลขมากที่สุดในชีต (มากกว่าแถวรวม)",
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
        const out = [turn("you", "ถึงคิวคุณ", "ตรวจรอบที่ " + r.round_no + " เดือน " + monthName(s.month, true), "ส่งมาเมื่อ " + when(r.submitted_at) + (r.submitted_by ? " โดย " + r.submitted_by : "") +
                " · งบประมาณ " + baht(r.budget) + " · per P4P อินเทิร์น " + baht(r.per_p4p))];
        out.push(finishBar(s, r));
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
        bar.append(el("p", "rv-counts", "รอตรวจ " + int(c.waiting) + " · อนุมัติ " + int(c.approve) +
            (c.carried ? " (คงผลรอบก่อน " + int(c.carried) + ")" : "") + " · ต้องแก้ไข " + int(c.fix) + " · ปัญหาอื่นที่เปิดอยู่ " +
            (openIssues === null ? (issuesErr ? "โหลดไม่สำเร็จ" : "กำลังโหลด…") : int(openIssues))));
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
        const out = [turn("ok", "เสร็จแล้ว", "อนุมัติครบ " + int(r.counts.approve) + " คน เมื่อ " + when(r.approved_at) +
                (r.approved_by ? " โดย " + r.approved_by : ""), status === "ready" ? "เอกสารเบิกจ่ายพร้อมแล้ว" + (r.pdf_built_at ? " (สร้างเมื่อ " + when(r.pdf_built_at) + ")" : "") + " · ทั้งสองฝั่งดาวน์โหลดได้"
                : status === "failed" ? "สร้างเอกสารเบิกจ่ายไม่สำเร็จ ดูด้านล่าง"
                    : "กำลังสร้างเอกสารเบิกจ่าย (PDF) · ปกติไม่เกินไม่กี่นาที หน้านี้อัปเดตเอง")];
        const kids = [];
        if (status === "ready") {
            const a = el("a", "btn-primary rv-download", "ดาวน์โหลดเอกสารเบิกจ่าย " + monthName(s.month, true) + " (PDF" +
                (r.pdf_pages ? ", " + int(r.pdf_pages) + " หน้า" : "") + (r.pdf_bytes ? ", " + sizeText(r.pdf_bytes) : "") + ")");
            a.href = "/dashboard/api/review/" + s.month + "/pdf";
            a.id = "rv-pdf";
            kids.push(el("div", "rv-actions"));
            kids[0].append(a);
            kids.push(el("p", "rv-hint", "A4 แนวนอน · หน้าแรกสรุปรายกลุ่มงาน ตามด้วยชีตกลุ่มงานทุกกลุ่ม · เวลาอนุมัติอยู่มุมขวาล่างทุกหน้า"));
        }
        else if (status === "failed") {
            const p = el("p", "alert", "สร้างเอกสารเบิกจ่ายไม่สำเร็จ");
            p.setAttribute("role", "alert");
            kids.push(p);
            if (r.pdf_error)
                kids.push(el("p", "rv-hint", "รายละเอียด: " + r.pdf_error));
            const row = el("div", "rv-actions");
            const b = el("button", "btn-primary", "สร้างเอกสารอีกครั้ง");
            b.type = "button";
            b.id = "rv-pdf-retry";
            if (flying(s, "pdf"))
                markBusy(b);
            b.addEventListener("click", () => { void retryPdf(s, b); });
            row.append(b);
            kids.push(row);
        }
        else {
            const p = el("p", "rv-loading", "กำลังสร้างเอกสาร…");
            p.setAttribute("aria-busy", "true");
            kids.push(p);
        }
        const n = noteEl("pdf");
        if (n)
            kids.push(n);
        out.push(card("เอกสารเบิกจ่าย", kids, "rv-h-pdf"));
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
        for (const [v, t] of [["todo", "รอตรวจ"], ["diff", "ผลเทียบไม่ตรง"], ["fix", "ต้องแก้ไข"], ["approve", "อนุมัติแล้ว"], ["all", "ทุกคน"]]) {
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
            if (!bothMatch(p))
                b.append(chip("bad", "ผลเทียบไม่ตรง"));
            b.addEventListener("click", () => { selected = p.index; render(); const t = document.getElementById("rv-person-h"); if (t)
                t.focus(); });
            li.append(b);
            ul.append(li);
        }
        if (!shown.length)
            ul.append(el("li", "rv-hint", filter === "todo" ? "ตรวจครบทุกคนแล้ว" : "ไม่มีรายชื่อ"));
        side.append(tools, count, ul);
        return side;
    }
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
        if (p.why)
            panel.append(el("p", "rv-why", "ตรวจอีกครั้งเพราะ: " + (WHY_TEXT[p.why] || p.why)));
        if (p.prev && (p.prev.remark || p.prev.reply)) {
            const prev = el("div", "rv-prev");
            if (p.prev.remark)
                prev.append(el("p", undefined, "รอบก่อน ผู้ตรวจสอบ: " + p.prev.remark));
            prev.append(el("p", undefined, "คำตอบผู้จัดทำ: " + (p.prev.reply || "ไม่มีคำตอบ")));
            panel.append(prev);
        }
        const t = el("table", "rv-compare");
        const cap = el("caption", "sr-only", "ผลเทียบอัตโนมัติ");
        const head = el("tr");
        for (const x of ["เรื่อง", "SK03", "เทียบกับ", "ผล"]) {
            const th = el("th", undefined, x);
            th.scope = "col";
            head.append(th);
        }
        const row = (label, a, b, check) => {
            const tr = el("tr");
            const th = el("th", undefined, label);
            th.scope = "row";
            const res = el("td");
            res.append(chip(check === "match" ? "ok" : "bad", CHECK_TEXT[check]));
            tr.append(th, el("td", undefined, a), el("td", undefined, b), res);
            return tr;
        };
        const thead = el("thead"), tbody = el("tbody");
        thead.append(head);
        tbody.append(row("เทียบคะแนน", num(p.score) + " (คอลัมน์ K)", p.stated === null ? "ไม่พบในชีตของแพทย์ (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")"
            : num(p.stated) + " ช่อง " + p.statedCell + " ชีต \"" + (p.sheet || "") + "\" (" + (HOW_TEXT[p.statedHow] || p.statedHow) + ")", p.scoreCheck), row("เทียบเงิน", num(p.pay) + " (คอลัมน์ N)", p.deptPay === null ? "ไม่พบในชีตกลุ่มงาน" : num(p.deptPay) + " ชีตกลุ่มงาน แถว " + p.deptRow + " (ตามสัดส่วนวิชาชีพ)", p.moneyCheck));
        t.append(cap, thead, tbody);
        panel.append(t);
        panel.append(sheetBox(s, r, p));
        panel.append(decideBox(s, p));
        const nav = el("div", "rv-actions");
        const list = visiblePeople();
        const i = list.findIndex((x) => x.index === p.index);
        const go = (d, text) => {
            const b = el("button", "btn-ghost", text);
            b.type = "button";
            b.id = d < 0 ? "rv-prev-person" : "rv-next-person";
            const target = list[i + d];
            b.disabled = !target;
            b.addEventListener("click", () => { if (target) {
                selected = target.index;
                render();
                const hh = document.getElementById("rv-person-h");
                if (hh)
                    hh.focus();
            } });
            return b;
        };
        nav.append(go(-1, "← คนก่อนหน้า"), go(1, "คนถัดไป →"));
        panel.append(nav);
        return panel;
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
    function sheetBox(s, r, p) {
        const box = el("div", "rv-sheet-box");
        const key = s.month + ":" + r.round_no + ":" + p.index;
        const d = details.get(key);
        if (!d) {
            const de = detailErrs.get(key);
            if (de) {
                box.append(failBox("โหลดชีตของแพทย์ไม่สำเร็จ: " + de, "rv-retry-sheet", () => { detailErrs.delete(key); render(); }));
                return box;
            }
            box.append(el("p", "rv-hint", "กำลังโหลดชีตของแพทย์…"));
            // One request per person at a time, whatever re-renders meanwhile.
            if (!detailLoading.has(key)) {
                detailLoading.add(key);
                const seq = detailSeq;
                void api(monthApi(s) + "/person/" + r.round_no + "/" + p.index)
                    .then((x) => { if (seq === detailSeq)
                    details.set(key, x); }, (e) => {
                    if (seq !== detailSeq || signedOut(e))
                        return;
                    const msg = errText(e, "โหลดไม่สำเร็จ");
                    detailErrs.set(key, msg);
                    if (selected === p.index)
                        shout("โหลดชีตของแพทย์ไม่สำเร็จ: " + msg);
                })
                    .then(() => {
                    if (seq !== detailSeq)
                        return;
                    detailLoading.delete(key);
                    if (selected === p.index)
                        render();
                });
            }
            return box;
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
        const g = d.grid;
        if (!g) {
            box.append(el("p", "rv-hint", "ไม่มีชีตของแพทย์ให้ดู"));
            return box;
        }
        const hit = cellRC(p.statedCell);
        const region = el("div", "rv-sheet");
        region.id = "rv-sheet";
        region.dataset.key = key;
        region.setAttribute("role", "region");
        region.tabIndex = 0;
        const capId = "rv-sheet-cap";
        region.setAttribute("aria-labelledby", capId);
        const cap = el("p", "rv-sheet-cap", "ชีต \"" + (p.sheet || g.sheet) + "\" ในไฟล์รวม (ค่าที่บันทึกไว้ในไฟล์ของแพทย์)" + (p.statedCell ? " · ช่องที่ใช้เป็นคะแนน: " + p.statedCell : ""));
        cap.id = capId;
        const tbl = el("table", "rv-xl");
        const map = new Map();
        for (const [rr, cc, v] of g.cells)
            map.set(rr + ":" + cc, v);
        const hd = el("tr");
        hd.append(el("th", "corner"));
        for (let c = 0; c < g.cols; c++) {
            const th = el("th", undefined, colLetters(c));
            th.scope = "col";
            hd.append(th);
        }
        const thead = el("thead");
        thead.append(hd);
        const tbody = el("tbody");
        for (let rr = 0; rr < g.rows; rr++) {
            const tr = el("tr");
            const th = el("th", undefined, String(rr + 1));
            th.scope = "row";
            tr.append(th);
            for (let c = 0; c < g.cols; c++) {
                const v = map.get(rr + ":" + c);
                const td = el("td", typeof v === "number" ? "num" : "", v === undefined ? "" : typeof v === "number" ? num(v) : String(v));
                if (hit && hit[0] === rr && hit[1] === c) {
                    td.className += " hit";
                    td.setAttribute("aria-label", "คะแนนที่ใช้ " + (p.stated !== null ? num(p.stated) : String(v)));
                }
                tr.append(td);
            }
            tbody.append(tr);
        }
        tbl.append(thead, tbody);
        region.append(tbl);
        box.append(cap, region);
        // Bring the cell used as the score into view (it is often far right / bottom),
        // unless this is a redraw of the sheet already open (render kept its scroll).
        requestAnimationFrame(() => {
            if (region.dataset.kept)
                return;
            const h = tbl.querySelector("td.hit");
            if (!h)
                return;
            region.scrollTop = Math.max(0, h.offsetTop - region.clientHeight / 2);
            region.scrollLeft = Math.max(0, h.offsetLeft - region.clientWidth / 2);
        });
        return box;
    }
    function decideBox(s, p) {
        const box = el("div", "rv-decide");
        const ok = bothMatch(p);
        const spot = "decide-" + p.index;
        const approve = el("button", "btn-primary", p.decision === "approve" ? "✓ อนุมัติแล้ว" : "อนุมัติ");
        approve.type = "button";
        approve.id = "rv-approve";
        const why = el("p", "rv-hint");
        why.id = "rv-approve-why";
        if (!ok) {
            approve.setAttribute("aria-disabled", "true");
            approve.setAttribute("aria-describedby", why.id);
            why.textContent = "อนุมัติได้เมื่อเทียบคะแนนและเทียบเงินตรงกันทั้งคู่ คนนี้ให้เลือก ต้องแก้ไข พร้อมหมายเหตุ";
        }
        approve.addEventListener("click", () => {
            if (!ok) {
                say(why.textContent || "");
                return;
            }
            void decide(s, p, "approve", "", approve);
        });
        const fixLabel = el("label", undefined, "หมายเหตุ (ต้องมีเมื่อเลือก ต้องแก้ไข)");
        fixLabel.htmlFor = "rv-remark";
        const ta = keep(el("textarea"), "remark:" + p.index, p.decision === "fix" ? p.remark : "");
        ta.id = "rv-remark";
        ta.rows = 2;
        ta.maxLength = 1000;
        const fe = fieldErrs.get("remark:" + p.index);
        const err = el("p", "rv-err" + (fe ? "" : " hidden"), fe || "");
        err.id = "rv-remark-e";
        if (fe)
            ta.setAttribute("aria-invalid", "true");
        ta.setAttribute("aria-describedby", err.id);
        const fix = el("button", "btn-ghost", p.decision === "fix" ? "บันทึกหมายเหตุใหม่" : "ต้องแก้ไข");
        fix.type = "button";
        fix.id = "rv-fix";
        fix.addEventListener("click", () => {
            if (!ta.value.trim()) {
                err.textContent = "พิมพ์หมายเหตุว่าต้องแก้อะไร";
                fieldErrs.set("remark:" + p.index, err.textContent);
                err.classList.remove("hidden");
                ta.setAttribute("aria-invalid", "true");
                ta.focus();
                return;
            }
            fieldErrs.delete("remark:" + p.index);
            void decide(s, p, "fix", ta.value, fix);
        });
        const row = el("div", "rv-actions");
        row.append(approve, fix);
        if (p.decision) {
            const undo = el("button", "btn-ghost", "ยกเลิกผล");
            undo.type = "button";
            undo.id = "rv-undo";
            undo.addEventListener("click", () => { void decide(s, p, null, "", undo); });
            row.append(undo);
        }
        if (flying(s, spot))
            for (const b of [approve, fix])
                markBusy(b);
        box.append(fixLabel, ta, err, row, why);
        const n = noteEl(spot) || noteEl("decided");
        if (n)
            box.append(n);
        return box;
    }
    async function decide(s, p, decision, remark, btn) {
        const spot = "decide-" + p.index;
        if (!begin(s, spot, btn))
            return;
        notes.delete("decided");
        busy = true;
        try {
            await post(monthApi(s) + "/decisions/" + p.index, { decision, remark }, "PUT");
            p.decision = decision;
            p.remark = decision === "fix" ? remark.trim() : "";
            p.carried = false;
            forget(s, "remark:" + p.index);
            tell(s, "decided", "ok", p.name + ": " + decisionText(p));
            // Straight on to the next person still to check.
            if (decision && s.month === month) {
                const next = visiblePeople().find((x) => x.decision === null && x.index !== p.index);
                if (next)
                    selected = next.index;
            }
        }
        catch (e) {
            tell(s, spot, "err", p.name + ": " + errText(e, "บันทึกไม่สำเร็จ"));
        }
        finally {
            busy = false;
            end(s, spot);
        }
        await reload();
        const hh = s.month === month ? document.getElementById("rv-person-h") : null;
        if (hh)
            hh.focus();
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
    // ผู้จัดทำ: what the auditor sent back, with a reply to each ─────────────
    function answersCard(s, r) {
        ensure(s, r);
        const kids = [];
        const fixes = (people || []).filter((p) => p.decision === "fix");
        if (peopleErr)
            kids.push(failBox("โหลดรายชื่อไม่สำเร็จ: " + peopleErr, "rv-retry-people", retryPeople));
        else if (!people)
            kids.push(el("p", "rv-loading", "กำลังโหลด…"));
        else if (!fixes.length)
            kids.push(el("p", "rv-hint", "ไม่มีรายชื่อที่ต้องแก้ ดูปัญหาอื่น ๆ ด้านล่าง"));
        for (const p of fixes) {
            const item = el("article", "rv-issue");
            const hid = "rv-ans-" + p.index;
            const h = el("h4", undefined, p.name + " · " + (p.intern ? "อินเทิร์น" : p.department));
            h.id = hid;
            item.setAttribute("aria-labelledby", hid);
            item.append(h, el("p", undefined, "ผู้ตรวจสอบ: " + p.remark));
            const form = el("form", "rv-reply");
            const lab = el("label", undefined, "คำตอบของผู้จัดทำ (ไม่บังคับ)");
            const ta = keep(el("textarea"), "answer:" + p.index, p.reply);
            ta.id = "rv-answer-" + p.index;
            ta.rows = 1;
            ta.maxLength = 1000;
            lab.htmlFor = ta.id;
            const save = el("button", "btn-ghost", "บันทึกคำตอบ");
            save.type = "submit";
            save.id = "rv-answer-save-" + p.index;
            const spot = "answer-" + p.index;
            if (flying(s, spot))
                markBusy(save);
            form.append(lab, ta, save);
            form.addEventListener("submit", (ev) => {
                ev.preventDefault();
                void saveAnswer(s, p, ta.value, save);
            });
            item.append(form);
            const n = noteEl(spot);
            if (n)
                item.append(n);
            kids.push(item);
        }
        kids.push(el("p", "rv-hint", "แก้ในแอป (แท็บรายชื่อ หรือให้แพทย์ส่งไฟล์ใหม่) แล้วสร้างไฟล์ใหม่ในข้อ 2 ดาวน์โหลด และส่งรอบที่ " + (r.round_no + 1) +
            " ในข้อ 3 รอบถัดไปผู้ตรวจสอบจะตรวจคนที่ต้องแก้ไข และคนที่คะแนน กลุ่มงาน หรือชื่อของตัวเองเปลี่ยน หรือผลเทียบไม่ตรงกัน"));
        const wrap = el("div", "rv-stack");
        wrap.append(card("สิ่งที่ผู้ตรวจสอบให้แก้ (รอบที่ " + r.round_no + ")", kids, "rv-h-ans"), issuesCard(s, "auditee"));
        return wrap;
    }
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
