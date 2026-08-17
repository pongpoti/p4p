/**
 * liff-access-log.js — best-effort LINE-identity capture + Telegram-alert
 * beacon for the status/list/ranking rich-menu pages.
 *
 * Loaded after supabase-js + shared.js + auth-guard.js (so P4P.db exists,
 * authenticated with this page's server-injected access token) and the LIFF
 * SDK. Reports one beacon per page load to the log_liff_access() RPC
 * (scripts/liff-access-alert-2026-08.sql), which independently re-derives
 * auth state server-side and throttles/fires the Telegram alert — nothing
 * captured here is trusted for security, only for the LINE identity a LIFF
 * page is the sole source of.
 *
 * Never blocks or affects the page: every failure is caught and swallowed,
 * at most reported as p_client_error. status/list/ranking only ever run this
 * once auth has already passed (main.js redirects a failed session to
 * /verify/ before this HTML is served at all) — the auth-fail case is
 * reported separately, from verify/app.js.
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
