/**
 * Shared browser constants + helpers for the P4P LIFF pages
 * (status / list / ranking).
 *
 * Loaded as a plain (synchronous) script BEFORE each page's inline script,
 * so everything here is available on window.P4P by the time the page runs.
 */
(function (global) {
  "use strict"

  // Supabase project. This is the PUBLISHABLE (anon) key — safe to expose in
  // the browser; the data is protected by Row Level Security (see
  // scripts/security-rls.sql). Single source of truth for all three pages.
  var SUPABASE_URL = "https://zjeizbrzcltkgtlmkbji.supabase.co"
  var SUPABASE_KEY = "sb_publishable_TcCSpznim4fi0Y7E_zuAsg_op19VZQ-"

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
  ]

  // Full Thai month names, index 0 = January.
  var THAI_MONTHS = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
  ]

  // Abbreviated Thai month names, index 0 = January.
  var THAI_MONTHS_SHORT = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
  ]

  // Canonical hospital department list, in the hand-maintained Thai-dictionary
  // order used everywhere else (INTERN forced last). status/app.js and
  // admin/app.js each still hold their own copy of this array — a pre-existing
  // duplication tracked in web/lib/__tests__/parity.test.ts — but verify/app.js
  // reads it from here rather than adding a fourth.
  var DEPARTMENTS = ["กุมารเวชกรรม", "จักษุวิทยา", "จิตเวชและยาเสพติด", "เทคนิคการแพทย์และพยาธิวิทยาคลินิก", "นิติเวช", "ผู้ป่วยนอก", "พยาธิวิทยากายวิภาค", "รังสีวิทยา", "วิสัญญีวิทยา", "เวชกรรมฟื้นฟู", "เวชกรรมสังคม", "เวชศาสตร์ฉุกเฉิน", "ศัลยกรรม", "ศัลยกรรมออร์โธปิดิกส์", "สูติ-นรีเวชกรรม", "โสต ศอ นาสิก", "อาชีวเวชกรรม", "อายุรกรรม", "INTERN"]

  // Escape text before inserting it into innerHTML (prevents HTML/script injection).
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;") // also safe inside single-quoted attributes
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
  }

  global.P4P = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY,
    SUPABASE_OPTS: SUPABASE_OPTS,
    COLOR_ARRAY: COLOR_ARRAY,
    THAI_MONTHS: THAI_MONTHS,
    THAI_MONTHS_SHORT: THAI_MONTHS_SHORT,
    DEPARTMENTS: DEPARTMENTS,
    escHtml: escHtml,
  }
})(window)
