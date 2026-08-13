const express = require("express")
const process = require("node:process")
const crypto = require("node:crypto")
const line = require("@line/bot-sdk")
const axios = require("axios")
const app = express()

const port = process.env.PORT || 3000
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET

// For the Telegram approve/reject buttons (scripts/telegram-approve-buttons.sql).
// SUPABASE_SERVICE_ROLE_KEY bypasses RLS — required only here, kept server-side.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// The LINE **Login** channel that owns the /verify/ LIFF app — NOT the
// Messaging API channel that LINE_CHANNEL_SECRET/LINE_ACCESS_TOKEN belong to.
// Used as `client_id` when asking LINE to verify a LIFF ID token; it is the
// `aud` LINE checks the token against, so a token minted for someone else's
// channel is rejected. Without this, ID-token verification cannot run at all.
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID

// Staged rollout switch for the LINE second factor (scripts/line-bind-verified.sql).
//
//   unset/false — DETECT ONLY. Binding is still verified against LINE and a
//                 mismatch is refused and alerted, but page access keeps the
//                 existing rules, including the "3 failures then let them
//                 through" fail-open. Zero lockout risk.
//   "true"      — ENFORCE. A gated page requires that THIS SESSION proved its
//                 LINE identity, and the fail-opens are switched off (both the
//                 attempts limit and the "gate RPC unreachable" path).
//
// Do NOT enable until /verify/ has been observed completing real binds in
// production, because it depends on the LIFF app having the `openid` scope —
// liff.getIDToken() returns null without it and every bind fails. Check with:
//   select count(*) from public.line_verified_sessions where verified_at > now() - interval '1 day';
const LINE_BIND_ENFORCE = process.env.LINE_BIND_ENFORCE === "true"

// The single LINE userId allowed into /admin/ (the roster CRUD dashboard,
// see servePage-adjacent routes below). Not a secret in itself — a LINE
// userId only identifies an account, it can't be used to authenticate as
// one — so a hardcoded fallback is fine; ADMIN_LINE_USER_ID lets it be
// overridden per-deployment without a code change.
const ADMIN_LINE_USER_ID = process.env.ADMIN_LINE_USER_ID || "Ub5c3e37b54e59f479fbf450e2df60d18"
// Base URL used to build the one-time admin login link sent over LINE DM
// (the webhook has no `req` to read a Host header from).
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || "https://p4p-sakhonmso.vercel.app"

const headers = {
  "Content-Type": "application/json",
  "Authorization": "Bearer " + LINE_ACCESS_TOKEN
}
const config = {
  channelSecret: LINE_CHANNEL_SECRET,
}
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_ACCESS_TOKEN,
})
// Month names, colors, and the 6-month iterator are shared with the rich-menu
// script via src/constants.cjs (local names kept for readability below).
const {
  COLOR_ARRAY: color_array,
  MONTH_NAMES: month_array,
  MONTH_ITERATOR: month_iterator,
} = require("./src/constants.cjs")

// ── Server-side session validation ───────────────────────────────────────
// The LINE (LIFF) in-app browser does not persist a client-side Supabase
// session across navigations, so the browser can't hold the auth token. Instead
// the SERVER validates the session: after the client verifies its OTP it posts
// the tokens here; we keep the refresh token in an HttpOnly cookie and, on every
// gated page request, exchange it for a fresh access token which we inject into
// the page. The browser only ever holds a short-lived access token in memory.
const fs = require("node:fs")
const path = require("node:path")
const SUPABASE_URL = "https://zjeizbrzcltkgtlmkbji.supabase.co"
const SUPABASE_ANON = "sb_publishable_TcCSpznim4fi0Y7E_zuAsg_op19VZQ-"
const RT_COOKIE = "p4p_rt"
const COOKIE_BASE = "HttpOnly; Secure; SameSite=Lax; Path=/"
const PAGE_TOKEN_PLACEHOLDER = "__P4P_ACCESS_TOKEN__"

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
function stampAssets(html, pageDir) {
  return html.replace(/(<script\s+src=")([^":?]+\.js)(")/g, (tag, pre, src, post) => {
    const rel = src.startsWith("/") ? src.slice(1) : path.posix.join(pageDir, src)
    try {
      const hash = crypto
        .createHash("sha1")
        .update(fs.readFileSync(path.join(__dirname, rel)))
        .digest("hex")
        .slice(0, 8)
      return pre + src + "?v=" + hash + post
    } catch (e) {
      console.warn("[assets] could not hash " + rel + " — serving it unversioned: " + e.message)
      return tag
    }
  })
}

// Gated pages cached as templates; the server fills the token placeholder per
// request. Files never change at runtime.
const gatedPages = ["status", "list", "ranking"]
const pageTemplates = {}
for (const p of gatedPages) {
  pageTemplates[p] = stampAssets(fs.readFileSync(path.join(__dirname, p, "index.html"), "utf8"), p)
}
// /verify/ also carries the same <meta name="p4p-session"> placeholder, used
// only for the silent LINE-bind bounce (see servePage's "bind_required"
// redirect below) — every other visit serves this same template unmodified.
const verifyTemplate = stampAssets(
  fs.readFileSync(path.join(__dirname, "verify", "index.html"), "utf8"),
  "verify",
)

