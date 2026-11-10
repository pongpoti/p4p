/**
 * Guards in main.ts (and the /verify/ page) that decide who gets in and
 * where they are sent: the owner LINE userId check, the session gate's
 * handling of Supabase errors, where the service-role upload routes take the
 * caller's email from, the access-request approval write, the /verify/
 * return target, and the Bangkok month used by the LINE status list.
 *
 * main.ts is an Express app whose only export is the app itself, so — as in
 * upload-helpers.test.mjs — each function is lifted out of the source by
 * name, transpiled, and run with its free variables passed in. A rename in
 * main.ts fails here loudly rather than silently testing nothing.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import ts from "typescript"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8")

/** The source text of the function declaration `name`, found with the TS parser. */
function sliceFunction(source, name, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let found = null
  const visit = (node) => {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) found = node
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!found) throw new Error(file + " no longer defines " + name + " — re-point this test")
  return source.slice(found.getStart(sf), found.end)
}

/**
 * Compile the named functions from `file` together and return them, with
 * `scope` supplying every free variable they read (constants, axios, …).
 */
function load(file, names, scope = {}) {
  const source = read(file)
  const snippet = names.map((n) => sliceFunction(source, n, file)).join("\n")
  const { outputText } = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const keys = Object.keys(scope)
  const factory = new Function(...keys, `${outputText}; return { ${names.join(", ")} }`)
  return factory(...keys.map((k) => scope[k]))
}

// ── F27: the owner LINE userId is env-only and fails closed ────────────────

test("no LINE userId literal is committed in main.ts or web/lib/config.ts", () => {
  for (const file of ["main.ts", "web/lib/config.ts"]) {
    const hits = read(file).match(/\bU[0-9a-f]{32}\b/g) || []
    assert.deepEqual(hits, [], file + " must read the owner's LINE userId from the environment only")
  }
})

test("with ADMIN_LINE_USER_ID unset, nobody is the owner — not even an event with no userId", () => {
  const { isOwnerLineUserId } = load("main.ts", ["isOwnerLineUserId"], { ADMIN_LINE_USER_ID: "" })
  for (const id of [undefined, null, "", "U" + "0".repeat(32)]) {
    assert.equal(isOwnerLineUserId(id), false, "unset owner must not match " + JSON.stringify(id))
  }
})

test("with ADMIN_LINE_USER_ID set, only that exact userId is the owner", () => {
  const owner = "U" + "a".repeat(32)
  const { isOwnerLineUserId } = load("main.ts", ["isOwnerLineUserId"], { ADMIN_LINE_USER_ID: owner })
  assert.equal(isOwnerLineUserId(owner), true)
  assert.equal(isOwnerLineUserId("U" + "b".repeat(32)), false)
  assert.equal(isOwnerLineUserId(undefined), false)
})

test("every owner check in main.ts goes through isOwnerLineUserId", () => {
  const source = read("main.ts")
  // The constant may be read where it is defined, in the helper, and as the
  // dashboard allowlist's fallback; any other comparison against it would
  // bypass the fail-closed check.
  const comparisons = source.match(/[!=]==\s*ADMIN_LINE_USER_ID\b|\bADMIN_LINE_USER_ID\s*[!=]==/g) || []
  assert.equal(comparisons.length, 1, "only isOwnerLineUserId may compare against ADMIN_LINE_USER_ID")
  assert.match(source, /const isDashOwner = \(sub: string\): boolean => isOwnerLineUserId\(sub\)/)
  assert.match(source, /if \(!isOwnerLineUserId\(event\.source\.userId\)\) return/)
})

// ── F08: only an outage is a reason to fail open ───────────────────────────

test("isTransientSupabaseError: no response or a 5xx is an outage, any 4xx is an answer", () => {
  const { isTransientSupabaseError } = load("main.ts", ["isTransientSupabaseError"])
  const withStatus = (status) => ({ response: { status, data: {} } })
  assert.equal(isTransientSupabaseError(new Error("connect ECONNREFUSED")), true)
  assert.equal(isTransientSupabaseError(Object.assign(new Error("timeout"), { code: "ECONNABORTED" })), true)
  for (const s of [500, 502, 503, 504]) assert.equal(isTransientSupabaseError(withStatus(s)), true, String(s))
  for (const s of [400, 401, 403, 404]) assert.equal(isTransientSupabaseError(withStatus(s)), false, String(s))
})

test("no upload route reads identity from the token's unverified claims", () => {
  const source = read("main.ts")
  assert.doesNotMatch(source, /jwtPayload\(at\)/)
  for (const route of ["/upload/score", "/upload/receipt"]) {
    const start = source.indexOf('app.post("' + route + '"')
    assert.notEqual(start, -1, route + " not found")
    const body = source.slice(start, source.indexOf("\napp.", start + 1))
    assert.match(body, /const callerEmail = caller\.email\b/, route + " must take callerEmail from verifiedUserEmail()")
  }
})

