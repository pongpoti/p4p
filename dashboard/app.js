"use strict";
/** GENERATED FILE'S SOURCE — this file is compiled to dashboard/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
;
(function () {
    "use strict";
    // ── Desktop-only gate — the inverse of the LIFF pages' mobile gate ───
    const mobileBlock = document.getElementById("mobile-block");
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        mobileBlock.style.display = "flex";
        return;
    }
    // ── DOM refs ─────────────────────────────────────────────────────────
    const load = document.getElementById("load");
    const unauthorized = document.getElementById("unauthorized");
    const empty = document.getElementById("empty");
    const logoutBtn = document.getElementById("logout-btn");
    logoutBtn.addEventListener("click", async () => {
        await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => { });
        location.reload();
    });
    (async function main() {
        let ok = false;
        try {
            const r = await fetch("/admin/api/session", { credentials: "same-origin" });
            ok = r.ok;
        }
        catch (e) {
            ok = false;
        }
        load.style.display = "none";
        if (!ok) {
            unauthorized.classList.remove("hidden");
            return;
        }
        logoutBtn.classList.remove("hidden");
        empty.classList.remove("hidden");
    })();
})();
