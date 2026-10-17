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
    const logoutBtn = document.getElementById("logout-btn");
    const userName = document.getElementById("user-name");
    logoutBtn.addEventListener("click", async () => {
        await fetch("/dashboard/logout", { method: "POST", credentials: "same-origin" }).catch(() => { });
        location.href = "/dashboard/login";
    });
    (async function main() {
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" });
            if (r.status === 401) {
                location.href = "/dashboard/login";
                return;
            }
            if (r.ok) {
                const session = await r.json();
                userName.textContent = session.name || "";
            }
        }
        catch (e) {
            // Name stays blank; the page itself is already authorised.
        }
    })();
})();