function parseCookies(req) {
  const out = {}
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
function setSessionCookie(res, at, rt) {
  const val = encodeURIComponent(JSON.stringify({ at: at, rt: rt }))
  res.append("Set-Cookie", RT_COOKIE + "=" + val + "; " + COOKIE_BASE + "; Max-Age=34560000")
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", RT_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
}

// ── Bind-redirect loop breaker ───────────────────────────────────────────
// Incident (2026-08): an unbound physician got stuck reloading between a
// gated page and /verify/ with no way out. Root cause: the "bind_required"
// redirect below is gated on the DATABASE's line_bind_attempts count, but
// verify/app.js's recordBindFailure() silently swallows any failure to reach
// that RPC and fabricates attempts=3 locally so the CLIENT auto-redirects
// back here — while the server, reading the real (unincremented) DB count,
// sees attempts stuck below the limit and immediately redirects right back
// to /verify/, which auto-runs the bind flow again on load with no tap
// required. Client and server disagreed on the count, and nothing caught it.
//
// This cookie is a hard backstop that does not depend on Supabase, LINE, or
// any client JS being reachable or correct — pure Express state. It counts
// consecutive bind_required redirects for THIS browser and, once BIND_LOOP_MAX
// is hit, serves the page instead of redirecting again, regardless of what
// the DB says. A short Max-Age means a stuck user recovers within minutes
// even if they never revisit; a successful serve always clears it, so a
// later, genuine bind prompt is never permanently suppressed for that browser.
const BIND_LOOP_COOKIE = "p4p_bindloop"
const BIND_LOOP_MAX = 4 // one above the intended 3 real attempts, as slack
function bindLoopCount(req) {
  const n = parseInt(parseCookies(req)[BIND_LOOP_COOKIE], 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}
function bumpBindLoopCookie(res, n) {
  res.append("Set-Cookie", BIND_LOOP_COOKIE + "=" + n + "; " + COOKIE_BASE + "; Max-Age=900")
}
function clearBindLoopCookie(res) {
  res.append("Set-Cookie", BIND_LOOP_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
}
function readSessionCookie(req) {
  const raw = parseCookies(req)[RT_COOKIE]
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    // Valid JSON but no usable refresh token inside — treat as no session
    // rather than falling through to using the raw JSON string itself as a
    // (bogus) refresh token.
    return (o && o.rt) ? { at: o.at || null, rt: o.rt } : null
  } catch {
    // Legacy cookie held a bare refresh token (pre-JSON format).
    return { at: null, rt: raw }
  }
}
// Read a JWT's payload without verifying it (the token itself was already
// validated by Supabase at /auth/session or the refresh call below — this is
// just for reading claims out of a token we already trust).
function jwtPayload(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  } catch { return {} }
}
function jwtExp(token) { return typeof jwtPayload(token).exp === "number" ? jwtPayload(token).exp : 0 }

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
function signAdminToken(purpose, exp) {
  if (!ADMIN_KEY_USABLE) throw new Error("admin signing key unavailable")
  const sig = crypto.createHmac("sha256", ADMIN_TOKEN_KEY).update(purpose + ":" + exp).digest("hex")
  return exp + "." + sig
}
function verifyAdminToken(purpose, token) {
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
function setAdminCookie(res) {
  const exp = Math.floor(Date.now() / 1000) + 90 * 24 * 3600 // 90 days
  res.append("Set-Cookie", ADMIN_COOKIE + "=" + signAdminToken("session", exp) + "; " + COOKIE_BASE + "; Max-Age=" + 90 * 24 * 3600)
}
function clearAdminCookie(res) {
  res.append("Set-Cookie", ADMIN_COOKIE + "=; " + COOKIE_BASE + "; Max-Age=0")
}
function requireAdmin(req, res, next) {
  const token = parseCookies(req)[ADMIN_COOKIE]
  if (!verifyAdminToken("session", token)) return res.status(401).json({ error: "not authenticated" })
  next()
}

// Calls a service_role-only RPC (admin_list_roster_tables / admin_table_columns)
// — same "apikey + Authorization both = service role key" pattern already
// used for approve_access_request/reject_access_request below.
async function callServiceRpc(fn, args) {
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
function pgErrorMessage(e, fallback) {
  return (e.response && e.response.data && e.response.data.message) || fallback
}

// Re-fetches the live roster-table list and checks membership — never trust
// a :table path param on its own, since it selects which Postgres table the
// next request reads/writes.
async function assertRosterTable(table) {
  const tables = await callServiceRpc("admin_list_roster_tables")
  if (!Array.isArray(tables) || !tables.includes(table)) {
    const err = new Error("unknown roster table: " + table)
    err.status = 404
    throw err
  }
}

// Resolve a usable access token from the session cookie: reuse the cached one
// while it's fresh, otherwise refresh once (rotating the cookie). Returns
// { at: null, reason } on failure — no cookie ("no_session") or a failed
// refresh ("expired", cookie cleared) — or { at, reason: null } on success.
async function resolveAccessToken(req, res) {
  const sess = readSessionCookie(req)
  if (!sess) return { at: null, reason: "no_session" }

  let at = sess.at
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
      if (!at) throw new Error("no access_token in refresh response")
      setSessionCookie(res, at, r.data.refresh_token || sess.rt)
    } catch {
      clearSessionCookie(res)
      return { at: null, reason: "expired" }
    }
  }
  return { at, reason: null }
}

// Single-round-trip gate check: is this email denylisted, does it have a LINE
// userId bound, how many failed bind attempts, and did THIS SESSION prove its
// LINE identity (scripts/line-bind-verified.sql).
//
// Called with the USER'S access token, not the anon key. The previous version
// used the anon key and passed the email as a parameter, which made the RPC an
// unauthenticated "is this address a registered physician?" oracle — and meant
// it could not be locked down, because revoking anon would 403, get swallowed
// by the catch below, and silently disable the whole gate including the
// denylist. get_line_bind_gate_status_self() takes no argument and reads the
// email from the caller's own JWT, so there is nothing left to enumerate.
// (apikey must still be the publishable key — Supabase requires that header —
// but Authorization is what selects the `authenticated` role.)
//
// Returns null on any error. What that MEANS depends on LINE_BIND_ENFORCE:
// in detect-only mode the caller proceeds (the long-standing fail-open, kept
// so a transient Supabase hiccup can't lock out a whole hospital); with
// enforcement on, the caller refuses to serve the page instead.
async function getLineBindGateStatus(accessToken) {
  try {
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/rpc/get_line_bind_gate_status_self",
      {},
      { headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, timeout: 8000 }
    )
    return (r.data && r.data[0]) || null
  } catch (e) {
    console.error("[gate] get_line_bind_gate_status_self failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    return null
  }
}

// Ask LINE whether a LIFF ID token is genuine. LINE checks the signature,
// expiry and audience for us and returns the claims; `sub` is the
// authoritative LINE userId.
//
// This is the whole point of the second factor. liff.getProfile().userId is
// just a string the browser chooses to send — the old bind RPC took it as a
// parameter and believed it. An ID token cannot be forged by the page.
async function verifyLineIdToken(idToken) {
  if (!LINE_LOGIN_CHANNEL_ID) {
    console.error("[line-bind] LINE_LOGIN_CHANNEL_ID is not set — cannot verify ID tokens")
    return null
  }
  try {
    const r = await axios.post(
      "https://api.line.me/oauth2/v2.1/verify",
      new URLSearchParams({ id_token: idToken, client_id: LINE_LOGIN_CHANNEL_ID }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 }
    )
    const sub = r.data && r.data.sub
    if (!sub) {
      console.error("[line-bind] LINE verify returned no sub claim")
      return null
    }
    return { sub: sub, name: (r.data && r.data.name) || null }
  } catch (e) {
    console.error("[line-bind] LINE rejected the id_token:",
      e.response ? JSON.stringify(e.response.data) : e.message)
    return null
  }
}

const BIND_ATTEMPT_LIMIT = 3

// Serve a gated page: require a valid session cookie and inject the current
// access token via <meta> (no inline script -> no CSP change). On top of
// session validity, also enforce the LINE-binding rule: a denylisted email is
// bounced out even with a valid session, and an email with no LINE userId
// bound yet (and still under the retry limit) is routed to /verify/ to
// silently complete that binding using its EXISTING session — no OTP
// re-entry — before it's allowed to reach the actual page.
function servePage(name) {
  return async (req, res) => {
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

    const gate = await getLineBindGateStatus(at)

    if (!gate) {
      // Could not confirm the denylist OR the session's LINE proof.
      if (LINE_BIND_ENFORCE) {
        return res.redirect(302, "/verify/?return=" + ret + "&reason=gate_unavailable#")
      }
      // Detect-only mode keeps the historical fail-open. Noted here because it
      // is a real gap while it lasts: a broken gate RPC silently stops
      // blocked_emails from being enforced at all.
    } else {
      if (gate.is_blocked) {
        clearSessionCookie(res)
        return res.redirect(302, "/verify/?reason=blocked#")
      }
      // Signed out, or revoked by an admin: Supabase DELETES the auth.sessions
      // row, so a missing row means this access token outlived its session.
      // Applies in both modes — it is a correctness fix, not part of the second
      // factor. /auth/logout only clears our cookie and never calls Supabase
      // signOut, so before this nothing in the system could really revoke a
      // session; a lifted cookie stayed good until the cached token expired.
      if (gate.session_revoked) {
        clearSessionCookie(res)
        return res.redirect(302, "/verify/?reason=expired#")
      }
      // `enforce_eligible` is true only for emails that have proved their LINE
      // identity through this flow at least once. Without that condition,
      // switching enforcement on would bounce every physician at once if the
      // LIFF app turned out to be missing the `openid` scope — ~200 people
      // locked out of a hospital tool by one env var. Users who have never
      // proved keep the old rules until they do, so the factor phases in.
      const wantsBindRedirect = LINE_BIND_ENFORCE && gate.enforce_eligible
        ? !gate.session_verified
        : !gate.is_bound && gate.attempts < BIND_ATTEMPT_LIMIT

      if (wantsBindRedirect) {
        // Hard backstop, independent of the DB-backed attempts count above
        // (see the comment on BIND_LOOP_COOKIE) — this redirect must never be
        // able to fire more than BIND_LOOP_MAX times in a row for one browser,
        // full stop, regardless of whether Supabase, LINE, or the client's own
        // retry accounting are behaving correctly.
        const loopCount = bindLoopCount(req)
        if (loopCount < BIND_LOOP_MAX) {
          bumpBindLoopCookie(res, loopCount + 1)
          return res.redirect(302, "/verify/?return=" + ret + "&reason=bind_required#")
        }
        console.warn("[bind-loop] backstop tripped for " + name + " — serving unbound rather than redirecting again")
      }
    }

    clearBindLoopCookie(res)
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    // This HTML carries a live access token in its <meta>, so it must never be
    // written to a cache — and a cached copy would also keep pointing at the
    // script URL that was current when it was stored, which is how a stale
    // ranking/app.js survives a deploy (see stampAssets above).
    res.setHeader("Cache-Control", "no-store")
    res.send(pageTemplates[name].replace(PAGE_TOKEN_PLACEHOLDER, at))
  }
}

// Security headers for the web UI. The Content-Security-Policy makes the
// email-verification gate more than cosmetic against XSS: script-src is limited
// to our own origin + the Supabase CDN + LINE's LIFF SDK CDN, with NO
// 'unsafe-inline', so an injected <script> or on*="" handler won't execute (all
// page JS was moved to external app.js files for exactly this reason). style-src
// keeps 'unsafe-inline' because the pages set element styles and load Google
// Fonts CSS; connect-src allows the Supabase REST/Realtime endpoints plus the
// LINE API hosts the LIFF SDK calls internally (liff.init / liff.getProfile, used
// on /verify/ to bind a LINE userId to the verified email — see
// scripts/bind-line-user.sql). frame-ancestors is intentionally omitted so the
// pages still load inside LINE's LIFF webview.
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
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP)
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  next()
})

