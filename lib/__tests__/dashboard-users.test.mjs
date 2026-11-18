/**
 * The dashboard's users and rights, and the QR invite (Pong, 2026-11-18:
 * "Go QR"): main.ts's real routes, loaded in-process with axios replaced
 * by a fake, as in server-routes.test.mjs. Nothing leaves the machine.
 *
 * Every LINE ID here is synthetic and built at run time; no real ID, name
 * or picture is in this file (the repository is public).
 */
import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// ── Synthetic people ───────────────────────────────────────────────────────
const OWNER = "U" + "a".repeat(32)
const ENV_USER = "U" + "b".repeat(32)     // in DASHBOARD_LINE_USER_IDS, like กานดา today
const QR_USER = "U" + "c".repeat(32)      // added with a QR
const STRANGER = "U" + "d".repeat(32)
const ORIGIN = "https://p4p.example.test"

Object.assign(process.env, {
  LINE_CHANNEL_SECRET: "test-line-secret",
  LINE_ACCESS_TOKEN: "test-line-token",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  ADMIN_LINE_USER_ID: OWNER,
  LINE_LOGIN_CHANNEL_SECRET: "test-login-secret",
  DASHBOARD_LINE_USER_IDS: OWNER + "," + ENV_USER,
  ADMIN_BASE_URL: ORIGIN,
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_CHAT_ID: "test-chat",
})

// Time moves on between tests so the 30 s users cache is read again.
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew
const later = (ms) => { skew += ms }

// ── Fake axios ─────────────────────────────────────────────────────────────
const SUPA = "https://zjeizbrzcltkgtlmkbji.supabase.co"
let calls = []
let scenario = {}
const httpError = (status, data = {}) => Object.assign(new Error("HTTP " + status), { response: { status, data } })
const NOT_INSTALLED = () => httpError(404, { code: "PGRST205", message: "Could not find the table" })
const rpcName = (url) => url.slice((SUPA + "/rest/v1/rpc/").length)

const fakeAxios = {
  async get(url) {
    calls.push(["get", url])
    if (url.startsWith(SUPA + "/rest/v1/dashboard_users?")) {
      if (scenario.usersError) throw scenario.usersError
      if (!scenario.users) throw NOT_INSTALLED()
      return { data: scenario.users }
    }
    if (url.startsWith(SUPA + "/rest/v1/dashboard_invites?")) {
      if (!scenario.users) throw NOT_INSTALLED()
      return { data: scenario.invites || [] }
    }
    if (url.startsWith(SUPA + "/rest/v1/dashboard_followups?")) return { data: [] }
    if (url.startsWith(SUPA + "/rest/v1/dept_staffing?")) return { data: [] }
    if (url.startsWith(SUPA + "/rest/v1/review_inputs?")) return { data: [] }
    if (url.startsWith(SUPA + "/rest/v1/access_requests?")) return { data: [] }
    if (/^https:[/][/][^/]+[/]rest[/]v1[/]\d{4}_\d{2}[?]/.test(url)) return { data: [{ firstname: "Somchai", lastname: "P.", submitted_at: null }] }
    throw new Error("unexpected GET " + url)
  },
  async post(url, body) {
    calls.push(["post", url, body])
    if (url === SUPA + "/rest/v1/dashboard_audit_log") return { data: null }
    if (url.startsWith("https://api.telegram.org/")) return { data: { ok: true } }
    if (url === "https://api.line.me/oauth2/v2.1/token") return { data: { id_token: "fake-id-token" } }
    if (url === "https://api.line.me/oauth2/v2.1/verify") return { data: scenario.lineProfile }
    if (url === SUPA + "/rest/v1/dashboard_followups") return { data: [{ id: 7, note: "", logged_by: "x", created_at: "2026-11-18T00:00:00Z", physician_name: "Somchai P." }] }
    if (url.startsWith(SUPA + "/rest/v1/rpc/")) {
      const fn = rpcName(url)
      if (fn === "admin_list_roster_tables") return { data: ["2569_10"] }
      if (fn === "review_months") return { data: [] }
      if (scenario.rpc && scenario.rpc[fn]) return { data: await scenario.rpc[fn](body) }
      throw httpError(404, { code: "PGRST202", message: "Could not find the function" })
    }
    throw new Error("unexpected POST " + url)
  },
  async patch(url, body) { calls.push(["patch", url, body]); return { data: [{}] } },
  async delete(url) {
    calls.push(["delete", url])
    return { data: [{ id: 7, month_key: "2569_10", roster_index: "x", physician_name: "Somchai P.", channel: "phone", note: "", logged_by: "x", created_at: "2026-11-18T00:00:00Z" }] }
  },
}
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
beforeEach(() => { calls = []; scenario = {}; later(31 * 1000) })

