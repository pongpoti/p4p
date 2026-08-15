import { NextResponse, type NextRequest } from "next/server"
import { resolveAccessToken } from "./lib/gate/session"
import { isCurrentUserAllowlisted } from "./lib/gate/status"
import { canonicalPath, verifyBounce } from "./lib/gate/targets"
import { redirectResponse, type CookieSpec } from "./lib/gate/redirect"

/**
 * The gate, plus the CSP nonce.
 *
 * Runs before every page request. Three jobs:
 *   1. URL canonicalisation, which is subtler than it looks (see below)
 *   2. session + allow-list gating for /status, /list, /ranking — a single
 *      boolean check, not a multi-field bind-status struct. Whether a LINE
 *      account is bound plays no part in reaching a page; see
 *      scripts/auth-rewrite-2026-08.sql and lib/gate/status.ts.
 *   3. a per-request CSP nonce, so Next's inline scripts do not force
 *      'unsafe-inline' into a policy that deliberately does not have it
 *
 * /admin/* is NOT gated here — it has its own auth (lib/admin), and bouncing an
 * admin to /verify/ would be wrong. The matcher excludes it.
 */

const GATED_PAGES = ["status", "list", "ranking"] as const

/** Header the page's Server Component reads to get the access token. */
export const TOKEN_HEADER = "x-p4p-access-token"
export const NONCE_HEADER = "x-nonce"

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // 'self' covers our bundles; the nonce covers Next's inline bootstrap and
    // RSC payload scripts. No 'unsafe-inline' — the fonts are self-hosted by
    // next/font and both CDN script origins are gone (Supabase and LIFF are
    // bundled from npm), so this is strictly tighter than the Express version.
    // 'strict-dynamic' is deliberately omitted: it would disable the 'self'
    // allowance in browsers that honour it, and Next's chunk loading relies on
    // plain same-origin <script src>.
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    // *.supabase.co also covers supabase/functions/line-verify — the browser
    // calls it directly for all LINE verification, same origin as everything
    // else Supabase.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.line.me https://access.line.me",
    // frame-ancestors intentionally omitted so the pages still load inside
    // LINE's LIFF webview.
  ].join("; ")
}

function securityHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp)
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  return response
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  const nonce = btoa(crypto.randomUUID())
  const csp = buildCsp(nonce)

  /** Headers forwarded to the route being rendered. */
  const forwarded = new Headers(request.headers)
  forwarded.set(NONCE_HEADER, nonce)

  const passThrough = (rewriteTo?: string) => {
    const response = rewriteTo
      ? NextResponse.rewrite(new URL(rewriteTo + search, request.url), {
          request: { headers: forwarded },
        })
      : NextResponse.next({ request: { headers: forwarded } })
    return securityHeaders(response, csp)
  }

  // A plain Response, NOT NextResponse.redirect() — see lib/gate/redirect.ts.
  const redirect = (to: string, cookies: CookieSpec[] = []) =>
    redirectResponse(
      new URL(to, request.url).href,
      {
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
      cookies,
    )

  const clearedSession: CookieSpec = { name: "p4p_rt", value: "", maxAge: 0 }

  // ── /verify and /verify/ ──────────────────────────────────────────────
  // BOTH render, with NO redirect between them, for the same LIFF-fragment
  // reason as ever (see lib/gate/targets.ts). No session lookup and no token
  // injection here anymore: binding a LINE account no longer needs a
  // server-injected token or a bounce-back-here round trip — the browser
  // already holds whatever tokens it needs by the time it calls either
  // /auth/session or supabase/functions/line-verify. The page is the same
  // static-ish thing for everyone, every time.
  if (pathname === "/verify" || pathname === "/verify/") {
    return passThrough("/verify")
  }

  // ── Gated pages ───────────────────────────────────────────────────────
  const gated = GATED_PAGES.find((p) => pathname === `/${p}` || pathname === `/${p}/`)
  if (!gated) return passThrough()

  // Canonicalise to the trailing-slash form first. LIFF opens "/status" with no
  // slash. These want the redirect (unlike /verify), with an explicit trailing
  // "#_" for the reason documented in lib/gate/targets.ts.
  if (pathname === `/${gated}`) {
    return redirect(canonicalPath(gated, search))
  }

  const returnTo = pathname + search
  const resolved = await resolveAccessToken(request.cookies)

  if (!resolved.at) {
    return redirect(
      verifyBounce(resolved.reason ?? "no_session", returnTo),
      resolved.clear ? [clearedSession] : [],
    )
  }

  const allowed = await isCurrentUserAllowlisted(resolved.at)
  const rotated: CookieSpec[] = resolved.rotated
    ? [sessionCookie(resolved.rotated.at, resolved.rotated.rt)]
    : []

  if (!allowed) {
    return redirect(verifyBounce("blocked"), [clearedSession])
  }

  forwarded.set(TOKEN_HEADER, resolved.at)
  const response = passThrough(`/${gated}`)
  if (resolved.rotated) setSessionOn(response, resolved.rotated.at, resolved.rotated.rt)
  return response
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function sessionCookie(at: string, rt: string): CookieSpec {
  return { name: "p4p_rt", value: JSON.stringify({ at, rt }), maxAge: 34_560_000 }
}

function setSessionOn(response: NextResponse, at: string, rt: string): void {
  response.cookies.set("p4p_rt", JSON.stringify({ at, rt }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 34_560_000,
  })
}

export const config = {
  /**
   * Pages only.
   *
   * Excluded, and each for a reason:
   *   api|auth|line|telegram|admin — route handlers with their own auth. In
   *     particular /admin/* must never reach the physician gate, or an admin
   *     would be bounced to /verify/.
   *   _next/*, favicon, assets — static output; running the gate on every chunk
   *     would add a Supabase round trip per asset.
   */
  matcher: [
    "/((?!api|auth|line|telegram|admin|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)",
  ],
}