// Client posts the tokens from its (working) client-side verifyOtp; we validate
// the access token, then stash the refresh token in an HttpOnly cookie.
app.post("/auth/session", express.json({ limit: "8kb" }), async (req, res) => {
  const { access_token, refresh_token } = req.body || {}
  if (!access_token || !refresh_token) return res.status(400).json({ error: "missing tokens" })
  try {
    await axios.get(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + access_token }, timeout: 8000,
    })
  } catch {
    return res.status(401).json({ error: "invalid token" })
  }
  setSessionCookie(res, access_token, refresh_token)
  res.json({ ok: true })
})
app.post("/auth/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

// Bind (or re-prove) the caller's LINE identity — the second factor.
//
// Both identities are established SERVER-SIDE here, and neither is taken on
// trust from the request body:
//   who they are in P4P   -> Supabase validates the access token
//   who they are on LINE  -> LINE validates the ID token, and its `sub` claim
//                            is the userId we store/compare
// The DB function is service_role-only, so a browser cannot reach it directly
// and cannot assert a LINE userId of its own choosing the way the old
// bind_line_user_id(p_line_user_id) allowed.
app.post("/line/bind", express.json({ limit: "8kb" }), async (req, res) => {
  const authHeader = req.headers.authorization || ""
  const at = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""
  const idToken = (req.body && req.body.id_token) || ""
  if (!at || !idToken) return res.status(400).json({ error: "missing token" })

  // 1. Validate the session against Supabase rather than reading the JWT body —
  //    this endpoint decides who a LINE account gets attached to, so the email
  //    must come from an authority, not from an unverified claim.
  let email = null
  try {
    const u = await axios.get(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + at }, timeout: 8000,
    })
    email = u.data && u.data.email
  } catch {
    return res.status(401).json({ error: "invalid session" })
  }
  if (!email) return res.status(401).json({ error: "no email on session" })

  // 2. Validate the LINE ID token with LINE.
  const line = await verifyLineIdToken(idToken)
  if (!line) return res.status(401).json({ error: "line verification failed" })

  // Without a session_id there is nothing to attach the proof to, so
  // get_line_bind_gate_status_self would keep reporting session_verified=false
  // and — with enforcement on — bounce the user straight back here forever.
  // Fail loudly instead: an infinite redirect inside LINE's webview is close to
  // undebuggable from the physician's side. session_id is a required claim on
  // every Supabase access token, so this should be unreachable.
  const sessionId = jwtPayload(at).session_id || null
  if (!sessionId) {
    console.error("[line-bind] access token has no session_id claim — cannot record proof")
    return res.status(500).json({ error: "no session_id on token" })
  }

  // 3. Record it. session_id ties the proof to THIS session; it is a required
  //    claim on every Supabase access token and is stable across refreshes, so
  //    a physician proves once per session rather than once per page load.
  try {
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/rpc/bind_line_user_id_verified",
      {
        p_email: email,
        p_line_user_id: line.sub,
        p_line_display_name: line.name,
        p_session_id: sessionId,
      },
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    )
    const status = (r.data && r.data.status) || "error"
    console.log("[line-bind] " + email + " -> " + status)
    if (status === "mismatch") return res.status(403).json({ status: status })
    if (status === "bound" || status === "match") return res.json({ status: status })
    return res.status(500).json({ status: status })
  } catch (e) {
    console.error("[line-bind] bind RPC failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "bind failed" })
  }
})

