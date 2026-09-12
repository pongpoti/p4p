"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import DesktopBlock, { useDeviceGate } from "@/components/DesktopBlock"
import { Notice, Spinner } from "@/components/ui"
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config"
import { DEPARTMENTS } from "@/lib/departments"
import OtpInput, { type OtpInputHandle } from "./OtpInput"
import {
  clearPending,
  isValidEmail,
  isValidOtp,
  readPending,
  safeReturnTarget,
  sanitizeName,
  savePending,
  withTimeout,
} from "./logic"

/**
 * /verify/ — email OTP login, the access-request fallback, and the silent
 * LINE reauth that skips both for an already-bound physician.
 *
 * Ported from verify/app.js. This is the page with incident history (see
 * REACT_REWRITE_PLAN.md §7's "Carry forward: silent LINE reauth" section) —
 * the state machine and every Thai string are transcribed deliberately,
 * not redesigned. Only the visual layer changes.
 */

/** Dedicated LIFF app for this page; liff.init() requires the current page to
 *  match its registered Endpoint URL. Overridable for a staging LIFF app. */
const DEFAULT_LIFF_ID = "2008561527-AShTrJz0"

type LiffModule = typeof import("@line/liff").default

type MsgKind = "error" | "ok" | "notice"
interface Msg {
  kind: MsgKind
  text: string
}

type Step = "email" | "code" | "request" | "submitted"

interface LineVerifySession {
  access_token: string
  refresh_token: string
}
interface LineVerifyResult {
  ok?: boolean
  session?: LineVerifySession
}

/** Lazy singleton, matching the pattern in lib/supabase-browser.ts. No
 *  client-side session persistence: the server holds the session via the
 *  /auth/session cookie route, because LINE's in-app webview does not persist
 *  a browser session reliably. */
let anon: SupabaseClient | null = null
function supabaseAnon(): SupabaseClient {
  if (!anon) {
    anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return anon
}

/** POSTs to the Supabase Edge Function that owns all LINE verification — see
 *  supabase/functions/line-verify. Never throws; a failed call reads as
 *  `{ ok: false }`, matching verify/app.js's callLineVerify(). */
async function callLineVerify(payload: Record<string, unknown>): Promise<LineVerifyResult> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/line-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(payload),
    })
    return (await resp.json()) as LineVerifyResult
  } catch (err) {
    console.warn("line-verify call failed:", err)
    return { ok: false }
  }
}

/** Hands a session's tokens to this app's own server, which stashes the
 *  refresh token in an HttpOnly cookie. */
async function establishSession(accessToken: string, refreshToken: string): Promise<void> {
  const resp = await fetch("/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
  })
  if (!resp.ok) throw new Error(`session POST failed: ${resp.status}`)
}

