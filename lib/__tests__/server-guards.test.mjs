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