// ── Silent LINE reauth ───────────────────────────────────────────────────
// Incident (2026-08): physicians who had already bound a LINE account were
// still hitting the plain email/OTP form on every visit. Root cause turned
// out to have nothing to do with the bind itself — is_bound is only ever
// consulted once a session already exists, and these physicians had NO
// session cookie at all by the time they reopened the app. Evidence from
// production auth logs: the same bound account created a brand-new session
// (fresh /otp + verifyOtp) every time it reopened the app, sometimes only a
// couple of hours after its previous session had refreshed successfully —
// i.e. the cookie itself was not surviving between separate LIFF launches,
// most plausibly because LINE gives each chat-triggered LIFF launch its own,
// non-persistent webview storage. No cookie attribute can fix that; the
// browser instance that held the cookie is simply gone by the next tap.
//
// What DOES survive across LIFF launches is LINE's own login — liff.init()
// + liff.getIDToken() keeps working because that is tied to the LINE app
// account, not to our webview's storage. This endpoint uses that as the
// actual reauthentication mechanism for a RETURNING bound physician: verify
// the ID token with LINE, look up the email it was already bound to (never
// creates a binding — only resumes one that the real email+OTP+ID-token
// flow already established), and mint a fresh Supabase session for that
// email entirely server-side. No email is sent and no OTP is typed; the
// physician never sees the form at all. An unbound LINE account (never
// completed the real flow) simply falls through to today's behavior.

