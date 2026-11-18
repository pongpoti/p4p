import express, { type NextFunction, type Request, type Response } from "express"
import process from "node:process"
import crypto from "node:crypto"
import * as line from "@line/bot-sdk"
import axios from "axios"
import fs from "node:fs"
import path from "node:path"

const app = express()

const port = process.env.PORT || 3000
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET

// Bypasses RLS — used by the /admin/api/* routes (roster CRUD, access
// requests), gated by the admin's own signed-cookie session. Physician auth
// no longer touches this key at all: LINE ID-token verification and the
// `physicians` write happen in the Supabase Edge Function
// (supabase/functions/line-verify), not here — see auth-rewrite-2026-08.sql
// and that function's header comment for the full design.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// The single LINE userId allowed into /admin/ (the roster CRUD dashboard,
// see servePage-adjacent routes below) and the /dashboard/ owner. Not a
// secret — a LINE userId cannot authenticate as its account — but it is a
// personal identifier, and this repository is public, so it lives only in
// the environment. Unset means NO owner, not a default one: the "admin" bot
// command answers nobody, the owner-only dashboard routes return 404, and
// DASHBOARD_LINE_USER_IDS has nothing to fall back to. Set it in Vercel
// before deploying (SUPABASE_MIGRATIONS.md, "Before deploying the 2026-11
// audit fixes").
const ADMIN_LINE_USER_ID = (process.env.ADMIN_LINE_USER_ID || "").trim()
if (!ADMIN_LINE_USER_ID) {
  console.error("[admin] ADMIN_LINE_USER_ID is not set — the \"admin\" login command and the " +
    "dashboard's owner-only features are DISABLED")
}
// Fails closed: with no owner configured, no userId (not even a missing one)
// is the owner.
function isOwnerLineUserId(userId: string | undefined | null): boolean {
  return Boolean(ADMIN_LINE_USER_ID) && userId === ADMIN_LINE_USER_ID
}
// Base URL used to build the one-time admin login link sent over LINE DM
// (the webhook has no `req` to read a Host header from).
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || "https://p4p-sakhonmso.vercel.app"

const headers = {
  "Content-Type": "application/json",
  "Authorization": "Bearer " + LINE_ACCESS_TOKEN
}
const config: line.ClientConfig & line.MiddlewareConfig = {
  channelAccessToken: LINE_ACCESS_TOKEN as string,
  channelSecret: LINE_CHANNEL_SECRET as string,
}
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_ACCESS_TOKEN as string,
})
// Month names, colors, and the 6-month iterator are shared with the rich-menu
// script via src/constants.ts (local names kept for readability below).
const {
  COLOR_ARRAY: color_array,
  MONTH_NAMES: month_array,
  MONTH_ITERATOR: month_iterator,
} = require("./src/constants") as typeof import("./src/constants")

// ── Server-side session validation ───────────────────────────────────────
// The LINE (LIFF) in-app browser does not persist a client-side Supabase
// session across navigations, so the browser can't hold the auth token. Instead
// the SERVER validates the session: after the client verifies its OTP it posts
// the tokens here; we keep the refresh token in an HttpOnly cookie and, on every
// gated page request, exchange it for a fresh access token which we inject into
// the page. The browser only ever holds a short-lived access token in memory.
const SUPABASE_URL = "https://zjeizbrzcltkgtlmkbji.supabase.co"
const SUPABASE_ANON = "sb_publishable_TcCSpznim4fi0Y7E_zuAsg_op19VZQ-"
const RT_COOKIE = "p4p_rt"
const COOKIE_BASE = "HttpOnly; Secure; SameSite=Lax; Path=/"
const PAGE_TOKEN_PLACEHOLDER = "__P4P_ACCESS_TOKEN__"
// The LIFF app whose registered endpoint is /upload/ (the rich menu's fourth
// block opens it). Injected into the page the same way the access token is,
// so the id lives in one place — the env var scripts/setup-richmenu.mts
// already requires — rather than being hardcoded in two.
const UPLOAD_LIFF_PLACEHOLDER = "__P4P_UPLOAD_LIFF_ID__"
// Hardcoded fallback for the same reason ADMIN_BASE_URL has one: a LIFF id
// is not a secret. This exact string is
// already public in the rich menu's own `uri` action and in every copy of
// this page's HTML. Making it a required env var bought nothing and cost a
// silent failure — with it unset, liff.init() never runs, so the chat
// receipt and the opportunistic LINE bind both quietly do nothing while the
// page otherwise looks fine. The env var still wins where it is set, which
// is what a preview deployment pointing at a second LIFF app needs.
const UPLOAD_LIFF_ID = process.env.UPLOAD_LIFF_ID || "2008561527-sj7tuMLL"

// Same-origin <script src> gets a content hash appended at boot, so a deploy
// that changes page logic actually reaches LINE's in-app WebView.
//
// Incident (2026-08): the ranking cut-off moved from the 15th of the following
// month to the 10th, but physicians kept seeing the old list — the WebView was
// still running a cached ranking/app.js carrying the 15th. Only the OLDER month
// tabs exposed it: the previous month's deadline had not passed yet, so both
// cut-offs produced an identical list there and the page looked correct.
// express.static's default `max-age=0` should have forced a revalidation, but a
// business rule that decides who counts as on time cannot rest on a WebView
// honouring cache headers. A hashed URL cannot be answered from cache at all —
// when app.js changes, so does the URL the page asks for.
//
// Absolute URLs (the Supabase and LIFF SDKs on their CDNs) are left alone: they
// are already versioned in the path and are not ours to hash. A script that
// cannot be read is served unstamped rather than failing the boot — a missing
// hash is a stale cache, a throw here is the whole site down.
function stampAssets(html: string, pageDir: string): string {
  return html.replace(/(<script\s+src=")([^":?]+\.js)(")/g, (tag: string, pre: string, src: string, post: string) => {
    const rel = src.startsWith("/") ? src.slice(1) : path.posix.join(pageDir, src)
    try {
      const hash = crypto
        .createHash("sha1")
        .update(fs.readFileSync(path.join(__dirname, rel)))
        .digest("hex")
        .slice(0, 8)
      return pre + src + "?v=" + hash + post
    } catch (e: any) {
      console.warn("[assets] could not hash " + rel + " — serving it unversioned: " + e.message)
      return tag
    }
  })
}

// Gated pages cached as templates; the server fills the token placeholder per
// request. Files never change at runtime.
const gatedPages = ["status", "list", "ranking", "upload"]
const pageTemplates: Record<string, string> = {}
for (const p of gatedPages) {
  pageTemplates[p] = stampAssets(fs.readFileSync(path.join(__dirname, p, "index.html"), "utf8"), p)
}
// /verify/ carries no token placeholder at all — it's the same static page
// for everyone, every time (see the route below).
const verifyTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "verify", "index.html"), "utf8"),
  "verify",
)

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i === -1) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
// The session cookie holds BOTH tokens as JSON: {at: access, rt: refresh}. We
// cache the access token so we only hit Supabase's refresh endpoint when it's
// near expiry — refreshing on every page load rotated the refresh token each
// time, which Supabase can flag as reuse/theft and revoke the whole session.
function setSessionCookie(res: Response, at: string, rt: string): void {
  const val = encodeURIComponent(JSON.stringify({ at: at, rt: rt }))
  res.append("Set-Cookie", RT_COOKIE + "=" + val + "; " + COOKIE_BASE + "; Max-Age=34560000")
}
function clearSessionCookie(res: Response): void {
  res.append("Set-Cookie", RT_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
}

interface SessionCookie {
  at: string | null
  rt: string
}

function readSessionCookie(req: Request): SessionCookie | null {
  const raw = parseCookies(req)[RT_COOKIE]
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    // Valid JSON but no usable refresh token inside — treat as no session
    // rather than falling through to using the raw JSON string itself as a
    // (bogus) refresh token.
    return (o && o.rt) ? { at: o.at || null, rt: o.rt } : null
  } catch (e) {
    // Legacy cookie held a bare refresh token (pre-JSON format).
    return { at: null, rt: raw }
  }
}
// Read a JWT's payload WITHOUT verifying it. Fit only for deciding when to
// refresh (jwtExp below), never for identity or access decisions: the
// session cookie is unsigned, so a cached access token's claims are whatever
// the browser sent. Identity comes from verifiedUserEmail(), which asks
// Supabase Auth.
function jwtPayload(token: string): Record<string, any> {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  } catch (e) { return {} }
}
function jwtExp(token: string): number { return typeof jwtPayload(token).exp === "number" ? jwtPayload(token).exp : 0 }

// ── Admin auth (/admin/) — separate from the physician email/OTP/LIFF flow ──
// The admin dashboard has exactly one legitimate user, already identified by
// LINE userId (see ADMIN_LINE_USER_ID). Rather than standing up a dedicated
// LIFF app (each one is registered in the LINE Developers console against a
// fixed Endpoint URL — not something reachable from here), this reuses the
// Messaging API bot already wired up below: LINE's webhook signature
// (line.middleware) authenticates event.source.userId, so a plain DM is
// enough proof of identity. Sending "admin" from that exact userId gets a
// short-lived signed login link back; visiting it sets a signed session
// cookie. No Supabase auth user, no LIFF, no OTP involved.
//
// Tokens are stateless HMAC-signed strings (no server-side storage — this
// runs on Vercel, where nothing survives between invocations reliably). The
// signing key reuses two secrets this deployment already has rather than
// requiring a new one to be provisioned; "purpose" is mixed into the HMAC so
// a short-lived login token can never be replayed as a long-lived session
// cookie or vice versa.
//
// FAIL CLOSED when either secret is missing. Both are read from process.env
// with no default, so an unset var used to concatenate into the fully
// predictable literal "undefined:undefined" — and since the token body is only
// "purpose:exp", with no nonce and no user identity, ANYONE could then forge an
// admin session cookie. These routes hold SUPABASE_SERVICE_ROLE_KEY and bypass
// RLS, so that is the highest-value credential in the system. A missing env var
// on a preview deployment or a renamed secret is an ordinary mistake; silently
// degrading to a guessable key because of one is not an acceptable outcome.
const ADMIN_TOKEN_KEY = LINE_CHANNEL_SECRET + ":" + SUPABASE_SERVICE_ROLE_KEY
const ADMIN_KEY_USABLE = Boolean(LINE_CHANNEL_SECRET) && Boolean(SUPABASE_SERVICE_ROLE_KEY)
if (!ADMIN_KEY_USABLE) {
  console.error("[admin] LINE_CHANNEL_SECRET and/or SUPABASE_SERVICE_ROLE_KEY is not set — " +
    "admin login is DISABLED (refusing to sign or accept tokens with a predictable key)")
}
function signAdminToken(purpose: string, exp: number): string {
  if (!ADMIN_KEY_USABLE) throw new Error("admin signing key unavailable")
  const sig = crypto.createHmac("sha256", ADMIN_TOKEN_KEY).update(purpose + ":" + exp).digest("hex")
  return exp + "." + sig
}
function verifyAdminToken(purpose: string, token: string | undefined | null): boolean {
  if (!ADMIN_KEY_USABLE) return false
  if (!token || typeof token !== "string") return false
  const i = token.indexOf(".")
  if (i === -1) return false
  const exp = parseInt(token.slice(0, i), 10)
  const sig = token.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false
  const expected = crypto.createHmac("sha256", ADMIN_TOKEN_KEY).update(purpose + ":" + exp).digest("hex")
  // Constant-time compare — this gates write access to every roster table.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const ADMIN_COOKIE = "p4p_admin"
// 7 days, not the previous 90. This token is a stateless bearer with no
// revocation path short of rotating LINE_CHANNEL_SECRET or
// SUPABASE_SERVICE_ROLE_KEY (which would break the rest of the system), so
// its lifetime IS its only real defense against a lost/handed-down phone.
// Re-authenticating is a single "admin" DM to the bot — trivial for the one
// person who ever needs to.
const ADMIN_SESSION_SECONDS = 7 * 24 * 3600
function setAdminCookie(res: Response): void {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  res.append("Set-Cookie", ADMIN_COOKIE + "=" + signAdminToken("session", exp) + "; " + COOKIE_BASE + "; Max-Age=" + ADMIN_SESSION_SECONDS)
}
function clearAdminCookie(res: Response): void {
  res.append("Set-Cookie", ADMIN_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = parseCookies(req)[ADMIN_COOKIE]
  if (!verifyAdminToken("session", token)) return res.status(401).json({ error: "not authenticated" })
  next()
}

// Calls a service_role-only RPC (admin_list_roster_tables / admin_table_columns)
// — same "apikey + Authorization both = service role key" pattern used by
// every /admin/api/* route below, RPC or plain table access alike.
async function callServiceRpc(fn: string, args?: Record<string, unknown>): Promise<any> {
  const r = await axios.post(
    SUPABASE_URL + "/rest/v1/rpc/" + fn,
    args || {},
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    }
  )
  return r.data
}

// PostgREST error bodies are {message, details, hint, code} — surfaced back
// to the browser as-is. This is a single-admin internal tool, not a public
// API, so a raw constraint-violation message (e.g. "null value in column
// "prefix" violates not-null constraint") is more useful to the admin than a
// generic "insert failed", and there's no other caller to leak it to.
function pgErrorMessage(e: any, fallback: string): string {
  return (e.response && e.response.data && e.response.data.message) || fallback
}

type StatusError = Error & { status?: number }

// Re-fetches the live roster-table list and checks membership — never trust
// a :table path param on its own, since it selects which Postgres table the
// next request reads/writes.
async function assertRosterTable(table: string): Promise<void> {
  const tables = await callServiceRpc("admin_list_roster_tables")
  if (!Array.isArray(tables) || !tables.includes(table)) {
    const err = new Error("unknown roster table: " + table) as StatusError
    err.status = 404
    throw err
  }
}

interface ResolvedAccessToken {
  at: string | null
  reason: string | null
}

// Resolve a usable access token from the session cookie: reuse the cached one
// while it's fresh, otherwise refresh once (rotating the cookie). Returns
// { at: null, reason } on failure — no cookie ("no_session") or a failed
// refresh ("expired", cookie cleared) — or { at, reason: null } on success.
async function resolveAccessToken(req: Request, res: Response): Promise<ResolvedAccessToken> {
  const sess = readSessionCookie(req)
  if (!sess) return { at: null, reason: "no_session" }

  // The cookie is unsigned, so a cached token that is not even JWT-shaped
  // (three base64url segments) is not used at all: it is dropped and the
  // refresh below decides, exactly as for an expired one. Without this, a
  // token holding a character Node refuses in a header (a %7F, say) failed
  // inside axios before any request was sent, which looked like an outage.
  let at = sess.at && isJwtShaped(sess.at) ? sess.at : null
  // Refresh only when the cached access token is missing or within 60s of
  // expiry — so a normal browsing session refreshes ~once an hour, not per page.
  if (!at || jwtExp(at) < Date.now() / 1000 + 60) {
    try {
      const r = await axios.post(
        SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token",
        { refresh_token: sess.rt },
        { headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" }, timeout: 8000 }
      )
      at = r.data && r.data.access_token
      if (!at || !isJwtShaped(at)) throw new Error("no access_token in refresh response")
      setSessionCookie(res, at, r.data.refresh_token || sess.rt)
    } catch (e) {
      clearSessionCookie(res)
      return { at: null, reason: "expired" }
    }
  }
  return { at, reason: null }
}

// A JWT's shape: three base64url segments, nothing else. Says nothing about
// whether the token is valid (only Supabase can), only that it can be sent.
function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
}

// Whether a failed Supabase call is an outage rather than an answer: a 5xx,
// or a network error that left no response (connection refused or reset,
// DNS, timeout). Any 4xx — above all the 401 for a token whose signature or
// expiry does not check out — is Supabase rejecting the request, and must
// never be mistaken for a hiccup. Nor is any other error with no response:
// axios also throws locally, before sending anything, for a request it
// cannot make (ERR_INVALID_CHAR for a header holding a forbidden
// character), and a hand-made cookie must not be able to pass for an outage.
function isTransientSupabaseError(e: any): boolean {
  const status = e && e.response && typeof e.response.status === "number" ? e.response.status : 0
  if (status) return status >= 500
  // Node and axios codes for a request that got no answer: the connection
  // failed, was cut or timed out, or the name did not resolve.
  const networkCodes = [
    "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EPIPE",
    "ERR_NETWORK", "ERR_SOCKET_CONNECTION_TIMEOUT",
  ]
  return Boolean(e && typeof e.code === "string" && networkCodes.includes(e.code))
}

// The gate check: is this session's email still allowed to be here — active
// in `physicians` and, as of auth-rewrite-2026-08.sql, not sitting on a
// revoked Supabase session either. Called with the USER'S access token, not
// the anon key, and the RPC reads the email from the caller's own JWT rather
// than taking one as a parameter — there is nothing here for an
// unauthenticated caller to enumerate.
//
// "allowed" / "blocked" is the RPC's own answer. "invalid" means Supabase
// refused the token itself (forged, or no longer valid), which callers treat
// like an expired session rather than a revoked account.
type GateVerdict = "allowed" | "blocked" | "invalid"
async function checkAllowlist(accessToken: string): Promise<GateVerdict> {
  try {
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/rpc/is_current_user_allowlisted",
      {},
      { headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, timeout: 8000 }
    )
    return r.data === true ? "allowed" : "blocked"
  } catch (e: any) {
    console.error("[gate] is_current_user_allowlisted failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    // Fail open ONLY on a transient Supabase outage rather than locking out
    // a whole hospital over a network blip — the same trade the old gate
    // made. A 401/403 (or any 4xx) is not a blip: the session cookie is
    // unsigned and its cached access token is reused until its claimed
    // expiry, so treating a rejected token as a hiccup let a hand-written
    // cookie through. RLS is still the real data barrier for the page.
    return isTransientSupabaseError(e) ? "allowed" : "invalid"
  }
}

// The caller's email as Supabase Auth itself reports it for this access
// token. GET /auth/v1/user checks the token's signature, expiry and session
// server-side, so this — not the token's own claims — is where the
// service-role routes take identity from. `transient` is set when Supabase
// could not be asked; otherwise a null email means the token was refused.
async function verifiedUserEmail(accessToken: string): Promise<{ email: string | null; transient: boolean }> {
  try {
    const r = await axios.get(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + accessToken }, timeout: 8000,
    })
    const email = r.data && typeof r.data.email === "string" ? r.data.email.trim().toLowerCase() : ""
    return { email: email || null, transient: false }
  } catch (e: any) {
    console.error("[gate] /auth/v1/user failed:", e.response ? e.response.status : e.message)
    return { email: null, transient: isTransientSupabaseError(e) }
  }
}

