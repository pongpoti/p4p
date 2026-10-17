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
    const userName     = document.getElementById("user-name") as HTMLElement
    const loginError   = document.getElementById("login-error") as HTMLElement

    // Set by the /dashboard/login -> LINE -> /dashboard/auth/callback round trip.
    const ERRORS: Record<string, string> = {
        not_allowed: "บัญชี LINE นี้ไม่มีสิทธิ์เข้าใช้งานแดชบอร์ด",
        login_failed: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่",
        bad_state: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่",
        login_disabled: "ระบบเข้าสู่ระบบยังไม่ได้ตั้งค่า",
    }
    const errorCode = new URLSearchParams(location.search).get("error")
    if (errorCode) history.replaceState(null, "", location.pathname)

    logoutBtn.addEventListener("click", async () => {
        await fetch("/dashboard/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
        location.reload()
    })

    // ── Boot ─────────────────────────────────────────────────────────────
    // LINE Login session (see main.ts). The page itself is not gated
    // server-side; /dashboard/api/session is.
    ;(async function main() {
        let session: { name?: string } | null = null
        try {
            const r = await fetch("/dashboard/api/session", { credentials: "same-origin" })
            if (r.ok) session = await r.json()
        } catch (e) {
            session = null
        }
        load.style.display = "none"
        if (!session) {
            if (errorCode) {
                loginError.textContent = ERRORS[errorCode] || ERRORS.login_failed
                loginError.classList.remove("hidden")
            }
            unauthorized.classList.remove("hidden")
            return
        }
        if (session.name) {
            userName.textContent = session.name
            userName.classList.remove("hidden")
        }
        logoutBtn.classList.remove("hidden")
        empty.classList.remove("hidden")
    })()
})()