// Generates a magic-link OTP for an existing user and immediately redeems it
// server-side, entirely with our own credentials. Two Supabase calls,
// service-role then anon:
//   1. POST /auth/v1/admin/generate_link — returns `email_otp`, the same
//      6-digit code that would otherwise be emailed. Nothing is actually
//      sent; we consume it ourselves in the next step.
//   2. POST /auth/v1/verify — the identical {email, token, type:"email"}
//      shape verify/app.js's client-side db.auth.verifyOtp() already sends
//      today, so this reuses a call this app already proves works in
//      production, rather than a PKCE/hashed_token path this codebase has
//      never exercised.
async function mintSessionForEmail(email) {
  const gen = await axios.post(
    SUPABASE_URL + "/auth/v1/admin/generate_link",
    { type: "magiclink", email: email },
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    }
  )
  // Some GoTrue versions nest verification fields under `properties`; guard
  // both shapes and log the raw keys on failure so a field-name drift shows
  // up immediately in Vercel logs instead of as a silent 500 with no clue.
  const otp = gen.data && (gen.data.email_otp || (gen.data.properties && gen.data.properties.email_otp))
  if (!otp) {
    console.error("[line-silent-auth] generate_link returned no email_otp. keys:",
      gen.data ? Object.keys(gen.data).join(",") : "(no body)")
    throw new Error("generate_link returned no email_otp")
  }

  const verify = await axios.post(
    SUPABASE_URL + "/auth/v1/verify",
    { type: "email", email: email, token: otp },
    { headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" }, timeout: 8000 }
  )
  if (!verify.data || !verify.data.access_token || !verify.data.refresh_token) {
    throw new Error("verify did not return a session")
  }
  return verify.data
}

// No Authorization header — there is no session yet; proving identity via a
// LINE ID token is the entire point of this endpoint.
app.post("/line/silent-auth", express.json({ limit: "8kb" }), async (req, res) => {
  const idToken = (req.body && req.body.id_token) || ""
  if (!idToken) return res.status(400).json({ error: "missing id_token" })

  const line = await verifyLineIdToken(idToken)
  if (!line) return res.status(401).json({ error: "line verification failed" })

  // Look up an EXISTING binding — this can only RESUME a session for an email
  // that the real email+OTP+verified-ID-token flow already bound to this
  // exact LINE account. It cannot be used to claim an email nobody has proven
  // ownership of: unlike /line/bind (email from an existing session, LINE
  // identity from the request), this looks the other direction — LINE
  // identity to email — so there is no "different LINE account" case to
  // mismatch against, and nothing here can create a new line_user_bindings row.
  //
  // Cardinality is enforced, not assumed. This lookup decides WHICH IDENTITY a
  // session is minted for, so "take the first row" is not good enough: the
  // email->uid mismatch check above guards only one direction, and until the
  // unique index below existed, two emails could bind the same LINE account and
  // rows[0] from an unordered result would pick between them nondeterministically.
  //
  //   create unique index line_user_bindings_line_user_id_key
  //     on public.line_user_bindings (line_user_id);
  //
  // limit=2 is deliberate — enough to DETECT a second row, so a violation is
  // refused loudly here rather than silently resolved, even if the index is
  // ever dropped or a future path writes around it.
  let email = null
  try {
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/line_user_bindings?line_user_id=eq." + encodeURIComponent(line.sub) + "&select=email&limit=2",
      {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
        timeout: 8000,
      }
    )
    if (Array.isArray(r.data) && r.data.length > 1) {
      console.error("[line-silent-auth] REFUSED: LINE userId maps to " + r.data.length +
        "+ emails — ambiguous identity, refusing to mint a session")
      return res.status(409).json({ error: "ambiguous_binding" })
    }
    email = r.data && r.data[0] && r.data[0].email
  } catch (e) {
    console.error("[line-silent-auth] binding lookup failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "lookup failed" })
  }
  // Not bound yet — fall through to the normal email/OTP form. Not an error.
  if (!email) return res.status(404).json({ error: "not_bound" })

  // Refuse to mint a session for a denylisted email, independent of whether
  // the client should have skipped this call (verify/app.js does, based on
  // the bounce reason, but that is JS an attacker can ignore). Without this,
  // a blocked-but-still-bound account could mint a session here, get bounced
  // straight back by the gate's OWN blocked_emails check on the very next
  // page, and — if the client retried — loop indefinitely minting sessions
  // against a denylisted address.
  try {
    const blocked = await axios.get(
      SUPABASE_URL + "/rest/v1/blocked_emails?email=eq." + encodeURIComponent(email) + "&select=email",
      {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
        timeout: 8000,
      }
    )
    if (Array.isArray(blocked.data) && blocked.data.length > 0) {
      return res.status(403).json({ error: "blocked" })
    }
  } catch (e) {
    console.error("[line-silent-auth] blocklist check failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "lookup failed" })
  }

  try {
    const session = await mintSessionForEmail(email)
    setSessionCookie(res, session.access_token, session.refresh_token)

    // Record this brand-new session as LINE-verified too, using the SAME
    // safe, mismatch-checking RPC /line/bind uses — so a later switch to
    // LINE_BIND_ENFORCE doesn't immediately ask this device to prove itself
    // again right after it just did, silently, one line above. A mismatch
    // genuinely can't happen here (we looked email up FROM this exact LINE
    // account), but routing through the same RPC is one code path to trust
    // rather than two, and keeps line_verified_sessions consistent.
    //
    // Awaited, not fire-and-forget: Vercel can freeze a serverless function
    // the instant a response is sent (see the Telegram webhook handler
    // below for the same lesson learned the hard way), so an un-awaited call
    // here could get silently killed before it ever reaches Supabase. Best
    // effort either way — its own failure must not fail the login, since the
    // session cookie is already good by this point.
    const sessionId = jwtPayload(session.access_token).session_id || null
    if (sessionId) {
      await axios.post(
        SUPABASE_URL + "/rest/v1/rpc/bind_line_user_id_verified",
        { p_email: email, p_line_user_id: line.sub, p_line_display_name: line.name, p_session_id: sessionId },
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
          },
          timeout: 8000,
        }
      ).catch((e) => console.warn("[line-silent-auth] post-mint verify record failed:", e.message))
    }

    console.log("[line-silent-auth] minted session for " + email)
    return res.json({ ok: true })
  } catch (e) {
    console.error("[line-silent-auth] mint failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "mint failed" })
  }
})