// Serve a gated page: require a valid session cookie whose email is still
// allow-listed, and inject the current access token via <meta> (no inline
// script -> no CSP change). Whether a LINE account is bound is irrelevant
// here — that's traceability recorded elsewhere (supabase/functions/line-
// verify), never a condition for reaching the page.
function servePage(name: string) {
  return async (req: Request, res: Response) => {
    // Canonicalize to a trailing slash first. LIFF opens "/status" (no slash),
    // but the page's relative <script src="app.js"> only resolves to
    // /status/app.js when the URL ends in "/". Without this the page script
    // 404s and never runs. (express.static used to do this redirect for us.)
    //
    // Every redirect target below ends in a literal "#" for the same reason:
    // LINE's LIFF platform appends "#access_token=...&id_token=..." (its OWN
    // per-LIFF-app session bootstrap, not ours) to the URL when a LIFF app is
    // first opened. A URL fragment is never sent to the server, so we can't
    // see or drop it directly — but if OUR redirect's Location header has no
    // fragment of its own, WebKit (LINE's iOS in-app browser) carries the
    // OLD fragment forward onto the new URL. That stale, wrong-LIFF-app
    // token then rides along into /verify/, where liff.init() sees a
    // mismatch against the (different) LIFF id it's initializing with and
    // fails with "Invalid LIFF ID" — reproducibly, regardless of which LIFF
    // app the physician actually entered through. An explicit trailing "#"
    // gives the browser a fragment of our own (empty) to use, so it stops
    // carrying the old one forward.
    if (!req.path.endsWith("/")) {
      return res.redirect(302, "/" + name + "/" + req.originalUrl.slice(req.path.length) + "#")
    }
    const ret = encodeURIComponent(req.originalUrl)
    const { at, reason } = await resolveAccessToken(req, res)
    if (!at) return res.redirect(302, "/verify/?return=" + ret + "&reason=" + reason + "#")

    const verdict = await checkAllowlist(at)
    if (verdict === "invalid") {
      // The token itself was refused. Same as a lapsed session: back to
      // /verify/ with the return target, where silent LINE reauth can still
      // resume a real physician's session without an OTP.
      clearSessionCookie(res)
      return res.redirect(302, "/verify/?return=" + ret + "&reason=expired#")
    }
    if (verdict === "blocked") {
      clearSessionCookie(res)
      return res.redirect(302, "/verify/?reason=blocked#")
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8")
    // This HTML carries a live access token in its <meta>, so it must never be
    // written to a cache — and a cached copy would also keep pointing at the
    // script URL that was current when it was stored, which is how a stale
    // ranking/app.js survives a deploy (see stampAssets above).
    res.setHeader("Cache-Control", "no-store")
    res.send(
      pageTemplates[name]
        .replace(PAGE_TOKEN_PLACEHOLDER, at)
        .replace(UPLOAD_LIFF_PLACEHOLDER, UPLOAD_LIFF_ID)
    )
  }
}

// Security headers for the web UI. The Content-Security-Policy makes the
// email-verification gate more than cosmetic against XSS: script-src is limited
// to our own origin + the Supabase CDN + LINE's LIFF SDK CDN, with NO
// 'unsafe-inline', so an injected <script> or on*="" handler won't execute (all
// page JS was moved to external app.js files for exactly this reason). style-src
// keeps 'unsafe-inline' because the pages set element styles and load Google
// Fonts CSS; connect-src allows the Supabase REST/Realtime/Edge-Function
// endpoints (the *.supabase.co wildcard covers
// supabase/functions/line-verify too — same origin as everything else
// Supabase) plus the LINE API hosts the LIFF SDK calls internally
// (liff.init / liff.getIDToken). frame-ancestors is intentionally omitted so
// the pages still load inside LINE's LIFF webview.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net https://static.line-scdn.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.line.me https://access.line.me",
].join("; ")
// The dashboard self-hosts TH SarabunPSK (/dashboard/fonts/) for its header
// and table tabs; ภาพรวม and ตามส่ง keep 17 Nov's Inter + Noto Sans Thai from
// Google Fonts (Pong, 2026-11-18), so the dashboard keeps the Google Fonts
// hosts, as the LIFF pages and /dashboard/login do.
const DASHBOARD_CSP = CSP
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Content-Security-Policy", CSP)
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  next()
})

// Client posts the tokens it already holds — either straight from its own
// client-side verifyOtp(), or from the Supabase Edge Function's "silent"
// mode (supabase/functions/line-verify) after a returning physician's LINE
// login alone resumed a session. Either way this endpoint's only job is: is
// this a real, currently-valid session, and if so, stash its refresh token
// in an HttpOnly cookie. No LINE calls, no service-role key, no `physicians`
// write happen here — that all lives in the Edge Function now.
app.post("/auth/session", express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
  const { access_token, refresh_token } = req.body || {}
  if (!access_token || !refresh_token) return res.status(400).json({ error: "missing tokens" })
  try {
    await axios.get(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + access_token }, timeout: 8000,
    })
  } catch (e) {
    return res.status(401).json({ error: "invalid token" })
  }
  setSessionCookie(res, access_token, refresh_token)
  res.json({ ok: true })
})
app.post("/auth/logout", (req: Request, res: Response) => { clearSessionCookie(res); res.json({ ok: true }) })

// Gated pages: server-validated + token injected (must be registered BEFORE the
// static mounts so "/status/" hits the handler, while "/status/app.js" etc.
// fall through to the static mount below).
for (const p of gatedPages) {
  app.get(["/" + p, "/" + p + "/"], servePage(p))
}

// /verify/ itself: the same static page for everyone, every time — no
// session lookup, no token injection. Binding a LINE account no longer needs
// a server-injected token or a bounce-back-here round trip (see verify/app.ts
// and supabase/functions/line-verify): the browser already holds whatever
// tokens it needs by the time it would call either. Registered before the
// static mount below so it's this handler, not express.static, that serves
// the trailing-slash-less form too.
app.get(["/verify", "/verify/"], (req: Request, res: Response) => {
  // NO trailing-slash redirect here — this page is served identically at both
  // /verify and /verify/.
  //
  // Incident (2026-08): unbound physicians hit an endless /verify -> /verify/
  // reload. This handler used to 302 the no-slash URL to "/verify/…#", and
  // that explicit "#" was the bug: LIFF navigates to its registered Endpoint
  // URL with "#access_token=…" appended to complete login, and the redirect
  // replaced that fragment with an empty one. liff.init() then found no login
  // state, restarted login, landed back on /verify, and got stripped again —
  // forever.
  //
  // It only surfaced when the `openid` scope was added: that invalidated
  // existing LIFF consent, so init() started needing a real login round-trip
  // instead of restoring from cache. The stripping bug was already here.
  //
  // Serving both paths keeps the fragment intact (no navigation at all), and
  // verify/index.html loads /verify/app.js absolutely so the no-slash URL
  // resolves its script correctly — that 404 was the redirect's only purpose.
  //
  // The OTHER trailing-"#" redirects (servePage, for /status /list /ranking)
  // are deliberately untouched: those clear a genuinely stale fragment left by
  // a DIFFERENT LIFF app, which is a real problem and a different one.
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  // Still no-store: the page itself is static, but stampAssets hashes its
  // script URL at boot, and a cached copy would keep requesting whatever
  // hash was current when it was stored.
  res.setHeader("Cache-Control", "no-store")
  res.send(verifyTemplate)
})

// ── /admin/ — roster CRUD dashboard, single-admin only ──────────────────────
// See the "Admin auth" block above for how ADMIN_COOKIE gets set (LINE DM ->
// signed login link -> this cookie). There is no server-side gating on the
// HTML — it renders an "unauthorized" state client-side by calling GET
// /admin/api/tables, which IS gated — so it needs no <meta> token injection
// and no CSP changes: it never talks to Supabase directly, only to these same-
// origin routes, which hold SUPABASE_SERVICE_ROLE_KEY server-side.
//
// It is still served from a template rather than by express.static below, for
// one reason: stampAssets. A dashboard whose app.js is pinned in a WebView
// cache goes on driving last week's UI against this week's API routes, which
// is a worse failure here than on the read-only physician pages — this page
// writes to the roster.
const adminTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "admin", "index.html"), "utf8"),
  "admin",
)
app.get(["/admin", "/admin/"], (req: Request, res: Response) => {
  // Relative <script src="app.js"> only resolves to /admin/app.js when the URL
  // ends in a slash — the same trap servePage documents for the gated pages.
  // express.static used to answer /admin without one, leaving the page asking
  // for /app.js.
  if (!req.path.endsWith("/")) {
    return res.redirect(302, "/admin/" + req.originalUrl.slice(req.path.length))
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  // No token in this HTML, but a cached copy would keep requesting the app.js
  // URL that was current when it was stored, which defeats the hash above.
  res.setHeader("Cache-Control", "no-store")
  res.send(adminTemplate)
})

// ── /dashboard/ — desktop-only admin dashboard ──────────────────────────────
// Signed in with LINE Login (web OAuth on the LIFF apps' Login channel), not
// the /admin/ cookie: /admin/ is the phone page and stays as it is. Only the
// owner, the users in dashboard_users (added with a QR, see below) and the
// LINE userIds in DASHBOARD_LINE_USER_IDS get a session. That list lives in
// the environment rather than here because this repository is public; the
// fallback is ADMIN_LINE_USER_ID (also env-only), so with neither set nobody
// gets a session. Since the QR invite it is only the bootstrap: its users
// move into dashboard_users the next time they sign in.
//
// The channel secret is env-only (LINE_LOGIN_CHANNEL_SECRET). Without it the
// login route refuses to start rather than signing sessions with a
// predictable key.
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "2008561527"
const LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET || ""
const DASHBOARD_LINE_USER_IDS = new Set(
  (process.env.DASHBOARD_LINE_USER_IDS || ADMIN_LINE_USER_ID).split(",").map((s) => s.trim()).filter(Boolean),
)
if (DASHBOARD_LINE_USER_IDS.size === 0) {
  console.error("[dashboard] neither DASHBOARD_LINE_USER_IDS nor ADMIN_LINE_USER_ID is set — no one can sign in to the dashboard")
}
if (!LINE_LOGIN_CHANNEL_SECRET) {
  console.error("[dashboard] LINE_LOGIN_CHANNEL_SECRET is not set — dashboard login is DISABLED")
}

// ── Dashboard users and their rights (QR invite, Pong 2026-11-18) ──────────
// Who gets what, in this order (dashPerms):
//   1. the owner (ADMIN_LINE_USER_ID): everything, and the owner-only parts;
//   2. a row in dashboard_users (scripts/dashboard-users-2026-11.sql): its
//      perms while active, nothing when suspended — a row beats the env var;
//   3. DASHBOARD_LINE_USER_IDS: LEGACY_PERMS, exactly what they had before;
//   4. anyone else: no session.
// Until the SQL is pasted the table answers "not installed" and only 1, 3
// and 4 apply, which is the dashboard as it was. Rights are never put in the
// cookie: dashSession re-reads them on every request.
const DASH_PERM_KEYS = ["followup.edit", "followup.view", "review.auditee", "roster.view", "staffing.view"]
// The ผู้จัดทำ set: every right a non-owner could have before (followup,
// read-only รายชื่อ and อัตรากำลัง, the ตรวจสอบ ผู้จัดทำ side).
const LEGACY_PERMS = DASH_PERM_KEYS.slice()
const OWNER_PERMS = DASH_PERM_KEYS.slice()
// Known keys only, followup.edit brings followup.view, sorted, no repeats;
// null when any key is unknown (or the value is not a list).
function normalizePerms(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = new Set<string>()
  for (const k of v) {
    if (typeof k !== "string" || !DASH_PERM_KEYS.includes(k)) return null
    out.add(k)
  }
  if (out.has("followup.edit")) out.add("followup.view")
  return Array.from(out).sort()
}
interface DashUserRow { line_user_id: string; display_name: string; line_name: string; perms: string[]; active: boolean }
// One copy per warm instance, read again every 30 s (one read at a time); a
// write on this instance drops it at once. A failed read keeps the last good
// copy for 10 minutes; after that the table's users are refused (fail closed)
// except that a suspension in the stale copy still holds, while the owner and
// the env users keep working.
const DASH_USERS_TTL_MS = 30 * 1000
const DASH_USERS_STALE_MS = 10 * 60 * 1000
const dashUsers = {
  rows: new Map<string, DashUserRow>(),
  installed: null as boolean | null,
  goodAt: 0,
  triedAt: 0,
  loading: null as Promise<void> | null,
}
// PostgREST / Postgres for "no such table or function".
const isNotInstalledError = (e: any): boolean =>
  ["PGRST205", "PGRST202", "42P01", "42883"].includes(String(e?.response?.data?.code || ""))
function loadDashUsers(force = false): Promise<void> {
  if (dashUsers.loading) return dashUsers.loading
  if (!force && Date.now() - dashUsers.triedAt < DASH_USERS_TTL_MS) return Promise.resolve()
  dashUsers.triedAt = Date.now()
  dashUsers.loading = (async () => {
    try {
      const r = await axios.get(SUPABASE_URL + "/rest/v1/dashboard_users?select=line_user_id,display_name,line_name,perms,active",
        { headers: SERVICE_HEADERS(), timeout: 5000 })
      const rows = new Map<string, DashUserRow>()
      for (const u of (Array.isArray(r.data) ? r.data : []) as DashUserRow[]) {
        if (u && typeof u.line_user_id === "string") {
          rows.set(u.line_user_id, { ...u, perms: normalizePerms(u.perms) || [], active: u.active === true })
        }
      }
      dashUsers.rows = rows
      dashUsers.installed = true
      dashUsers.goodAt = Date.now()
    } catch (e: any) {
      if (isNotInstalledError(e)) {
        dashUsers.rows = new Map()
        dashUsers.installed = false
        dashUsers.goodAt = Date.now()
      } else {
        console.error("[dashboard] users read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      }
    } finally {
      dashUsers.loading = null
    }
  })()
  return dashUsers.loading
}
const dashUsersFresh = (): boolean => dashUsers.goodAt > 0 && Date.now() - dashUsers.goodAt < DASH_USERS_STALE_MS
// The user's row, or null (none, or the copy is too old to trust).
const dashUserRow = (sub: string): DashUserRow | null => (dashUsersFresh() && dashUsers.rows.get(sub)) || null
function dashPerms(sub: string): string[] | null {
  if (!sub) return null
  if (isOwnerLineUserId(sub)) return OWNER_PERMS
  const row = dashUsers.rows.get(sub)
  if (row) {
    if (!row.active) return null
    if (dashUsersFresh()) return row.perms
  }
  return DASHBOARD_LINE_USER_IDS.has(sub) ? LEGACY_PERMS : null
}

const DASH_COOKIE = "p4p_dash"
const DASH_STATE_COOKIE = "p4p_dash_state"
const DASH_SESSION_SECONDS = 12 * 3600
// Signed out after this long without activity. The page pings
// /dashboard/api/session while the user is active, which slides the idle
// deadline forward; a closed or untouched tab simply lets it lapse.
const DASH_IDLE_SECONDS = 15 * 60

// HMAC-signed "payload.sig" values: the session cookie carries
// {sub, name, exp, idle}, the state cookie {state, nonce, exp}.
function signDash(obj: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url")
  const sig = crypto.createHmac("sha256", "dash:" + LINE_LOGIN_CHANNEL_SECRET).update(body).digest("base64url")
  return body + "." + sig
}
function readDash(token: string | undefined): Record<string, any> | null {
  if (!LINE_LOGIN_CHANNEL_SECRET || !token) return null
  const i = token.indexOf(".")
  if (i === -1) return null
  const body = token.slice(0, i)
  const expected = crypto.createHmac("sha256", "dash:" + LINE_LOGIN_CHANNEL_SECRET).update(body).digest("base64url")
  const a = Buffer.from(token.slice(i + 1))
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const o = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    return o && typeof o.exp === "number" && o.exp > Date.now() / 1000 ? o : null
  } catch (e) { return null }
}
function dashSession(req: Request): { sub: string; name: string; exp: number; perms: string[] } | null {
  const o = readDash(parseCookies(req)[DASH_COOKIE])
  // A payload with a typ (the phone's p4p_join) is never a session.
  if (!o || typeof o.idle !== "number" || o.idle <= Date.now() / 1000 || o.typ !== undefined) return null
  // Re-checked on every request, so a suspension or a removed right (or an
  // id taken out of the env var) applies to the next call, not when the
  // cookie expires.
  const perms = dashPerms(String(o.sub || ""))
  if (!perms) return null
  const row = dashUserRow(o.sub)
  return { sub: o.sub, name: (row && row.display_name) || staffName(o.name), exp: o.exp, perms }
}
// The owner can do everything; anyone else needs the right.
const can = (s: { sub: string; perms: string[] }, perm: string): boolean => isDashOwner(s.sub) || s.perms.includes(perm)
// (Re)issues the session cookie with a fresh idle deadline, keeping the
// absolute 12h expiry from sign-in.
function setDashCookie(res: Response, sub: string, name: string, exp: number): void {
  const now = Math.floor(Date.now() / 1000)
  const idle = Math.min(exp, now + DASH_IDLE_SECONDS)
  res.append("Set-Cookie", DASH_COOKIE + "=" + signDash({ sub, name, exp, idle }) + "; " + COOKIE_BASE + "; Max-Age=" + Math.max(0, exp - now))
}
// The callback URL must be registered on the LINE Login channel exactly, so
// it is built from ADMIN_BASE_URL (the production origin), not the Host header.
const DASH_CALLBACK_URL = ADMIN_BASE_URL.replace(/\/$/, "") + "/dashboard/auth/callback"

const dashboardTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "dashboard", "index.html"), "utf8"),
  "dashboard",
)
const dashboardLoginTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "dashboard", "login.html"), "utf8"),
  "dashboard",
)
// Fixed strings only: the ?error code picks one, it is never echoed.
const DASH_LOGIN_ERRORS: Record<string, string> = {
  not_allowed: "บัญชี LINE นี้ไม่มีสิทธิ์เข้าใช้งานแดชบอร์ด",
  login_failed: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่",
  bad_state: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่",
  login_disabled: "ระบบเข้าสู่ระบบยังไม่ได้ตั้งค่า",
  idle: "ออกจากระบบอัตโนมัติ เนื่องจากไม่มีการใช้งาน 15 นาที",
}

