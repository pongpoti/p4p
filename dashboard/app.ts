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
    const logoutBtn = document.getElementById("logout-btn") as HTMLElement
    const userName  = document.getElementById("user-name") as HTMLElement

    logoutBtn.addEventListener("click", async () => {
        await fetch("/dashboard/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.href = "/dashboard/login"
    })

    // ── Boot ─────────────────────────────────────────────────────────────
    // main.ts only serves this page to a signed-in, allowlisted LINE user,
    // so this call just fills in the name. A 401 here means the session
    // ended since the page loaded: back to the login page.
    ;(async function main() {
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" })
            if (r.status === 401) {
                location.href = "/dashboard/login"
                return
            }
            if (r.ok) {
                const session: { name?: string } = await r.json()
                userName.textContent = session.name || ""
            }
        } catch (e) {
            // Name stays blank; the page itself is already authorised.
        }
    })()
})()