// ── Helpers ────────────────────────────────────────────────────────────────
const sign = (o) => {
  const body = Buffer.from(JSON.stringify(o)).toString("base64url")
  return body + "." + crypto.createHmac("sha256", "dash:" + process.env.LINE_LOGIN_CHANNEL_SECRET).update(body).digest("base64url")
}
const dashCookie = (sub, name = "Someone") => {
  const now = Math.floor(Date.now() / 1000)
  return "p4p_dash=" + sign({ sub, name, exp: now + 3600, idle: now + 600 })
}
function request(path, { method = "GET", cookie, body, origin } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (origin) headers.origin = origin
  if (body !== undefined) headers["content-type"] = "application/json"
  return fetch(base + path, { method, headers, redirect: "manual", body: body === undefined ? undefined : JSON.stringify(body) })
}
const row = (sub, perms, extra = {}) => ({ line_user_id: sub, display_name: "Somchai P.", line_name: "Somchai", perms, active: true, ...extra })
const audits = () => calls.filter(([v, u]) => v === "post" && u === SUPA + "/rest/v1/dashboard_audit_log").map((c) => c[2])
const telegrams = () => calls.filter(([v, u]) => v === "post" && u.startsWith("https://api.telegram.org/")).map((c) => JSON.stringify(c[2]))
const rpcCalls = (fn) => calls.filter(([v, u]) => v === "post" && u === SUPA + "/rest/v1/rpc/" + fn).map((c) => c[2])
const session = async (sub) => {
  const r = await request("/dashboard/api/session", { cookie: dashCookie(sub) })
  return r.status === 200 ? r.json() : r.status
}

const PRESETS = {
  author: ["followup.edit", "followup.view", "review.auditee", "roster.view", "staffing.view"],
  viewOnly: ["followup.view", "roster.view", "staffing.view"],
  clear: [],
}
const IDX = "11111111-2222-4333-8444-555555555555"
// [label, path, method, right needed (null: everyone)]
const ROUTES = [
  ["ตามส่ง history", "/dashboard/api/followups?month=2569_10&index=" + IDX + "&channel=phone", "GET", "followup.view"],
  ["ตามส่ง add", "/dashboard/api/followups", "POST", "followup.edit"],
  ["ตามส่ง delete", "/dashboard/api/followups/7", "DELETE", "followup.edit"],
  ["รายชื่อ months", "/dashboard/api/roster", "GET", "roster.view"],
  ["อัตรากำลัง", "/dashboard/api/staffing", "GET", "staffing.view"],
  ["ตรวจสอบ months", "/dashboard/api/review/months", "GET", "review.auditee"],
  ["ภาพรวม", "/dashboard/api/overview", "GET", null],
  ["ภาพรวม pending", "/dashboard/api/pending?month=2569_10", "GET", null],
]
const call = (sub, [, path, method]) => request(path, {
  method, cookie: dashCookie(sub),
  body: method === "POST" ? { month: "2569_10", index: IDX, channel: "phone", note: "" } : undefined,
})

// ── Who gets what ──────────────────────────────────────────────────────────

