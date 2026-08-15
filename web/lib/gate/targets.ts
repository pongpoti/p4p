/**
 * Redirect targets for the gate.
 *
 * Pure string building, kept out of middleware.ts so the one property that
 * matters can be unit-tested: EVERY target carries a fragment of its own.
 *
 * ── Why a fragment at all ────────────────────────────────────────────────
 * LINE's iOS webview carries the CURRENT page's fragment forward onto the new
 * URL when a redirect's Location has no fragment of its own. A LIFF app appends
 * "#access_token=…" on open, so without one, a stale token belonging to a
 * DIFFERENT LIFF app rides along into /verify/, where liff.init() sees the
 * mismatch and fails with "Invalid LIFF ID" — reproducibly, whichever app the
 * physician entered through. Giving the browser an inert fragment of ours
 * stops it reaching for the old one.
 *
 * ── Why "#_" and not the bare "#" the Express app used ───────────────────
 * Next will not emit a bare "#". Measured, not assumed:
 *
 *   - NextResponse.redirect() serialises through Next's NextURL wrapper, which
 *     drops an empty fragment.
 *   - Returning a plain Response with a relative Location throws
 *     ERR_INVALID_URL — Next parses and normalises the Location of ANY response
 *     middleware returns.
 *   - Absolutising it first with the standard URL class (which DOES keep an
 *     empty fragment in .href) still loses it: Next re-normalises the header
 *     back to a relative path and drops the empty fragment on the way.
 *
 * A NON-empty fragment survives all of that. "_" is inert: nothing parses it,
 * and liff.init() looks for "access_token=" in the fragment, which "_" does not
 * contain — so a page that needs login state does a normal login round trip,
 * exactly as it did with the empty fragment before. The observable behaviour in
 * the webview is unchanged; only the byte differs.
 *
 * If a future Next version emits a bare "#", this can go back to "#" — but
 * there is no functional reason to.
 */

/** The inert fragment appended to every redirect target. See above. */
export const INERT_FRAGMENT = "#_"

/** Bare gated path -> its trailing-slash form. */
export function canonicalPath(page: string, search: string): string {
  return `/${page}/${search}${INERT_FRAGMENT}`
}

export type BounceReason = "no_session" | "expired" | "blocked"

/**
 * Off to /verify/. `returnTo` is omitted for terminal reasons (blocked,
 * expired) where sending the user back afterwards makes no sense — matching
 * the Express behaviour.
 */
export function verifyBounce(reason: BounceReason, returnTo?: string): string {
  const params = new URLSearchParams()
  if (returnTo) params.set("return", returnTo)
  params.set("reason", reason)
  return `/verify/?${params.toString()}${INERT_FRAGMENT}`
}
