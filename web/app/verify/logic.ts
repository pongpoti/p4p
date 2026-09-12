/**
 * Pure logic for /verify/, ported from verify/app.js.
 *
 * Kept separate from VerifyClient.tsx so the parts that do not need a DOM —
 * the open-redirect guard and the name sanitizer, in particular — are
 * unit-testable the same way lib/gate/targets.ts is (see
 * lib/__tests__/targets.test.ts). Everything here is a direct, deliberately
 * unclever port: this is the page with incident history (see
 * REACT_REWRITE_PLAN.md §7's "Carry forward: silent LINE reauth" section),
 * so fidelity beats cleverness.
 */

/** Where an unrecognised or missing `?return=` sends the physician. */
const DEFAULT_RETURN = "/status/"

/**
 * Same-origin guard for the `?return=` param, ported byte-for-byte from
 * safeReturn() in verify/app.js (the regex is unchanged: `^\/(?![/\\])`).
 * Accepts exactly one leading "/" not followed by another "/" or "\" — both
 * of which browsers can still resolve as a protocol-relative or
 * scheme-relative URL — and rejects everything else, including a bare host
 * with no leading slash at all, falling back to DEFAULT_RETURN.
 *
 * This is a client-side backstop: lib/gate/targets.ts already never emits an
 * unsafe `return=`, but this page can be reached with an arbitrary one from
 * outside the app too.
 */
export function safeReturnTarget(raw: string | null | undefined): string {
  const decoded = decodeMaybe(raw ?? "")
  return /^\/(?![/\\])/.test(decoded) ? decoded : DEFAULT_RETURN
}

function decodeMaybe(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A stray "%" that is not a valid escape makes decodeURIComponent throw.
    // Treat it as "nothing safe to return to" rather than propagating.
    return ""
  }
}

/** Access-request name field length, matching verify/app.js's NAME_MAX. */
export const NAME_MAX = 100

/**
 * Ported verbatim from sanitizeName() in verify/app.js. Note this only
 * normalises spaces and hyphens to a single space and collapses whitespace
 * runs — it does not strip other control characters or zero-width
 * characters, which is the legacy behaviour, kept as-is.
 */
export function sanitizeName(raw: string | null | undefined): string {
  return String(raw || "")
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
}

/** Step 1 email format check, ported verbatim from the email-step handler. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
}

/** Step 2 OTP format check: exactly six digits, ported verbatim. */
export function isValidOtp(token: string): boolean {
  return /^[0-9]{6}$/.test(token)
}

/**
 * Races `promise` against a `ms` timeout, resolving to `fallback` if the
 * timeout wins. Ported verbatim from withTimeout() in verify/app.js — used to
 * cap the whole LIFF init → isLoggedIn → getIDToken sequence at 4s so a hung
 * liff.init() cannot leave the physician stuck on the loading state forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

// ── "Resume where I left off" — survives a reload mid-OTP ──────────────────
// LINE's in-app webview can reload the page between the email step and the
// code step (e.g. the user switches apps to check their inbox). This lets a
// reload land back on the code step instead of making them request a new
// code, for PENDING_TTL after the original request.
const PENDING_KEY = "p4p_verify_pending"
const PENDING_TTL = 15 * 60 * 1000

export function savePending(email: string): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email, ts: Date.now() }))
  } catch {
    // Private-mode / storage disabled. The OTP flow still works end to end;
    // it just won't resume the code step after a reload.
  }
}

export function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
}

export function readPending(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const parsed = raw ? (JSON.parse(raw) as { email?: string; ts?: number }) : null
    if (parsed?.email && typeof parsed.ts === "number" && Date.now() - parsed.ts < PENDING_TTL) {
      return parsed.email
    }
  } catch {
    /* ignore */
  }
  clearPending()
  return null
}