test("before the SQL is in: the owner has everything, the env user today's set, a stranger nothing", async () => {
  const o = await session(OWNER)
  assert.equal(o.isOwner, true)
  assert.deepEqual(o.perms, PRESETS.author)
  assert.equal(o.usersInstalled, false)
  const e = await session(ENV_USER)
  assert.equal(e.isOwner, false)
  assert.equal(e.reviewAuditee, true)
  assert.deepEqual(e.perms, PRESETS.author, "LEGACY = the ผู้จัดทำ preset")
  assert.equal(await session(STRANGER), 401)
})

test("the env user keeps exactly today's access on every route while the table is missing", async () => {
  for (const r of ROUTES) assert.equal((await call(ENV_USER, r)).status, 200, r[0])
  // ...and the owner-only parts stay closed.
  for (const [path, method] of [
    ["/dashboard/api/audit", "GET"], ["/dashboard/api/access-requests", "GET"], ["/dashboard/api/users", "GET"],
    ["/dashboard/api/roster/2569_10", "POST"], ["/dashboard/api/staffing/MED", "PUT"],
  ]) {
    const r = await request(path, { method, cookie: dashCookie(ENV_USER), origin: ORIGIN, body: method === "GET" ? undefined : {} })
    assert.equal(r.status, 404, method + " " + path)
  }
})

test("a row beats the env var: a suspended env user is signed out at once", async () => {
  scenario.users = [row(ENV_USER, PRESETS.author, { active: false })]
  assert.equal(await session(ENV_USER), 401)
  assert.equal((await call(ENV_USER, ROUTES[0])).status, 401)
})

test("a QR user gets the rights in their row, and their shown name", async () => {
  scenario.users = [row(QR_USER, ["roster.view"], { display_name: "สมชาย" })]
  const s = await session(QR_USER)
  assert.deepEqual(s.perms, ["roster.view"])
  assert.equal(s.name, "สมชาย")
  assert.equal(s.reviewAuditee, false)
  assert.equal(s.isOwner, false)
  assert.equal("pendingUsers" in s, false, "only the owner gets the pending count")
})

for (const [preset, perms] of Object.entries(PRESETS)) {
  test("the path gate for the " + preset + " preset: 404 without the right, through with it", async () => {
    scenario.users = [row(QR_USER, perms)]
    for (const r of ROUTES) {
      const want = r[3] === null || perms.includes(r[3]) ? 200 : 404
      assert.equal((await call(QR_USER, r)).status, want, preset + ": " + r[0])
    }
  })
}

// Express routes ignore case and a trailing slash, so another spelling of a
// path reaches the same handler; it must be refused just the same.
const SPELLINGS = [
  ["GET", "/dashboard/api/Followups?month=2569_10&index=" + IDX + "&channel=phone", "followup.view"],
  ["GET", "/dashboard/API/followups?month=2569_10&index=" + IDX + "&channel=phone", "followup.view"],
  ["GET", "/Dashboard/api/followups/?month=2569_10&index=" + IDX + "&channel=phone", "followup.view"],
  ["POST", "/dashboard/api/FOLLOWUPS", "followup.edit"],
  ["POST", "/dashboard/api/followups/", "followup.edit"],
  ["DELETE", "/dashboard/api/Followups/7", "followup.edit"],
  ["DELETE", "/dashboard/api/followups/7/", "followup.edit"],
  ["GET", "/dashboard/api/Roster", "roster.view"],
  ["GET", "/dashboard/api/roster/", "roster.view"],
  ["GET", "/dashboard/api/ROSTER/2569_10", "roster.view"],
  ["GET", "/dashboard/api/staffing/", "staffing.view"],
  ["GET", "/dashboard/api/Staffing", "staffing.view"],
  ["GET", "/DASHBOARD/API/STAFFING/", "staffing.view"],
]
for (const preset of ["clear", "viewOnly"]) {
  test("the " + preset + " preset: another spelling of a path (case, trailing slash) is refused too", async () => {
    scenario.users = [row(QR_USER, PRESETS[preset])]
    for (const [method, path, need] of SPELLINGS) {
      calls = []
      const r = await request(path, {
        method, cookie: dashCookie(QR_USER),
        body: method === "POST" ? { month: "2569_10", index: IDX, channel: "phone", note: "" } : undefined,
      })
      const want = PRESETS[preset].includes(need) ? 200 : 404
      // With the right it reaches the handler (the fake has no columns RPC,
      // so the one-month roster read ends in its own 500, not in a 404).
      if (want === 200) assert.ok(r.status === 200 || (r.status === 500 && path.includes("/2569_10")), preset + ": " + method + " " + path + " " + r.status)
      else assert.equal(r.status, 404, preset + ": " + method + " " + path)
      if (want === 404) {
        const writes = calls.filter(([v, u]) => (v === "delete" || v === "post") && u === SUPA + "/rest/v1/dashboard_followups")
        assert.equal(writes.length, 0, "nothing written for " + method + " " + path)
      }
    }
  })
}

