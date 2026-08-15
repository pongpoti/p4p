import { describe, expect, it } from "vitest"
import { INERT_FRAGMENT, canonicalPath, verifyBounce, type BounceReason } from "../gate/targets"

const REASONS: BounceReason[] = ["no_session", "expired", "blocked"]

/**
 * The trailing fragment is the entire point of this module. It is invisible in
 * a browser, produces no error when missing, and its absence only shows up as
 * physicians stuck in a redirect loop inside LINE's webview — which is how it
 * shipped in 2026-08.
 *
 * It is also the thing most likely to be "cleaned up" by someone who does not
 * know why it is there, and Next drops it silently given half a chance (see the
 * header comment in ../gate/targets.ts). Hence these tests.
 */
describe("every redirect target carries a fragment", () => {
  it("canonicalPath, with and without a query string", () => {
    expect(canonicalPath("status", "")).toBe("/status/#_")
    expect(canonicalPath("status", "?sheetname=2569_04")).toBe("/status/?sheetname=2569_04#_")
  })

  it("verifyBounce, for every reason, with and without a return path", () => {
    for (const reason of REASONS) {
      expect(verifyBounce(reason).endsWith(INERT_FRAGMENT), reason).toBe(true)
      expect(verifyBounce(reason, "/status/").endsWith(INERT_FRAGMENT), reason).toBe(true)
    }
  })

  it("uses a NON-empty fragment, because Next silently drops an empty one", () => {
    // Measured against the emitted header, not assumed. If this is ever
    // shortened back to a bare "#", the fragment stops being sent at all and
    // the stale-token bug returns with no visible symptom in tests.
    expect(INERT_FRAGMENT.length).toBeGreaterThan(1)
    expect(INERT_FRAGMENT.startsWith("#")).toBe(true)
  })

  it("the fragment is inert — liff.init() must not read it as login state", () => {
    // liff.init() looks for "access_token=" in the fragment. Ours must not
    // contain it, or a page would be handed a fabricated, invalid login state.
    expect(INERT_FRAGMENT).not.toContain("access_token")
    expect(INERT_FRAGMENT).not.toContain("=")
  })
})

describe("verifyBounce", () => {
  it("includes the return path when there is somewhere to go back to", () => {
    expect(verifyBounce("no_session", "/status/")).toBe(
      "/verify/?return=%2Fstatus%2F&reason=no_session#_",
    )
  })

  it("percent-encodes a return path that carries its own query", () => {
    const target = verifyBounce("no_session", "/status/?sheetname=2569_04")
    expect(target).toBe("/verify/?return=%2Fstatus%2F%3Fsheetname%3D2569_04&reason=no_session#_")

    // And it must survive being read back out.
    const query = target.slice(target.indexOf("?") + 1, -INERT_FRAGMENT.length)
    const parsed = new URLSearchParams(query)
    expect(parsed.get("return")).toBe("/status/?sheetname=2569_04")
    expect(parsed.get("reason")).toBe("no_session")
  })

  it("omits the return path for terminal reasons", () => {
    // Sending a blocked or expired user back where they came from is pointless.
    expect(verifyBounce("blocked")).toBe("/verify/?reason=blocked#_")
    expect(verifyBounce("expired")).toBe("/verify/?reason=expired#_")
  })

  it("never produces a protocol-relative or absolute target", () => {
    // The client-side safeReturn() only accepts a single leading "/", so an
    // open redirect here would be caught there too — but not producing one is
    // the first line of defence.
    for (const reason of REASONS) {
      const target = verifyBounce(reason, "//evil.test/")
      expect(target.startsWith("/verify/?")).toBe(true)
      expect(target).not.toContain("//evil.test")
    }
  })
})
