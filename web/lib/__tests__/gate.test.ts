import { describe, expect, it, vi } from "vitest"
import { jwtExp, jwtPayload, isExpiring } from "../gate/jwt"
import { readSessionCookie, resolveAccessToken } from "../gate/session"
import { gateDecision, isCurrentUserAllowlisted } from "../gate/status"

/** Build an unsigned JWT with the given payload — only the body is ever read. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`
}

function cookies(map: Record<string, string>) {
  return { get: (name: string) => (name in map ? { value: map[name]! } : undefined) }
}

describe("jwtPayload", () => {
  it("reads claims", () => {
    const token = fakeJwt({ exp: 123, session_id: "sess-1", email: "a@b.co" })
    expect(jwtPayload(token)).toMatchObject({ exp: 123, session_id: "sess-1" })
    expect(jwtExp(token)).toBe(123)
  })

  it("survives non-ASCII claims", () => {
    // A Thai display name in a claim would be mangled by a naive atob.
    expect(jwtPayload(fakeJwt({ name: "สมชาย" })).name).toBe("สมชาย")
  })

  it("returns an empty payload rather than throwing on garbage", () => {
    for (const bad of ["", "not.a.jwt", "onlyonepart", "a.!!!.c"]) {
      expect(jwtPayload(bad)).toEqual({})
      expect(jwtExp(bad)).toBe(0)
    }
  })
})

describe("isExpiring", () => {
  const future = Math.floor(Date.now() / 1000) + 3600
  const past = Math.floor(Date.now() / 1000) - 10

  it("is false for a comfortably fresh token", () => {
    expect(isExpiring(fakeJwt({ exp: future }))).toBe(false)
  })

  it("is true for a missing, expired, or nearly-expired token", () => {
    expect(isExpiring(null)).toBe(true)
    expect(isExpiring(fakeJwt({ exp: past }))).toBe(true)
    // Within the 60s skew.
    expect(isExpiring(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }))).toBe(true)
  })
})

describe("readSessionCookie", () => {
  it("reads the JSON form", () => {
    const raw = JSON.stringify({ at: "access", rt: "refresh" })
    expect(readSessionCookie(cookies({ p4p_rt: raw }))).toEqual({ at: "access", rt: "refresh" })
  })

  it("accepts a legacy bare refresh token", () => {
    expect(readSessionCookie(cookies({ p4p_rt: "legacy-token" }))).toEqual({
      at: null,
      rt: "legacy-token",
    })
  })

  it("treats valid JSON with no rt as no session", () => {
    // The bug this guards: falling through to using the JSON string itself as a
    // (bogus) refresh token.
    expect(readSessionCookie(cookies({ p4p_rt: JSON.stringify({ at: "x" }) }))).toBeNull()
  })

  it("returns null when the cookie is absent", () => {
    expect(readSessionCookie(cookies({}))).toBeNull()
  })
})

describe("resolveAccessToken", () => {
  const fresh = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
  const stale = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 })

  it("reports no_session with no cookie", async () => {
    const result = await resolveAccessToken(cookies({}))
    expect(result).toEqual({ at: null, reason: "no_session" })
  })

  it("reuses a fresh cached token without hitting the network", async () => {
    const fetchImpl = vi.fn()
    const raw = JSON.stringify({ at: fresh, rt: "refresh" })
    const result = await resolveAccessToken(cookies({ p4p_rt: raw }), fetchImpl as never)

    expect(result.at).toBe(fresh)
    expect(result.rotated).toBeUndefined()
    // Refreshing on every page load rotated the refresh token each time, which
    // Supabase can flag as reuse and revoke the whole session. This assertion
    // is the guard against that regression.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refreshes a stale token and reports the rotation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-at", refresh_token: "new-rt" }),
    })
    const raw = JSON.stringify({ at: stale, rt: "old-rt" })
    const result = await resolveAccessToken(cookies({ p4p_rt: raw }), fetchImpl as never)

    expect(result.at).toBe("new-at")
    expect(result.rotated).toEqual({ at: "new-at", rt: "new-rt" })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("keeps the old refresh token when the response omits a new one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-at" }),
    })
    const raw = JSON.stringify({ at: stale, rt: "old-rt" })
    const result = await resolveAccessToken(cookies({ p4p_rt: raw }), fetchImpl as never)
    expect(result.rotated).toEqual({ at: "new-at", rt: "old-rt" })
  })

  it("reports expired and asks for the cookie to be cleared when refresh fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    const raw = JSON.stringify({ at: stale, rt: "old-rt" })
    const result = await resolveAccessToken(cookies({ p4p_rt: raw }), fetchImpl as never)

    expect(result).toMatchObject({ at: null, reason: "expired", clear: true })
  })

  it("treats a network throw the same as a failed refresh", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"))
    const raw = JSON.stringify({ at: stale, rt: "old-rt" })
    const result = await resolveAccessToken(cookies({ p4p_rt: raw }), fetchImpl as never)
    expect(result).toMatchObject({ at: null, reason: "expired", clear: true })
  })
})

// ── The gate is now a single boolean ─────────────────────────────────────
// Whether a LINE account is bound plays no part in reaching a page — that's
// traceability recorded by supabase/functions/line-verify, never a login
// condition. See scripts/auth-rewrite-2026-08.sql.
describe("gateDecision", () => {
  it("serves when the email is allow-listed", () => {
    expect(gateDecision(true).type).toBe("serve")
  })

  it("bounces to blocked when it is not", () => {
    expect(gateDecision(false).type).toBe("blocked")
  })
})

describe("isCurrentUserAllowlisted", () => {
  it("returns the RPC's boolean result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => true })
    expect(await isCurrentUserAllowlisted("token", fetchImpl as never)).toBe(true)

    fetchImpl.mockResolvedValue({ ok: true, json: async () => false })
    expect(await isCurrentUserAllowlisted("token", fetchImpl as never)).toBe(false)
  })

  it("fails OPEN on a non-ok response or a network error", async () => {
    // A transient Supabase hiccup must not lock out a whole hospital; RLS is
    // still the real data barrier regardless of what this returns.
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await isCurrentUserAllowlisted("token", notOk as never)).toBe(true)

    const throws = vi.fn().mockRejectedValue(new Error("offline"))
    expect(await isCurrentUserAllowlisted("token", throws as never)).toBe(true)
  })
})
