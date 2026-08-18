/**
 * liff-access-log.js — live LINE identity capture + Telegram-alert beacon
 * for the status/list/ranking rich-menu pages.
 *
 * History: the original rollout (PR #150) caused a visible double
 * page-reload on every tap and was hotfixed to a no-LIFF, server-derived-
 * identity fallback (PR #151/#152). A single-page trial on ranking/ alone
 * (PR #153) confirmed the reload happens ONCE per device — the normal,
 * expected first-time LIFF login handshake, same as verify/'s own LIFF app
 * has always done — not a persistent problem. This restores live capture to
 * all three pages (2026-08-18).
 *
 * log_liff_access() (scripts/liff-access-server-side-2026-08.sql) still
 * falls back to the physician's last-known stored LINE identity if this
 * ever fails to report one (a genuine LIFF/network error, or a visitor not
 * logged into LIFF) — that safety net is unchanged and still worth having.
 *
 * Never blocks or affects the page: any failure is caught and logged to the
 * console only.
 */
;(function (global) {
  "use strict"

  // Each rich-menu button opens its own dedicated LIFF app (Endpoint URL
  // fixed to this exact path in the LINE Developers console) — see
  // scripts/setup-richmenu.mjs and main.js's createStatusSublist().
  var LIFF_IDS = {
    "/status/": "2008561527-a0xP1XmY",
    "/list/": "2008561527-wyje9amz",
    "/ranking/": "2008561527-BXrxUUDb",
  }

  var path = global.location.pathname
  var liffId = LIFF_IDS[path]
  if (!liffId || !global.P4P || !global.P4P.db || !global.liff) return
  var page = path.replace(/\//g, "")

  function report(lineUserId, lineDisplayName, clientError) {
    global.P4P.db
      .rpc("log_liff_access", {
        p_page: page,
        p_line_user_id: lineUserId || null,
        p_line_display_name: lineDisplayName || null,
        p_client_error: clientError || null,
      })
      .then(function (res) {
        if (res && res.error) console.warn("[liff-access-log] rpc error:", res.error)
      })
      .catch(function (err) {
        console.warn("[liff-access-log] report failed:", err)
      })
  }

  global.liff
    .init({ liffId: liffId })
    .then(function () {
      if (!global.liff.isLoggedIn()) {
        report(null, null, "liff not logged in")
        return
      }
      return global.liff
        .getProfile()
        .then(function (profile) {
          report(profile.userId, profile.displayName, null)
        })
        .catch(function (err) {
          report(null, null, "getProfile failed: " + (err && err.message))
        })
    })
    .catch(function (err) {
      report(null, null, "liff.init failed: " + (err && err.message))
    })
})(window)
