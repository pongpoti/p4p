import crypto from "node:crypto"
import { ADMIN_COOKIE, serverEnv } from "../config"

/**
 * Admin auth — separate from the physician email/OTP/LIFF flow.
 *
 * The dashboard has exactly one legitimate user, already identified by LINE
 * userId. Rather than standing up a dedicated LIFF app, this reuses the
 * Messaging API bot: LINE's webhook signature authenticates
 * event.source.userId, so a DM is enough proof of identity. Sending "admin"
 * from that exact userId gets a short-lived signed login link back; visiting it
 * sets a signed session cookie. No Supabase auth user, no LIFF, no OTP.
 *
 * Tokens are stateless HMAC strings — nothing survives between invocations on
 * Vercel reliably, so there is no server-side store. The signing key reuses two
 * secrets the deployment already has rather than requiring a new one, and
 * "purpose" is mixed into the HMAC so a short-lived login token can never be
 * replayed as a long-lived session cookie or vice versa.
 *
 * A session token cannot be revoked without rotating one of the two secrets
 * it is derived from, which would break the rest of the system — its
 * lifetime (ADMIN_SESSION_DAYS) is the only real defense against a lost or
 * handed-down phone. Shortened from 90 to 7 days for exactly that reason;
 * re-authenticating is a single "admin" DM to the bot, trivial for the one
 * person who ever needs to.
 */
export type TokenPurpose = "login" | "session"

/**
 * True only when BOTH source secrets are present.
 *
 * The `?? ""` fallbacks below are what make this necessary: with either secret
 * unset the key silently became the literal ":", and since the signed payload
 * is only `purpose:exp` — no nonce, no user identity — anyone could forge an
 * admin session cookie. Every route behind this holds the service-role key and
 * bypasses RLS, so the failure mode is total. Fail closed instead.
 */
export function adminKeyUsable(): boolean {
  return Boolean(serverEnv.lineChannelSecret()) && Boolean(serverEnv.supabaseServiceRoleKey())
}

function signingKey(): string {
  return `${serverEnv.lineChannelSecret() ?? ""}:${serverEnv.supabaseServiceRoleKey() ?? ""}`
}

export function signAdminToken(purpose: TokenPurpose, exp: number): string {
  if (!adminKeyUsable()) {
    throw new Error("admin signing key unavailable: LINE_CHANNEL_SECRET / SUPABASE_SERVICE_ROLE_KEY not set")
  }
  const sig = crypto.createHmac("sha256", signingKey()).update(`${purpose}:${exp}`).digest("hex")
  return `${exp}.${sig}`
}

export function verifyAdminToken(purpose: TokenPurpose, token: string | undefined | null): boolean {
  if (!adminKeyUsable()) {
    console.error("[admin] signing secrets not set — refusing to verify any admin token")
    return false
  }
  if (!token || typeof token !== "string") return false
  const i = token.indexOf(".")
  if (i === -1) return false

  const exp = parseInt(token.slice(0, i), 10)
  const sig = token.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false

  const expected = crypto
    .createHmac("sha256", signingKey())
    .update(`${purpose}:${exp}`)
    .digest("hex")

  // Constant-time compare — this gates write access to every roster table.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const ADMIN_SESSION_DAYS = 7

export function adminSessionCookie(): { name: string; value: string; maxAge: number } {
  const maxAge = ADMIN_SESSION_DAYS * 24 * 3600
  return {
    name: ADMIN_COOKIE,
    value: signAdminToken("session", Math.floor(Date.now() / 1000) + maxAge),
    maxAge,
  }
}

/** True when the request carries a valid admin session cookie. */
export function isAdminRequest(request: Request): boolean {
  const raw = request.headers.get("cookie") ?? ""
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i === -1) continue
    if (part.slice(0, i).trim() !== ADMIN_COOKIE) continue
    return verifyAdminToken("session", decodeURIComponent(part.slice(i + 1).trim()))
  }
  return false
}
