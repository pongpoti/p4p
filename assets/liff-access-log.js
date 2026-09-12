"use strict";
/** GENERATED FILE'S SOURCE — this file is compiled to
 * assets/liff-access-log.js by `npm run build:browser` (see
 * tsconfig.browser.json). Edit this file, not the .js twin, which is a
 * build artifact served byte-for-byte by express.static() and must not be
 * hand-edited. */
/**
 * liff-access-log.js — reports one "page opened" beacon per load to the
 * log_liff_access() RPC, for the Telegram access-alert
 * (scripts/liff-access-alert-2026-08.sql +
 * scripts/liff-access-server-side-2026-08.sql +
 * scripts/liff-access-no-throttle-2026-09.sql +
 * scripts/liff-access-add-upload-2026-09.sql).
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
 * /upload/ DOES call liff.init() itself, for sendMessages()/the opportunistic
 * bind (see upload/app.js) — but not for this beacon specifically: reusing
 * the exact same no-LIFF-SDK design status/list/ranking already settled on
 * keeps this one script identical on all four pages, and there is no reason
 * to risk the double-reload failure mode a second time just for this.
 *
 * Never blocks or affects the page: any failure is caught and logged to the
 * console only.
 */
;
(function (global) {
    "use strict";
    var PAGES = ["/status/", "/list/", "/ranking/", "/upload/"];
    var path = global.location.pathname;
    if (PAGES.indexOf(path) === -1 || !global.P4P || !global.P4P.db)
        return;
    var page = path.replace(/\//g, "");
    global.P4P.db
        .rpc("log_liff_access", { p_page: page })
        .then(function (res) {
        if (res && res.error)
            console.warn("[liff-access-log] rpc error:", res.error);
    })
        .catch(function (err) {
        console.warn("[liff-access-log] report failed:", err);
    });
})(window);
