/**
 * scripts/review-email-test-toggle-2026-11.sql, read as text: it pastes
 * through chat (no backslash), keeps its function to the service role,
 * keeps the test address while test mode is off, refuses to turn test mode
 * off with no recipients or while an email is on its way, and carries no
 * address (this repository is public).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/review-email-test-toggle-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")

test("pastes through chat: no backslash, no E'' string", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
})

test("service role only, fixed search path", () => {
  assert.match(code, /create or replace function public\.review_email_set_test\(p_on boolean\)/)
  assert.match(code, /set search_path = ''/)
  assert.match(code, /revoke all on function public\.review_email_set_test\(boolean\) from public, anon, authenticated;/)
  assert.match(code, /grant execute on function public\.review_email_set_test\(boolean\) to service_role;/)
})

test("the test address is kept while off, filled once from test_to, safe to re-run", () => {
  assert.match(code, /add column if not exists test_addr text not null default ''/)
  assert.match(code, /set test_addr = test_to where test_addr = '' and test_to <> ''/)
  // Off empties test_to only after saving the address in test_addr.
  assert.match(code, /set test_addr = case when s\.test_to <> '' then s\.test_to else s\.test_addr end,\s+test_to = ''/)
})

test("off is refused with no recipients or while an email is queued or being sent", () => {
  const off = code.slice(code.indexOf("  else"))
  assert.match(off, /cardinality\(s\.recipients\), 0\) = 0 then raise exception 'review: no recipients'/)
  assert.match(off, /status in \('queued', 'sending'\)\) then\s+raise exception 'review: an email is still going out'/)
  assert.match(code, /if s\.test_addr = '' and s\.test_to = '' then raise exception 'review: no test address'/)
  assert.match(code, /if p_on is null then raise exception 'review: bad switch'/)
  // The settings row is locked while it changes.
  assert.match(code, /from public\.review_email_settings where id = 1 for update/)
})

test("no address in the file", () => {
  const addresses = src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []
  assert.deepEqual(addresses, [])
  assert.equal(/insert into public\.review_email_settings/i.test(code), false)
})