// ── Audit log ─────────────────────────────────────────────────────────────
// Who did what on /dashboard/: sign-ins (and refused ones), sign-outs, tab
// views, lists opened, follow-up notes added or deleted, and audit-log views.
// Written here on the server with the service key (table
// dashboard_audit_log, scripts/dashboard-audit-log-2026-10.sql, which is
// append-only), so an admin cannot skip or alter an entry. Only the owner
// (ADMIN_LINE_USER_ID, the single /admin/ user) can read it; the other
// dashboard admins never see the tab and get 404 from its API.
const isDashOwner = (sub: string): boolean => isOwnerLineUserId(sub)
// LINE display names shown as the Thai names Pong set (lib/staff-names.ts).
const { staffName } = require("./lib/staff-names") as typeof import("./lib/staff-names")
// History rows: a dashboard user's older rows carry the LINE name, so they
// get the Thai one; a refused stranger keeps the name LINE gave.
const shownActor = (sub: string, name: string): string => {
  const row = dashUserRow(sub)
  if (row) return row.display_name || staffName(name)
  return dashPerms(sub) !== null ? staffName(name) : name
}
// The ตรวจสอบ tab's ผู้จัดทำ (auditee) side: a dashboard user who is not the
// owner and has review.auditee (Pong, 2026-11-12: "Add Dada as auditee";
// every env user has it). The owner has both sides.
const isReviewAuditee = (sub: string): boolean => !isDashOwner(sub) && (dashPerms(sub) || []).includes("review.auditee")

// Never throws: a failed log write is reported in the server log, and the
// action it describes still goes ahead.
async function audit(req: Request, actor: { sub: string; name: string }, action: string, target: Record<string, unknown> = {}): Promise<void> {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  try {
    await axios.post(SUPABASE_URL + "/rest/v1/dashboard_audit_log", {
      actor_line_id: actor.sub,
      actor_name: actor.name,
      action,
      target,
      ip: (fwd || req.socket.remoteAddress || "").slice(0, 64),
      user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
    }, { headers: { ...SERVICE_HEADERS(), "Content-Type": "application/json" }, timeout: 8000 })
  } catch (e: any) {
    console.error("[dashboard] audit write failed (" + action + "):", e.response ? JSON.stringify(e.response.data) : e.message)
  }
}

// Unlike the LIFF pages, the dashboard never runs inside a frame, so it
// refuses to be framed by anyone (clickjacking on the delete buttons).
// The approval panel shows the newcomer's LINE picture, so the dashboard's
// img-src also allows LINE's profile-picture host (one img-src: a second
// directive would be ignored).
const DASH_CSP = DASHBOARD_CSP.replace("img-src 'self' data:", "img-src 'self' data: https://profile.line-scdn.net")
app.use("/dashboard", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Content-Security-Policy", (req.path === "/login" ? CSP : DASH_CSP) + "; frame-ancestors 'none'")
  next()
})

// The users table, read before any dashboard route (scripts and images
// skip it). Without the LINE Login secret nobody can sign in, so no read.
app.use("/dashboard", async (req: Request, res: Response, next: NextFunction) => {
  if (!LINE_LOGIN_CHANNEL_SECRET || /[.](js|css|png|svg|ico|ttf|woff2?)$/i.test(req.path)) return next()
  await loadDashUsers()
  next()
})

// Rights by path, before every route (mountReview and mountStaffing too).
// It only ever adds a refusal: no session goes on to the route's own 401,
// and the owner-only checks in the handlers stay as they are. Express
// routes ignore case and a trailing slash, so the gate matches the same
// way: on Express's own parsed path (baseUrl + path, which also handles an
// absolute-form request target), lower-cased, with repeated and trailing
// slashes taken off. The ตามส่ง, รายชื่อ and อัตรากำลัง handlers check the
// right again themselves. ภาพรวม (/api/overview, /api/pending) is everyone's.
const DASH_PATH_RIGHTS: [RegExp, (method: string) => string | null][] = [
  [/^[/]dashboard[/]api[/]followups([/].*)?$/i, (m) => (m === "GET" || m === "HEAD" ? "followup.view" : "followup.edit")],
  [/^[/]dashboard[/]api[/]roster([/].*)?$/i, (m) => (m === "GET" || m === "HEAD" ? "roster.view" : null)],
  [/^[/]dashboard[/]api[/]staffing$/i, (m) => (m === "GET" || m === "HEAD" ? "staffing.view" : null)],
]
const dashGatePath = (path: string): string => path.toLowerCase().replace(/[/]{2,}/g, "/").replace(/(.)[/]+$/, "$1")
function dashPathRight(method: string, path: string): string | null {
  const p = dashGatePath(path.split("?")[0])
  for (const [re, right] of DASH_PATH_RIGHTS) if (re.test(p)) return right(method)
  return null
}
app.use("/dashboard", (req: Request, res: Response, next: NextFunction) => {
  const need = dashPathRight(req.method, req.baseUrl + req.path)
  if (!need) return next()
  const s = dashSession(req)
  if (!s || can(s, need)) return next()
  res.setHeader("Cache-Control", "no-store")
  res.status(404).json({ error: "not found" })
})
// The same check inside a handler: true when the request may go on, and
// otherwise the 404 has been sent.
function dashRight(s: { sub: string; perms: string[] }, need: string, res: Response): boolean {
  if (can(s, need)) return true
  res.status(404).json({ error: "not found" })
  return false
}

// The dashboard is only ever served to a signed-in, allowlisted user;
// everyone else lands on /dashboard/login first.
app.get(["/dashboard", "/dashboard/"], (req: Request, res: Response) => {
  if (!dashSession(req)) return res.redirect(302, "/dashboard/login")
  if (!req.path.endsWith("/")) {
    return res.redirect(302, "/dashboard/" + req.originalUrl.slice(req.path.length))
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  // A cached copy would keep requesting the app.js URL that was current when
  // it was stored, which defeats stampAssets — and it must not outlive logout.
  res.setHeader("Cache-Control", "no-store")
  res.send(dashboardTemplate)
})

app.get("/dashboard/login", async (req: Request, res: Response) => {
  if (dashSession(req)) return res.redirect(302, "/dashboard/")
  // A session that lapsed on the server (laptop asleep, tab closed) still has
  // its signed cookie: log the idle sign-out once, then clear it.
  const lapsed = readDash(parseCookies(req)[DASH_COOKIE])
  if (lapsed && lapsed.typ === undefined && dashPerms(String(lapsed.sub || "")) !== null) {
    res.append("Set-Cookie", DASH_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
    await audit(req, { sub: lapsed.sub, name: staffName(lapsed.name) }, "session.idle")
  }
  const msg = DASH_LOGIN_ERRORS[String(req.query.error || "")]
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  // The idle sign-out is a notice, not a failure, so it gets a calmer style.
  const cls = req.query.error === "idle" ? "error notice" : "error"
  res.send(dashboardLoginTemplate.replace("__LOGIN_ERROR__", msg ? '<p class="' + cls + '" role="alert">' + msg + "</p>" : ""))
})

// Starts LINE Login; LINE sends the browser back to /dashboard/auth/callback.
// ?join=<token>: the phone of someone who scanned the owner's QR (see the
// QR invite routes below). Same channel, same callback, same scopes; the
// token itself never goes to LINE, only its hash, in the signed state cookie.
app.get("/dashboard/auth/line", (req: Request, res: Response) => {
  const joining = req.query.join !== undefined
  if (joining) {
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Cache-Control", "no-store")
    if (!joinRateOk(req, "join")) return res.redirect(302, "/dashboard/join/done?e=busy")
    if (!LINE_LOGIN_CHANNEL_SECRET) return res.redirect(302, "/dashboard/join/done?e=not_ready")
    if (!JOIN_TOKEN_RE.test(String(req.query.join))) return res.redirect(302, "/dashboard/join/done?e=invalid")
  }
  if (!LINE_LOGIN_CHANNEL_SECRET) return res.redirect(302, "/dashboard/login?error=login_disabled")
  // "j." marks a join even when the cookie is lost on the way back.
  const state = (joining ? "j." : "") + crypto.randomBytes(16).toString("hex")
  const nonce = crypto.randomBytes(16).toString("hex")
  const exp = Math.floor(Date.now() / 1000) + 600
  const saved: Record<string, unknown> = { state, nonce, exp }
  if (joining) saved.join = sha256Hex(String(req.query.join))
  res.append("Set-Cookie", DASH_STATE_COOKIE + "=" + signDash(saved) + "; " + COOKIE_BASE + "; Max-Age=600")
  const q = new URLSearchParams({
    response_type: "code",
    client_id: LINE_LOGIN_CHANNEL_ID,
    redirect_uri: DASH_CALLBACK_URL,
    state,
    scope: "profile openid",
    nonce,
  })
  res.redirect(302, "https://access.line.me/oauth2/v2.1/authorize?" + q.toString())
})

app.get("/dashboard/auth/callback", async (req: Request, res: Response) => {
  const saved = readDash(parseCookies(req)[DASH_STATE_COOKIE])
  res.append("Set-Cookie", DASH_STATE_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
  const code = String(req.query.code || "")
  const queryState = String(req.query.state || "")
  // A phone that scanned the QR comes back to the phone pages, never to the
  // desktop-only login page.
  const joining = (saved && typeof saved.join === "string") || queryState.startsWith("j.")
  if (joining) {
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Cache-Control", "no-store")
  }
  if (!saved || !code || queryState !== saved.state) {
    if (joining) return res.redirect(302, "/dashboard/join/done?e=" + (req.query.error === "access_denied" ? "denied" : "bad_state"))
    return res.redirect(302, "/dashboard/login?error=bad_state")
  }
  try {
    const tok = await axios.post(
      "https://api.line.me/oauth2/v2.1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: DASH_CALLBACK_URL,
        client_id: LINE_LOGIN_CHANNEL_ID,
        client_secret: LINE_LOGIN_CHANNEL_SECRET,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 },
    )
    // LINE verifies the ID token's signature, audience, expiry and nonce.
    const v = await axios.post(
      "https://api.line.me/oauth2/v2.1/verify",
      new URLSearchParams({ id_token: tok.data.id_token, client_id: LINE_LOGIN_CHANNEL_ID, nonce: saved.nonce }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 },
    )
    const sub = String(v.data.sub || "")
    // The QR join: records who scanned, never signs anyone in.
    if (typeof saved.join === "string") return await joinClaim(req, res, saved.join, v.data)
    // Someone this instance does not know yet may have been approved on
    // another one a moment ago: read the table again once before refusing.
    if (dashPerms(sub) === null && !dashUsers.rows.has(sub)) await loadDashUsers(true)
    if (dashPerms(sub) === null) {
      console.warn("[dashboard] LINE login refused for " + sub)
      await audit(req, { sub, name: String(v.data.name || "") }, "login.refused")
      return res.redirect(302, "/dashboard/login?error=not_allowed")
    }
    const row = dashUserRow(sub)
    const name = (row && row.display_name) || staffName(v.data.name)
    setDashCookie(res, sub, name, Math.floor(Date.now() / 1000) + DASH_SESSION_SECONDS)
    await Promise.all([audit(req, { sub, name }, "login.success"), importEnvUser(req, sub, v.data)])
    res.redirect(302, "/dashboard/")
  } catch (e: any) {
    console.error("[dashboard] LINE login failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    if (joining) return res.redirect(302, "/dashboard/join/done?e=failed")
    res.redirect(302, "/dashboard/login?error=login_failed")
  }
})

// An env-listed user (not the owner) with no row yet gets one, with the
// rights they have today, so the owner can edit or suspend them on the
// page. Never throws; does nothing until the SQL is in.
async function importEnvUser(req: Request, sub: string, profile: Record<string, any>): Promise<void> {
  if (isDashOwner(sub) || !DASHBOARD_LINE_USER_IDS.has(sub) || dashUsers.installed !== true || dashUsers.rows.has(sub)) return
  try {
    const r = await callServiceRpc("dashboard_user_import", {
      p_sub: sub, p_line_name: String(profile.name || "").slice(0, 100), p_display_name: staffName(profile.name).slice(0, 60),
    })
    if (r && r.inserted) {
      await audit(req, { sub, name: staffName(profile.name) }, "user.import", { perms: LEGACY_PERMS })
      void loadDashUsers(true)
    }
  } catch (e: any) {
    console.error("[dashboard] user import failed:", e.response ? JSON.stringify(e.response.data) : e.message)
  }
}

// ?reason=idle when the page signs itself out after 15 idle minutes. By then
// the server's idle deadline has usually passed too, so the cookie is read
// for its signature and 12h expiry only.
app.post("/dashboard/logout", async (req: Request, res: Response) => {
  const o = readDash(parseCookies(req)[DASH_COOKIE])
  res.append("Set-Cookie", DASH_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
  if (o && o.typ === undefined && dashPerms(String(o.sub || "")) !== null) {
    const row = dashUserRow(o.sub)
    await Promise.all([
      audit(req, { sub: o.sub, name: (row && row.display_name) || staffName(o.name) }, req.query.reason === "idle" ? "session.idle" : "session.logout"),
      // Signing out also cancels the owner's QR that nobody scanned yet.
      isDashOwner(o.sub) && dashUsers.installed !== false
        ? callServiceRpc("dashboard_invite_cancel", { p_actor: o.sub, p_id: null }).catch(() => null) : null,
    ])
  }
  res.json({ ok: true })
})

// Also the page's keep-alive: each call slides the idle deadline forward.
// perms: the tabs this user has (the page shows only those; the server
// checks every call anyway). The owner also gets how many QR scans wait for
// approval, and whether the users table is installed yet.
app.get("/dashboard/api/session", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  setDashCookie(res, s.sub, s.name, s.exp)
  const owner = isDashOwner(s.sub)
  const body: Record<string, unknown> = {
    ok: true, name: s.name, idleSeconds: DASH_IDLE_SECONDS, isOwner: owner, reviewAuditee: isReviewAuditee(s.sub), perms: s.perms,
  }
  if (owner) {
    body.usersInstalled = dashUsers.installed !== false
    body.pendingUsers = dashUsers.installed === false ? 0 : await pendingInviteCount(s.sub)
  }
  res.json(body)
})

// ── QR invite: a new dashboard user (Pong, 2026-11-18: "Go QR") ────────────
// The owner's เพิ่มผู้ใช้ด้วย QR makes a QR that works once and expires in 10
// minutes (dashboard_invites keeps only the token's sha256). The newcomer
// scans it with the LINE app: /dashboard/join (the landing card, which only
// peeks at the QR) → /dashboard/auth/line?join= → LINE Login on the same
// channel and callback as the desktop sign-in → the callback records the
// LINE ID that LINE verified, with a 4-digit code, and sends the phone to
// /dashboard/join/wait, which shows the code. The owner types that code in
// the approval panel, picks the rights, and approves; only then does the
// LINE ID get a row in dashboard_users. The join never sets p4p_dash.
const JOIN_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
const JOIN_COOKIE = "p4p_join"
const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex")
const dashboardJoinTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "dashboard", "join.html"), "utf8"),
  "dashboard",
)
const escapeHtml = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
// Bangkok clock time, e.g. "07:41 น."
const bkkTime = (iso: string | number | Date): string =>
  new Date(iso).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }) + " น."
// "ตามส่ง (บันทึก) · รายชื่อ (ดู) · อัตรากำลัง (ดู) · ตรวจสอบ (ผู้จัดทำ)"
function permsSummary(perms: unknown, sep = " · "): string {
  const p = normalizePerms(perms) || []
  const out: string[] = []
  if (p.includes("followup.edit")) out.push("ตามส่ง (บันทึก)")
  else if (p.includes("followup.view")) out.push("ตามส่ง (ดู)")
  if (p.includes("roster.view")) out.push("รายชื่อ (ดู)")
  if (p.includes("staffing.view")) out.push("อัตรากำลัง (ดู)")
  if (p.includes("review.auditee")) out.push("ตรวจสอบ (ผู้จัดทำ)")
  return out.length ? out.join(sep) : "ภาพรวมเท่านั้น"
}

// Per instance and best effort (the database holds the real limits): 30
// requests per 10 minutes per IP on the landing page, the LINE hop and the
// error cards. The wait page reloads itself every 5 s, so it has its own,
// larger allowance.
const JOIN_WINDOW_MS = 10 * 60 * 1000
const JOIN_LIMITS: Record<string, number> = { join: 30, wait: 200 }
const joinHits = new Map<string, number[]>()
function joinRateOk(req: Request, bucket: "join" | "wait"): boolean {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || ""
  const key = bucket + ":" + ip
  const now = Date.now()
  const hits = (joinHits.get(key) || []).filter((t) => now - t < JOIN_WINDOW_MS)
  hits.push(now)
  joinHits.set(key, hits)
  if (joinHits.size > 5000) {
    for (const [k, v] of joinHits) if (!v.length || now - v[v.length - 1] >= JOIN_WINDOW_MS) joinHits.delete(k)
  }
  return hits.length <= JOIN_LIMITS[bucket]
}

