const express = require("express")
const process = require("node:process")
const crypto = require("node:crypto")
const line = require("@line/bot-sdk")
const axios = require("axios")
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
// The LIFF app whose registered endpoint is /upload/ (the rich menu's fourth
// block opens it). Injected into the page the same way the access token is,
// so the id lives in one place — the env var scripts/setup-richmenu.mjs
// already requires — rather than being hardcoded in two.
const UPLOAD_LIFF_PLACEHOLDER = "__P4P_UPLOAD_LIFF_ID__"
// Hardcoded fallback for the same reason ADMIN_LINE_USER_ID and
// ADMIN_BASE_URL have one: a LIFF id is not a secret. This exact string is
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
const gatedPages = ["status", "list", "ranking", "upload"]
const pageTemplates = {}
for (const p of gatedPages) {
  pageTemplates[p] = stampAssets(fs.readFileSync(path.join(__dirname, p, "index.html"), "utf8"), p)
}
// /verify/ carries no token placeholder at all — it's the same static page
// for everyone, every time (see the route below).
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

function readSessionCookie(req) {
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
// Read a JWT's payload without verifying it (the token itself was already
// validated by Supabase at /auth/session or the refresh call below — this is
// just for reading claims out of a token we already trust).
function jwtPayload(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  } catch (e) { return {} }
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
// 7 days, not the previous 90. This token is a stateless bearer with no
// revocation path short of rotating LINE_CHANNEL_SECRET or
// SUPABASE_SERVICE_ROLE_KEY (which would break the rest of the system), so
// its lifetime IS its only real defense against a lost/handed-down phone.
// Re-authenticating is a single "admin" DM to the bot — trivial for the one
// person who ever needs to.
const ADMIN_SESSION_SECONDS = 7 * 24 * 3600
function setAdminCookie(res) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  res.append("Set-Cookie", ADMIN_COOKIE + "=" + signAdminToken("session", exp) + "; " + COOKIE_BASE + "; Max-Age=" + ADMIN_SESSION_SECONDS)
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
// — same "apikey + Authorization both = service role key" pattern used by
// every /admin/api/* route below, RPC or plain table access alike.
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
    } catch (e) {
      clearSessionCookie(res)
      return { at: null, reason: "expired" }
    }
  }
  return { at, reason: null }
}

// Single boolean gate check: is this session's email still allowed to be
// here — active in `physicians` and, as of auth-rewrite-2026-08.sql, not
// sitting on a revoked Supabase session either. Called with the USER'S
// access token, not the anon key, and the RPC reads the email from the
// caller's own JWT rather than taking one as a parameter — there is nothing
// here for an unauthenticated caller to enumerate.
async function isCurrentUserAllowlisted(accessToken) {
  try {
    const r = await axios.post(
      SUPABASE_URL + "/rest/v1/rpc/is_current_user_allowlisted",
      {},
      { headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, timeout: 8000 }
    )
    return r.data === true
  } catch (e) {
    console.error("[gate] is_current_user_allowlisted failed:",
      e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message)
    // Fail open on a transient Supabase hiccup rather than locking out a
    // whole hospital over a network blip — the same trade the old gate made.
    // RLS is still the real data barrier regardless of what this returns.
    return true
  }
}

