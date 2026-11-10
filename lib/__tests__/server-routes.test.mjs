/**
 * main.ts's real routes, loaded in-process with axios replaced by a fake —
 * every Supabase call is answered here, nothing leaves the machine. (The
 * LINE webhook is not exercised: its replies go through the LINE SDK's own
 * HTTP client, which this fake does not cover.)
 *
 * Covers the session gate and the service-role /upload/* routes (F08) and
 * the access-request approval write (F13).
 *
 * node --test runs each file in its own process, so the env vars and the
 * axios stub set up below cannot leak into the other test files.
 */
import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// ── Environment: fake secrets only ─────────────────────────────────────────
const OWNER = "U" + "a".repeat(32)
Object.assign(process.env, {
  LINE_CHANNEL_SECRET: "test-line-secret",
  LINE_ACCESS_TOKEN: "test-line-token",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  ADMIN_LINE_USER_ID: OWNER,
  LINE_LOGIN_CHANNEL_SECRET: "test-login-secret",
})
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID
delete process.env.DASHBOARD_LINE_USER_IDS

// ── Fake axios ─────────────────────────────────────────────────────────────
const SUPA = "https://zjeizbrzcltkgtlmkbji.supabase.co"
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
// The token Supabase really issued. main.ts reads only its exp claim (to
// decide whether to refresh); the fake below is what "verifies" it.
const REAL_TOKEN_EMAIL = "doc.real@example.test"
const REAL_JWT = b64url({ alg: "HS256" }) + "." + b64url({ email: REAL_TOKEN_EMAIL, exp: 9999999999 }) + ".sig"
let calls = []
let scenario = {}
const httpError = (status, data = {}) => Object.assign(new Error("HTTP " + status), { response: { status, data } })
const netError = () => Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
const bearer = (opts) => String((opts && opts.headers && opts.headers.Authorization) || "").replace(/^Bearer /, "")

const fakeAxios = {
  async get(url, opts) {
    calls.push(["get", url])
    if (url === SUPA + "/auth/v1/user") {
      if (scenario.authUser) return scenario.authUser(bearer(opts))
      // Supabase Auth accepts only the token it issued.
      if (bearer(opts) === REAL_JWT) return { data: { email: "Doc.Real@Example.test" } }
      throw httpError(401, { msg: "invalid JWT" })
    }
    if (url.startsWith(SUPA + "/rest/v1/p4p_upload_queue?")) return { data: scenario.queueRows || [] }
    if (url.startsWith(SUPA + "/rest/v1/access_requests?")) return { data: scenario.requestRows || [] }
    if (url.startsWith(SUPA + "/rest/v1/physicians?")) return { data: scenario.physicianRows || [] }
    throw new Error("unexpected GET " + url)
  },
  async post(url, body, opts) {
    calls.push(["post", url, body])
    if (url === SUPA + "/rest/v1/rpc/is_current_user_allowlisted") {
      if (scenario.allowlist) return scenario.allowlist(bearer(opts))
      // PostgREST verifies the JWT signature before running the RPC.
      if (bearer(opts) === REAL_JWT) return { data: true }
      throw httpError(401, { code: "PGRST301", message: "JWSError JWSInvalidSignature" })
    }
    if (url.startsWith(SUPA + "/rest/v1/physicians")) {
      if (scenario.insertError) throw scenario.insertError
      return { data: null }
    }
    if (url === SUPA + "/rest/v1/dashboard_audit_log") return { data: null }
    throw new Error("unexpected POST " + url)
  },
  async patch(url, body) {
    calls.push(["patch", url, body])
    return { data: [{}] }
  },
}
// main.ts does `import axios from "axios"`; seed the module cache with the
// fake under the path that import resolves to, before main.ts is loaded.
const axiosPath = require.resolve("axios", { paths: [repoRoot] })
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios }

const app = require(resolve(repoRoot, "main.ts"))

let server
let base
before(async () => {
  await new Promise((ok) => { server = app.listen(0, "127.0.0.1", ok) })
  base = "http://127.0.0.1:" + server.address().port
})
after(() => new Promise((ok) => server.close(ok)))
beforeEach(() => { calls = []; scenario = {} })

// ── Helpers ────────────────────────────────────────────────────────────────
// A token whose claims say whatever the attacker wants; the signature is junk.
const forgedToken = (email) => b64url({ alg: "HS256", typ: "JWT" }) + "." +
  b64url({ email, exp: 9999999999, role: "authenticated" }) + ".not-a-signature"