// Fixed cards: ?e= picks one, it is never echoed.
const JOIN_MESSAGES: Record<string, string> = {
  expired: "QR นี้หมดอายุแล้ว ขอให้ผู้ดูแลสร้าง QR ใหม่",
  used: "QR นี้ถูกใช้แล้ว — ถ้าไม่ใช่คุณที่สแกน ให้แจ้งผู้ดูแลทันที",
  invalid: "QR ไม่ถูกต้อง ขอให้ผู้ดูแลสร้าง QR ใหม่",
  already: "บัญชี LINE นี้มีสิทธิ์เข้าใช้อยู่แล้ว เข้าใช้งานบนคอมพิวเตอร์ได้เลย",
  owner: "นี่คือบัญชีผู้ดูแลระบบ ให้ผู้ใช้ใหม่เป็นผู้สแกน",
  bad_state: "เปิดลิงก์ไม่สำเร็จ กรุณาสแกน QR อีกครั้งด้วยแอป LINE",
  denied: "ยกเลิกการยืนยันตัวตนแล้ว",
  failed: "ยืนยันตัวตนไม่สำเร็จ กรุณาลองใหม่",
  busy: "ลองบ่อยเกินไป กรุณารอสักครู่",
  not_ready: "ระบบยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล",
}
const JOIN_SVG: Record<string, string> = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  no: '<path d="M18 6 6 18M6 6l12 12"/>',
  warn: '<path d="M12 6v8M12 18v.5"/>',
}
const joinMark = (kind: "ok" | "no" | "warn"): string =>
  '<div class="mark ' + kind + '" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round">' + JOIN_SVG[kind] + "</svg></div>"
const JOIN_SITE = '<span class="nowrap">p4p-sakhonmso.vercel.app</span>'
function sendJoinPage(res: Response, card: string, refresh = false, status = 200): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("X-Robots-Tag", "noindex")
  // Function replacers: a "$&" or "$'" in a LINE display name stays text.
  res.status(status).send(dashboardJoinTemplate
    .replace("__JOIN_REFRESH__", () => (refresh ? '<meta http-equiv="refresh" content="5">' : ""))
    .replace("__JOIN_BODY__", () => '<section class="card">' + card + "</section>"))
}
const joinError = (res: Response, e: string): void => {
  const msg = JOIN_MESSAGES[e] || JOIN_MESSAGES.invalid
  sendJoinPage(res, joinMark(e === "denied" || e === "busy" ? "warn" : "no") + '<h1 role="alert">' + escapeHtml(msg) + "</h1>")
}

// The QR's address. It only peeks: a link preview or prefetch cannot use
// the QR up; the scan counts at the callback.
app.get("/dashboard/join", async (req: Request, res: Response) => {
  if (!joinRateOk(req, "join")) return joinError(res, "busy")
  if (!LINE_LOGIN_CHANNEL_SECRET) return joinError(res, "not_ready")
  const token = String(req.query.i || "")
  if (!JOIN_TOKEN_RE.test(token)) return joinError(res, "invalid")
  try {
    const r = await callServiceRpc("dashboard_invite_peek", { p_token_hash: sha256Hex(token) })
    const status = r && r.status
    if (status !== "open") return joinError(res, status === "expired" || status === "used" ? status : "invalid")
  } catch (e: any) {
    if (isNotInstalledError(e)) return joinError(res, "not_ready")
    console.error("[dashboard] join peek failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return joinError(res, "failed")
  }
  sendJoinPage(res,
    "<h1>ขอเข้าใช้งานแดชบอร์ด P4P</h1>" +
    "<p>ผู้ดูแลเชิญคุณเข้าใช้แดชบอร์ด กรุณายืนยันตัวตนด้วยบัญชี LINE ที่จะใช้เข้าสู่ระบบบนคอมพิวเตอร์</p>" +
    '<a class="line" href="/dashboard/auth/line?join=' + encodeURIComponent(token) + '"><i aria-hidden="true">LINE</i>ยืนยันตัวตนด้วย LINE</a>' +
    '<p class="fine">ระบบจะได้รับเฉพาะชื่อและรูปโปรไฟล์ LINE ของคุณ · หน้านี้ไม่ขอรหัสผ่าน · ที่อยู่เว็บต้องเป็น ' + JOIN_SITE + "</p>")
})

app.get("/dashboard/join/done", (req: Request, res: Response) => {
  if (!joinRateOk(req, "join")) return joinError(res, "busy")
  joinError(res, String(req.query.e || ""))
})

// The callback's join branch: LINE has verified the ID token, so v.data.sub
// is the same LINE ID the newcomer's desktop sign-in will carry.
async function joinClaim(req: Request, res: Response, tokenHash: string, profile: Record<string, any>): Promise<void> {
  const sub = String(profile.sub || "")
  if (!/^U[0-9a-f]{32}$/.test(sub)) return res.redirect(302, "/dashboard/join/done?e=failed")
  const name = String(profile.name || "").slice(0, 100)
  const picture = typeof profile.picture === "string" && profile.picture.startsWith("https://profile.line-scdn.net/")
    ? profile.picture.slice(0, 500) : null
  if (isDashOwner(sub)) return res.redirect(302, "/dashboard/join/done?e=owner")
  if (dashPerms(sub) !== null) return res.redirect(302, "/dashboard/join/done?e=already")
  let r: { result?: string; id?: string }
  try {
    r = (await callServiceRpc("dashboard_invite_claim", {
      p_token_hash: tokenHash, p_sub: sub, p_name: name, p_picture: picture,
      p_code: String(crypto.randomInt(0, 10000)).padStart(4, "0"),
    })) || {}
  } catch (e: any) {
    if (isNotInstalledError(e)) return res.redirect(302, "/dashboard/join/done?e=not_ready")
    throw e
  }
  const invite = String(r.id || "").slice(0, 8)
  if (r.result === "ok" && r.id) {
    const exp = Math.floor(Date.now() / 1000) + 24 * 3600
    res.append("Set-Cookie", JOIN_COOKIE + "=" + signDash({ typ: "join", inv: r.id, sub, exp }) +
      "; HttpOnly; Secure; SameSite=Lax; Path=/dashboard/join; Max-Age=" + 24 * 3600)
    await Promise.all([
      audit(req, { sub, name }, "user.claim", { invite }),
      tg.sendTelegram("[P4P] มีผู้สแกน QR ขอสิทธิ์แดชบอร์ด — LINE: " + name + " เวลา " + bkkTime(Date.now()) +
        " อนุมัติได้บนแดชบอร์ดเท่านั้น ถ้าไม่ได้สร้าง QR นี้ ให้ปฏิเสธทันที"),
    ])
    return res.redirect(302, "/dashboard/join/wait")
  }
  const reason = ["used", "expired", "already", "invalid"].includes(String(r.result)) ? String(r.result) : "invalid"
  console.warn("[dashboard] QR claim refused (" + reason + ")")
  await Promise.all([
    audit(req, { sub, name }, "user.claim_refused", { invite, reason }),
    reason === "used" ? tg.sendTelegram("[P4P] QR ที่ใช้แล้วถูกสแกนซ้ำโดย " + name + " — ตรวจว่า QR ไม่ได้หลุดออกไป") : null,
  ])
  res.redirect(302, "/dashboard/join/done?e=" + reason)
}

// The newcomer's phone after the scan: the code while the owner decides
// (reloading itself every 5 s, no script), then the answer.
app.get("/dashboard/join/wait", async (req: Request, res: Response) => {
  if (!joinRateOk(req, "wait")) return joinError(res, "busy")
  const o = readDash(parseCookies(req)[JOIN_COOKIE])
  if (!o || o.typ !== "join" || typeof o.inv !== "string" || typeof o.sub !== "string") return joinError(res, "bad_state")
  let st: { status?: string; code?: string | null; name?: string | null; perms?: string[] }
  try {
    st = (await callServiceRpc("dashboard_invite_status", { p_id: o.inv, p_sub: o.sub })) || {}
  } catch (e: any) {
    console.error("[dashboard] join status failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return joinError(res, isNotInstalledError(e) ? "not_ready" : "failed")
  }
  if (st.status === "scanned" && st.code) {
    return sendJoinPage(res,
      "<h1>รหัสยืนยันของคุณ</h1>" +
      '<div class="code" aria-label="' + escapeHtml(st.code.split("").join(" ")) + '">' + escapeHtml(st.code) + "</div>" +
      "<p>แสดงรหัสนี้ให้ผู้ดูแลกรอกบนคอมพิวเตอร์</p>" +
      '<p class="fine">ในนาม ' + escapeHtml(st.name || "") + "</p>" +
      '<span class="spin" role="status">รอผู้ดูแลอนุมัติ… หน้านี้จะอัปเดตเอง</span>', true)
  }
  if (st.status === "approved") {
    return sendJoinPage(res, joinMark("ok") +
      "<h1>ได้รับอนุมัติแล้ว</h1>" +
      "<p>สิทธิ์ของคุณ: " + escapeHtml(permsSummary(st.perms)) + "</p>" +
      '<div class="info">แดชบอร์ดใช้งานบนคอมพิวเตอร์เท่านั้น เปิด <span class="nowrap">p4p-sakhonmso.vercel.app/dashboard</span> ' +
      "แล้วกด “เข้าสู่ระบบด้วย LINE” ด้วยบัญชีนี้</div>")
  }
  if (st.status === "rejected") {
    return sendJoinPage(res, joinMark("no") + "<h1>คำขอไม่ได้รับอนุมัติ</h1><p>หากคิดว่าผิดพลาด กรุณาติดต่อผู้ดูแลระบบ</p>")
  }
  if (st.status === "invalid") return joinError(res, "bad_state")
  // cancelled, expired, locked
  sendJoinPage(res, joinMark("warn") + "<h1>คำขอนี้ถูกยกเลิกหรือหมดเวลาแล้ว</h1><p>ขอให้ผู้ดูแลสร้าง QR ใหม่</p>")
})

// ── The owner's side: QR, approval, users (anyone else gets 404) ──────────
const qrcodeGenerator = require("qrcode-generator") as typeof import("qrcode-generator")
function qrDataUri(text: string): string {
  const qr = qrcodeGenerator(0, "M")
  qr.addData(text)
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true } as any)
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")
}
const ADMIN_ORIGIN = (() => { try { return new URL(ADMIN_BASE_URL).origin } catch (e) { return "" } })()
// The owner's session, or null after answering 401 / 404 (and 403 for a
// write from another origin: the writes take JSON under a Lax cookie, and
// must also come from this site).
function usersOwner(req: Request, res: Response, write = false): { sub: string; name: string; exp: number; perms: string[] } | null {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) { res.status(401).json({ error: "not authenticated" }); return null }
  if (!isDashOwner(s.sub)) { res.status(404).json({ error: "not found" }); return null }
  if (write) {
    const origin = String(req.headers.origin || "")
    let sameHost = false
    try { sameHost = !!origin && new URL(origin).host === String(req.headers.host || "") } catch (e) { sameHost = false }
    if (!(origin && (origin === ADMIN_ORIGIN || sameHost))) { res.status(403).json({ error: "bad origin" }); return null }
  }
  return s
}
const usersNotInstalled = (res: Response): void => {
  res.status(409).json({ error: "not_installed", installed: false })
}
async function pendingInviteCount(owner: string): Promise<number> {
  try {
    const r = await axios.get(SUPABASE_URL + "/rest/v1/dashboard_invites?select=id&status=eq.scanned&created_by=eq." + owner +
      "&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&limit=50", { headers: SERVICE_HEADERS(), timeout: 5000 })
    return Array.isArray(r.data) ? r.data.length : 0
  } catch (e: any) {
    if (isNotInstalledError(e)) dashUsers.installed = false
    return 0
  }
}
// What the owner's page may see of a request: never the code or the whole ID.
interface InviteRow {
  id: string; status: string; created_at: string; expires_at: string; claimed_sub: string | null; claimed_name: string | null
  claimed_picture: string | null; claimed_at: string | null; code_tries: number; perms: string[] | null; decided_at: string | null
}
const INVITE_COLS = "id,status,created_at,expires_at,claimed_sub,claimed_name,claimed_picture,claimed_at,code_tries,perms,decided_at"
const inviteView = (r: InviteRow): Record<string, unknown> => ({
  id: r.id,
  status: (r.status === "open" || r.status === "scanned") && Date.parse(r.expires_at) <= Date.now() ? "expired" : r.status,
  expiresAt: r.expires_at,
  triesLeft: Math.max(0, 3 - (r.code_tries || 0)),
  claim: r.claimed_sub ? {
    name: r.claimed_name || "", picture: r.claimed_picture || null, subTail: r.claimed_sub.slice(-4), at: r.claimed_at,
  } : null,
  perms: r.perms || null,
})
// The name typed for the dashboard, cleaned like an approved physician's
// name (cleanApprovalName); over 60 characters is refused, not cut.
const cleanDisplayName = (v: string): string => (cleanApprovalName(v.slice(0, 200)) || "")
const pgMessage = (e: any): string => String(e?.response?.data?.message || e?.message || "")