// ── F15: the /verify/ return target stays on this origin ───────────────────

test("safeReturnTarget keeps same-origin paths and refuses everything else", () => {
  const origin = "https://p4p.example.test"
  const { safeReturnTarget } = load("verify/app.ts", ["safeReturnTarget"])
  const keep = {
    "/status/": "/status/",
    "%2Fstatus%2F": "/status/",
    "/list/?sheetname=2569_10&color=bg-sky-300": "/list/?sheetname=2569_10&color=bg-sky-300",
    "/upload/#top": "/upload/#top",
  }
  for (const [raw, want] of Object.entries(keep)) assert.equal(safeReturnTarget(raw, origin), want, raw)
  const refuse = [
    "/\t/evil.example", // the reported bypass: the URL parser drops the tab
    "/\n\\evil.example",
    "/%09/evil.example", // the same tab, still encoded once
    "/\r/evil.example",
    "//evil.example",
    "/\\evil.example",
    "///evil.example",
    "/.//evil.example", // dot segment resolved away, leaving "//evil.example"
    "/..//evil.example",
    "/%2E//evil.example",
    "https://evil.example/",
    origin + "/status/", // absolute, even same-origin: callers only ever send a path
    "javascript:alert(1)",
    "status/",
    "/a\u0085b", // C1 control
    "/a\u007fb",
    "%E0%A4%A", // malformed escape
    "",
  ]
  for (const raw of refuse) assert.equal(safeReturnTarget(raw, origin), "/status/", JSON.stringify(raw))
})

test("whatever safeReturnTarget returns resolves to this origin", () => {
  const origin = "https://p4p.example.test"
  const { safeReturnTarget } = load("verify/app.ts", ["safeReturnTarget"])
  const pieces = ["/", "//", "\\", "\t", "\n", "%2F", "%5C", "%09", "%2E", ".", "..", "evil.example", "status", "?", "#", "@", ":"]
  // Every 3-piece combination, each checked the way the browser will use it
  // (location.replace resolves it against the page's own URL).
  for (const a of pieces) for (const b of pieces) for (const c of pieces) {
    const raw = a + b + c
    const out = safeReturnTarget(raw, origin)
    assert.ok(out.startsWith("/") && !out.startsWith("//"), JSON.stringify(raw) + " -> " + out)
    assert.equal(new URL(out, origin + "/verify/").origin, origin, JSON.stringify(raw) + " -> " + out)
  }
})

test("the compiled verify/app.js carries the same check", () => {
  const { safeReturnTarget } = load("verify/app.js", ["safeReturnTarget"])
  assert.equal(safeReturnTarget("/\t/evil.example", "https://p4p.example.test"), "/status/")
  assert.equal(safeReturnTarget("/.//evil.example", "https://p4p.example.test"), "/status/")
  assert.equal(safeReturnTarget("/ranking/", "https://p4p.example.test"), "/ranking/")
})

// ── F22: the LINE status list follows the Bangkok calendar ─────────────────

test("bangkokMonthAndBeYear turns over at Bangkok midnight, not UTC midnight", () => {
  const { bangkokMonthAndBeYear } = load("main.ts", ["bangkokMonthAndBeYear"])
  const at = (iso) => bangkokMonthAndBeYear(Date.parse(iso))
  // 02:00 on 1 Dec 2569 in Bangkok is still 30 Nov in UTC.
  assert.deepEqual(at("2026-11-30T19:00:00Z"), { month: 11, beYear: 2569 })
  assert.deepEqual(at("2026-11-30T16:59:59Z"), { month: 10, beYear: 2569 }, "23:59:59 Bangkok is still November")
  assert.deepEqual(at("2026-11-30T17:00:00Z"), { month: 11, beYear: 2569 }, "00:00 Bangkok is December")
  // New Year: 00:30 on 1 Jan 2570 in Bangkok.
  assert.deepEqual(at("2026-12-31T17:30:00Z"), { month: 0, beYear: 2570 })
  assert.deepEqual(at("2026-06-15T05:00:00Z"), { month: 5, beYear: 2569 })
})

test("the status list reads the month from bangkokMonthAndBeYear", () => {
  const source = read("main.ts")
  const start = source.indexOf("const createStatusSublist")
  assert.notEqual(start, -1)
  const body = source.slice(start, source.indexOf("\n}\n", start))
  assert.match(body, /bangkokMonthAndBeYear\(Date\.now\(\)\)/)
  assert.doesNotMatch(body, /getMonth\(\)|getFullYear\(\)/, "local-time getters follow the server's UTC clock")
})
