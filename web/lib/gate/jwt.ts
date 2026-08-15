/**
 * Reading claims out of a Supabase access token.
 *
 * Deliberately does NOT verify the signature. Every token this touches was
 * already validated by Supabase — either at /auth/session, or by the refresh
 * call that minted it — so this is reading a token we already trust, not
 * deciding whether to trust one. Anything that needs to establish identity
 * asks Supabase instead of reading the JWT body (see
 * supabase/functions/line-verify, which does exactly that for LINE binding).
 *
 * Edge-safe: uses atob rather than Buffer, so it works in middleware.
 */

export interface JwtPayload {
  exp?: number
  session_id?: string
  email?: string
  [key: string]: unknown
}

export function jwtPayload(token: string): JwtPayload {
  try {
    const part = token.split(".")[1]
    if (!part) return {}
    // base64url -> base64
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const json = atob(padded)
    // atob yields a binary string; Thai or any other non-ASCII claim would be
    // mangled by JSON.parse without this round-trip through UTF-8.
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as JwtPayload
  } catch {
    return {}
  }
}

/** Expiry as a unix timestamp, or 0 when absent/unparseable. */
export function jwtExp(token: string): number {
  const exp = jwtPayload(token).exp
  return typeof exp === "number" ? exp : 0
}

/** True when the token is missing or within `skewSeconds` of expiring. */
export function isExpiring(token: string | null, skewSeconds = 60): boolean {
  if (!token) return true
  return jwtExp(token) < Date.now() / 1000 + skewSeconds
}
