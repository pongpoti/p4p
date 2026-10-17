/** GENERATED FILE'S SOURCE — this file is compiled to dashboard/app.js by
 * `npm run build:browser` (see tsconfig.browser.json). Edit this file, not
 * the .js twin, which is a build artifact served byte-for-byte by
 * express.static() and must not be hand-edited. */
;(function () {
    "use strict"

    // ── Desktop-only gate — the inverse of the LIFF pages' mobile gate ───
    const mobileBlock = document.getElementById("mobile-block") as HTMLElement
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        mobileBlock.style.display = "flex"
        return
    }

    // ── DOM refs ─────────────────────────────────────────────────────────
    const load         = document.getElementById("load") as HTMLElement
    const unauthorized = document.getElementById("unauthorized") as HTMLElement
    const empty        = document.getElementById("empty") as HTMLElement
    const logoutBtn    = document.getElementById("logout-btn") as HTMLElement

    logoutBtn.addEventListener("click", async () => {
        await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.reload()
    })

    // ── Boot ─────────────────────────────────────────────────────────────
    // Same admin cookie as /admin/ (LINE DM -> signed login link). The page
    // itself is not gated server-side; /admin/api/session is.
    ;(async function main() {
        let ok = false
        try {
            const r = await fetch("/admin/api/session", { credentials: "same-origin" })
            ok = r.ok
        } catch (e) {
            ok = false
        }
        load.style.display = "none"
        if (!ok) {
            unauthorized.classList.remove("hidden")
            return
        }
        logoutBtn.classList.remove("hidden")
        empty.classList.remove("hidden")
    })()
})()