// Receives Telegram's "callback_query" webhook when an admin taps ✅/❌ on the
// access-request alert (buttons added by scripts/telegram-approve-buttons.sql).
// Uses the Supabase SERVICE ROLE key to call the approve/reject RPC — that key
// never leaves this server.
app.post("/telegram/webhook", express.json({ limit: "64kb" }), async (req, res) => {
  const receivedSecret = (req.headers["x-telegram-bot-api-secret-token"] || "").trim()
  const expectedSecret = (TELEGRAM_WEBHOOK_SECRET || "").trim()
  console.log("[tg-webhook] received. secret header present:", !!req.headers["x-telegram-bot-api-secret-token"])

  // Telegram echoes back the secret set via setWebhook in this header — the
  // only real proof a request came from Telegram and not a guessed URL. Trim
  // both sides so an accidental trailing space/newline (easy to introduce
  // pasting a long value into Vercel's env var UI) doesn't cause a false
  // mismatch. Log LENGTHS only (never the values) — a length mismatch is a
  // strong sign of a copy-paste truncation between where the secret was set
  // (Vercel) and where it was registered (the setWebhook call).
  //
  // The empty-secret case is checked FIRST and separately. With
  // TELEGRAM_WEBHOOK_SECRET unset, expectedSecret is "" and a request carrying
  // no header at all compares equal — the handler below then approves or
  // rejects access requests through a service-role RPC for anyone who guesses
  // this URL. Same reasoning as ADMIN_KEY_USABLE above: a missing env var must
  // disable the endpoint, never open it.
  if (!expectedSecret) {
    console.error("[tg-webhook] REJECTED: TELEGRAM_WEBHOOK_SECRET is not set — " +
      "refusing every callback (a missing secret is not a match)")
    return res.sendStatus(401)
  }
  if (receivedSecret.length !== expectedSecret.length ||
      !crypto.timingSafeEqual(Buffer.from(receivedSecret), Buffer.from(expectedSecret))) {
    console.log(
      "[tg-webhook] REJECTED: secret mismatch. received len=" + receivedSecret.length +
      " expected len=" + expectedSecret.length + " (configured=" + !!TELEGRAM_WEBHOOK_SECRET + ")"
    )
    return res.sendStatus(401)
  }

  const cb = req.body && req.body.callback_query
  if (!cb || !cb.data) {
    console.log("[tg-webhook] no callback_query.data in body — update type:", Object.keys(req.body || {}).join(","))
    return res.sendStatus(200)
  }
  const [action, token] = String(cb.data).split("|")
  // Log only a token prefix — it's a single-use approve/reject token for
  // access_requests, not a long-lived secret, but there's no reason to put
  // the full value in Vercel's logs when a prefix is enough to correlate.
  const tokenPreview = token ? token.slice(0, 8) + "…" : token
  console.log("[tg-webhook] callback_data action:", action, "token:", tokenPreview)
  if (!token || (action !== "appr" && action !== "rej")) {
    console.log("[tg-webhook] REJECTED: unparseable callback_data")
    return res.sendStatus(200)
  }

  const tg = (method, body) =>
    axios.post("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, body, { timeout: 8000 })
      .then((r) => { console.log("[tg-webhook] telegram." + method + " ok:", JSON.stringify(r.data)); return r })
      .catch((e) => {
        console.error("[tg-webhook] telegram." + method + " FAILED:",
          e.response ? JSON.stringify(e.response.data) : e.message)
      })

  try {
    const fn = action === "appr" ? "approve_access_request" : "reject_access_request"
    console.log("[tg-webhook] calling Supabase RPC:", fn, "with token:", tokenPreview)
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/rpc/" + fn,
      { p_token: token },
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    )
    console.log("[tg-webhook] RPC response:", JSON.stringify(r.data))
    const ok = r.data === true

    await tg("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: ok
        ? (action === "appr" ? "อนุมัติแล้ว" : "ปฏิเสธคำขอแล้ว")
        : "คำขอนี้ถูกดำเนินการไปแล้ว หรือไม่พบข้อมูล",
    })

    if (ok && cb.message) {
      const suffix = action === "appr" ? "\n\n✅ อนุมัติแล้ว" : "\n\n❌ ปฏิเสธแล้ว"
      await tg("editMessageText", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: (cb.message.text || "") + suffix,
        reply_markup: { inline_keyboard: [] },
      })
    }
  } catch (e) {
    console.error("[tg-webhook] RPC call FAILED:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "เกิดข้อผิดพลาด กรุณาลองใหม่" })
  }

  console.log("[tg-webhook] handler complete, responding 200")
  // Respond only after ALL Telegram/Supabase calls finish. Vercel's serverless
  // runtime can freeze the function the instant a response is sent — an early
  // ack (the previous version of this code) let the platform kill
  // answerCallbackQuery/editMessageText before they completed, which is why the
  // button spinner would time out with no confirmation ever showing.
  res.sendStatus(200)
})

