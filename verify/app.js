      ;(function () {
        // ── LINE-only guard ───────────────────────────────────────────────────
        // The data pages (status/list/ranking) only work inside the LINE app, so
        // there's no point asking a desktop/Chrome visitor to verify. Show the
        // same "open via LINE" block those pages use and stop here.
        const desktopBlock = document.getElementById("desktop-block")
        if (!/Line\//i.test(navigator.userAgent)) {
            if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
                desktopBlock.querySelector("h2").textContent = "กรุณาเปิดผ่าน LINE application"
                desktopBlock.querySelector("p").textContent  = "ขอบคุณสำหรับความร่วมมือ"
            }
            desktopBlock.style.display = "flex"
            return
        }

        const db = supabase.createClient(P4P.SUPABASE_URL, P4P.SUPABASE_KEY, P4P.SUPABASE_OPTS)

        // ── LINE userId binding — REQUIRED, not best-effort ─────────────────────
        // Business rule: we must know every physician's LINE userId as of their
        // first verification. liff.init() itself can still fail silently (no
        // LINE-side consequence if it does — see attemptLineBind/runLineBindFlow
        // below for how a failure is actually handled: retried, then — after
        // BIND_ATTEMPT_LIMIT tries recorded server-side — let through anyway with
        // an admin alert, so a genuine device/permission problem can't lock a
        // physician out of a monthly-use tool forever).
        //
        // Dedicated LIFF app for THIS page. liff.init() requires the current
        // page to match the LIFF app's registered Endpoint URL — it is NOT
        // enough for the id to belong to the same LINE channel. /verify/ is
        // reached via an internal 302 redirect from /status, /ranking, or
        // /list (each of which has ITS OWN LIFF app + endpoint — see
        // scripts/setup-richmenu.mjs / scripts/update-month-picker.mjs), so
        // initializing with any of THOSE ids here failed with "Invalid LIFF
        // ID" / INIT_FAILED regardless of entry point. This id's Endpoint
        // URL is set to /verify/ specifically, matching where this actually runs.
        const LIFF_ID = "2008561527-AShTrJz0"
        let liffInitError = null
        const liffReady = liff.init({ liffId: LIFF_ID }).then(() => true).catch((err) => {
            console.warn("liff.init failed:", err)
            liffInitError = err
            return false
        })

        // ── Return target (open-redirect safe) ────────────────────────────────
        // Only accept same-origin paths: a single leading "/" that is not "//"
        // or "/\" (protocol-relative). Anything else falls back to /status/.
        function safeReturn() {
            const raw = new URLSearchParams(location.search).get("return") || ""
            const dec = (() => { try { return decodeURIComponent(raw) } catch { return "" } })()
            if (/^\/(?![/\\])/.test(dec)) return dec
            return "/status/"
        }
        const RETURN_TO = safeReturn()

        // ── DOM refs ──────────────────────────────────────────────────────────
        const emailStep   = document.getElementById("email-step")
        const codeStep    = document.getElementById("code-step")
        const emailInput  = document.getElementById("email")
        const otpBoxes    = Array.from(document.querySelectorAll(".otp-box"))
        const emailSubmit = document.getElementById("email-submit")
        const codeSubmit  = document.getElementById("code-submit")
        const backBtn     = document.getElementById("back-btn")
        const sentTo      = document.getElementById("sent-to")
        const requestStep = document.getElementById("request-step")
        const reqName     = document.getElementById("reqname")
        const reqEmail    = document.getElementById("req-email")
        const requestSubmit = document.getElementById("request-submit")
        const requestBack = document.getElementById("request-back")
        const bindStep       = document.getElementById("bind-step")
        const bindStatusText = document.getElementById("bind-status-text")
        const bindRetryBtn   = document.getElementById("bind-retry-btn")
        const bindDebugLog   = document.getElementById("bind-debug-log")
        const msg         = document.getElementById("msg")
        const emailLoadingDots = document.getElementById("email-loading-dots")

        let currentEmail = ""

        // ── Helpers ───────────────────────────────────────────────────────────
        // Declared here (before the bind-only early-return below) rather than
        // further down: the bind flow's async callbacks reference these, and if
        // bind-only mode returns early, a `const` declared after that return
        // point is never reached — a later reference to it from an already-
        // in-flight async callback throws (temporal dead zone), which was
        // silently swallowed into the bind flow's own .catch() as a false
        // "bind failed" the first time this shipped. Keep these above ANY early
        // return in this file.
        const showError  = (text) => { msg.className = "msg error";  msg.textContent = text }
        const showOk     = (text) => { msg.className = "msg ok";     msg.textContent = text }
        const showNotice = (text) => { msg.className = "msg notice"; msg.textContent = text }
        const clearMsg   = ()     => { msg.className = "msg";        msg.textContent = "" }
        const busy = (btn, on, label) => {
            btn.disabled = on
            btn.innerHTML = on ? '<span class="spinner"></span>' + label : label
        }

        // ── Shared LINE-bind flow — used by BOTH entry points ───────────────────
        //   1. Fresh OTP verify (codeStep handler): token = data.session.access_token
        //   2. Silent bind bounce (server injected <meta name="p4p-session">):
        //      token = the injected token, no OTP involved at all
        // A retry here must NEVER re-run verifyOtp() — OTP codes are single-use,
        // so retrying the whole form would fail on the already-consumed code.
        // Instead the retry button just re-attempts the bind itself with the
        // SAME still-valid access token.
        function buildAuthedClient(accessToken) {
            return supabase.createClient(P4P.SUPABASE_URL, P4P.SUPABASE_KEY, {
                // Don't reuse `db` / rely on supabase-js's own session bookkeeping —
                // this project already found that unreliable inside LINE's in-app
                // webview (same reason /auth/session extracts tokens directly
                // instead of trusting client-side persistence). Attaching the
                // token explicitly as a header works regardless of that quirk.
                auth: { persistSession: false, autoRefreshToken: false },
                global: { headers: { Authorization: `Bearer ${accessToken}` } },
            })
        }

        // Describes ANY error (JS Error, Supabase PostgrestError, string, etc.)
        // into one readable line — used for the on-screen debug log below, since
        // the physician's device is otherwise a black box with no console access.
        function describeError(err) {
            if (!err) return "unknown error"
            const parts = []
            if (err.message) parts.push(err.message)
            if (err.details) parts.push("details: " + err.details)
            if (err.hint) parts.push("hint: " + err.hint)
            if (err.code) parts.push("code: " + err.code)
            // Dump every OTHER own-enumerable property too — the fixed
            // message/details/hint/code list above covers Supabase/PostgREST
            // errors, but a LIFF SDK error may carry additional fields (e.g.
            // a more specific sub-reason) that this was silently dropping,
            // which is exactly the information needed to pin down why
            // liff.init() rejects a same-page-endpoint LIFF id.
            const known = new Set(["message", "details", "hint", "code"])
            for (const key of Object.keys(err)) {
                if (known.has(key)) continue
                try {
                    const val = typeof err[key] === "object" ? JSON.stringify(err[key]) : String(err[key])
                    parts.push(`${key}: ${val}`)
                } catch { /* unstringifiable — skip */ }
            }
            return parts.length ? parts.join(" | ") : String(err)
        }

        async function attemptLineBind(accessToken) {
            const inited = await liffReady
            if (!inited) {
                // Surface exactly what was attempted, not just the error —
                // the previous "Invalid LIFF ID" report gave no way to
                // confirm the id/URL actually in play at failure time.
                throw new Error(
                    "liff.init failed: " + describeError(liffInitError) +
                    ` | liffId used: ${LIFF_ID}` +
                    ` | page URL: ${location.href}`
                )
            }
            if (!liff.isLoggedIn()) throw new Error("liff.isLoggedIn() returned false")

            // An ID TOKEN, not getProfile(). getProfile() returns plain JSON
            // that this page could put any value into — the old flow passed
            // its userId straight to bind_line_user_id(), so the browser was
            // asserting its own LINE identity and the "binding" proved nothing.
            // An ID token is signed by LINE and verified server-side in
            // main.js (POST /line/bind), so the userId that gets stored is one
            // LINE vouched for. See scripts/line-bind-verified.sql.
            const idToken = liff.getIDToken()
            if (!idToken) {
                throw new Error(
                    "liff.getIDToken() returned null — the LIFF app is almost certainly " +
                    "missing the `openid` scope (getProfile only needs `profile`). " +
                    "Enable it for LIFF id " + LIFF_ID + " in the LINE Developers console."
                )
            }

            const resp = await fetch("/line/bind", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + accessToken,
                },
                body: JSON.stringify({ id_token: idToken }),
            })
            const body = await resp.json().catch(() => ({}))

            // A mismatch is NOT a retryable failure — it means a different,
            // LINE-verified account is presenting itself for this email. The
            // server has already refused it and alerted the admin. Flagged so
            // runLineBindFlow can avoid burning a bind attempt on it: those
            // attempts exist for device/permission problems, and letting a
            // mismatch count down to the fail-open limit would hand an
            // attacker exactly the bypass this whole change removes.
            if (resp.status === 403 && body.status === "mismatch") {
                const mismatchErr = new Error("LINE account does not match the one bound to this email")
                mismatchErr.mismatch = true
                throw mismatchErr
            }
            if (!resp.ok) {
                throw new Error("/line/bind failed: " + resp.status + " " + JSON.stringify(body))
            }
        }

        // Records one failed attempt server-side and returns the running count.
        // If the RPC call itself can't even be reached, fail OPEN (treat as if
        // the limit were hit) — a physician must never be trapped by a failure
        // in the failure-recording mechanism itself.
        async function recordBindFailure(accessToken) {
            try {
                const { data, error } = await buildAuthedClient(accessToken).rpc("record_bind_failure")
                if (error) throw error
                return typeof data === "number" ? data : BIND_ATTEMPT_LIMIT
            } catch (err) {
                console.warn("record_bind_failure failed:", err)
                return BIND_ATTEMPT_LIMIT
            }
        }

        const BIND_ATTEMPT_LIMIT = 3
        let currentBindToken = null

        // Drives the bind-step UI end to end: attempt -> success (redirect) or
        // failure -> record it -> under the limit (show retry) or at the limit
        // (let them through anyway; scripts/line-bind-gate.sql already fired a
        // one-time Telegram alert to the admin at that point).
        function runLineBindFlow(accessToken) {
            currentBindToken = accessToken
            emailStep.classList.add("hidden")
            codeStep.classList.add("hidden")
            requestStep.classList.add("hidden")
            bindStep.classList.remove("hidden")
            bindRetryBtn.classList.add("hidden")
            bindStatusText.innerHTML = '<span class="spinner spinner-dark"></span>กำลังยืนยันบัญชี LINE ของท่าน โปรดรอสักครู่...'

            attemptLineBind(accessToken).then(() => {
                showOk("ยืนยันสำเร็จ กำลังนำท่านเข้าสู่ระบบ...")
                location.replace(RETURN_TO)
            }).catch(async (err) => {
                console.warn("LINE bind failed:", err)
                const ts = new Date().toISOString().slice(11, 19)
                bindDebugLog.textContent += `[${ts}] ${describeError(err)}\n`
                bindDebugLog.classList.remove("hidden")

                // Verified-but-different LINE account: stop here. No retry, no
                // attempt recorded, no redirect — the admin has been alerted
                // and only they can clear the binding (see the runbook at the
                // end of scripts/line-bind-verified.sql).
                if (err && err.mismatch) {
                    showError("บัญชี LINE ของท่านไม่ตรงกับที่ลงทะเบียนไว้")
                    bindStatusText.textContent =
                        "ระบบตรวจพบว่าท่านเข้าใช้งานจากบัญชี LINE อื่น กรุณาติดต่อผู้ดูแลระบบ"
                    bindRetryBtn.classList.add("hidden")
                    return
                }

                const attempts = await recordBindFailure(accessToken)
                if (attempts >= BIND_ATTEMPT_LIMIT) {
                    bindStatusText.textContent = "ข้ามขั้นตอนนี้ชั่วคราว กำลังนำท่านเข้าสู่ระบบ..."
                    setTimeout(() => location.replace(RETURN_TO), 1200)
                } else {
                    bindStatusText.textContent = "ไม่สามารถยืนยันบัญชี LINE ได้ กรุณาลองใหม่อีกครั้ง"
                    bindRetryBtn.classList.remove("hidden")
                }
            })
        }
        bindRetryBtn.addEventListener("click", () => runLineBindFlow(currentBindToken))

        // ── Silent-bind bounce ───────────────────────────────────────────────────
        // main.js redirects an already-verified-but-unbound session here with a
        // real access token injected into <meta name="p4p-session"> (see
        // servePage's "bind_required" case) instead of the usual placeholder.
        // When that's the case, skip straight to the bind flow — no email/OTP
        // entry needed, this person is already logged in.
        const sessionMeta = document.querySelector('meta[name="p4p-session"]')
        const injectedToken = sessionMeta ? sessionMeta.getAttribute("content") : ""
        if (injectedToken && injectedToken !== "__P4P_ACCESS_TOKEN__") {
            runLineBindFlow(injectedToken)
            return
        }

        // The email input starts disabled with loading dots showing over it.
        // Previously this was just a fixed 5s cosmetic delay before handing
        // control to the user. It is now driven by the silent LINE reauth
        // attempt below — see showEmailForm(), which is what actually
        // re-enables it. Declared here (rather than inline below) because
        // sanitizeName/PENDING_KEY/otpBoxes etc. all sit between here and
        // where the reauth attempt is wired up, and this line documents the
        // very first thing that happens on a fresh page load.
        emailInput.disabled = true

        // ── Physician name (request-access step) ────────────────────────────────
        // This used to be a <select> populated from list_all_physicians(), which
        // unions every YYYY_MM roster and returns all ~250 physician names. That
        // RPC is callable by `anon` — it has to be, because this step runs before
        // login — so the dropdown handed the hospital's entire physician roster
        // to anyone holding the publishable key, which is (correctly) published in
        // page source. RLS restricts firstname/lastname to allow-listed
        // authenticated users; that SECURITY DEFINER function bypassed it
        // entirely. It was the only confirmed PII-to-internet path in the app.
        //
        // It is now a plain text field: nothing about the roster crosses the wire.
        // The admin already gets name + email in the Telegram approval alert, so
        // the dropdown was only ever saving them from typos — not worth publishing
        // the roster for. sanitizeName() below mirrors the server-side cleaning in
        // log_access_request(), which is the check that actually counts (the RPC
        // is anon-callable directly, so client validation is advisory only).

        // Strip control characters — including newlines, which would otherwise let
        // a submitted "name" forge extra lines in the admin's Telegram message —
        // collapse whitespace, and cap the length.
        const NAME_MAX = 100
        function sanitizeName(raw) {
            return (
                String(raw || "")
                    // eslint-disable-next-line no-control-regex
                    .replace(/[\u0000-\u001F\u007F]/g, " ") // C0 controls + DEL
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, NAME_MAX)
            )
        }

        // ── Pending-email persistence ─────────────────────────────────────────
        // To read the OTP the user must leave LINE for their email app and come
        // back. If the in-app browser reloads the page during that round-trip,
        // restore the code-entry step instead of dropping them at step 1.
        const PENDING_KEY = "p4p_verify_pending"
        const PENDING_TTL = 15 * 60 * 1000 // 15 min — after this the OTP is likely dead
        const savePending  = (email) => {
            try { localStorage.setItem(PENDING_KEY, JSON.stringify({ email, ts: Date.now() })) } catch { /* storage blocked */ }
        }
        const clearPending = () => {
            try { localStorage.removeItem(PENDING_KEY) } catch { /* storage blocked */ }
        }
        const readPending  = () => {
            try {
                const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null")
                if (p && p.email && Date.now() - p.ts < PENDING_TTL) return p.email
            } catch { /* ignore */ }
            clearPending()
            return null
        }

        // ── OTP six-box input ─────────────────────────────────────────────────
        const getOtpValue = () => otpBoxes.map((b) => b.value).join("")
        const clearOtpBoxes = () => { otpBoxes.forEach((b) => (b.value = "")) }

        otpBoxes.forEach((box, i) => {
            // Normal typing: keep only the last digit typed, advance to the next box.
            // Bulk fill (autofill suggestion, or a paste that slipped past the
            // dedicated paste handler below): distribute the digits across this
            // box and the following ones. No native maxlength is set on these
            // inputs specifically so a multi-character autofill/paste isn't
            // silently truncated to 1 char before this handler ever sees it.
            box.addEventListener("input", () => {
                const digits = box.value.replace(/\D/g, "")
                if (digits.length > 1) {
                    for (let k = 0; k < digits.length && i + k < otpBoxes.length; k++) {
                        otpBoxes[i + k].value = digits[k]
                    }
                    otpBoxes[Math.min(i + digits.length, otpBoxes.length - 1)].focus()
                } else {
                    box.value = digits
                    if (digits && i < otpBoxes.length - 1) otpBoxes[i + 1].focus()
                }
            })

            box.addEventListener("keydown", (e) => {
                if (e.key === "Backspace" && !box.value && i > 0) {
                    e.preventDefault()
                    otpBoxes[i - 1].value = ""
                    otpBoxes[i - 1].focus()
                } else if (e.key === "ArrowLeft" && i > 0) {
                    e.preventDefault()
                    otpBoxes[i - 1].focus()
                } else if (e.key === "ArrowRight" && i < otpBoxes.length - 1) {
                    e.preventDefault()
                    otpBoxes[i + 1].focus()
                }
            })

            // Explicit paste handling: intercept BEFORE the browser inserts the
            // clipboard text, so a full 6-digit paste anywhere always distributes
            // correctly regardless of how the target browser would otherwise
            // truncate/insert it.
            box.addEventListener("paste", (e) => {
                e.preventDefault()
                const text = (e.clipboardData || window.clipboardData).getData("text")
                const digits = text.replace(/\D/g, "").slice(0, otpBoxes.length - i)
                for (let k = 0; k < digits.length; k++) otpBoxes[i + k].value = digits[k]
                if (digits.length) otpBoxes[Math.min(i + digits.length, otpBoxes.length - 1)].focus()
            })
        })

        // Switch to the code-entry step for a given email (after sending, or on
        // restore after a reload).
        const goToCodeStep = (email) => {
            currentEmail = email
            sentTo.textContent = email
            emailStep.classList.add("hidden")
            codeStep.classList.remove("hidden")
            otpBoxes[0].focus()
        }

        // Why did the server send us here? "expired" = the session lapsed;
        // "blocked" = revoked via blocked_emails (a valid session is not enough —
        // main.js re-checks the denylist on every gated-page request); "no_session"
        // is the everyday logged-out case and stays silent; "gate_unavailable"
        // means the gate RPC itself couldn't be reached.
        const bounceReason = new URLSearchParams(location.search).get("reason")
        const reasonShown = bounceReason === "expired" || bounceReason === "blocked"

        // ── Silent LINE reauth ────────────────────────────────────────────────
        // Incident (2026-08): a physician who had already bound a LINE account
        // was still landing on this plain email form on every visit. The cause
        // had nothing to do with the bind itself — is_bound is only ever
        // consulted once a session already exists, and these physicians had NO
        // session cookie at all by the time they reopened the app. Production
        // auth logs showed the same bound account creating a brand-new session
        // every time it reopened, sometimes only hours after its previous
        // session had refreshed successfully — the cookie was not surviving a
        // fresh LIFF launch, most plausibly because LINE gives each
        // chat-triggered launch its own non-persistent webview storage. No
        // cookie attribute fixes that: the browser instance that held it is
        // simply gone by the next tap.
        //
        // What DOES survive across launches is LINE's own login — liff.init()
        // and liff.getIDToken() keep working regardless, because that is tied
        // to the LINE app account, not this webview's storage. So before
        // showing the form at all, ask POST /line/silent-auth (see main.js) to
        // resume a session via that: it verifies the ID token with LINE, looks
        // up the email it was already bound to (never creates a binding — only
        // resumes one the real email+OTP+ID-token flow already established),
        // and mints a fresh Supabase session server-side. No email is sent, no
        // OTP is typed, and an unbound LINE account just falls through to the
        // form exactly as before.
        //
        // Deliberately SKIPPED for "blocked" and "gate_unavailable": retrying
        // either would just mint a session the gate immediately rejects (or
        // hit a live outage again), and a client that kept retrying on
        // "blocked" specifically could loop — mint a session, get bounced back
        // here with the same reason, try again. The server independently
        // refuses to mint a session for a blocked email regardless of what
        // this check does, but there is no reason to even make the round trip
        // in these two cases.
        const pendingEmail = readPending()
        const skipSilentReauth = Boolean(pendingEmail) || bounceReason === "blocked" || bounceReason === "gate_unavailable"

        async function attemptSilentLineReauth() {
            const inited = await liffReady
            if (!inited || !liff.isLoggedIn()) return false
            const idToken = liff.getIDToken()
            if (!idToken) return false
            try {
                const resp = await fetch("/line/silent-auth", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id_token: idToken }),
                })
                return resp.ok
            } catch (err) {
                console.warn("silent LINE reauth failed:", err)
                return false
            }
        }

        // Bounded so a slow/hanging liff.init() can't stall a visitor who has
        // nothing to gain from this check (never bound, or not in LINE at all)
        // indefinitely — they still need to reach the email form eventually.
        function withTimeout(promise, ms) {
            return Promise.race([
                promise,
                new Promise((resolve) => setTimeout(() => resolve(false), ms)),
            ])
        }

        function showEmailForm() {
            emailInput.disabled = false
            emailLoadingDots.classList.add("hidden")
            if (bounceReason === "expired") {
                showNotice("เซสชันหมดอายุ กรุณายืนยันตัวตนอีกครั้ง")
            } else if (bounceReason === "blocked") {
                showError("บัญชีของท่านถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ")
            }
        }

        if (pendingEmail) {
            // A verification was in progress before a reload — restore the code
            // step. Unaffected by silent reauth: we're already mid-flow for a
            // specific email, so there is nothing to resume in its place.
            goToCodeStep(pendingEmail)
            if (!reasonShown) showOk("กรุณากรอกรหัสยืนยันที่ส่งไปยังอีเมลของท่าน")
        } else if (skipSilentReauth) {
            showEmailForm()
        } else {
            withTimeout(attemptSilentLineReauth(), 4000).then((ok) => {
                if (ok) {
                    showOk("ยืนยันสำเร็จ กำลังนำท่านเข้าสู่ระบบ...")
                    location.replace(RETURN_TO)
                    return
                }
                showEmailForm()
            })
        }

        // ── Step 1 — request an OTP ───────────────────────────────────────────
        emailStep.addEventListener("submit", async (e) => {
            e.preventDefault()
            clearMsg()
            const email = emailInput.value.trim().toLowerCase()
            if (!email) return
            // Email-format check before hitting the server.
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                showError("กรุณากรอกอีเมลให้ถูกต้อง")
                return
            }
            busy(emailSubmit, true, "กำลังส่ง...")
            try {
                // Only allow-listed physicians (in physician_directory or
                // sender_physician_match) may proceed. Checked via a SECURITY
                // DEFINER RPC that returns just a boolean, so the email list is
                // never exposed.
                const { data: allowed, error: rpcErr } =
                    await db.rpc("is_sender_allowlisted", { p_email: email })
                if (rpcErr) throw rpcErr
                if (!allowed) {
                    // Not on the list yet — ask for their name so an admin can
                    // identify and add them, then log the request (see request-step).
                    currentEmail = email
                    reqEmail.textContent = email
                    busy(emailSubmit, false, "ส่งรหัสยืนยัน")
                    clearMsg()
                    emailStep.classList.add("hidden")
                    requestStep.classList.remove("hidden")
                    reqName.focus()
                    return
                }

                const { error } = await db.auth.signInWithOtp({
                    email,
                    options: { shouldCreateUser: true },
                })
                if (error) throw error

                savePending(email)      // survive an in-app-browser reload
                goToCodeStep(email)
                busy(emailSubmit, false, "ส่งรหัสยืนยัน")
                showOk("ส่งรหัสยืนยันแล้ว กรุณาตรวจสอบอีเมลของท่าน")
            } catch (err) {
                console.error(err)
                busy(emailSubmit, false, "ส่งรหัสยืนยัน")
                showError("ส่งรหัสไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
            }
        })

        // ── Step 2 — verify the OTP ───────────────────────────────────────────
        codeStep.addEventListener("submit", async (e) => {
            e.preventDefault()
            clearMsg()
            const token = getOtpValue()
            if (!/^[0-9]{6}$/.test(token)) {
                showError("กรุณากรอกรหัส 6 หลัก")
                return
            }
            busy(codeSubmit, true, "กำลังยืนยัน...")
            try {
                const { data, error } = await db.auth.verifyOtp({
                    email: currentEmail,
                    token,
                    type: "email",
                })
                if (error) throw error
                if (!data.session) throw new Error("verifyOtp returned no session")
                clearPending()

                // Hand the tokens to the SERVER, which stores the refresh token in
                // an HttpOnly cookie and validates every page request. The browser
                // never persists a session itself (unreliable in LINE's webview).
                const resp = await fetch("/auth/session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        access_token: data.session.access_token,
                        refresh_token: data.session.refresh_token,
                    }),
                })
                if (!resp.ok) throw new Error("session POST failed: " + resp.status)

                // Session is live at this point. Binding the LINE userId is now a
                // REQUIRED step, not best-effort — runLineBindFlow takes over the UI
                // from here (retry-on-failure, then give up after BIND_ATTEMPT_LIMIT
                // and let them through) and handles the final redirect itself.
                runLineBindFlow(data.session.access_token)
            } catch (err) {
                console.error(err)
                busy(codeSubmit, false, "ยืนยัน")
                showError("รหัสไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่")
            }
        })

        // ── Back to email step ────────────────────────────────────────────────
        backBtn.addEventListener("click", () => {
            clearPending()
            clearMsg()
            codeStep.classList.add("hidden")
            emailStep.classList.remove("hidden")
            clearOtpBoxes()
            emailInput.focus()
        })

        // ── Step 2b — submit an access request (name + email) ─────────────────
        requestStep.addEventListener("submit", async (e) => {
            e.preventDefault()
            clearMsg()
            const name = sanitizeName(reqName.value)
            if (name.length < 2) {
                showError("กรุณากรอกชื่อ-นามสกุลของท่าน")
                return
            }
            busy(requestSubmit, true, "กำลังส่ง...")
            try {
                await db.rpc("log_access_request", { p_email: currentEmail, p_name: name })
                requestStep.classList.add("hidden")
                showNotice("ส่งคำขอเรียบร้อยแล้ว ผู้ดูแลจะเพิ่มสิทธิ์ให้ท่านเร็ว ๆ นี้ กรุณากลับมายืนยันอีกครั้งภายหลัง")
            } catch (err) {
                console.error(err)
                busy(requestSubmit, false, "ส่งคำขอเข้าใช้งาน")
                showError("ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง")
            }
        })

        requestBack.addEventListener("click", () => {
            clearMsg()
            requestStep.classList.add("hidden")
            emailStep.classList.remove("hidden")
            reqName.value = ""
            emailInput.focus()
        })
      })()