test("an absolute-form request target is gated like the plain path", async () => {
  scenario.users = [row(QR_USER, [])]
  const http = require("node:http")
  const port = server.address().port
  for (const p of ["/dashboard/api/roster", "/dashboard/api/staffing/", "/dashboard/api/Followups?month=2569_10&index=" + IDX + "&channel=phone"]) {
    const status = await new Promise((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "http://127.0.0.1:" + port + p, headers: { cookie: dashCookie(QR_USER) } },
        (res) => { res.resume(); ok(res.statusCode) })
      req.on("error", fail)
      req.end()
    })
    assert.equal(status, 404, "absolute-form " + p)
  }
})

test("a failed read keeps the copy for 10 minutes, then the table's users are refused (owner and env users still in)", async () => {
  scenario.users = [row(QR_USER, PRESETS.viewOnly), row(ENV_USER, PRESETS.author, { active: false })]
  assert.equal(typeof (await session(QR_USER)), "object")
  scenario.usersError = httpError(503, { message: "busy" })
  later(5 * 60 * 1000)
  assert.equal(typeof (await session(QR_USER)), "object", "5 minutes: the last good copy")
  later(6 * 60 * 1000)
  assert.equal(await session(QR_USER), 401, "11 minutes: fail closed")
  assert.equal(await session(ENV_USER), 401, "a suspension in the old copy still holds")
  assert.equal(typeof (await session(OWNER)), "object")
})

// ── The users API is the owner's ───────────────────────────────────────────

test("non-owners get 404 on every /api/users route, and no session gets 401", async () => {
  scenario.users = [row(QR_USER, PRESETS.author)]
  const routes = [
    ["/dashboard/api/users", "GET"], ["/dashboard/api/users/invites", "POST"],
    ["/dashboard/api/users/invites/" + IDX, "GET"], ["/dashboard/api/users/invites/" + IDX + "/approve", "POST"],
    ["/dashboard/api/users/invites/" + IDX + "/reject", "POST"], ["/dashboard/api/users/invites/" + IDX + "/cancel", "POST"],
    ["/dashboard/api/users/" + QR_USER, "PATCH"],
  ]
  for (const [path, method] of routes) {
    const body = method === "GET" ? undefined : {}
    for (const sub of [ENV_USER, QR_USER]) {
      assert.equal((await request(path, { method, cookie: dashCookie(sub), origin: ORIGIN, body })).status, 404, sub.slice(0, 2) + " " + method + " " + path)
    }
    assert.equal((await request(path, { method, origin: ORIGIN, body })).status, 401, method + " " + path)
  }
  assert.equal(calls.some(([, u]) => u.includes("/rpc/dashboard_invite")), false)
})