// Gated pages: server-validated + token injected (must be registered BEFORE the
// static mounts so "/status/" hits the handler, while "/status/app.js" etc.
// fall through to the static mount below).
for (const p of gatedPages) {
  app.get(["/" + p, "/" + p + "/"], servePage(p))
}

// /verify/ itself: for everyone this is the normal unauthenticated page
// (served byte-identical to the plain static file). The ONE exception is the
// "bind_required" bounce from servePage() above — a session that's valid but
// still needs its LINE userId bound. In that case only, inject the existing
// access token so the page can silently complete the bind (see verify/app.js)
// without making the physician re-enter their email/OTP. Registered before
// the static mount below for the same reason as the gated pages.
app.get(["/verify", "/verify/"], async (req, res) => {
  // NO trailing-slash redirect here — this page is served identically at both
  // /verify and /verify/.
  //
  // Incident (2026-08): unbound physicians hit an endless /verify -> /verify/
  // reload. This handler used to 302 the no-slash URL to "/verify/…#", and
  // that explicit "#" was the bug: LIFF navigates to its registered Endpoint
  // URL with "#access_token=…" appended to complete login, and the redirect
  // replaced that fragment with an empty one. liff.init() then found no login
  // state, restarted login, landed back on /verify, and got stripped again —
  // forever. Vercel logs showed the cycle plainly, with no POST /line/bind
  // ever reached.
  //
  // It only surfaced when the `openid` scope was added: that invalidated
  // existing LIFF consent, so init() started needing a real login round-trip
  // instead of restoring from cache. The stripping bug was already here.
  //
  // Serving both paths keeps the fragment intact (no navigation at all), and
  // verify/index.html now loads /verify/app.js absolutely so the no-slash URL
  // resolves its script correctly — that 404 was the redirect's only purpose.
  //
  // The OTHER trailing-"#" redirects (servePage, for /status /list /ranking)
  // are deliberately untouched: those clear a genuinely stale fragment left by
  // a DIFFERENT LIFF app, which is a real problem and a different one.
  res.setHeader("Content-Type", "text/html; charset=utf-8")

  // Inject the access token whenever a VALID SESSION EXISTS — not only when
  // the URL still carries ?reason=bind_required.
  //
  // Incident (2026-08): an unbound physician reported the "ยืนยันอีเมล" email
  // form reloading 2-3 times instead of binding silently. That page is the
  // email/OTP step, which verify/app.js only shows when NO token was injected
  // — the tell that finally explained why no POST /line/bind, no
  // line_bind_attempts row and no line_verified_sessions row ever appeared:
  // runLineBindFlow was never reached at all.
  //
  // Cause: servePage bounces them here as
  // /verify/?return=…&reason=bind_required with the token injected, and
  // verify/app.js starts the silent bind. liff.init() then performs a LINE
  // login round-trip which navigates to the LIFF app's REGISTERED endpoint
  // URL — our query string does not survive that. Coming back, reason was no
  // longer "bind_required", so no token was injected, and the physician got
  // dropped onto the email form for an account they were already signed in to.
  //
  // Keying off the session removes the dependency on a query parameter
  // surviving a third party's redirect. Note this also means a signed-in
  // visitor to /verify/ is taken straight through the bind rather than being
  // offered the email form; switching accounts requires POST /auth/logout
  // first. That is the right trade — being unable to log in at all is far
  // worse than an awkward account switch.
  const { at } = await resolveAccessToken(req, res)
  console.log(
    "[verify] reason=" + (req.query.reason || "-") +
    " session=" + (at ? "yes" : "no") +
    " token_injected=" + (at ? "yes" : "no")
  )
  // Same reasoning as servePage: the signed-in variant embeds an access token,
  // and either variant must be re-fetched so its <script> URLs stay current.
  res.setHeader("Cache-Control", "no-store")
  res.send(at ? verifyTemplate.replace(PAGE_TOKEN_PLACEHOLDER, at) : verifyTemplate)
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
app.get(["/admin", "/admin/"], (req, res) => {
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

// One-time login link from the LINE bot. Invalid/expired -> bounce to the
// page itself, which shows the "message the bot" instructions.
app.get("/admin/login", (req, res) => {
  const token = String(req.query.token || "")
  if (!verifyAdminToken("login", token)) return res.redirect(302, "/admin/?error=bad_token")
  setAdminCookie(res)
  res.redirect(302, "/admin/")
})

app.post("/admin/logout", (req, res) => { clearAdminCookie(res); res.json({ ok: true }) })

app.get("/admin/api/tables", requireAdmin, async (req, res) => {
  try {
    const tables = await callServiceRpc("admin_list_roster_tables")
    res.json({ tables: tables || [] })
  } catch (e) {
    console.error("[admin] list tables failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to list tables" })
  }
})

app.get("/admin/api/tables/:table/columns", requireAdmin, async (req, res) => {
  try {
    await assertRosterTable(req.params.table)
    const columns = await callServiceRpc("admin_table_columns", { p_table: req.params.table })
    res.json({ columns: columns || [] })
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] columns failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load columns" })
  }
})

app.get("/admin/api/tables/:table/rows", requireAdmin, async (req, res) => {
  try {
    await assertRosterTable(req.params.table)
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table) + "?select=*&order=department,lastname",
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ rows: r.data })
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] rows fetch failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load rows" })
  }
})