// Serve a gated page: require a valid session cookie whose email is still
// allow-listed, and inject the current access token via <meta> (no inline
// script -> no CSP change). Whether a LINE account is bound is irrelevant
// here — that's traceability recorded elsewhere (supabase/functions/line-
// verify), never a condition for reaching the page.
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

    const allowed = await isCurrentUserAllowlisted(at)
    if (!allowed) {
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
app.use((req, res, next) => {
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
app.post("/auth/session", express.json({ limit: "8kb" }), async (req, res) => {
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
app.post("/auth/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

// Gated pages: server-validated + token injected (must be registered BEFORE the
// static mounts so "/status/" hits the handler, while "/status/app.js" etc.
// fall through to the static mount below).
for (const p of gatedPages) {
  app.get(["/" + p, "/" + p + "/"], servePage(p))
}

// /verify/ itself: the same static page for everyone, every time — no
// session lookup, no token injection. Binding a LINE account no longer needs
// a server-injected token or a bounce-back-here round trip (see verify/app.js
// and supabase/functions/line-verify): the browser already holds whatever
// tokens it needs by the time it would call either. Registered before the
// static mount below so it's this handler, not express.static, that serves
// the trailing-slash-less form too.
app.get(["/verify", "/verify/"], (req, res) => {
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

// ── Access requests ──────────────────────────────────────────────────────
// An email that isn't allow-listed yet (log_access_request(), called from
// /verify/) lands here for the admin to act on. Approving used to happen via
// a bearer token riding in a Telegram button's callback_data — replayable by
// anyone in that chat or holding the bot token, straight against Supabase,
// with no admin session involved at all (SECURITY_ANALYSIS.md §2c). This is
// the replacement: the admin's own authenticated dashboard, writing with the
// service_role key server-side, same posture as the roster CRUD routes above.
app.get("/admin/api/access-requests", requireAdmin, async (req, res) => {
  try {
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/access_requests?resolved=is.false&select=*&order=requested_at.desc",
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    res.json({ requests: r.data || [] })
  } catch (e) {
    console.error("[admin] access-requests list failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: "failed to load access requests" })
  }
})

app.post("/admin/api/access-requests/:email/approve", requireAdmin, async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase()
  if (!email) return res.status(400).json({ error: "missing email" })
  try {
    const reqRow = await axios.get(
      SUPABASE_URL + "/rest/v1/access_requests?email=eq." + encodeURIComponent(email) + "&select=name,department",
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }, timeout: 8000 }
    )
    const name = (reqRow.data && reqRow.data[0] && reqRow.data[0].name) || null
    const department = (reqRow.data && reqRow.data[0] && reqRow.data[0].department) || null

    // Upsert rather than insert: the email may already exist (e.g. a
    // previously revoked physician re-requesting) — approving should
    // re-activate that row, not fail on the primary key.
    //
    // department is omitted from the body entirely when the request never
    // captured one (a request logged before this field existed) — merge-
    // duplicates only overwrites columns present in the payload, so leaving
    // it out preserves whatever department the physicians row already has
    // rather than clobbering it with null.
    const upsertBody = { email: email, full_name: name, source: "directory", active: true, updated_at: new Date().toISOString() }
    if (department) upsertBody.department = department
    await axios.post(
      SUPABASE_URL + "/rest/v1/physicians?on_conflict=email",
      upsertBody,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        timeout: 8000,
      }
    )
    await axios.patch(
      SUPABASE_URL + "/rest/v1/access_requests?email=eq." + encodeURIComponent(email),
      { resolved: true },
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" }, timeout: 8000 }
    )
    res.json({ ok: true })
  } catch (e) {
    console.error("[admin] approve access-request failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    res.status(500).json({ error: pgErrorMessage(e, "approve failed") })
  }
})

app.post("/admin/api/access-requests/:email/reject", requireAdmin, async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase()
  if (!email) return res.status(400).json({ error: "missing email" })
  try {
    await axios.patch(
      SUPABASE_URL + "/rest/v1/access_requests?email=eq." + encodeURIComponent(email),
      { resolved: true },
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" }, timeout: 8000 }
    )
    res.json({ ok: true })
  } catch (e) {
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
// Same env var scripts/setup-richmenu.mjs requires — the LIFF app whose
// endpoint is /upload/. Only used to build a "ส่งไฟล์อีกครั้ง" button; a
// missing value degrades that button to "ติดต่อผู้ดูแล", never a crash.
const UPLOAD_LIFF_URL = UPLOAD_LIFF_ID ? "https://liff.line.me/" + UPLOAD_LIFF_ID : ""

const receipt = require("./lib/line-receipt-flex")

function serviceHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
  }, extra || {})
}

// The 10th of the month AFTER month_key, 23:59:59 Asia/Bangkok — the same
// instant web/lib/months.ts's deadlineISO() and enqueue_p4p_upload()'s own
// SQL compute. Punctuality is measured against `received_at` (when the
// physician handed the file over), never against processing time (§9).
function monthDeadlineMs(monthKey) {
  const [beYear, month] = String(monthKey || "").split("_").map(Number)
  if (!beYear || !month) return NaN
  // month is 1-based, so passing it as a 0-based index already means "the
  // following month"; December rolls into the next year on its own.
  return Date.UTC(beYear - 543, month, 10, 16, 59, 59)
}
function isLateUpload(monthKey, receivedAt) {
  const deadline = monthDeadlineMs(monthKey)
  const received = new Date(receivedAt).getTime()
  if (isNaN(deadline) || isNaN(received)) return false
  return received > deadline
}

async function fetchQueueRow(filter) {
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
async function patchQueueRow(id, patch, extraFilter) {
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

app.post("/upload/score", express.json({ limit: "8kb" }), async (req, res) => {
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
  if (!(await isCurrentUserAllowlisted(at))) {
    clearSessionCookie(res)
    return res.status(401).json({ error: "blocked" })
  }
  const callerEmail = String(jwtPayload(at).email || "").toLowerCase()

  let row
  try {
    row = await fetchQueueRow("id=eq." + encodeURIComponent(queueId))
  } catch (e) {
    console.error("[upload] queue lookup failed:", e.response ? JSON.stringify(e.response.data) : e.message)
    return res.status(500).json({ error: "lookup_failed" })
  }
  if (!row) return res.status(404).json({ error: "not_found" })
  // The id is an opaque uuid the browser just received from its own enqueue
  // call, not a secret — THIS check is the access control, mirroring how
  // object_path ownership is checked at enqueue time.
  if (String(row.email).toLowerCase() !== callerEmail) {
    return res.status(403).json({ error: "forbidden" })
  }
  // A retry of an already-resolved request, or one the worker got to first.
  if (row.status !== "pending") return res.status(409).json({ error: "already_processed", status: row.status })

  const monthKey = row.month_key
  const monthNum = parseInt(String(monthKey).slice(5), 10)
  const beYear = parseInt(String(monthKey).slice(0, 4), 10)

  // Reject (terminal, no retry on either claim function) — same shape as an
  // enqueue-time refusal: nothing here was ever eligible.
  async function reject(errorType, detail, status) {
    try {
      await patchQueueRow(row.id, {
        status: "rejected",
        error_type: errorType,
        error_detail: detail || null,
        finished_at: new Date().toISOString(),
      }, "&status=eq.pending")
    } catch (e) {
      console.error("[upload] reject patch failed:", e.message)
    }
    return res.status(status || 422).json({ error: errorType, detail: detail || "" })
  }

  // Defer to claim_p4p_score_fallback(): stamp the losing tier's method (it
  // is useful data in its own right, and it is what makes the row claimable
  // immediately instead of waiting out the claim query's 30s race guard) and
  // leave status='pending' exactly as enqueue left it.
  async function defer(method) {
    try {
      await patchQueueRow(row.id, { score_method: method })
    } catch (e) {
      console.error("[upload] defer patch failed:", e.message)
    }
    return res.json({ pending: true })
  }

  let buffer
  try {
    const objectUrl = SUPABASE_URL + "/storage/v1/object/" + UPLOAD_BUCKET + "/" +
      String(row.object_path).split("/").map(encodeURIComponent).join("/")
    const r = await axios.get(objectUrl, { headers: serviceHeaders(), responseType: "arraybuffer", timeout: 15000 })
    buffer = Buffer.from(r.data)
  } catch (e) {
    // Transient: leave the row pending, the worker will pick it up. The
    // physician sees "กำลังตรวจสอบ" rather than an error they can't act on.
    console.error("[upload] object download failed:", e.response ? e.response.status : e.message)
    return res.json({ pending: true })
  }

  // Everything from here runs behind the zip-entry/size guard and the parse
  // timeout (§7.7 rec 3, §11): the guard bounds memory, the timeout bounds
  // CPU, and a file that trips either is deferred or rejected rather than
  // left holding the request open against Vercel's execution limit.
  const score = require("./lib/p4p-score")
  let rows
  try {
    ({ rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: monthNum, timeoutMs: 7000 }))
  } catch (e) {
    if (e.code === "PARSE_TIMEOUT") return defer("parse timeout (deferred to worker)")
    console.warn("[upload] parse failed (" + (e.code || "parse_error") + "): " + e.message)
    return reject("other", "ไม่สามารถอ่านไฟล์ได้: " + e.message)
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
  const inferredMonth = score.resolveBeMonth(row.filename || "", "", "")
  const inferredYear = score.resolveBeYear(row.filename || "", "", "") || score.resolveBeYearFromRows(rows)
  if ((inferredMonth && inferredMonth !== monthNum) || (inferredYear && inferredYear !== beYear)) {
    const inferredKey = String(inferredYear || beYear) + "_" + String(inferredMonth || monthNum).padStart(2, "0")
    return reject("month_mismatch", "ไฟล์ระบุเดือน " + inferredKey + " แต่เลือกส่งเดือน " + monthKey)
  }

  const { score: value, method } = score.resolveScore(rows)

  // The confidence gate (§7.7 rec 1). Two conditions, not one: a confident
  // score is necessary but not sufficient — saveScore() throws outright on a
  // null roster index, and resolving that is matchName()'s job, in the
  // worker, by design.
  if (!score.isHighConfidence(method) || row.roster_index === null || row.roster_index === undefined) {
    return defer(method)
  }
  if (!(value > 0)) {
    return reject("zero_score", "ไม่พบคะแนนรวมในไฟล์")
  }

  // The roster row is the canonical spelling of the name and department —
  // p4p_submissions is keyed on it, and so is the Drive filename the worker
  // will use later.
  let rosterRow = null
  try {
    const r = await axios.get(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(monthKey) +
        "?index=eq." + encodeURIComponent(row.roster_index) + "&select=index,prefix,firstname,lastname,department",
      { headers: serviceHeaders(), timeout: 8000 }
    )
    rosterRow = (r.data && r.data[0]) || null
  } catch (e) {
    console.error("[upload] roster lookup failed:", e.response ? JSON.stringify(e.response.data) : e.message)
  }
  if (!rosterRow) return defer(method)

  const matchedName = [rosterRow.firstname, rosterRow.lastname].filter(Boolean).join(" ").trim()
  const department = rosterRow.department || row.department || ""
  const submittedAt = new Date(row.received_at).toISOString()

  try {
    // saveScore(): the score column on the month's roster row. `Prefer:
    // return=representation` so a filter that matched nothing surfaces here
    // rather than being reported to the physician as saved.
    const saved = await axios.patch(
      SUPABASE_URL + "/rest/v1/" + encodeURIComponent(monthKey) + "?index=eq." + encodeURIComponent(row.roster_index),
      { score: value, submitted_at: submittedAt },
      { headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }), timeout: 8000 }
    )
    if (!saved.data || saved.data.length === 0) throw new Error("no roster row matched index " + row.roster_index)
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
    // The score is already in the roster table; losing this write means the
    // worker re-scores the row later and writes the same number again.
    console.error("[upload] queue completion patch failed:", e.message)
  }

  const displayName = [rosterRow.prefix, matchedName].filter(Boolean).join(" ").trim()
  res.json({
    score: Number(value.toFixed(2)),
    month_key: monthKey,
    is_late: isLateUpload(monthKey, row.received_at),
    display_date: receipt.displayMonth(monthKey),
    display_name: displayName,
    department,
    received_at: submittedAt,
  })
})

app.use("/status", express.static("status"))
app.use("/list", express.static("list"))
app.use("/ranking", express.static("ranking"))
app.use("/verify", express.static("verify"))
app.use("/admin", express.static("admin"))
app.use("/assets", express.static("assets"))
app.use("/upload", express.static("upload"))
// /lib holds the one browser-loadable module that main.js also require()s
// (lib/line-receipt-flex.js — see its header). Nothing here is gated: it is
// the same Flex-building code the bot itself sends, with no data in it.
app.use("/lib", express.static("lib"))

app.post("/line", line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err)
      res.status(500).end()
    })
})

// The chat-side answer for one queue row, whatever state it is in (§7.5
// step ④). A missing row is answered too — "nothing here yet" is a real
// answer to a tap, and silence looks like a broken button.
function buildUploadResultMessage(row) {
  if (!row) return { type: "text", text: "ยังไม่พบไฟล์ที่ส่งเข้ามาในระบบ" }
  if (row.status === "done") {
    return receipt.buildScoreReceipt({
      displayName: row.full_name,
      department: row.department,
      monthKey: row.month_key,
      score: row.score,
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

const handleEvent = async (event) => {
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
    let row = null
    if (/^[0-9a-f-]{36}$/i.test(queueId)) {
      try {
        row = await fetchQueueRow("id=eq." + encodeURIComponent(queueId))
      } catch (e) {
        console.error("[upload] postback lookup failed:", e.message)
      }
    }
    // Defence in depth: this postback came from a button the bot itself sent
    // over a signature-verified webhook, so the id is not attacker-chosen —
    // but the row names its owner, so check it rather than assume it.
    if (row && row.line_user_id !== event.source.userId) row = null
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildUploadResultMessage(row)],
    })
  }

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
  // §7.5 step ②: the upload page sends this line as the physician, which is
  // what earns the bot a free reply. THE TEXT IS A TRIGGER, NOT DATA — the
  // row is resolved from source.userId, never from what the message says. A
  // physician who types it by hand gets the same answer, so this doubles as
  // a free status command.
  if (message.startsWith("ส่งไฟล์ p4p") || message === "ดูผลคะแนน" || message === "ผลคะแนน") {
    let row = null
    try {
      row = await fetchQueueRow(
        "line_user_id=eq." + encodeURIComponent(event.source.userId) + "&order=received_at.desc&limit=1"
      )
    } catch (e) {
      console.error("[upload] trigger lookup failed:", e.message)
    }
    const stillWorking = row && (row.status === "pending" || row.status === "processing")
    return client.replyMessage({
      "replyToken": event.replyToken,
      "messages": [
        stillWorking
          ? receipt.buildPendingBubble({ monthKey: row.month_key, queueId: row.id, ack: true })
          : buildUploadResultMessage(row),
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

