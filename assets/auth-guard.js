"use strict";
/** GENERATED FILE'S SOURCE — this file is compiled to assets/auth-guard.js
 * by `npm run build:browser` (see tsconfig.browser.json). Edit this file,
 * not the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
/**
 * auth-guard.js — client half of the SERVER-side auth gate for the P4P pages
 * (status / list / ranking). Loaded after the Supabase UMD bundle + shared.js,
 * before each page's app.js.
 *
 * The server (main.js) validates the HttpOnly session cookie and injects the
 * current access token into <meta name="p4p-session"> before serving the page.
 * This script reads that token, builds the Supabase data client authenticated
 * with it (RLS enforces the allow-list) as P4P.db, reveals the page, and
 * resolves P4P.ready. There is no client-side session storage — the LINE in-app
 * browser doesn't persist one reliably, which is why validation is server-side.
 *
 * If the token is missing (page reached without the server gate) it redirects
 * to /verify/ as a fail-safe.
 */
;
(function (global) {
    "use strict";
    // The `|| (global.P4P = {})` branch is a defensive fallback for the
    // (never-expected) case where shared.js hasn't run yet — asserted to
    // P4PGlobal since a real empty object can't structurally satisfy it; the
    // rest of this file behaves exactly as before regardless.
    var P4P = global.P4P || (global.P4P = {});
    // Hide the body until we confirm a token is present.
    var style = document.createElement("style");
    style.textContent = "html.p4p-unverified body{visibility:hidden!important}";
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.classList.add("p4p-unverified");
    function reveal() {
        document.documentElement.classList.remove("p4p-unverified");
    }
    var meta = document.querySelector('meta[name="p4p-session"]');
    var at = meta ? (meta.getAttribute("content") || "") : "";
    if (!at || at === "__P4P_ACCESS_TOKEN__") {
        // Fail-safe: the server should have redirected already, but if not, do it.
        var ret = encodeURIComponent(global.location.pathname + global.location.search + global.location.hash);
        global.location.replace("/verify/?return=" + ret + "&reason=no_session");
        P4P.db = null;
        P4P.ready = new Promise(function () { }); // never resolves — navigating away
        return;
    }
    // Data client authenticated with the injected user token. The `accessToken`
    // provider is the supported way to bring your own token — supabase-js uses it
    // for every request (verified: sends `Authorization: Bearer <token>`).
    P4P.db = global.supabase.createClient(P4P.SUPABASE_URL, P4P.SUPABASE_KEY, {
        accessToken: function () { return Promise.resolve(at); },
    });
    reveal();
    P4P.ready = Promise.resolve(true);
})(window);