app.post("/dashboard/api/users/invites", express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
  const s = usersOwner(req, res, true)
  if (!s) return
  const token = crypto.randomBytes(16).toString("base64url")
  try {
    const r = await callServiceRpc("dashboard_invite_create", { p_actor: s.sub, p_token_hash: sha256Hex(token) })
    const qr = qrDataUri(ADMIN_BASE_URL.replace(/[/]$/, "") + "/dashboard/join?i=" + token)
    await audit(req, s, "user.invite", { invite: String(r.id).slice(0, 8) })
    res.json({ id: r.id, expiresAt: r.expires_at, qr })
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    if (/rate_limited/.test(pgMessage(e))) {
      return res.status(429).json({ error: "rate_limited", message: "สร้าง QR บ่อยเกินไป ลองใหม่ในอีกสักครู่" })
    }
    console.error("[dashboard] invite create failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// Polled every 2 s by the open QR dialog (not logged).
app.get("/dashboard/api/users/invites/:id", async (req: Request, res: Response) => {
  const s = usersOwner(req, res)
  if (!s) return
  const id = String(req.params.id)
  if (!UUID_RE.test(id)) return res.status(404).json({ error: "not found" })
  try {
    const r = await axios.get(SUPABASE_URL + "/rest/v1/dashboard_invites?select=" + INVITE_COLS + "&id=eq." + id +
      "&created_by=eq." + s.sub, { headers: SERVICE_HEADERS(), timeout: 5000 })
    if (!r.data.length) return res.status(404).json({ error: "not found" })
    res.json(inviteView(r.data[0]))
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    console.error("[dashboard] invite read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// The LINE ID approved is the one on the invite row (verified by LINE at the
// scan); any ID in the body is ignored.
app.post("/dashboard/api/users/invites/:id/approve", express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
  const s = usersOwner(req, res, true)
  if (!s) return
  const id = String(req.params.id)
  if (!UUID_RE.test(id)) return res.status(404).json({ error: "not found" })
  const code = String(req.body?.code ?? "")
  const perms = normalizePerms(req.body?.perms)
  const displayName = typeof req.body?.displayName === "string" ? cleanDisplayName(req.body.displayName) : ""
  if (!/^[0-9]{4}$/.test(code) || !perms || displayName.length < 1 || displayName.length > 60) {
    return res.status(400).json({ error: "bad request" })
  }
  try {
    const r = await callServiceRpc("dashboard_invite_decide", {
      p_actor: s.sub, p_id: id, p_decision: "approve", p_code: code, p_perms: perms, p_display_name: displayName,
    })
    const invite = id.slice(0, 8)
    if (r.result === "bad_code" || r.result === "locked") {
      const tries = 3 - Number(r.tries_left || 0)
      await Promise.all([
        audit(req, s, "user.bad_code", { invite, tries }),
        r.result === "locked" ? tg.sendTelegram("[P4P] กรอกรหัสยืนยันผิด 3 ครั้ง — ยกเลิกคำขอแล้ว") : null,
      ])
      return res.status(r.result === "locked" ? 409 : 400).json({ error: r.result, triesLeft: Number(r.tries_left || 0) })
    }
    if (r.result !== "ok") return res.status(409).json({ error: r.result || "not_pending" })
    dashUsers.triedAt = 0
    await loadDashUsers(true)
    const after = r.after || {}
    await Promise.all([
      audit(req, s, "user.approve", { invite, sub: after.line_user_id, name: after.display_name, line_name: after.line_name, perms: after.perms }),
      tg.sendTelegram("[P4P] เพิ่มผู้ใช้แดชบอร์ด: " + after.display_name + " โดย " + s.name + " — สิทธิ์: " + permsSummary(after.perms, ", ")),
    ])
    res.json({ ok: true, user: { displayName: after.display_name, perms: after.perms } })
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    console.error("[dashboard] invite approve failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

app.post("/dashboard/api/users/invites/:id/reject", express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
  const s = usersOwner(req, res, true)
  if (!s) return
  const id = String(req.params.id)
  if (!UUID_RE.test(id)) return res.status(404).json({ error: "not found" })
  try {
    const r = await callServiceRpc("dashboard_invite_decide", {
      p_actor: s.sub, p_id: id, p_decision: "reject", p_code: null, p_perms: null, p_display_name: null,
    })
    if (r.result !== "ok") return res.status(409).json({ error: r.result || "not_pending" })
    await Promise.all([
      audit(req, s, "user.reject", { invite: id.slice(0, 8), sub: r.sub, name: r.name }),
      tg.sendTelegram("[P4P] ปฏิเสธคำขอของ " + (r.name || "")),
    ])
    res.json({ ok: true })
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    console.error("[dashboard] invite reject failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// The dialog closed before anyone scanned (sent with keepalive).
app.post("/dashboard/api/users/invites/:id/cancel", express.json({ limit: "1kb" }), async (req: Request, res: Response) => {
  const s = usersOwner(req, res, true)
  if (!s) return
  const id = String(req.params.id)
  if (!UUID_RE.test(id)) return res.status(404).json({ error: "not found" })
  try {
    const r = await callServiceRpc("dashboard_invite_cancel", { p_actor: s.sub, p_id: id })
    if (r && r.cancelled) await audit(req, s, "user.cancel", { invite: id.slice(0, 8), reason: "closed" })
    res.json({ ok: true, cancelled: !!(r && r.cancelled) })
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    console.error("[dashboard] invite cancel failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// ผู้ใช้งานและสิทธิ์: the users and the scans waiting for approval.
app.get("/dashboard/api/users", async (req: Request, res: Response) => {
  const s = usersOwner(req, res)
  if (!s) return
  try {
    const [users, pending] = await Promise.all([
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_users?select=line_user_id,line_name,display_name,perms,active,source,added_at,suspended_at" +
        "&order=added_at.asc", { headers: SERVICE_HEADERS(), timeout: 8000 }),
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_invites?select=" + INVITE_COLS + "&status=eq.scanned&created_by=eq." + s.sub +
        "&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&order=claimed_at.asc&limit=50",
      { headers: SERVICE_HEADERS(), timeout: 8000 }),
    ])
    res.json({
      installed: true,
      owner: { name: s.name },
      users: (users.data as Record<string, any>[]).map((u) => ({
        id: u.line_user_id, lineName: u.line_name || "", displayName: u.display_name, perms: normalizePerms(u.perms) || [],
        active: u.active === true, source: u.source, addedAt: u.added_at, suspendedAt: u.suspended_at || null,
      })),
      pending: (pending.data as InviteRow[]).map(inviteView),
    })
  } catch (e: any) {
    if (isNotInstalledError(e)) return res.json({ installed: false, owner: { name: s.name }, users: [], pending: [] })
    console.error("[dashboard] users read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// Edit one user's rights or shown name, suspend or re-enable them. Never
// the owner, who has no row.
app.patch("/dashboard/api/users/:sub", express.json({ limit: "2kb" }), async (req: Request, res: Response) => {
  const s = usersOwner(req, res, true)
  if (!s) return
  const sub = String(req.params.sub)
  if (!/^U[0-9a-f]{32}$/.test(sub) || isDashOwner(sub)) return res.status(404).json({ error: "not found" })
  const perms = normalizePerms(req.body?.perms)
  const displayName = typeof req.body?.displayName === "string" ? cleanDisplayName(req.body.displayName) : ""
  const active = req.body?.active
  if (!perms || displayName.length < 1 || displayName.length > 60 || typeof active !== "boolean") {
    return res.status(400).json({ error: "bad request" })
  }
  try {
    const r = await callServiceRpc("dashboard_user_save", {
      p_actor: s.sub, p_sub: sub, p_perms: perms, p_display_name: displayName, p_active: active,
    })
    dashUsers.triedAt = 0
    await loadDashUsers(true)
    const before = r.before || {}
    const after = r.after || {}
    const suspended = before.active === true && after.active === false
    await Promise.all([
      suspended
        ? audit(req, s, "user.suspend", { sub, name: after.display_name })
        : audit(req, s, "user.edit", {
          sub, name: after.display_name,
          before: { displayName: before.display_name, perms: before.perms, active: before.active },
          after: { displayName: after.display_name, perms: after.perms, active: after.active },
        }),
      tg.sendTelegram(suspended ? "[P4P] ระงับผู้ใช้ " + after.display_name
        : "[P4P] แก้ไขสิทธิ์ " + after.display_name + ": " + (after.active ? permsSummary(after.perms, ", ") : "ระงับแล้ว")),
    ])
    res.json({ ok: true, user: { id: sub, displayName: after.display_name, perms: normalizePerms(after.perms) || [], active: after.active === true } })
  } catch (e: any) {
    if (isNotInstalledError(e)) return usersNotInstalled(res)
    if (/not_found/.test(pgMessage(e))) return res.status(404).json({ error: "not found" })
    if (/too_many/.test(pgMessage(e))) return res.status(409).json({ error: "too_many" })
    console.error("[dashboard] user save failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed" })
  }
})

// Excel submission status for the six months before the current one
// (Bangkok time; the current month is still open, so it is left out), one
// entry per month, newest first. A month with no roster table yet comes back
// with exists: false rather than being left out, so the grid always has six
// cards. The ตามส่ง tab filters this same list on the client.
// ?view=overview|followup marks a tab the user opened (logged); without it
// the call is a background refresh (not logged).
app.get("/dashboard/api/overview", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  const view = req.query.view
  const logged = view === "overview" || view === "followup" ? audit(req, s, "view." + view) : Promise.resolve()
  try {
    const bkk = new Date(Date.now() + 7 * 3600 * 1000)
    const now = bkk.getUTCFullYear() * 12 + bkk.getUTCMonth()
    const recent = [1, 2, 3, 4, 5, 6].map((back) => [(now - back) % 12, Math.floor((now - back) / 12) + 543])
    const tables: string[] = (await callServiceRpc("admin_list_roster_tables")) || []
    const months = await Promise.all(recent.map(async ([m, year]) => {
      const key = year + "_" + String(m + 1).padStart(2, "0")
      const base = { key, name: month_array[m] + " " + year, color: color_array[m][1] }
      if (!tables.includes(key)) return { ...base, exists: false, total: 0, sent: 0, lastSubmittedAt: null }
      const r = await axios.get(
        SUPABASE_URL + "/rest/v1/" + encodeURIComponent(key) + "?select=submitted_at",
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 },
      )
      const stamps = (r.data as { submitted_at: string | null }[]).map((row) => row.submitted_at).filter(Boolean) as string[]
      return {
        ...base,
        exists: true,
        total: r.data.length,
        sent: stamps.length,
        lastSubmittedAt: stamps.length ? stamps.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null,
      }
    }))
    await logged
    // The owner (admin) also gets each month's budget and N (review_inputs),
    // for the งบ button on the month cards. Others get none, and no button
    // (Pong, 2026-11-17: the ผู้จัดทำ no longer types them).
    const canBudget = isDashOwner(s.sub)
    const budgets: Record<string, unknown> = {}
    if (canBudget) {
      try {
        const keys = months.map((m) => m.key).join(",")
        const r = await axios.get(
          SUPABASE_URL + "/rest/v1/review_inputs?select=month,budget,per_p4p,doctors,updated_at,updated_by&month=in.(" + keys + ")",
          { headers: SERVICE_HEADERS(), timeout: 8000 },
        )
        for (const row of r.data as { month: string; budget: string; per_p4p: string; doctors: number | null; updated_at: string; updated_by: string }[]) {
          budgets[row.month] = { budget: Number(row.budget), per_p4p: Number(row.per_p4p), doctors: row.doctors, updated_at: row.updated_at, updated_by: row.updated_by }
        }
      } catch (e: any) {
        // Not installed yet, or Supabase busy: the cards show no budget.
        console.error("[dashboard] overview budgets failed:", e.response ? JSON.stringify(e.response.data) : e.message)
      }
    }
    res.json({ months: canBudget ? months.map((m) => ({ ...m, budget: budgets[m.key] ?? null })) : months, canBudget })
  } catch (e: any) {
    console.error("[dashboard] overview failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load overview" })
  }
})

// ── ตามส่ง (follow-up) log ────────────────────────────────────────────────
// Physicians who have not sent a month's file, and the phone calls / LINE
// messages the admins have logged for each (table dashboard_followups,
// scripts/dashboard-followups-2026-10.sql). Service key only, behind the
// dashboard session; the month must be an existing roster table.
const SERVICE_HEADERS = () => ({ apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY })
const FOLLOWUP_CHANNELS = ["phone", "line"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function rosterMonthExists(key: unknown): Promise<boolean> {
  if (typeof key !== "string" || !/^\d{4}_\d{2}$/.test(key)) return false
  const tables: string[] = (await callServiceRpc("admin_list_roster_tables")) || []
  return tables.includes(key)
}

// Thai dictionary order: Intl's "th" collation skips leading vowels
// (เ แ โ ใ ไ), so ไก่ sorts under ก and before ขวัญ.
const thaiCollator = new Intl.Collator("th")

// First and last name only; the dashboard leaves out the นพ./พญ. prefix.
const rosterName = (r: { firstname?: string | null; lastname?: string | null }): string =>
  [r.firstname || "", r.lastname || ""].join(" ").trim()

// &refresh=1 marks the page's own reload after a change (not logged).
app.get("/dashboard/api/pending", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  const month = req.query.month
  try {
    if (!(await rosterMonthExists(month))) return res.status(404).json({ error: "unknown month" })
    const [roster, logs] = await Promise.all([
      axios.get(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(month as string) +
        "?select=index,firstname,lastname,department&submitted_at=is.null",
        { headers: SERVICE_HEADERS(), timeout: 8000 }),
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_followups?select=roster_index,channel,created_at&month_key=eq." +
        encodeURIComponent(month as string) + "&order=created_at.asc",
        { headers: SERVICE_HEADERS(), timeout: 8000 }),
    ])
    const counts = new Map<string, { phone: number; line: number; last: string | null }>()
    for (const l of logs.data as { roster_index: string; channel: "phone" | "line"; created_at: string }[]) {
      const c = counts.get(l.roster_index) || { phone: 0, line: 0, last: null }
      c[l.channel]++
      c.last = l.created_at
      counts.set(l.roster_index, c)
    }
    // Sorted by first name, then last name; the prefix (นพ./พญ.) is ignored.
    const rows = (roster.data as any[]).slice().sort((a, b) =>
      thaiCollator.compare(a.firstname || "", b.firstname || "") || thaiCollator.compare(a.lastname || "", b.lastname || ""))
    const physicians = rows.map((r) => {
      const c = counts.get(r.index) || { phone: 0, line: 0, last: null }
      return { index: r.index, name: rosterName(r), department: r.department || "", phone: c.phone, line: c.line, lastContactAt: c.last }
    })
    if (req.query.refresh !== "1") await audit(req, s, "pending.open", { month, unsent: physicians.length })
    res.json({ physicians })
  } catch (e: any) {
    console.error("[dashboard] pending failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load pending list" })
  }
})

app.get("/dashboard/api/followups", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!dashRight(s, "followup.view", res)) return
  const { month, index, channel } = req.query
  if (typeof month !== "string" || !/^\d{4}_\d{2}$/.test(month) || typeof index !== "string" || !UUID_RE.test(index) ||
      typeof channel !== "string" || !FOLLOWUP_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: "bad request" })
  }
  try {
    const [r, who] = await Promise.all([
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_followups?select=id,note,logged_by,created_at" +
        "&month_key=eq." + month + "&roster_index=eq." + index + "&channel=eq." + channel + "&order=created_at.asc",
        { headers: SERVICE_HEADERS(), timeout: 8000 }),
      // Only for the log entry's name; not needed for the page's own reloads.
      req.query.refresh === "1" ? null : axios.get(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(month) +
        "?select=firstname,lastname&index=eq." + index, { headers: SERVICE_HEADERS(), timeout: 8000 }).catch(() => null),
    ])
    if (req.query.refresh !== "1") {
      await audit(req, s, "followup.history",
        { month, index, physician: who?.data?.[0] ? rosterName(who.data[0]) : "", channel, entries: r.data.length })
    }
    res.json({ entries: r.data })
  } catch (e: any) {
    console.error("[dashboard] followups failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load follow-ups" })
  }
})

app.post("/dashboard/api/followups", express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!dashRight(s, "followup.edit", res)) return
  const { month, index, channel } = req.body || {}
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : ""
  if (typeof index !== "string" || !UUID_RE.test(index) || typeof channel !== "string" || !FOLLOWUP_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: "bad request" })
  }
  try {
    if (!(await rosterMonthExists(month))) return res.status(404).json({ error: "unknown month" })
    // The physician must be on that month's roster; the name is snapshotted from it.
    const row = await axios.get(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(month) +
      "?select=firstname,lastname&index=eq." + index, { headers: SERVICE_HEADERS(), timeout: 8000 })
    if (!row.data.length) return res.status(404).json({ error: "unknown physician" })
    const ins = await axios.post(SUPABASE_URL + "/rest/v1/dashboard_followups",
      { month_key: month, roster_index: index, physician_name: rosterName(row.data[0]), channel, note, logged_by: s.name },
      { headers: { ...SERVICE_HEADERS(), "Content-Type": "application/json", Prefer: "return=representation" }, timeout: 8000 })
    const e = ins.data[0]
    await audit(req, s, "followup.add", { id: e.id, month, index, physician: e.physician_name, channel, note: e.note })
    res.json({ entry: { id: e.id, note: e.note, logged_by: e.logged_by, created_at: e.created_at } })
  } catch (e: any) {
    console.error("[dashboard] followup insert failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to save follow-up" })
  }
})

app.delete("/dashboard/api/followups/:id", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!dashRight(s, "followup.edit", res)) return
  const id = String(req.params.id)
  if (!/^[1-9][0-9]{0,17}$/.test(id)) return res.status(400).json({ error: "bad request" })
  try {
    const del = await axios.delete(SUPABASE_URL + "/rest/v1/dashboard_followups?id=eq." + id,
      { headers: { ...SERVICE_HEADERS(), Prefer: "return=representation" }, timeout: 8000 })
    if (!del.data.length) return res.status(404).json({ error: "not found" })
    console.log("[dashboard] followup", id, "deleted by", s.name)
    const d = del.data[0]
    // The whole row, so the log still shows what was removed.
    await audit(req, s, "followup.delete", {
      id: d.id, month: d.month_key, index: d.roster_index, physician: d.physician_name, channel: d.channel,
      note: d.note, logged_by: d.logged_by, logged_at: d.created_at,
    })
    res.json({ ok: true })
  } catch (e: any) {
    console.error("[dashboard] followup delete failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to delete follow-up" })
  }
})

// The audit log itself, owners only (404 for everyone else, so the route
// does not advertise itself). Newest first, 50 a page; ?before=<id> pages
// back. Filters: actor (LINE userId), group (one of AUDIT_GROUPS), from/to
// (YYYY-MM-DD, Bangkok days, inclusive).
const AUDIT_GROUPS: Record<string, string> = {
  login: "action=like.login.*",
  session: "action=like.session.*",
  view: "action=in.(view.overview,view.followup,view.roster,view.review,view.staffing,pending.open,followup.history,audit.view,review.download)",
  change: "action=in.(followup.add,followup.delete,roster.add,roster.edit,roster.delete,access.approve,access.reject," +
    "budget.save,review.inputs,review.rebuild,review.upload,review.submit,review.withdraw,review.decide,review.reply," +
    "review.return,review.unreturn,review.approve,review.issue,review.issue_reply,review.issue_open,review.issue_close," +
    "review.pdf_retry,review.reopen,review.email,review.email_mode,review.approve_all,staffing.save," +
    "user.approve,user.reject,user.edit,user.suspend,user.import)",
  refused: "action=in.(login.refused,user.claim_refused,user.bad_code)",
  users: "action=like.user.*",
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
app.get("/dashboard/api/audit", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  const { before, actor, group, from, to } = req.query
  const filters: string[] = []
  if (typeof before === "string" && /^[1-9][0-9]{0,17}$/.test(before)) filters.push("id=lt." + before)
  if (typeof actor === "string" && /^U[0-9a-f]{32}$/.test(actor)) filters.push("actor_line_id=eq." + actor)
  if (typeof group === "string" && AUDIT_GROUPS[group]) filters.push(AUDIT_GROUPS[group])
  if (typeof from === "string" && DATE_RE.test(from)) filters.push("created_at=gte." + from + "T00:00:00%2B07:00")
  if (typeof to === "string" && DATE_RE.test(to)) {
    const next = new Date(Date.parse(to + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)
    filters.push("created_at=lt." + next + "T00:00:00%2B07:00")
  }
  // Paging back is part of the same look, so only the first page is logged.
  const logged = typeof before === "string" ? Promise.resolve()
    : audit(req, s, "audit.view", { actor: actor || "", group: group || "", from: from || "", to: to || "" })
  try {
    const [r, people] = await Promise.all([
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_audit_log?select=id,created_at,actor_line_id,actor_name,action,target,ip,user_agent" +
        (filters.length ? "&" + filters.join("&") : "") + "&order=id.desc&limit=51",
        { headers: SERVICE_HEADERS(), timeout: 8000 }),
      // Everyone who has signed in or tried to, for the person filter.
      axios.get(SUPABASE_URL + "/rest/v1/dashboard_audit_log?select=actor_line_id,actor_name" +
        "&action=in.(login.success,login.refused,user.claim)&order=id.desc&limit=500",
        { headers: SERVICE_HEADERS(), timeout: 8000 }),
    ])
    await logged
    const actors = new Map<string, string>()
    for (const p of people.data as { actor_line_id: string; actor_name: string }[]) {
      if (p.actor_line_id && !actors.has(p.actor_line_id)) actors.set(p.actor_line_id, shownActor(p.actor_line_id, p.actor_name))
    }
    res.json({
      entries: r.data.slice(0, 50).map((e: { actor_line_id: string; actor_name: string }) =>
        ({ ...e, actor_name: shownActor(e.actor_line_id, e.actor_name) })),
      more: r.data.length > 50,
      actors: Array.from(actors, ([id, name]) => ({ id, name })),
    })
  } catch (e: any) {
    console.error("[dashboard] audit read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load audit log" })
  }
})

// ── รายชื่อ tab: the /admin/ roster editor ─────────────────────────────────
// Every dashboard user may read it (Pong, 2026-11-18: กานดา gets the tab
// "but disable edit / delete"); adding, editing, deleting and the access
// requests stay with the owner (Pong), and anyone else gets 404 there.
// Same reads and writes as the /admin/ routes below (service key, the month
// must be a live roster table, the body is filtered to real non-PK columns),
// behind the dashboard session instead of the /admin/ cookie. Every write is
// in the audit log with what changed.
const dashRosterTable = async (req: Request, res: Response): Promise<string | null> => {
  const table = String(req.params.table || "")
  if (!/^\d{4}_\d{2}$/.test(table)) { res.status(404).json({ error: "unknown table" }); return null }
  try {
    await assertRosterTable(table)
    return table
  } catch (e: any) {
    if (e.status === 404) { res.status(404).json({ error: "unknown table" }); return null }
    throw e
  }
}
const WRITE_HEADERS = () => ({ ...SERVICE_HEADERS(), "Content-Type": "application/json", Prefer: "return=representation" })
const rosterFullName = (r: Record<string, any>): string =>
  (((r.prefix || "") + (r.firstname || "")).trim() + " " + (r.lastname || "")).trim().replace(/\s+/g, " ")