test("the owner's writes must come from this site", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_create: () => ({ id: IDX, expires_at: new Date(Date.now() + 600000).toISOString() }) }
  assert.equal((await request("/dashboard/api/users/invites", { method: "POST", cookie: dashCookie(OWNER), body: {} })).status, 403)
  assert.equal((await request("/dashboard/api/users/invites", { method: "POST", cookie: dashCookie(OWNER), origin: "https://evil.example", body: {} })).status, 403)
  assert.equal(rpcCalls("dashboard_invite_create").length, 0)
})

test("a new QR: a one-time token, only its hash stored, the QR as an image, nothing secret logged", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_create: () => ({ id: IDX, expires_at: new Date(Date.now() + 600000).toISOString() }) }
  const r = await request("/dashboard/api/users/invites", { method: "POST", cookie: dashCookie(OWNER), origin: ORIGIN, body: {} })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("cache-control"), "no-store")
  const out = await r.json()
  assert.equal(out.id, IDX)
  assert.match(out.qr, /^data:image[/]svg[+]xml;base64,/)
  assert.equal("url" in out || "token" in out, false)
  const [args] = rpcCalls("dashboard_invite_create")
  assert.equal(args.p_actor, OWNER)
  assert.match(args.p_token_hash, /^[0-9a-f]{64}$/)
  const a = audits().find((x) => x.action === "user.invite")
  assert.deepEqual(a.target, { invite: IDX.slice(0, 8) })
})

// ── The phone ──────────────────────────────────────────────────────────────

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex")
// The card itself, from inside <main> (not a mention of the text anywhere
// else in the page, such as a CSS comment).
const mainOf = (html) => {
  const m = html.match(/<main>\s*(<section class="card">[\s\S]*<\/section>)\s*<\/main>/)
  assert.ok(m, "the card is inside <main>")
  assert.ok(!html.includes("__JOIN_"), "no placeholder is left")
  return m[1]
}

test("the landing page only peeks at the QR and links to LINE with the token", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_peek: () => ({ status: "open" }) }
  const r = await request("/dashboard/join?i=" + TOKEN)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("referrer-policy"), "no-referrer")
  const html = await r.text()
  assert.match(mainOf(html), /ขอเข้าใช้งานแดชบอร์ด P4P/)
  assert.ok(html.includes('href="/dashboard/auth/line?join=' + TOKEN + '"'))
  assert.equal(rpcCalls("dashboard_invite_peek")[0].p_token_hash, sha(TOKEN))
  assert.equal(rpcCalls("dashboard_invite_claim").length, 0, "a link preview cannot use the QR up")
  assert.doesNotMatch(html, /<script/)
})

test("the landing page: fixed cards for a used, expired or malformed QR", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_peek: () => ({ status: "used" }) }
  assert.match(mainOf(await (await request("/dashboard/join?i=" + TOKEN)).text()), /QR นี้ถูกใช้แล้ว/)
  scenario.rpc = { dashboard_invite_peek: () => ({ status: "expired" }) }
  assert.match(await (await request("/dashboard/join?i=" + TOKEN)).text(), /QR นี้หมดอายุแล้ว/)
  assert.match(await (await request("/dashboard/join?i=%3Cscript%3E")).text(), /QR ไม่ถูกต้อง/)
  const echo = await (await request("/dashboard/join/done?e=%3Cb%3Ehi")).text()
  assert.doesNotMatch(echo, /<b>hi/, "?e= picks a fixed card, never echoed")
  assert.equal((await request("/dashboard/join.html")).status, 404, "the raw template stays hidden")
})

async function startJoin() {
  const r = await request("/dashboard/auth/line?join=" + TOKEN)
  assert.equal(r.status, 302)
  const loc = new URL(r.headers.get("location"))
  assert.equal(loc.origin + loc.pathname, "https://access.line.me/oauth2/v2.1/authorize")
  assert.equal(loc.searchParams.get("scope"), "profile openid")
  assert.equal(loc.search.includes(TOKEN), false, "the token never goes to LINE")
  const state = loc.searchParams.get("state")
  assert.match(state, /^j[.][0-9a-f]{32}$/)
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0]
  return { state, cookie }
}

