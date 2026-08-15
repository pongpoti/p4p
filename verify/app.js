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

        // ── LINE identity capture ────────────────────────────────────────────
        // Traceability only — matching a LINE account to a verified email — not
        // a second auth factor. Email OTP alone is sufficient to log in; a
        // missing or unavailable LINE ID token here never blocks that. See
        // scripts/auth-rewrite-2026-08.sql and supabase/functions/line-verify,
        // which owns all LINE verification now (not this app's own server).
        //
        // Dedicated LIFF app for THIS page. liff.init() requires the current
        // page to match the LIFF app's registered Endpoint URL — it is NOT
        // enough for the id to belong to the same LINE channel. /verify/ is
        // reached via an internal 302 redirect from /status, /ranking, or
        // /list (each of which has ITS OWN LIFF app + endpoint), so
        // initializing with any of THOSE ids here fails with "Invalid LIFF
        // ID" regardless of entry point. This id's Endpoint URL is set to
        // /verify/ specifically, matching where this actually runs. It needs
        // BOTH the `profile` and `openid` scopes enabled in the LINE
        // Developers console — liff.getIDToken() returns null without
        // `openid`, handled below as a no-op rather than an error.
        const LIFF_ID = "2008561527-AShTrJz0"
        const liffReady = liff.init({ liffId: LIFF_ID }).then(() => true).catch((err) => {
            console.warn("liff.init failed:", err)
            return false
        })

        async function getLineIdToken() {
            const inited = await liffReady
            if (!inited || !liff.isLoggedIn()) return null
            try { return liff.getIDToken() || null } catch (err) { return null }
        }

        // Bounded so a slow/hanging liff.init() can't stall a visitor who has
        // nothing to gain from it (never bound, or not really in LINE) — they
        // still need to reach the email form eventually.
        function withTimeout(promise, ms, fallback) {
            return Promise.race([
                promise,
                new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
            ])
        }

        // POST to the Supabase Edge Function that owns all LINE verification —
        // see supabase/functions/line-verify. Never same-origin: this app's own
        // server (main.js) has no LINE-verification code path at all anymore.
        async function callLineVerify(payload) {
            try {
                const resp = await fetch(P4P.SUPABASE_URL + "/functions/v1/line-verify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", apikey: P4P.SUPABASE_KEY },
                    body: JSON.stringify(payload),
                })
                return await resp.json()
            } catch (err) {
                console.warn("line-verify call failed:", err)
                return { ok: false }
            }
        }

        // Hands a session's tokens to this app's own server, which stashes the
        // refresh token in an HttpOnly cookie — the LIFF in-app browser doesn't
        // reliably persist its own storage across navigations/launches, so the
        // server holds the session instead (see main.js). This is now the ONLY
        // thing /auth/session does.
        async function establishSession(accessToken, refreshToken) {
            const resp = await fetch("/auth/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
            })
            if (!resp.ok) throw new Error("session POST failed: " + resp.status)
        }

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
        const reqDept     = document.getElementById("reqdept")
        const reqEmail    = document.getElementById("req-email")
        const requestSubmit = document.getElementById("request-submit")
        const requestBack = document.getElementById("request-back")
        const msg         = document.getElementById("msg")
        const emailLoadingDots = document.getElementById("email-loading-dots")

        let currentEmail = ""
        // Best-effort LINE ID token for this page load, captured once (on
        // boot) and reused both for the silent-reauth attempt below and, if
        // that doesn't apply, for the traceability bind after OTP succeeds —
        // one liff.getIDToken() call, not two.
        let capturedIdToken = null

        // Populate the department dropdown from the shared list (assets/shared.js)
        // once, at load — nothing here is a roster of physicians, so there is no
        // repeat of the list_all_physicians() PII concern the name field's comment
        // above it documents.
        for (const dept of P4P.DEPARTMENTS) {
            const opt = document.createElement("option")
            opt.value = dept
            opt.textContent = dept
            reqDept.appendChild(opt)
        }

        // ── Helpers ───────────────────────────────────────────────────────────
        const showError  = (text) => { msg.className = "msg error";  msg.textContent = text }
        const showOk     = (text) => { msg.className = "msg ok";     msg.textContent = text }
        const showNotice = (text) => { msg.className = "msg notice"; msg.textContent = text }
        const clearMsg   = ()     => { msg.className = "msg";        msg.textContent = "" }
        const busy = (btn, on, label) => {
            btn.disabled = on
            btn.innerHTML = on ? '<span class="spinner"></span>' + label : label
        }

        // ── Physician name (request-access step) ────────────────────────────────
        // Free text, not a roster dropdown — see SECURITY_ANALYSIS.md §2a for
        // why the dropdown this used to be was removed (it leaked all ~250
        // physician names to `anon`). sanitizeName() mirrors the server-side
        // cleaning in log_access_request(), which is the check that actually
        // counts (the RPC is anon-callable directly, so this is advisory only).
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
            try { localStorage.setItem(PENDING_KEY, JSON.stringify({ email, ts: Date.now() })) } catch (e) { /* storage blocked */ }
        }
        const clearPending = () => {
            try { localStorage.removeItem(PENDING_KEY) } catch (e) { /* storage blocked */ }
        }
        const readPending  = () => {
            try {
                const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null")
                if (p && p.email && Date.now() - p.ts < PENDING_TTL) return p.email
            } catch (e) { /* ignore */ }
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
        // "blocked" = revoked (physicians.active = false) — a valid session is
        // not enough, main.js re-checks on every gated-page request; "no_session"
        // is the everyday logged-out case and stays silent.
        const bounceReason = new URLSearchParams(location.search).get("reason")
        const reasonShown = bounceReason === "expired" || bounceReason === "blocked"

        function showEmailForm() {
            emailInput.disabled = false
            emailLoadingDots.classList.add("hidden")
            if (bounceReason === "expired") {
                showNotice("เซสชันหมดอายุ กรุณายืนยันตัวตนอีกครั้ง")
            } else if (bounceReason === "blocked") {
                showError("บัญชีของท่านถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ")
            }
        }

        // The email input starts disabled with loading dots showing over it,
        // re-enabled by showEmailForm() once the silent-reauth attempt below
        // (or the timeout guarding it) settles.
        emailInput.disabled = true

        // ── Silent LINE reauth ────────────────────────────────────────────────
        // For a RETURNING bound physician, LINE's own (persistent) login can
        // resume a session with no email typed and no OTP sent — via the Edge
        // Function's mode:"silent", which looks up the LINE account against
        // `physicians` and mints a session if it's bound and active. A
        // first-time or unbound visitor just falls through to the email form;
        // that's the normal case, not an error.
        async function attemptSilentLineReauth(idToken) {
            if (!idToken) return false
            const result = await callLineVerify({ mode: "silent", id_token: idToken })
            if (!result || !result.ok || !result.session) return false
            try {
                await establishSession(result.session.access_token, result.session.refresh_token)
                return true
            } catch (err) {
                console.warn("silent reauth session establish failed:", err)
                return false
            }
        }

        const pendingEmail = readPending()
        // Skip only for "blocked" — retrying after "expired" is exactly the
        // recovery path this exists for (session died, LINE still knows you).
        // The Edge Function independently refuses to mint a session for a
        // revoked email regardless, so this is a courtesy, not the real gate.
        const skipSilentReauth = bounceReason === "blocked"

        const idTokenPromise = withTimeout(getLineIdToken(), 4000, null).then((t) => {
            capturedIdToken = t
            return t
        })

        if (pendingEmail) {
            // A verification was in progress before a reload — restore the code
            // step. Unaffected by silent reauth: we're already mid-flow for a
            // specific email, so there is nothing to resume in its place. The
            // id-token capture above still runs in the background so it's ready
            // if the OTP step below wants to attach it.
            goToCodeStep(pendingEmail)
            if (!reasonShown) showOk("กรุณากรอกรหัสยืนยันที่ส่งไปยังอีเมลของท่าน")
        } else if (skipSilentReauth) {
            idTokenPromise.then(showEmailForm)
        } else {
            idTokenPromise.then(async (idToken) => {
                const ok = await attemptSilentLineReauth(idToken)
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
                // Only allow-listed physicians (active in `physicians`) may
                // proceed. Checked via a SECURITY DEFINER RPC that returns just
                // a boolean, so the email list is never exposed.
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
                await establishSession(data.session.access_token, data.session.refresh_token)

                // Best-effort LINE traceability (matching this email to a LINE
                // account) — never a login condition. Awaited so it actually
                // completes before the redirect below can cancel it in flight,
                // but its failure is swallowed: the physician is already signed
                // in at this point regardless of whether this succeeds.
                if (capturedIdToken) {
                    try {
                        await callLineVerify({
                            mode: "bind",
                            access_token: data.session.access_token,
                            id_token: capturedIdToken,
                        })
                    } catch (err) {
                        console.warn("line bind (traceability) failed:", err)
                    }
                }

                showOk("ยืนยันสำเร็จ กำลังนำท่านเข้าสู่ระบบ...")
                location.replace(RETURN_TO)
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

        // ── Step 2b — submit an access request (name + department + email) ────
        requestStep.addEventListener("submit", async (e) => {
            e.preventDefault()
            clearMsg()
            const name = sanitizeName(reqName.value)
            if (name.length < 2) {
                showError("กรุณากรอกชื่อ-นามสกุลของท่าน")
                return
            }
            const department = reqDept.value
            if (!department) {
                showError("กรุณาเลือกกลุ่มงานของท่าน")
                return
            }
            busy(requestSubmit, true, "กำลังส่ง...")
            try {
                await db.rpc("log_access_request", { p_email: currentEmail, p_name: name, p_department: department })
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
            reqDept.value = ""
            emailInput.focus()
        })
      })()