// Keeps only keys that are real, non-PK columns of the target table — the
// request body is client-controlled, so this is what stops an insert/update
// from writing to a column that doesn't exist (PostgREST would 400 anyway)
// or overwriting the `index` primary key.
async function filterToColumns(table, body) {
  const columns = await callServiceRpc("admin_table_columns", { p_table: table })
  const allowed = new Set((columns || []).filter((c) => !c.is_pk).map((c) => c.column_name))
  const out = {}
  for (const k of Object.keys(body || {})) {
    if (allowed.has(k)) out[k] = body[k]
  }
  return out
}

app.post("/admin/api/tables/:table/rows", requireAdmin, express.json({ limit: "32kb" }), async (req, res) => {
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
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] insert failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "insert failed") })
  }
})

app.patch("/admin/api/tables/:table/rows/:index", requireAdmin, express.json({ limit: "32kb" }), async (req, res) => {
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
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] update failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(400).json({ error: pgErrorMessage(e, "update failed") })
  }
})

app.delete("/admin/api/tables/:table/rows/:index", requireAdmin, async (req, res) => {
  try {
    await assertRosterTable(req.params.table)
    await axios.delete(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(req.params.table) + "?index=eq." + encodeURIComponent(req.params.index),
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ ok: true })
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: "unknown table" })
    console.error("[admin] delete failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "delete failed" })
  }
})

app.use("/status", express.static("status"))
app.use("/list", express.static("list"))
app.use("/ranking", express.static("ranking"))
app.use("/verify", express.static("verify"))
app.use("/admin", express.static("admin"))
app.use("/assets", express.static("assets"))

app.post("/line", line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err)
      res.status(500).end()
    })
})

const handleEvent = async (event) => {
  if (event.type !== 'message' || event.message.type !== 'text') {
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
  const message = event.message.text.trim().toLowerCase()
  if (message === "status") {
    return client.replyMessage({
      "replyToken": event.replyToken,
      "messages": [createStatusList()]
    })
  }
  if (message === "myid") {
    return client.replyMessage({
      "replyToken": event.replyToken,
      "messages": [{ "type": "text", "text": event.source.userId }]
    })
  }
  if (message === "admin") {
    // Silent no-op for anyone else — never confirm or deny that "admin" is a
    // recognized command, so this can't be used to probe for the admin's
    // userId.
    if (event.source.userId !== ADMIN_LINE_USER_ID) return Promise.resolve(null)
    // signAdminToken throws when the signing secrets are missing. Report that
    // to the admin instead of letting it reject the whole webhook — the
    // handler's catch would turn one unusable command into a 500 for every
    // event in the batch, and LINE would retry it.
    if (!ADMIN_KEY_USABLE) {
      return client.replyMessage({
        "replyToken": event.replyToken,
        "messages": [{ "type": "text", "text": "ระบบผู้ดูแลปิดใช้งานชั่วคราว: ไม่ได้ตั้งค่า secret บนเซิร์ฟเวอร์" }]
      })
    }
    const exp = Math.floor(Date.now() / 1000) + 600 // 10 minutes
    const url = ADMIN_BASE_URL + "/admin/login?token=" + signAdminToken("login", exp)
    return client.replyMessage({
      "replyToken": event.replyToken,
      "messages": [{ "type": "text", "text": "ลิงก์เข้าสู่ระบบแอดมิน (ใช้ได้ 10 นาที):\n" + url }]
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

const createStatusSublist = (i) => {
  const now = new Date()
  const month = now.getMonth()
  const year = now.getFullYear() + 543
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
if (require.main === module) {
  app.listen(port, () => { console.log("P4P server is live") })
}

module.exports = app