test("the join callback passes LINE's verified ID to the claim and never signs the phone in", async () => {
  scenario.users = []
  scenario.lineProfile = { sub: QR_USER, name: "Somchai P.", picture: "https://profile.line-scdn.net/abc" }
  scenario.rpc = { dashboard_invite_claim: () => ({ result: "ok", id: IDX }) }
  const { state, cookie } = await startJoin()
  const r = await request("/dashboard/auth/callback?code=c0de&state=" + state, { cookie })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), "/dashboard/join/wait")
  const setCookie = r.headers.get("set-cookie") || ""
  assert.doesNotMatch(setCookie, /p4p_dash=[^;]/, "no dashboard session from a join")
  assert.match(setCookie, /p4p_join=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=[/]dashboard[/]join/)
  const [args] = rpcCalls("dashboard_invite_claim")
  assert.equal(args.p_sub, QR_USER)
  assert.equal(args.p_token_hash, sha(TOKEN))
  assert.match(args.p_code, /^[0-9]{4}$/)
  assert.equal(args.p_picture, "https://profile.line-scdn.net/abc")
  // The code is shown on the phone only: not in the log, not on Telegram.
  assert.equal(JSON.stringify(audits()).includes(args.p_code + '"'), false)
  for (const t of telegrams()) {
    assert.equal(t.includes(QR_USER), false)
    assert.equal(t.includes(TOKEN), false)
  }
  assert.equal(audits().find((a) => a.action === "user.claim").actor_line_id, QR_USER)

  // The phone cookie is not a session.
  const joinCookie = setCookie.match(/p4p_join=([^;]+)/)[1]
  assert.equal((await request("/dashboard/api/session", { cookie: "p4p_dash=" + joinCookie })).status, 401)

  // The wait page shows the code and refreshes itself.
  scenario.rpc = { dashboard_invite_status: () => ({ status: "scanned", code: "4719", name: "Somchai P.", perms: [] }) }
  const w = await request("/dashboard/join/wait", { cookie: "p4p_join=" + joinCookie })
  const html = await w.text()
  assert.match(mainOf(html), /4719/)
  assert.match(html.slice(0, html.indexOf("</head>")), /http-equiv="refresh" content="5"/)
  assert.deepEqual(rpcCalls("dashboard_invite_status")[0], { p_id: IDX, p_sub: QR_USER })
  scenario.rpc = { dashboard_invite_status: () => ({ status: "approved", code: null, name: "Somchai P.", perms: PRESETS.viewOnly }) }
  const done = await (await request("/dashboard/join/wait", { cookie: "p4p_join=" + joinCookie })).text()
  assert.match(mainOf(done), /ได้รับอนุมัติแล้ว/)
  assert.match(done, /ตามส่ง [(]ดู[)] · รายชื่อ [(]ดู[)] · อัตรากำลัง [(]ดู[)]/)
  assert.doesNotMatch(done, /http-equiv="refresh"/)
})

test("a second scan of a used QR is refused, logged and alerted", async () => {
  scenario.users = []
  scenario.lineProfile = { sub: STRANGER, name: "Stranger" }
  scenario.rpc = { dashboard_invite_claim: () => ({ result: "used", id: IDX }) }
  const { state, cookie } = await startJoin()
  const r = await request("/dashboard/auth/callback?code=c0de&state=" + state, { cookie })
  assert.equal(r.headers.get("location"), "/dashboard/join/done?e=used")
  assert.equal(audits().find((a) => a.action === "user.claim_refused").target.reason, "used")
  assert.equal(telegrams().length, 1)
})