const sessionCookie = (at) => "p4p_rt=" + encodeURIComponent(JSON.stringify({ at, rt: "refresh-x" }))
const QUEUE_ID = "11111111-2222-4333-8444-555555555555"
const pendingRow = (email) => ({
  id: QUEUE_ID, email, status: "pending", month_key: "2569_10", full_name: "Test Doctor",
  object_path: "x/y.xlsx", filename: "y.xlsx",
})

function request(path, { method = "GET", cookie, body } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers["content-type"] = "application/json"
  return fetch(base + path, {
    method, headers, redirect: "manual",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const touchedQueue = () => calls.some(([, url]) => url.includes("p4p_upload_queue"))
const realSession = () => sessionCookie(REAL_JWT)

// ── F08: the page gate ─────────────────────────────────────────────────────

test("a hand-written session cookie no longer opens a gated page", async () => {
  const r = await request("/status/", { cookie: sessionCookie(forgedToken("victim@example.test")) })
  assert.equal(r.status, 302)
  const loc = r.headers.get("location")
  assert.match(loc, /^\/verify\/\?return=%2Fstatus%2F&reason=expired#$/, "a refused token is an expired session, not a revoked account")
  assert.match(r.headers.get("set-cookie") || "", /p4p_rt=;/, "the bad cookie is cleared")
})

test("a real session still gets the page", async () => {
  const r = await request("/status/", { cookie: realSession() })
  assert.equal(r.status, 200)
  assert.match(await r.text(), new RegExp(REAL_JWT.replace(/[.]/g, "\\.")))
})

test("the gate still fails open on a network error or a 5xx", async () => {
  scenario.allowlist = () => { throw netError() }
  assert.equal((await request("/status/", { cookie: realSession() })).status, 200)
  scenario.allowlist = () => { throw httpError(503) }
  assert.equal((await request("/status/", { cookie: realSession() })).status, 200)
})

test("a 403 from the allowlist RPC is a refusal, and the RPC's own false is 'blocked'", async () => {
  scenario.allowlist = () => { throw httpError(403) }
  let r = await request("/status/", { cookie: realSession() })
  assert.equal(r.status, 302)
  assert.match(r.headers.get("location"), /reason=expired/)
  scenario.allowlist = () => ({ data: false })
  r = await request("/status/", { cookie: realSession() })
  assert.equal(r.headers.get("location"), "/verify/?reason=blocked#")
})

// ── F08: /upload/score and /upload/receipt ─────────────────────────────────

test("/upload/score refuses a forged token before touching the queue", async () => {
  scenario.queueRows = [pendingRow("victim@example.test")]
  const r = await request("/upload/score", {
    method: "POST", cookie: sessionCookie(forgedToken("victim@example.test")), body: { queue_id: QUEUE_ID },
  })
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error, "no_session")
  assert.equal(touchedQueue(), false, "no service-role read or write for an unverified caller")
})

test("/upload/receipt refuses a forged token before touching the queue", async () => {
  scenario.queueRows = [pendingRow("victim@example.test")]
  const r = await request("/upload/receipt", {
    method: "POST", cookie: sessionCookie(forgedToken("victim@example.test")),
    body: { queue_id: QUEUE_ID, reason: "send_failed" },
  })
  assert.equal(r.status, 401)
  assert.equal(touchedQueue(), false)
})

test("the upload routes take the caller's email from Supabase Auth, not from the token's claims", async () => {
  // The token claims the row owner's email, Supabase Auth says otherwise.
  scenario.authUser = () => ({ data: { email: "someone.else@example.test" } })
  scenario.allowlist = () => ({ data: true })
  scenario.queueRows = [pendingRow("victim@example.test")]
  const forged = sessionCookie(forgedToken("victim@example.test"))
  let r = await request("/upload/score", { method: "POST", cookie: forged, body: { queue_id: QUEUE_ID } })
  assert.equal(r.status, 403)
  r = await request("/upload/receipt", { method: "POST", cookie: forged, body: { queue_id: QUEUE_ID, reason: "sent" } })
  assert.equal(r.status, 403)
  assert.equal(calls.some(([verb]) => verb === "patch"), false)
})

test("the verified owner passes the ownership check, case-insensitively", async () => {
  scenario.queueRows = [pendingRow(REAL_TOKEN_EMAIL)]
  const r = await request("/upload/receipt", {
    method: "POST", cookie: realSession(), body: { queue_id: QUEUE_ID, reason: "sent" },
  })
  assert.equal(r.status, 200)
  assert.ok(calls.some(([verb, url]) => verb === "patch" && url.includes(QUEUE_ID)), "the receipt is stamped")
})

test("an Auth outage defers /upload/score without reading the queue", async () => {
  scenario.authUser = () => { throw netError() }
  scenario.queueRows = [pendingRow(REAL_TOKEN_EMAIL)]
  const r = await request("/upload/score", { method: "POST", cookie: realSession(), body: { queue_id: QUEUE_ID } })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { pending: true })
  assert.equal(touchedQueue(), false)
})

// ── F13: approval never rewrites an existing physician's name ──────────────

const ADMIN_KEY = process.env.LINE_CHANNEL_SECRET + ":" + process.env.SUPABASE_SERVICE_ROLE_KEY
function adminCookie() {
  const exp = Math.floor(Date.now() / 1000) + 600
  const sig = crypto.createHmac("sha256", ADMIN_KEY).update("session:" + exp).digest("hex")
  return "p4p_admin=" + exp + "." + sig
}
function dashCookie(sub) {
  const now = Math.floor(Date.now() / 1000)
  const body = Buffer.from(JSON.stringify({ sub, name: "Owner", exp: now + 3600, idle: now + 600 })).toString("base64url")
  const sig = crypto.createHmac("sha256", "dash:" + process.env.LINE_LOGIN_CHANNEL_SECRET).update(body).digest("base64url")
  return "p4p_dash=" + body + "." + sig
}
const physicianWrites = () => calls.filter(([verb, url]) => verb !== "get" && url.includes("/rest/v1/physicians"))

for (const [label, approve] of [
  ["/admin/", (email) => request("/admin/api/access-requests/" + encodeURIComponent(email) + "/approve", { method: "POST", cookie: adminCookie() })],
  ["/dashboard/", (email) => request("/dashboard/api/access-requests/" + encodeURIComponent(email) + "/approve", { method: "POST", cookie: dashCookie(OWNER) })],
]) {
  test(label + " approval re-activates an existing physician without touching full_name", async () => {
    scenario.requestRows = [{ name: "Tampered Name", department: "Medicine" }]
    scenario.physicianRows = [{ email: "doc@example.test", full_name: "Roster Name" }]
    const r = await approve("doc@example.test")
    assert.equal(r.status, 200)
    const writes = physicianWrites()
    assert.equal(writes.length, 1)
    const [verb, url, body] = writes[0]
    assert.equal(verb, "patch")
    assert.match(url, /physicians\?email=eq\.doc%40example\.test$/)
    assert.equal("full_name" in body, false, "the self-reported request name must not replace the roster name")
    assert.equal(body.active, true)
    assert.equal(body.department, "Medicine")
  })

  test(label + " approval of a request with no name never writes a NULL name", async () => {
    scenario.requestRows = [{ name: null, department: null }]
    scenario.physicianRows = [{ email: "doc@example.test", full_name: "Roster Name" }]
    assert.equal((await approve("doc@example.test")).status, 200)
    const [, , body] = physicianWrites()[0]
    assert.equal("full_name" in body, false)
    assert.equal("department" in body, false)
  })

  test(label + " approval of a new email inserts the requested name as before", async () => {
    scenario.requestRows = [{ name: "New Doctor", department: "Surgery" }]
    scenario.physicianRows = []
    assert.equal((await approve("new@example.test")).status, 200)
    const writes = physicianWrites()
    assert.equal(writes.length, 1)
    const [verb, url, body] = writes[0]
    assert.equal(verb, "post")
    assert.doesNotMatch(url, /on_conflict/, "a plain insert, so a concurrent row is never merged over")
    assert.equal(body.full_name, "New Doctor")
    assert.equal(body.department, "Surgery")
    assert.equal(body.active, true)
  })
}

test("an existing physician with a blank name gets the requested one", async () => {
  scenario.requestRows = [{ name: "Filled Name", department: null }]
  scenario.physicianRows = [{ email: "doc@example.test", full_name: "  " }]
  assert.equal((await request("/admin/api/access-requests/doc%40example.test/approve", { method: "POST", cookie: adminCookie() })).status, 200)
  assert.equal(physicianWrites()[0][2].full_name, "Filled Name")
})

test("/admin/ approval needs an open request", async () => {
  scenario.requestRows = []
  const r = await request("/admin/api/access-requests/doc%40example.test/approve", { method: "POST", cookie: adminCookie() })
  assert.equal(r.status, 404)
  assert.equal(physicianWrites().length, 0)
})

test("an insert that loses a race to a concurrent row falls back to the update", async () => {
  scenario.requestRows = [{ name: "Tampered Name", department: null }]
  scenario.physicianRows = []
  scenario.insertError = httpError(409, { code: "23505", message: "duplicate key" })
  assert.equal((await request("/admin/api/access-requests/doc%40example.test/approve", { method: "POST", cookie: adminCookie() })).status, 200)
  const writes = physicianWrites()
  assert.deepEqual(writes.map(([verb]) => verb), ["post", "patch"])
  assert.equal("full_name" in writes[1][2], false)
})
