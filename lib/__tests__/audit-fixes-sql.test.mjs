/**
 * Static checks on the SQL the owner pastes by hand into Supabase for the
 * 2026-11-10 audit fixes (scripts/audit-fixes-2026-11.sql), and on the older
 * re-runnable scripts that used to carry the holes it closes.
 *
 * Nothing here talks to a database: the behaviour itself was checked by
 * loading the scripts into a throwaway Postgres 16 with stubbed auth/storage
 * schemas. These tests guard the parts that are easy to undo by accident
 * with a later edit: the paste rules (no backslashes, one transaction per
 * PART, search_path on every SECURITY DEFINER function, grants) and "no
 * older script defines or grants the fixed functions again".
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const FIX_FILE = "scripts/audit-fixes-2026-11.sql"
const fixSource = readFileSync(resolve(repoRoot, FIX_FILE), "utf8")

// What the fix file holds, PART by PART.
const PARTS = [1, 2, 3, 4]
const FUNCTIONS = [
  "public.clean_request_text",
  "public.sync_physician_from_match",
  "public.log_access_request",
  "public.claim_p4p_score_fallback",
  "public.claim_p4p_archive",
]
const DEFINERS = ["public.sync_physician_from_match", "public.log_access_request"]
const GRANTS = [
  "grant execute on function public.claim_p4p_archive() to service_role;",
  "grant execute on function public.claim_p4p_score_fallback() to service_role;",
  "grant execute on function public.log_access_request(text, text, text) to anon, authenticated;",
]
const REVOKED_FROM_ALL = ["clean_request_text(text, integer)", "sync_physician_from_match()", "claim_p4p_score_fallback()", "claim_p4p_archive()"]
// Functions no other script may create any more.
const OWNED = ["sync_physician_from_match", "log_access_request", "claim_p4p_score_fallback", "claim_p4p_archive"]

/** Drop `--` comments so a mention in prose never counts as code. */
function stripComments(sql) {
  return sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
}

function sqlFiles() {
  const dirs = ["scripts", "automation/sql"]
  return dirs.flatMap((dir) =>
    readdirSync(resolve(repoRoot, dir))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => join(dir, name))
  )
}

const code = stripComments(fixSource)

/** Each `create or replace function ... $$ ... $$;` in the fix file, as text. */
function functionBlocks(sql) {
  const blocks = []
  const re = /create or replace function\s+([a-z0-9_.]+)\s*\(/gi
  let m
  while ((m = re.exec(sql))) {
    const open = sql.indexOf("$$", m.index)
    const close = sql.indexOf("$$", open + 2)
    blocks.push({ name: m[1], header: sql.slice(m.index, open), body: sql.slice(open, close + 2) })
  }
  return blocks
}
const blockNamed = (name) => functionBlocks(code).find((b) => b.name === name)

test("the fix file pastes through chat: no backslash, no E'' string", () => {
  assert.equal(fixSource.includes("\\"), false, "a backslash would be refused by the paste path")
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false, "E'' strings need backslashes and are not allowed")
})

test("the fix file has PART markers, each PART its own transaction", () => {
  const parts = fixSource.split(/^-- PART (\d+)/m).slice(1)
  assert.deepEqual(parts.filter((_, i) => i % 2 === 0).map(Number), PARTS)
  for (let i = 1; i < parts.length; i += 2) {
    const body = stripComments(parts[i])
    assert.equal((body.match(/^begin;$/gm) || []).length, 1, `PART ${parts[i - 1]} needs exactly one begin;`)
    assert.equal((body.match(/^commit;$/gm) || []).length, 1, `PART ${parts[i - 1]} needs exactly one commit;`)
    assert.ok(body.indexOf("begin;") < body.indexOf("commit;"))
  }
})

test("every SECURITY DEFINER function in the fix file pins search_path = public", () => {
  const blocks = functionBlocks(code)
  assert.deepEqual(blocks.map((b) => b.name), FUNCTIONS)
  const definers = blocks.filter((b) => /security definer/i.test(b.header))
  assert.deepEqual(definers.map((b) => b.name), DEFINERS)
  for (const b of definers) {
    assert.match(b.header, /^set search_path = public$/m, `${b.name} must set search_path = public`)
  }
})

test("grants: claim functions service_role only, log_access_request anon, helpers nobody", () => {
  assert.deepEqual((code.match(/^grant .*$/gim) || []).sort(), GRANTS)
  for (const fn of REVOKED_FROM_ALL) {
    assert.match(code, new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon, authenticated;`))
  }
})

test("no other script defines the functions the fix file now owns", () => {
  for (const file of sqlFiles()) {
    if (file === FIX_FILE) continue
    const body = stripComments(readFileSync(resolve(repoRoot, file), "utf8"))
    for (const fn of OWNED) {
      assert.equal(new RegExp(`create (or replace )?function public\\.${fn}\\b`, "i").test(body), false, `${file} defines ${fn}`)
    }
  }
})

test("the migration ledger lists the fix file", () => {
  const ledger = readFileSync(resolve(repoRoot, "SUPABASE_MIGRATIONS.md"), "utf8")
  assert.match(ledger, /^24\. `scripts\/audit-fixes-2026-11\.sql`/m)
})

test("F01: the trigger function never writes to physicians", () => {
  const sync = blockNamed("public.sync_physician_from_match")
  assert.ok(sync)
  assert.equal(/(insert into|update)\s+public\.physicians/i.test(sync.body), false)
  assert.match(sync.body, /insert into public\.access_requests/)
  assert.match(sync.body, /where not public\.access_requests\.resolved/)
})

test("F01: no script copies matched senders into the allow-list", () => {
  for (const file of sqlFiles()) {
    const body = stripComments(readFileSync(resolve(repoRoot, file), "utf8"))
    assert.equal(/insert into public\.(physicians|physician_directory)\b[^;]*from public\.sender_physician_match/is.test(body), false, `${file} copies matched senders into the allow-list`)
  }
})

test("F13: log_access_request never overwrites name/department or reopens", () => {
  const fn = blockNamed("public.log_access_request")
  assert.ok(fn)
  const onConflict = fn.body.slice(fn.body.indexOf("on conflict"))
  assert.equal(/\bname\s*=/.test(onConflict), false)
  assert.equal(/department\s*=/.test(onConflict), false)
  assert.equal(/resolved\s*=\s*false/.test(onConflict), false)
  assert.match(onConflict, /where not public\.access_requests\.resolved/)
})

test("F09: claim_p4p_score_fallback reclaims or fails rows stuck in processing", () => {
  const fn = blockNamed("public.claim_p4p_score_fallback")
  assert.ok(fn)
  assert.match(fn.body, /status = 'processing'\s+and coalesce\(claimed_at, received_at\) < now\(\) - interval '30 minutes'/)
  assert.match(fn.body, /error_type\s+= 'stuck_processing'/)
  assert.match(fn.body, /attempts < 3/)
})

test("F17: claim_p4p_archive supersedes an older upload", () => {
  const fn = blockNamed("public.claim_p4p_archive")
  assert.ok(fn)
  assert.match(fn.body, /set archive_status = 'superseded'/)
  assert.match(code, /check \(archive_status in \('archive_pending', 'archived', 'superseded'\)\)/)
})