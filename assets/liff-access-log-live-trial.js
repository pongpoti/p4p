/**
 * liff-access-log-live-trial.js — TRIAL, ranking/ ONLY.
 *
 * status/list keep using assets/liff-access-log.js (no LIFF SDK, identity
 * derived server-side from the last known physicians.line_user_id — see
 * scripts/liff-access-server-side-2026-08.sql). This file instead captures a
 * LIVE LINE identity via liff.getProfile(), the way all three pages
 * originally worked, to test whether the double-reload regression from
 * 2026-08-17/18 was:
 *
 *   (a) a one-time per-device LIFF login handshake — normal, matches how
 *       verify/'s own (unrelated, working) LIFF app has always behaved, and
 *       an acceptable one-off bump, or
 *   (b) a persistent problem — most likely the `profile` scope never having
 *       been confirmed enabled on this LIFF app in the LINE Developers
 *       console, causing a consent LIFF can never actually satisfy.
 *
 * Test: tap the rich-menu Ranking button several times in a row. Reloads
 * once then stops -> (a), safe to port this same approach to status/list and
 * retire the no-LIFF fallback there too. Reloads every time -> (b), revert
 * this file and ranking/index.html's script tags; status/list are
 * unaffected either way, since they never load this file.
 *
 * The RPC (scripts/liff-access-server-side-2026-08.sql) already supports
 * this call shape unchanged: when p_line_user_id/p_line_display_name are
 * supplied, they take priority over the stored physicians fallback — no SQL
 * changes needed for this trial.
 */
;(function (global) {
  "use strict"

  var LIFF_ID = "2008561527-BXrxUUDb" // ranking's dedicated LIFF app
  if (!global.P4P || !global.P4P.db || !global.liff) return

  function report(lineUserId, lineDisplayName, clientError) {
    global.P4P.db
      .rpc("log_liff_access", {
        p_page: "ranking",
        p_line_user_id: lineUserId || null,
        p_line_display_name: lineDisplayName || null,
        p_client_error: clientError || null,
      })
      .then(function (res) {
        if (res && res.error) console.warn("[liff-access-log-live-trial] rpc error:", res.error)
      })
      .catch(function (err) {
        console.warn("[liff-access-log-live-trial] report failed:", err)
      })
  }

  global.liff
    .init({ liffId: LIFF_ID })
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
