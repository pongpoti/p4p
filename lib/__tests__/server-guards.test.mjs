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

/** The source text of `function name(...) {...}` (async or not), braces matched. */
function sliceFunction(source, name, file) {
  const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(source)
  if (!m) throw new Error(file + " no longer defines " + name + " — re-point this test")
  const start = m.index
  // The body's "{" is the first one after the parameter list closes.
  let i = source.indexOf("(", start)
  for (let depth = 0; i < source.length; i++) {
    if (source[i] === "(") depth++
    else if (source[i] === ")" && --depth === 0) break
  }
  const open = source.indexOf("{", i)
  for (let j = open, depth = 0; j < source.length; j++) {
    if (source[j] === "{") depth++
    else if (source[j] === "}" && --depth === 0) return source.slice(start, j + 1)
  }
  throw new Error("unbalanced braces while reading " + name + " from " + file)
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