test("the owner or an existing user scanning is refused before the QR is touched", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_claim: () => ({ result: "ok", id: IDX }) }
  for (const [sub, e] of [[OWNER, "owner"], [ENV_USER, "already"]]) {
    scenario.lineProfile = { sub, name: "x" }
    const { state, cookie } = await startJoin()
    const r = await request("/dashboard/auth/callback?code=c0de&state=" + state, { cookie })
    assert.equal(r.headers.get("location"), "/dashboard/join/done?e=" + e)
  }
  assert.equal(rpcCalls("dashboard_invite_claim").length, 0)
})

test("a join that lost its state cookie goes to the phone card, not the desktop login", async () => {
  const r = await request("/dashboard/auth/callback?code=c0de&state=j.0123")
  assert.equal(r.headers.get("location"), "/dashboard/join/done?e=bad_state")
  const d = await request("/dashboard/auth/callback?error=access_denied&state=j.0123")
  assert.equal(d.headers.get("location"), "/dashboard/join/done?e=denied")
})

test("a normal sign-in: an env user is moved into the table once, with today's rights", async () => {
  scenario.users = []
  scenario.lineProfile = { sub: ENV_USER, name: "Dada" }
  scenario.rpc = { dashboard_user_import: () => ({ inserted: true }) }
  await request("/dashboard/api/session", { cookie: dashCookie(OWNER) }) // load the (empty, installed) table
  const r1 = await request("/dashboard/auth/line")
  const state = new URL(r1.headers.get("location")).searchParams.get("state")
  assert.match(state, /^[0-9a-f]{32}$/)
  const r = await request("/dashboard/auth/callback?code=c0de&state=" + state, { cookie: (r1.headers.get("set-cookie") || "").split(";")[0] })
  assert.equal(r.headers.get("location"), "/dashboard/")
  assert.match(r.headers.get("set-cookie") || "", /p4p_dash=[^;]/)
  const [args] = rpcCalls("dashboard_user_import")
  assert.equal(args.p_sub, ENV_USER)
  assert.equal(args.p_display_name, "กานดา")
  assert.deepEqual(audits().find((a) => a.action === "user.import").target, { perms: PRESETS.author })
})

// ── Approval ───────────────────────────────────────────────────────────────

test("approve takes the LINE ID from the invite row (none from the body), and a wrong code counts down to the lock", async () => {
  scenario.users = []
  let tries = 0
  scenario.rpc = {
    dashboard_invite_decide: (b) => {
      if (b.p_code !== "4719") {
        tries++
        return { result: tries >= 3 ? "locked" : "bad_code", tries_left: Math.max(0, 3 - tries) }
      }
      return { result: "ok", after: { line_user_id: QR_USER, display_name: "สมชาย", line_name: "Somchai", perms: PRESETS.viewOnly } }
    },
  }
  const approve = (code) => request("/dashboard/api/users/invites/" + IDX + "/approve", {
    method: "POST", cookie: dashCookie(OWNER), origin: ORIGIN,
    body: { code, perms: PRESETS.viewOnly, displayName: "สมชาย", sub: STRANGER, line_user_id: STRANGER },
  })
  const ok = await approve("4719")
  assert.equal(ok.status, 200)
  for (const args of rpcCalls("dashboard_invite_decide")) {
    assert.deepEqual(Object.keys(args).sort(), ["p_actor", "p_code", "p_decision", "p_display_name", "p_id", "p_perms"])
    assert.equal(JSON.stringify(args).includes(STRANGER), false)
  }
  const ap = audits().find((a) => a.action === "user.approve")
  assert.equal(ap.target.sub, QR_USER)
  assert.match(telegrams().join(), /เพิ่มผู้ใช้แดชบอร์ด: สมชาย/)
  assert.equal(telegrams().join().includes(QR_USER), false)

  calls = []
  const r1 = await approve("0000")
  assert.equal(r1.status, 400)
  assert.deepEqual(await r1.json(), { error: "bad_code", triesLeft: 2 })
  assert.deepEqual(await (await approve("1111")).json(), { error: "bad_code", triesLeft: 1 })
  const r3 = await approve("2222")
  assert.equal(r3.status, 409)
  assert.deepEqual(await r3.json(), { error: "locked", triesLeft: 0 })
  assert.equal(audits().filter((a) => a.action === "user.bad_code").length, 3)
  assert.match(telegrams().join(), /กรอกรหัสยืนยันผิด 3 ครั้ง/)
})

