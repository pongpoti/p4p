"use strict";
/** GENERATED FILE'S SOURCE — this file is compiled to assets/shared.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
/**
 * Shared browser constants + helpers for the P4P LIFF pages
 * (status / list / ranking).
 *
 * Loaded as a plain (synchronous) script BEFORE each page's inline script,
 * so everything here is available on window.P4P by the time the page runs.
 */
;
(function (global) {
    "use strict";
    // Supabase project. This is the PUBLISHABLE (anon) key — safe to expose in
    // the browser; the data is protected by Row Level Security (see
    // scripts/security-rls.sql). Single source of truth for all three pages.
    var SUPABASE_URL = "https://zjeizbrzcltkgtlmkbji.supabase.co";
    var SUPABASE_KEY = "sb_publishable_TcCSpznim4fi0Y7E_zuAsg_op19VZQ-";
    // Month accent colors, index 0 = January: [tailwindClass, hex]
    var COLOR_ARRAY = [
        ["bg-red-300", "#ffa2a2"],
        ["bg-orange-300", "#ffb86a"],
        ["bg-yellow-300", "#ffdf20"],
        ["bg-lime-300", "#bbf451"],
        ["bg-green-300", "#7bf1a8"],
        ["bg-teal-300", "#46ecd5"],
        ["bg-cyan-300", "#53eafd"],
        ["bg-sky-300", "#74d4ff"],
        ["bg-blue-300", "#8ec5ff"],
        ["bg-indigo-300", "#a3b3ff"],
        ["bg-violet-300", "#c4b4ff"],
        ["bg-fuchsia-300", "#f4a8ff"],
    ];
    // Full Thai month names, index 0 = January.
    var THAI_MONTHS = [
        "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
        "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
    ];
    // Abbreviated Thai month names, index 0 = January.
    var THAI_MONTHS_SHORT = [
        "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
        "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
    ];
    // Canonical hospital department list, in the hand-maintained Thai-dictionary
    // order used everywhere else (INTERN forced last). status/app.js and
    // admin/app.js each still hold their own copy of this array — a pre-existing
    // duplication tracked in web/lib/__tests__/parity.test.ts — but verify/app.js
    // reads it from here rather than adding a fourth.
    var DEPARTMENTS = ["กุมารเวชกรรม", "จักษุวิทยา", "จิตเวชและยาเสพติด", "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", "นิติเวช", "ผู้ป่วยนอก", "พยาธิวิทยากายวิภาค", "รังสีวิทยา", "วิสัญญีวิทยา", "เวชกรรมฟื้นฟู", "เวชกรรมสังคม", "เวชศาสตร์ฉุกเฉิน", "ศัลยกรรม", "ศัลยกรรมออร์โธปิดิกส์", "สูติ-นรีเวชกรรม", "โสต ศอ นาสิก", "อาชีวเวชกรรม", "อายุรกรรม", "INTERN"];
    // ── Month window / deadline / upload-file helpers ────────────────────────
    // Used by /upload/ (see UPLOAD_VIA_LINE_DESIGN.md §5.4: these live here
    // rather than inline in upload/app.js so the eventual web/app/upload/ port
    // is a re-import rather than a rewrite, and so the existing parity test has
    // one place to watch).
    // The six months the pages offer, most recent first, as "2569_06" keys.
    // Derived rather than tabulated — the same single rule src/constants.cjs's
    // MONTH_ITERATOR encodes: the i-th most recent month before month m is
    // (m - i) mod 12, crossing into the previous year when m - i goes negative.
    function recentMonthKeys(count, now) {
        var d = now || new Date();
        var m = d.getMonth();
        var beYear = d.getFullYear() + 543;
        var out = [];
        for (var i = 0; i < (count || 6); i++) {
            var idx = ((m - i) % 12 + 12) % 12;
            var year = beYear + ((m - i) < 0 ? -1 : 0);
            out.push(year + "_" + String(idx + 1).padStart(2, "0"));
        }
        return out;
    }
    // "2569_06" -> "มิถุนายน 2569"
    function monthKeyDisplay(key) {
        var parts = String(key || "").split("_");
        var name = THAI_MONTHS[parseInt(parts[1], 10) - 1];
        return name ? name + " " + parts[0] : String(key || "");
    }
    // The 10th of the month AFTER the work month, 23:59:59 Asia/Bangkok — the
    // same instant web/lib/months.ts's deadlineISO() and the enqueue RPC's SQL
    // compute. Ranking counts a submission late past this (§9).
    function deadlineDate(key) {
        var parts = String(key || "").split("_");
        var beYear = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        if (!beYear || !month)
            return null;
        // month is 1-based, so using it as a 0-based index already means "the
        // following month"; December rolls into the next year by itself.
        return new Date(Date.UTC(beYear - 543, month, 10, 16, 59, 59));
    }
    // "10 ก.ค. 23:59" — always rendered in Bangkok time, whatever the device says.
    function deadlineDisplay(key) {
        var d = deadlineDate(key);
        if (!d)
            return "";
        var parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Bangkok", day: "numeric", month: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false,
        }).formatToParts(d).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
        return parseInt(parts.day, 10) + " " + THAI_MONTHS_SHORT[parseInt(parts.month, 10) - 1] +
            " " + parts.hour + ":" + parts.minute;
    }
    // "ภายใน 10 ก.ค." — same cutoff as deadlineDisplay but without the time,
    // for the "กำหนดส่ง" label: the exact hour doesn't need surfacing there,
    // just the day to submit by. deadlineDisplay itself stays untouched since
    // the late-notice banner still wants the precise time you missed.
    function deadlineDueDisplay(key) {
        var d = deadlineDate(key);
        if (!d)
            return "";
        var parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Bangkok", day: "numeric", month: "numeric",
        }).formatToParts(d).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
        return "ภายใน " + parseInt(parts.day, 10) + " " + THAI_MONTHS_SHORT[parseInt(parts.month, 10) - 1];
    }
    function isLateFor(key, when) {
        var d = deadlineDate(key);
        if (!d)
            return false;
        return (when ? new Date(when) : new Date()).getTime() > d.getTime();
    }
    // "2026-06-12T07:32:00Z" -> "12 มิ.ย. 14:32" (Bangkok)
    function shortDateTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime()))
            return "";
        var parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Bangkok", day: "numeric", month: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false,
        }).formatToParts(d).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
        return parseInt(parts.day, 10) + " " + THAI_MONTHS_SHORT[parseInt(parts.month, 10) - 1] +
            " " + parts.hour + ":" + parts.minute;
    }
    // "2026-06-12T07:32:00Z" -> "12 มิ.ย." (Bangkok). The month chips are two
    // to a row, so their subtitle has roughly half a phone's width to live in —
    // the time is dropped there and stays available in ประวัติการส่ง below.
    function shortDate(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime()))
            return "";
        var parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Bangkok", day: "numeric", month: "numeric",
        }).formatToParts(d).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
        return parseInt(parts.day, 10) + " " + THAI_MONTHS_SHORT[parseInt(parts.month, 10) - 1];
    }
    var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
    // Synchronous picker checks (§5.3). UX only — enqueue_p4p_upload() and the
    // worker re-check everything; these exist so the common mistakes fail in a
    // second with a clear reason instead of twenty minutes later over LINE.
    function validateUploadFile(file) {
        if (!file)
            return { ok: false, error: "no_file", message: "กรุณาเลือกไฟล์" };
        var name = String(file.name || "");
        var base = name.split(/[\\/]/).pop();
        if (base && base.indexOf("~$") === 0) {
            return { ok: false, error: "temp_file", message: "ไฟล์นี้เป็นไฟล์ชั่วคราวของ Excel (~$) กรุณาปิดไฟล์แล้วเลือกไฟล์จริง" };
        }
        if (!/\.xlsx$/i.test(name)) {
            return { ok: false, error: "wrong_extension", message: "รองรับเฉพาะไฟล์ Excel (.xlsx) เท่านั้น" };
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            return { ok: false, error: "oversize", message: "ไฟล์ใหญ่เกิน 5 MB กรุณาลดขนาดไฟล์" };
        }
        if (file.size <= 0) {
            return { ok: false, error: "other", message: "ไฟล์ว่าง กรุณาเลือกไฟล์ใหม่" };
        }
        return { ok: true };
    }
    // Every .xlsx is a zip, so its first four bytes are PK\x03\x04. Catches a
    // renamed .xls or a truncated download before it costs a round trip.
    function checkMagicBytes(file) {
        return new Promise(function (resolve) {
            try {
                var reader = new FileReader();
                reader.onload = function () {
                    var b = new Uint8Array(reader.result);
                    resolve(b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04);
                };
                reader.onerror = function () { resolve(true); }; // unreadable slice: let the server decide
                reader.readAsArrayBuffer(file.slice(0, 4));
            }
            catch {
                resolve(true);
            }
        });
    }
    // Escape text before inserting it into innerHTML (prevents HTML/script injection).
    function escHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;"); // also safe inside single-quoted attributes
    }
    // Auth is validated SERVER-side (see main.js): the verify page uses
    // supabase.auth only to run the OTP, then posts the tokens to /auth/session.
    // The data pages get a token injected by the server and never touch auth.
    // persistSession is off because no client-side session is kept anywhere.
    var SUPABASE_OPTS = {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    };
    global.P4P = {
        SUPABASE_URL: SUPABASE_URL,
        SUPABASE_KEY: SUPABASE_KEY,
        SUPABASE_OPTS: SUPABASE_OPTS,
        COLOR_ARRAY: COLOR_ARRAY,
        THAI_MONTHS: THAI_MONTHS,
        THAI_MONTHS_SHORT: THAI_MONTHS_SHORT,
        DEPARTMENTS: DEPARTMENTS,
        escHtml: escHtml,
        MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
        recentMonthKeys: recentMonthKeys,
        monthKeyDisplay: monthKeyDisplay,
        deadlineDate: deadlineDate,
        deadlineDisplay: deadlineDisplay,
        deadlineDueDisplay: deadlineDueDisplay,
        isLateFor: isLateFor,
        shortDateTime: shortDateTime,
        shortDate: shortDate,
        validateUploadFile: validateUploadFile,
        checkMagicBytes: checkMagicBytes,
    };
})(window);