app.get("/dashboard/api/roster", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!dashRight(s, "roster.view", res)) return
  try {
    const tables: string[] = (await callServiceRpc("admin_list_roster_tables")) || []
    res.json({ tables: tables.slice().sort().reverse() })
  } catch (e: any) {
    console.error("[dashboard] roster tables failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to list tables" })
  }
})

// &refresh=1 marks the page's own reload (not logged).
app.get("/dashboard/api/roster/:table", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!dashRight(s, "roster.view", res)) return
  try {
    const table = await dashRosterTable(req, res)
    if (!table) return
    const [columns, rows] = await Promise.all([
      callServiceRpc("admin_table_columns", { p_table: table }),
      axios.get(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(table) + "?select=*", { headers: SERVICE_HEADERS(), timeout: 8000 }),
    ])
    if (req.query.refresh !== "1") await audit(req, s, "view.roster", { month: table, rows: rows.data.length })
    res.json({ columns: columns || [], rows: rows.data })
  } catch (e: any) {
    console.error("[dashboard] roster read failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load roster" })
  }
})

app.post("/dashboard/api/roster/:table", express.json({ limit: "32kb" }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  try {
    const table = await dashRosterTable(req, res)
    if (!table) return
    const body = await filterToColumns(table, req.body)
    const r = await axios.post(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(table), body, { headers: WRITE_HEADERS(), timeout: 8000 })
    const row = (r.data && r.data[0]) || null
    if (row) await audit(req, s, "roster.add", { month: table, index: row.index, physician: rosterFullName(row), row })
    res.json({ row })
  } catch (e: any) {
    console.error("[dashboard] roster insert failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "insert failed") })
  }
})

app.patch("/dashboard/api/roster/:table/:index", express.json({ limit: "32kb" }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  const index = String(req.params.index)
  if (!UUID_RE.test(index)) return res.status(400).json({ error: "bad request" })
  try {
    const table = await dashRosterTable(req, res)
    if (!table) return
    const body = await filterToColumns(table, req.body)
    const url = SUPABASE_URL + "/rest/v1/" + encodeURIComponent(table) + "?index=eq." + index
    const before = await axios.get(url + "&select=*", { headers: SERVICE_HEADERS(), timeout: 8000 })
    if (!before.data.length) return res.status(404).json({ error: "not found" })
    if (!Object.keys(body).length) return res.json({ row: before.data[0] })
    const r = await axios.patch(url, body, { headers: WRITE_HEADERS(), timeout: 8000 })
    const row = (r.data && r.data[0]) || null
    // Only the fields that actually changed, as [before, after].
    const changes: Record<string, [unknown, unknown]> = {}
    for (const k of Object.keys(body)) {
      const was = before.data[0][k]
      const now = row ? row[k] : body[k]
      if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) changes[k] = [was ?? null, now ?? null]
    }
    if (Object.keys(changes).length) {
      await audit(req, s, "roster.edit", { month: table, index, physician: rosterFullName(row || before.data[0]), changes })
    }
    res.json({ row })
  } catch (e: any) {
    console.error("[dashboard] roster update failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "update failed") })
  }
})

app.delete("/dashboard/api/roster/:table/:index", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  const index = String(req.params.index)
  if (!UUID_RE.test(index)) return res.status(400).json({ error: "bad request" })
  try {
    const table = await dashRosterTable(req, res)
    if (!table) return
    const r = await axios.delete(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(table) + "?index=eq." + index,
      { headers: { ...SERVICE_HEADERS(), Prefer: "return=representation" }, timeout: 8000 })
    if (!r.data.length) return res.status(404).json({ error: "not found" })
    // The whole row, so the log still shows who was removed.
    await audit(req, s, "roster.delete", { month: table, index, physician: rosterFullName(r.data[0]), row: r.data[0] })
    res.json({ ok: true })
  } catch (e: any) {
    console.error("[dashboard] roster delete failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "delete failed" })
  }
})

// ── ตรวจสอบ tab: the month's SK03 check, owner only ─────────────────────────
// Routes live in lib/review-server.ts; tables and the private bucket come
// from scripts/review-tab-2026-11.sql (pasted by hand), and the tab says so
// until they exist.
;(require("./lib/review-server") as { mountReview(deps: Record<string, unknown>): void }).mountReview({
  app,
  express,
  axios,
  supabaseUrl: SUPABASE_URL,
  serviceHeaders: SERVICE_HEADERS,
  callServiceRpc,
  listRosterTables: async (): Promise<string[]> => (await callServiceRpc("admin_list_roster_tables")) || [],
  dashSession,
  isDashOwner,
  isReviewAuditee,
  audit,
})

// ── อัตรากำลัง tab: each department's staffing and multiplier ─────────────
// Routes live in lib/staffing-server.ts; every dashboard user reads, the
// owner edits. The table comes from scripts/dept-staffing-2026-11.sql
// (pasted by hand); until then the tab shows the 13-11-69 numbers.
;(require("./lib/staffing-server") as { mountStaffing(deps: Record<string, unknown>): void }).mountStaffing({
  app,
  express,
  axios,
  supabaseUrl: SUPABASE_URL,
  serviceHeaders: SERVICE_HEADERS,
  callServiceRpc,
  dashSession,
  isDashOwner,
  canView: (s: { sub: string; perms: string[] }) => can(s, "staffing.view"),
  audit,
})

app.get("/dashboard/api/access-requests", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  try {
    const r = await axios.get(SUPABASE_URL + "/rest/v1/access_requests?resolved=is.false&select=email,name,department,requested_at&order=requested_at.desc",
      { headers: SERVICE_HEADERS(), timeout: 8000 })
    res.json({ requests: r.data || [] })
  } catch (e: any) {
    console.error("[dashboard] access-requests failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load access requests" })
  }
})

app.post("/dashboard/api/access-requests/:email/:decision", express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store")
  const s = dashSession(req)
  if (!s) return res.status(401).json({ error: "not authenticated" })
  if (!isDashOwner(s.sub)) return res.status(404).json({ error: "not found" })
  const email = String(req.params.email || "").trim().toLowerCase()
  const decision = String(req.params.decision)
  if (!email || (decision !== "approve" && decision !== "reject")) return res.status(400).json({ error: "bad request" })
  try {
    const open = await axios.get(SUPABASE_URL + "/rest/v1/access_requests?resolved=is.false&select=name,department&email=eq." +
      encodeURIComponent(email), { headers: SERVICE_HEADERS(), timeout: 8000 })
    if (!open.data.length) return res.status(404).json({ error: "not found" })
    const opts = approveOptionsFrom(req.body)
    if (decision === "approve") await approveAccessRequest(email, opts)
    else await resolveAccessRequest(email)
    await audit(req, s, "access." + decision, {
      email, name: (decision === "approve" && opts.name) || open.data[0].name || "", department: open.data[0].department || "",
      ...(decision === "approve" && opts.name && opts.name !== open.data[0].name ? { requested_name: open.data[0].name || "" } : {}),
      ...(decision === "approve" && opts.sameNameConfirmed ? { same_name_confirmed: true } : {}),
    })
    res.json({ ok: true })
  } catch (e: any) {
    if (e.status === 409) return res.status(409).json({ error: "name_taken", name: e.name_taken })
    console.error("[dashboard] access-request " + decision + " failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: pgErrorMessage(e, decision + " failed") })
  }
})

// One-time login link from the LINE bot. Invalid/expired -> bounce to the
// page itself, which shows the "message the bot" instructions.
app.get("/admin/login", (req: Request, res: Response) => {
  const token = String(req.query.token || "")
  if (!verifyAdminToken("login", token)) return res.redirect(302, "/admin/?error=bad_token")
  setAdminCookie(res)
  res.redirect(302, "/admin/")
})

app.post("/admin/logout", (req: Request, res: Response) => { clearAdminCookie(res); res.json({ ok: true }) })

app.get("/admin/api/tables", requireAdmin, async (req: Request, res: Response) => {
  try {
    const tables = await callServiceRpc("admin_list_roster_tables")
    res.json({ tables: tables || [] })
  } catch (e: any) {
    console.error("[admin] list tables failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to list tables" })
  }
})

app.get("/admin/api/tables/:table/columns", requireAdmin, async (req: Request<{ table: string }>, res: Response) => {
  try {
    await assertRosterTable(req.params.table)
    const columns = await callServiceRpc("admin_table_columns", { p_table: req.params.table })
    res.json({ columns: columns || [] })
  } catch (e: any) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] columns failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load columns" })
  }
})

app.get("/admin/api/tables/:table/rows", requireAdmin, async (req: Request<{ table: string }>, res: Response) => {
  try {
    await assertRosterTable(req.params.table)
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table) + "?select=*&order=department,lastname",
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ rows: r.data })
  } catch (e: any) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] rows fetch failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load rows" })
  }
})

// Keeps only keys that are real, non-PK columns of the target table — the
// request body is client-controlled, so this is what stops an insert/update
// from writing to a column that doesn't exist (PostgREST would 400 anyway)
// or overwriting the `index` primary key.
async function filterToColumns(table: string, body: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const columns = await callServiceRpc("admin_table_columns", { p_table: table })
  const allowed = new Set((columns || []).filter((c: any) => !c.is_pk).map((c: any) => c.column_name))
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(body || {})) {
    if (allowed.has(k)) out[k] = (body as Record<string, unknown>)[k]
  }
  return out
}

app.post("/admin/api/tables/:table/rows", requireAdmin, express.json({ limit: "32kb" }), async (req: Request<{ table: string }>, res: Response) => {
  try {
    await assertRosterTable(req.params.table)
    const body = await filterToColumns(req.params.table, req.body)
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table),
      body,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        timeout: 8000,
      }
    )
    res.json({ row: (r.data && r.data[0]) || null })
  } catch (e: any) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] insert failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "insert failed") })
  }
})

app.patch("/admin/api/tables/:table/rows/:index", requireAdmin, express.json({ limit: "32kb" }), async (req: Request<{ table: string; index: string }>, res: Response) => {
  try {
    await assertRosterTable(req.params.table)
    const body = await filterToColumns(req.params.table, req.body)
    const r = await axios.patch(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table) + "?index=eq." + encodeURIComponent(req.params.index),
      body,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        timeout: 8000,
      }
    )
    res.json({ row: (r.data && r.data[0]) || null })
  } catch (e: any) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] update failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "update failed") })
  }
})

app.delete("/admin/api/tables/:table/rows/:index", requireAdmin, async (req: Request<{ table: string; index: string }>, res: Response) => {
  try {
    await assertRosterTable(req.params.table)
    await axios.delete(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table) + "?index=eq." + encodeURIComponent(req.params.index),
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ ok: true })
  } catch (e: any) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] delete failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "delete failed" })
  }
})

// ── Access requests ──────────────────────────────────────────────────────
// An email that isn't allow-listed yet (log_access_request(), called from
// /verify/) lands here for the admin to act on. Approving used to happen via
// a bearer token riding in a Telegram button's callback_data — replayable by
// anyone in that chat or holding the bot token, straight against Supabase,
// with no admin session involved at all (SECURITY_ANALYSIS.md §2c). This is
// the replacement: the admin's own authenticated dashboard, writing with the
// service_role key server-side, same posture as the roster CRUD routes above.
app.get("/admin/api/access-requests", requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/access_requests?resolved=is.false&select=*&order=requested_at.desc",
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ requests: r.data || [] })
  } catch (e: any) {
    console.error("[admin] access-requests list failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load access requests" })
  }
})

// The normalisation enqueue_p4p_upload and my_p4p_identity use to match a
// physicians.full_name to a roster row (lower case, runs of space as one).
function normalisePhysicianName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase()
}

// A name the admin typed in place of the request's own when approving:
// cleaned like log_access_request cleans a requested name (control, zero-width
// and bidi characters out, whitespace collapsed, capped at 100).
function cleanApprovalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const s = Array.from(raw, (ch) => {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return " "
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return ""
    return ch
  }).join("").replace(/\s+/g, " ").trim().slice(0, 100).trim()
  return s || null
}

interface ApproveOptions {
  // The admin's own spelling of the name, used instead of the request's.
  name?: string | null
  // The admin has seen that another physician already has this name and
  // says this is a different person with the same name.
  sameNameConfirmed?: boolean
}

// Shared by /admin/ and the dashboard's รายชื่อ tab. Returns the request's
// name (null when it had none) once the physician is allow-listed. Throws a
// 404 StatusError when the email has no open request, and a 409 (code
// "name_taken") when the name it would write already belongs to another
// physician and the admin has not confirmed it.
async function approveAccessRequest(email: string, opts: ApproveOptions = {}): Promise<{ name: string | null; department: string | null }> {
  const reqRow = await axios.get(
    SUPABASE_URL + "/rest/v1/access_requests?resolved=is.false&email=eq." + encodeURIComponent(email) + "&select=name,department",
    { headers: SERVICE_HEADERS(), timeout: 8000 }
  )
  if (!reqRow.data || !reqRow.data[0]) {
    const err = new Error("no open access request for " + email) as StatusError
    err.status = 404
    throw err
  }
  const name = cleanApprovalName(opts.name) || (reqRow.data[0].name && String(reqRow.data[0].name).trim()) || null
  const department = reqRow.data[0].department || null

  // The request's name is self-reported (log_access_request is open to
  // anon, so whoever asks first for an address sets the name on its
  // request), while physicians.full_name is what enqueue_p4p_upload and
  // my_p4p_identity match against the roster. So it may name a NEW
  // physician, but never replaces an existing one's: a tampered name on a
  // re-request would send that account's uploads to someone else's roster
  // row, and a request with no name would blank it. An existing row only has
  // a blank name filled. And a name another physician already has is not
  // written until the admin has looked (audit F13): either it was typed to
  // borrow that physician's roster row, or two physicians share a name, and
  // only the admin can tell which.
  //
  // department is left out entirely when the request never captured one (a
  // request logged before this field existed), so an existing row keeps the
  // department it has rather than being clobbered with null.
  const headers = { ...SERVICE_HEADERS(), "Content-Type": "application/json" }
  const byEmail = SUPABASE_URL + "/rest/v1/physicians?email=eq." + encodeURIComponent(email)
  const changes: Record<string, unknown> = { source: "directory", active: true, updated_at: new Date().toISOString() }
  if (department) changes.department = department
  const reactivate = (fillBlankName: boolean) => {
    const patch = { ...changes }
    if (fillBlankName && name) patch.full_name = name
    return axios.patch(byEmail, patch, { headers, timeout: 8000 })
  }

  const existing = await axios.get(byEmail + "&select=full_name", { headers: SERVICE_HEADERS(), timeout: 8000 })
  const writesName = Boolean(name) && !(existing.data && existing.data[0] && String(existing.data[0].full_name || "").trim())
  if (writesName && !opts.sameNameConfirmed) {
    const others = await axios.get(
      SUPABASE_URL + "/rest/v1/physicians?select=full_name&email=neq." + encodeURIComponent(email),
      { headers: SERVICE_HEADERS(), timeout: 8000 }
    )
    const wanted = normalisePhysicianName(name!)
    if ((others.data || []).some((p: { full_name?: string | null }) => p.full_name && normalisePhysicianName(p.full_name) === wanted)) {
      const err = new Error("another physician already has the name " + name) as StatusError & { code?: string; name_taken?: string }
      err.status = 409
      err.code = "name_taken"
      err.name_taken = name!
      throw err
    }
  }
  if (existing.data && existing.data[0]) {
    // e.g. a previously revoked physician re-requesting: re-activate the row.
    await reactivate(!String(existing.data[0].full_name || "").trim())
  } else {
    const insertBody: Record<string, unknown> = { email, ...changes }
    if (name) insertBody.full_name = name
    try {
      // A plain insert, not an upsert: a row that appears between the read
      // above and this write must not be merged over.
      await axios.post(SUPABASE_URL + "/rest/v1/physicians", insertBody, { headers, timeout: 8000 })
    } catch (e: any) {
      if (!(e.response && e.response.status === 409)) throw e
      // Lost that race: the row exists now, and its name is not ours to set.
      await reactivate(false)
    }
  }
  await resolveAccessRequest(email)
  return { name, department }
}

async function resolveAccessRequest(email: string): Promise<void> {
  await axios.patch(
    SUPABASE_URL + "/rest/v1/access_requests?email=eq." + encodeURIComponent(email),
    { resolved: true },
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" }, timeout: 8000 }
  )
}

// The approve routes' optional JSON body: { name, confirmSameName }.
function approveOptionsFrom(body: unknown): ApproveOptions {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  return { name: cleanApprovalName(b.name), sameNameConfirmed: b.confirmSameName === true }
}

app.post("/admin/api/access-requests/:email/approve", requireAdmin, express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
  const email = String(req.params.email || "").trim().toLowerCase()
  if (!email) return res.status(400).json({ error: "missing email" })
  try {
    await approveAccessRequest(email, approveOptionsFrom(req.body))
    res.json({ ok: true })
  } catch (e: any) {
    // Already resolved (or never requested): nothing to approve.
    if (e.status === 404) return res.status(404).json({ error: "no open request" })
    if (e.status === 409) return res.status(409).json({ error: "name_taken", name: e.name_taken })
    console.error("[admin] approve access-request failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: pgErrorMessage(e, "approve failed") })
  }
})