test("approve refuses a bad code shape, an unknown right or a blank name before the database", async () => {
  scenario.users = []
  scenario.rpc = { dashboard_invite_decide: () => ({ result: "ok", after: {} }) }
  for (const body of [
    { code: "47a9", perms: [], displayName: "x" },
    { code: "4719", perms: ["audit.view"], displayName: "x" },
    { code: "4719", perms: [], displayName: "   " },
    { code: "4719", perms: [], displayName: "x".repeat(61) },
  ]) {
    const r = await request("/dashboard/api/users/invites/" + IDX + "/approve", { method: "POST", cookie: dashCookie(OWNER), origin: ORIGIN, body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal(rpcCalls("dashboard_invite_decide").length, 0)
})

test("the owner's poll never sees the code or the whole LINE ID", async () => {
  scenario.users = []
  scenario.invites = [{
    id: IDX, status: "scanned", created_at: "2026-11-18T00:40:00Z", expires_at: new Date(Date.now() + 3600000).toISOString(),
    claimed_sub: QR_USER, claimed_name: "Somchai P.", claimed_picture: null, claimed_at: "2026-11-18T00:41:00Z",
    code_tries: 1, perms: null, decided_at: null, confirm_code: "4719",
  }]
  const r = await request("/dashboard/api/users/invites/" + IDX, { cookie: dashCookie(OWNER) })
  const out = await r.json()
  assert.equal(out.status, "scanned")
  assert.equal(out.claim.subTail, "cccc")
  assert.equal(out.triesLeft, 2)
  const text = JSON.stringify(out)
  assert.equal(text.includes(QR_USER), false)
  assert.equal(text.includes("4719"), false)
  const asked = calls.find(([, u]) => u.startsWith(SUPA + "/rest/v1/dashboard_invites?"))[1]
  assert.doesNotMatch(asked, /confirm_code/)
  assert.match(asked, new RegExp("created_by=eq." + OWNER))
})

test("suspend and edit: the owner cannot be edited, a suspension is logged as one", async () => {
  scenario.users = [row(QR_USER, PRESETS.viewOnly)]
  scenario.rpc = {
    dashboard_user_save: (b) => ({
      before: row(QR_USER, PRESETS.viewOnly),
      after: row(QR_USER, b.p_perms, { display_name: b.p_display_name, active: b.p_active }),
    }),
  }
  const patch = (sub, body) => request("/dashboard/api/users/" + sub, { method: "PATCH", cookie: dashCookie(OWNER), origin: ORIGIN, body })
  assert.equal((await patch(OWNER, { perms: [], displayName: "x", active: false })).status, 404)
  const r = await patch(QR_USER, { perms: PRESETS.viewOnly, displayName: "Somchai P.", active: false })
  assert.equal(r.status, 200)
  assert.deepEqual(audits().map((a) => a.action), ["user.suspend"])
  assert.match(telegrams().join(), /ระงับผู้ใช้ Somchai P[.]/)
  calls = []
  await patch(QR_USER, { perms: ["followup.edit"], displayName: "Somchai P.", active: true })
  assert.deepEqual(rpcCalls("dashboard_user_save")[0].p_perms, ["followup.edit", "followup.view"], "edit brings view")
  assert.equal(audits()[0].action, "user.edit")
})

test("the owner's session carries the pending count", async () => {
  scenario.users = []
  scenario.invites = [{ id: IDX }]
  const s = await session(OWNER)
  assert.equal(s.usersInstalled, true)
  assert.equal(s.pendingUsers, 1)
})
