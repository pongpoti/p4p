/**
 * liff-access-log.js — reports one "page opened" beacon per load to the
 * log_liff_access() RPC, for the Telegram access-alert
 * (scripts/liff-access-alert-2026-08.sql +
 * scripts/liff-access-server-side-2026-08.sql).
 *
 * Deliberately does NOT touch the LIFF SDK. An earlier version called
 * liff.init()/liff.getProfile() here to capture a live LINE identity, but
 * status/list/ranking had never initialized LIFF before, and the first-ever
 * login handshake caused a visible double page-reload in production
 * (reverted same-day). This version sends only the page name — P4P.db
 * already carries the server-injected access token (see auth-guard.js), and
 * log_liff_access() derives the physician's LINE identity itself from
 * whatever physicians.line_user_id/line_display_name was captured the last
 * time they actually logged in and bound LINE. Trade-off, accepted
 * deliberately: the LINE name/ID shown is "as of their last login", not
 * captured fresh on this exact tap.
 *
 * Never blocks or affects the page: any failure is caught and logged to the
 * console only.
 */
;(function (global) {
  "use strict"

  var PAGES = ["/status/", "/list/", "/ranking/"]
  var path = global.location.pathname
  if (PAGES.indexOf(path) === -1 || !global.P4P || !global.P4P.db) return
  var page = path.replace(/\//g, "")

  global.P4P.db
    .rpc("log_liff_access", { p_page: page })
    .then(function (res) {
      if (res && res.error) console.warn("[liff-access-log] rpc error:", res.error)
    })
    .catch(function (err) {
      console.warn("[liff-access-log] report failed:", err)
    })
})(window)