app.post("/admin/api/access-requests/:email/reject", requireAdmin, async (req: Request, res: Response) => {
  const email = String(req.params.email || "").trim().toLowerCase()
  if (!email) return res.status(400).json({ error: "missing email" })
  try {
    await resolveAccessRequest(email)
    res.json({ ok: true })
  } catch (e: any) {
    console.error("[admin] reject access-request failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "reject failed" })
  }
})

// ── /upload/ — submit a scorecard from the LINE rich menu ───────────────────
// See UPLOAD_VIA_LINE_DESIGN.md. The page itself is served by servePage()
// like every other gated page (it is in `gatedPages` above); the file bytes
// never pass through here — the browser PUTs them straight to Supabase
// Storage and calls enqueue_p4p_upload(). This one route is what makes the
// common case *instant*: it scores a confidence-gated subset of files
// synchronously (§7.7/§7.8) so the physician sees a number before the page
// closes, instead of waiting on a GitHub runner.
//
// It never calls Claude and never touches Drive — both stay in automation/'s
// hands, reached through the two claim functions. A file this route cannot
// confidently score is left `pending` for the worker, never guessed at.
const UPLOAD_BUCKET = "p4p-uploads"
// Same env var scripts/setup-richmenu.mts requires — the LIFF app whose
// endpoint is /upload/. Only used to build a "ส่งไฟล์อีกครั้ง" button; a
// missing value degrades that button to "ติดต่อผู้ดูแล", never a crash.
const UPLOAD_LIFF_URL = UPLOAD_LIFF_ID ? "https://liff.line.me/" + UPLOAD_LIFF_ID : ""

interface ReceiptModule {
  displayMonth(monthKey: string): string
  formatScore(score: number | string | null | undefined): string
  buildScoreReceipt(args: { displayName: string; department: string; monthKey: string; score: number | string; receivedAt: string; isLate: boolean }): unknown
  buildPendingBubble(args: { monthKey: string; queueId: string; ack: boolean }): unknown
  buildFailureBubble(args: { monthKey: string; errorType: string; detail: string; uploadLiffUrl: string }): unknown
}
interface TelegramModule {
  sendTelegram(text: unknown): Promise<boolean>
  formatResultMessage(result: Record<string, unknown>, filename: string | null | undefined, upload?: Record<string, unknown> | null): string
  formatErrorMessage(error: string | null | undefined, filename: string | null | undefined, upload?: Record<string, unknown> | null): string
}
interface ScoreExtractResult {
  score: number | null
  method: string
}
interface ParsedWorkbook {
  rows: Record<string, unknown>[]
  sheetName: string
  sheetCount: number
  matched: boolean
  singleSheet: boolean
}
interface ScoreModule {
  resolveBeMonth(filename?: string | null, subject?: string | null, body?: string | null): number | null
  resolveBeYear(filename?: string | null, subject?: string | null, body?: string | null): number | null
  resolveBeMonthFromRows(rows: Record<string, unknown>[]): number | null
  resolveFilenameMonth(filename?: string | null): number | null
  resolveFilenameYear(filename?: string | null): number | null
  resolveBeYearFromRows(rows: Record<string, unknown>[]): number | null
  resolveScore(rows: Record<string, unknown>[]): ScoreExtractResult
  isHighConfidence(method: string): boolean
  parseWorkbookRowsSafely(buffer: Buffer, opts?: Record<string, unknown>): Promise<ParsedWorkbook>
}

const receipt = require("./lib/line-receipt-flex") as ReceiptModule
// The admin's Telegram alert (§7.6). Vendored for the same reason the scorer
// is — see the file's own header — and a no-op when this deployment has no
// TELEGRAM_* variables, never a failed submission.
const tg = require("./lib/telegram-notify") as TelegramModule

function serviceHeaders(extra?: Record<string, string>): Record<string, string> {
  return Object.assign({
    apikey: SUPABASE_SERVICE_ROLE_KEY as string,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
  }, extra || {})
}

// The 5th of the month AFTER month_key, 23:59:59 Asia/Bangkok — the same
// instant web/lib/months.ts's deadlineISO() and enqueue_p4p_upload()'s own
// SQL compute. Punctuality is measured against `received_at` (when the
// physician handed the file over), never against processing time (§9).
function monthDeadlineMs(monthKey: string): number {
  const [beYear, month] = String(monthKey || "").split("_").map(Number)
  if (!beYear || !month) return NaN
  // month is 1-based, so passing it as a 0-based index already means "the
  // following month"; December rolls into the next year on its own.
  return Date.UTC(beYear - 543, month, 5, 16, 59, 59)
}
function isLateUpload(monthKey: string, receivedAt: string): boolean {
  const deadline = monthDeadlineMs(monthKey)
  const received = new Date(receivedAt).getTime()
  if (isNaN(deadline) || isNaN(received)) return false
  return received > deadline
}

interface QueueRow {
  id: string
  email: string
  status: string
  filename: string | null
  month_key: string
  object_path: string
  full_name: string
  department: string | null
  roster_index: number | null
  received_at: string
  line_user_id?: string | null
  error_type?: string | null
  error_detail?: string | null
  score?: number | null
}

async function fetchQueueRow(filter: string): Promise<QueueRow | null> {
  const r = await axios.get(
    SUPABASE_URL + "/rest/v1/p4p_upload_queue?" + filter + "&select=*",
    { headers: serviceHeaders(), timeout: 8000 }
  )
  return (r.data && r.data[0]) || null
}

// `extraFilter` exists for one reason: the worker and this route can both be
// looking at the same row. The claim query gives the browser a head start
// (§6.5's race guard), but a slow download or parse can outlast it, and by
// then claim_p4p_score_fallback() may have moved the row to 'processing'.
// Adding `&status=eq.pending` makes every write here a no-op in that case
// instead of flipping a row the worker is actively holding.
async function patchQueueRow(id: string, patch: Record<string, unknown>, extraFilter?: string): Promise<number> {
  const r = await axios.patch(
    SUPABASE_URL + "/rest/v1/p4p_upload_queue?id=eq." + encodeURIComponent(id) + (extraFilter || ""),
    patch,
    {
      headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      timeout: 8000,
    }
  )
  return Array.isArray(r.data) ? r.data.length : 0
}

app.post("/upload/score", express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
  // Deliberately just the id: every other fact this route needs is already
  // on the row enqueue_p4p_upload() built from the caller's own JWT. Taking
  // identity or month as a parameter here would reopen the hole every other
  // layer closes.
  const queueId = String((req.body && req.body.queue_id) || "")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queueId)) {
    return res.status(400).json({ error: "bad_request", detail: "queue_id must be a uuid" })
  }

  // Same gate as every physician page, but NOT servePage(): that answers a
  // failed check with a 302 to /verify/, which a fetch() follows
  // transparently — the page would get HTML back with a 200 and throw on
  // res.json(). A 401 with a JSON body lets the page decide.
  const { at, reason } = await resolveAccessToken(req, res)
  if (!at) return res.status(401).json({ error: "no_session", reason })
  // Everything below runs with the service role, so the caller's email must
  // come from Supabase Auth, not from the cookie's (unsigned) cached token.
  const caller = await verifiedUserEmail(at)
  if (caller.transient) {
    // Nothing can be checked while Supabase is unreachable. Touch nothing:
    // the row stays pending as enqueue left it, the worker scores it, and
    // the physician gets the result in chat.
    return res.json({ pending: true })
  }
  if (!caller.email) {
    clearSessionCookie(res)
    return res.status(401).json({ error: "no_session", reason: "invalid" })
  }
  const verdict = await checkAllowlist(at)
  if (verdict !== "allowed") {
    clearSessionCookie(res)
    return res.status(401).json(verdict === "blocked" ? { error: "blocked" } : { error: "no_session", reason: "invalid" })
  }
  const callerEmail = caller.email

  let row: QueueRow | null
  try {
    row = await fetchQueueRow("id=eq." + encodeURIComponent(queueId))
  } catch (e: any) {
    console.error("[upload] queue lookup failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "lookup_failed" })
  }
  if (!row) return res.status(404).json({ error: "not_found" })
  // The id is an opaque uuid the browser just received from its own enqueue
  // call, not a secret — THIS check is the access control, mirroring how
  // object_path ownership is checked at enqueue time. It holds only because
  // callerEmail came from Supabase Auth (verifiedUserEmail above).
  if (String(row.email).toLowerCase() !== callerEmail) {
    return res.status(403).json({ error: "forbidden" })
  }
  // A retry of an already-resolved request, or one the worker got to first.
  if (row.status !== "pending") return res.status(409).json({ error: "already_processed", status: row.status })

  const monthKey = row.month_key
  const monthNum = parseInt(String(monthKey).slice(5), 10)
  const beYear = parseInt(String(monthKey).slice(0, 4), 10)

  // The §7.6 context block. `rosterMatch` is always "exact" on this path:
  // reaching a Telegram from here means row.roster_index was non-null, which
  // enqueue_p4p_upload() only sets on an exact roster hit — anything fuzzy
  // was deferred to the worker, which sends its own.
  function tgContext(extra?: Record<string, unknown>): Record<string, unknown> {
    return Object.assign({
      source: "LINE upload",
      accountName: row!.full_name,
      email: row!.email,
      monthKey,
      rosterMatch: "exact",
    }, extra || {})
  }

  // Awaited, not fired and forgotten: the Vercel function can be frozen the
  // moment the response is written, and a promise still in flight then simply
  // never resolves. sendTelegram() swallows its own failures and caps itself
  // at 5 s, so the worst case is a slightly slower receipt.
  async function notifyAdmin(text: string): Promise<void> {
    await tg.sendTelegram(text)
  }

  // Reject (terminal, no retry on either claim function) — same shape as an
  // enqueue-time refusal: nothing here was ever eligible.
  async function reject(errorType: string, detail?: string, status?: number, tgExtra?: Record<string, unknown>) {
    try {
      await patchQueueRow(row!.id, {
        status: "rejected",
        error_type: errorType,
        error_detail: detail || null,
        finished_at: new Date().toISOString(),
      }, "&status=eq.pending")
    } catch (e: any) {
      console.error("[upload] reject patch failed:", e.message)
    }
    // No attempt counter: unlike the worker's failures, a rejection here is
    // terminal on the first try — there is nothing coming back.
    await notifyAdmin(tg.formatErrorMessage(
      detail || errorType,
      row!.filename,
      tgContext(Object.assign({ errorType }, tgExtra || {}))
    ))
    return res.status(status || 422).json({ error: errorType, detail: detail || "" })
  }

  // Defer to claim_p4p_score_fallback(): stamp the losing tier's method (it
  // is useful data in its own right, and it is what makes the row claimable
  // immediately instead of waiting out the claim query's 30s race guard) and
  // leave status='pending' exactly as enqueue left it.
  async function defer(method: string) {
    try {
      await patchQueueRow(row!.id, { score_method: method })
    } catch (e: any) {
      console.error("[upload] defer patch failed:", e.message)
    }
    return res.json({ pending: true })
  }

  let buffer: Buffer
  try {
    const objectUrl = SUPABASE_URL + "/storage/v1/object/" + UPLOAD_BUCKET + "/" +
      String(row.object_path).split("/").map(encodeURIComponent).join("/")
    const r = await axios.get(objectUrl, { headers: serviceHeaders(), responseType: "arraybuffer", timeout: 15000 })
    buffer = Buffer.from(r.data)
  } catch (e: any) {
    // Transient: leave the row pending, the worker will pick it up. The
    // physician sees "กำลังตรวจสอบ" rather than an error they can't act on.
    console.error("[upload] object download failed:", e.response ? e.response.status : e.message)
    return res.json({ pending: true })
  }

  // Everything from here runs behind the zip-entry/size guard and the parse
  // timeout (§7.7 rec 3, §11): the guard bounds memory, the timeout bounds
  // CPU, and a file that trips either is deferred or rejected rather than
  // left holding the request open against Vercel's execution limit.
  const score = require("./lib/p4p-score") as ScoreModule
  let rows: Record<string, unknown>[]
  let matched: boolean
  let singleSheet: boolean
  try {
    ({ rows, matched, singleSheet } = await score.parseWorkbookRowsSafely(buffer, {
      targetMonth: monthNum, targetYear: beYear, filename: row.filename, timeoutMs: 7000,
    }))
  } catch (e: any) {
    if (e.code === "PARSE_TIMEOUT") return defer("parse timeout (deferred to worker)")
    console.warn("[upload] parse failed (" + (e.code || "parse_error") + "): " + e.message)
    return reject("other", "ไม่สามารถอ่านไฟล์ได้ กรุณาตรวจสอบว่าไฟล์เปิดได้ใน Microsoft Excel และบันทึกเป็น .xlsx แล้วส่งใหม่อีกครั้ง")
  }

  // The same two corruption checks processBuffer() already runs.
  if (!rows || rows.length === 0) {
    return reject("other", "ไฟล์ไม่มีข้อมูล (0 แถว)")
  }
  const nonNullCount = rows.reduce((n, r) => n + Object.values(r).filter((v) => v !== null).length, 0)
  if (nonNullCount < 3) {
    return reject("other", "ไฟล์มีข้อมูลไม่ครบ (" + nonNullCount + " ช่อง)")
  }


  // Month cross-check — the one mistake this path can still make is a file
  // whose contents say July uploaded under June. Only a month or year that
  // actually resolved counts: an unstated month is not a mismatch.
  //
  // A workbook with exactly one sheet holding data skips the rows fallback
  // entirely (`singleSheet`): its sheet content isn't consulted for this
  // check either, for the same reason parseWorkbookRowsSafely ignores it for
  // `matched` — a lone sheet's tab/title text is routinely a leftover from
  // whatever month the physician last reused this file for.
  const inferredMonth = score.resolveFilenameMonth(row.filename) ||
    (singleSheet ? null : score.resolveBeMonthFromRows(rows))
  const inferredYear = score.resolveFilenameYear(row.filename) ||
    (singleSheet ? null : score.resolveBeYearFromRows(rows))
  if ((inferredMonth && inferredMonth !== monthNum) || (inferredYear && inferredYear !== beYear)) {
    const inferredKey = String(inferredYear || beYear) + "_" + String(inferredMonth || monthNum).padStart(2, "0")
    // monthInFile is what turns the alert's "⚠️ Month in file" line on — the
    // one disagreement this path can actually detect (§7.6).
    return reject("month_mismatch", "ไฟล์ระบุเดือน " + inferredKey + " แต่เลือกส่งเดือน " + monthKey,
      422, { monthInFile: inferredKey })
  }

  // Ordering matters: the check above fires when the file names a DIFFERENT
  // month, which is the more precise complaint. Reaching here means nothing
  // this route trusts named a month at all: for a multi-sheet workbook, no
  // tab/title row named the picked month; for a single-sheet one, the
  // filename itself didn't (its sheet content is never consulted — see
  // above). Without one there is nothing to check the chip against: the
  // file would be scored on the physician's word alone, and a wrong
  // attachment would look exactly like a right one.
  if (!matched) {
    return reject("month_not_found", "ไม่พบเดือน " + receipt.displayMonth(monthKey) + " ในไฟล์นี้")
  }

  const { score: value, method } = score.resolveScore(rows)

  // The confidence gate (§7.7 rec 1). Two conditions, not one: a confident
  // score is necessary but not sufficient — saveScore() throws outright on a
  // null roster index, and resolving that is matchName()'s job, in the
  // worker, by design.
  if (!score.isHighConfidence(method) || row.roster_index === null || row.roster_index === undefined) {
    return defer(method)
  }
  if (!(value !== null && value > 0)) {
    return reject("zero_score", "ไม่พบคะแนนรวมในไฟล์")
  }

  // The roster row is the canonical spelling of the name and department —
  // p4p_submissions is keyed on it, and so is the Drive filename the worker
  // will use later.
  let rosterRow: { index: number; prefix: string | null; firstname: string | null; lastname: string | null; department: string | null } | null = null
  try {
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(monthKey) +
        "?index=eq." + encodeURIComponent(String(row.roster_index)) + "&select=index,prefix,firstname,lastname,department",
      { headers: serviceHeaders(), timeout: 8000 }
    )
    rosterRow = (r.data && r.data[0]) || null
  } catch (e: any) {
    console.error("[upload] roster lookup failed:", e.response ? JSON.stringify(e.response.data) : e.message)
  }
  if (!rosterRow) return defer(method)

  const matchedName = [rosterRow.firstname, rosterRow.lastname].filter(Boolean).join(" ").trim()
  const department = rosterRow.department || row.department || ""
  const submittedAt = new Date(row.received_at).toISOString()

  try {
    // saveScore(): the score column on the month's roster row, through
    // save_p4p_score() (scripts/audit-fixes-2026-11.sql PART 5), the same
    // call the relay saves with: it writes only when no submission received
    // after this one already has its score saved, so an email the relay
    // saved a moment ago is never overwritten by this older upload.
    const rowUrl = SUPABASE_URL + "/rest/v1/" + encodeURIComponent(monthKey) + "?index=eq." + encodeURIComponent(String(row.roster_index))
    let written: boolean | null = null
    try {
      const r = await axios.post(
        SUPABASE_URL + "/rest/v1/rpc/save_p4p_score",
        { p_month_key: monthKey, p_index: String(row.roster_index), p_score: value, p_received_at: submittedAt },
        { headers: serviceHeaders({ "Content-Type": "application/json" }), timeout: 8000 }
      )
      if (r.data !== true && r.data !== false) throw new Error("save_p4p_score answered " + JSON.stringify(r.data))
      written = r.data
    } catch (e: any) {
      // PGRST202: the function is not installed yet; the plain update below
      // is what this route did before it.
      if (!(e.response && e.response.data && e.response.data.code === "PGRST202")) throw e
    }
    if (written === false) {
      // A newer submission is saved: the worker holds this one for the
      // admin and tells the physician, as it does for a retried older email.
      console.warn("[upload] a newer submission is already saved for queue row " + row.id + "; deferring")
      return defer(method)
    }
    if (written === null) {
      // `Prefer: return=representation` so a filter that matched nothing
      // surfaces here rather than being reported to the physician as saved.
      const saved = await axios.patch(
        rowUrl,
        { score: value },
        { headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }), timeout: 8000 }
      )
      if (!saved.data || saved.data.length === 0) throw new Error("no roster row matched index " + row.roster_index)
    }
    // submitted_at is what the ranking reads for punctuality, so it keeps the
    // EARLIEST submission — same rule as automation's saveScore(). A re-upload
    // of a month updates the score above but never moves an on-time
    // submission past the deadline; 0 rows here just means an earlier time
    // is already recorded.
    await axios.patch(
      rowUrl + "&or=" + encodeURIComponent("(submitted_at.is.null,submitted_at.gt.\"" + submittedAt + "\")"),
      { submitted_at: submittedAt },
      { headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }), timeout: 8000 }
    )
  } catch (e: any) {
    // Fall back to the queue rather than telling the physician a number that
    // was not written.
    console.error("[upload] saveScore failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return defer(method)
  }

  try {
    // logSubmission(): first submission's timestamp wins (ignore-duplicates),
    // so fixing a file never costs punctuality (§9).
    await axios.post(
      SUPABASE_URL + "/rest/v1/p4p_submissions?on_conflict=physician_name,work_month",
      {
        physician_name: matchedName,
        department: department || null,
        work_month: monthKey,
        submitted_at: submittedAt,
        thread_id: null,
        filename: row.filename || null,
      },
      { headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" }), timeout: 8000 }
    )
  } catch (e: any) {
    // Non-fatal, exactly as on the email path: the score is saved either way.
    console.warn("[upload] logSubmission skipped:", e.response ? JSON.stringify(e.response.data) : e.message)
  }

  try {
    const updated = await patchQueueRow(row.id, {
      status: "done",
      score: value,
      score_method: method,
      finished_at: new Date().toISOString(),
      archive_status: "archive_pending",
    }, "&status=eq.pending")
    if (updated === 0) {
      // The worker claimed it while this request was reading the file. The
      // score above is already written and is the same file's number either
      // way; the worker's own pass will close the row.
      console.warn("[upload] queue row " + row.id + " was claimed by the worker mid-request")
    }
  } catch (e: any) {
    // The score is already in the roster table; losing this write means the
    // worker re-scores the row later and writes the same number again.
    console.error("[upload] queue completion patch failed:", e.message)
  }

  const displayName = [rosterRow.prefix, matchedName].filter(Boolean).join(" ").trim()

  // The success half of §7.6. The worker sends nothing for a row that got
  // this far — drain-uploads' archive branch is silent by design — so if this
  // send is skipped the admin never hears about the common case at all.
  await notifyAdmin(tg.formatResultMessage(
    // `value.toFixed(2)`, not receipt.formatScore's grouped "1,842.50": the
    // worker's own success alert prints the ungrouped form, and the admin
    // reads both messages side by side.
    { matchedName, score: (value as number).toFixed(2), saved: true },
    row.filename,
    tgContext()
  ))

  res.json({
    score: Number((value as number).toFixed(2)),
    month_key: monthKey,
    is_late: isLateUpload(monthKey, row.received_at),
    display_date: receipt.displayMonth(monthKey),
    display_name: displayName,
    department,
    received_at: submittedAt,
  })
})