export default function VerifyClient() {
  const device = useDeviceGate()

  const [step, setStep] = useState<Step>("email")
  const [emailReady, setEmailReady] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const [emailValue, setEmailValue] = useState("")
  const [emailBusy, setEmailBusy] = useState(false)

  const [sentTo, setSentTo] = useState("")
  const [codeBusy, setCodeBusy] = useState(false)

  const [reqEmailDisplay, setReqEmailDisplay] = useState("")
  const [reqName, setReqName] = useState("")
  const [reqDept, setReqDept] = useState("")
  const [requestBusy, setRequestBusy] = useState(false)

  const currentEmail = useRef("")
  const capturedIdToken = useRef<string | null>(null)
  const returnTo = useRef("/status/")
  const initRan = useRef(false)

  const otpRef = useRef<OtpInputHandle>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const reqNameRef = useRef<HTMLInputElement>(null)

  // Focus the right field on every step transition. The email input is
  // disabled while `!emailReady`, so calling .focus() on it during the
  // initial "checking" phase is a harmless no-op — exactly matching
  // verify/app.js, which never focuses the email input on load, only on the
  // explicit "back" actions (both of which land here with emailReady already
  // true from the first time the form was shown).
  useEffect(() => {
    if (step === "code") otpRef.current?.focus()
    else if (step === "request") reqNameRef.current?.focus()
    else if (step === "email") emailInputRef.current?.focus()
  }, [step])

  const goToCodeStep = useCallback((email: string) => {
    currentEmail.current = email
    setSentTo(email)
    setStep("code")
  }, [])

  const showEmailForm = useCallback((bounceReason: string | null) => {
    setEmailReady(true)
    if (bounceReason === "expired") {
      setMsg({ kind: "notice", text: "เซสชันหมดอายุ กรุณายืนยันตัวตนอีกครั้ง" })
    } else if (bounceReason === "blocked") {
      setMsg({ kind: "error", text: "บัญชีของท่านถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" })
    }
  }, [])

  const attemptSilentLineReauth = useCallback(async (idToken: string | null): Promise<boolean> => {
    if (!idToken) return false
    const result = await callLineVerify({ mode: "silent", id_token: idToken })
    if (!result?.ok || !result.session) return false
    try {
      await establishSession(result.session.access_token, result.session.refresh_token)
      return true
    } catch (err) {
      console.warn("silent reauth session establish failed:", err)
      return false
    }
  }, [])

  // ── Load: LINE-only guard already handled by `device`; from here on this
  // mirrors the top-level script body in verify/app.js. ─────────────────────
  useEffect(() => {
    if (device !== "allowed") return
    if (initRan.current) return
    initRan.current = true

    const search = new URLSearchParams(window.location.search)
    const bounceReason = search.get("reason")
    const reasonShown = bounceReason === "expired" || bounceReason === "blocked"
    returnTo.current = safeReturnTarget(search.get("return"))

    const liffId = process.env.NEXT_PUBLIC_LIFF_ID_VERIFY || DEFAULT_LIFF_ID

    // Resolves to the initialised liff module, or null if init/import failed.
    // getLineIdToken() (below) awaits this, so wrapping the WHOLE sequence in
    // withTimeout(…, 4000, null) caps a hung liff.init() too, not just the
    // token lookup after it — matching verify/app.js's liffReady/idTokenPromise
    // structure exactly.
    const liffReady: Promise<LiffModule | null> = (async () => {
      try {
        const mod = (await import("@line/liff")).default
        await mod.init({ liffId })
        return mod
      } catch (err) {
        console.warn("liff.init failed:", err)
        return null
      }
    })()

    const getLineIdToken = async (): Promise<string | null> => {
      const mod = await liffReady
      if (!mod || !mod.isLoggedIn()) return null
      try {
        return mod.getIDToken() || null
      } catch {
        return null
      }
    }

    const idTokenPromise = withTimeout(getLineIdToken(), 4000, null)
    void idTokenPromise.then((t) => {
      capturedIdToken.current = t
    })

    // Fire-and-forget access-log beacon — unbounded, unlike idTokenPromise
    // above, matching verify/app.js's liffReady.then(...) reporting block.
    void (async () => {
      const mod = await liffReady
      let userId: string | null = null
      let displayName: string | null = null
      let clientError: string | null = null
      if (!mod) {
        clientError = "liff.init failed"
      } else if (!mod.isLoggedIn()) {
        clientError = "liff not logged in"
      } else {
        try {
          const profile = await mod.getProfile()
          userId = profile.userId
          displayName = profile.displayName
        } catch (err) {
          clientError = `getProfile failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      try {
        await supabaseAnon().rpc("log_liff_access", {
          p_page: "verify",
          p_line_user_id: userId,
          p_line_display_name: displayName,
          p_client_error: clientError,
          p_bounce_reason: bounceReason,
        })
      } catch (err) {
        console.warn("liff access-log report failed:", err)
      }
    })()

    const pendingEmail = readPending()
    const skipSilentReauth = bounceReason === "blocked"

    if (pendingEmail) {
      // Deliberately does NOT wait on idTokenPromise — a physician resuming a
      // code they already requested should see the code step immediately.
      goToCodeStep(pendingEmail)
      if (!reasonShown) {
        setMsg({ kind: "ok", text: "กรุณากรอกรหัสยืนยันที่ส่งไปยังอีเมลของท่าน" })
      }
      return
    }

    if (skipSilentReauth) {
      void idTokenPromise.then(() => showEmailForm(bounceReason))
      return
    }

    void idTokenPromise.then(async (idToken) => {
      const ok = await attemptSilentLineReauth(idToken)
      if (ok) {
        setMsg({ kind: "ok", text: "ยืนยันสำเร็จ กำลังนำท่านเข้าสู่ระบบ..." })
        window.location.replace(returnTo.current)
        return
      }
      showEmailForm(bounceReason)
    })
  }, [device, attemptSilentLineReauth, goToCodeStep, showEmailForm])

  if (device !== "allowed") return <DesktopBlock state={device} />

  // ── Step 1: request an OTP (or fall through to the access-request form) ──
  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setMsg(null)
    const email = emailValue.trim().toLowerCase()
    if (!email) return
    if (!isValidEmail(email)) {
      setMsg({ kind: "error", text: "กรุณากรอกอีเมลให้ถูกต้อง" })
      return
    }
    setEmailBusy(true)
    try {
      const { data: allowed, error: rpcErr } = await supabaseAnon().rpc("is_sender_allowlisted", {
        p_email: email,
      })
      if (rpcErr) throw rpcErr
      if (!allowed) {
        currentEmail.current = email
        setReqEmailDisplay(email)
        setEmailBusy(false)
        setMsg(null)
        setStep("request")
        return
      }
      const { error } = await supabaseAnon().auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      })
      if (error) throw error
      savePending(email)
      goToCodeStep(email)
      setEmailBusy(false)
      setMsg({ kind: "ok", text: "ส่งรหัสยืนยันแล้ว กรุณาตรวจสอบอีเมลของท่าน" })
    } catch (err) {
      console.error(err)
      setEmailBusy(false)
      setMsg({ kind: "error", text: "ส่งรหัสไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" })
    }
  }

  // ── Step 2: verify the OTP ────────────────────────────────────────────────
  const handleCodeSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setMsg(null)
    const token = otpRef.current?.getValue() ?? ""
    if (!isValidOtp(token)) {
      setMsg({ kind: "error", text: "กรุณากรอกรหัส 6 หลัก" })
      return
    }
    setCodeBusy(true)
    try {
      const { data, error } = await supabaseAnon().auth.verifyOtp({
        email: currentEmail.current,
        token,
        type: "email",
      })
      if (error) throw error
      if (!data.session) throw new Error("verifyOtp returned no session")
      clearPending()
      await establishSession(data.session.access_token, data.session.refresh_token)
      if (capturedIdToken.current) {
        try {
          await callLineVerify({
            mode: "bind",
            access_token: data.session.access_token,
            id_token: capturedIdToken.current,
          })
        } catch (err) {
          console.warn("line bind (traceability) failed:", err)
        }
      }
      setMsg({ kind: "ok", text: "ยืนยันสำเร็จ กำลังนำท่านเข้าสู่ระบบ..." })
      window.location.replace(returnTo.current)
    } catch (err) {
      console.error(err)
      setCodeBusy(false)
      setMsg({ kind: "error", text: "รหัสไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่" })
    }
  }

  const handleBack = () => {
    clearPending()
    setMsg(null)
    setStep("email")
    otpRef.current?.clear()
  }

  // ── Step 2b: submit an access request ────────────────────────────────────
  const handleRequestSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setMsg(null)
    const name = sanitizeName(reqName)
    if (name.length < 2) {
      setMsg({ kind: "error", text: "กรุณากรอกชื่อ-นามสกุลของท่าน" })
      return
    }
    if (!reqDept) {
      setMsg({ kind: "error", text: "กรุณาเลือกกลุ่มงานของท่าน" })
      return
    }
    setRequestBusy(true)
    try {
      await supabaseAnon().rpc("log_access_request", {
        p_email: currentEmail.current,
        p_name: name,
        p_department: reqDept,
      })
      setStep("submitted")
      setMsg({
        kind: "notice",
        text: "ส่งคำขอเรียบร้อยแล้ว ผู้ดูแลจะเพิ่มสิทธิ์ให้ท่านเร็ว ๆ นี้ กรุณากลับมายืนยันอีกครั้งภายหลัง",
      })
    } catch (err) {
      console.error(err)
      setRequestBusy(false)
      setMsg({ kind: "error", text: "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" })
    }
  }

  const handleRequestBack = () => {
    setMsg(null)
    setStep("email")
    setReqName("")
    setReqDept("")
  }

  const hiddenUnless = (want: Step) => (step === want ? "" : "hidden")

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-5 py-10">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-white shadow-[0_6px_24px_rgba(75,61,51,0.08)]">
        <div className="bg-[var(--color-primary)] px-6 py-5 text-white">
          <h1 className="font-[family-name:var(--font-manrope)] text-lg font-bold">ยืนยันตัวตน</h1>
          <p className="mt-1 text-sm opacity-90">SAKHONMSO P4P</p>
        </div>

        <div className="px-6 py-6">
          {/* Step 1: email */}
          <form onSubmit={handleEmailSubmit} noValidate className={hiddenUnless("email")}>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-semibold text-[var(--color-secondary)]"
            >
              อีเมลที่ใช้ส่ง P4P
            </label>
            <div className="relative">
              <input
                id="email"
                ref={emailInputRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                required
                disabled={!emailReady || emailBusy}
                value={emailValue}
                onChange={(e) => setEmailValue(e.target.value)}
                className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-white px-3.5 py-3 text-base text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-60"
              />
              {!emailReady ? <LoadingDots /> : null}
            </div>
            <button
              type="submit"
              disabled={!emailReady || emailBusy}
              className="mt-4 w-full rounded-[var(--radius-card)] bg-[var(--color-secondary)] px-3.5 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {emailBusy ? (
                <>
                  <Spinner /> กำลังส่ง...
                </>
              ) : (
                "ส่งรหัสยืนยัน"
              )}
            </button>
            <p className="mt-3.5 text-sm leading-relaxed text-[var(--color-ink-muted)]">
              ระบบจะส่งรหัส 6 หลักไปยังอีเมลของท่าน เฉพาะอีเมลที่เคยส่ง P4P เท่านั้นจึงจะเข้าใช้งานได้
            </p>
          </form>

          {/* Step 2: OTP code */}
          <form onSubmit={handleCodeSubmit} noValidate className={hiddenUnless("code")}>
            <label
              id="otp-label"
              className="mb-1.5 block text-sm font-semibold text-[var(--color-secondary)]"
            >
              รหัสยืนยัน 6 หลัก
            </label>
            <OtpInput ref={otpRef} />
            <button
              type="submit"
              disabled={codeBusy}
              className="mt-4 w-full rounded-[var(--radius-card)] bg-[var(--color-secondary)] px-3.5 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {codeBusy ? (
                <>
                  <Spinner /> กำลังยืนยัน...
                </>
              ) : (
                "ยืนยัน"
              )}
            </button>
            <p className="mt-3.5 text-sm leading-relaxed text-[var(--color-ink-muted)]">
              ส่งรหัสไปที่{" "}
              <b className="break-all font-semibold text-[var(--color-secondary)]">{sentTo}</b> แล้ว
            </p>
            <button
              type="button"
              onClick={handleBack}
              className="mt-3.5 text-sm font-medium text-[var(--color-muted)] underline"
            >
              ใช้อีเมลอื่น
            </button>
          </form>

          {/* Step 2b: request access (email not yet registered) */}
          <form onSubmit={handleRequestSubmit} noValidate className={hiddenUnless("request")}>
            <label
              htmlFor="reqname"
              className="mb-1.5 block text-sm font-semibold text-[var(--color-secondary)]"
            >
              ชื่อ-นามสกุล
            </label>
            {/* Free text, NOT a roster dropdown — see verify/index.html's comment
                on why a physician-list <select> here would leak the whole
                roster to `anon`, before login. */}
            <input
              id="reqname"
              ref={reqNameRef}
              type="text"
              autoComplete="name"
              maxLength={100}
              placeholder="ชื่อ-นามสกุลของท่าน"
              required
              disabled={requestBusy}
              value={reqName}
              onChange={(e) => setReqName(e.target.value)}
              className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-white px-3.5 py-3 text-base text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-60"
            />
            <label
              htmlFor="reqdept"
              className="mb-1.5 mt-3.5 block text-sm font-semibold text-[var(--color-secondary)]"
            >
              กลุ่มงาน
            </label>
            <select
              id="reqdept"
              required
              disabled={requestBusy}
              value={reqDept}
              onChange={(e) => setReqDept(e.target.value)}
              className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-white px-3.5 py-3 text-base text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-60"
            >
              <option value="" disabled>
                เลือกกลุ่มงาน
              </option>
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={requestBusy}
              className="mt-4 w-full rounded-[var(--radius-card)] bg-[var(--color-secondary)] px-3.5 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {requestBusy ? (
                <>
                  <Spinner /> กำลังส่ง...
                </>
              ) : (
                "ส่งคำขอเข้าใช้งาน"
              )}
            </button>
            <p className="mt-3.5 text-sm leading-relaxed text-[var(--color-ink-muted)]">
              อีเมล{" "}
              <b className="break-all font-semibold text-[var(--color-secondary)]">
                {reqEmailDisplay}
              </b>{" "}
              ยังไม่ได้ลงทะเบียน กรุณากรอกชื่อ-นามสกุลและกลุ่มงานของท่านเพื่อให้ผู้ดูแลเพิ่มสิทธิ์ให้ท่าน
            </p>
            <button
              type="button"
              onClick={handleRequestBack}
              className="mt-3.5 text-sm font-medium text-[var(--color-muted)] underline"
            >
              ใช้อีเมลอื่น
            </button>
          </form>

          {msg ? (
            <div className="mt-3.5">
              <Notice kind={msg.kind === "notice" ? "info" : msg.kind}>{msg.text}</Notice>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  )
}

function LoadingDots() {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-[var(--radius-card)] bg-white">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-muted)]"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}