// ── /upload/receipt — did the chat receipt actually reach the chat? ─────────
// The receipt goes out through liff.sendMessages() in the physician's own
// browser, so without this route a failed send is invisible to everyone: the
// page swallows the error (it must never block a submission) and nothing
// server-side ever hears about it. The page reports the outcome here once per
// submission; a send that did not happen is stamped on the queue row and
// Telegrammed to the admin, who can then follow up by hand.
const RECEIPT_REASONS = new Set([
  "sent", "liff_init_failed", "not_in_client", "group_chat", "send_failed",
])

app.post("/upload/receipt", express.json({ limit: "4kb" }), async (req: Request, res: Response) => {
  const body = req.body || {}
  const queueId = String(body.queue_id || "")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queueId)) {
    return res.status(400).json({ error: "bad_request", detail: "queue_id must be a uuid" })
  }
  const reason = String(body.reason || "")
  if (!RECEIPT_REASONS.has(reason)) {
    return res.status(400).json({ error: "bad_request", detail: "unknown reason" })
  }
  // Browser-supplied and only ever shown to the admin — bounded, never trusted.
  const contextType = body.context_type ? String(body.context_type).slice(0, 40) : null
  const errorText = body.error ? String(body.error).slice(0, 500) : null

  // Same gate and ownership check as /upload/score, for the same reasons.
  const { at, reason: authReason } = await resolveAccessToken(req, res)
  if (!at) return res.status(401).json({ error: "no_session", reason: authReason })
  const caller = await verifiedUserEmail(at)
  // The page ignores this route's answer, so an outage just means no stamp
  // and no alert for this one receipt.
  if (caller.transient) return res.status(503).json({ error: "auth_unavailable" })
  if (!caller.email) {
    clearSessionCookie(res)
    return res.status(401).json({ error: "no_session", reason: "invalid" })
  }
  const verdict = await checkAllowlist(at)
  if (verdict !== "allowed") {
    clearSessionCookie(res)
    return res.status(401).json(verdict === "blocked" ? { error: "blocked" } : { error: "no_session", reason: "invalid" })
  }
  const callerEmail = caller.email

  let row: QueueRow | null
  try {
    row = await fetchQueueRow("id=eq." + encodeURIComponent(queueId))
  } catch (e: any) {
    console.error("[upload] receipt lookup failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "lookup_failed" })
  }
  if (!row) return res.status(404).json({ error: "not_found" })
  if (String(row.email).toLowerCase() !== callerEmail) {
    return res.status(403).json({ error: "forbidden" })
  }

  const sent = reason === "sent"
  try {
    await patchQueueRow(row.id, {
      receipt_status: reason,
      receipt_context: contextType,
      receipt_error: errorText,
      receipt_reported_at: new Date().toISOString(),
    })
  } catch (e: any) {
    // Diagnostics only — the Telegram below still carries the facts.
    console.error("[upload] receipt patch failed:", e.response ? JSON.stringify(e.response.data) : e.message)
  }

  if (!sent) {
    console.warn("[upload] chat receipt not delivered for " + row.id + ": " + reason +
      (contextType ? " (context " + contextType + ")" : "") + (errorText ? " — " + errorText : ""))
    await tg.sendTelegram(
      "⚠️ ส่งใบยืนยันเข้าแชท LINE ไม่สำเร็จ\n" +
      "แพทย์: " + row.full_name + "\n" +
      "เดือน: " + receipt.displayMonth(row.month_key) + "\n" +
      "ไฟล์: " + (row.filename || "-") + "\n" +
      "สาเหตุ: " + reason +
      (contextType ? "\nเปิดจาก: " + contextType : "") +
      (errorText ? "\nข้อผิดพลาด: " + errorText : "")
    )
  }
  res.json({ ok: true })
})

app.use("/status", express.static("status"))
app.use("/list", express.static("list"))
app.use("/ranking", express.static("ranking"))
app.use("/verify", express.static("verify"))
app.use("/admin", express.static("admin"))
// Scripts only: the two pages are served by the routes above, which gate
// /dashboard/ on a session; the raw .html files must not bypass that.
app.use("/dashboard", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.endsWith(".html")) return res.status(404).end()
  next()
}, express.static("dashboard", { index: false }))
app.use("/assets", express.static("assets"))
app.use("/upload", express.static("upload"))
// /lib holds the one browser-loadable module that main.js also require()s
// (lib/line-receipt-flex.js — see its header). Nothing here is gated: it is
// the same Flex-building code the bot itself sends, with no data in it.
app.use("/lib", express.static("lib"))

app.post("/line", line.middleware(config), (req: Request, res: Response) => {
  Promise
    .all((req.body.events as LineWebhookEvent[]).map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err)
      res.status(500).end()
    })
})

// The chat-side answer for one queue row, whatever state it is in (§7.5
// step ④). A missing row is answered too — "nothing here yet" is a real
// answer to a tap, and silence looks like a broken button.
function buildUploadResultMessage(row: QueueRow | null): unknown {
  if (!row) return { type: "text", text: "ยังไม่พบไฟล์ที่ส่งเข้ามาในระบบ" }
  if (row.status === "done") {
    return receipt.buildScoreReceipt({
      displayName: row.full_name,
      department: row.department || "",
      monthKey: row.month_key,
      score: row.score ?? 0,
      receivedAt: row.received_at,
      isLate: isLateUpload(row.month_key, row.received_at),
    })
  }
  if (row.status === "failed" || row.status === "rejected") {
    return receipt.buildFailureBubble({
      monthKey: row.month_key,
      errorType: row.error_type || "other",
      detail: row.error_detail || "",
      uploadLiffUrl: UPLOAD_LIFF_URL,
    })
  }
  return receipt.buildPendingBubble({ monthKey: row.month_key, queueId: row.id, ack: false })
}

interface LineWebhookEvent {
  type: string
  replyToken?: string
  postback?: { data?: string }
  message?: { type: string; text?: string }
  source: { userId?: string }
}

// The line the upload page sends as the physician to earn a free reply (§7.5
// step ②). It is not something they typed, and the upload's own result alert
// already reaches Telegram, so it is not forwarded.
const UPLOAD_TRIGGER_PREFIX = "ส่งไฟล์ p4p"

// The sender's LINE display name, or "" when LINE will not give it (the user
// blocked the bot, a network error, a timeout). Never throws.
async function lineDisplayName(userId: string): Promise<string> {
  try {
    const r = await axios.get("https://api.line.me/v2/bot/profile/" + encodeURIComponent(userId), {
      headers: headers,
      timeout: 5000,
    })
    return String((r.data && r.data.displayName) || "").trim()
  } catch (e: any) {
    console.warn("[line] profile lookup failed: " + (e.response ? "HTTP " + e.response.status : e.message))
    return ""
  }
}

// Pong asked (2026-11-10) for every text a user types to the bot to show up
// in the Telegram admin chat as two plain messages: the display name, then
// the LINE userId. Only who wrote, never what they wrote. Sent one after the
// other so the name always lands above its id. sendTelegram() swallows its
// own failures, so this never breaks the reply.
async function forwardTextSender(event: LineWebhookEvent): Promise<void> {
  const userId = event.source.userId
  if (!userId) return
  const name = await lineDisplayName(userId)
  await tg.sendTelegram(name || "(ไม่ทราบชื่อ LINE)")
  await tg.sendTelegram(userId)
}

function isForwardedText(event: LineWebhookEvent): boolean {
  if (event.type !== "message" || !event.message || event.message.type !== "text") return false
  const text = (event.message.text || "").trim().toLowerCase()
  return !text.startsWith(UPLOAD_TRIGGER_PREFIX)
}

// Runs the forward alongside the normal reply and waits for both: on Vercel
// the function can be frozen once the response is sent, so a fire-and-forget
// alert could be lost. The reply itself is not held back by Telegram.
const handleEvent = async (event: LineWebhookEvent): Promise<unknown> => {
  if (!isForwardedText(event)) return replyToEvent(event)
  const [result] = await Promise.all([replyToEvent(event), forwardTextSender(event)])
  return result
}

const replyToEvent = async (event: LineWebhookEvent): Promise<unknown> => {
  // ── Upload result, pulled rather than pushed (§7.5) ──────────────────────
  // The bot cannot put a button in the chat without spending a push, so the
  // upload page makes the physician "say" a trigger line (free, sent as
  // them), the bot answers that webhook with an ACK carrying this postback
  // button (free), and the physician taps whenever they like — which gives
  // the bot a FRESH reply token to answer with the real receipt (free). Total
  // OA quota: zero.
  if (event.type === "postback") {
    const data = String((event.postback && event.postback.data) || "")
    if (!data.startsWith("p4p_result=")) return Promise.resolve(null)
    const queueId = decodeURIComponent(data.slice("p4p_result=".length))
    let row: QueueRow | null = null
    if (/^[0-9a-f-]{36}$/i.test(queueId)) {
      try {
        row = await fetchQueueRow("id=eq." + encodeURIComponent(queueId))
      } catch (e: any) {
        console.error("[upload] postback lookup failed:", e.message)
      }
    }
    // Defence in depth: this postback came from a button the bot itself sent
    // over a signature-verified webhook, so the id is not attacker-chosen —
    // but the row names its owner, so check it rather than assume it.
    if (row && row.line_user_id !== event.source.userId) row = null
    return client.replyMessage({
      replyToken: event.replyToken as string,
      messages: [buildUploadResultMessage(row) as line.messagingApi.Message],
    })
  }

  if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
    return Promise.resolve(null)
  }
  try {
    await axios.post("https://api.line.me/v2/bot/chat/loading/start",
      { "chatId": event.source.userId },
      { headers: headers }
    )
  } catch (error) {
    console.error(error)
  }
  const message = (event.message.text || "").trim().toLowerCase()
  if (message === "status") {
    return client.replyMessage({
      "replyToken": event.replyToken as string,
      "messages": [createStatusList() as line.messagingApi.Message]
    })
  }
  if (message === "myid") {
    return client.replyMessage({
      "replyToken": event.replyToken as string,
      "messages": [{ "type": "text", "text": event.source.userId as string }]
    })
  }
  if (message === "admin") {
    // Silent no-op for anyone else — never confirm or deny that "admin" is a
    // recognized command, so this can't be used to probe for the admin's
    // userId.
    if (!isOwnerLineUserId(event.source.userId)) return Promise.resolve(null)
    // signAdminToken throws when the signing secrets are missing. Report that
    // to the admin instead of letting it reject the whole webhook — the
    // handler's catch would turn one unusable command into a 500 for every
    // event in the batch, and LINE would retry it.
    if (!ADMIN_KEY_USABLE) {
      return client.replyMessage({
        "replyToken": event.replyToken as string,
        "messages": [{ "type": "text", "text": "ระบบผู้ดูแลปิดใช้งานชั่วคราว: ไม่ได้ตั้งค่า secret บนเซิร์ฟเวอร์" }]
      })
    }
    const exp = Math.floor(Date.now() / 1000) + 600 // 10 minutes
    const url = ADMIN_BASE_URL + "/admin/login?token=" + signAdminToken("login", exp)
    return client.replyMessage({
      "replyToken": event.replyToken as string,
      "messages": [{ "type": "text", "text": "ลิงก์เข้าสู่ระบบแอดมิน (ใช้ได้ 10 นาที):\n" + url }]
    })
  }
  // §7.5 step ②: the upload page sends this line as the physician, which is
  // what earns the bot a free reply. THE TEXT IS A TRIGGER, NOT DATA — the
  // row is resolved from source.userId, never from what the message says. A
  // physician who types it by hand gets the same answer, so this doubles as
  // a free status command.
  if (message.startsWith(UPLOAD_TRIGGER_PREFIX) || message === "ดูผลคะแนน" || message === "ผลคะแนน") {
    let row: QueueRow | null = null
    try {
      row = await fetchQueueRow(
        "line_user_id=eq." + encodeURIComponent(event.source.userId || "") + "&order=received_at.desc&limit=1"
      )
    } catch (e: any) {
      console.error("[upload] trigger lookup failed:", e.message)
    }
    const stillWorking = row && (row.status === "pending" || row.status === "processing")
    return client.replyMessage({
      "replyToken": event.replyToken as string,
      "messages": [
        (stillWorking
          ? receipt.buildPendingBubble({ monthKey: row!.month_key, queueId: row!.id, ack: true })
          : buildUploadResultMessage(row)) as line.messagingApi.Message,
      ],
    })
  }
  return Promise.resolve(null)
}

const createStatusList = () => {
  const object = {
    "type": "flex",
    "altText": "เลือกเดือนที่ต้องการ",
    "contents": {
      "type": "bubble",
      "size": "mega",
      "header": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "box",
            "layout": "vertical",
            "contents": [
              {
                "type": "text",
                "text": "กรุณาเลือกเดือน",
                "align": "center",
                "color": "#FFFFFF",
                "size": "xxl",
                "margin": "md",
                "offsetBottom": "sm",
                "weight": "bold",
              },
              {
                "type": "text",
                "text": "สามารถดูได้ 6 เดือนย้อนหลัง",
                "color": "#ffffa0",
                "align": "center",
              },
            ],
          },
        ],
        "backgroundColor": "#4B3D33",
        "paddingAll": "xxl",
      },
      "hero": {
        "type": "box",
        "layout": "vertical",
        "contents": [],
        "height": "5px",
        "backgroundColor": "#81A7AE",
      },
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          createStatusSublist(0),
          createStatusSublist(1),
          createStatusSublist(2),
          createStatusSublist(3),
          createStatusSublist(4),
          createStatusSublist(5),
        ],
        "backgroundColor": "#F5F5F0",
      }
    }
  }
  return object
}

// The current month (0-11) and Buddhist-era year in Asia/Bangkok. Vercel runs
// in UTC, where 00:00-06:59 on the 1st is still last month; shifting by +7h
// and reading the UTC fields is what /dashboard/api/overview does too
// (Thailand has no daylight saving).
function bangkokMonthAndBeYear(nowMs: number): { month: number; beYear: number } {
  const bkk = new Date(nowMs + 7 * 3600 * 1000)
  return { month: bkk.getUTCMonth(), beYear: bkk.getUTCFullYear() + 543 }
}

const createStatusSublist = (i: number) => {
  const { month, beYear: year } = bangkokMonthAndBeYear(Date.now())
  const iterator = month_iterator[month]
  const name = month_array[iterator[i][0]] + " " + (year + iterator[i][1])
  const color_hex = color_array[iterator[i][0]][1]
  const color_tw = color_array[iterator[i][0]][0]
  const sheetname = (year + iterator[i][1]) + "_" + String(iterator[i][0] + 1).padStart(2, '0')
  const object = {
    "type": "box",
    "layout": "horizontal",
    "contents": [
      {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": name,
            "align": "center",
            "size": "lg",
            "style": "italic",
            "weight": "bold",
          },
        ],
        "backgroundColor": color_hex,
        "cornerRadius": "sm",
        "borderColor": color_hex,
        "borderWidth": "semi-bold",
        "flex": 3,
        "paddingAll": "md",
      },
      {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": "คลิก",
            "align": "center",
            "weight": "bold",
            "size": "lg",
            "color": "#412D11",
          },
        ],
        "backgroundColor": "#f5f5f5",
        "cornerRadius": "md",
        "offsetEnd": "md",
        "borderColor": "#412D11",
        "borderWidth": "semi-bold",
        "flex": 1,
        "paddingAll": "md",
        "action": {
          "type": "uri",
          "label": sheetname,
          "uri": "https://liff.line.me/2008561527-a0xP1XmY?sheetname=" +
            sheetname +
            "&color=" + color_tw,
        },
      },
    ],
    "paddingBottom": "xxl",
    "paddingTop": "xxl",
  }
  return object
}

// On Vercel the exported app is used as the serverless handler.
// app.listen only runs for local dev (node main.js).
if ((require as NodeJS.Require).main === module) {
  app.listen(port, () => { console.log("P4P server is live") })
}

;(module as NodeModule).exports = app
